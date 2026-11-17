import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, normalizeSettings } from '../hooks/lib/settings.ts';

test('defaults match the brief', () => {
  assert.deepEqual(defaultSettings(), {
    enabled: true,
    display: 'bar',
    barStyle: 'native',
    barWidth: 20,
    fields: { stepCount: true, percentage: false, stepLabel: true, elapsed: true, subagents: true },
    animation: 'smooth',
    showOnVscodeStatus: true,
  });
});

test('defaultSettings returns a fresh copy each time', () => {
  const a = defaultSettings();
  a.fields.elapsed = false;
  assert.equal(defaultSettings().fields.elapsed, true);
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
    enabled: 'yes',
    display: 'text',
    barStyle: 'sparkle',
    barWidth: 'wide',
    fields: { stepCount: false, percentage: 1, stepLabel: null, elapsed: false, subagents: undefined },
    animation: 'instant',
    showOnVscodeStatus: false,
  });
  assert.equal(s.enabled, true);
  assert.equal(s.display, 'text');
  assert.equal(s.barStyle, 'native');
  assert.equal(s.barWidth, 20);
  assert.deepEqual(s.fields, { stepCount: false, percentage: false, stepLabel: true, elapsed: false, subagents: true });
  assert.equal(s.animation, 'instant');
  assert.equal(s.showOnVscodeStatus, false);
});

test('fields that is not an object is ignored', () => {
  for (const fields of ['x', 5, null, [true], undefined]) {
    assert.deepEqual(normalizeSettings({ fields }).fields, defaultSettings().fields);
  }
});

test('every bar style, display and animation value is accepted', () => {
  for (const barStyle of ['native', 'blocks', 'thin', 'dots', 'ascii']) assert.equal(normalizeSettings({ barStyle }).barStyle, barStyle);
  for (const display of ['bar', 'text']) assert.equal(normalizeSettings({ display }).display, display);
  for (const animation of ['smooth', 'instant']) assert.equal(normalizeSettings({ animation }).animation, animation);
});

test('barWidth is rounded and clamped to 10..40; non-finite falls back', () => {
  assert.equal(normalizeSettings({ barWidth: 5 }).barWidth, 10);
  assert.equal(normalizeSettings({ barWidth: 99 }).barWidth, 40);
  assert.equal(normalizeSettings({ barWidth: 12.6 }).barWidth, 13);
  assert.equal(normalizeSettings({ barWidth: 10 }).barWidth, 10);
  assert.equal(normalizeSettings({ barWidth: 40 }).barWidth, 40);
  assert.equal(normalizeSettings({ barWidth: Infinity }).barWidth, 20);
  assert.equal(normalizeSettings({ barWidth: NaN }).barWidth, 20);
  assert.equal(normalizeSettings({ barWidth: '30' }).barWidth, 20);
});

test('the result survives a JSON round trip', () => {
  const s = normalizeSettings({ barStyle: 'dots', barWidth: 25 });
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(s))), s);
});
