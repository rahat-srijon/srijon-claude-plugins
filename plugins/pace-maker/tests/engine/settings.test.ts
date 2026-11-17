import { test, expect, mock } from 'claude-code/testing'

const band = {
  plugin: 'pace-maker',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 11 } },
} as never

const done = (turnId: string) => ({ text: '', answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as never

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

/** A config file in memory: `file` is its text, or undefined for a missing file. `reads` counts $.fs.read calls and the paths asked. */
function fakeConfig(on: any, env: Record<string, string> = { PACE_MAKER_DATA_DIR: '/data' }) {
  mock.env(on, env)
  const disk: { file: string | undefined; paths: string[] } = { file: undefined, paths: [] }
  on('fs.read', (_: any, e: any) => {
    disk.paths.push(e.path)
    if (disk.file === undefined) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    return { value: disk.file }
  })
  return disk
}

const create = ($: any, subject: string) => $.tool.call({ tool: 'TaskCreate', subject, description: 'd' })
const drawn = async ($: any) => {
  const ui = await $.ui.mount(band)
  const found = await ui.find({ type: 'Text' })
  await ui.unmount()
  return found?.text as string | undefined
}

test('a missing config file gives the defaults and the band draws', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const disk = fakeConfig(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  expect(await drawn($)).toMatch(/0\/1/)
  expect(disk.paths[0]).toMatch(/data[\\/]config\.json$/)
})

test('a garbled or wrong-typed file gives the defaults and never throws', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const disk = fakeConfig(on)
  for (const text of ['{ not json', '[]', 'null', '{"enabled":"no","fields":7}', '']) {
    disk.file = text
    await $.turn.start({ text: 'go', turnId: 'g' })
    await create($, 'Step')
    expect(await drawn($)).toMatch(/^0\/\d/)
    await $.turn.complete(done('g'))
  }
})

test('the settings are read at session.start and at every turn.start, never when drawing or in tool calls', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const disk = fakeConfig(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(disk.paths.length).toBe(1)
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(disk.paths.length).toBe(2)
  await create($, 'One')
  await create($, 'Two')
  for (let i = 0; i < 5; i++) await drawn($)
  expect(disk.paths.length).toBe(2)
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(disk.paths.length).toBe(3)
  // A subagent's turn is not the main loop: no read.
  await $.turn.start({ text: 'sub', turnId: 's', agentId: 'agent-1' })
  expect(disk.paths.length).toBe(3)
})

test('a change in the file shows at the next turn.start and asks for a redraw', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const disk = fakeConfig(on)
  let redraws = 0
  on('ui.invalidate', () => {
    redraws += 1
    return { value: undefined }
  })
  disk.file = JSON.stringify({ fields: { stepCount: true, percentage: false, stepLabel: false, elapsed: false, subagents: false } })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  expect(await drawn($)).toBe('0/1')

  const before = redraws
  disk.file = JSON.stringify({ fields: { stepCount: false, percentage: true, stepLabel: false, elapsed: false, subagents: false } })
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(redraws).toBeGreaterThan(before)
  expect(await drawn($)).toBe('0%')

  // Unchanged settings do not cause another redraw on their own.
  const settled = redraws
  await $.turn.start({ text: 'same', turnId: 't3' })
  expect(redraws).toBe(settled)
})

test('the home directory is used when there is no override', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const disk = fakeConfig(on, { USERPROFILE: 'C:\\Users\\a' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(disk.paths).toHaveLength(1)
  expect(disk.paths[0]).toMatch(/^C:.Users.a.\.claude.plugins.data.pace-maker.config\.json$/)
})

test('with no override and no home nothing is read and the defaults hold', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const disk = fakeConfig(on, {})
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Step')
  expect(disk.paths).toEqual([])
  expect(await drawn($)).toMatch(/0\/1/)
})

