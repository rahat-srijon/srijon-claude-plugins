// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { eventFor, handle } from '../hook.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'hook.js');
const BUNDLED = (/** @type {string} */ id) => path.join(PLUGIN_ROOT, 'sounds', `${id}.wav`);

/** @type {string} */
let dataDir;
/** @type {string | undefined} */
let savedDataDir;
/** @type {string | undefined} */
let savedProjectDir;
/** @type {string[]} */
let extraDirs;

beforeEach(() => {
  savedDataDir = process.env.CLAUDIO_DATA_DIR;
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-hook-'));
  extraDirs = [];
  process.env.CLAUDIO_DATA_DIR = dataDir;
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  for (const dir of [dataDir, ...extraDirs]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  restoreEnv('CLAUDIO_DATA_DIR', savedDataDir);
  restoreEnv('CLAUDE_PROJECT_DIR', savedProjectDir);
});

/**
 * @param {string} name
 * @param {string | undefined} value
 */
function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/**
 * @typedef {{ file: string, volume: number, kind: 'play' | 'speak' }} Call
 */

/**
 * Recording fakes. `failPlay` and `failSpeak` decide which calls throw.
 * @param {{ failPlay?: (file: string) => boolean, failSpeak?: boolean }} [options]
 */
function fakes({ failPlay = () => false, failSpeak = false } = {}) {
  /** @type {Call[]} */
  const calls = [];
  return {
    calls,
    deps: {
      dataDir,
      pluginRoot: PLUGIN_ROOT,
      /**
       * @param {string} file
       * @param {{ volume: number }} opts
       */
      play: async (file, opts) => {
        calls.push({ file, volume: opts.volume, kind: 'play' });
        if (failPlay(file)) {
          throw new Error('play failed');
        }
      },
      /**
       * @param {string} text
       * @param {{ volume: number }} opts
       */
      speak: async (text, opts) => {
        calls.push({ file: text, volume: opts.volume, kind: 'speak' });
        if (failSpeak) {
          throw new Error('speak failed');
        }
      },
    },
  };
}

/** @param {Record<string, unknown>} config */
function writeConfig(config) {
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
}

/**
 * @param {string} name
 * @param {string[]} lines
 * @returns {string}
 */
function writeTranscript(name, lines) {
  const file = path.join(dataDir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** @param {string} model */
function assistantLine(model) {
  return JSON.stringify({ type: 'assistant', message: { model } });
}

/** @param {Date} date */
function hhmm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** @param {string} id */
function stop(id = 's1') {
  return { hook_event_name: 'Stop', session_id: id };
}

describe('eventFor', () => {
  test('maps each hook to its event', () => {
    assert.equal(eventFor({ hook_event_name: 'Stop' }), 'agent_done');
    assert.equal(eventFor({ hook_event_name: 'SubagentStop' }), 'subagent_done');
    assert.equal(eventFor({ hook_event_name: 'StopFailure' }), 'error');
    assert.equal(eventFor({ hook_event_name: 'PreToolUse', tool_name: 'Agent' }), 'subagent_start');
    assert.equal(eventFor({ hook_event_name: 'PreToolUse', tool_name: 'Task' }), 'subagent_start');
    assert.equal(eventFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), 'question');
    assert.equal(
      eventFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
      'permission',
    );
  });

  test('returns null for other notification types', () => {
    assert.equal(eventFor({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), null);
    assert.equal(eventFor({ hook_event_name: 'Notification' }), null);
  });

  test('returns null for PreToolUse with other tools', () => {
    assert.equal(eventFor({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), null);
    assert.equal(eventFor({ hook_event_name: 'PreToolUse' }), null);
  });

  test('returns null for prototype keys', () => {
    assert.equal(eventFor({ hook_event_name: 'constructor' }), null);
    assert.equal(eventFor({ hook_event_name: '__proto__' }), null);
    assert.equal(eventFor({ hook_event_name: 'PreToolUse', tool_name: 'constructor' }), null);
    assert.equal(eventFor({ hook_event_name: 'PreToolUse', tool_name: 'toString' }), null);
  });
});

describe('ignored input', () => {
  test('unmapped input is ignored and plays nothing', async () => {
    const { calls, deps } = fakes();
    const outcome = await handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, deps);
    assert.equal(outcome.status, 'ignored');
    assert.equal(outcome.event, null);
    assert.equal(outcome.detail, 'nothing to play for Bash');
    assert.deepEqual(calls, []);
  });
});

describe('state hooks', () => {
  test('UserPromptSubmit records the turn start', async () => {
    const { calls, deps } = fakes();
    const outcome = await handle({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, deps);
    assert.equal(outcome.status, 'recorded');
    assert.equal(outcome.detail, 'turn start');
    assert.deepEqual(calls, []);
  });

  test('SessionStart records the model', async () => {
    const { deps } = fakes();
    const outcome = await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
    assert.equal(outcome.status, 'recorded');
    assert.equal(outcome.detail, 'model claude-opus-5');
  });

  test('SessionStart without a model records nothing useful', async () => {
    const { deps } = fakes();
    const outcome = await handle({ hook_event_name: 'SessionStart', session_id: 's1' }, deps);
    assert.equal(outcome.status, 'recorded');
    assert.equal(outcome.detail, 'no model in input');
  });

  test('PostModelSwitch records the new model', async () => {
    const { deps } = fakes();
    const outcome = await handle(
      { hook_event_name: 'PostModelSwitch', session_id: 's1', to_model: 'claude-haiku-4' },
      deps,
    );
    assert.equal(outcome.status, 'recorded');
    assert.equal(outcome.detail, 'model claude-haiku-4');
  });

  test('a later Stop without a transcript uses the cached model', async () => {
    const { deps } = fakes();
    await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
    const outcome = await handle(stop('s1'), deps);
    assert.equal(outcome.status, 'played');
    assert.equal(outcome.model, 'claude-opus-5');
    assert.equal(outcome.family, 'opus');
  });

  test('PostModelSwitch overrides the model from SessionStart', async () => {
    const { deps } = fakes();
    await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
    await handle({ hook_event_name: 'PostModelSwitch', session_id: 's1', to_model: 'claude-haiku-4' }, deps);
    const outcome = await handle(stop('s1'), deps);
    assert.equal(outcome.family, 'haiku');
  });
});

describe('gating', () => {
  test('plugin disabled', async () => {
    writeConfig({ enabled: false });
    const { calls, deps } = fakes();
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.detail, 'plugin disabled');
    assert.deepEqual(calls, []);
  });

  test('muted', async () => {
    writeConfig({ muted: true });
    const { calls, deps } = fakes();
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.detail, 'muted');
    assert.deepEqual(calls, []);
  });

  test('quiet hours covering now', async () => {
    const now = Date.now();
    writeConfig({
      quietHours: {
        enabled: true,
        from: hhmm(new Date(now - 60 * 60 * 1000)),
        to: hhmm(new Date(now + 60 * 60 * 1000)),
      },
    });
    const { calls, deps } = fakes();
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.detail, 'quiet hours');
    assert.deepEqual(calls, []);
  });

  test('event disabled', async () => {
    writeConfig({ events: { agent_done: { enabled: false } } });
    const { calls, deps } = fakes();
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.detail, 'event disabled');
    assert.deepEqual(calls, []);
  });

  test('subagent_start is disabled by default', async () => {
    const { calls, deps } = fakes();
    const outcome = await handle(
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's1' },
      deps,
    );
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.event, 'subagent_start');
    assert.equal(outcome.detail, 'event disabled');
    assert.deepEqual(calls, []);
  });

  test('a second identical event is skipped for cooldown', async () => {
    const { calls, deps } = fakes();
    const first = await handle(stop(), deps);
    const second = await handle(stop(), deps);
    assert.equal(first.status, 'played');
    assert.equal(second.status, 'skipped');
    assert.equal(second.detail, 'cooldown');
    assert.equal(calls.length, 1);
  });

  test('a skipped event does not consume the cooldown', async () => {
    const { calls, deps } = fakes();
    writeConfig({ muted: true });
    const skipped = await handle(stop(), deps);
    assert.equal(skipped.detail, 'muted');
    writeConfig({ muted: false });
    const played = await handle(stop(), deps);
    assert.equal(played.status, 'played');
    assert.equal(calls.length, 1);
  });
});

