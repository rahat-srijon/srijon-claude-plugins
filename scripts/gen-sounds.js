// @ts-check
// Synthesizes the plugin's default notification sounds from scratch, so the
// repository ships no third-party audio. Output is deterministic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const ATTACK_SECONDS = 0.005;
const RELEASE_SECONDS = 0.015;
const GLIDE_SECONDS = 0.08;

/** Relative amplitudes of harmonics 1, 2, 3, ... for each timbre. */
const TIMBRES = {
  bell: [1, 0.35, 0.12],
  soft: [1, 0.2],
  buzz: [1, 0.55, 0.4, 0.25, 0.12],
};

/**
 * @typedef {object} Note
 * @property {number} freq Target frequency in Hz.
 * @property {number} start Onset in seconds.
 * @property {number} dur Duration in seconds, including the decay tail.
 * @property {number} [from] Frequency in Hz to glide up or down from.
 * @property {number} [gain] Relative loudness, 1 by default.
 */

/**
 * @typedef {object} Sound
 * @property {string} file
 * @property {number} length Total length in seconds.
 * @property {keyof typeof TIMBRES} timbre
 * @property {number} peakDb Peak level after normalization, in dBFS.
 * @property {Note[]} notes
 */

/** @type {Sound[]} */
const SOUNDS = [
  {
    file: 'done.wav',
    length: 0.6,
    timbre: 'bell',
    peakDb: -3,
    notes: [
      { freq: 523.25, start: 0, dur: 0.3 },
      { freq: 659.25, start: 0.15, dur: 0.3 },
      { freq: 783.99, start: 0.3, dur: 0.3 },
    ],
  },
  {
    file: 'subagent-start.wav',
    length: 0.15,
    timbre: 'soft',
    peakDb: -9,
    notes: [{ freq: 880, start: 0, dur: 0.15, from: 740 }],
  },
  {
    file: 'subagent-done.wav',
    length: 0.35,
    timbre: 'soft',
    peakDb: -3,
    notes: [
      { freq: 783.99, start: 0, dur: 0.2 },
      { freq: 587.33, start: 0.12, dur: 0.23 },
    ],
  },
  {
    file: 'question.wav',
    length: 0.4,
    timbre: 'bell',
    peakDb: -3,
    notes: [
      { freq: 587.33, start: 0, dur: 0.16 },
      { freq: 880, start: 0.15, dur: 0.25, from: 587.33 },
    ],
  },
  {
    file: 'permission.wav',
    length: 0.5,
    timbre: 'bell',
    peakDb: -3,
    notes: [
      { freq: 987.77, start: 0, dur: 0.22 },
      { freq: 987.77, start: 0.25, dur: 0.25 },
    ],
  },
  {
    file: 'error.wav',
    length: 0.5,
    timbre: 'buzz',
    peakDb: -3,
    notes: [
      { freq: 246.94, start: 0, dur: 0.25 },
      { freq: 196, start: 0.22, dur: 0.28 },
    ],
  },
  {
    file: 'usage-near.wav',
    length: 0.45,
    timbre: 'bell',
    peakDb: -4,
    notes: [
      { freq: 880, start: 0, dur: 0.22 },
      { freq: 739.99, start: 0.18, dur: 0.27 },
    ],
  },
  {
    file: 'usage-reset.wav',
    length: 0.5,
    timbre: 'soft',
    peakDb: -3,
    notes: [
      { freq: 659.25, start: 0, dur: 0.25, from: 440 },
      { freq: 987.77, start: 0.2, dur: 0.3 },
    ],
  },
  {
    file: 'usage-week-near.wav',
    length: 0.65,
    timbre: 'bell',
    peakDb: -4,
    notes: [
      { freq: 659.25, start: 0, dur: 0.22 },
      { freq: 554.37, start: 0.18, dur: 0.22 },
      { freq: 440, start: 0.36, dur: 0.29 },
    ],
  },
  {
    file: 'usage-week-reset.wav',
    length: 0.75,
    timbre: 'soft',
    peakDb: -3,
    notes: [
      { freq: 587.33, start: 0, dur: 0.25, from: 392 },
      { freq: 783.99, start: 0.2, dur: 0.25 },
      { freq: 1174.66, start: 0.4, dur: 0.35 },
    ],
  },
];

/**
 * Add one additive-synthesis note to a mono sample buffer.
 * @param {Float64Array} samples Buffer to mix into.
 * @param {Note} note
 * @param {number[]} harmonics Relative harmonic amplitudes.
 */
function addNote(samples, note, harmonics) {
  const first = Math.round(note.start * SAMPLE_RATE);
  const count = Math.round(note.dur * SAMPLE_RATE);
  const decay = note.dur / 4;
  const gain = note.gain ?? 1;
  let phase = 0;
  for (let i = 0; i < count && first + i < samples.length; i++) {
    const t = i / SAMPLE_RATE;
    const glide = Math.min(t / GLIDE_SECONDS, 1);
    const freq = (note.from ?? note.freq) + (note.freq - (note.from ?? note.freq)) * glide;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    let value = 0;
    for (let h = 0; h < harmonics.length; h++) {
      value += harmonics[h] * Math.sin(phase * (h + 1));
    }
    const attack = Math.min(t / ATTACK_SECONDS, 1);
    const release = Math.min((note.dur - t) / RELEASE_SECONDS, 1);
    samples[first + i] += gain * value * attack * release * Math.exp(-t / decay);
  }
}

/**
 * Render a sound to normalized floating-point samples.
 * @param {Sound} sound
 * @returns {Float64Array}
 */
function render(sound) {
  const samples = new Float64Array(Math.round(sound.length * SAMPLE_RATE));
  for (const note of sound.notes) {
    addNote(samples, note, TIMBRES[sound.timbre]);
  }
  const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
  const scale = 10 ** (sound.peakDb / 20) / peak;
  return samples.map((s) => s * scale);
}

/**
 * Encode samples as a 16-bit PCM mono WAV file.
 * @param {string} file Destination path.
 * @param {Float64Array} samples Samples in the range -1 to 1.
 * @returns {number} Bytes written.
 */
function writeWav(file, samples) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  samples.forEach((s, i) => buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2));
  fs.writeFileSync(file, buffer);
  return buffer.length;
}

/**
 * Resolve the output directory from `--out <dir>`, defaulting to `<repo>/sounds`.
 * @param {string[]} args
 * @returns {string}
 */
function outputDir(args) {
  const flag = args.indexOf('--out');
  if (flag === -1) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..', 'sounds');
  }
  const dir = args[flag + 1];
  if (!dir) {
    throw new Error('--out requires a directory argument');
  }
  return path.resolve(dir);
}

try {
  const dir = outputDir(process.argv.slice(2));
  fs.mkdirSync(dir, { recursive: true });
  for (const sound of SOUNDS) {
    const file = path.join(dir, sound.file);
    const bytes = writeWav(file, render(sound));
    console.log(`wrote ${file} (${bytes} bytes)`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
