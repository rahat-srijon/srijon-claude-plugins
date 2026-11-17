import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, type Settings } from '../hooks/lib/settings.ts';
import { easeValue, formatElapsed, formatResetTime, formatView, glyphBar, oneLine } from '../hooks/lib/format.ts';
import type { View } from '../hooks/lib/view.ts';

const S = (over: Partial<Settings> & { fields?: Partial<Settings['fields']> } = {}): Settings => {
  const d = defaultSettings();
  return { ...d, ...over, fields: { ...d.fields, ...over.fields } };
};
const fmt = (v: View, s: Settings = S(), now?: number) => {
  const f = formatView(v, s, now);
  assert.ok(f, 'expected a formatted view');
  return f;
};
const progress = (over: Partial<Extract<View, { kind: 'progress' }>> = {}): View => ({
  kind: 'progress', done: 3, total: 5, fraction: 0.6, label: 'Running tests', elapsedMs: 12 * 60_000, ...over,
});

test('hidden formats to null', () => {
  assert.equal(formatView({ kind: 'hidden' }, S()), null);
});

test('progress: text, color and native bar data', () => {
  const f = fmt(progress());
  assert.equal(f.text, '3/5 · Running tests · 12m');
  assert.equal(f.color, undefined);
  assert.equal(f.kind, 'progress');
  assert.deepEqual(f.bar, { value: 3, max: 5, valueText: '3/5', label: 'Running tests' });
  assert.equal(f.glyphBar, undefined);
});

test('progress: each field toggles on its own', () => {
  const only = (field: string) => ({
    stepCount: false, percentage: false, stepLabel: false, elapsed: false, subagents: false, [field]: true,
  });
  assert.equal(fmt(progress(), S({ fields: only('stepCount') })).text, '3/5');
  assert.equal(fmt(progress(), S({ fields: only('percentage') })).text, '60%');
  assert.equal(fmt(progress(), S({ fields: only('stepLabel') })).text, 'Running tests');
  assert.equal(fmt(progress(), S({ fields: only('elapsed') })).text, '12m');
  assert.equal(fmt(progress(), S({ fields: { percentage: true } })).text, '3/5 · 60% · Running tests · 12m');
  assert.equal(fmt(progress(), S({ fields: only('none') })).text, '');
});

test('progress: no label and no elapsed leave those parts out', () => {
  const v = progress({ elapsedMs: 0 });
  delete (v as { label?: string }).label;
  assert.equal(fmt(v).text, '3/5');
  assert.equal(fmt(v).bar?.label, 'Progress');
});

test('progress: native bar value text follows the toggles', () => {
  assert.equal(fmt(progress(), S({ fields: { percentage: true } })).bar?.valueText, '3/5 · 60%');
  assert.equal(fmt(progress(), S({ fields: { stepCount: false } })).bar?.valueText, undefined);
  assert.equal(fmt(progress(), S({ fields: { stepLabel: false } })).bar?.label, 'Progress');
});

test('progress: every glyph bar style has exactly barWidth cells', () => {
  const v = progress({ fraction: 0.5, done: 5, total: 10 });
  const cases: [Settings['barStyle'], string][] = [
    ['blocks', '█'.repeat(10) + '░'.repeat(10)],
    ['thin', '━'.repeat(10) + '─'.repeat(10)],
    ['dots', '●'.repeat(10) + '○'.repeat(10)],
    ['ascii', `[${'#'.repeat(9)}${'-'.repeat(9)}]`],
  ];
  for (const [barStyle, want] of cases) {
    const f = fmt(v, S({ barStyle, barWidth: 20 }));
    assert.equal(f.glyphBar, want, barStyle);
    assert.equal([...(f.glyphBar ?? '')].length, 20, barStyle);
    assert.equal(f.bar, undefined);
  }
});

test('progress: glyph bars honor barWidth and the 0 and full ends', () => {
  assert.equal(glyphBar(0, 'blocks', 10), '░'.repeat(10));
  assert.equal(glyphBar(1, 'blocks', 10), '█'.repeat(10));
  assert.equal(glyphBar(0.99, 'blocks', 10), '█'.repeat(9) + '░');
  assert.equal(glyphBar(0, 'ascii', 10), '[--------]');
  assert.equal(glyphBar(1, 'ascii', 10), '[########]');
  assert.equal([...glyphBar(0.3, 'dots', 40)].length, 40);
  assert.equal(glyphBar(5, 'thin', 10), '━'.repeat(10));
  assert.equal(glyphBar(-1, 'thin', 10), '─'.repeat(10));
  assert.equal(glyphBar(NaN, 'thin', 10), '─'.repeat(10));
});

