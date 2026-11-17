import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyModel, applyToolEvent, type Model, type ToolEvent } from '../hooks/lib/progress.ts';
import { emptyState, applyEvent, type SessionState, type StateEvent } from '../hooks/lib/state.ts';
import { emptyBackground, applyBackgroundEvent, type Background, type BackgroundEvent } from '../hooks/lib/background.ts';
import { deriveState, type View } from '../hooks/lib/view.ts';

const plan = (...st: string[]): ToolEvent => ({
  tool: 'mcp__ccd_turn__update_plan',
  input: { items: st.map((status, i) => ({ content: `step ${i + 1}`, status })) },
});
const list = (...st: string[]): Model => applyToolEvent(emptyModel(), plan(...st));
const st = (...events: StateEvent[]): SessionState => events.reduce((s, e) => applyEvent(s, e, 1000), emptyState());
const bgOf = (...events: BackgroundEvent[]): Background => events.reduce(applyBackgroundEvent, emptyBackground());
const shell = (label = 'npm test'): BackgroundEvent => ({ kind: 'started', id: 's1', itemKind: 'shell', label });
const agent = (id: string): BackgroundEvent => ({ kind: 'started', id, itemKind: 'agent', label: `agent ${id}` });
const view = (m: Model, s: SessionState, b: Background = emptyBackground(), now = 5000): View => deriveState(m, s, b, now);
const end = (answer = 'ok', isAborted = false): StateEvent => ({ kind: 'turnComplete', isAborted, answer });
const open = list('completed', 'in_progress', 'pending');
const finished = list('completed', 'completed');

test('hidden: no list, nothing running, no stop reason', () => {
  assert.deepEqual(view(emptyModel(), emptyState()), { kind: 'hidden' });
  assert.deepEqual(view(emptyModel(), st({ kind: 'turnStart' }, end('hi'))), { kind: 'hidden' });
});

test('progress: a list and a running turn', () => {
  const v = view(open, st({ kind: 'turnStart' }), emptyBackground(), 4000);
  assert.deepEqual(v, { kind: 'progress', done: 1, total: 3, fraction: 1 / 3, label: 'step 2', elapsedMs: 3000 });
});

test('working: running without a list; detail from background, subagents counted', () => {
  assert.deepEqual(view(emptyModel(), st({ kind: 'turnStart' })), { kind: 'working', elapsedMs: 4000, subagents: 0 });
  const v = view(emptyModel(), st({ kind: 'turnStart' }), bgOf(shell('npm test'), agent('a'), agent('b')));
  assert.deepEqual(v, { kind: 'working', detail: 'agent b', elapsedMs: 4000, subagents: 2 });
});

test('working: background-only work after the turn ended, with no list', () => {
  const v = view(emptyModel(), st({ kind: 'turnStart' }, end()), bgOf(shell('npm test')));
  assert.deepEqual(v, { kind: 'working', detail: 'npm test', elapsedMs: 4000, subagents: 0 });
});

test('stopped: stale list, normal end, no question, no reason', () => {
  const v = view(open, st({ kind: 'turnStart' }, end('Finished the first part.')));
  assert.deepEqual(v, { kind: 'stopped', done: 1, total: 3, left: 2 });
  assert.equal('reason' in v, false);
});

test('stopped: the stored stop reason becomes the view reason, and only on a stopped view', () => {
  const stopped = [{ kind: 'turnStart' }, end('Finished the first part.'), { kind: 'stopReason', text: 'waiting on the build' }] as StateEvent[];
  assert.deepEqual(view(open, st(...stopped)), { kind: 'stopped', done: 1, total: 3, left: 2, reason: 'waiting on the build' });
  // a colored state keeps its own reason; the stored text is not used there
  assert.equal(view(open, st(...stopped, { kind: 'permissionPrompt', tool: 'Bash' })).kind, 'waiting');
  assert.equal(view(finished, st(...stopped)).kind, 'done');
  // a new turn drops it
  assert.equal(view(open, st(...stopped, { kind: 'turnStart' })).kind, 'progress');
});

test('done: all completed, with the turn duration', () => {
  const s = applyEvent(applyEvent(emptyState(), { kind: 'turnStart' }, 1000), end('all done'), 4000);
  assert.deepEqual(view(finished, s), { kind: 'done', done: 2, total: 2, durationMs: 3000 });
  assert.deepEqual(view(finished, emptyState()), { kind: 'done', done: 2, total: 2, durationMs: 0 });
});

