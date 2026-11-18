import { test, expect, mock } from 'claude-code/testing'
import { watchState } from './kit'

const done = (turnId: string, extra: Record<string, unknown> = {}) =>
  ({ text: '', answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer', ...extra }) as never

function engineBottom(on: any) {
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
}

test('turn.start and turn.complete follow the main loop only', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const state = watchState(on)
  engineBottom(on)

  await $.turn.start({ text: 'sub', turnId: 'a', agentId: 'agent-1' })
  await $.turn.complete(done('a', { agentId: 'agent-1' }))
  expect(state.count('session')).toBe(0)

  await $.turn.start({ text: 'go', turnId: 'm' })
  expect(state.last('session')).toMatchObject({ running: true, startedAt: 1000 })
  await clock.advance(5000)
  await $.turn.complete(done('m', { answer: 'Should I continue?' }))
  expect(state.last('session')).toMatchObject({
    running: false,
    endedAt: 6000,
    lastEnd: { isAborted: false, answer: 'Should I continue?' },
  })
  await $.turn.start({ text: 'again', turnId: 'm2' })
  await $.turn.complete(done('m2', { isAborted: true, reason: 'aborted' }))
  expect(state.last('session').lastEnd.isAborted).toBe(true)
})

test('AskUserQuestion sets the prompt, then clears it when answered', async ($, on) => {
  const state = watchState(on)
  let during: unknown = 'unset'
  on('tool.call', () => {
    during = state.last('session')?.permission
    return { result: {}, text: 'answered' }
  })
  const ran = await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect(during).toEqual({ tool: 'AskUserQuestion' })
  expect(state.last('session').permission).toBeNull()
  expect(ran.text).toBe('answered')
})

test('ExitPlanMode marks plan mode waiting; the next turn clears it', async ($, on) => {
  mock.clock(on)
  const state = watchState(on)
  engineBottom(on)
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect(state.last('session').planWaiting).toBe(true)
  await $.turn.start({ text: 'ok', turnId: 'n' })
  expect(state.last('session').planWaiting).toBe(false)
})

test('a tool.check that resolves to ask raises the prompt only where somebody can answer', async ($, on) => {
  const state = watchState(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' })
  expect(state.count('session')).toBe(0)
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u2', approver: 'person' })
  expect(state.last('session').permission).toEqual({ tool: 'Bash' })
})

test('a tool.check ask is cleared when the call finishes', async ($, on) => {
  mock.clock(on)
  const state = watchState(on)
  engineBottom(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1', approver: 'person' })
  expect(state.last('session').permission).toEqual({ tool: 'Bash' })
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u1' })
  expect(state.last('session').permission).toBeNull()
})

test('a tool.check deny is a denied permission; a query or a subagent call is not', async ($, on) => {
  const state = watchState(on)
  on('tool.check', () => ({ decision: 'deny', reason: 'no' }))
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf /' } }) // a query: no call id
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'a1', agentId: 'agent-1' })
  expect(state.count('session')).toBe(0)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf /' }, tool_use_id: 'u1' })
  expect(state.last('session').denied).toEqual({ tool: 'Bash' })
  expect(state.last('session').permission).toBeNull()
})

test('a denied tool.call result (a person said no, or a hook did) is a denied permission', async ($, on) => {
  const state = watchState(on)
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', () => ({ deny: 'The user rejected this tool call' }))
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u1', approver: 'person' })
  expect(state.last('session').permission).toEqual({ tool: 'Bash' })
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u1' })
  expect(ran.isError).toBe(true) // the engine turns a refusal into an errored result
  expect(state.last('session')).toMatchObject({ permission: null, denied: { tool: 'Bash' } })
})

test('a tool that fails on its own is not a denied permission', async ($, on) => {
  const state = watchState(on)
  on('tool.call', () => ({ result: 'ENOENT: no such file', text: 'ENOENT: no such file', isError: true }) as never)
  await $.tool.call({ tool: 'Bash', command: 'cat nope', tool_use_id: 'u1' })
  expect(state.last('session')?.denied ?? null).toBeNull()
})

test('a refused ExitPlanMode is the user declining a plan, not a denied permission', async ($, on) => {
  const state = watchState(on)
  on('tool.call', () => ({ deny: 'no' }))
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect(state.last('session')?.denied ?? null).toBeNull()
  expect(state.last('session')?.planWaiting ?? false).toBe(false)
})

test('turn.complete with reason error: a usage limit, another API error', async ($, on) => {
  mock.clock(on)
  const state = watchState(on)
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 'a' })
  await $.turn.complete(done('a', { reason: 'error', answer: 'Usage limit reached, resets 2026-11-19T00:00:00Z' }))
  expect(state.last('session')).toMatchObject({ running: false, limit: { resetsAt: '2026-11-19T00:00:00Z' }, error: null })
  await $.turn.start({ text: 'again', turnId: 'b' })
  expect(state.last('session').limit).toBeNull()
  await $.turn.complete(done('b', { reason: 'error', answer: 'API Error: 529 overloaded' }))
  expect(state.last('session')).toMatchObject({ running: false, error: { code: 'error', message: 'API Error: 529 overloaded' } })
  await $.turn.start({ text: 'rate', turnId: 'c' })
  await $.turn.complete(done('c', { reason: 'error', answer: 'API Error: 429 rate_limit_error' }))
  expect(state.last('session').limit).toEqual({})
})

