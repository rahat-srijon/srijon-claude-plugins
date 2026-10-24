// @ts-check
import path from 'node:path';
import { run, which } from './run.js';

/**
 * Linux players in order of preference, with the arguments each needs.
 * @type {{ name: string, wavOnly: boolean, args: (file: string, volume: number) => string[] }[]}
 */
const LINUX_PLAYERS = [
  {
    name: 'paplay',
    wavOnly: false,
    args: (file, volume) => [`--volume=${Math.round(volume * 65536)}`, file],
  },
  {
    name: 'pw-play',
    wavOnly: false,
    args: (file, volume) => [`--volume=${volume}`, file],
  },
  {
    name: 'ffplay',
    wavOnly: false,
    args: (file, volume) => [
      '-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(volume * 100)), file,
    ],
  },
  {
    name: 'aplay',
    wavOnly: true,
    args: (file) => ['-q', file],
  },
];

/**
 * Name the player that would be used on this macOS or Linux machine.
 * @returns {string | null}
 */
export function posixBackend() {
  if (process.platform === 'darwin') return which('afplay') ? 'afplay' : null;
  return LINUX_PLAYERS.find((player) => which(player.name))?.name ?? null;
}

/**
 * Play a sound file on macOS (afplay) or Linux (the first available player).
 * @param {string} file Absolute path to the sound file.
 * @param {number} volume 0..1.
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function playPosix(file, volume, timeoutMs) {
  if (process.platform === 'darwin') {
    return run('afplay', ['-v', String(volume), file], { timeoutMs });
  }
  const isWav = path.extname(file).toLowerCase() === '.wav';
  const player = LINUX_PLAYERS.find((p) => (isWav || !p.wavOnly) && which(p.name));
  if (!player) {
    return Promise.reject(new Error(`No audio player available for ${path.basename(file)}`));
  }
  return run(player.name, player.args(file, volume), { timeoutMs });
}
