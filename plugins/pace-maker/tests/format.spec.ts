import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLYPH_STYLES, defaultSettings, type Settings } from '../hooks/lib/settings.ts';
import { determinateBar, formatElapsed, glyphWidth, formatResetTime, formatView, oneLine, segmentLength, slidingBar } from '../hooks/lib/format.ts';
import type { View } from '../hooks/lib/view.ts';

const S = (over: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), ...over });
const fmt = (v: View, s: Settings = S(), tick = 0, now?: number, width = 20) => {
  const f = formatView(v, s, tick, now, width);
  if (f === null) throw new Error('expected a formatted view');
  return f;
};
const progress = (over: Partial<Extract<View, { kind: 'progress' }>> = {}): View => ({
  kind: 'progress', done: 3, total: 5, fraction: 0.6, label: 'Running tests', elapsedMs: 12 * 60_000, ...over,
});
const working = (over: Partial<Extract<View, { kind: 'working' }>> = {}): View => ({ kind: 'working', elapsedMs: 40_000, subagents: 0, ...over });
/** The cells of a bar in track order: '#' for used, '.' for rest. */
const cells = (b: NonNullable<ReturnType<typeof fmt>['bar']>): string => b.parts.map((p) => (p.used ? '#' : '.').repeat([...p.text].length)).join('');
const draw = (b: NonNullable<ReturnType<typeof fmt>['bar']>): string => `${b.open}${b.parts.map((p) => p.text).join('')}${b.close}`;

test('hidden formats to null', () => {
  assert.equal(formatView({ kind: 'hidden' }, S(), 0), null);
});

test('progress: icon, text, tone, determinate bar and tail (blocks by default)', () => {
  const f = fmt(progress());
  assert.deepEqual([f.kind, f.icon, f.text, f.tone], ['progress', '▶', 'Progress', 'suggestion']);
  assert.equal(f.label, 'Running tests');
  assert.equal(f.tail, '3/5 · 12m');
  assert.deepEqual(f.shape, { tone: 'progress', mode: 'determinate', fraction: 0.6, moving: false });
  assert.equal(f.bar?.mode, 'determinate');
  assert.equal(f.bar?.moving, false);
  assert.equal(f.bar?.used, '█'.repeat(12));
  assert.equal(f.bar?.rest, '░'.repeat(8));
});

test('progress: percent joins the tail in order and each field toggles on its own', () => {
  const all = S({ showPercent: true });
  assert.equal(fmt(progress(), all).tail, '3/5 · 60% · 12m');
  const only = (field: keyof Settings): Partial<Settings> => ({
    showCount: false, showPercent: false, showLabel: false, showElapsed: false, showSubagents: false, [field]: true,
  });
  assert.equal(fmt(progress(), S(only('showCount'))).tail, '3/5');
  assert.equal(fmt(progress(), S(only('showPercent'))).tail, '60%');
  assert.equal(fmt(progress(), S(only('showLabel'))).tail, '');
  assert.equal(fmt(progress(), S(only('showLabel'))).label, 'Running tests');
  assert.equal(fmt(progress(), S(only('showCount'))).label, '');
  assert.equal(fmt(progress(), S(only('showElapsed'))).tail, '12m');
  assert.equal(fmt(progress(), S(only('showSubagents'))).tail, '');
  assert.equal(fmt(progress(), S({ ...only('showCount'), showLabel: true })).tail, '3/5');
});

test('progress: no label and no elapsed leave those parts out with no stray separator', () => {
  const f = fmt({ kind: 'progress', done: 3, total: 5, fraction: 0.6, elapsedMs: 0 }, S({ showPercent: true }));
  assert.equal(f.tail, '3/5 · 60%');
  const none = S({ showCount: false, showPercent: false, showLabel: false, showElapsed: false });
  assert.equal(fmt(progress(), none).tail, '');
  assert.equal(fmt(progress(), none).bar?.mode, 'determinate');
});

test('determinate: filled = round(fraction * width), clamped, and never full before done', () => {
  const used = (fraction: number, width: number): number => [...determinateBar(fraction, 'blocks', width).used].length;
  assert.equal(used(0, 10), 0);
  assert.equal(used(1, 10), 10);
  assert.equal(used(0.5, 10), 5);
  assert.equal(used(0.25, 10), 3); // 2.5 rounds up
  assert.equal(used(0.24, 10), 2);
  assert.equal(used(1 / 3, 20), 7);
  assert.equal(used(0.6, 20), 12);
  assert.equal(used(0.99, 10), 9);
  assert.equal(used(-1, 10), 0);
  assert.equal(used(7, 10), 10);
  assert.equal(used(NaN, 10), 0);
  for (const w of [10, 25, 40]) {
    const b = determinateBar(0.4, 'blocks', w);
    assert.equal([...b.used].length + [...b.rest].length, w);
  }
});