test('waiting: permission, question and usage limit', () => {
  assert.deepEqual(view(open, st({ kind: 'permissionPrompt', tool: 'Bash' })), {
    kind: 'waiting', why: 'permission', detail: 'Bash', done: 1, total: 3,
  });
  assert.deepEqual(view(open, st({ kind: 'turnStart' }, end('Which file should I edit?'))), {
    kind: 'waiting', why: 'question', done: 1, total: 3,
  });
  assert.deepEqual(view(open, st({ kind: 'usageLimit', resetsAt: '5pm' })), {
    kind: 'waiting', why: 'usage-limit', detail: '5pm', done: 1, total: 3,
  });
});

test('blocked: error, denied and dependency', () => {
  assert.deepEqual(view(open, st({ kind: 'turnStart' }, { kind: 'stopFailure', message: 'API error 529' })), {
    kind: 'blocked', why: 'error', detail: 'API error 529', done: 1, total: 3,
  });
  assert.deepEqual(view(open, st({ kind: 'permissionDenied', tool: 'Write' })), {
    kind: 'blocked', why: 'denied', detail: 'Write', done: 1, total: 3,
  });
  const dep = [
    { tool: 'TaskCreate', input: { subject: 'first' }, result: { task: { id: '1' } } },
    { tool: 'TaskCreate', input: { subject: 'second' }, result: { task: { id: '2' } } },
    { tool: 'TaskUpdate', input: { taskId: '2', addBlockedBy: ['1'] } },
  ].reduce(applyToolEvent, emptyModel());
  assert.deepEqual(view(dep, st({ kind: 'turnStart' }, end('stopped'))), {
    kind: 'blocked', why: 'dependency', count: 1, detail: 'second', done: 0, total: 2,
  });
});

test('paused: command, plan and interrupt', () => {
  assert.deepEqual(view(open, st({ kind: 'pause', reason: 'lunch' })), {
    kind: 'paused', why: 'command', detail: 'lunch', done: 1, total: 3,
  });
  assert.deepEqual(view(open, st({ kind: 'planWaiting' })), { kind: 'paused', why: 'plan', done: 1, total: 3 });
  assert.deepEqual(view(open, st({ kind: 'turnStart' }, end('stopped', true))), {
    kind: 'paused', why: 'interrupt', done: 1, total: 3,
  });
});

test('every one of the 8 view kinds is reachable', () => {
  const kinds = new Set<string>([
    view(emptyModel(), emptyState()).kind,
    view(open, st({ kind: 'turnStart' })).kind,
    view(emptyModel(), st({ kind: 'turnStart' })).kind,
    view(open, st({ kind: 'turnStart' }, end())).kind,
    view(finished, emptyState()).kind,
    view(open, st({ kind: 'permissionPrompt', tool: 'x' })).kind,
    view(open, st({ kind: 'permissionDenied', tool: 'x' })).kind,
    view(open, st({ kind: 'planWaiting' })).kind,
  ]);
  assert.deepEqual([...kinds].sort(), ['blocked', 'done', 'hidden', 'paused', 'progress', 'stopped', 'waiting', 'working']);
});

// Precedence: each assertion sets two tiers at once and checks the higher one wins.
test('precedence 1 over 2: disabled beats permission', () => {
  assert.equal(view(open, st({ kind: 'setDisabled', value: true }, { kind: 'permissionPrompt', tool: 'x' })).kind, 'hidden');
});

test('precedence 2 over 3: permission beats the pause command', () => {
  const v = view(open, st({ kind: 'pause', reason: 'p' }, { kind: 'permissionPrompt', tool: 'x' }));
  assert.equal(v.kind === 'waiting' && v.why, 'permission');
});

test('precedence 2 mid-turn: permission beats running', () => {
  const v = view(open, st({ kind: 'turnStart' }, { kind: 'permissionPrompt', tool: 'Bash' }));
  assert.equal(v.kind === 'waiting' && v.why, 'permission');
});

test('precedence 3 over 4: pause command beats running', () => {
  const v = view(open, st({ kind: 'turnStart' }, { kind: 'pause', reason: 'p' }));
  assert.equal(v.kind === 'paused' && v.why, 'command');
});

test('precedence 4 over 5: running beats every stop reason', () => {
  const s: SessionState = { ...st({ kind: 'turnStart' }), error: { message: 'e' }, planWaiting: true };
  assert.equal(view(open, s).kind, 'progress');
});

test('precedence 5: error beats denied', () => {
  const s = st({ kind: 'permissionDenied', tool: 'x' }, { kind: 'stopFailure', message: 'e' });
  const v = view(open, s);
  assert.equal(v.kind === 'blocked' && v.why, 'error');
});

