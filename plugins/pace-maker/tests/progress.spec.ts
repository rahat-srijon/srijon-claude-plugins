import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyModel,
  applyToolEvent,
  applyTaskList,
  counts,
  fraction,
  activeLabel,
  isComplete,
  hasList,
  blocked,
  type Model,
  type ToolEvent,
} from '../hooks/lib/progress.ts';

const ev = (tool: string, input: Record<string, unknown>, extra: Partial<ToolEvent> = {}): ToolEvent => ({ tool, input, ...extra });
const run = (events: ToolEvent[], from: Model = emptyModel()): Model => events.reduce(applyToolEvent, from);
const create = (id: string, subject: string, extra: Record<string, unknown> = {}): ToolEvent =>
  ev('TaskCreate', { subject, ...extra }, { result: { task: { id, subject } } });
const update = (taskId: string, extra: Record<string, unknown>): ToolEvent => ev('TaskUpdate', { taskId, ...extra });
const plan = (input: Record<string, unknown>, text?: string): ToolEvent => ev('mcp__ccd_turn__update_plan', input, text ? { text } : {});
const statuses = (m: Model): string[] => m.tasks.map((t) => t.status);
const planOf = (...st: string[]): Model =>
  run([plan({ items: st.map((status, i) => ({ content: `s${i + 1}`, status })) })]);

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

test('emptyModel has no list', () => {
  const m = emptyModel();
  assert.deepEqual(m, { shape: 'progress-1', tasks: [], source: null, held: [] });
  assert.equal(hasList(m), false);
  assert.equal(fraction(m), 0);
  assert.equal(isComplete(m), false);
  assert.equal(activeLabel(m), undefined);
});

test('TaskCreate appends pending tasks with activeForm', () => {
  const m = run([create('1', 'Write code', { activeForm: 'Writing code' }), create('2', 'Test')]);
  assert.equal(m.source, 'task');
  assert.deepEqual(m.tasks[0], { id: '1', subject: 'Write code', activeForm: 'Writing code', status: 'pending', blockedBy: [] });
  assert.deepEqual(statuses(m), ['pending', 'pending']);
});

test('TaskCreate without an id in the result is ignored', () => {
  const m0 = emptyModel();
  assert.equal(applyToolEvent(m0, ev('TaskCreate', { subject: 'x' })), m0);
  assert.equal(applyToolEvent(m0, ev('TaskCreate', { subject: 'x' }, { result: { task: {} } })), m0);
});

test('TaskUpdate changes status, subject, activeForm and blockers', () => {
  const m = run([
    create('1', 'A'),
    create('2', 'B'),
    update('2', { status: 'in_progress', subject: 'B2', activeForm: 'Doing B2', addBlockedBy: ['1'] }),
  ]);
  assert.deepEqual(m.tasks[1], { id: '2', subject: 'B2', activeForm: 'Doing B2', status: 'in_progress', blockedBy: ['1'] });
  assert.equal(m.tasks[0]?.status, 'pending');
});

test('in_progress on one task leaves the others alone', () => {
  const m = run([create('1', 'A'), create('2', 'B'), update('1', { status: 'in_progress' }), update('2', { status: 'in_progress' })]);
  assert.deepEqual(statuses(m), ['in_progress', 'in_progress']);
});

test('TaskUpdate deleted keeps the task but drops it from counts', () => {
  const m = run([create('1', 'A'), create('2', 'B'), update('1', { status: 'completed' }), update('2', { status: 'deleted' })]);
  assert.equal(m.tasks.length, 2);
  assert.deepEqual(counts(m), { done: 1, total: 1 });
  assert.equal(isComplete(m), true);
});

test('TaskUpdate before TaskCreate is held, then applied on create', () => {
  const m1 = run([update('7', { status: 'in_progress', addBlockedBy: ['3'] })]);
  assert.equal(m1.tasks.length, 0);
  assert.equal(m1.held.length, 1);
  const m2 = applyToolEvent(m1, create('7', 'Late'));
  assert.deepEqual(m2.held, []);
  assert.deepEqual(m2.tasks[0], { id: '7', subject: 'Late', status: 'in_progress', blockedBy: ['3'] });
});

