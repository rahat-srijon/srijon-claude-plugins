import { test, expect } from 'claude-code/testing'
import { watchState } from './kit'

const ids = (state: ReturnType<typeof watchState>) => state.last('bg').items.map((i: any) => `${i.kind}:${i.id}`)

test('background shells, agents and monitors start; a plain Bash does not', async ($, on) => {
  const state = watchState(on)
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') {
      return (e as any).run_in_background
        ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'sh1' } }
        : { result: { stdout: 'hi', stderr: '', interrupted: false } }
    }
    if (e.tool === 'Agent') return { result: { status: 'async_launched', agentId: 'ag1', description: 'd', prompt: 'p', outputFile: 'f' } }
    if (e.tool === 'Monitor') return { result: { taskId: 'mon1', timeoutMs: 0 } }
    return { result: {} }
  })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(state.count('bg')).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true })
  await $.tool.call({ tool: 'Agent', description: 'Explore', prompt: 'p', run_in_background: true } as never)
  await $.tool.call({ tool: 'Monitor', description: 'watch logs', timeout_ms: 1000, command: 'tail -f x' } as never)
  expect(ids(state)).toEqual(['shell:sh1', 'agent:ag1', 'monitor:mon1'])
})

test('TaskStop, a terminal task-notification, Stop and session end finish background items', async ($, on) => {
  const state = watchState(on)
  on('classic.Stop', () => ({}))
  on('session.end', (_, e) => ({ sessionId: (e as any).sessionId ?? 's' }) as never)
  on('tool.call', (_, e) =>
    e.tool === 'Bash'
      ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${(e as any).command}` } }
      : { result: {} },
  )
  const start = (command: string) => $.tool.call({ tool: 'Bash', command, run_in_background: true })
  for (const c of ['1', '2', '3', '4']) await start(c)
  expect(ids(state)).toEqual(['shell:b1', 'shell:b2', 'shell:b3', 'shell:b4'])

  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' })
  expect(ids(state)).toEqual(['shell:b2', 'shell:b3', 'shell:b4'])

  const note = (text: string) =>
    $.session.append({
      message: { type: 'user', content: [{ type: 'text', text }] },
      door: 'delivery',
      origin: { kind: 'task-notification' },
      uuid: 'n1',
    } as never)
  await note('<task-notification><task-id>b2</task-id><status>running</status></task-notification>')
  expect(ids(state)).toEqual(['shell:b2', 'shell:b3', 'shell:b4'])
  await note('<task-notification><task-id>b2</task-id><status>completed</status></task-notification>')
  expect(ids(state)).toEqual(['shell:b3', 'shell:b4'])

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b4', type: 'shell', status: 'running', description: 'x' }] })
  expect(ids(state)).toEqual(['shell:b4'])
  await $.session.end({ reason: 'other' } as never)
  expect(ids(state)).toEqual([])
})

test('a TaskList result rebuilds the list', async ($, on) => {
  const state = watchState(on)
  on('tool.call', () => ({
    result: { tasks: [{ id: '1', subject: 'A', status: 'completed' }, { id: '2', subject: 'B', status: 'in_progress', blockedBy: [] }] },
  }))
  await $.tool.call({ tool: 'TaskList' } as never)
  expect(state.last('progress').tasks.map((t: any) => t.status)).toEqual(['completed', 'in_progress'])
})
