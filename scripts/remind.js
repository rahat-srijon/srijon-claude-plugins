// @ts-check
// Repeats a sound in a detached process until it is no longer needed.
//   remind.js attention <sessionId> <id>  question, permission or error, until dealt with
//   remind.js usage <window>              a usage "near" sound, while any session's turn runs
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.js';
import { log } from './lib/log.js';
import { dataDir as defaultDataDir, pluginRoot as defaultPluginRoot } from './lib/paths.js';
import { playEvent } from './lib/play.js';
import {
  activitySnapshot,
  clearAttention,
  hasActivity,
  isAlive,
  lastTurnInterrupted,
  readAttention,
  updateUsageReminder,
} from './lib/reminders.js';
import { openSession } from './lib/state.js';
import { WINDOWS, hitWindows, readUsageState } from './lib/usage.js';

/** @typedef {import('./lib/usage.js').WindowName} WindowName */
/** @typedef {import('./lib/play.js').Roots} Roots */

/** Wait this long before noting the transcript, so lines written as the prompt appeared are not activity. */
const SETTLE_MS = 2000;
/** Stop an attention reminder after this long, in case its session died without a hook. */
export const MAX_ATTENTION_MS = 60 * 60 * 1000;
/** Drop a session from a usage reminder after this long, in case its turn end was missed. */
export const MAX_TURN_MS = 6 * 60 * 60 * 1000;

/**
 * Replay a question, permission or error sound until a hook in the session
 * clears the reminder, a message appears in the session's transcripts, the
 * reminder is replaced or turned off, or MAX_ATTENTION_MS passes.
 * @param {string} sessionId
 * @param {string} id
 * @param {Roots} roots
 * @returns {Promise<void>}
 */
export async function runAttention(sessionId, id, { dataDir, pluginRoot }) {
  const reminder = readAttention(dataDir, sessionId);
  if (reminder?.id !== id) {
    return;
  }
  const { event, family, transcriptPath } = reminder;
  const projectDir = reminder.projectDir ?? undefined;
  log('debug', `remind: ${event} reminder started for session ${sessionId}`);
  await sleep(SETTLE_MS);
  const snapshot = transcriptPath ? activitySnapshot(transcriptPath) : {};
  let waitMs = -SETTLE_MS;
  for (;;) {
    const config = loadConfig({ dataDir, projectDir });
    const repeatMs = config.events[event].repeatMs ?? 0;
    if (repeatMs <= 0) {
      clearAttention(dataDir, sessionId, id);
      return;
    }
    await sleep(Math.max(0, repeatMs + waitMs));
    waitMs = 0;
    const reason = attentionDone(reminder, sessionId, snapshot, { dataDir, pluginRoot });
    if (reason) {
      clearAttention(dataDir, sessionId, id);
      log('debug', `remind: ${event} reminder for session ${sessionId} stopped: ${reason}`);
      return;
    }
    const { status, detail } = await playEvent(loadConfig({ dataDir, projectDir }), event, { family, dataDir, pluginRoot });
    log('debug', `remind: event=${event} repeat ${status}: ${detail}`);
  }
}

/**
 * @param {import('./lib/reminders.js').AttentionReminder} reminder
 * @param {string} sessionId
 * @param {import('./lib/reminders.js').ActivitySnapshot} snapshot
 * @param {Roots} roots
 * @returns {string | null} Why the reminder is over, or null to keep going.
 */
function attentionDone(reminder, sessionId, snapshot, { dataDir, pluginRoot }) {
  if (readAttention(dataDir, sessionId)?.id !== reminder.id) {
    return 'cleared or replaced';
  }
  if (reminder.transcriptPath && hasActivity(reminder.transcriptPath, snapshot)) {
    return 'new messages in the transcript';
  }
  if (Date.now() - reminder.startedAt > MAX_ATTENTION_MS) {
    return 'time limit';
  }
  return fs.existsSync(pluginRoot) ? null : 'plugin root gone';
}

/**
 * Replay a window's "near" sound while it is past a threshold and some session
 * has a turn running. One repeater per window, claimed through its pid.
 * @param {WindowName} window
 * @param {Roots} roots
 * @returns {Promise<void>}
 */
export async function runUsage(window, { dataDir, pluginRoot }) {
  const near = WINDOWS[window].near;
  const claimed = updateUsageReminder(dataDir, window, (r) => {
    if (r.pid === null || !isAlive(r.pid)) {
      r.pid = process.pid;
    }
  });
  if (claimed?.pid !== process.pid) {
    return;
  }
  log('debug', `remind: ${near} repeater started`);
  try {
    for (;;) {
      const repeatMs = loadConfig({ dataDir }).events[near].repeatWhileWorkingMs ?? 0;
      if (repeatMs <= 0) {
        return;
      }
      await sleep(repeatMs);
      const reminder = updateUsageReminder(dataDir, window, (r) => pruneSessions(r, dataDir));
      if (!reminder || reminder.pid !== process.pid || Object.keys(reminder.sessions).length === 0) {
        return;
      }
      if (!hitWindows(readUsageState(dataDir), Date.now() / 1000).includes(window) || !fs.existsSync(pluginRoot)) {
        updateUsageReminder(dataDir, window, (r) => { r.sessions = {}; });
        return;
      }
      const { status, detail } = await playEvent(loadConfig({ dataDir }), near, { dataDir, pluginRoot });
      log('debug', `remind: event=${near} repeat ${status}: ${detail}`);
    }
  } finally {
    updateUsageReminder(dataDir, window, (r) => {
      if (r.pid === process.pid) {
        r.pid = null;
      }
    });
    log('debug', `remind: ${near} repeater stopped`);
  }
}

/**
 * Drop sessions whose turn is over: ended by a hook, interrupted with Esc,
 * or running for longer than MAX_TURN_MS.
 * @param {import('./lib/reminders.js').UsageReminder} reminder
 * @param {string} dataDir
 * @returns {void}
 */
function pruneSessions(reminder, dataDir) {
  for (const [sessionId, { transcriptPath, joinedAt }] of Object.entries(reminder.sessions)) {
    const over = !openSession(dataDir, sessionId).turnActive()
      || (transcriptPath !== null && lastTurnInterrupted(transcriptPath))
      || Date.now() - joinedAt > MAX_TURN_MS;
    if (over) {
      delete reminder.sessions[sessionId];
    }
  }
}

/**
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    // Node resolves symlinks in the main module's URL, so compare real paths.
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const roots = { dataDir: defaultDataDir(), pluginRoot: defaultPluginRoot() };
  const [mode, first, second] = argv;
  if (mode === 'attention' && first && second) {
    await runAttention(first, second, roots);
  } else if (mode === 'usage' && (first === 'five_hour' || first === 'seven_day')) {
    await runUsage(first, roots);
  } else {
    log('warn', `remind: bad arguments ${argv.join(' ')}`);
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err) => log('error', 'remind: failed', err));
}