test('held updates for other ids stay held', () => {
  const m = run([update('9', { status: 'completed' }), create('1', 'A')]);
  assert.equal(m.held.length, 1);
  assert.equal(m.held[0]?.taskId, '9');
});

test('a new TaskCreate after a fully completed list starts fresh', () => {
  const m = run([create('1', 'A'), create('2', 'B'), update('1', { status: 'completed' }), update('2', { status: 'completed' }), create('3', 'C')]);
  assert.deepEqual(m.tasks.map((t) => t.id), ['3']);
});

test('a list of only completed and deleted tasks also resets', () => {
  const m = run([create('1', 'A'), create('2', 'B'), update('1', { status: 'completed' }), update('2', { status: 'deleted' }), create('3', 'C')]);
  assert.deepEqual(m.tasks.map((t) => t.id), ['3']);
});

test('a new TaskCreate after an unfinished list appends', () => {
  const m = run([create('1', 'A'), create('2', 'B'), update('1', { status: 'completed' }), create('3', 'C')]);
  assert.deepEqual(m.tasks.map((t) => t.id), ['1', '2', '3']);
});

test('TodoWrite replaces the list with todo-N ids', () => {
  const todos1 = [
    { content: 'One', status: 'in_progress', activeForm: 'Doing one' },
    { content: 'Two', status: 'pending', activeForm: 'Doing two' },
  ];
  const m1 = run([create('1', 'old'), ev('TodoWrite', { todos: todos1 })]);
  assert.equal(m1.source, 'todo');
  assert.deepEqual(m1.tasks.map((t) => t.id), ['todo-1', 'todo-2']);
  assert.equal(m1.tasks[0]?.subject, 'One');
  assert.equal(activeLabel(m1), 'Doing one');
  const m2 = applyToolEvent(m1, ev('TodoWrite', { todos: [{ content: 'Only', status: 'completed', activeForm: 'x' }] }));
  assert.deepEqual(m2.tasks.map((t) => t.subject), ['Only']);
  assert.equal(isComplete(m2), true);
});

test('update_plan items replaces the list', () => {
  const m = run([
    plan({ items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] }),
  ]);
  assert.equal(m.source, 'plan');
  assert.deepEqual(m.tasks.map((t) => t.id), ['plan-1', 'plan-2', 'plan-3']);
  assert.deepEqual(statuses(m), ['completed', 'in_progress', 'pending']);
  assert.equal(m.tasks[0]?.activeForm, undefined);
  assert.equal(activeLabel(m), 'b');
});

test('update_plan advance completes the running step and starts the next', () => {
  const m = applyToolEvent(planOf('completed', 'in_progress', 'pending'), plan({ advance: true }));
  assert.deepEqual(statuses(m), ['completed', 'completed', 'in_progress']);
});

test('update_plan advance with nothing running starts the first pending step', () => {
  const m = applyToolEvent(planOf('completed', 'pending', 'pending'), plan({ advance: true }));
  assert.deepEqual(statuses(m), ['completed', 'in_progress', 'pending']);
});

test('update_plan advance on the last step completes it', () => {
  const m = applyToolEvent(planOf('completed', 'in_progress'), plan({ advance: true }));
  assert.deepEqual(statuses(m), ['completed', 'completed']);
});

test('update_plan done marks 1-based steps completed', () => {
  const m = applyToolEvent(planOf('in_progress', 'pending', 'pending'), plan({ done: [1, 3] }));
  assert.deepEqual(statuses(m), ['completed', 'pending', 'completed']);
});

test('update_plan start makes one step in progress', () => {
  const m = applyToolEvent(planOf('pending', 'pending', 'pending'), plan({ start: 2 }));
  assert.deepEqual(statuses(m), ['pending', 'in_progress', 'pending']);
});

