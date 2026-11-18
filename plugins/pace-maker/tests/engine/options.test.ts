import { test, expect, mock } from 'claude-code/testing'

const band = {
  plugin: 'pace-maker',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 11 } },
} as never

const SPINNER = {
  plugin: 'pace-maker',
  surface: 'vscode',
  component: 'Spinner',
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
} as never

function engineBottom(on: any) {
  let n = 0
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_: any, e: any) =>
    e.tool === 'TaskCreate' ? { result: { task: { id: String(++n), subject: String(e.subject) } } } : { result: { success: true }, text: 'ok' },
  )
}

async function twoTasks($: any) {
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'One', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Two', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Doing two' })
}

const drawn = async ($: any) => {
  const ui = await $.ui.mount(band)
  const found = await ui.find({ type: 'Text' })
  await ui.unmount()
  return found?.text as string | undefined
}

test('the manifest defaults draw blocks, 20 cells, the count and the label', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await twoTasks($)
  await clock.advance(1000)
  const text = await drawn($)
  expect(text).toMatch(/^[█░]{20} 1\/2 · Doing two · 1s$/)
})

test('options pick the bar style, its width and the fields', { options: { barStyle: 'dots', barWidth: 10, showPercent: true, showLabel: false, showElapsed: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await twoTasks($)
  await clock.advance(1000)
  expect(await drawn($)).toMatch(/^[●○]{10} 1\/2 · 50%$/)
})

// The engine checks options against userConfig itself: a picker value outside its list reads as the default (the module
// still loads); a value of the wrong type or range stops the module loading, so normalizeSettings is the second line.
test('a barStyle outside the list reads as the default', { options: { barStyle: 'native', showPercent: true } as never }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await twoTasks($)
  await clock.advance(1000)
  expect(await drawn($)).toMatch(/^[█░]{20} 1\/2 · 50% · Doing two · 1s$/)
})

test('enabled: false hides the band, the spinner text, the status line and the ticker', { options: { enabled: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  let statuses = 0
  let redraws = 0
  on('session.surfaces', () => ({ value: ['vscode'] }))
  on('ui.status', () => {
    statuses += 1
    return { value: undefined }
  })
  on('ui.invalidate', () => {
    redraws += 1
    return { value: undefined }
  })
  on('ui.render', ($: any, e: any, next: any) => {
    if (e.component !== 'Spinner') return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ children: `${e.props.word}${e.props.suffix}` })
  })
  await twoTasks($)
  await clock.advance(5000)
  expect(await drawn($)).toBeUndefined()
  const ui = await $.ui.mount(SPINNER)
  expect((await ui.find({ type: 'Text', text: /Sauteing/ }))?.text).toBe('Sauteing…')
  await ui.unmount()
  expect(statuses).toBe(0)
  expect(redraws).toBe(0)
})

test('enabled: true (the default) shows the vscode spinner text', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: `${e.props.word}${e.props.suffix}` })
  })
  await twoTasks($)
  await clock.advance(1000)
  const ui = await $.ui.mount(SPINNER)
  expect((await ui.find({ type: 'Text', text: /Sauteing/ }))?.text).toBe('Sauteing… 1/2 · Doing two · 1s')
  await ui.unmount()
})
