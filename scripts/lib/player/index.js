// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { playPosix, posixBackend } from './posix.js';
import { which } from './run.js';
import { speakText } from './tts.js';
import { playWindows } from './windows.js';

/**
 * @typedef {object} PlayOptions
 * @property {number} [volume] 0..1, clamped. Defaults to 1.
 * @property {number} [timeoutMs] Stop playback after this long. Defaults to 10000.
 */

/**
 * @param {number} volume
 * @returns {number}
 */
function clampVolume(volume) {
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
}

/**
 * Play a sound file. Resolves when playback ends or the timeout stops it.
 * @param {string} file
 * @param {PlayOptions} [options]
 * @returns {Promise<void>}
 */
export async function play(file, { volume = 1, timeoutMs = 10000 } = {}) {
  // Absolute paths can't be mistaken for command-line options and are what
  // MediaPlayer's Uri needs.
  const absolute = path.resolve(file);
  const stat = await fs.promises.stat(absolute).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Sound file not found: ${absolute}`);

  const level = clampVolume(volume);
  switch (process.platform) {
    case 'win32':
      return playWindows(absolute, level, timeoutMs);
    case 'darwin':
    case 'linux':
      return playPosix(absolute, level, timeoutMs);
    default:
      throw new Error('No audio backend available');
  }
}

/**
 * Speak text aloud. Resolves when speech ends or the timeout stops it.
 * @param {string} text
 * @param {PlayOptions} [options]
 * @returns {Promise<void>}
 */
export async function speak(text, { volume = 1, timeoutMs = 10000 } = {}) {
  if (!text.trim()) throw new Error('Nothing to speak');
  return speakText(text, clampVolume(volume), timeoutMs);
}

/**
 * Name the audio player in use on this machine, e.g. 'powershell', 'afplay'
 * or 'paplay'.
 * @returns {string | null}
 */
export function backend() {
  switch (process.platform) {
    case 'win32':
      return which('powershell.exe') ? 'powershell' : null;
    case 'darwin':
    case 'linux':
      return posixBackend();
    default:
      return null;
  }
}