test('update_plan combines done, then start, then advance', () => {
  const m0 = planOf('in_progress', 'pending', 'pending', 'pending');
  assert.deepEqual(statuses(applyToolEvent(m0, plan({ done: [1], start: 2 }))), ['completed', 'in_progress', 'pending', 'pending']);
  // done first, then start, then advance: step 2 is started, then advanced past
  assert.deepEqual(statuses(applyToolEvent(m0, plan({ done: [1], start: 2, advance: true }))), ['completed', 'completed', 'in_progress', 'pending']);
});

test('update_plan ignores out-of-range indexes', () => {
  const m0 = planOf('in_progress', 'pending');
  const m = applyToolEvent(m0, plan({ done: [0, 5, -1], start: 9 }));
  assert.deepEqual(statuses(m), ['in_progress', 'pending']);
});

test('update_plan partial forms with no list change nothing', () => {
  assert.deepEqual(run([plan({ advance: true }), plan({ done: [1] }), plan({ start: 1 })]).tasks, []);
});

test('update_plan text resyncs a missed call', () => {
  const m0 = planOf('in_progress', 'pending', 'pending', 'pending');
  const m = applyToolEvent(m0, plan({}, 'Plan updated: step 3 of 4 is in progress.'));
  assert.deepEqual(statuses(m), ['completed', 'completed', 'in_progress', 'pending']);
});

test('update_plan text with a different step count is not applied', () => {
  const m0 = planOf('in_progress', 'pending');
  const m = applyToolEvent(m0, plan({}, 'Plan updated: step 2 of 5 is in progress.'));
  assert.deepEqual(statuses(m), ['in_progress', 'pending']);
});

test('wrap_up completes the running step and leaves pending ones', () => {
  const m = applyToolEvent(planOf('completed', 'in_progress', 'pending'), ev('mcp__ccd_turn__wrap_up', {}));
  assert.deepEqual(statuses(m), ['completed', 'completed', 'pending']);
});

test('wrap_up with no list is ignored', () => {
  const m0 = emptyModel();
  assert.equal(applyToolEvent(m0, ev('mcp__ccd_turn__wrap_up', {})), m0);
});

test('agentId is accepted and applies like any other call', () => {
  const m = run([create('1', 'A'), update('1', { status: 'completed' })].map((e) => ({ ...e, agentId: 'sub-1' })));
  assert.equal(isComplete(m), true);
});

test('error events are ignored', () => {
  const m0 = run([create('1', 'A')]);
  const m = applyToolEvent(m0, { ...update('1', { status: 'completed' }), isError: true });
  assert.equal(m, m0);
});

test('unknown tools are ignored', () => {
  const m0 = run([create('1', 'A')]);
  assert.equal(applyToolEvent(m0, ev('Bash', { command: 'ls' })), m0);
});

test('events never mutate the input model', () => {
  const m0 = deepFreeze(run([create('1', 'A'), create('2', 'B'), update('1', { status: 'in_progress' }), update('5', { status: 'completed' })]));
  const events = [
    create('3', 'C'),
    update('1', { status: 'completed', addBlockedBy: ['2'] }),
    update('9', { status: 'completed' }),
    ev('TodoWrite', { todos: [{ content: 'x', status: 'pending', activeForm: 'x' }] }),
    plan({ items: [{ content: 'a', status: 'in_progress' }] }),
    plan({ advance: true }),
    ev('mcp__ccd_turn__wrap_up', {}),
  ];
  const before = JSON.stringify(m0);
  for (const e of events) applyToolEvent(m0, e);
  assert.equal(JSON.stringify(m0), before);
  const p = deepFreeze(planOf('in_progress', 'pending'));
  applyToolEvent(p, plan({ advance: true }));
  applyToolEvent(p, plan({}, 'step 2 of 2'));
  applyToolEvent(p, ev('mcp__ccd_turn__wrap_up', {}));
});

