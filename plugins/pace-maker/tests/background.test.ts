import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBackground,
  applyBackgroundEvent,
  backgroundSummary,
  type Background,
  type BackgroundEvent,
} from '../hooks/lib/background.ts';

const start = (id: string, itemKind: 'shell' | 'agent' | 'monitor', label: string): BackgroundEvent => ({
  kind: 'started',
  id,
  itemKind,
  label,
});
const run = (events: BackgroundEvent[], from: Background = emptyBackground()): Background =>
  events.reduce(applyBackgroundEvent, from);

test('emptyBackground has no items', () => {
  assert.deepEqual(emptyBackground(), { shape: 'bg-1', items: [] });
  assert.deepEqual(backgroundSummary(emptyBackground()), { shells: 0, agents: 0, monitors: 0, total: 0 });
});

test('started adds items and the summary counts per kind', () => {
  const bg = run([start('1', 'shell', 'npm test'), start('2', 'agent', 'review'), start('3', 'shell', 'build'), start('4', 'monitor', 'logs')]);
  assert.deepEqual(backgroundSummary(bg), { shells: 2, agents: 1, monitors: 1, total: 4, label: 'logs' });
});

test('label is the newest item and falls back when it ends', () => {
  const bg = run([start('1', 'shell', 'old'), start('2', 'shell', 'new')]);
  assert.equal(backgroundSummary(bg).label, 'new');
  assert.equal(backgroundSummary(run([{ kind: 'ended', id: '2' }], bg)).label, 'old');
});

test('duplicate started is ignored', () => {
  const bg = run([start('1', 'shell', 'a'), start('1', 'agent', 'b')]);
  assert.equal(bg.items.length, 1);
  assert.deepEqual(bg.items[0], { id: '1', kind: 'shell', label: 'a' });
});

test('ended removes the item; an unknown id is ignored', () => {
  const bg = run([start('1', 'shell', 'a'), start('2', 'agent', 'b')]);
  assert.deepEqual(run([{ kind: 'ended', id: '1' }], bg).items.map((i) => i.id), ['2']);
  assert.deepEqual(run([{ kind: 'ended', id: 'nope' }], bg), bg);
  assert.deepEqual(run([{ kind: 'ended', id: 'x' }]), emptyBackground());
});

test('sessionEnded clears everything', () => {
  const bg = run([start('1', 'shell', 'a'), start('2', 'agent', 'b'), { kind: 'sessionEnded' }]);
  assert.deepEqual(bg, emptyBackground());
});

test('unknown events never throw and change nothing', () => {
  const bg = run([start('1', 'shell', 'a')]);
  assert.doesNotThrow(() => applyBackgroundEvent(bg, { kind: 'bogus' } as unknown as BackgroundEvent));
  assert.deepEqual(applyBackgroundEvent(bg, { kind: 'bogus' } as unknown as BackgroundEvent), bg);
});

test('does not mutate its input and survives JSON', () => {
  const bg = Object.freeze({ shape: 'bg-1' as const, items: Object.freeze([]) as never });
  assert.doesNotThrow(() => applyBackgroundEvent(bg, start('1', 'shell', 'a')));
  const next = run([start('1', 'shell', 'a')]);
  assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
});
