// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MUTEX_STALE_MS = 2000;
const MAX_ID_LENGTH = 128;

let pruned = false;

/**
 * @typedef {object} SessionState
 * @property {number | null} turnStartedAt
 * @property {string | null} model
 * @property {number} updatedAt
 */

/**
 * @typedef {object} Session
 * @property {(now?: number) => void} markTurnStart
 * @property {(now?: number) => number | null} turnSeconds
 * @property {() => string | null} getModel
 * @property {(modelId: string) => void} setModel
 */

/**
 * @typedef {object} QuietHours
 * @property {boolean} enabled
 * @property {string} from Local time, `HH:MM`.
 * @property {string} to Local time, `HH:MM`.
 */

/**
 * Reduce an arbitrary string to a safe file name stem.
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 */
function sanitize(value, fallback) {
  const clean = String(value).replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_ID_LENGTH);
  return clean || fallback;
}

/**
 * Write a JSON file atomically: temp file in the same directory, then rename.
 * @param {string} file
 * @param {unknown} data
 * @returns {void}
 */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Read a JSON object from a file, or null if it is missing or malformed.
 * @param {string} file
 * @returns {Record<string, unknown> | null}
 */
export function readJsonObject(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
      log('debug', `state: cannot read ${file}`, err);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Delete session files not modified within the retention window. Runs at most
 * once per process.
 * @param {string} sessionsDir
 * @returns {void}
 */
function pruneSessions(sessionsDir) {
  if (pruned) {
    return;
  }
  pruned = true;
  try {
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    for (const name of fs.readdirSync(sessionsDir)) {
      const file = path.join(sessionsDir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
        }
      } catch {
        // Another process may have removed it already.
      }
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
      log('debug', 'state: session pruning failed', err);
    }
  }
}

/**
 * Open the persisted state of one Claude Code session. Every method re-reads
 * the file, because each hook event runs in a fresh process.
 * @param {string} dataDir
 * @param {string} sessionId
 * @returns {Session}
 */
export function openSession(dataDir, sessionId) {
  const sessionsDir = path.join(dataDir, 'sessions');
  const file = path.join(sessionsDir, `${sanitize(sessionId, 'unknown')}.json`);
  pruneSessions(sessionsDir);

  /** @returns {SessionState} */
  const load = () => {
    const raw = readJsonObject(file) ?? {};
    return {
      turnStartedAt: typeof raw.turnStartedAt === 'number' ? raw.turnStartedAt : null,
      model: typeof raw.model === 'string' ? raw.model : null,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  };

  /** @param {Partial<SessionState>} changes */
  const save = (changes) => {
    try {
      writeJsonAtomic(file, { ...load(), ...changes, updatedAt: Date.now() });
    } catch (err) {
      log('debug', `state: cannot write ${file}`, err);
    }
  };

  return {
    markTurnStart(now = Date.now()) {
      save({ turnStartedAt: now });
    },
    turnSeconds(now = Date.now()) {
      const { turnStartedAt } = load();
      return turnStartedAt === null ? null : Math.max(0, (now - turnStartedAt) / 1000);
    },
    getModel() {
      return load().model;
    },
    setModel(modelId) {
      save({ model: modelId });
    },
  };
}

/**
 * Take the exclusive-create mutex. Returns the open descriptor, or null when
 * another process currently holds a fresh mutex.
 * @param {string} mutexFile
 * @returns {number | null}
 */
function acquireMutex(mutexFile) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return fs.openSync(mutexFile, 'wx');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') {
        throw err;
      }
    }
    let ageMs;
    try {
      ageMs = Date.now() - fs.statSync(mutexFile).mtimeMs;
    } catch {
      continue; // Released between open and stat: retry.
    }
    if (ageMs < MUTEX_STALE_MS) {
      return null;
    }
    // A crashed process left it behind.
    fs.rmSync(mutexFile, { force: true });
  }
  return null;
}

/**
 * Coalesce repeated events: succeeds for the first caller within a cooldown
 * window and fails for the rest. Fails open on any file system error so the
 * user still hears the sound.
 * @param {string} dataDir
 * @param {string} key
 * @param {number} cooldownMs
 * @param {number} [now]
 * @returns {boolean} True if the caller should proceed.
 */
export function tryAcquire(dataDir, key, cooldownMs, now = Date.now()) {
  if (cooldownMs <= 0) {
    return true;
  }
  const locksDir = path.join(dataDir, 'locks');
  const name = sanitize(key, 'default');
  const stampFile = path.join(locksDir, `${name}.json`);
  const mutexFile = path.join(locksDir, `${name}.lock`);
  let fd = null;
  try {
    fs.mkdirSync(locksDir, { recursive: true });
    fd = acquireMutex(mutexFile);
    if (fd === null) {
      return false;
    }
    const at = readJsonObject(stampFile)?.at;
    if (typeof at === 'number' && now - at < cooldownMs) {
      return false;
    }
    writeJsonAtomic(stampFile, { at: now });
    return true;
  } catch (err) {
    log('debug', `state: tryAcquire failed for ${name}`, err);
    return true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
        fs.rmSync(mutexFile, { force: true });
      } catch (err) {
        // A leftover mutex goes stale and is reclaimed by the next caller.
        log('debug', `state: cannot release mutex for ${name}`, err);
      }
    }
  }
}

/**
 * Run `fn` while holding an exclusive mutex file, retrying briefly when another
 * process holds it.
 * @template T
 * @param {string} mutexFile
 * @param {() => T} fn
 * @param {{ attempts?: number, waitMs?: number }} [options]
 * @returns {{ ok: true, value: T } | { ok: false }} Not ok when the mutex stayed busy.
 * @throws {Error} Whatever `fn` throws, or file system errors other than a busy mutex.
 */
export function withMutex(mutexFile, fn, { attempts = 10, waitMs = 20 } = {}) {
  fs.mkdirSync(path.dirname(mutexFile), { recursive: true });
  let fd = acquireMutex(mutexFile);
  for (let attempt = 1; fd === null && attempt < attempts; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    fd = acquireMutex(mutexFile);
  }
  if (fd === null) {
    return { ok: false };
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    try {
      fs.closeSync(fd);
      fs.rmSync(mutexFile, { force: true });
    } catch (err) {
      log('debug', `state: cannot release mutex ${mutexFile}`, err);
    }
  }
}

/**
 * Convert `HH:MM` to minutes since midnight.
 * @param {string} value
 * @returns {number | null}
 */
function toMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/**
 * Whether `now` falls inside the quiet-hours window (local time, start
 * inclusive, end exclusive). Windows may wrap past midnight.
 * @param {QuietHours} quietHours
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isQuietTime(quietHours, now = new Date()) {
  if (!quietHours || !quietHours.enabled) {
    return false;
  }
  const from = toMinutes(quietHours.from);
  const to = toMinutes(quietHours.to);
  if (from === null || to === null || from === to) {
    return false;
  }
  const current = now.getHours() * 60 + now.getMinutes();
  return from < to ? current >= from && current < to : current >= from || current < to;
}
