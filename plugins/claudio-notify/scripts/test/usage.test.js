// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Guard directory so that even import-time logging can never reach the real ~/.claude.
const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-usage-'));
process.env.CLAUDIO_DATA_DIR = guardDir;

const { loadConfig } = await import('../lib/config.js');
const {
  STALE_RESET_SECONDS,
  nextReset,
  observe,
  parseRateLimits,
  readUsageState,
  step,
  usageStateFile,
} = await import('../lib/usage.js');
const { onStatusLine } = await import('../usage.js');

/** @typedef {import('../lib/usage.js').UsageState} UsageState */
/** @typedef {import('../lib/usage.js').Observations} Observations */

const NOW = 1_800_000_000;
const HOUR = 3600;

/** @type {string} */
let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-usage-'));
  process.env.CLAUDIO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env.CLAUDIO_DATA_DIR = guardDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

process.on('exit', () => {
  fs.rmSync(guardDir, { recursive: true, force: true });
});

/**
 * Config with the default thresholds (80, 95) and reset minimum (80), plus overrides.
 * @param {Record<string, unknown>} [events]
 */
function config(events = {}) {
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ events }));
  return loadConfig({ dataDir });
}

/**
 * Feed observations through `step` one after another.
 * @param {Array<{ observed: Observations, now: number }>} runs
 * @param {ReturnType<typeof config>} cfg
 * @returns {{ state: UsageState, events: string[][] }}
 */
function replay(runs, cfg) {
  /** @type {UsageState} */
  let state = {};
  const events = [];
  for (const { observed, now } of runs) {
    const result = step(state, observed, cfg, now);
    state = result.state;
    events.push(result.events);
  }
  return { state, events };
}

/**
 * @param {number} percent
 * @param {number} [resetsAt]
 */
function fiveHour(percent, resetsAt = NOW + 2 * HOUR) {
  return { five_hour: { percent, resetsAt } };
}

describe('parseRateLimits', () => {
  it('reads both windows', () => {
    const input = {
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: NOW },
        seven_day: { used_percentage: 41.2, resets_at: NOW + 1 },
      },
    };
    assert.deepEqual(parseRateLimits(input), {
      five_hour: { percent: 23.5, resetsAt: NOW },
      seven_day: { percent: 41.2, resetsAt: NOW + 1 },
    });
  });

  it('leaves out missing and malformed windows', () => {
    assert.deepEqual(parseRateLimits({}), {});
    assert.deepEqual(parseRateLimits(null), {});
    assert.deepEqual(parseRateLimits({ rate_limits: { five_hour: { used_percentage: '50', resets_at: NOW } } }), {});
    assert.deepEqual(parseRateLimits({ rate_limits: { seven_day: { used_percentage: 5 } } }), {});
  });

  it('ignores the spend limit window', () => {
    const input = { rate_limits: { spend_limit: { used_percentage: 90, resets_at: NOW } } };
    assert.deepEqual(parseRateLimits(input), {});
  });

  it('clamps the percentage to 0..100', () => {
    const input = { rate_limits: { five_hour: { used_percentage: 130, resets_at: NOW } } };
    assert.equal(parseRateLimits(input).five_hour?.percent, 100);
  });
});

describe('step: thresholds', () => {
  it('plays nothing below the first threshold', () => {
    const { events } = replay([{ observed: fiveHour(50), now: NOW }], config());
    assert.deepEqual(events, [[]]);
  });

  it('plays each threshold once per window', () => {
    const { events, state } = replay([
      { observed: fiveHour(79), now: NOW },
      { observed: fiveHour(81), now: NOW + 60 },
      { observed: fiveHour(85), now: NOW + 120 },
      { observed: fiveHour(96), now: NOW + 180 },
      { observed: fiveHour(97), now: NOW + 240 },
    ], config());
    assert.deepEqual(events, [[], ['usage_5h_near'], [], ['usage_5h_near'], []]);
    assert.deepEqual(state.five_hour?.fired, [80, 95]);
  });

  it('plays once when several thresholds are crossed at once', () => {
    const { events, state } = replay([{ observed: fiveHour(99), now: NOW }], config());
    assert.deepEqual(events, [['usage_5h_near']]);
    assert.deepEqual(state.five_hour?.fired, [80, 95]);
  });

  it('uses the configured thresholds and the weekly event for the weekly window', () => {
    const cfg = config({ usage_week_near: { thresholds: [50] } });
    const observed = { seven_day: { percent: 60, resetsAt: NOW + 3 * 24 * HOUR } };
    assert.deepEqual(step({}, observed, cfg, NOW).events, ['usage_week_near']);
  });

  it('plays nothing with an empty threshold list', () => {
    const cfg = config({ usage_5h_near: { thresholds: [] } });
    assert.deepEqual(step({}, fiveHour(100), cfg, NOW).events, []);
  });

  it('ignores an observation whose reset time has already passed', () => {
    const { events, state } = replay([{ observed: fiveHour(90, NOW - 1), now: NOW }], config());
    assert.deepEqual(events, [[]]);
    assert.deepEqual(state, {});
  });

  it('follows a moving reset time within the same window', () => {
    const { events, state } = replay([
      { observed: fiveHour(85, NOW + HOUR), now: NOW },
      { observed: fiveHour(86, NOW + HOUR + 1), now: NOW + 60 },
    ], config());
    assert.deepEqual(events, [['usage_5h_near'], []]);
    assert.equal(state.five_hour?.resetsAt, NOW + HOUR + 1);
  });
});