test('every bar style draws used and rest glyphs, ascii wrapped in brackets', () => {
  const glyphs = { blocks: ['█', '░'], thin: ['▬', '─'], dots: ['●', '○'], ascii: ['#', '-'] } as const;
  for (const style of GLYPH_STYLES) {
    const [u, r] = glyphs[style];
    const b = determinateBar(0.5, style, 10);
    assert.equal(b.style, style);
    assert.equal(b.used, u.repeat(5));
    assert.equal(b.rest, r.repeat(5));
    assert.equal(draw(b), `${style === 'ascii' ? '[' : ''}${u.repeat(5)}${r.repeat(5)}${style === 'ascii' ? ']' : ''}`);
    const s = slidingBar(0, style, 10);
    assert.equal(s.style, style);
    assert.equal(s.used, u.repeat(segmentLength(10)));
    assert.equal(s.rest, r.repeat(10 - segmentLength(10)));
  }
  assert.equal(draw(determinateBar(0.5, 'ascii', 10)), '[#####-----]');
  assert.equal(draw(determinateBar(0, 'thin', 10)), '─'.repeat(10));
  assert.equal(draw(determinateBar(1, 'dots', 10)), '●'.repeat(10));
});

test('the glyph bar follows the style setting and the width passed in; smooth falls back to blocks', () => {
  assert.equal(draw(fmt(progress(), S({ barStyle: 'ascii' }), 0, undefined, 10).bar!), '[######----]');
  assert.equal(draw(fmt(progress(), S({ barStyle: 'dots' }), 0, undefined, 40).bar!), `${'●'.repeat(24)}${'○'.repeat(16)}`);
  assert.equal(cells(fmt(progress(), S(), 0, undefined, 10).bar!), '######....');
  assert.equal(fmt(progress(), S({ barStyle: 'smooth' })).bar?.style, 'blocks');
  assert.equal(cells(fmt(working(), S(), 0, undefined, 40).bar!).length, 40);
  // The smooth shape does not depend on the glyph style or width.
  assert.deepEqual(fmt(progress(), S({ barStyle: 'thin' }), 0, undefined, 12).shape, fmt(progress()).shape);
});

test('glyphWidth: the band width less a margin, kept between 10 and 60', () => {
  assert.equal(glyphWidth(80), 60);
  assert.equal(glyphWidth(40), 38);
  assert.equal(glyphWidth(5), 10);
  assert.equal(glyphWidth(NaN), 20);
});

test('sliding: a segment of width/5 (at least 2) moves one cell per tick and wraps', () => {
  assert.equal(segmentLength(10), 2);
  assert.equal(segmentLength(20), 4);
  assert.equal(segmentLength(40), 8);
  assert.equal(segmentLength(14), 3);
  const at = (t: number, w = 10) => cells(slidingBar(t, 'blocks', w));
  assert.equal(at(0), '##........');
  assert.equal(at(1), '.##.......');
  assert.equal(at(7), '.......##.');
  assert.equal(at(8), '........##');
  assert.equal(at(9), '#........#'); // wraps round the end
  assert.equal(at(10), '##........'); // and returns to the start
  assert.equal(at(25), at(5));
  assert.equal(at(-1), at(9));
  // Always the same number of used cells, so it never implies a fraction.
  for (let t = 0; t < 40; t += 1) assert.equal(at(t, 20).split('#').length - 1, 4);
  const wrapped = slidingBar(9, 'blocks', 10);
  assert.deepEqual(wrapped.parts.map((p) => p.used), [true, false, true]);
  assert.equal(wrapped.used, '██');
  assert.equal(wrapped.mode, 'sliding');
  assert.equal(wrapped.moving, true);
});

test('sliding: frozen mode stands still whatever the tick', () => {
  const a = slidingBar(0, 'blocks', 20, true);
  const b = slidingBar(123, 'blocks', 20, true);
  assert.deepEqual(a.parts, b.parts);
  assert.equal(a.mode, 'sliding');
  assert.equal(a.moving, false);
  assert.equal([...a.used].length, 4);
  assert.equal(cells(a), '........####........');
});

