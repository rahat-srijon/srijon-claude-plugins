// @ts-check
import { run, which } from './run.js';

// Text and volume arrive through environment variables, so no value is ever
// parsed as PowerShell code.
const SPEECH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Speech',
  '  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '  $synth.Volume = [int]$env:CLAUDIO_VOLUME',
  '  $synth.Speak($env:CLAUDIO_TEXT)',
  '  $synth.Dispose()',
  '} catch {',
  '  exit 1',
  '}',
].join('\n');

/**
 * Name the text-to-speech engine available on this machine.
 * @returns {string | null}
 */
export function ttsBackend() {
  switch (process.platform) {
    case 'win32':
      return which('powershell.exe') ? 'powershell' : null;
    case 'darwin':
      return which('say') ? 'say' : null;
    case 'linux':
      if (which('spd-say')) return 'spd-say';
      return which('espeak') ? 'espeak' : null;
    default:
      return null;
  }
}

/**
 * Keep text that starts with a dash from being parsed as a command-line option.
 * @param {string} text
 * @returns {string}
 */
function asOperand(text) {
  return text.startsWith('-') ? ` ${text}` : text;
}

/**
 * Speak text aloud with the platform's speech engine.
 * @param {string} text
 * @param {number} volume 0..1.
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function speakText(text, volume, timeoutMs) {
  switch (ttsBackend()) {
    case 'powershell':
      return run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SPEECH_SCRIPT],
        { env: { CLAUDIO_TEXT: text, CLAUDIO_VOLUME: String(Math.round(volume * 100)) }, timeoutMs },
      );
    case 'say':
      return run('say', [`[[volm ${volume.toFixed(2)}]] ${text}`], { timeoutMs });
    case 'spd-say':
      return run('spd-say', ['-w', '-i', String(Math.round(volume * 200 - 100)), asOperand(text)], { timeoutMs });
    case 'espeak':
      return run('espeak', ['-a', String(Math.round(volume * 200)), asOperand(text)], { timeoutMs });
    default:
      return Promise.reject(new Error('No text-to-speech engine available'));
  }
}
