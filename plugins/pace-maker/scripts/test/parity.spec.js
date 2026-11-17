// @ts-nocheck
// The mod's normalizeSettings (TypeScript) and the scripts' normalizeConfig (plain JS) are two copies of one contract; this keeps them in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, normalizeSettings } from '../../hooks/lib/settings.ts';
import { defaultConfig, normalizeConfig } from '../lib/config.js';

const samples = [
  undefined, null, 0, 'x', [], {},
  { enabled: false },
  { display: 'text', barStyle: 'ascii', barWidth: 12.6, animation: 'instant', showOnVscodeStatus: false },
  { barStyle: 'sparkle', barWidth: 'wide', enabled: 'no' },
  { barWidth: 5 }, { barWidth: 99 }, { barWidth: NaN }, { barWidth: Infinity },
  { fields: { stepCount: false, percentage: true, stepLabel: null, elapsed: 0, subagents: false } },
  { fields: 'x' }, { fields: [true] },
  { ai: { explainStop: true } }, { ai: { askForTaskList: true, explainStop: 'yes' } }, { ai: 7 },
  { enabled: true, display: 'bar', barStyle: 'dots', barWidth: 25, fields: { stepCount: true, percentage: true, stepLabel: true, elapsed: true, subagents: true }, animation: 'smooth', showOnVscodeStatus: true, ai: { explainStop: true, askForTaskList: true } },
];

test('the defaults are the same in the mod and in the scripts', () => {
  assert.deepEqual(defaultConfig(), defaultSettings());
});

test('both normalizers give the same answer for every sample', () => {
  for (const raw of samples) assert.deepEqual(normalizeConfig(raw), normalizeSettings(raw), JSON.stringify(raw));
});
