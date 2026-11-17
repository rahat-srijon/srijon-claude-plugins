import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPLAIN_INSTRUCTION, EXPLAIN_REQUEST, TASK_LIST_LINE, buildExplainPrompt, clampReason, shouldAskForTaskList, shouldExplain,
} from '../hooks/lib/explain.ts';
import type { View } from '../hooks/lib/view.ts';

const on = { enabled: true, ai: { explainStop: true, askForTaskList: true } };
const off = { enabled: true, ai: { explainStop: false, askForTaskList: false } };
const stopped: View = { kind: 'stopped', done: 1, total: 3, left: 2 };

test('shouldExplain: only an unexplained stopped view with the setting and the plugin on', () => {
  assert.equal(shouldExplain(stopped, on), true);
  assert.equal(shouldExplain(stopped, off), false); // the zero-token default
  assert.equal(shouldExplain(stopped, { ...on, enabled: false }), false);
  assert.equal(shouldExplain({ ...stopped, reason: 'already known' }, on), false);
  for (const v of [
    { kind: 'hidden' }, { kind: 'working', elapsedMs: 1, subagents: 0 }, { kind: 'done', done: 1, total: 1, durationMs: 1 },
    { kind: 'waiting', why: 'question', done: 1, total: 3 }, { kind: 'blocked', why: 'error', done: 1, total: 3 },
    { kind: 'paused', why: 'interrupt', done: 1, total: 3 }, { kind: 'progress', done: 1, total: 3, fraction: 0.3, elapsedMs: 1 },
  ] as View[]) assert.equal(shouldExplain(v, on), false, v.kind);
});

test('the call settings are a small, short, bounded request', () => {
  assert.deepEqual({ ...EXPLAIN_REQUEST }, { model: 'haiku', maxTokens: 30, effort: 'low', timeoutMs: 15000 });
});

test('buildExplainPrompt: the last 1500 characters of the answer, then the instruction, nothing else', () => {
  const answer = `HEAD${'x'.repeat(3000)}TAIL`;
  const p = buildExplainPrompt(answer);
  assert.equal(p, `${answer.slice(-1500)}\n\n${EXPLAIN_INSTRUCTION}`);
  assert.equal(p.includes('HEAD'), false);
  assert.equal(buildExplainPrompt('short answer'), `short answer\n\n${EXPLAIN_INSTRUCTION}`);
  assert.equal(EXPLAIN_INSTRUCTION, 'Reply with the reason this turn stopped in at most 8 words, no quotes, no trailing period.');
});

test('clampReason: 8 words, 60 characters, one line, no quotes, no trailing period', () => {
  assert.equal(clampReason('Waiting on the build to finish.'), 'Waiting on the build to finish');
  assert.equal(clampReason('"Needs your decision on the API"\n'), 'Needs your decision on the API');
  assert.equal(clampReason('one two three four five six seven eight nine ten'), 'one two three four five six seven eight');
  assert.equal(clampReason('line one\nline two\r\nline three'), 'line one line two line three');
  assert.equal(clampReason("it doesn't compile"), "it doesn't compile");
  const long = clampReason('Supercalifragilistic extraordinarily lengthy explanation regarding nothing');
  assert.ok(long.length <= 60, long);
  assert.equal(clampReason(`${'a'.repeat(100)} b`), 'a'.repeat(60));
  for (const bad of ['', '   ', '\n', '""', '.', undefined, null, 5, {}]) assert.equal(clampReason(bad), '');
});

test('shouldAskForTaskList: setting and plugin on, and a task tool among the offered tools', () => {
  assert.equal(shouldAskForTaskList(on, ['Bash', 'TodoWrite']), true);
  assert.equal(shouldAskForTaskList(on, ['mcp__ccd_turn__update_plan']), true);
  assert.equal(shouldAskForTaskList(on, ['TaskCreate', 'TaskUpdate']), true);
  assert.equal(shouldAskForTaskList(on, ['Bash', 'Read']), false);
  assert.equal(shouldAskForTaskList(on, []), false);
  assert.equal(shouldAskForTaskList(on, undefined), false); // cannot tell: skip, no tokens spent
  assert.equal(shouldAskForTaskList(off, ['TodoWrite']), false);
  assert.equal(shouldAskForTaskList({ ...on, enabled: false }, ['TodoWrite']), false);
  assert.ok(TASK_LIST_LINE.length < 120);
});
