// @ts-check
import path from 'node:path';
import { log } from './log.js';
import { readJsonObject, withMutex, writeJsonAtomic } from './state.js';

/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./config.js').EventName} EventName */
/** @typedef {import('./config.js').UsageNearEventName} UsageNearEventName */
/** @typedef {import('./config.js').UsageResetEventName} UsageResetEventName */

/** @typedef {'five_hour' | 'seven_day'} WindowName */

/**
 * One rate-limit window as the status line reports it.
 * @typedef {object} Observation
 * @property {number} percent `used_percentage`, 0..100.
 * @property {number} resetsAt `resets_at`, Unix seconds.
 */

/** @typedef {Partial<Record<WindowName, Observation>>} Observations */

/**
 * What is remembered about one window between status line runs.
 * @typedef {object} WindowState
 * @property {number} resetsAt Latest `resets_at` seen for the window, Unix seconds.
 * @property {number} maxPercent Highest usage seen in the window.
 * @property {number[]} fired Thresholds that have already sounded in the window.
 * @property {boolean} reset Whether the window's reset has been handled.
 */

/** @typedef {Partial<Record<WindowName, WindowState>>} UsageState */

/**
 * @typedef {object} StepResult
 * @property {UsageState} state
 * @property {EventName[]} events Events to play, in order.
 */

/**
 * Events per window.
 * @type {Readonly<Record<WindowName, { near: UsageNearEventName, reset: UsageResetEventName }>>}
 */
export const WINDOWS = Object.freeze({
  five_hour: Object.freeze({ near: 'usage_5h_near', reset: 'usage_5h_reset' }),
  seven_day: Object.freeze({ near: 'usage_week_near', reset: 'usage_week_reset' }),
});

const WINDOW_NAMES = /** @type {readonly WindowName[]} */ (Object.freeze(Object.keys(WINDOWS)));

/** A drop of at least this many points within a window means it was reset early. */
const DROP_POINTS = 1;
/** A reset noticed this long after `resets_at` is too stale to announce. */
export const STALE_RESET_SECONDS = 15 * 60;

/**
 * Pick the windows out of status line input. Missing or malformed windows are
 * left out.
 * @param {unknown} input Parsed status line JSON.
 * @returns {Observations}
 */
export function parseRateLimits(input) {
  /** @type {Observations} */
  const out = {};
  const limits = field(input, 'rate_limits');
  for (const name of WINDOW_NAMES) {
    const window = field(limits, name);
    const percent = field(window, 'used_percentage');
    const resetsAt = field(window, 'resets_at');
    if (isFiniteNumber(percent) && isFiniteNumber(resetsAt)) {
      out[name] = { percent: Math.min(100, Math.max(0, percent)), resetsAt };
    }
  }
  return out;
}

/**
 * Advance the remembered state by one observation and work out which events
 * are due. Pure: the caller persists the state and plays the events.
 *
 * A window resets when its stored `resets_at` has passed or its usage drops.
 * The reset sounds only if the ended window reached the reset event's
 * `minPercent` and the reset is not stale. Each threshold sounds once per
 * window; crossing several at once sounds once.
 * @param {UsageState} previous
 * @param {Observations} observed
 * @param {Config} config
 * @param {number} now Unix seconds.
 * @returns {StepResult}
 */
export function step(previous, observed, config, now) {
  /** @type {UsageState} */
  const state = {};
  /** @type {EventName[]} */
  const events = [];
  for (const name of WINDOW_NAMES) {
    const { near, reset } = WINDOWS[name];
    let window = previous[name] ? { ...previous[name], fired: [...previous[name].fired] } : undefined;
    const seen = observed[name] && observed[name].resetsAt > now ? observed[name] : undefined;

    if (window && !window.reset) {
      const expired = window.resetsAt <= now;
      const dropped = seen !== undefined && seen.percent <= window.maxPercent - DROP_POINTS;
      if (expired || dropped) {
        const fresh = !expired || now - window.resetsAt <= STALE_RESET_SECONDS;
        if (fresh && window.maxPercent >= (config.events[reset].minPercent ?? 0)) {
          events.push(reset);
        }
        window.reset = true;
      }
    }

    if (seen) {
      if (!window || window.reset) {
        window = { resetsAt: seen.resetsAt, maxPercent: seen.percent, fired: [], reset: false };
      } else {
        window.resetsAt = seen.resetsAt;
        window.maxPercent = Math.max(window.maxPercent, seen.percent);
      }
      const crossed = (config.events[near].thresholds ?? [])
        .filter((threshold) => seen.percent >= threshold && !window?.fired.includes(threshold));
      if (crossed.length > 0) {
        events.push(near);
        window.fired = [...window.fired, ...crossed].sort((a, b) => a - b);
      }
    }

    if (window) {
      state[name] = window;
    }
  }
  return { state, events };
}

/**
 * When the next announced reset is due: the earliest `resets_at` of a window
 * whose reset would sound.
 * @param {UsageState} state
 * @param {Config} config
 * @returns {number | null} Unix seconds, or null when no reset is pending.
 */
export function nextReset(state, config) {
  let next = null;
  for (const name of WINDOW_NAMES) {
    const window = state[name];
    const minPercent = config.events[WINDOWS[name].reset].minPercent ?? 0;
    if (window && !window.reset && window.maxPercent >= minPercent) {
      next = next === null ? window.resetsAt : Math.min(next, window.resetsAt);
    }
  }
  return next;
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function usageStateFile(dataDir) {
  return path.join(dataDir, 'usage', 'state.json');
}

/**
 * Read the remembered state. Malformed windows are dropped.
 * @param {string} dataDir
 * @returns {UsageState}
 */
export function readUsageState(dataDir) {
  const raw = readJsonObject(usageStateFile(dataDir)) ?? {};
  /** @type {UsageState} */
  const state = {};
  for (const name of WINDOW_NAMES) {
    const window = raw[name];
    const resetsAt = field(window, 'resetsAt');
    const maxPercent = field(window, 'maxPercent');
    const fired = field(window, 'fired');
    if (isFiniteNumber(resetsAt) && isFiniteNumber(maxPercent) && Array.isArray(fired)) {
      state[name] = {
        resetsAt,
        maxPercent,
        fired: fired.filter(isFiniteNumber),
        reset: field(window, 'reset') === true,
      };
    }
  }
  return state;
}

/**
 * Apply one observation to the stored state under a mutex, so concurrent
 * sessions and the reset timer announce each crossing once.
 * @param {string} dataDir
 * @param {Observations} observed
 * @param {Config} config
 * @param {number} [now] Unix seconds.
 * @returns {StepResult | null} Null when the state stayed locked.
 */
export function observe(dataDir, observed, config, now = Date.now() / 1000) {
  const file = usageStateFile(dataDir);
  const result = withMutex(`${file}.lock`, () => {
    const previous = readUsageState(dataDir);
    const next = step(previous, observed, config, now);
    if (JSON.stringify(next.state) !== JSON.stringify(previous)) {
      writeJsonAtomic(file, next.state);
    }
    return next;
  });
  if (!result.ok) {
    log('debug', 'usage: state is locked; skipping this update');
    return null;
  }
  return result.value;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key)
    ? /** @type {Record<string, unknown>} */ (value)[key]
    : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
