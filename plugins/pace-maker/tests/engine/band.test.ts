import { test, expect, mock } from 'claude-code/testing'
import { SURFACES, band, cellsOf, drawn, trackOf } from './kit'

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

/** Five tasks, three of them done and the fourth running. */
async function threeOfFive($: any) {
  for (const s of ['One', 'Two', 'Three', 'Four', 'Five']) await create($, s)
  for (const id of ['1', '2', '3']) await update($, id, 'completed')
  await update($, '4', 'in_progress', 'Running tests')
}

const countRedraws = (on: any) => {
  const n = { redraws: 0 }
  on('ui.invalidate', () => {
    n.redraws += 1
    return { value: undefined }
  })
  return n
}

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

test('a turn with no task list shows Working and a sliding bar on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(5000)
  for (const surface of SURFACES) {
    const row = await drawn($, surface)
    expect(row).toMatch(/^● Working [█░]{20}  5s$/)
    // A short segment, never a fraction: about a fifth of the track.
    expect(cellsOf(row)).toEqual({ used: 4, rest: 16 })
  }
  const ui = await $.ui.mount(band('terminal'))
  expect((await ui.find({ type: 'Text', text: /Working/ }))?.props.color).toBe('suggestion')
  await ui.unmount()
})

test('the sliding segment moves one cell per 250 ms tick and keeps its length', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const seen: string[] = []
  for (let i = 0; i < 6; i += 1) {
    seen.push(trackOf(await drawn($)))
    await clock.advance(250)
  }
  expect(new Set(seen).size).toBe(6)
  for (const t of seen) expect(cellsOf(t)).toEqual({ used: 4, rest: 16 })
  // The segment starts one cell further along each time.
  const start = (t: string) => t.indexOf('█')
  expect(start(seen[1]!) - start(seen[0]!)).toBe(1)
  expect(start(seen[2]!) - start(seen[1]!)).toBe(1)
})

test('a task list shows Progress with a count and a determinate bar on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await threeOfFive($)
  await clock.advance(65_000)
  for (const surface of SURFACES) {
    const row = await drawn($, surface)
    expect(row).toBe(`▶ Progress ${'█'.repeat(12)}${'░'.repeat(8)}  3/5 · Running tests · 1m`)
  }
  await update($, '4', 'completed')
  await update($, '5', 'in_progress', 'Shipping')
  expect(await drawn($)).toMatch(/^▶ Progress █{16}░{4} {2}4\/5 · Shipping · 1m$/)
  // The bar stands still between steps: the same drawing a moment later.
  const before = await drawn($)
  await clock.advance(250)
  expect(trackOf(await drawn($))).toBe(trackOf(before))
})

test('Done shows a full bar on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Only step')
  await update($, '1', 'completed')
  await clock.advance(120_000)
  await $.turn.complete(done('t1'))
  for (const surface of SURFACES) {
    expect(await drawn($, surface)).toBe(`✓ Done ${'█'.repeat(20)}  1/1 · 2m`)
  }
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /Done/ }))?.props.color).toBe('success')
  await ui.unmount()
})

test('a permission wait mid-turn with no list keeps a frozen bar', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1', approver: 'person' })
  await clock.advance(1000)
  const frozen = `${'░'.repeat(8)}${'█'.repeat(4)}${'░'.repeat(8)}`
  for (const surface of SURFACES) {
    expect(await drawn($, surface)).toBe(`⏸ Waiting for permission: Bash ${frozen}`)
  }
  // Frozen: the same cells a few ticks later.
  await clock.advance(2000)
  expect(trackOf(await drawn($))).toBe(frozen)
  const ui = await $.ui.mount(band('terminal'))
  expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.props.color).toBe('warning')
  await ui.unmount()
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
  for (const surface of SURFACES) {
    expect(await drawn($, surface)).toBe(`⏸ Waiting for permission: Bash ${'█'.repeat(12)}${'░'.repeat(8)}  3/5`)
  }
})