test('progress: text-only display has no bar and carries an icon', () => {
  const f = fmt(progress(), S({ display: 'text' }));
  assert.equal(f.bar, undefined);
  assert.equal(f.glyphBar, undefined);
  assert.equal(f.icon, '▶');
  assert.equal(f.text, '▶ 3/5 · Running tests · 12m');
  assert.equal(fmt(progress(), S({ display: 'text', barStyle: 'blocks' })).glyphBar, undefined);
});

test('progress: a smoothed fraction moves the bar, not the text', () => {
  const f = formatView(progress(), S(), 0, 0.3);
  assert.equal(f?.bar?.value, 1.5);
  assert.equal(f?.text, '3/5 · Running tests · 12m');
  assert.equal(formatView(progress(), S({ barStyle: 'blocks', barWidth: 10 }), 0, 0.3)?.glyphBar, '███░░░░░░░');
});

test('progress: zero total keeps a valid bar', () => {
  const f = fmt(progress({ done: 0, total: 0, fraction: 0 }));
  assert.equal(f.bar?.max, 1);
  assert.equal(f.bar?.value, 0);
});

test('working', () => {
  const v: View = { kind: 'working', detail: 'npm test', elapsedMs: 4 * 60_000, subagents: 0 };
  const f = fmt(v);
  assert.equal(f.text, '● Working · npm test in background · 4m');
  assert.equal(f.color, 'subtle');
  assert.equal(f.bar, undefined);
  assert.equal(fmt({ ...v, subagents: 2 }).text, '● Working · npm test in background · 4m · 2 subagents');
  assert.equal(fmt({ ...v, subagents: 1 }).text, '● Working · npm test in background · 4m · 1 subagent');
  assert.equal(fmt({ ...v, subagents: 2 }, S({ fields: { subagents: false } })).text, '● Working · npm test in background · 4m');
  assert.equal(fmt({ ...v, subagents: 2 }, S({ fields: { elapsed: false } })).text, '● Working · npm test in background · 2 subagents');
  assert.equal(fmt({ kind: 'working', elapsedMs: 0, subagents: 0 }).text, '● Working');
});

test('stopped', () => {
  const v: View = { kind: 'stopped', done: 3, total: 5, left: 2 };
  assert.equal(fmt(v).text, '○ Stopped · 2 of 5 steps left');
  assert.equal(fmt(v).color, 'subtle');
  assert.equal(fmt({ ...v, reason: 'tests failed' }).text, '○ Stopped · 2 of 5 steps left · tests failed');
  assert.equal(fmt({ kind: 'stopped', done: 0, total: 1, left: 1 }).text, '○ Stopped · 1 of 1 step left');
});

test('done', () => {
  const v: View = { kind: 'done', done: 5, total: 5, durationMs: 18 * 60_000 };
  const f = fmt(v);
  assert.equal(f.text, '✓ Done · 5/5 · 18m');
  assert.equal(f.color, 'success');
  assert.equal(fmt(v, S({ fields: { elapsed: false } })).text, '✓ Done · 5/5');
  assert.equal(fmt(v, S({ fields: { stepCount: false } })).text, '✓ Done · 18m');
  assert.equal(fmt({ ...v, durationMs: 0 }).text, '✓ Done · 5/5');
});

test('waiting: permission, question and usage limit', () => {
  const w = (why: 'permission' | 'question' | 'usage-limit', detail?: string): View =>
    detail === undefined ? { kind: 'waiting', why, done: 1, total: 3 } : { kind: 'waiting', why, detail, done: 1, total: 3 };
  assert.equal(fmt(w('permission', 'Bash')).text, '⏸ Waiting for permission: Bash');
  assert.equal(fmt(w('permission')).text, '⏸ Waiting for permission');
  assert.equal(fmt(w('permission', 'AskUserQuestion')).text, '⏸ Waiting for your answer');
  assert.equal(fmt(w('question')).text, '⏸ Waiting for your answer');
  assert.equal(fmt(w('permission', 'Bash')).color, 'warning');
  assert.equal(fmt(w('usage-limit')).text, '⏸ Waiting · usage limit');
  assert.equal(fmt(w('usage-limit', 'not a date')).text, '⏸ Waiting · usage limit');
  const iso = '2026-11-18T14:05:00Z';
  const d = new Date(iso);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(fmt(w('usage-limit', iso)).text, `⏸ Waiting · usage limit, resets ${hhmm}`);
  assert.equal(fmt(w('usage-limit', iso)).color, 'warning');
  // A reset time that is already past is left out.
  assert.equal(fmt(w('usage-limit', iso), S(), Date.parse(iso) + 1).text, '⏸ Waiting · usage limit');
});