test('turn.complete with reason refusal carries the API explanation', async ($, on) => {
  mock.clock(on)
  const state = watchState(on)
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 'a' })
  await $.turn.complete(done('a', { reason: 'refusal', answer: '', refusal: { category: 'cyber', explanation: 'Declined for safety' } }))
  expect(state.last('session').error).toEqual({ code: 'refusal', message: 'Declined for safety' })
})

test('a subagent turn that errors is ignored; an answer sets no error', async ($, on) => {
  mock.clock(on)
  const state = watchState(on)
  engineBottom(on)
  await $.turn.start({ text: 'sub', turnId: 's', agentId: 'agent-1' })
  await $.turn.complete(done('s', { agentId: 'agent-1', reason: 'error', answer: 'rate limit' }))
  expect(state.count('session')).toBe(0)
  await $.turn.start({ text: 'go', turnId: 'm' })
  await $.turn.complete(done('m'))
  expect(state.last('session')).toMatchObject({ error: null, limit: null })
})

test('/pace registers once and off, on, pause and resume change the session atom', async ($, on) => {
  const state = watchState(on)
  const registered: string[] = []
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['pace'])

  const run = (args: string) => $.command.run({ command: 'pace', args } as never)
  expect((await run('off')).text).toBe('Off for this conversation.')
  expect(state.last('session').disabled).toBe(true)
  expect((await run('pause waiting for review')).text).toBe('Paused: waiting for review.')
  expect(state.last('session').pause).toEqual({ reason: 'waiting for review' })
  expect((await run('on')).text).toBe('On.')
  expect(state.last('session')).toMatchObject({ disabled: false, pause: null })
  await run('pause lunch')
  expect((await run('resume')).text).toBe('Resumed.')
  expect(state.last('session').pause).toBeNull()
  const usage = (await run('')).text as string
  expect(usage).toMatch(/Usage/)
  expect(usage).toBe('Usage: /pace on|off|pause <reason>|resume')
  expect((await run('config')).text).toBe(usage)
  expect((await run('pause so. it ends.')).text).toBe('Paused: so. it ends.')
  for (const args of ['off', 'on', 'pause x', 'resume', '']) {
    const t = (await run(args)).text as string
    expect(t.includes('\n')).toBe(false)
    expect(t).not.toMatch(/pace-maker/i)
  }
  expect(usage.includes('\n')).toBe(false)
})