test('enabled: false hides the band, the ticker and the status entry', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const disk = fakeConfig(on)
  const lines: (string | undefined)[] = []
  let redraws = 0
  on('session.surfaces', () => ({ value: ['vscode'] }))
  on('ui.status', (_: any, e: any) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => {
    redraws += 1
    return { value: undefined }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Only step')
  await clock.advance(2000)
  expect(lines.at(-1)).toMatch(/0\/1/)
  expect(await drawn($)).toMatch(/0\/1/)

  disk.file = JSON.stringify({ enabled: false })
  await $.turn.start({ text: 'next', turnId: 't2' })
  await clock.advance(1000)
  expect(await drawn($)).toBeUndefined()
  expect(lines.at(-1)).toBeUndefined()
  const settled = redraws
  await clock.advance(10_000)
  expect(redraws).toBe(settled)

  // Turned back on: it all comes back.
  disk.file = JSON.stringify({ enabled: true })
  await $.turn.start({ text: 'again', turnId: 't3' })
  await clock.advance(1000)
  expect(await drawn($)).toMatch(/0\/1/)
})

test('every /pace command picks up a saved change at once', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  const disk = fakeConfig(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Step')
  expect(await drawn($)).toMatch(/0\/1/)
  disk.file = JSON.stringify({ enabled: false })
  await $.command.run({ command: 'pace', args: 'resume' } as never)
  expect(await drawn($)).toBeUndefined()
})

// ---- /pace config -------------------------------------------------------------------------------------------------

function fakeProcess(on: any, answer: (argv: readonly string[]) => any) {
  const calls: (readonly string[])[] = []
  const full = (r: { exitCode: number; stdout: string; stderr: string }) => ({ ...r, isStdoutTruncated: false, isStderrTruncated: false })
  on('process.run', (_: any, e: any) => {
    calls.push(e.argv)
    return { value: full(answer(e.argv)) }
  })
  return calls
}

test('/pace config runs the launcher and answers with one line holding the URL', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  fakeConfig(on)
  const calls = fakeProcess(on, () => ({ exitCode: 0, stdout: 'http://127.0.0.1:50123/?token=abc123\n', stderr: '' }))
  const text = (await $.command.run({ command: 'pace', args: 'config' } as never)).text as string
  expect(text).toBe('Settings page: http://127.0.0.1:50123/?token=abc123')
  expect(text.includes('\n')).toBe(false)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.[0]).toBe('node')
  expect(calls[0]?.[1]).toMatch(/[\\/]scripts[\\/]cli\.js$|\/scripts\/cli\.js$/)
  expect(calls[0]?.slice(2)).toEqual(['config'])
})

test('/pace config says so in one line when the launch fails or node is missing', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  fakeConfig(on)
  let mode: 'exit' | 'missing' | 'silent' = 'exit'
  on('process.run', () => {
    if (mode === 'missing') throw new Error('spawn node ENOENT')
    if (mode === 'silent') return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 1, stdout: '', stderr: 'pace-maker: timed out waiting for the settings server\n', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const run = async () => (await $.command.run({ command: 'pace', args: 'config' } as never)).text as string

  const manual = /Run in a terminal: node ".*[\/]scripts[\/]cli\.js" config$/
  const failed = await run()
  expect(failed).toMatch(/^Could not open the settings page from this window( \(timed out waiting for the settings server\))?\. Run in a terminal: node "/)
  expect(failed).toMatch(manual)
  expect(failed.includes('\n')).toBe(false)
  expect(failed.length).toBeLessThanOrEqual(220)

  mode = 'missing'
  const missing = await run()
  expect(missing).toMatch(/^Could not open the settings page from this window\. Run in a terminal: node "/)
  expect(missing).toMatch(manual)
  expect(missing.includes('\n')).toBe(false)

  mode = 'silent'
  expect(await run()).toMatch(/^Could not open the settings page from this window[\s\S]*scripts[\/]cli\.js" config$/)
})