test('blocked: error, denied and dependency', () => {
  const b = (why: 'error' | 'denied' | 'dependency', extra: object = {}): View =>
    ({ kind: 'blocked', why, done: 1, total: 3, ...extra }) as View;
  assert.equal(fmt(b('error', { detail: 'API error 529' })).text, '⛔ Blocked · API error 529');
  assert.equal(fmt(b('error')).text, '⛔ Blocked · error');
  assert.equal(fmt(b('denied', { detail: 'Bash' })).text, '⛔ Blocked · permission denied: Bash');
  assert.equal(fmt(b('denied')).text, '⛔ Blocked · permission denied');
  assert.equal(fmt(b('dependency', { count: 2, detail: 'x' })).text, '⛔ Blocked · 2 tasks wait on unmet dependencies');
  assert.equal(fmt(b('dependency', { count: 1 })).text, '⛔ Blocked · 1 task waits on unmet dependencies');
  assert.equal(fmt(b('error', { detail: 'x' })).color, 'error');
});

test('paused: interrupt, plan and command', () => {
  const p = (why: 'interrupt' | 'plan' | 'command', extra: object = {}, done = 3, total = 5): View =>
    ({ kind: 'paused', why, done, total, ...extra }) as View;
  assert.equal(fmt(p('interrupt')).text, '⏸ Paused by you · 3/5');
  assert.equal(fmt(p('interrupt', {}, 0, 0)).text, '⏸ Paused by you');
  assert.equal(fmt(p('plan')).text, '⏸ Plan ready for approval');
  assert.equal(fmt(p('command', { detail: 'lunch' })).text, '⏸ Paused · lunch · 3/5');
  assert.equal(fmt(p('command', { detail: 'lunch' }, 0, 0)).text, '⏸ Paused · lunch');
  assert.equal(fmt(p('command')).text, '⏸ Paused · 3/5');
  for (const why of ['interrupt', 'plan', 'command'] as const) assert.equal(fmt(p(why)).color, 'suggestion');
});

test('colors are theme tokens only', () => {
  const tokens = new Set(['subtle', 'success', 'warning', 'error', 'suggestion']);
  const views: View[] = [
    { kind: 'working', elapsedMs: 0, subagents: 0 },
    { kind: 'stopped', done: 1, total: 2, left: 1 },
    { kind: 'done', done: 1, total: 1, durationMs: 0 },
    { kind: 'waiting', why: 'question', done: 0, total: 1 },
    { kind: 'blocked', why: 'error', done: 0, total: 1 },
    { kind: 'paused', why: 'plan', done: 0, total: 1 },
  ];
  for (const v of views) assert.ok(tokens.has(String(fmt(v).color)), v.kind);
});

test('one state at a time: every text is a single line', () => {
  const nasty = 'line one\nline two\t\ttabbed   and a very long tail '.repeat(10);
  const views: View[] = [
    progress({ label: nasty }),
    { kind: 'working', detail: nasty, elapsedMs: 5000, subagents: 1 },
    { kind: 'stopped', done: 1, total: 2, left: 1, reason: nasty },
    { kind: 'waiting', why: 'permission', detail: nasty, done: 0, total: 1 },
    { kind: 'blocked', why: 'error', detail: nasty, done: 0, total: 1 },
    { kind: 'paused', why: 'command', detail: nasty, done: 0, total: 1 },
  ];
  for (const v of views) {
    const t = fmt(v).text;
    assert.ok(!/[\n\r\t]/.test(t), v.kind);
    assert.ok(t.length < 200, `${v.kind} is ${t.length} long`);
  }
  assert.equal(oneLine('a\n b\t c'), 'a b c');
  assert.equal(oneLine('x'.repeat(100), 10), `${'x'.repeat(9)}…`);
});

test('elapsed time formatting', () => {
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

test('easing moves from start to end and never overshoots', () => {
  assert.equal(easeValue(0.2, 0.6, 0), 0.2);
  assert.equal(easeValue(0.2, 0.6, 300), 0.6);
  assert.equal(easeValue(0.2, 0.6, 1000), 0.6);
  let last = 0.2;
  for (let t = 0; t <= 300; t += 25) {
    const v = easeValue(0.2, 0.6, t);
    assert.ok(v >= last && v <= 0.6);
    last = v;
  }
  assert.equal(easeValue(0.6, 0.2, 150) < 0.6, true);
  assert.equal(easeValue(0, 1, 50, 0), 1);
});
