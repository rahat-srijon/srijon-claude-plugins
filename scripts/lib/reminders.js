// @ts-check
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';
import { readJsonObject, withMutex, writeJsonAtomic } from './state.js';

/** @typedef {import('./config.js').EventName} EventName */
/** @typedef {import('./usage.js').WindowName} WindowName */

/**
 * A question, permission or error sound that repeats until it is dealt with.
 * One per session: a newer one replaces the older.
 * @typedef {object} AttentionReminder
 * @property {string} id Lets the repeater notice that it was replaced.
 * @property {EventName} event
 * @property {string} family
 * @property {string | null} transcriptPath
 * @property {string | null} projectDir
 * @property {number} startedAt Epoch ms.
 */

/**
 * A usage "near" sound that repeats while any session has a turn running.
 * @typedef {object} UsageReminder
 * @property {number | null} pid The repeater process, if one claimed it.
 * @property {Record<string, { transcriptPath: string | null, joinedAt: number }>} sessions
 */

/**
 * Map from transcript file to its size, for spotting new transcript lines.
 * @typedef {Record<string, number>} ActivitySnapshot
 */

/** Read at most this much new transcript per file; more than that is activity anyway. */
const MAX_SCAN_BYTES = 1024 * 1024;
/** Read this much from the end of a transcript to find its last message. */
const TAIL_BYTES = 64 * 1024;
const INTERRUPT_PREFIX = '[Request interrupted by user';
const ID_RE = /[^A-Za-z0-9_-]/g;

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function remindersDir(dataDir) {
  return path.join(dataDir, 'reminders');
}

/**
 * @param {string} dataDir
 * @param {string} sessionId
 * @returns {string}
 */
function attentionFile(dataDir, sessionId) {
  return path.join(remindersDir(dataDir), `attention-${sessionId.replace(ID_RE, '').slice(0, 128) || 'unknown'}.json`);
}

/**
 * @param {string} dataDir
 * @param {WindowName} window
 * @returns {string}
 */
function usageFile(dataDir, window) {
  return path.join(remindersDir(dataDir), `usage-${window}.json`);
}

/**
 * Record a new attention reminder for a session, replacing any older one.
 * @param {string} dataDir
 * @param {string} sessionId
 * @param {Omit<AttentionReminder, 'id' | 'startedAt'>} reminder
 * @returns {AttentionReminder}
 */
export function setAttention(dataDir, sessionId, reminder) {
  /** @type {AttentionReminder} */
  const full = { ...reminder, id: randomBytes(6).toString('hex'), startedAt: Date.now() };
  writeJsonAtomic(attentionFile(dataDir, sessionId), full);
  return full;
}

/**
 * @param {string} dataDir
 * @param {string} sessionId
 * @returns {AttentionReminder | null}
 */
export function readAttention(dataDir, sessionId) {
  const raw = readJsonObject(attentionFile(dataDir, sessionId));
  if (!raw || typeof raw.id !== 'string' || typeof raw.event !== 'string' || typeof raw.startedAt !== 'number') {
    return null;
  }
  return {
    id: raw.id,
    event: /** @type {EventName} */ (raw.event),
    family: typeof raw.family === 'string' ? raw.family : 'other',
    transcriptPath: typeof raw.transcriptPath === 'string' ? raw.transcriptPath : null,
    projectDir: typeof raw.projectDir === 'string' ? raw.projectDir : null,
    startedAt: raw.startedAt,
  };
}

/**
 * Drop a session's attention reminder. With `id`, only if it is still that one.
 * @param {string} dataDir
 * @param {string} sessionId
 * @param {string} [id]
 * @returns {boolean} True if a reminder was removed.
 */
export function clearAttention(dataDir, sessionId, id) {
  const current = readAttention(dataDir, sessionId);
  if (!current || (id !== undefined && current.id !== id)) {
    return false;
  }
  fs.rmSync(attentionFile(dataDir, sessionId), { force: true });
  return true;
}

/**
 * @param {string} dataDir
 * @param {WindowName} window
 * @returns {UsageReminder}
 */
export function readUsageReminder(dataDir, window) {
  const raw = readJsonObject(usageFile(dataDir, window)) ?? {};
  /** @type {UsageReminder['sessions']} */
  const sessions = {};
  const rawSessions = raw.sessions !== null && typeof raw.sessions === 'object' ? raw.sessions : {};
  for (const [id, value] of Object.entries(rawSessions)) {
    const entry = /** @type {Record<string, unknown>} */ (value ?? {});
    if (typeof entry.joinedAt === 'number') {
      sessions[id] = {
        transcriptPath: typeof entry.transcriptPath === 'string' ? entry.transcriptPath : null,
        joinedAt: entry.joinedAt,
      };
    }
  }
  return { pid: typeof raw.pid === 'number' ? raw.pid : null, sessions };
}