describe('step: resets', () => {
  it('plays the reset once when the stored reset time passes', () => {
    const resetsAt = NOW + HOUR;
    const { events, state } = replay([
      { observed: fiveHour(90, resetsAt), now: NOW },
      { observed: {}, now: resetsAt },
      { observed: {}, now: resetsAt + 10 },
    ], config());
    assert.deepEqual(events, [['usage_5h_near'], ['usage_5h_reset'], []]);
    assert.equal(state.five_hour?.reset, true);
  });

  it('plays the reset when usage drops before the reset time', () => {
    const { events } = replay([
      { observed: fiveHour(90), now: NOW },
      { observed: fiveHour(2), now: NOW + 60 },
      { observed: fiveHour(3), now: NOW + 120 },
    ], config());
    assert.deepEqual(events, [['usage_5h_near'], ['usage_5h_reset'], []]);
  });

  it('starts a new window after a reset, so thresholds play again', () => {
    const resetsAt = NOW + HOUR;
    const { events } = replay([
      { observed: fiveHour(85, resetsAt), now: NOW },
      { observed: fiveHour(1, resetsAt + 5 * HOUR), now: resetsAt + 1 },
      { observed: fiveHour(82, resetsAt + 5 * HOUR), now: resetsAt + HOUR },
    ], config());
    assert.deepEqual(events, [['usage_5h_near'], ['usage_5h_reset'], ['usage_5h_near']]);
  });

  it('stays silent when the ended window stayed below minPercent', () => {
    const resetsAt = NOW + HOUR;
    const { events, state } = replay([
      { observed: fiveHour(50, resetsAt), now: NOW },
      { observed: {}, now: resetsAt + 1 },
    ], config());
    assert.deepEqual(events, [[], []]);
    assert.equal(state.five_hour?.reset, true);
  });

  it('plays every reset with minPercent 0', () => {
    const resetsAt = NOW + HOUR;
    const cfg = config({ usage_5h_reset: { minPercent: 0 } });
    const { events } = replay([
      { observed: fiveHour(0, resetsAt), now: NOW },
      { observed: {}, now: resetsAt + 1 },
    ], cfg);
    assert.deepEqual(events, [[], ['usage_5h_reset']]);
  });

  it('stays silent for a reset noticed too late', () => {
    const resetsAt = NOW + HOUR;
    const { events, state } = replay([
      { observed: fiveHour(90, resetsAt), now: NOW },
      { observed: {}, now: resetsAt + STALE_RESET_SECONDS + 1 },
    ], config());
    assert.deepEqual(events, [['usage_5h_near'], []]);
    assert.equal(state.five_hour?.reset, true);
  });

  it('ignores a drop of less than one point', () => {
    const { events } = replay([
      { observed: fiveHour(90), now: NOW },
      { observed: fiveHour(89.5), now: NOW + 60 },
    ], config());
    assert.deepEqual(events, [['usage_5h_near'], []]);
  });

  it('handles the two windows independently', () => {
    const cfg = config();
    const week = NOW + 3 * 24 * HOUR;
    const first = step({}, {
      five_hour: { percent: 81, resetsAt: NOW + HOUR },
      seven_day: { percent: 96, resetsAt: week },
    }, cfg, NOW);
    assert.deepEqual(first.events, ['usage_5h_near', 'usage_week_near']);
    const second = step(first.state, { seven_day: { percent: 96, resetsAt: week } }, cfg, NOW + HOUR);
    assert.deepEqual(second.events, ['usage_5h_reset']);
  });

  it('does not change the previous state', () => {
    /** @type {UsageState} */
    const previous = { five_hour: { resetsAt: NOW + HOUR, maxPercent: 81, fired: [80], reset: false } };
    const frozen = structuredClone(previous);
    step(previous, fiveHour(96, NOW + HOUR), config(), NOW);
    assert.deepEqual(previous, frozen);
  });
});

