// @ts-check
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';
import { dataDir as defaultDataDir, pluginRoot as defaultPluginRoot } from './paths.js';

/**
 * @typedef {'agent_done' | 'subagent_start' | 'subagent_done' | 'question' | 'permission' | 'error'
 *   | UsageNearEventName | UsageResetEventName} EventName
 */
/** @typedef {'agent_done' | 'subagent_start' | 'subagent_done'} AgentEventName */
/** @typedef {'usage_5h_near' | 'usage_week_near'} UsageNearEventName */
/** @typedef {'usage_5h_reset' | 'usage_week_reset'} UsageResetEventName */

/**
 * @typedef {object} EventConfig
 * @property {boolean} enabled
 * @property {string} sound Sound spec, see {@link parseSoundSpec}.
 * @property {number | null} volume 0..1, or null to use the global volume.
 * @property {Record<string, string>} [byModel] Agent events only: model family to sound spec.
 * @property {number[]} [thresholds] Usage "near" events only: percentages that each sound once
 *   per limit window, ascending.
 * @property {number} [minPercent] Usage "reset" events only: the reset sounds only if the window
 *   that ended had reached this percentage.
 */

/**
 * @typedef {object} QuietHours
 * @property {boolean} enabled
 * @property {string} from Local time as HH:MM.
 * @property {string} to Local time as HH:MM.
 */

/**
 * @typedef {object} Config
 * @property {boolean} enabled
 * @property {boolean} muted
 * @property {number} volume 0..1.
 * @property {QuietHours} quietHours
 * @property {number} minTurnSeconds
 * @property {number} cooldownMs
 * @property {Record<EventName, EventConfig>} events
 * @property {boolean} usageResetTimer Keep a background timer that plays the reset sounds when no
 *   session is running.
 * @property {{ template: string }} tts
 * @property {Record<string, string>} modelPatterns Model family to the pattern that identifies it.
 */

/**
 * @typedef {object} ParsedSoundSpec
 * @property {'default' | 'user' | 'path' | 'tts'} type
 * @property {string} value Bundled id, user filename, absolute path, or '' for tts.
 */

/** @typedef {{ kind: 'file', value: string } | { kind: 'tts', value: string }} ResolvedSound */

/** @type {readonly EventName[]} */
export const EVENTS = Object.freeze([
  'agent_done',
  'subagent_start',
  'subagent_done',
  'question',
  'permission',
  'error',
  'usage_5h_near',
  'usage_5h_reset',
  'usage_week_near',
  'usage_week_reset',
]);

/**
 * Events that support per-model sound overrides.
 * @type {readonly AgentEventName[]}
 */
export const AGENT_EVENTS = Object.freeze(['agent_done', 'subagent_start', 'subagent_done']);

/**
 * Usage-limit events that sound when a window crosses one of its thresholds.
 * @type {readonly UsageNearEventName[]}
 */
export const USAGE_NEAR_EVENTS = Object.freeze(['usage_5h_near', 'usage_week_near']);

/**
 * Usage-limit events that sound when a window resets.
 * @type {readonly UsageResetEventName[]}
 */
export const USAGE_RESET_EVENTS = Object.freeze(['usage_5h_reset', 'usage_week_reset']);

/** @type {Readonly<Record<EventName, string>>} */
export const EVENT_LABELS = Object.freeze({
  agent_done: 'finished',
  subagent_start: 'started a subagent',
  subagent_done: 'subagent finished',
  question: 'has a question',
  permission: 'needs permission',
  error: 'hit an error',
  usage_5h_near: 'is near the 5-hour limit',
  usage_5h_reset: '5-hour limit reset',
  usage_week_near: 'is near the weekly limit',
  usage_week_reset: 'weekly limit reset',
});

/**
 * Ids of the WAV files shipped in `<pluginRoot>/sounds/<id>.wav`.
 * @type {readonly string[]}
 */
export const BUNDLED_SOUNDS = Object.freeze([
  'done',
  'subagent-start',
  'subagent-done',
  'question',
  'permission',
  'error',
  'usage-near',
  'usage-reset',
  'usage-week-near',
  'usage-week-reset',
]);