test('precedence 5: denied beats dependency', () => {
  const dep = [
    { tool: 'TaskCreate', input: { subject: 'a' }, result: { task: { id: '1' } } },
    { tool: 'TaskCreate', input: { subject: 'b' }, result: { task: { id: '2' } } },
    { tool: 'TaskUpdate', input: { taskId: '2', addBlockedBy: ['1'] } },
  ].reduce(applyToolEvent, emptyModel());
  const v = view(dep, st({ kind: 'permissionDenied', tool: 'x' }));
  assert.equal(v.kind === 'blocked' && v.why, 'denied');
});

test('precedence 5: dependency beats usage limit', () => {
  const dep = [
    { tool: 'TaskCreate', input: { subject: 'a' }, result: { task: { id: '1' } } },
    { tool: 'TaskCreate', input: { subject: 'b' }, result: { task: { id: '2' } } },
    { tool: 'TaskUpdate', input: { taskId: '2', addBlockedBy: ['1'] } },
  ].reduce(applyToolEvent, emptyModel());
  const v = view(dep, st({ kind: 'usageLimit' }));
  assert.equal(v.kind === 'blocked' && v.why, 'dependency');
});

test('precedence 5: usage limit beats plan waiting', () => {
  const v = view(open, st({ kind: 'planWaiting' }, { kind: 'usageLimit' }));
  assert.equal(v.kind === 'waiting' && v.why, 'usage-limit');
});

test('precedence 5: plan waiting beats interrupt', () => {
  const v = view(open, st({ kind: 'planWaiting' }, end('Q?', true)));
  assert.equal(v.kind === 'paused' && v.why, 'plan');
});

test('precedence 5: interrupt beats question', () => {
  const v = view(open, st(end('Which one?', true)));
  assert.equal(v.kind === 'paused' && v.why, 'interrupt');
});

test('precedence 5 over 6: question beats background work', () => {
  const v = view(open, st(end('Which one?')), bgOf(shell()));
  assert.equal(v.kind === 'waiting' && v.why, 'question');
});

test('precedence 6 over 7: background work beats done', () => {
  assert.equal(view(finished, st({ kind: 'turnStart' }, end()), bgOf(shell())).kind, 'working');
});

test('precedence 7 over 8 and 9: done, then stopped, then hidden', () => {
  assert.equal(view(finished, st({ kind: 'turnStart' }, end())).kind, 'done');
  assert.equal(view(open, st({ kind: 'turnStart' }, end())).kind, 'stopped');
  assert.equal(view(emptyModel(), st({ kind: 'turnStart' }, end())).kind, 'hidden');
});

test('a question with no tasks left is not waiting', () => {
  assert.equal(view(finished, st({ kind: 'turnStart' }, end('Anything else?'))).kind, 'done');
});

test('an error with no list is still blocked', () => {
  const v = view(emptyModel(), st({ kind: 'turnStart' }, { kind: 'stopFailure', message: 'boom' }));
  assert.deepEqual(v, { kind: 'blocked', why: 'error', detail: 'boom', done: 0, total: 0 });
});

test('reset: resetRun then a new list shows progress, not done', () => {
  const doneState = st({ kind: 'turnStart' }, end('done'));
  assert.equal(view(finished, doneState).kind, 'done');
  const next = applyEvent(applyEvent(doneState, { kind: 'resetRun' }), { kind: 'turnStart' }, 9000);
  const v = view(list('in_progress', 'pending'), next, emptyBackground(), 10000);
  assert.deepEqual(v, { kind: 'progress', done: 0, total: 2, fraction: 0, label: 'step 1', elapsedMs: 1000 });
});

test('resume after compaction: JSON round trip gives the same view', () => {
  const cases: [Model, SessionState, Background][] = [
    [open, st({ kind: 'turnStart' }), bgOf(agent('a'))],
    [open, st({ kind: 'permissionPrompt', tool: 'Bash' }), bgOf(shell())],
    [open, st({ kind: 'turnStart' }, end('Which one?')), emptyBackground()],
    [finished, st({ kind: 'turnStart' }, end()), emptyBackground()],
  ];
  const rt = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  for (const [m, s, b] of cases) {
    assert.deepEqual(deriveState(rt(m), rt(s), rt(b), 7000), deriveState(m, s, b, 7000));
  }
});

test('elapsedMs is 0 when there is no start time', () => {
  const v = view(open, { ...emptyState(), running: true });
  assert.equal(v.kind === 'progress' && v.elapsedMs, 0);
});
