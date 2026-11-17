import { test, expect, mock } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const band = (surface: (typeof SURFACES)[number], extra: Record<string, unknown> = {}) =>
  ({
    plugin: 'pace-maker',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: true,
      maxRows: 12,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 11 },
      ...extra,
    },
  }) as never

const done = (turnId: string, extra: Record<string, unknown> = {}) =>
  ({ text: '', answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer', ...extra }) as never

// Nothing sits below the plugin: these hooks stand for the engine.
function engineBottom(on: any, hold?: { tool: string; until: Promise<void> }) {
  let n = 0
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', async (_: any, e: any) => {
    if (hold && e.tool === hold.tool) await hold.until
    return e.tool === 'TaskCreate' ? { result: { task: { id: String(++n), subject: String(e.subject) } } } : { result: { success: true }, text: 'ok' }
  })
}

const create = ($: any, subject: string) => $.tool.call({ tool: 'TaskCreate', subject, description: 'd' })
const update = ($: any, taskId: string, status: string, activeForm?: string) =>
  $.tool.call({ tool: 'TaskUpdate', taskId, status, ...(activeForm ? { activeForm } : {}) })

test('hidden state draws nothing extra', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    expect(await ui.find({ type: 'Progress' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a progress line and a bar appear once tasks exist', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  await create($, 'Ship it')
  await update($, '1', 'in_progress', 'Writing tests')
  await clock.advance(65_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    const line = await ui.find({ type: 'Text', text: /0\/2/ })
    expect(line?.text).toBe('0/2 · Writing tests · 1m')
    // The engine's Progress reaches a test as Box and Text: its label and figure.
    expect(await ui.find({ type: 'Text', text: /^Writing tests 0\/2$/ })).toBeDefined()
    await ui.unmount()
  }

  await update($, '1', 'completed')
  await update($, '2', 'in_progress', 'Shipping')
  await clock.advance(1000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ type: 'Text', text: /1\/2/ }))?.text).toBe('1/2 · Shipping · 1m')
    await ui.unmount()
  }
})

test('a finished list and ended turn shows Done', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Only step')
  await update($, '1', 'completed')
  await clock.advance(120_000)
  await $.turn.complete(done('t1'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ type: 'Text', text: /✓ Done/ }))?.text).toBe('✓ Done · 1/1 · 2m')
    expect(await ui.find({ type: 'Progress' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a question to the user shows the waiting text', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  // The call is held beneath the plugin while the band is drawn.
  let release: () => void = () => {}
  engineBottom(on, { tool: 'AskUserQuestion', until: new Promise<void>((r) => (release = r)) })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Run it')
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.advance(1)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ type: 'Text', text: /Waiting for your answer/ }))?.text).toBe('⏸ Waiting for your answer')
    await ui.unmount()
  }
  release()
  await call
})

test('a survey holds the band: the plugin yields', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  const ui = await $.ui.mount(band('terminal', { hasSurvey: true }))
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

test('/pace off hides the band for this conversation', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('command.register', () => ({ value: { command: 'pace' } }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  await $.command.run({ command: 'pace', args: 'off' } as never)
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

const SPINNER = {
  plugin: 'pace-maker',
  component: 'Spinner',
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
} as never

test('vscode has no band: the spinner suffix carries the compact text', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  // Stands for the engine's own spinner: it draws the word and the suffix it was handed.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: `${e.props.word}${e.props.suffix}` })
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  await create($, 'Ship it')
  await update($, '1', 'in_progress', 'Writing tests')
  await clock.advance(5000)

  const ui = await $.ui.mount({ ...(SPINNER as object), surface: 'vscode' } as never)
  expect((await ui.find({ type: 'Text', text: /Sauteing/ }))?.text).toBe('Sauteing… 0/2 · Writing tests · 5s')
  await ui.unmount()

  // Other surfaces keep the engine's own spinner.
  for (const surface of SURFACES) {
    const other = await $.ui.mount({ ...(SPINNER as object), surface } as never)
    expect((await other.find({ type: 'Text', text: /Sauteing/ }))?.text).toBe('Sauteing…')
    await other.unmount()
  }
})

test('the ticker redraws each second while work shows and stops when idle', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  let redraws = 0
  on('ui.invalidate', () => {
    redraws += 1
    return { value: undefined }
  })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Only step')
  await update($, '1', 'in_progress', 'Working it')
  await clock.advance(3000)
  expect(redraws).toBeGreaterThanOrEqual(3)

  await update($, '1', 'completed')
  await $.turn.complete(done('t1'))
  await clock.advance(1000)
  const settled = redraws
  await clock.advance(10_000)
  expect(redraws).toBe(settled)
})

test('no timer runs while nothing shows', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  let redraws = 0
  on('ui.invalidate', () => {
    redraws += 1
    return { value: undefined }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.command.run({ command: 'pace', args: 'off' } as never)
  await clock.advance(10_000)
  expect(redraws).toBe(0)
})

test('the vscode status line follows the state and is cleared when it ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const lines: (string | undefined)[] = []
  on('session.surfaces', () => ({ value: ['vscode'] }))
  on('ui.status', (_: any, e: any) => {
    lines.push(e.text)
    return { value: undefined }
  })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Only step')
  await update($, '1', 'in_progress', 'Working it')
  await clock.advance(2000)
  expect(lines.at(-1)).toMatch(/^0\/1 · Working it · \ds$/)

  await update($, '1', 'completed')
  await $.turn.complete(done('t1'))
  await clock.advance(1000)
  expect(lines.at(-1)).toBeUndefined()
})

test('terminal and desktop never get a status line: the band is their surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  let statuses = 0
  on('session.surfaces', () => ({ value: ['terminal', 'vscode'] }))
  on('ui.status', () => {
    statuses += 1
    return { value: undefined }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Only step')
  await clock.advance(2000)
  expect(statuses).toBe(0)
})

test('a smooth bar eases for about 300 ms after a step lands, then the fast timer stops', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  let redraws = 0
  on('ui.invalidate', () => {
    redraws += 1
    return { value: undefined }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'One')
  await create($, 'Two')
  await update($, '1', 'in_progress', 'One')
  const ui = await $.ui.mount(band('terminal'))

  redraws = 0
  await update($, '1', 'completed')
  await update($, '2', 'in_progress', 'Two')
  await clock.advance(200)
  expect(redraws).toBeGreaterThanOrEqual(2)
  await clock.advance(400)
  const settled = redraws
  await clock.advance(300)
  expect(redraws).toBe(settled)
  await ui.unmount()
})
