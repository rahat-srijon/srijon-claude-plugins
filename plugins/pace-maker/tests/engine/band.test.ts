import { test, expect, mock } from 'claude-code/testing'
import { SURFACES, band, drawn, look, watchState } from './kit'
import { PALETTE, TRACK, unpackCells } from '../../hooks/lib/bar.ts'

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
const bash = ($: any, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', command: 'ls', ...extra } as never)

/** Five tasks, three of them done and the fourth running. */
async function threeOfFive($: any) {
  for (const s of ['One', 'Two', 'Three', 'Four', 'Five']) await create($, s)
  for (const id of ['1', '2', '3']) await update($, id, 'completed')
  await update($, '4', 'in_progress', 'Running tests')
}

/** Counts the redraws and the blits the plugin asks for. */
function watchDraws(on: any) {
  const n = { redraws: 0, blits: [] as any[] }
  on('ui.invalidate', () => {
    n.redraws += 1
    return { value: undefined }
  })
  on('ui.blit', (_: any, e: any) => {
    n.blits.push(e)
    return { value: {} }
  })
  return n
}

/** The Raster's cells as [code point, fg, bg]. */
const cellsOf = (raster: any) => unpackCells(raster.cells)
const litCount = (raster: any) => cellsOf(raster).filter((c) => !(c[1] === TRACK && c[2] === TRACK)).length

test('hidden state draws nothing extra', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.unmount()
  }
})

test('two rows on every surface: one line of text that never wraps, then the bar', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await threeOfFive($)
  await clock.advance(65_000)
  for (const surface of SURFACES) {
    const v = await look($, surface)
    expect(v.outer?.flexDirection).toBe('column')
    // Row 1: the left text and the tail spread to both edges, and both truncate instead of wrapping.
    expect(v.rowBox?.flexDirection).toBe('row')
    expect(v.rowBox?.flexWrap).toBeUndefined()
    expect(v.left).toBe('▶ Progress · Running tests')
    expect(v.tail).toBe('3/5 · 1m')
    expect(v.outerProps?.wrap).toBe('truncate-end')
    expect(v.leftProps).toMatchObject({ color: 'suggestion', bold: true })
    // The step reads dim, after the state.
    expect(v.leftRuns.map((r) => r.text)).toEqual(['▶ Progress', ' · Running tests'])
    expect(v.leftRuns[1]?.props.dimColor).toBe(true)
    expect(v.row).not.toMatch(/[\r\n]/)
    // Row 2: the bar, not glyph text.
    expect(v.glyphs).toBe('')
    expect(v.raster !== undefined || v.svg !== undefined).toBe(true)
  }
})

test('the terminal draws a Raster one row tall and as wide as the band; desktop and vscode draw an Svg', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await threeOfFive($)
  await clock.advance(1000)
  const t = await look($, 'terminal', { bodyColumns: 100 })
  expect(t.svg).toBeUndefined()
  expect(t.raster).toMatchObject({ key: 'pace-bar', columns: 100, rows: 1 })
  const cells = cellsOf(t.raster)
  expect(cells).toHaveLength(100)
  // 3 of 5 done: the first 60 cells are filled, the rest is the dim track.
  expect(cells.slice(0, 60).every((c) => c[1] !== TRACK)).toBe(true)
  expect(cells.slice(60).every((c) => c[1] === TRACK && c[2] === TRACK)).toBe(true)
  expect(await look($, 'terminal', { bodyColumns: 40 }).then((v) => v.raster?.columns)).toBe(40)
  for (const surface of ['desktop', 'vscode'] as const) {
    const v = await look($, surface)
    expect(v.raster).toBeUndefined()
    expect(v.svg?.source).toMatch(/^<svg [^>]*viewBox="0 0 960 8"/)
    expect(v.svg?.source).toContain('url(#pm-fill)')
    expect(v.svg?.alt).toBe('Progress, 60%')
    expect(v.svg?.isInteractive).toBe(true)
  }
})