test('working: sliding bar, text and tail', () => {
  const f = fmt(working(), S(), 3);
  assert.deepEqual([f.kind, f.icon, f.text, f.tone], ['working', '●', 'Working', 'suggestion']);
  assert.equal(f.bar?.mode, 'sliding');
  assert.equal(f.bar?.moving, true);
  assert.equal(cells(f.bar!), '...####.................'.slice(0, 20));
  assert.equal(f.tail, '40s');
  assert.equal(fmt(working({ detail: 'npm test', subagents: 2 })).tail, '40s · 2 subagents');
  assert.equal(fmt(working({ detail: 'npm test', subagents: 2 })).label, 'npm test in background');
  assert.deepEqual(f.shape, { tone: 'working', mode: 'sliding', fraction: 0, moving: true });
  assert.equal(fmt(working({ subagents: 1 })).tail, '40s · 1 subagent');
  assert.equal(fmt(working({ detail: 'x', subagents: 1 }), S({ showLabel: false, showElapsed: false, showSubagents: false })).tail, '');
  assert.equal(fmt(working({ detail: 'x', subagents: 1 }), S({ showLabel: false })).label, '');
  assert.equal(fmt(working({ elapsedMs: 0 })).tail, '');
  // The tick moves the segment; the text does not change.
  assert.notDeepEqual(fmt(working(), S(), 0).bar?.parts, fmt(working(), S(), 1).bar?.parts);
  assert.equal(fmt(working(), S(), 0).text, fmt(working(), S(), 1).text);
});

test('stopped: determinate bar, text and tail', () => {
  const f = fmt({ kind: 'stopped', done: 3, total: 5, left: 2 }, S({ showPercent: true }));
  assert.deepEqual([f.icon, f.text, f.tone], ['○', 'Stopped · 2 of 5 steps left', 'subtle']);
  assert.equal(f.bar?.mode, 'determinate');
  assert.equal(f.bar?.used, '█'.repeat(12));
  assert.equal(f.tail, '3/5 · 60%');
  assert.equal(fmt({ kind: 'stopped', done: 0, total: 1, left: 1 }).text, 'Stopped · 1 of 1 step left');
  assert.equal(fmt({ kind: 'stopped', done: 3, total: 5, left: 2, reason: 'waiting   on\nthe build' }).text, 'Stopped · 2 of 5 steps left · waiting on the build');
});

test('done: a full bar and the duration', () => {
  const f = fmt({ kind: 'done', done: 5, total: 5, durationMs: 18 * 60_000 });
  assert.deepEqual([f.icon, f.text, f.tone], ['✓', 'Done', 'success']);
  assert.equal(f.bar?.mode, 'determinate');
  assert.equal(f.bar?.used, '█'.repeat(20));
  assert.equal(f.bar?.rest, '');
  assert.equal(f.tail, '5/5 · 18m');
  assert.equal(fmt({ kind: 'done', done: 5, total: 5, durationMs: 0 }).tail, '5/5');
  assert.equal(fmt({ kind: 'done', done: 5, total: 5, durationMs: 9000 }, S({ showCount: false })).tail, '9s');
  assert.deepEqual(f.shape, { tone: 'done', mode: 'determinate', fraction: 1, moving: false });
});

test('done with no list: the time follows the word, no counts, a full bar', () => {
  const f = fmt({ kind: 'done', done: 0, total: 0, durationMs: 40_000 });
  assert.deepEqual([f.icon, f.text, f.tail, f.label, f.tone], ['✓', 'Done · 40s', '', '', 'success']);
  assert.equal(f.shape?.fraction, 1);
  assert.equal(f.bar?.rest, '');
  assert.equal(fmt({ kind: 'done', done: 0, total: 0, durationMs: 40_000 }, S({ showElapsed: false })).text, 'Done');
  assert.equal(fmt({ kind: 'done', done: 0, total: 0, durationMs: 0 }).text, 'Done');
});

const waiting = (why: 'permission' | 'question' | 'usage-limit', detail?: string, over: { done?: number; total?: number; running?: boolean } = {}): View => ({
  kind: 'waiting', why, ...(detail === undefined ? {} : { detail }), done: over.done ?? 1, total: over.total ?? 3, running: over.running ?? false,
});