describe('nextReset', () => {
  it('is the earliest reset that would play', () => {
    const cfg = config();
    /** @type {UsageState} */
    const state = {
      five_hour: { resetsAt: NOW + HOUR, maxPercent: 85, fired: [80], reset: false },
      seven_day: { resetsAt: NOW + 2 * HOUR, maxPercent: 90, fired: [80], reset: false },
    };
    assert.equal(nextReset(state, cfg), NOW + HOUR);
  });

  it('skips windows below minPercent and windows already reset', () => {
    const cfg = config();
    /** @type {UsageState} */
    const state = {
      five_hour: { resetsAt: NOW + HOUR, maxPercent: 50, fired: [], reset: false },
      seven_day: { resetsAt: NOW + 2 * HOUR, maxPercent: 90, fired: [80], reset: true },
    };
    assert.equal(nextReset(state, cfg), null);
  });
});

describe('observe', () => {
  it('persists the state so a crossing plays once across processes', () => {
    const cfg = config();
    assert.deepEqual(observe(dataDir, fiveHour(85), cfg, NOW)?.events, ['usage_5h_near']);
    assert.deepEqual(observe(dataDir, fiveHour(85), cfg, NOW + 1)?.events, []);
    assert.deepEqual(readUsageState(dataDir).five_hour?.fired, [80]);
  });

  it('starts over from a corrupt state file', () => {
    fs.mkdirSync(path.dirname(usageStateFile(dataDir)), { recursive: true });
    fs.writeFileSync(usageStateFile(dataDir), '{not json');
    assert.deepEqual(observe(dataDir, fiveHour(85), config(), NOW)?.events, ['usage_5h_near']);
  });

  it('drops malformed windows from the state file', () => {
    fs.mkdirSync(path.dirname(usageStateFile(dataDir)), { recursive: true });
    fs.writeFileSync(usageStateFile(dataDir), JSON.stringify({ five_hour: { resetsAt: 'soon' } }));
    assert.deepEqual(readUsageState(dataDir), {});
  });

  it('skips the update while another process holds the lock', () => {
    const lock = `${usageStateFile(dataDir)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    assert.equal(observe(dataDir, fiveHour(85), config(), NOW), null);
    assert.ok(!fs.existsSync(usageStateFile(dataDir)));
  });
});

describe('onStatusLine', () => {
  /**
   * @param {number} percent
   */
  function input(percent) {
    const resetsAt = Math.floor(Date.now() / 1000) + HOUR;
    return JSON.stringify({
      workspace: { project_dir: dataDir },
      rate_limits: { five_hour: { used_percentage: percent, resets_at: resetsAt } },
    });
  }

  /** @returns {{ calls: string[][], spawnDetached: (script: string, args: string[]) => void }} */
  function recorder() {
    /** @type {string[][]} */
    const calls = [];
    return { calls, spawnDetached: (script, args) => { calls.push(args); } };
  }

  it('starts one player for a crossing and none for a repeat', async () => {
    config();
    const fake = recorder();
    assert.deepEqual(await onStatusLine(input(85), { dataDir, pluginRoot: dataDir, ...fake }), ['usage_5h_near']);
    assert.deepEqual(await onStatusLine(input(86), { dataDir, pluginRoot: dataDir, ...fake }), []);
    assert.deepEqual(fake.calls, [['play', 'usage_5h_near', '--project-dir', dataDir]]);
  });

  it('records the crossing but starts no player when muted or the event is off', async () => {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ muted: true }));
    const fake = recorder();
    assert.deepEqual(await onStatusLine(input(85), { dataDir, pluginRoot: dataDir, ...fake }), []);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(readUsageState(dataDir).five_hour?.fired, [80]);
  });

  it('starts the reset timer when it is on and a reset is pending', async () => {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ usageResetTimer: true }));
    const fake = recorder();
    await onStatusLine(input(85), { dataDir, pluginRoot: dataDir, ...fake });
    assert.deepEqual(fake.calls.map((args) => args[0]), ['play', 'timer']);
  });

  it('ignores input that is not JSON', async () => {
    const fake = recorder();
    assert.deepEqual(await onStatusLine('not json', { dataDir, pluginRoot: dataDir, ...fake }), []);
    assert.deepEqual(fake.calls, []);
  });
});
