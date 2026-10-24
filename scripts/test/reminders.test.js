// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Guard directory so that even import-time logging can never reach the real ~/.claude.
const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-reminders-'));
process.env.CLAUDIO_DATA_DIR = guardDir;

const { handle } = await import('../hook.js');
const {
  activitySnapshot,
  clearAttention,
  hasActivity,
  joinUsageReminder,
  lastTurnInterrupted,
  leaveUsageReminders,
  readAttention,
  readUsageReminder,
  setAttention,
} = await import('../lib/reminders.js');
const { openSession } = await import('../lib/state.js');
const { runAttention, runUsage } = await import('../remind.js');

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOUR = 3600;

/** @type {string} */
let dataDir;
/** @type {string} */
let transcript;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-reminders-'));
  process.env.CLAUDIO_DATA_DIR = dataDir;
  transcript = path.join(dataDir, 'project', 's1.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
});

afterEach(() => {
  process.env.CLAUDIO_DATA_DIR = guardDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

process.on('exit', () => {
  fs.rmSync(guardDir, { recursive: true, force: true });
});

/**
 * @param {string} file
 * @param {Record<string, unknown>} entry
 */
function append(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/** @param {unknown} config */
function writeConfig(config) {
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
}

/** Mark the 5-hour window as past its 80% threshold. */
function hitFiveHour() {
  const state = { five_hour: { resetsAt: Math.floor(Date.now() / 1000) + HOUR, maxPercent: 85, fired: [80], reset: false } };
  fs.mkdirSync(path.join(dataDir, 'usage'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'usage', 'state.json'), JSON.stringify(state));
}

function fakes() {
  /** @type {string[]} */
  const played = [];
  /** @type {string[][]} */
  const spawned = [];
  return {
    played,
    spawned,
    deps: {
      dataDir,
      pluginRoot: PLUGIN_ROOT,
      /** @param {string} file */
      play: async (file) => { played.push(path.basename(file)); },
      speak: async () => {},
      /**
       * @param {string} script
       * @param {string[]} args
       */
      spawnDetached: (script, args) => { spawned.push([script, ...args]); },
    },
  };
}

/**
 * @param {string} hook
 * @param {Record<string, unknown>} [extra]
 */
function input(hook, extra = {}) {
  return { hook_event_name: hook, session_id: 's1', transcript_path: transcript, ...extra };
}

describe('attention records', () => {
  it('stores, replaces and clears a session reminder', () => {
    const first = setAttention(dataDir, 's1', { event: 'question', family: 'opus', transcriptPath: null, projectDir: null });
    const second = setAttention(dataDir, 's1', { event: 'error', family: 'opus', transcriptPath: null, projectDir: null });
    assert.notEqual(first.id, second.id);
    assert.equal(readAttention(dataDir, 's1')?.event, 'error');
    assert.equal(clearAttention(dataDir, 's1', first.id), false);
    assert.equal(clearAttention(dataDir, 's1', second.id), true);
    assert.equal(readAttention(dataDir, 's1'), null);
  });
});

describe('transcript activity', () => {
  it('ignores metadata lines and notices messages', () => {
    const snapshot = activitySnapshot(transcript);
    append(transcript, { type: 'custom-title', title: 'x' });
    append(transcript, { type: 'attachment' });
    assert.equal(hasActivity(transcript, snapshot), false);
    append(transcript, { type: 'user', message: { content: [{ type: 'tool_result', content: 'tea' }] } });
    assert.equal(hasActivity(transcript, snapshot), true);
  });

  it('notices messages in subagent transcripts', () => {
    const snapshot = activitySnapshot(transcript);
    append(path.join(path.dirname(transcript), 's1', 'subagents', 'agent-a1.jsonl'), { type: 'assistant' });
    assert.equal(hasActivity(transcript, snapshot), true);
  });

  it('recognizes an Esc interrupt as the last message', () => {
    assert.equal(lastTurnInterrupted(transcript), false);
    append(transcript, { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    append(transcript, { type: 'last-prompt' });
    assert.equal(lastTurnInterrupted(transcript), true);
    append(transcript, { type: 'assistant', message: { content: [] } });
    assert.equal(lastTurnInterrupted(transcript), false);
  });
});

describe('usage reminder records', () => {
  it('asks for a repeater once and forgets sessions that leave', () => {
    assert.equal(joinUsageReminder(dataDir, 'five_hour', 's1', transcript), true);
    assert.deepEqual(Object.keys(readUsageReminder(dataDir, 'five_hour').sessions), ['s1']);
    leaveUsageReminders(dataDir, ['five_hour', 'seven_day'], 's1');
    assert.deepEqual(readUsageReminder(dataDir, 'five_hour'), { pid: null, sessions: {} });
  });
});

describe('hook reminders', () => {
  it('starts a question reminder and ignores the permission prompt for it', async () => {
    const { played, spawned, deps } = fakes();
    await handle(input('PreToolUse', { tool_name: 'AskUserQuestion' }), deps);
    const reminder = readAttention(dataDir, 's1');
    assert.deepEqual(spawned, [['remind.js', 'attention', 's1', reminder?.id]]);
    const outcome = await handle(input('Notification', { notification_type: 'permission_prompt' }), deps);
    assert.equal(outcome.status, 'ignored');
    assert.deepEqual(played, ['question.wav']);
    assert.equal(readAttention(dataDir, 's1')?.id, reminder?.id);
  });

  it('clears the reminder on the next hook in the session', async () => {
    const { deps } = fakes();
    await handle(input('Notification', { notification_type: 'permission_prompt' }), deps);
    assert.equal(readAttention(dataDir, 's1')?.event, 'permission');
    await handle(input('Stop'), deps);
    assert.equal(readAttention(dataDir, 's1'), null);
  });

  it('records the question but starts no repeater with repeatMs 0', async () => {
    writeConfig({ events: { question: { repeatMs: 0 } } });
    const { spawned, deps } = fakes();
    await handle(input('PreToolUse', { tool_name: 'AskUserQuestion' }), deps);
    assert.deepEqual(spawned, []);
    assert.equal(readAttention(dataDir, 's1')?.event, 'question');
  });

  it('plays agent_start when it is on', async () => {
    writeConfig({ events: { agent_start: { enabled: true } } });
    const { played, deps } = fakes();
    await handle(input('UserPromptSubmit'), deps);
    assert.deepEqual(played, ['start.wav']);
  });

  it('reminds about a hit usage limit on the prompt and joins the working repeater', async () => {
    writeConfig({ cooldownMs: 0, events: { usage_5h_near: { remindOnPrompt: true, repeatWhileWorkingMs: 5000 } } });
    hitFiveHour();
    const { played, spawned, deps } = fakes();
    await handle(input('UserPromptSubmit'), deps);
    assert.deepEqual(played, ['usage-near.wav']);
    assert.deepEqual(spawned, [['remind.js', 'usage', 'five_hour']]);
    await handle(input('Stop', { stop_hook_active: false }), deps);
    assert.deepEqual(readUsageReminder(dataDir, 'five_hour').sessions, {});
    assert.equal(openSession(dataDir, 's1').turnActive(), false);
  });

  it('does nothing extra on a prompt while no limit is hit', async () => {
    writeConfig({ events: { usage_5h_near: { remindOnPrompt: true, repeatWhileWorkingMs: 5000 } } });
    const { played, spawned, deps } = fakes();
    await handle(input('UserPromptSubmit'), deps);
    assert.deepEqual(played, []);
    assert.deepEqual(spawned, []);
  });
});

describe('repeaters', () => {
  it('runAttention stops at once for a replaced reminder', async () => {
    setAttention(dataDir, 's1', { event: 'question', family: 'other', transcriptPath: transcript, projectDir: null });
    await runAttention('s1', 'not-the-id', { dataDir, pluginRoot: PLUGIN_ROOT });
    assert.equal(readAttention(dataDir, 's1')?.event, 'question');
  });

  it('runAttention stops and clears when repeating is turned off', async () => {
    writeConfig({ events: { question: { repeatMs: 0 } } });
    const reminder = setAttention(dataDir, 's1', { event: 'question', family: 'other', transcriptPath: null, projectDir: null });
    await runAttention('s1', reminder.id, { dataDir, pluginRoot: PLUGIN_ROOT });
    assert.equal(readAttention(dataDir, 's1'), null);
  });

  it('runUsage exits and releases the reminder once no turn is running', async () => {
    writeConfig({ events: { usage_5h_near: { repeatWhileWorkingMs: 1000 } } });
    hitFiveHour();
    joinUsageReminder(dataDir, 'five_hour', 's1', transcript);
    await runUsage('five_hour', { dataDir, pluginRoot: PLUGIN_ROOT });
    assert.deepEqual(readUsageReminder(dataDir, 'five_hour'), { pid: null, sessions: {} });
  });
});