test('waiting: permission, question and usage limit', () => {
  assert.equal(fmt(waiting('permission', 'Bash')).text, 'Waiting for permission: Bash');
  assert.equal(fmt(waiting('permission')).text, 'Waiting for permission');
  assert.equal(fmt(waiting('permission', 'AskUserQuestion')).text, 'Waiting for your answer');
  assert.equal(fmt(waiting('question')).text, 'Waiting for your answer');
  assert.deepEqual([fmt(waiting('permission', 'Bash')).icon, fmt(waiting('permission', 'Bash')).tone], ['⏸', 'warning']);
  assert.equal(fmt(waiting('usage-limit')).text, 'Waiting · usage limit');
  assert.equal(fmt(waiting('usage-limit', 'not a date')).text, 'Waiting · usage limit');
  const iso = '2026-11-18T14:05:00Z';
  const d = new Date(iso);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(fmt(waiting('usage-limit', iso)).text, `Waiting · usage limit, resets ${hhmm}`);
  // A reset time that is already past is left out.
  assert.equal(fmt(waiting('usage-limit', iso), S(), 0, Date.parse(iso) + 1).text, 'Waiting · usage limit');
});

test('waiting: a list gives a determinate bar; with no list a frozen slide, running or idle', () => {
  const withList = fmt(waiting('permission', 'Bash', { running: true }));
  assert.equal(withList.bar?.mode, 'determinate');
  assert.equal(withList.bar?.used, '█'.repeat(7));
  assert.equal(withList.tail, '1/3');
  const frozen = fmt(waiting('permission', 'Bash', { done: 0, total: 0, running: true }), S(), 17);
  assert.equal(frozen.bar?.mode, 'sliding');
  assert.equal(frozen.bar?.moving, false);
  assert.deepEqual(frozen.bar?.parts, fmt(waiting('permission', 'Bash', { done: 0, total: 0, running: true }), S(), 0).bar?.parts);
  assert.deepEqual(frozen.shape, { tone: 'waiting', mode: 'sliding', fraction: 0, moving: false });
  assert.equal(withList.shape?.tone, 'waiting');
  assert.equal(withList.shape?.fraction, 1 / 3);
  assert.equal(frozen.tail, '');
  const idle = fmt(waiting('usage-limit', undefined, { done: 0, total: 0, running: false }));
  assert.deepEqual(idle.shape, { tone: 'waiting', mode: 'sliding', fraction: 0, moving: false });
  assert.equal(idle.bar?.moving, false);
  assert.equal(fmt(waiting('question', undefined, { done: 1, total: 3, running: false })).bar?.mode, 'determinate');
});

const blocked = (why: 'error' | 'denied' | 'dependency', detail?: string, over: { done?: number; total?: number; running?: boolean; count?: number } = {}): View => ({
  kind: 'blocked', why, ...(detail === undefined ? {} : { detail }), ...(over.count === undefined ? {} : { count: over.count }),
  done: over.done ?? 1, total: over.total ?? 3, running: over.running ?? false,
});

test('blocked: error, denied and dependency', () => {
  const e = fmt(blocked('error', 'API error 529'));
  assert.deepEqual([e.icon, e.text, e.tone], ['✖', 'Blocked · API error 529', 'error']);
  assert.equal(fmt(blocked('error')).text, 'Blocked · error');
  assert.equal(fmt(blocked('denied', 'Write')).text, 'Blocked · permission denied: Write');
  assert.equal(fmt(blocked('denied')).text, 'Blocked · permission denied');
  assert.equal(fmt(blocked('dependency', 'second', { count: 1 })).text, 'Blocked · 1 task waits on unmet dependencies');
  assert.equal(fmt(blocked('dependency', 'second', { count: 3 })).text, 'Blocked · 3 tasks wait on unmet dependencies');
  assert.equal(fmt(blocked('error', 'a\n  b')).text, 'Blocked · a b');
  assert.equal(fmt(blocked('error')).bar?.mode, 'determinate');
  assert.equal(fmt(blocked('error', 'x', { done: 0, total: 0 })).shape?.moving, false);
  assert.equal(fmt(blocked('error', 'x', { done: 0, total: 0 })).shape?.mode, 'sliding');
  assert.equal(fmt(blocked('denied', 'Bash', { done: 0, total: 0, running: true })).bar?.moving, false);
});

const paused = (why: 'interrupt' | 'plan' | 'command', detail?: string, over: { done?: number; total?: number; running?: boolean } = {}): View => ({
  kind: 'paused', why, ...(detail === undefined ? {} : { detail }), done: over.done ?? 3, total: over.total ?? 5, running: over.running ?? false,
});