describe('minTurnSeconds', () => {
  test('Stop right after UserPromptSubmit is skipped', async () => {
    const { calls, deps } = fakes();
    await handle({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, deps);
    const outcome = await handle(stop('s1'), deps);
    assert.equal(outcome.status, 'skipped');
    assert.match(outcome.detail, /^turn took \d+\.\ds, under minTurnSeconds 15$/);
    assert.deepEqual(calls, []);
  });

  test('Stop with no recorded turn plays', async () => {
    const { calls, deps } = fakes();
    const outcome = await handle(stop('s1'), deps);
    assert.equal(outcome.status, 'played');
    assert.equal(calls.length, 1);
  });

  test('minTurnSeconds of 0 lets a short turn play', async () => {
    writeConfig({ minTurnSeconds: 0 });
    const { calls, deps } = fakes();
    await handle({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, deps);
    const outcome = await handle(stop('s1'), deps);
    assert.equal(outcome.status, 'played');
    assert.equal(calls.length, 1);
  });
});

describe('model resolution', () => {
  test('Stop uses the model from the transcript', async () => {
    const transcript = writeTranscript('main.jsonl', [assistantLine('claude-sonnet-5-5')]);
    const { deps } = fakes();
    const outcome = await handle({ ...stop(), transcript_path: transcript }, deps);
    assert.equal(outcome.model, 'claude-sonnet-5-5');
    assert.equal(outcome.family, 'sonnet');
  });

  test('Stop prefers the transcript over the cached model', async () => {
    const transcript = writeTranscript('main.jsonl', [assistantLine('claude-haiku-4')]);
    const { deps } = fakes();
    await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
    const outcome = await handle({ ...stop('s1'), transcript_path: transcript }, deps);
    assert.equal(outcome.family, 'haiku');
  });

  test('SubagentStop uses agent_transcript_path', async () => {
    const main = writeTranscript('main.jsonl', [assistantLine('claude-opus-5')]);
    const sub = writeTranscript('sub.jsonl', [assistantLine('claude-haiku-4')]);
    const { deps } = fakes();
    const outcome = await handle(
      { hook_event_name: 'SubagentStop', session_id: 's1', transcript_path: main, agent_transcript_path: sub },
      deps,
    );
    assert.equal(outcome.event, 'subagent_done');
    assert.equal(outcome.family, 'haiku');
  });

  test('SubagentStop falls back to the session model, then the main transcript', async () => {
    const main = writeTranscript('main.jsonl', [assistantLine('claude-opus-5')]);
    const { deps } = fakes();
    const viaTranscript = await handle(
      { hook_event_name: 'SubagentStop', session_id: 's1', transcript_path: main },
      deps,
    );
    assert.equal(viaTranscript.family, 'opus');

    await handle({ hook_event_name: 'SessionStart', session_id: 's2', model: 'claude-sonnet-5-5' }, deps);
    const viaCache = await handle(
      { hook_event_name: 'SubagentStop', session_id: 's2', transcript_path: main },
      deps,
    );
    assert.equal(viaCache.family, 'sonnet');
  });

  describe('PreToolUse Agent', () => {
    /** @type {string} */
    let projectDir;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-hook-proj-'));
      extraDirs.push(projectDir);
      const agents = path.join(projectDir, '.claude', 'agents');
      fs.mkdirSync(agents, { recursive: true });
      fs.writeFileSync(
        path.join(agents, 'reviewer.md'),
        '---\nname: claudio-test-reviewer\nmodel: sonnet\n---\nBody\n',
      );
      writeConfig({ events: { subagent_start: { enabled: true } } });
    });

    /** @param {Record<string, unknown>} toolInput */
    const agentInput = (toolInput) => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      session_id: 's1',
      cwd: projectDir,
      tool_input: toolInput,
    });

    test('prefers tool_input.model over the definition and session model', async () => {
      const { deps } = fakes();
      await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
      const outcome = await handle(
        agentInput({ model: 'haiku', subagent_type: 'claudio-test-reviewer' }),
        deps,
      );
      assert.equal(outcome.status, 'played');
      assert.equal(outcome.model, 'haiku');
      assert.equal(outcome.family, 'haiku');
    });

    test('then uses the agent definition frontmatter', async () => {
      const { deps } = fakes();
      await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
      const outcome = await handle(agentInput({ subagent_type: 'claudio-test-reviewer' }), deps);
      assert.equal(outcome.model, 'sonnet');
      assert.equal(outcome.family, 'sonnet');
    });

    test('then the session model', async () => {
      const { deps } = fakes();
      await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
      const outcome = await handle(agentInput({ subagent_type: 'claudio-test-nonexistent' }), deps);
      assert.equal(outcome.family, 'opus');
    });

    test('then the main transcript', async () => {
      const main = writeTranscript('main.jsonl', [assistantLine('claude-haiku-4')]);
      const { deps } = fakes();
      const outcome = await handle(
        { ...agentInput({ subagent_type: 'claudio-test-nonexistent' }), transcript_path: main },
        deps,
      );
      assert.equal(outcome.family, 'haiku');
    });

    test('a definition with model inherit falls through to the session model', async () => {
      fs.writeFileSync(
        path.join(projectDir, '.claude', 'agents', 'inherit.md'),
        '---\nname: claudio-test-inherit\nmodel: inherit\n---\n',
      );
      const { deps } = fakes();
      await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
      const outcome = await handle(agentInput({ subagent_type: 'claudio-test-inherit' }), deps);
      assert.equal(outcome.family, 'opus');
    });
  });

  for (const [name, input] of /** @type {[string, Record<string, unknown>][]} */ ([
    ['question', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }],
    ['permission', { hook_event_name: 'Notification', notification_type: 'permission_prompt' }],
    ['error', { hook_event_name: 'StopFailure' }],
  ])) {
    test(`${name} uses the cached model`, async () => {
      const transcript = writeTranscript('main.jsonl', [assistantLine('claude-haiku-4')]);
      const { deps } = fakes();
      await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
      const outcome = await handle({ ...input, session_id: 's1', transcript_path: transcript }, deps);
      assert.equal(outcome.status, 'played');
      assert.equal(outcome.family, 'opus');
    });

    test(`${name} falls back to the transcript model`, async () => {
      const transcript = writeTranscript('main.jsonl', [assistantLine('claude-haiku-4')]);
      const { deps } = fakes();
      const outcome = await handle({ ...input, session_id: 's1', transcript_path: transcript }, deps);
      assert.equal(outcome.family, 'haiku');
    });
  }

  test('no model anywhere gives family other', async () => {
    const { deps } = fakes();
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.model, null);
    assert.equal(outcome.family, 'other');
  });
});

