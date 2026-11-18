import { test, expect, mock } from 'claude-code/testing'
import { drawn } from './kit'

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

test('the manifest defaults draw blocks, 20 cells, the count, the label and the time', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await twoTasks($)
  await clock.advance(1000)
  const text = await drawn($)
  expect(text).toMatch(/^▶ Progress [█░]{20} {2}1\/2 · Doing two · 1s$/)
})

test('options pick the bar style, its width and the fields', { options: { barStyle: 'dots', barWidth: 10, showPercent: true, showLabel: false, showElapsed: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await twoTasks($)
  await clock.advance(1000)
  expect(await drawn($)).toMatch(/^▶ Progress ●{5}○{5} {2}1\/2 · 50%$/)
})

// The engine checks options against userConfig itself: a picker value outside its list reads as the default (the module
// still loads); a value of the wrong type or range stops the module loading, so normalizeSettings is the second line.
test('a barStyle outside the list reads as the default', { options: { barStyle: 'native', showPercent: true } as never }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await twoTasks($)
  await clock.advance(1000)
  expect(await drawn($)).toMatch(/^▶ Progress [█░]{20} {2}1\/2 · 50% · Doing two · 1s$/)
})
