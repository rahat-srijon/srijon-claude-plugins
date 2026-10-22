// @ts-check
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} RunOptions
 * @property {Record<string, string>} [env] Variables merged over `process.env`.
 * @property {number} [timeoutMs] Kill the process after this long; not an error.
 */

/**
 * Run a command to completion with no stdio and no console window.
 * Resolves on exit code 0 or when the timeout kills the process; rejects if
 * the command cannot be started or exits non-zero.
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} [options]
 * @returns {Promise<void>}
 */
export function run(command, args, { env, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;

    /** @param {Error | null} err */
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('error', (err) => {
      finish(new Error(`Failed to start ${command}: ${err.message}`, { cause: err }));
    });

    child.once('exit', (code, signal) => {
      if (code === 0 || timedOut) {
        finish(null);
      } else {
        const reason = code === null ? `signal ${signal}` : `code ${code}`;
        finish(new Error(`${command} exited with ${reason}`));
      }
    });
  });
}

/** @type {Map<string, string | null>} */
const whichCache = new Map();

/**
 * Find an executable on PATH, honouring PATHEXT on Windows. Results are
 * memoised for the life of the process.
 * @param {string} name
 * @returns {string | null} Absolute path, or null if not found.
 */
export function which(name) {
  const cached = whichCache.get(name);
  if (cached !== undefined) return cached;
  const found = lookup(name);
  whichCache.set(name, found);
  return found;
}

/**
 * @param {string} name
 * @returns {string | null}
 */
function lookup(name) {
  const isWindows = process.platform === 'win32';
  const dirs = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => (isWindows ? dir.replace(/^"(.*)"$/, '$1') : dir))
    .filter(Boolean);

  let names = [name];
  if (isWindows) {
    const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)
      .map((ext) => ext.toLowerCase());
    if (!exts.includes(path.extname(name).toLowerCase())) {
      names = exts.map((ext) => name + ext);
    }
  }

  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (isExecutable(full, isWindows)) return full;
    }
  }
  return null;
}

/**
 * @param {string} file
 * @param {boolean} isWindows
 * @returns {boolean}
 */
function isExecutable(file, isWindows) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    // Windows has no execute bit; PATHEXT already decided what is runnable.
    if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
