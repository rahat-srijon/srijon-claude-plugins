import { test, expect, mock } from 'claude-code/testing'
import { drawn, watchState } from './kit'

const done = (turnId: string, extra: Record<string, unknown> = {}) =>
  ({ text: '', answer: 'Finished the first part.', durationMs: 1, isAborted: false, turnId, reason: 'answer', ...extra }) as never

function engineBottom(on: any) {
  let n = 0
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.call', (_: any, e: any) =>
    e.tool === 'TaskCreate' ? { result: { task: { id: String(++n), subject: String(e.subject) } } } : { result: { success: true }, text: 'ok' },
  )
}

/** Counts and records every model.complete the plugin makes; `answer` decides each reply. */
function fakeModel(on: any, answer: (e: any) => any) {
  const calls: any[] = []
  on('model.complete', async (_: any, e: any) => {
    calls.push(e)
    return { value: await answer(e) }
  })
  return calls
}
const reply = (text: string) => ({ isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } })
const settle = () => new Promise((r) => (globalThis as any).setTimeout(r, 20))

const create = ($: any, subject: string) => $.tool.call({ tool: 'TaskCreate', subject, description: 'd' })

/** One turn that leaves the list open: a session with two tasks, then the turn ends normally. */
async function stopWithTasksLeft($: any, answer = 'Finished the first part.') {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  await create($, 'Ship it')
  await $.turn.complete(done('t1', { answer }))
  await settle()
}

// ---- Explain why it stopped ----------------------------------------------------------------------------------------

test('with the AI setting off no model call is made', { options: {} }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const calls = fakeModel(on, () => reply('should never be asked'))
  const state = watchState(on)
  await stopWithTasksLeft($)
  expect(await drawn($)).toMatch(/Stopped/)
  expect(await drawn($)).not.toMatch(/should never/)
  expect(calls).toHaveLength(0)
  expect(state.last('session').stopReason).toBeNull()
})

test('explainStop on: one small-model call, the reply is clamped and reaches the stopped view', { options: { explainStop: true } }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const calls = fakeModel(on, () => reply('"Waiting on you to pick one of the two\noptions."'))
  const state = watchState(on)
  const answer = `HEAD${'x'.repeat(2000)}TAIL`
  await stopWithTasksLeft($, answer)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ model: 'haiku', maxTokens: 30, effort: 'low', timeoutMs: 15000 })
  expect(calls[0].prompt).toBe(`${answer.slice(-1500)}\n\nReply with the reason this turn stopped in at most 8 words, no quotes, no trailing period.`)
  expect(state.last('session').stopReason).toBe('Waiting on you to pick one of the')
  const text = await drawn($)
  expect(text).toMatch(/Stopped/)
  expect(text).toMatch(/Waiting on you to pick one of the/)
})

test('a failed, empty or throwing reply leaves the plain stopped line and never breaks the turn', { options: { explainStop: true } }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  let mode = 0
  const calls = fakeModel(on, () => {
    mode++
    if (mode === 1) return { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} }
    if (mode === 2) return reply('  ""  ')
    throw new Error('boom')
  })
  const state = watchState(on)
  await stopWithTasksLeft($)
  for (const id of ['t2', 't3']) {
    await $.turn.start({ text: 'again', turnId: id })
    await $.turn.complete(done(id))
    await settle()
  }
  expect(calls).toHaveLength(3) // one call per stop
  expect(state.last('session').stopReason).toBeNull()
  expect(await drawn($)).toMatch(/Stopped/)
})

test('no call when the turn was aborted, errored, asked a question, has no list or is a subagent turn', { options: { explainStop: true } }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const calls = fakeModel(on, () => reply('should not be called'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'no list', turnId: 'n1' })
  await $.turn.complete(done('n1'))
  await settle()
  expect(calls).toHaveLength(0) // no task list: hidden, not stopped

  await $.turn.start({ text: 'go', turnId: 'a' })
  await create($, 'Write tests')
  await $.turn.complete(done('a', { isAborted: true, reason: 'aborted' }))
  await settle()
  expect(calls).toHaveLength(0)

  await $.turn.start({ text: 'ask', turnId: 'q' })
  await $.turn.complete(done('q', { answer: 'Should I continue with the second part?' }))
  await settle()
  expect(calls).toHaveLength(0)

  await $.turn.start({ text: 'err', turnId: 'e' })
  await $.turn.complete(done('e', { reason: 'error', answer: 'API error 500' }))
  await settle()
  expect(calls).toHaveLength(0)

  await $.turn.start({ text: 'sub', turnId: 's', agentId: 'agent-1' })
  await $.turn.complete(done('s', { agentId: 'agent-1' }))
  await settle()
  expect(calls).toHaveLength(0)
})

test('a new turn aborts the call in flight and a late reply is dropped', { options: { explainStop: true } }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  let release: (v: unknown) => void = () => {}
  const calls = fakeModel(on, () => new Promise((resolve) => { release = resolve }))
  const state = watchState(on)
  await stopWithTasksLeft($)
  expect(calls).toHaveLength(1)
  await $.turn.start({ text: 'next', turnId: 't2' })
  release(reply('A stale reason'))
  await settle()
  expect(state.last('session').stopReason).toBeNull()
  await $.turn.complete(done('t2', { isAborted: true, reason: 'aborted' }))
  await settle()
  expect(state.last('session').stopReason).toBeNull()
  expect(calls).toHaveLength(1)
})

test('the session ending drops a reply that is still on its way', { options: { explainStop: true } }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('session.end', () => ({ sessionId: 's' }) as never)
  let release: (v: unknown) => void = () => {}
  fakeModel(on, () => new Promise((resolve) => { release = resolve }))
  const state = watchState(on)
  await stopWithTasksLeft($)
  await $.session.end({ reason: 'other' } as never)
  release(reply('Too late'))
  await settle()
  expect(state.last('session').stopReason).toBeNull()
})

test('a plugin that is off globally calls no model', { options: { enabled: false, explainStop: true } }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const calls = fakeModel(on, () => reply('nope'))
  await stopWithTasksLeft($)
  expect(calls).toHaveLength(0)
})
