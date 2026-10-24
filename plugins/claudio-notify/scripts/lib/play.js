// @ts-check
import { spawn } from 'node:child_process';
import path from 'node:path';
import { DEFAULTS, effectiveVolume, resolveSound } from './config.js';
import { log } from './log.js';
import { dataDir as defaultDataDir, pluginRoot as defaultPluginRoot } from './paths.js';
import { play as defaultPlay, speak as defaultSpeak } from './player/index.js';
import { isQuietTime, tryAcquire } from './state.js';

/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./config.js').EventName} EventName */
/** @typedef {import('./config.js').ResolvedSound} ResolvedSound */
/** @typedef {import('./state.js').Session} Session */

/**
 * @typedef {object} PlayOptions
 * @property {string} [family] Model family for per-model sounds.
 * @property {Session | null} [session] For the minimum turn length; null outside a session.
 * @property {typeof defaultPlay} [play]
 * @property {typeof defaultSpeak} [speak]
 * @property {string} [dataDir]
 * @property {string} [pluginRoot]
 */

/**
 * @typedef {object} Roots
 * @property {string} dataDir
 * @property {string} pluginRoot
 */

/**
 * Gate one event's sound (master switch, mute, quiet hours, event switch,
 * minimum turn length, cooldown) and play it, falling back to the bundled
 * sound. Playback failures are logged, not thrown.
 * @param {Config} config
 * @param {EventName} event
 * @param {PlayOptions} [options]
 * @returns {Promise<{ status: 'skipped' | 'played' | 'failed', detail: string }>}
 */
export async function playEvent(config, event, options = {}) {
  const {
    family = 'other',
    session = null,
    play = defaultPlay,
    speak = defaultSpeak,
    dataDir = defaultDataDir(),
    pluginRoot = defaultPluginRoot(),
  } = options;
  const reason = skipReason(config, event, session, dataDir);
  if (reason) {
    return { status: 'skipped', detail: reason };
  }

  const volume = effectiveVolume(config, event);
  const roots = { pluginRoot, dataDir };
  const sound = resolveSound(config, event, family, roots);
  // DEFAULTS has no overrides, so this resolves to the event's bundled sound.
  const bundled = resolveSound(DEFAULTS, event, family, roots);
  const attempts = sound.kind === bundled.kind && sound.value === bundled.value ? [sound] : [sound, bundled];
  for (const attempt of attempts) {
    try {
      if (attempt.kind === 'tts') {
        await speak(attempt.value, { volume });
      } else {
        await play(attempt.value, { volume });
      }
      const detail = attempt === sound ? describe(attempt) : `${describe(attempt)} (fallback)`;
      return { status: 'played', detail };
    } catch (err) {
      log('warn', `play: cannot play ${describe(attempt)}`, err);
    }
  }
  return { status: 'failed', detail: attempts.map(describe).join(', then ') };
}

/**
 * Whether an event can sound at all right now, ignoring the cooldown and the
 * minimum turn length. Used before starting something that repeats it.
 * @param {Config} config
 * @param {EventName} event
 * @returns {boolean}
 */
export function canSound(config, event) {
  return config.enabled && !config.muted && config.events[event].enabled;
}

/**
 * Run a plugin script in a detached, hidden process that outlives the caller,
 * such as a hook or the status line.
 * @param {string} script File name under `scripts/`.
 * @param {string[]} args
 * @param {Roots} roots
 * @returns {void}
 */
export function spawnDetached(script, args, { dataDir, pluginRoot }) {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts', script), ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CLAUDIO_DATA_DIR: dataDir, CLAUDE_PLUGIN_ROOT: pluginRoot },
  });
  child.on('error', (err) => log('warn', `play: cannot start ${script} ${args[0] ?? ''}`, err));
  child.unref();
}

/**
 * @param {Config} config
 * @param {EventName} event
 * @param {Session | null} session
 * @param {string} dataDir
 * @returns {string | null} Why the sound should not play, or null to play it.
 */
function skipReason(config, event, session, dataDir) {
  if (!config.enabled) {
    return 'plugin disabled';
  }
  if (config.muted) {
    return 'muted';
  }
  if (isQuietTime(config.quietHours)) {
    return 'quiet hours';
  }
  if (!config.events[event].enabled) {
    return 'event disabled';
  }
  if (event === 'agent_done' && session) {
    const seconds = session.turnSeconds();
    if (seconds !== null && seconds < config.minTurnSeconds) {
      return `turn took ${seconds.toFixed(1)}s, under minTurnSeconds ${config.minTurnSeconds}`;
    }
  }
  // Last, so an event skipped for another reason does not start a cooldown.
  if (!tryAcquire(dataDir, event, config.cooldownMs)) {
    return 'cooldown';
  }
  return null;
}

/**
 * @param {ResolvedSound} sound
 * @returns {string}
 */
function describe(sound) {
  return sound.kind === 'tts' ? `tts "${sound.value}"` : sound.value;
}
