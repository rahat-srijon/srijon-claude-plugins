// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath, dataDir, defaultConfig, loadConfig, normalizeConfig, saveConfig, validateConfig } from '../lib/config.js';

/** @returns {string} A fresh temp directory. */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pace-config-'));

test('defaults match the mod and the brief', () => {
  assert.deepEqual(defaultConfig(), {
    enabled: true,
    display: 'bar',
    barStyle: 'native',
    barWidth: 20,
    fields: { stepCount: true, percentage: false, stepLabel: true, elapsed: true, subagents: true },
    animation: 'smooth',
    showOnVscodeStatus: true,
    ai: { explainStop: false, askForTaskList: false },
  });
  const a = defaultConfig();
  a.ai.explainStop = true;
  assert.equal(defaultConfig().ai.explainStop, false);
});

test('normalizeConfig never throws and falls back field by field', () => {
  for (const raw of [undefined, null, 0, 'x', true, [], () => 1, NaN]) {
    assert.deepEqual(normalizeConfig(raw), defaultConfig());
  }
  assert.deepEqual(normalizeConfig(new Proxy({}, { get() { throw new Error('boom'); } })), defaultConfig());
  const c = normalizeConfig({
    enabled: 'yes', display: 'text', barStyle: 'sparkle', barWidth: 'wide', animation: 'instant',
    fields: { stepCount: false, percentage: 1 }, ai: { explainStop: true, askForTaskList: 'on' }, extra: 1,
  });
  assert.equal(c.enabled, true);
  assert.equal(c.display, 'text');
  assert.equal(c.barStyle, 'native');
  assert.equal(c.barWidth, 20);
  assert.equal(c.animation, 'instant');
  assert.deepEqual(c.fields, { stepCount: false, percentage: false, stepLabel: true, elapsed: true, subagents: true });
  assert.deepEqual(c.ai, { explainStop: true, askForTaskList: false });
  assert.equal(normalizeConfig({ barWidth: 5 }).barWidth, 10);
  assert.equal(normalizeConfig({ barWidth: 99 }).barWidth, 40);
  assert.equal(normalizeConfig({ barWidth: 12.6 }).barWidth, 13);
});

test('validateConfig accepts a full valid object and rejects everything else', () => {
  const ok = validateConfig(defaultConfig());
  assert.equal(ok.ok, true);

  /** @param {(c: any) => void} mutate */
  const bad = (mutate) => {
    const c = /** @type {any} */ (defaultConfig());
    mutate(c);
    const r = validateConfig(c);
    assert.equal(r.ok, false, JSON.stringify(c));
    return r.ok ? [] : r.errors;
  };
  for (const raw of [null, 5, 'x', [], undefined]) assert.equal(validateConfig(raw).ok, false);
  assert.equal(validateConfig({}).ok, false);
  bad((c) => { c.enabled = 'true'; });
  bad((c) => { c.display = 'both'; });
  bad((c) => { c.barStyle = 'sparkle'; });
  bad((c) => { c.barWidth = 9; });
  bad((c) => { c.barWidth = 41; });
  bad((c) => { c.barWidth = 20.5; });
  bad((c) => { c.barWidth = '20'; });
  bad((c) => { c.animation = 'fast'; });
  bad((c) => { c.showOnVscodeStatus = 1; });
  bad((c) => { c.fields = null; });
  bad((c) => { delete c.fields.elapsed; });
  bad((c) => { c.fields.extra = true; });
  bad((c) => { c.ai = []; });
  bad((c) => { c.ai.explainStop = 'yes'; });
  bad((c) => { delete c.ai.askForTaskList; });
  assert.match(bad((c) => { c.nope = 1; }).join(), /unknown key "nope"/);
  assert.match(bad((c) => { c.ai.other = true; }).join(), /unknown key "ai.other"/);
});

test('data dir: PACE_MAKER_DATA_DIR wins, else the plugin data folder under the home .claude', () => {
  const dir = tmp();
  assert.equal(dataDir({ PACE_MAKER_DATA_DIR: dir }), path.resolve(dir));
  assert.equal(configPath(dir), path.join(dir, 'config.json'));
  assert.equal(dataDir({}), path.join(os.homedir(), '.claude', 'plugins', 'data', 'pace-maker'));
  assert.equal(dataDir({ PACE_MAKER_DATA_DIR: '' }), path.join(os.homedir(), '.claude', 'plugins', 'data', 'pace-maker'));
  const saved = process.env.PACE_MAKER_DATA_DIR;
  process.env.PACE_MAKER_DATA_DIR = dir;
  try {
    assert.equal(dataDir(), path.resolve(dir));
    assert.equal(configPath(), path.join(path.resolve(dir), 'config.json'));
  } finally {
    if (saved === undefined) delete process.env.PACE_MAKER_DATA_DIR;
    else process.env.PACE_MAKER_DATA_DIR = saved;
  }
});

test('loadConfig: missing, empty and garbled files give the defaults', () => {
  const dir = tmp();
  assert.deepEqual(loadConfig(dir), defaultConfig());
  for (const text of ['', '{', 'null', '[1]', 'not json']) {
    fs.writeFileSync(configPath(dir), text);
    assert.deepEqual(loadConfig(dir), defaultConfig());
  }
  fs.writeFileSync(configPath(dir), '{"enabled":false,"ai":{"explainStop":true}}');
  const c = loadConfig(dir);
  assert.equal(c.enabled, false);
  assert.equal(c.ai.explainStop, true);
  assert.equal(c.display, 'bar');
});

test('saveConfig writes atomically: creates the directory, leaves no temp file, replaces the old one', () => {
  const root = tmp();
  const dir = path.join(root, 'nested', 'pace');
  const first = { ...defaultConfig(), barStyle: /** @type {const} */ ('dots'), barWidth: 30 };
  saveConfig(first, dir);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath(dir), 'utf8')), first);
  assert.deepEqual(loadConfig(dir), first);

  const second = { ...first, enabled: false };
  saveConfig(second, dir);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  assert.equal(loadConfig(dir).enabled, false);
});

test('saveConfig normalizes what it is given and a failed write keeps the old file', () => {
  const dir = tmp();
  saveConfig(/** @type {any} */ ({ barWidth: 999, display: 'text' }), dir);
  const stored = JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
  assert.equal(stored.barWidth, 40);
  assert.equal(stored.display, 'text');
  assert.deepEqual(stored.ai, { explainStop: false, askForTaskList: false });

  // The target is a directory: the rename fails, the temp file is removed.
  const blocked = tmp();
  fs.mkdirSync(configPath(blocked));
  assert.throws(() => saveConfig(defaultConfig(), blocked));
  assert.deepEqual(fs.readdirSync(blocked), ['config.json']);
});
