import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, applyEvent, type SessionState, type StateEvent } from '../hooks/lib/state.ts';

const run = (events: StateEvent[], from: SessionState = emptyState(), now = 1000): SessionState =>
  events.reduce((s, e) => applyEvent(s, e, now), from);

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

test('emptyState is idle and enabled', () => {
  const s = emptyState();
  assert.equal(s.shape, 'state-3');
  assert.equal(s.disabled, false);
  assert.equal(s.running, false);
  assert.equal(s.startedAt, null);
  assert.equal(s.lastEnd, null);
  assert.equal(s.stopReason, null);
});

test('toolCall counts calls since the turn started; turnStart resets the count and stamps the turn', () => {
  const s = run([{ kind: 'turnStart' }, { kind: 'toolCall' }, { kind: 'toolCall' }], emptyState(), 1000);
  assert.equal(s.toolCalls, 2);
  assert.equal(s.turnStartedAt, 1000);
  const again = applyEvent(s, { kind: 'turnStart' }, 9000);
  assert.equal(again.toolCalls, 0);
  assert.equal(again.turnStartedAt, 9000);
  assert.equal(again.startedAt, 1000);
  // A turn ending keeps the count (the view reads it), and resetRun does not touch it.
  assert.equal(applyEvent(s, { kind: 'turnComplete', isAborted: false, answer: '' }, 3000).toolCalls, 2);
  assert.equal(applyEvent(s, { kind: 'resetRun' }).toolCalls, 2);
  assert.equal(emptyState().toolCalls, 0);
});

test('stopReason stores the text, and turnStart and resetRun clear it', () => {
  const s = run([{ kind: 'turnStart' }, { kind: 'turnComplete', isAborted: false, answer: 'x' }, { kind: 'stopReason', text: 'waiting on the build' }]);
  assert.equal(s.stopReason, 'waiting on the build');
  assert.equal(run([{ kind: 'turnStart' }], s).stopReason, null);
  assert.equal(run([{ kind: 'resetRun' }], s).stopReason, null);
  assert.equal(run([{ kind: 'stopReason', text: '' }], s).stopReason, null);
  assert.equal(run([{ kind: 'stopReason', text: 'a' }], deepFreeze(emptyState())).stopReason, 'a');
});

test('turnStart sets running and startedAt, and clears the stop reasons', () => {
  const dirty: SessionState = {
    ...emptyState(),
    permission: { tool: 'Bash' },
    pause: { reason: 'x' },
    planWaiting: true,
    error: { message: 'boom' },
    denied: { tool: 'Bash' },
    limit: {},
    lastEnd: { isAborted: true, answer: 'a' },
  };
  const s = applyEvent(dirty, { kind: 'turnStart' }, 500);
  assert.equal(s.running, true);
  assert.equal(s.startedAt, 500);
  assert.equal(s.permission, null);
  assert.equal(s.pause, null);
  assert.equal(s.planWaiting, false);
  assert.equal(s.error, null);
  assert.equal(s.denied, null);
  assert.equal(s.limit, null);
  assert.equal(s.lastEnd, null);
});

test('turnStart keeps an existing startedAt', () => {
  const s = run([{ kind: 'turnStart' }], { ...emptyState(), startedAt: 100 }, 900);
  assert.equal(s.startedAt, 100);
});

test('turnComplete stops the run, stamps endedAt, clears permission and records the end', () => {
  const s = applyEvent(
    run([{ kind: 'turnStart' }, { kind: 'permissionPrompt', tool: 'Bash' }], emptyState(), 100),
    { kind: 'turnComplete', isAborted: false, answer: 'done' },
    700,
  );
  assert.equal(s.running, false);
  assert.equal(s.endedAt, 700);
  assert.equal(s.permission, null);
  assert.deepEqual(s.lastEnd, { isAborted: false, answer: 'done' });
});

