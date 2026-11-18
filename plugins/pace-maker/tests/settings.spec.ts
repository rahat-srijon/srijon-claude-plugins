import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultSettings, normalizeSettings } from '../hooks/lib/settings.ts';

const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));

test('defaults match the brief', () => {
  assert.deepEqual(defaultSettings(), {
    enabled: true,
    barStyle: 'blocks',
    barWidth: 20,
    showCount: true,
    showPercent: false,
    showLabel: true,
    showElapsed: true,
    showSubagents: true,
    explainStop: false,
  });
});

test('plugin.json userConfig declares the same fields with the same defaults', () => {
  const uc = manifest.userConfig;
  assert.deepEqual(Object.keys(uc).sort(), Object.keys(defaultSettings()).sort());
  for (const [k, v] of Object.entries(defaultSettings())) assert.equal(uc[k].default, v, k);
  assert.deepEqual(uc.barStyle.options, ['blocks', 'thin', 'dots', 'ascii']);
  assert.equal(uc.barWidth.type, 'number');
  assert.equal(uc.barWidth.min, 10);
  assert.equal(uc.barWidth.max, 40);
  assert.ok(String(uc.explainStop.description).startsWith('Uses AI:'));
  for (const f of Object.values<any>(uc)) assert.ok(f.title && f.description, 'every field has a title and a description');
});

test('defaultSettings returns a fresh copy each time', () => {
  const a = defaultSettings();
  a.showElapsed = false;
  assert.equal(defaultSettings().showElapsed, true);
});

test('empty or missing options give the defaults', () => {
  assert.deepEqual(normalizeSettings({}), defaultSettings());
  assert.deepEqual(normalizeSettings(undefined), defaultSettings());
});

test('garbage input gives the defaults and never throws', () => {
  for (const raw of [undefined, null, 0, 'x', true, [], [1, 2], () => 1, NaN, Symbol('s')]) {
    assert.deepEqual(normalizeSettings(raw), defaultSettings());
  }
  const throwing = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.deepEqual(normalizeSettings(throwing), defaultSettings());
});

test('each field falls back on its own', () => {
  const s = normalizeSettings({
    enabled: 'yes', barStyle: 'native', barWidth: 'wide', showCount: 0, showPercent: true, showLabel: null, showElapsed: false,
    showSubagents: [], explainStop: 1,
  });
  assert.deepEqual(s, { ...defaultSettings(), showPercent: true, showElapsed: false });
});

test('valid values are kept', () => {
  const want = {
    enabled: false, barStyle: 'dots', barWidth: 30, showCount: false, showPercent: true, showLabel: false, showElapsed: false,
    showSubagents: false, explainStop: true,
  };
  assert.deepEqual(normalizeSettings(want), want);
  for (const style of ['blocks', 'thin', 'dots', 'ascii']) assert.equal(normalizeSettings({ barStyle: style }).barStyle, style);
});

test('barWidth is rounded and clamped to 10-40; a numeric string counts, junk falls back to 20', () => {
  const w = (v: unknown) => normalizeSettings({ barWidth: v }).barWidth;
  assert.equal(w(25.6), 26);
  assert.equal(w(3), 10);
  assert.equal(w(500), 40);
  assert.equal(w(-5), 10);
  assert.equal(w('15'), 15);
  assert.equal(w(' 25 '), 25);
  for (const bad of ['', 'x', NaN, Infinity, null, undefined, true, {}, []]) assert.equal(w(bad), 20, String(bad));
});

test('removed fields are ignored', () => {
  const s = normalizeSettings({ display: 'text', animation: 'instant', showOnVscodeStatus: false, ai: { explainStop: true }, fields: { elapsed: false } });
  assert.deepEqual(s, defaultSettings());
});
