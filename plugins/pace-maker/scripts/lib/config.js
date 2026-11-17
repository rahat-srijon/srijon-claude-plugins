// @ts-check
// The global settings file (config.json) for the Node side: the launcher, the settings server and their tests.
// hooks/lib/settings.ts holds the same shape for the mod; tests/config-parity.spec.ts keeps the two in step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ stepCount: boolean, percentage: boolean, stepLabel: boolean, elapsed: boolean, subagents: boolean }} Fields
 * @typedef {{ explainStop: boolean, askForTaskList: boolean }} AiSettings
 * @typedef {{
 *   enabled: boolean,
 *   display: 'bar' | 'text',
 *   barStyle: 'native' | 'blocks' | 'thin' | 'dots' | 'ascii',
 *   barWidth: number,
 *   fields: Fields,
 *   animation: 'smooth' | 'instant',
 *   showOnVscodeStatus: boolean,
 *   ai: AiSettings,
 * }} Config
 */

export const CONFIG_FILE = 'config.json';
export const DISPLAYS = Object.freeze(['bar', 'text']);
export const BAR_STYLES = Object.freeze(['native', 'blocks', 'thin', 'dots', 'ascii']);
export const ANIMATIONS = Object.freeze(['smooth', 'instant']);
export const BAR_WIDTH_MIN = 10;
export const BAR_WIDTH_MAX = 40;
const FIELD_KEYS = Object.freeze(['stepCount', 'percentage', 'stepLabel', 'elapsed', 'subagents']);
const AI_KEYS = Object.freeze(['explainStop', 'askForTaskList']);
const TOP_KEYS = Object.freeze(['enabled', 'display', 'barStyle', 'barWidth', 'fields', 'animation', 'showOnVscodeStatus', 'ai']);

/**
 * The settings directory: PACE_MAKER_DATA_DIR, else ~/.claude/plugins/data/pace-maker.
 * The mod reaches the same place through $.env (USERPROFILE or HOME), which is what os.homedir() reads.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dataDir(env = process.env) {
  const override = env.PACE_MAKER_DATA_DIR;
  if (override !== undefined && override !== '') {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'pace-maker');
}

/**
 * @param {string} [dir]
 * @returns {string}
 */
export function configPath(dir = dataDir()) {
  return path.join(dir, CONFIG_FILE);
}

/** @returns {Config} A fresh copy of the defaults. */
export function defaultConfig() {
  return {
    enabled: true,
    display: 'bar',
    barStyle: 'native',
    barWidth: 20,
    fields: { stepCount: true, percentage: false, stepLabel: true, elapsed: true, subagents: true },
    animation: 'smooth',
    showOnVscodeStatus: true,
    ai: { explainStop: false, askForTaskList: false },
  };
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isRec = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {unknown} v
 * @param {boolean} dflt
 * @returns {boolean}
 */
const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

/**
 * @template {string} T
 * @param {unknown} v
 * @param {readonly T[]} allowed
 * @param {T} dflt
 * @returns {T}
 */
const pick = (v, allowed, dflt) => (typeof v === 'string' && /** @type {readonly string[]} */ (allowed).includes(v) ? /** @type {T} */ (v) : dflt);

/**
 * Lenient read, the same rules as normalizeSettings in the mod: each field falls back on its own, never throws.
 * @param {unknown} raw
 * @returns {Config}
 */
export function normalizeConfig(raw) {
  const d = defaultConfig();
  try {
    if (!isRec(raw)) {
      return d;
    }
    const f = isRec(raw.fields) ? raw.fields : {};
    const a = isRec(raw.ai) ? raw.ai : {};
    const w = raw.barWidth;
    const width = typeof w === 'number' && Number.isFinite(w)
      ? Math.min(BAR_WIDTH_MAX, Math.max(BAR_WIDTH_MIN, Math.round(w)))
      : d.barWidth;
    return {
      enabled: bool(raw.enabled, d.enabled),
      display: pick(raw.display, DISPLAYS, d.display),
      barStyle: pick(raw.barStyle, BAR_STYLES, d.barStyle),
      barWidth: width,
      fields: {
        stepCount: bool(f.stepCount, d.fields.stepCount),
        percentage: bool(f.percentage, d.fields.percentage),
        stepLabel: bool(f.stepLabel, d.fields.stepLabel),
        elapsed: bool(f.elapsed, d.fields.elapsed),
        subagents: bool(f.subagents, d.fields.subagents),
      },
      animation: pick(raw.animation, ANIMATIONS, d.animation),
      showOnVscodeStatus: bool(raw.showOnVscodeStatus, d.showOnVscodeStatus),
      ai: {
        explainStop: bool(a.explainStop, d.ai.explainStop),
        askForTaskList: bool(a.askForTaskList, d.ai.askForTaskList),
      },
    };
  } catch {
    return d;
  }
}

/**
 * Strict check for what the page sends: every key present with the right type, no unknown keys. Nothing is coerced.
 * @param {unknown} raw
 * @returns {{ ok: true, value: Config } | { ok: false, errors: string[] }}
 */
export function validateConfig(raw) {
  /** @type {string[]} */
  const errors = [];
  if (!isRec(raw)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) {
      errors.push(`unknown key "${key}"`);
    }
  }
  /**
   * @param {string} name
   * @param {unknown} v
   */
  const needBool = (name, v) => {
    if (typeof v !== 'boolean') {
      errors.push(`${name} must be true or false`);
    }
  };
  /**
   * @param {string} name
   * @param {unknown} v
   * @param {readonly string[]} allowed
   */
  const needOne = (name, v, allowed) => {
    if (typeof v !== 'string' || !allowed.includes(v)) {
      errors.push(`${name} must be one of ${allowed.join(', ')}`);
    }
  };
  needBool('enabled', raw.enabled);
  needOne('display', raw.display, DISPLAYS);
  needOne('barStyle', raw.barStyle, BAR_STYLES);
  const w = raw.barWidth;
  if (typeof w !== 'number' || !Number.isInteger(w) || w < BAR_WIDTH_MIN || w > BAR_WIDTH_MAX) {
    errors.push(`barWidth must be a whole number from ${BAR_WIDTH_MIN} to ${BAR_WIDTH_MAX}`);
  }
  needOne('animation', raw.animation, ANIMATIONS);
  needBool('showOnVscodeStatus', raw.showOnVscodeStatus);
  for (const [group, keys, value] of /** @type {const} */ ([['fields', FIELD_KEYS, raw.fields], ['ai', AI_KEYS, raw.ai]])) {
    if (!isRec(value)) {
      errors.push(`${group} must be an object`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        errors.push(`unknown key "${group}.${key}"`);
      }
    }
    for (const key of keys) {
      needBool(`${group}.${key}`, value[key]);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: normalizeConfig(raw) };
}

/**
 * Read config.json. A missing, unreadable or garbled file gives the defaults. Never throws.
 * @param {string} [dir]
 * @returns {Config}
 */
export function loadConfig(dir = dataDir()) {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath(dir), 'utf8')));
  } catch {
    return defaultConfig();
  }
}

/**
 * Write config.json atomically: a temp file in the same directory, then a rename over the target,
 * so the mod (which reads it at every turn) never sees half a file.
 * @param {Config} config
 * @param {string} [dir]
 * @returns {void}
 */
export function saveConfig(config, dir = dataDir()) {
  const target = configPath(dir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, 'utf8');
  try {
    renameWithRetry(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Windows can refuse a rename for a moment while another process has the target open.
 * @param {string} from
 * @param {string} to
 * @returns {void}
 */
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