test('a turn with no task list shows Working and a sliding bar on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(5000)
  for (const surface of SURFACES) {
    const v = await look($, surface)
    expect(v.row).toBe('● Working  5s')
    expect(v.leftProps?.color).toBe('suggestion')
    if (surface === 'terminal') {
      // A short soft segment on the track, never a fraction.
      const n = litCount(v.raster)
      expect(n).toBeGreaterThanOrEqual(6)
      expect(n).toBeLessThanOrEqual(16)
    } else {
      expect(v.svg?.source).toContain('<animate attributeName="x"')
      expect(v.svg?.alt).toBe('Working')
    }
  }
})

test('the sliding segment moves one cell per 100 ms on the terminal, by blit, with no redraw', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const seen = watchDraws(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await look($) // the band is on screen: the plugin learns the Raster's size and address
  seen.blits.length = 0
  seen.redraws = 0
  await clock.advance(500)
  expect(seen.blits).toHaveLength(5)
  expect(seen.redraws).toBe(0)
  for (const b of seen.blits) expect(b).toMatchObject({ requestId: 'band', key: 'pace-bar', columns: 80, rows: 1 })
  const first = (b: any) => cellsOf(b).findIndex((c) => !(c[1] === TRACK && c[2] === TRACK))
  const starts = seen.blits.map((b) => first(b))
  expect(new Set(starts).size).toBe(5)
  expect(starts[1]! - starts[0]!).toBe(1)
  expect(starts[2]! - starts[1]!).toBe(1)
  // The text row still advances once a second.
  await clock.advance(1000)
  expect(seen.redraws).toBe(1)
})

test('desktop and vscode need no repaint: the ticker only redraws once a second for the elapsed time', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const seen = watchDraws(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await look($, 'desktop')
  seen.redraws = 0
  await clock.advance(3000)
  expect(seen.blits).toHaveLength(0)
  expect(seen.redraws).toBe(3)
  expect(await drawn($, 'desktop')).toBe('● Working  3s')
  await clock.advance(1000)
  expect(await drawn($, 'vscode')).toBe('● Working  4s')
})

test('a determinate fill eases toward its new value in about 300 ms', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const seen = watchDraws(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await threeOfFive($)
  await look($)
  await clock.advance(1000)
  seen.blits.length = 0
  await update($, '4', 'completed')
  await update($, '5', 'in_progress', 'Shipping')
  // At once the drawing still shows the old fill; the new target is 4 of 5.
  const start = await look($)
  expect(litCount(start.raster)).toBeLessThan(64)
  expect(litCount(start.raster)).toBeGreaterThanOrEqual(48)
  await clock.advance(400)
  expect(seen.blits.length).toBeGreaterThanOrEqual(3)
  const counts = seen.blits.map((b) => litCount(b))
  for (let i = 1; i < counts.length; i += 1) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!)
  expect(counts[counts.length - 1]).toBe(64)
  expect(litCount((await look($)).raster)).toBe(64)
  // Settled: the blits stop (the slow once-a-second redraw is all that is left while the turn runs).
  await clock.advance(1000)
  const after = seen.blits.length
  await clock.advance(1000)
  expect(seen.blits.length).toBe(after)
})

test('a task list shows Progress with a count, the step and a determinate bar on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await threeOfFive($)
  await clock.advance(65_000)
  for (const surface of SURFACES) expect(await drawn($, surface)).toBe('▶ Progress · Running tests  3/5 · 1m')
})

test('Done: a full bar and the result, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Only step')
  await update($, '1', 'completed')
  await clock.advance(120_000)
  await $.turn.complete(done('t1'))
  for (const surface of SURFACES) {
    const v = await look($, surface)
    expect(v.row).toBe('✓ Done  1/1 · 2m')
    expect(v.leftProps?.color).toBe('success')
    if (surface === 'terminal') expect(litCount(v.raster)).toBe(80)
    else expect(v.svg?.source).toContain(`<rect width="960" height="8" rx="4" fill="url(#pm-fill)"`)
  }
})