/** @type {Readonly<Config>} */
export const DEFAULTS = deepFreeze({
  enabled: true,
  muted: false,
  volume: 0.8,
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
  minTurnSeconds: 15,
  cooldownMs: 1500,
  events: {
    agent_done: { enabled: true, sound: 'default:done', volume: null, byModel: {} },
    subagent_start: { enabled: false, sound: 'default:subagent-start', volume: null, byModel: {} },
    subagent_done: { enabled: true, sound: 'default:subagent-done', volume: null, byModel: {} },
    question: { enabled: true, sound: 'default:question', volume: null },
    permission: { enabled: true, sound: 'default:permission', volume: null },
    error: { enabled: true, sound: 'default:error', volume: null },
    usage_5h_near: { enabled: true, sound: 'default:usage-near', volume: null, thresholds: [80, 95] },
    usage_5h_reset: { enabled: true, sound: 'default:usage-reset', volume: null, minPercent: 80 },
    usage_week_near: { enabled: true, sound: 'default:usage-week-near', volume: null, thresholds: [80, 95] },
    usage_week_reset: { enabled: true, sound: 'default:usage-week-reset', volume: null, minPercent: 80 },
  },
  usageResetTimer: false,
  tts: { template: '{model} {event}' },
  modelPatterns: { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', fable: 'fable' },
});

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const AUDIO_EXT_RE = /\.(?:wav|mp3)$/i;
// ':' is rejected too because on Windows it names a drive or an NTFS alternate data stream.
const PATH_CHARS_RE = /[\\/:]/;
const EVENT_KEYS = Object.freeze(['enabled', 'sound', 'volume']);
const AGENT_EVENT_KEYS = Object.freeze([...EVENT_KEYS, 'byModel']);
const USAGE_NEAR_EVENT_KEYS = Object.freeze([...EVENT_KEYS, 'thresholds']);
const USAGE_RESET_EVENT_KEYS = Object.freeze([...EVENT_KEYS, 'minPercent']);
const MAX_THRESHOLDS = 10;

/**
 * Parse a sound spec string.
 * @param {unknown} spec
 * @returns {ParsedSoundSpec | null} Null when the spec is invalid.
 */
export function parseSoundSpec(spec) {
  if (typeof spec !== 'string' || spec.includes('\0')) {
    return null;
  }
  if (spec === 'tts') {
    return { type: 'tts', value: '' };
  }
  if (spec.startsWith('default:')) {
    const id = spec.slice('default:'.length);
    return BUNDLED_SOUNDS.includes(id) ? { type: 'default', value: id } : null;
  }
  if (spec.startsWith('user:')) {
    const name = spec.slice('user:'.length);
    const isBasename = !PATH_CHARS_RE.test(name) && !name.includes('..');
    return isBasename && AUDIO_EXT_RE.test(name) ? { type: 'user', value: name } : null;
  }
  if (path.isAbsolute(spec) && AUDIO_EXT_RE.test(spec)) {
    return { type: 'path', value: spec };
  }
  return null;
}

/**
 * Load the effective config: DEFAULTS, then `<dataDir>/config.json`, then
 * `<projectDir>/.claude/claudio.json`, normalized. Never throws.
 * @param {{ dataDir?: string, projectDir?: string }} [options]
 * @returns {Config} A fresh, mutable object.
 */
export function loadConfig(options = {}) {
  try {
    const { dataDir = defaultDataDir(), projectDir } = options;
    const files = [path.join(dataDir, 'config.json')];
    if (projectDir) {
      files.push(path.join(projectDir, '.claude', 'claudio.json'));
    }
    /** @type {Record<string, unknown>} */
    let merged = {};
    for (const file of files) {
      const layer = readLayer(file);
      if (layer) {
        merged = /** @type {Record<string, unknown>} */ (deepMerge(merged, layer));
      }
    }
    return normalize(merged);
  } catch (err) {
    log('error', 'config: failed to load config, using defaults', err);
    return normalize({});
  }
}

/**
 * Normalize a config and write it atomically to `<dataDir>/config.json`.
 * @param {unknown} config
 * @param {{ dataDir?: string }} [options]
 * @returns {Config} The normalized config that was written.
 * @throws {Error} On IO errors.
 */
export function saveConfig(config, { dataDir = defaultDataDir() } = {}) {
  const normalized = normalize(config);
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  const tmp = path.join(dataDir, `.config.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup; the original error is the one worth reporting.
    }
    throw err;
  }
  return normalized;
}

/**
 * Resolve the sound to play for an event. Tries the per-model override (agent
 * events only), then the event's sound, then the bundled default, which is
 * returned even when missing on disk.
 * @param {Config} config
 * @param {EventName} event
 * @param {string} family
 * @param {{ pluginRoot?: string, dataDir?: string }} [options]
 * @returns {ResolvedSound}
 */
export function resolveSound(config, event, family, options = {}) {
  const { pluginRoot = defaultPluginRoot(), dataDir = defaultDataDir() } = options;
  const eventConfig = config.events[event];
  /** @type {unknown[]} */
  const candidates = [];
  if (isAgentEvent(event) && eventConfig.byModel && Object.hasOwn(eventConfig.byModel, family)) {
    candidates.push(eventConfig.byModel[family]);
  }
  candidates.push(eventConfig.sound);

  for (const spec of candidates) {
    const parsed = parseSoundSpec(spec);
    if (!parsed) {
      log('warn', `config: invalid sound spec ${preview(spec)} for ${event}; falling back`);
      continue;
    }
    if (parsed.type === 'tts') {
      return { kind: 'tts', value: ttsText(config, event, family) };
    }
    const file = specPath(parsed, pluginRoot, dataDir);
    if (isFile(file)) {
      return { kind: 'file', value: file };
    }
    log('warn', `config: sound ${preview(spec)} for ${event} not found at ${file}; falling back`);
  }

  const bundled = /** @type {ParsedSoundSpec} */ (parseSoundSpec(DEFAULTS.events[event].sound));
  return { kind: 'file', value: specPath(bundled, pluginRoot, dataDir) };
}

/**
 * Build the text-to-speech phrase for an event, e.g. 'Opus finished'.
 * @param {Config} config
 * @param {EventName} event
 * @param {string} family
 * @returns {string}
 */
export function ttsText(config, event, family) {
  const known = family !== 'other' && Object.hasOwn(config.modelPatterns, family);
  const model = known ? family.charAt(0).toUpperCase() + family.slice(1) : 'Claude';
  return config.tts.template
    .replace(/\{model\}/g, () => model)
    .replace(/\{event\}/g, () => EVENT_LABELS[event])
    .trim();
}

/**
 * Get the volume for an event: its own volume, or the global one when null.
 * @param {Config} config
 * @param {EventName} event
 * @returns {number}
 */
export function effectiveVolume(config, event) {
  const volume = config.events[event].volume;
  return volume === null ? config.volume : volume;
}

/**
 * @param {ParsedSoundSpec} parsed A non-tts spec.
 * @param {string} pluginRoot
 * @param {string} dataDir
 * @returns {string}
 */
function specPath(parsed, pluginRoot, dataDir) {
  if (parsed.type === 'default') {
    return path.join(pluginRoot, 'sounds', `${parsed.value}.wav`);
  }
  if (parsed.type === 'user') {
    return path.join(dataDir, 'sounds', parsed.value);
  }
  return path.resolve(parsed.value);
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {EventName} event
 * @returns {event is AgentEventName}
 */
function isAgentEvent(event) {
  return /** @type {readonly string[]} */ (AGENT_EVENTS).includes(event);
}

/**
 * @param {EventName} event
 * @returns {event is UsageNearEventName}
 */
export function isUsageNearEvent(event) {
  return /** @type {readonly string[]} */ (USAGE_NEAR_EVENTS).includes(event);
}

/**
 * @param {EventName} event
 * @returns {event is UsageResetEventName}
 */
export function isUsageResetEvent(event) {
  return /** @type {readonly string[]} */ (USAGE_RESET_EVENTS).includes(event);
}

/**
 * Read one JSON config layer. Missing files are silently skipped.
 * @param {string} file
 * @returns {Record<string, unknown> | undefined}
 */
function readLayer(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log('warn', `config: cannot read ${file}; skipping`, err);
    }
    return undefined;
  }
  let data;
  try {
    // Windows editors often save UTF-8 with a BOM, which JSON.parse rejects.
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    log('warn', `config: invalid JSON in ${file}; skipping`, err instanceof Error ? err.message : err);
    return undefined;
  }
  if (!isPlainObject(data)) {
    log('warn', `config: ${file} must contain a JSON object; skipping`);
    return undefined;
  }
  return data;
}

/**
 * Validate a config against DEFAULTS, replacing invalid values with defaults.
 * @param {unknown} input
 * @returns {Config}
 */
function normalize(input) {
  if (!isPlainObject(input)) {
    log('warn', `config: expected an object, got ${preview(input)}; using defaults`);
  }
  const raw = asRecord(deepMerge(DEFAULTS, isPlainObject(input) ? input : {}));
  warnUnknown('', raw, Object.keys(DEFAULTS));

  const quiet = objectOr('quietHours', raw.quietHours, DEFAULTS.quietHours);
  warnUnknown('quietHours', quiet, Object.keys(DEFAULTS.quietHours));
  const tts = objectOr('tts', raw.tts, DEFAULTS.tts);
  warnUnknown('tts', tts, Object.keys(DEFAULTS.tts));
  const modelPatterns = normalizeModelPatterns(raw.modelPatterns);

  return {
    enabled: validOr('enabled', raw.enabled, DEFAULTS.enabled, isBoolean),
    muted: validOr('muted', raw.muted, DEFAULTS.muted, isBoolean),
    volume: numberOr('volume', raw.volume, DEFAULTS.volume, clampUnit),
    quietHours: {
      enabled: validOr('quietHours.enabled', quiet.enabled, DEFAULTS.quietHours.enabled, isBoolean),
      from: validOr('quietHours.from', quiet.from, DEFAULTS.quietHours.from, isTime),
      to: validOr('quietHours.to', quiet.to, DEFAULTS.quietHours.to, isTime),
    },
    minTurnSeconds: numberOr('minTurnSeconds', raw.minTurnSeconds, DEFAULTS.minTurnSeconds, toCount),
    cooldownMs: numberOr('cooldownMs', raw.cooldownMs, DEFAULTS.cooldownMs, toCount),
    events: normalizeEvents(raw.events, modelPatterns),
    usageResetTimer: validOr('usageResetTimer', raw.usageResetTimer, DEFAULTS.usageResetTimer, isBoolean),
    tts: {
      template: validOr('tts.template', tts.template, DEFAULTS.tts.template, isNonEmptyString),
    },
    modelPatterns,
  };
}

/**
 * @param {unknown} value
 * @param {Record<string, string>} modelPatterns Already normalized.
 * @returns {Record<EventName, EventConfig>}
 */
function normalizeEvents(value, modelPatterns) {
  const src = objectOr('events', value, DEFAULTS.events);
  warnUnknown('events', src, EVENTS);
  const events = /** @type {Record<EventName, EventConfig>} */ ({});
  for (const event of EVENTS) {
    const keyPath = `events.${event}`;
    const def = DEFAULTS.events[event];
    const raw = objectOr(keyPath, src[event], def);
    const agent = isAgentEvent(event);
    const near = isUsageNearEvent(event);
    const reset = isUsageResetEvent(event);
    warnUnknown(keyPath, raw, eventKeys(event));
    /** @type {EventConfig} */
    const out = {
      enabled: validOr(`${keyPath}.enabled`, raw.enabled, def.enabled, isBoolean),
      sound: validOr(`${keyPath}.sound`, raw.sound, def.sound, isSoundSpec),
      volume: raw.volume === null ? null : numberOr(`${keyPath}.volume`, raw.volume, def.volume, clampUnit),
    };
    if (agent) {
      out.byModel = normalizeByModel(`${keyPath}.byModel`, raw.byModel, modelPatterns);
    }
    if (near) {
      out.thresholds = normalizeThresholds(`${keyPath}.thresholds`, raw.thresholds, def.thresholds ?? []);
    }
    if (reset) {
      out.minPercent = numberOr(`${keyPath}.minPercent`, raw.minPercent, def.minPercent ?? 0, clampPercent);
    }
    events[event] = out;
  }
  return events;
}

/**
 * Keep only entries whose key is a known family and whose value is a valid spec.
 * @param {string} keyPath
 * @param {unknown} value
 * @param {Record<string, string>} modelPatterns
 * @returns {Record<string, string>}
 */
function normalizeByModel(keyPath, value, modelPatterns) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [family, spec] of Object.entries(objectOr(keyPath, value, {}))) {
    if (!Object.hasOwn(modelPatterns, family)) {
      log('warn', `config: ignoring ${keyPath}.${family}: unknown model family`);
    } else if (!isSoundSpec(spec)) {
      log('warn', `config: ignoring ${keyPath}.${family}: invalid sound spec ${preview(spec)}`);
    } else {
      out[family] = /** @type {string} */ (spec);
    }
  }
  return out;
}

/**
 * The keys an event's config may have.
 * @param {EventName} event
 * @returns {readonly string[]}
 */
function eventKeys(event) {
  if (isAgentEvent(event)) {
    return AGENT_EVENT_KEYS;
  }
  if (isUsageNearEvent(event)) {
    return USAGE_NEAR_EVENT_KEYS;
  }
  return isUsageResetEvent(event) ? USAGE_RESET_EVENT_KEYS : EVENT_KEYS;
}

/**
 * Keep valid percentages (above 0, up to 100), deduplicated and ascending.
 * @param {string} keyPath
 * @param {unknown} value
 * @param {readonly number[]} fallback
 * @returns {number[]}
 */
function normalizeThresholds(keyPath, value, fallback) {
  if (!Array.isArray(value)) {
    warnReplaced(keyPath, value, fallback);
    return [...fallback];
  }
  /** @type {Set<number>} */
  const out = new Set();
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item) && item > 0 && item <= 100) {
      out.add(item);
    } else {
      log('warn', `config: ignoring ${keyPath} entry ${preview(item)}: must be a number above 0 and up to 100`);
    }
  }
  const sorted = [...out].sort((a, b) => a - b);
  if (sorted.length > MAX_THRESHOLDS) {
    log('warn', `config: ${keyPath} keeps only the first ${MAX_THRESHOLDS} thresholds`);
  }
  return sorted.slice(0, MAX_THRESHOLDS);
}

/**
 * Validate model patterns. User-added families are kept when valid; invalid
 * built-in families revert to their default pattern.
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function normalizeModelPatterns(value) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [family, pattern] of Object.entries(objectOr('modelPatterns', value, DEFAULTS.modelPatterns))) {
    const keyPath = `modelPatterns.${family}`;
    if (isNonEmptyString(pattern)) {
      out[family] = /** @type {string} */ (pattern);
    } else if (Object.hasOwn(DEFAULTS.modelPatterns, family)) {
      warnReplaced(keyPath, pattern, DEFAULTS.modelPatterns[family]);
      out[family] = DEFAULTS.modelPatterns[family];
    } else {
      log('warn', `config: ignoring ${keyPath}: pattern must be a non-empty string`);
    }
  }
  return out;
}

/**
 * Deep-merge plain objects; anything else in `override` replaces `base`.
 * Undefined values are treated as absent.
 * @param {unknown} base
 * @param {unknown} override
 * @returns {unknown}
 */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // Assigning '__proto__' would replace the prototype instead of adding a key.
    if (key === '__proto__' || value === undefined) {
      continue;
    }
    out[key] = Object.hasOwn(out, key) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/**
 * @template T
 * @param {string} keyPath
 * @param {unknown} value
 * @param {T} fallback
 * @param {(value: unknown) => boolean} isValid
 * @returns {T}
 */
function validOr(keyPath, value, fallback, isValid) {
  if (isValid(value)) {
    return /** @type {T} */ (value);
  }
  warnReplaced(keyPath, value, fallback);
  return fallback;
}

/**
 * Accept a finite number, adjusting it into range with `fix` (logged).
 * @template F
 * @param {string} keyPath
 * @param {unknown} value
 * @param {F} fallback
 * @param {(value: number) => number} fix
 * @returns {number | F}
 */
function numberOr(keyPath, value, fallback, fix) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnReplaced(keyPath, value, fallback);
    return fallback;
  }
  const fixed = fix(value);
  if (fixed !== value) {
    log('warn', `config: ${keyPath} adjusted from ${value} to ${fixed}`);
  }
  return fixed;
}

/**
 * @param {string} keyPath
 * @param {unknown} value
 * @param {object} fallback
 * @returns {Record<string, unknown>}
 */
function objectOr(keyPath, value, fallback) {
  return asRecord(validOr(keyPath, value, fallback, isPlainObject));
}

/**
 * Log keys that are not in `known`. Normalization copies known keys only, so
 * these are dropped from the result.
 * @param {string} keyPath '' for the top level.
 * @param {Record<string, unknown>} obj
 * @param {readonly string[]} known
 * @returns {void}
 */
function warnUnknown(keyPath, obj, known) {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      log('warn', `config: ignoring unknown key ${keyPath ? `${keyPath}.` : ''}${key}`);
    }
  }
}

/**
 * @param {string} keyPath
 * @param {unknown} value
 * @param {unknown} fallback
 * @returns {void}
 */
function warnReplaced(keyPath, value, fallback) {
  log('warn', `config: invalid ${keyPath} ${preview(value)}; using default ${preview(fallback)}`);
}

/**
 * Short printable form of a value for log messages.
 * @param {unknown} value
 * @returns {string}
 */
function preview(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    // Circular structures and BigInts cannot be stringified.
  }
  text ??= typeof value;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isBoolean(value) {
  return typeof value === 'boolean';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSoundSpec(value) {
  return parseSoundSpec(value) !== null;
}

/**
 * @param {number} value
 * @returns {number}
 */
function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * @param {number} value
 * @returns {number}
 */
function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

/**
 * @param {number} value
 * @returns {number}
 */
function toCount(value) {
  return Math.max(0, Math.round(value));
}

/**
 * @template {object} T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}