test('the model survives a JSON round trip', () => {
  const m = run([create('1', 'A', { activeForm: 'Doing A' }), update('1', { status: 'in_progress', addBlockedBy: ['2'] }), update('8', { status: 'completed' })]);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
  const again = applyToolEvent(JSON.parse(JSON.stringify(m)) as Model, update('1', { status: 'completed' }));
  assert.equal(again.tasks[0]?.status, 'completed');
});

test('applyTaskList rebuilds the list and normalizes statuses', () => {
  const stale = run([create('1', 'old'), update('4', { status: 'completed' })]);
  const m = applyTaskList(stale, [
    { id: '1', subject: 'A', status: 'completed' },
    { id: '2', subject: 'B', status: 'in_progress', blockedBy: ['1'] },
    { id: '3', subject: 'C', status: 'weird' },
  ]);
  assert.equal(m.source, 'task');
  assert.deepEqual(statuses(m), ['completed', 'in_progress', 'pending']);
  assert.deepEqual(m.tasks[1]?.blockedBy, ['1']);
  assert.deepEqual(m.tasks[0]?.blockedBy, []);
  assert.deepEqual(m.held, []);
  assert.equal(stale.tasks.length, 1);
  // later updates keep working after recovery
  assert.equal(applyToolEvent(m, update('3', { status: 'in_progress' })).tasks[2]?.status, 'in_progress');
});

test('counts, fraction and isComplete', () => {
  const m = run([create('1', 'A'), create('2', 'B'), create('3', 'C'), create('4', 'D'), update('1', { status: 'completed' }), update('4', { status: 'deleted' })]);
  assert.deepEqual(counts(m), { done: 1, total: 3 });
  assert.equal(fraction(m), 1 / 3);
  assert.equal(hasList(m), true);
  assert.equal(isComplete(m), false);
  assert.equal(isComplete(run([create('1', 'A'), update('1', { status: 'completed' })])), true);
});

test('a list of only deleted tasks has no list', () => {
  const m = run([create('1', 'A'), update('1', { status: 'deleted' })]);
  assert.equal(hasList(m), false);
  assert.equal(isComplete(m), false);
  assert.equal(fraction(m), 0);
});

test('activeLabel prefers activeForm, falls back to subject, else undefined', () => {
  const withForm = run([create('1', 'Run tests', { activeForm: 'Running tests' }), update('1', { status: 'in_progress' })]);
  assert.equal(activeLabel(withForm), 'Running tests');
  const noForm = run([create('1', 'Run tests'), update('1', { status: 'in_progress' })]);
  assert.equal(activeLabel(noForm), 'Run tests');
  assert.equal(activeLabel(run([create('1', 'Run tests')])), undefined);
  const deleted = run([create('1', 'X'), update('1', { status: 'in_progress' }), update('1', { status: 'deleted' })]);
  assert.equal(activeLabel(deleted), undefined);
});

test('blocked lists open tasks with an unfinished blocker', () => {
  const m = run([
    create('1', 'A'),
    create('2', 'B'),
    create('3', 'C'),
    update('2', { addBlockedBy: ['1'] }),
    update('3', { addBlockedBy: ['1', '2'] }),
  ]);
  assert.deepEqual(blocked(m), ['2', '3']);
  const after = applyToolEvent(m, update('1', { status: 'completed' }));
  assert.deepEqual(blocked(after), ['3']);
  const done = applyToolEvent(after, update('2', { status: 'completed' }));
  assert.deepEqual(blocked(done), []);
  // a completed task is never listed, even with an open blocker
  const odd = run([create('1', 'A'), create('2', 'B'), update('2', { addBlockedBy: ['1'] }), update('2', { status: 'completed' })]);
  assert.deepEqual(blocked(odd), []);
  // a blocker that was deleted no longer blocks
  assert.deepEqual(blocked(applyToolEvent(m, update('1', { status: 'deleted' }))), ['3']);
});