test('a question to the user shows the waiting text with its bar', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  // The call is held beneath the plugin while the band is drawn.
  let release: () => void = () => {}
  engineBottom(on, { tool: 'AskUserQuestion', until: new Promise<void>((r) => (release = r)) })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Run it')
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.advance(1)
  for (const surface of SURFACES) {
    const row = await drawn($, surface)
    expect(row).toMatch(/^⏸ Waiting for your answer [█░]{20} {2}0\/1$/)
  }
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
  for (const surface of SURFACES) {
    expect(await drawn($, surface)).toBe(`○ Stopped · 2 of 5 steps left ${'█'.repeat(12)}${'░'.repeat(8)}  3/5`)
  }
})

test('/pace pause shows the blue paused row', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('command.register', () => ({ value: { command: 'pace' } }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.command.run({ command: 'pace', args: 'pause lunch' } as never)
  await clock.advance(500)
  const ui = await $.ui.mount(band('vscode'))
  const state = await ui.find({ type: 'Text', text: /Paused/ })
  expect(state?.text).toBe('⏸ Paused · lunch ')
  expect(state?.props.color).toBe('planMode')
  await ui.unmount()
  expect(cellsOf(await drawn($))).toEqual({ used: 4, rest: 16 })
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

test('/pace off hides the band for this conversation', async ($, on) => {
  mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('command.register', () => ({ value: { command: 'pace' } }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  expect(await drawn($)).toMatch(/Progress/)
  await $.command.run({ command: 'pace', args: 'off' } as never)
  for (const surface of SURFACES) expect(await drawn($, surface)).toBeUndefined()
  await $.command.run({ command: 'pace', args: 'on' } as never)
  expect(await drawn($)).toMatch(/Progress/)
})

test('enabled: false hides the band on every surface and runs no timer', { options: { enabled: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const seen = countRedraws(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Write tests')
  await clock.advance(10_000)
  for (const surface of SURFACES) expect(await drawn($, surface)).toBeUndefined()
  expect(seen.redraws).toBe(0)
})

test('the ticker redraws every 250 ms while a turn runs and stops when it ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  const seen = countRedraws(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'Only step')
  await update($, '1', 'in_progress', 'Working it')
  seen.redraws = 0
  await clock.advance(1000)
  expect(seen.redraws).toBe(4)

  await update($, '1', 'completed')
  await $.turn.complete(done('t1'))
  await clock.advance(1000)
  const settled = seen.redraws
  await clock.advance(10_000)
  expect(seen.redraws).toBe(settled)
})

test('the ticker keeps going through a mid-turn permission wait and stops on an idle stop', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('tool.check', () => ({ decision: 'ask' }))
  const seen = countRedraws(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1', approver: 'person' })
  seen.redraws = 0
  await clock.advance(1000)
  expect(seen.redraws).toBe(4)

  await $.turn.complete(done('t1'))
  await clock.advance(500)
  const settled = seen.redraws
  await clock.advance(10_000)
  expect(seen.redraws).toBe(settled)
})

test('no timer runs while nothing shows', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  on('command.register', () => ({ value: { command: 'pace' } }))
  const seen = countRedraws(on)
  await clock.advance(10_000)
  expect(seen.redraws).toBe(0)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.command.run({ command: 'pace', args: 'off' } as never)
  seen.redraws = 0
  await clock.advance(10_000)
  expect(seen.redraws).toBe(0)
})

test('the band is drawn from Box and Text only: no Progress, Spinner or status line', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  engineBottom(on)
  let statuses = 0
  on('ui.status', () => {
    statuses += 1
    return { value: undefined }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await create($, 'One')
  await clock.advance(1000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Progress' })).toBeUndefined()
    expect((await ui.find({ type: 'Box' }))?.props.flexWrap).toBe('wrap')
    await ui.unmount()
  }
  expect(statuses).toBe(0)
})
