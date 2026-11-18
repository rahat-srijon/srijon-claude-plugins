import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureEvent, isDeniedResult } from '../hooks/lib/failure.ts';

test('an answer or an interrupt is no failure', () => {
  assert.equal(failureEvent({ reason: 'answer', answer: 'done' }), null);
  assert.equal(failureEvent({ reason: 'aborted', answer: '' }), null);
  assert.equal(failureEvent({}), null);
});

test('an API error becomes a stopFailure carrying the text, cut short', () => {
  assert.deepEqual(failureEvent({ reason: 'error', answer: 'API Error: 529 overloaded' }), { kind: 'stopFailure', code: 'error', message: 'API Error: 529 overloaded' });
  assert.deepEqual(failureEvent({ reason: 'error', answer: '' }), { kind: 'stopFailure', code: 'error', message: 'API error' });
  const long = failureEvent({ reason: 'error', answer: `boom ${'x'.repeat(500)}` });
  assert.ok(long?.kind === 'stopFailure' && long.message.length <= 120);
});

test('rate-limit and usage-limit wording becomes the usageLimit event', () => {
  for (const text of ['Rate limit exceeded', 'API Error: 429 Too Many Requests', 'You have hit your usage limit', '5-hour limit reached', 'rate_limit_error']) {
    assert.deepEqual(failureEvent({ reason: 'error', answer: text }), { kind: 'usageLimit' }, text);
  }
});

test('a reset time in the text rides along', () => {
  assert.deepEqual(failureEvent({ reason: 'error', answer: 'Usage limit reached, resets 2026-11-19T00:00:00Z' }), {
    kind: 'usageLimit', resetsAt: '2026-11-19T00:00:00Z',
  });
});

test('a refusal becomes a stopFailure with the API explanation, else the category', () => {
  assert.deepEqual(failureEvent({ reason: 'refusal', answer: '', refusal: { category: 'cyber', explanation: 'Declined for safety' } }), {
    kind: 'stopFailure', code: 'refusal', message: 'Declined for safety',
  });
  assert.deepEqual(failureEvent({ reason: 'refusal', answer: '', refusal: { category: 'cyber', explanation: null } }), {
    kind: 'stopFailure', code: 'refusal', message: 'cyber',
  });
  assert.deepEqual(failureEvent({ reason: 'refusal', answer: '', refusal: { category: null, explanation: null } }), {
    kind: 'stopFailure', code: 'refusal', message: 'the model declined',
  });
});

test('garbage never throws', () => {
  for (const e of [{ reason: 'error', answer: 5 }, { reason: 'refusal', refusal: null }, { reason: 'refusal', refusal: 3 }]) {
    assert.doesNotThrow(() => failureEvent(e as never));
  }
});

test('isDeniedResult: the deny variant and the engine\'s permission-denied error, not a tool\'s own failure', () => {
  assert.equal(isDeniedResult({ deny: 'no' }), true);
  assert.equal(isDeniedResult({ isError: true, text: 'Permission to use Bash has been denied. IMPORTANT: you may try other tools.' }), true);
  assert.equal(isDeniedResult({ isError: true, result: 'Error: Permission to use Edit has been denied.' }), true);
  assert.equal(isDeniedResult({ isError: true, text: "The user doesn't want to proceed with this tool use." }), true);
  assert.equal(isDeniedResult({ isError: true, text: 'ENOENT: no such file' }), false);
  assert.equal(isDeniedResult({ isError: false, text: 'Permission to use Bash has been denied' }), false);
  assert.equal(isDeniedResult({ result: {}, text: 'ok' }), false);
  assert.equal(isDeniedResult(undefined), false);
  assert.equal(isDeniedResult(null), false);
});