/**
 * Change a usage reminder under its mutex. Deletes the file once no session is left.
 * @param {string} dataDir
 * @param {WindowName} window
 * @param {(reminder: UsageReminder) => void} change
 * @returns {UsageReminder | null} The reminder after the change, or null if the mutex stayed busy.
 */
export function updateUsageReminder(dataDir, window, change) {
  const file = usageFile(dataDir, window);
  const result = withMutex(`${file}.lock`, () => {
    const reminder = readUsageReminder(dataDir, window);
    change(reminder);
    if (Object.keys(reminder.sessions).length === 0) {
      fs.rmSync(file, { force: true });
    } else {
      writeJsonAtomic(file, reminder);
    }
    return reminder;
  });
  if (!result.ok) {
    log('debug', `reminders: ${path.basename(file)} is locked; skipping`);
    return null;
  }
  return result.value;
}

/**
 * Add a session with a running turn to a window's usage reminder.
 * @param {string} dataDir
 * @param {WindowName} window
 * @param {string} sessionId
 * @param {string | null} transcriptPath
 * @returns {boolean} True if no live repeater holds the reminder, so one should start.
 */
export function joinUsageReminder(dataDir, window, sessionId, transcriptPath) {
  const reminder = updateUsageReminder(dataDir, window, (r) => {
    r.sessions[sessionId] = { transcriptPath, joinedAt: r.sessions[sessionId]?.joinedAt ?? Date.now() };
  });
  return reminder !== null && (reminder.pid === null || !isAlive(reminder.pid));
}

/**
 * Remove a session whose turn ended from every usage reminder.
 * @param {string} dataDir
 * @param {readonly WindowName[]} windows
 * @param {string} sessionId
 * @returns {void}
 */
export function leaveUsageReminders(dataDir, windows, sessionId) {
  for (const window of windows) {
    if (fs.existsSync(usageFile(dataDir, window))) {
      updateUsageReminder(dataDir, window, (r) => {
        delete r.sessions[sessionId];
      });
    }
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/**
 * The transcript files of a session: the main one and its subagents'.
 * @param {string} transcriptPath
 * @returns {string[]}
 */
function transcriptFiles(transcriptPath) {
  const sessionId = path.basename(transcriptPath, '.jsonl');
  const subagents = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(subagents).filter((name) => name.endsWith('.jsonl'));
  } catch {
    // No subagents yet.
  }
  return [transcriptPath, ...names.map((name) => path.join(subagents, name))];
}

/**
 * Note how long each of a session's transcripts is now.
 * @param {string} transcriptPath
 * @returns {ActivitySnapshot}
 */
export function activitySnapshot(transcriptPath) {
  /** @type {ActivitySnapshot} */
  const snapshot = {};
  for (const file of transcriptFiles(transcriptPath)) {
    try {
      snapshot[file] = fs.statSync(file).size;
    } catch {
      // Missing: counts as empty.
    }
  }
  return snapshot;
}

/**
 * Whether a user or assistant message was added to the session's transcripts
 * since the snapshot. Metadata lines that Claude Code writes at any time are
 * not activity.
 * @param {string} transcriptPath
 * @param {ActivitySnapshot} snapshot
 * @returns {boolean}
 */
export function hasActivity(transcriptPath, snapshot) {
  for (const file of transcriptFiles(transcriptPath)) {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    const from = snapshot[file] ?? 0;
    if (size <= from) {
      continue;
    }
    if (size - from > MAX_SCAN_BYTES) {
      return true;
    }
    if (readRange(file, from, size).split('\n').some(isMessageLine)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the transcript's last message is an Esc interrupt, which ends the
 * turn without a Stop hook.
 * @param {string} transcriptPath
 * @returns {boolean}
 */
export function lastTurnInterrupted(transcriptPath) {
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return false;
  }
  const lines = readRange(transcriptPath, Math.max(0, size - TAIL_BYTES), size).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseLine(lines[i]);
    if (entry?.type === 'assistant') {
      return false;
    }
    if (entry?.type === 'user') {
      return messageText(entry).startsWith(INTERRUPT_PREFIX);
    }
  }
  return false;
}

/**
 * @param {string} file
 * @param {number} from
 * @param {number} to
 * @returns {string}
 */
function readRange(file, from, to) {
  const buffer = Buffer.alloc(to - from);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

/**
 * @param {string} line
 * @returns {Record<string, unknown> | null}
 */
function parseLine(line) {
  if (!line.trim()) {
    return null;
  }
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    // A partly written last line.
    return null;
  }
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isMessageLine(line) {
  const type = parseLine(line)?.type;
  return type === 'user' || type === 'assistant';
}

/**
 * The text of a user entry's first content block, or its string content.
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function messageText(entry) {
  const message = /** @type {Record<string, unknown>} */ (entry.message ?? {});
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  const first = Array.isArray(content) ? content[0] : null;
  if (first && typeof first === 'object') {
    const block = /** @type {Record<string, unknown>} */ (first);
    const text = block.text ?? block.content;
    return typeof text === 'string' ? text : '';
  }
  return '';
}
