// @ts-check
import path from 'node:path';
import { log } from '../log.js';
import { run } from './run.js';

// The file path and volume reach the scripts only through environment
// variables, so no value is ever parsed as PowerShell code.
const MEDIA_PLAYER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName PresentationCore',
  '  $player = New-Object System.Windows.Media.MediaPlayer',
  '  $player.Open([Uri]$env:CLAUDIO_FILE)',
  '  $player.Volume = [double]$env:CLAUDIO_VOLUME',
  '  $deadline = [DateTime]::UtcNow.AddSeconds(3)',
  '  while (-not $player.NaturalDuration.HasTimeSpan) {',
  "    if ([DateTime]::UtcNow -gt $deadline) { throw 'Timed out opening media' }",
  '    Start-Sleep -Milliseconds 20',
  '  }',
  '  $player.Play()',
  '  Start-Sleep -Milliseconds ([int]$player.NaturalDuration.TimeSpan.TotalMilliseconds + 150)',
  '  $player.Close()',
  '} catch {',
  '  exit 1',
  '}',
].join('\n');

const SOUND_PLAYER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  (New-Object System.Media.SoundPlayer $env:CLAUDIO_FILE).PlaySync()',
  '} catch {',
  '  exit 1',
  '}',
].join('\n');

/**
 * @param {string} script
 * @param {Record<string, string>} env
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function powershell(script, env, timeoutMs) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  return run('powershell.exe', args, { env, timeoutMs });
}

/**
 * Play a wav or mp3 file on Windows through WPF's MediaPlayer. WAV files fall
 * back to System.Media.SoundPlayer, which ignores the volume.
 * @param {string} file Absolute path to the sound file.
 * @param {number} volume 0..1.
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export async function playWindows(file, volume, timeoutMs) {
  const started = Date.now();
  try {
    await powershell(MEDIA_PLAYER_SCRIPT, { CLAUDIO_FILE: file, CLAUDIO_VOLUME: String(volume) }, timeoutMs);
  } catch (err) {
    const remainingMs = timeoutMs - (Date.now() - started);
    if (path.extname(file).toLowerCase() !== '.wav' || remainingMs <= 0) throw err;
    log('debug', `MediaPlayer failed, falling back to SoundPlayer (no volume) for ${file}`, err);
    await powershell(SOUND_PLAYER_SCRIPT, { CLAUDIO_FILE: file }, remainingMs);
  }
}