test('paused: interrupt, plan and command', () => {
  const i = fmt(paused('interrupt'));
  assert.deepEqual([i.icon, i.text, i.tone, i.tail], ['⏸', 'Paused by you', 'planMode', '3/5']);
  assert.equal(fmt(paused('interrupt', undefined, { done: 0, total: 0 })).text, 'Paused by you');
  assert.equal(fmt(paused('plan')).text, 'Plan ready for approval');
  assert.equal(fmt(paused('command', 'lunch')).text, 'Paused · lunch');
  assert.equal(fmt(paused('command')).text, 'Paused');
  assert.equal(fmt(paused('command', 'lunch')).bar?.used, '█'.repeat(12));
  assert.equal(fmt(paused('command', 'lunch', { done: 0, total: 0 })).shape?.moving, false);
  const mid = fmt(paused('command', 'lunch', { done: 0, total: 0, running: true }), S(), 9);
  assert.equal(mid.bar?.mode, 'sliding');
  assert.equal(mid.bar?.moving, false);
  assert.equal(mid.tail, '');
});

test('the tail drops separators cleanly in every state', () => {
  const off = S({ showCount: false, showPercent: false, showLabel: false, showElapsed: false, showSubagents: false });
  const views: View[] = [progress(), working({ detail: 'x', subagents: 2 }), { kind: 'done', done: 1, total: 1, durationMs: 5000 },
    waiting('permission', 'Bash'), blocked('error', 'x'), paused('command', 'x'), { kind: 'stopped', done: 1, total: 3, left: 2 }];
  for (const v of views) {
    const f = fmt(v, off);
    assert.equal(f.tail, '', v.kind);
    assert.equal(f.label, '', v.kind);
    const on = fmt(v, S({ showPercent: true }));
    assert.doesNotMatch(on.tail, /^ ·|· $|· ·|^ | $/, v.kind);
  }
  // A single survivor has no separator at all.
  assert.equal(fmt(progress(), S({ ...off, showElapsed: true })).tail, '12m');
});

test('tones are theme tokens only', () => {
  const tokens = new Set(['success', 'warning', 'error', 'suggestion', 'subtle', 'planMode', 'claude', 'permission', 'ide']);
  const views: View[] = [progress(), working(), { kind: 'done', done: 1, total: 1, durationMs: 0 }, waiting('permission'),
    blocked('error'), paused('plan'), { kind: 'stopped', done: 1, total: 3, left: 2 }];
  const tones = views.map((v) => fmt(v).tone);
  for (const t of tones) assert.ok(tokens.has(t), t);
  assert.deepEqual(tones, ['suggestion', 'suggestion', 'success', 'warning', 'error', 'planMode', 'subtle']);
});

test('every state text is a single line', () => {
  const views: View[] = [
    progress({ label: 'two\nlines   here' }), working({ detail: 'a\nb' }), waiting('permission', 'a\nb'), blocked('error', 'a\n\nb'),
    blocked('denied', 'a\nb'), paused('command', 'a\nb'), { kind: 'stopped', done: 1, total: 3, left: 2, reason: 'a\nb' },
  ];
  for (const v of views) {
    const f = fmt(v);
    assert.doesNotMatch(`${f.text}${f.label}${f.tail}`, /[\r\n\t]/, v.kind);
  }
  assert.equal(fmt(progress({ label: 'x'.repeat(200) })).label.length < 120, true);
});

test('one-line helper and elapsed time formatting', () => {
  assert.equal(oneLine('  a   b\n c '), 'a b c');
  assert.equal(oneLine('abcdef', 4), 'abc…');
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(45_000), '45s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(60_000), '1m');
  assert.equal(formatElapsed(12 * 60_000 + 59_000), '12m');
  assert.equal(formatElapsed(59 * 60_000 + 59_000), '59m');
  assert.equal(formatElapsed(3_600_000), '1h 00m');
  assert.equal(formatElapsed(3_600_000 + 5 * 60_000), '1h 05m');
  assert.equal(formatElapsed(26 * 3_600_000 + 30 * 60_000), '26h 30m');
  assert.equal(formatElapsed(-5), '0s');
  assert.equal(formatElapsed(NaN), '0s');
  assert.equal(formatElapsed(Infinity), '0s');
});

test('reset time formatting', () => {
  assert.equal(formatResetTime(undefined), undefined);
  assert.equal(formatResetTime('soon'), undefined);
  assert.match(String(formatResetTime('2026-11-18T09:03:00Z')), /^\d\d:\d\d$/);
});
