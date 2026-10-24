// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

const MAX_BYTES = 1024 * 1024;

/** @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel */

/**
 * Get the path of the log file.
 * @returns {string}
 */
export function logFile() {
  return path.join(dataDir(), 'claudio.log');
}

/**
 * Append one line to the log file, rotating at 1 MiB. Never throws and never
 * writes to stdout or stderr, because it runs inside Claude Code hooks.
 * @param {LogLevel} level
 * @param {string} message
 * @param {unknown} [err]
 * @returns {void}
 */
export function log(level, message, err) {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotate(file);
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (err !== undefined) {
      line += `: ${err instanceof Error && err.stack ? err.stack : String(err)}`;
    }
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Logging must never break a hook.
  }
}

/**
 * Rotate the log file to `<file>.1` once it reaches the size limit.
 * @param {string} file
 * @returns {void}
 */
function rotate(file) {
  try {
    if (fs.statSync(file).size >= MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // Missing file or failed rotation: just keep appending.
  }
}