test('Done stays after a turn that ran a tool and kept no list, until the next turn starts', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await bash($)
  await clock.advance(40_000)
  await $.turn.complete(done('t1'))
  await clock.advance(60_000)
  for (const surface of SURFACES) {
    const v = await look($, surface)
    expect(v.left).toBe('✓ Done · 40s')
    expect(v.tail).toBeUndefined()
    expect(v.leftProps?.color).toBe('success')
    if (surface === 'terminal') expect(litCount(v.raster)).toBe(80)
    else expect(v.svg?.alt).toBe('Done · 40s, 100%')
  }
  // The next turn replaces it.
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(await drawn($)).toMatch(/^● Working/)
})

test('a tool call by a subagent does not count as work', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await bash($, { agentId: 'sub1' })
  await clock.advance(2000)
  await $.turn.complete(done('t1'))
  for (const surface of SURFACES) expect(await drawn($, surface)).toBeUndefined()
})

test('a quick reply with no tool call leaves the band hidden, even after an earlier Done', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(2000)
  await $.turn.complete(done('t1', { answer: 'Hello there.' }))
  for (const surface of SURFACES) expect(await drawn($, surface)).toBeUndefined()
  // A long working turn does leave a result; the next quick reply takes it away again.
  await $.turn.start({ text: 'work', turnId: 't2' })
  await bash($)
  await clock.advance(20_000)
  await $.turn.complete(done('t2'))
  expect(await drawn($)).toBe('✓ Done · 20s')
  await $.turn.start({ text: 'thanks', turnId: 't3' })
  await clock.advance(1000)
  await $.turn.complete(done('t3', { answer: 'You are welcome.' }))
  expect(await drawn($)).toBeUndefined()
})

test('a turn of 8 seconds or more with no tool call is work too', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'think', turnId: 't1' })
  await clock.advance(9000)
  await $.turn.complete(done('t1'))
  expect(await drawn($)).toBe('✓ Done · 9s')
})

test('a plain-text question with no task list shows Waiting for your answer on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1000)
  await $.turn.complete(done('t1', { answer: 'I can do either. Which one do you prefer?' }))
  for (const surface of SURFACES) {
    const v = await look($, surface)
    expect(v.left).toBe('⏸ Waiting for your answer')
    expect(v.leftProps?.color).toBe('warning')
    expect(v.raster !== undefined || v.svg !== undefined).toBe(true)
  }
})

test('a permission wait mid-turn with no list keeps a still segment, and the amber text', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('tool.check', () => ({ decision: 'ask' }))
  const seen = watchDraws(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1', approver: 'person' })
  await clock.advance(1000)
  const a = await look($)
  expect(a.left).toBe('⏸ Waiting for permission: Bash')
  expect(a.leftProps?.color).toBe('warning')
  await clock.advance(2000)
  const b = await look($)
  expect(b.raster?.cells).toBe(a.raster?.cells)
  // Held still: nothing is painted between the once-a-second redraws.
  expect(seen.blits).toHaveLength(0)
  const svg = await look($, 'desktop')
  expect(svg.svg?.source).not.toContain('<animate')
})

test('a permission wait mid-turn with a list shows the determinate bar', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  // A stand-in for the engine asking a person, switched on once the list is built.
  let ask = false
  on('tool.check', () => ({ decision: ask ? 'ask' : 'allow' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await threeOfFive($)
  ask = true
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1', approver: 'person' })
  await clock.advance(1000)
  for (const surface of SURFACES) expect(await drawn($, surface)).toBe('⏸ Waiting for permission: Bash  3/5')
  expect(litCount((await look($)).raster)).toBe(48)
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
  for (const surface of SURFACES) expect(await drawn($, surface)).toBe('⏸ Waiting for your answer  0/1')
  release()
  await call
})

test('a stopped list keeps its bar once the turn has ended', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await threeOfFive($)
  await $.turn.complete(done('t1', { answer: 'Finished the first part.' }))
  await clock.advance(1000)
  for (const surface of SURFACES) expect(await drawn($, surface)).toBe('○ Stopped · 2 of 5 steps left  3/5')
  expect(litCount((await look($)).raster)).toBe(48)
})

test('/pace pause shows the blue paused row', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('command.register', () => ({ value: { command: 'pace' } }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.command.run({ command: 'pace', args: 'pause lunch' } as never)
  await clock.advance(500)
  const v = await look($, 'vscode')
  expect(v.left).toBe('⏸ Paused · lunch')
  expect(v.leftProps?.color).toBe('planMode')
  expect(v.svg?.source).toContain(PALETTE.paused.to.toString(16))
})

test('a survey holds the band: the plugin yields', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface, { hasSurvey: true }))
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    await ui.unmount()
  }
})

