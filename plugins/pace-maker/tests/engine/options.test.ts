import { test, expect, mock } from 'claude-code/testing'
import { drawn, look } from './kit'

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

test('the manifest defaults draw the smooth bar, the count, the label and the time', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await twoTasks($)
  await clock.advance(1000)
  expect(await drawn($)).toBe('▶ Progress · Doing two  1/2 · 1s')
  expect((await look($)).raster).toMatchObject({ columns: 80, rows: 1 })
  expect((await look($, 'desktop')).svg?.source).toMatch(/^<svg /)
})

test('options pick the bar style and the fields', { options: { barStyle: 'dots', showPercent: true, showLabel: false, showElapsed: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await twoTasks($)
  await clock.advance(1000)
  const v = await look($)
  expect(v.row).toBe('▶ Progress  1/2 · 50%')
  expect(v.glyphs).toBe(`${'●'.repeat(30)}${'○'.repeat(30)}`)
  expect(v.raster).toBeUndefined()
})

// The engine checks options against userConfig itself: a picker value outside its list reads as the default (the module
// still loads); a value of the wrong type or range stops the module loading, so normalizeSettings is the second line.
test('a barStyle outside the list reads as the default', { options: { barStyle: 'native', showPercent: true } as never }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await twoTasks($)
  await clock.advance(1000)
  const v = await look($)
  expect(v.row).toBe('▶ Progress · Doing two  1/2 · 50% · 1s')
  expect(v.raster?.rows).toBe(1)
})