describe('playback', () => {
  test('plays the bundled sound for the event', async () => {
    const { calls, deps } = fakes();
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.status, 'played');
    assert.equal(outcome.detail, BUNDLED('done'));
    assert.deepEqual(calls, [{ file: BUNDLED('done'), volume: 0.8, kind: 'play' }]);
  });

  test('passes the global volume, or the event volume when set', async () => {
    writeConfig({ volume: 0.4, events: { error: { volume: 0.25 } } });
    const { calls, deps } = fakes();
    await handle(stop('a'), deps);
    await handle({ hook_event_name: 'StopFailure', session_id: 'a' }, deps);
    assert.equal(calls[0].volume, 0.4);
    assert.equal(calls[1].volume, 0.25);
  });

  test('uses a byModel override', async () => {
    writeConfig({ events: { agent_done: { byModel: { opus: 'default:permission' } } } });
    const { calls, deps } = fakes();
    await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
    const outcome = await handle(stop('s1'), deps);
    assert.equal(outcome.status, 'played');
    assert.equal(calls[0].file, BUNDLED('permission'));
  });

  test('byModel does not apply to another family', async () => {
    writeConfig({ events: { agent_done: { byModel: { opus: 'default:permission' } } } });
    const { calls, deps } = fakes();
    await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-haiku-4' }, deps);
    await handle(stop('s1'), deps);
    assert.equal(calls[0].file, BUNDLED('done'));
  });

  test('a tts spec calls speak', async () => {
    writeConfig({ volume: 0.5, events: { agent_done: { sound: 'tts' } } });
    const { calls, deps } = fakes();
    await handle({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-opus-5' }, deps);
    const outcome = await handle(stop('s1'), deps);
    assert.equal(outcome.status, 'played');
    assert.equal(outcome.detail, 'tts "Opus finished"');
    assert.deepEqual(calls, [{ file: 'Opus finished', volume: 0.5, kind: 'speak' }]);
  });

  test('a failing tts falls back to the bundled sound', async () => {
    writeConfig({ events: { agent_done: { sound: 'tts' } } });
    const { calls, deps } = fakes({ failSpeak: true });
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.status, 'played');
    assert.match(outcome.detail, /\(fallback\)$/);
    assert.deepEqual(calls.map((call) => call.kind), ['speak', 'play']);
  });

  test('a failing non-bundled sound falls back to the bundled one', async () => {
    fs.mkdirSync(path.join(dataDir, 'sounds'));
    const custom = path.join(dataDir, 'sounds', 'custom.wav');
    fs.writeFileSync(custom, 'RIFF');
    writeConfig({ events: { agent_done: { sound: 'user:custom.wav' } } });
    const { calls, deps } = fakes({ failPlay: (file) => file === custom });
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.status, 'played');
    assert.ok(outcome.detail.includes('(fallback)'));
    assert.ok(outcome.detail.includes(BUNDLED('done')));
    assert.deepEqual(calls.map((call) => call.file), [custom, BUNDLED('done')]);
  });

  test('both sounds failing gives failed', async () => {
    fs.mkdirSync(path.join(dataDir, 'sounds'));
    const custom = path.join(dataDir, 'sounds', 'custom.wav');
    fs.writeFileSync(custom, 'RIFF');
    writeConfig({ events: { agent_done: { sound: 'user:custom.wav' } } });
    const { calls, deps } = fakes({ failPlay: () => true });
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.detail, `${custom}, then ${BUNDLED('done')}`);
    assert.equal(calls.length, 2);
  });

  test('a failing bundled sound is attempted only once', async () => {
    const { calls, deps } = fakes({ failPlay: () => true });
    const outcome = await handle(stop(), deps);
    assert.equal(outcome.status, 'failed');
    assert.equal(calls.length, 1);
  });
});

describe('process', () => {
  test('invalid JSON on stdin exits 0 with no output', () => {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: 'not json {',
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CLAUDIO_DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});