test('/pace off hides the band for this conversation, a finished one too', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('command.register', () => ({ value: { command: 'pace' } }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  expect(await drawn($)).toMatch(/Progress/)
  await $.command.run({ command: 'pace', args: 'off' } as never)
  for (const surface of SURFACES) expect(await drawn($, surface)).toBeUndefined()
  await $.command.run({ command: 'pace', args: 'on' } as never)
  expect(await drawn($)).toMatch(/Progress/)
  // A result left on screen goes too.
  await update($, '1', 'completed')
  await clock.advance(1000)
  await $.turn.complete(done('t1'))
  expect(await drawn($)).toMatch(/Done/)
  await $.command.run({ command: 'pace', args: 'off' } as never)
  for (const surface of SURFACES) expect(await drawn($, surface)).toBeUndefined()
})

test('enabled: false hides the band on every surface and runs no timer', { options: { enabled: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const seen = watchDraws(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  await bash($)
  await clock.advance(10_000)
  await $.turn.complete(done('t1'))
  for (const surface of SURFACES) expect(await drawn($, surface)).toBeUndefined()
  expect(seen.redraws).toBe(0)
  expect(seen.blits).toHaveLength(0)
})

test('timers run only while a turn does: they stop when it ends, and never start while idle', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const seen = watchDraws(on)
  await clock.advance(10_000)
  expect(seen.redraws + seen.blits.length).toBe(0)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await look($)
  seen.redraws = 0
  seen.blits.length = 0
  await clock.advance(1000)
  expect(seen.blits).toHaveLength(10)
  expect(seen.redraws).toBe(1)

  await bash($)
  await $.turn.complete(done('t1'))
  await clock.advance(1000)
  const settled = seen.redraws + seen.blits.length
  await clock.advance(10_000)
  expect(seen.redraws + seen.blits.length).toBe(settled)
})

test('never more than ten redraws or blits in any second', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const seen = watchDraws(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await look($)
  for (let s = 0; s < 3; s += 1) {
    seen.redraws = 0
    seen.blits.length = 0
    await clock.advance(1000)
    expect(seen.redraws).toBeLessThanOrEqual(10)
    expect(seen.blits.length).toBeLessThanOrEqual(10)
  }
})

test('a denied blit falls back to a redraw instead of freezing the bar', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  let redraws = 0
  on('ui.invalidate', () => {
    redraws += 1
    return { value: undefined }
  })
  on('ui.blit', () => ({ value: { deny: 'not mounted' } }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await look($)
  redraws = 0
  await clock.advance(1000)
  expect(redraws).toBeGreaterThanOrEqual(10)
  expect(redraws).toBeLessThanOrEqual(11)
})

test('a glyph bar style draws the Text bar on every surface, as wide as the band allows', { options: { barStyle: 'dots' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await threeOfFive($)
  await clock.advance(1000)
  for (const surface of SURFACES) {
    const v = await look($, surface)
    expect(v.raster).toBeUndefined()
    expect(v.svg).toBeUndefined()
    expect(v.left).toBe('▶ Progress · Running tests')
    expect(v.glyphs).toBe(`${'●'.repeat(36)}${'○'.repeat(24)}`)
  }
  // A narrow band gets a shorter bar.
  expect((await look($, 'terminal', { bodyColumns: 30 })).glyphs).toBe(`${'●'.repeat(17)}${'○'.repeat(11)}`)
})

test('the render hook never writes state', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const state = watchState(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await threeOfFive($)
  await clock.advance(1000)
  const before = state.writes.length
  for (const surface of SURFACES) await look($, surface)
  await clock.advance(3000)
  expect(state.writes.length).toBe(before)
})
