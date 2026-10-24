// @ts-check
// Usage-limit sounds. The status line shim imports onStatusLine(); the same
// file runs detached as `usage.js play <event>...` to play sounds without
// slowing the status line, and as `usage.js timer` for the opt-in reset timer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { EVENTS, loadConfig } from './lib/config.js';
import { log } from './lib/log.js';
import { dataDir as defaultDataDir, pluginRoot as defaultPluginRoot } from './lib/paths.js';
import { setupRecordFile, usageDir } from './lib/statusline.js';
import { nextReset, observe, parseRateLimits, readUsageState } from './lib/usage.js';
import { playEvent } from './hook.js';

/** @typedef {import('./lib/config.js').Config} Config */
/** @typedef {import('./lib/config.js').EventName} EventName */

/**
 * @typedef {object} Roots
 * @property {string} dataDir
 * @property {string} pluginRoot
 */

const PLAY_GAP_MS = 300;
/** The timer re-checks at least this often, so new windows and config changes are seen. */
const TIMER_MAX_SLEEP_MS = 10 * 60 * 1000;
/** Wake a little after `resets_at`, so the window has really ended. */
const TIMER_LATE_MS = 2000;

/**
 * Handle one status line update: record the rate-limit windows and start a
 * detached player for any sound that is due. Never throws and never writes to
 * stdout, which belongs to the status line.
 * @param {string} text Status line JSON.
 * @param {Partial<Roots> & { spawnDetached?: typeof spawnDetached }} [options]
 * @returns {Promise<EventName[]>} The events handed to the player.
 */
export async function onStatusLine(text, options = {}) {
  const {
    dataDir = defaultDataDir(),
    pluginRoot = defaultPluginRoot(),
    spawnDetached: start = spawnDetached,
  } = options;
  try {
    let input;
    try {
      input = JSON.parse(text);
    } catch {
      return [];
    }
    const projectDir = projectDirOf(input);
    const config = loadConfig({ dataDir, projectDir });
    const result = observe(dataDir, parseRateLimits(input), config);
    if (!result) {
      return [];
    }
    const audible = result.events.filter((event) => config.enabled && !config.muted && config.events[event].enabled);
    if (result.events.length > 0) {
      log('info', `usage: due ${result.events.join(', ')}; playing ${audible.join(', ') || 'none'}`);
    }
    if (audible.length > 0) {
      start(['play', ...audible, ...(projectDir ? ['--project-dir', projectDir] : [])], { dataDir, pluginRoot });
    }
    if (config.usageResetTimer && nextReset(result.state, config) !== null && !timerRunning(dataDir)) {
      start(['timer'], { dataDir, pluginRoot });
    }
    return audible;
  } catch (err) {
    log('error', 'usage: status line update failed', err);
    return [];
  }
}

/**
 * Run this file in a detached, hidden process that outlives the status line.
 * @param {string[]} args
 * @param {Roots} roots
 * @returns {void}
 */
export function spawnDetached(args, { dataDir, pluginRoot }) {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts', 'usage.js'), ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CLAUDIO_DATA_DIR: dataDir, CLAUDE_PLUGIN_ROOT: pluginRoot },
  });
  child.on('error', (err) => log('warn', `usage: cannot start ${args[0]}`, err));
  child.unref();
}

/**
 * Play events one after another through the normal gates.
 * @param {EventName[]} events
 * @param {Roots & { projectDir?: string }} options
 * @returns {Promise<void>}
 */
async function playEvents(events, { dataDir, pluginRoot, projectDir }) {
  const config = loadConfig({ dataDir, projectDir });
  for (const [index, event] of events.entries()) {
    if (index > 0) {
      await sleep(PLAY_GAP_MS);
    }
    const { status, detail } = await playEvent(config, event, { dataDir, pluginRoot });
    log('debug', `usage: event=${event} ${status}: ${detail}`);
  }
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
function pidFile(dataDir) {
  return path.join(usageDir(dataDir), 'timer.pid');
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/**
 * @param {string} dataDir
 * @returns {number | null} The pid in the pidfile, if any.
 */
function readPid(dataDir) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile(dataDir), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} dataDir
 * @returns {boolean}
 */
export function timerRunning(dataDir) {
  const pid = readPid(dataDir);
  return pid !== null && isAlive(pid);
}

/**
 * Take the pidfile, replacing one left by a dead process.
 * @param {string} dataDir
 * @returns {boolean} False when another timer is running.
 */
function claimPidFile(dataDir) {
  const file = pidFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') {
        throw err;
      }
    }
    if (timerRunning(dataDir)) {
      return false;
    }
    fs.rmSync(file, { force: true });
  }
  return false;
}

/**
 * @param {string} dataDir
 * @returns {void}
 */
function releasePidFile(dataDir) {
  if (readPid(dataDir) === process.pid) {
    fs.rmSync(pidFile(dataDir), { force: true });
  }
}

/**
 * Sleep until the next announced reset, play it, and repeat. Exits when no
 * reset is pending, the timer is turned off, setup is undone, or the plugin
 * root disappears after an update (the next status line run starts a new one).
 * @param {Roots} roots
 * @returns {Promise<void>}
 */
async function runTimer({ dataDir, pluginRoot }) {
  if (!claimPidFile(dataDir)) {
    return;
  }
  log('info', 'usage: reset timer started');
  try {
    for (;;) {
      const config = loadConfig({ dataDir });
      if (!config.usageResetTimer || !fs.existsSync(setupRecordFile(dataDir)) || !fs.existsSync(pluginRoot)) {
        break;
      }
      const result = observe(dataDir, {}, config);
      if (result && result.events.length > 0) {
        await playEvents(result.events, { dataDir, pluginRoot });
      }
      const next = nextReset(result?.state ?? readUsageState(dataDir), config);
      if (next === null) {
        break;
      }
      const waitMs = next * 1000 - Date.now() + TIMER_LATE_MS;
      await sleep(Math.min(Math.max(waitMs, TIMER_LATE_MS), TIMER_MAX_SLEEP_MS));
    }
  } finally {
    releasePidFile(dataDir);
    log('info', 'usage: reset timer stopped');
  }
}

/**
 * @param {unknown} input
 * @returns {string | undefined}
 */
function projectDirOf(input) {
  const record = /** @type {Record<string, unknown>} */ (input ?? {});
  const workspace = /** @type {Record<string, unknown>} */ (record.workspace ?? {});
  const dir = workspace.project_dir ?? record.cwd;
  return typeof dir === 'string' && dir ? dir : undefined;
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const roots = { dataDir: defaultDataDir(), pluginRoot: defaultPluginRoot() };
  const [mode, ...rest] = argv;
  if (mode === 'play') {
    const flag = rest.indexOf('--project-dir');
    const projectDir = flag === -1 ? undefined : rest[flag + 1];
    const names = flag === -1 ? rest : rest.slice(0, flag);
    const events = /** @type {EventName[]} */ (names.filter((name) => EVENTS.includes(/** @type {EventName} */ (name))));
    await playEvents(events, { ...roots, projectDir });
  } else if (mode === 'timer') {
    await runTimer(roots);
  } else {
    log('warn', `usage: unknown mode ${String(mode)}`);
  }
}

/**
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    // Node resolves symlinks in the main module's URL, so compare real paths.
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err) => log('error', 'usage: failed', err));
}
