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

test('a permission_prompt notification raises the prompt and the next finished call clears it', async ($, on) => {
  mock.clock(on)
  const state = watchState(on)
  engineBottom(on)
  on('classic.Notification', () => ({}))
  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  expect(state.count('session')).toBe(0) // not running: stays neutral
  await $.turn.start({ text: 'go', turnId: 't' })
  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  expect(state.last('session').permission).toEqual({ tool: 'Bash' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(state.last('session').permission).toBeNull()
})

test('errors: a usage limit, another API error, a denied tool', async ($, on) => {
  const state = watchState(on)
  on('classic.StopFailure', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  await $.classic.StopFailure({ error: 'rate_limit', error_details: 'Limit reached, resets 2026-11-19T00:00:00Z' })
  expect(state.last('session').limit).toEqual({ resetsAt: '2026-11-19T00:00:00Z' })
  await $.classic.StopFailure({ error: 'overloaded', error_details: 'API Error: 529' })
  expect(state.last('session').error).toEqual({ code: 'overloaded', message: 'API Error: 529' })
  await $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'x', reason: 'no' })
  expect(state.last('session').denied).toEqual({ tool: 'Bash' })
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
  expect((await run('off')).text).toMatch(/off/)
  expect(state.last('session').disabled).toBe(true)
  await run('pause waiting for review')
  expect(state.last('session').pause).toEqual({ reason: 'waiting for review' })
  expect((await run('on')).text).toMatch(/on/)
  expect(state.last('session')).toMatchObject({ disabled: false, pause: null })
  await run('pause lunch')
  expect((await run('resume')).text).toBeTruthy()
  expect(state.last('session').pause).toBeNull()
  const usage = (await run('')).text as string
  expect(usage).toMatch(/Usage/)
  expect(usage).toMatch(/config/)
  expect(usage.includes('\n')).toBe(false)
})
