import { test, expect, mock } from 'claude-code/testing'
import { watchState } from './kit'

test('TaskCreate and TaskUpdate update the progress atom', async ($, on) => {
  const state = watchState(on)
  let n = 0
  on('tool.call', (_, e) =>
    e.tool === 'TaskCreate'
      ? { result: { task: { id: String(++n), subject: String(e.subject) } } }
      : { result: { success: true } },
  )
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write tests', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', activeForm: 'Writing tests' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  const model = state.last('progress')
  expect(model.tasks.map((t: any) => [t.subject, t.status])).toEqual([
    ['Write tests', 'completed'],
    ['Ship it', 'pending'],
  ])
  expect(model.source).toBe('task')
})

test('update_plan items, advance and wrap_up drive the list to complete', async ($, on) => {
  const state = watchState(on)
  on('tool.call', (_, e) => ({ result: {}, text: e.tool === 'mcp__ccd_turn__update_plan' ? 'Plan shown (2 steps).' : 'ok' }))
  const plan = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__ccd_turn__update_plan', ...input } as never)

  await plan({ items: [{ content: 'Read', status: 'in_progress' }, { content: 'Write', status: 'pending' }] })
  expect(state.last('progress').tasks.map((t: any) => t.status)).toEqual(['in_progress', 'pending'])
  await plan({ advance: true })
  expect(state.last('progress').tasks.map((t: any) => t.status)).toEqual(['completed', 'in_progress'])
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' } as never)
  expect(state.last('progress').tasks.map((t: any) => t.status)).toEqual(['completed', 'completed'])
  expect(state.last('progress').source).toBe('plan')
})

test('a new list after a finished one starts a fresh run', async ($, on) => {
  mock.clock(on)
  const state = watchState(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'a', status: 'completed', activeForm: 'a' }] })
  expect(state.last('session').lastEnd).not.toBeNull()
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'b', status: 'pending', activeForm: 'b' }] })
  expect(state.last('session').lastEnd).toBeNull()
  expect(state.last('progress').tasks.map((t: any) => t.subject)).toEqual(['b'])
})

test('an error in the logic does not change the tool call result', async ($, on) => {
  on('state.set', () => {
    throw new Error('boom')
  })
  on('tool.call', () => ({ result: { task: { id: '1', subject: 'x' } }, text: 'created' }))
  const ran = await $.tool.call({ tool: 'TaskCreate', subject: 'x', description: 'd' })
  expect(ran.text).toBe('created')
  expect(ran.result).toEqual({ task: { id: '1', subject: 'x' } })
})