test('permission prompt, resolve and deny', () => {
  const s1 = run([{ kind: 'permissionPrompt', tool: 'Edit' }]);
  assert.deepEqual(s1.permission, { tool: 'Edit' });
  assert.equal(run([{ kind: 'permissionResolved' }], s1).permission, null);
  const s2 = run([{ kind: 'permissionDenied', tool: 'Edit' }], s1);
  assert.equal(s2.permission, null);
  assert.deepEqual(s2.denied, { tool: 'Edit' });
});

test('stopFailure stops the run and records the error', () => {
  const s = run([{ kind: 'turnStart' }, { kind: 'stopFailure', code: '529', message: 'overloaded' }]);
  assert.equal(s.running, false);
  assert.deepEqual(s.error, { code: '529', message: 'overloaded' });
  assert.deepEqual(run([{ kind: 'stopFailure', message: 'm' }]).error, { message: 'm' });
});

test('usageLimit, planWaiting, pause and resume', () => {
  assert.deepEqual(run([{ kind: 'usageLimit', resetsAt: '5pm' }]).limit, { resetsAt: '5pm' });
  assert.deepEqual(run([{ kind: 'usageLimit' }]).limit, {});
  assert.equal(run([{ kind: 'planWaiting' }]).planWaiting, true);
  const paused = run([{ kind: 'pause', reason: 'lunch' }]);
  assert.deepEqual(paused.pause, { reason: 'lunch' });
  assert.equal(run([{ kind: 'resume' }], paused).pause, null);
});

test('setDisabled toggles', () => {
  const off = run([{ kind: 'setDisabled', value: true }]);
  assert.equal(off.disabled, true);
  assert.equal(run([{ kind: 'setDisabled', value: false }], off).disabled, false);
});

test('resetRun clears the run facts but keeps disabled and pause', () => {
  const s = run(
    [
      { kind: 'setDisabled', value: true },
      { kind: 'turnStart' },
      { kind: 'pause', reason: 'p' },
      { kind: 'stopFailure', message: 'x' },
      { kind: 'usageLimit' },
      { kind: 'planWaiting' },
      { kind: 'permissionDenied', tool: 'T' },
      { kind: 'turnComplete', isAborted: false, answer: 'a' },
      { kind: 'resetRun' },
    ],
  );
  assert.equal(s.startedAt, null);
  assert.equal(s.endedAt, null);
  assert.equal(s.lastEnd, null);
  assert.equal(s.error, null);
  assert.equal(s.denied, null);
  assert.equal(s.limit, null);
  assert.equal(s.planWaiting, false);
  assert.equal(s.disabled, true);
  assert.deepEqual(s.pause, { reason: 'p' });
});

test('out-of-order and unknown events never throw', () => {
  const base = emptyState();
  assert.deepEqual(run([{ kind: 'permissionResolved' }]), base);
  assert.deepEqual(run([{ kind: 'resume' }]), base);
  assert.doesNotThrow(() => applyEvent(base, { kind: 'bogus' } as unknown as StateEvent));
  assert.doesNotThrow(() => applyEvent(base, undefined as unknown as StateEvent));
  assert.deepEqual(applyEvent(base, { kind: 'bogus' } as unknown as StateEvent), base);
  const s = run([{ kind: 'turnComplete', isAborted: false, answer: 'hi' }], base, 42);
  assert.equal(s.running, false);
  assert.equal(s.startedAt, null);
  assert.equal(s.endedAt, 42);
});

test('applyEvent does not mutate its input and returns a new object', () => {
  const s = deepFreeze(emptyState());
  const next = applyEvent(s, { kind: 'turnStart' }, 1);
  assert.notEqual(next, s);
  assert.equal(s.running, false);
  assert.notEqual(applyEvent(s, { kind: 'resume' }), s);
});

test('state survives a JSON round trip', () => {
  const s = run([{ kind: 'turnStart' }, { kind: 'permissionPrompt', tool: 'Bash' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});
