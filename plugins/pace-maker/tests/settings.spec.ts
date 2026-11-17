import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataDirFor, defaultSettings, normalizeSettings, parseSettingsText } from '../hooks/lib/settings.ts';

test('defaults match the brief', () => {
  assert.deepEqual(defaultSettings(), {
    enabled: true,
    display: 'bar',
    barStyle: 'native',
    barWidth: 20,
    fields: { stepCount: true, percentage: false, stepLabel: true, elapsed: true, subagents: true },
    animation: 'smooth',
    showOnVscodeStatus: true,
    ai: { explainStop: false, askForTaskList: false },
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

test('ai options default to off and fall back field by field', () => {
  assert.deepEqual(normalizeSettings({}).ai, { explainStop: false, askForTaskList: false });
  assert.deepEqual(normalizeSettings({ ai: { explainStop: true, askForTaskList: 'yes' } }).ai, { explainStop: true, askForTaskList: false });
  assert.deepEqual(normalizeSettings({ ai: { askForTaskList: true } }).ai, { explainStop: false, askForTaskList: true });
  for (const ai of ['x', 5, null, [true], undefined]) assert.deepEqual(normalizeSettings({ ai }).ai, defaultSettings().ai);
});

test('dataDirFor prefers the override, then home, then nothing', () => {
  assert.equal(dataDirFor('D:\\tmp\\pm\\', 'C:\\Users\\a'), 'D:\\tmp\\pm');
  assert.equal(dataDirFor(undefined, 'C:\\Users\\a\\'), 'C:\\Users\\a/.claude/plugins/data/pace-maker');
  assert.equal(dataDirFor('', '/home/a'), '/home/a/.claude/plugins/data/pace-maker');
  assert.equal(dataDirFor(undefined, undefined), undefined);
  assert.equal(dataDirFor(undefined, ''), undefined);
});

test('parseSettingsText never throws and falls back to the defaults', () => {
  for (const text of ['', '{', 'null', '[]', 'nope', undefined, null, 5]) assert.deepEqual(parseSettingsText(text), defaultSettings());
  assert.equal(parseSettingsText('{"enabled":false,"ai":{"explainStop":true}}').enabled, false);
  assert.equal(parseSettingsText('{"ai":{"explainStop":true}}').ai.explainStop, true);
});
