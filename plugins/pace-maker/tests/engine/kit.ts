import type { On } from 'claude-code'

/** Records what the plugin writes to $.state, by key, as the plain value (the shape tag removed). */
export function watchState(on: On) {
  const writes: { key: string; value: any }[] = []
  on('state.set', (_, e, next) => {
    writes.push({ key: e.key, value: (e.value as { value: unknown }).value })
    return next(e)
  })
  return {
    writes,
    last: (key: string): any => [...writes].reverse().find((w) => w.key === key)?.value,
    count: (key: string) => writes.filter((w) => w.key === key).length,
  }
}

export type Surface = 'terminal' | 'desktop' | 'vscode'
export const SURFACES: readonly Surface[] = ['terminal', 'desktop', 'vscode']

/** An AbovePrompt render event for this plugin on one surface. */
export const band = (surface: Surface = 'terminal', extra: Record<string, unknown> = {}) =>
  ({
    plugin: 'pace-maker',
    surface,
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 11 }, ...extra },
  }) as never

export type Look = {
  /** Row 1 as drawn: the state text, then the tail after two spaces; undefined when the plugin drew nothing. */
  row: string | undefined
  left: string | undefined
  tail: string | undefined
  /** The props of the state run in row 1 (colour, bold), the runs of the left part, and the props of the Text that truncates. */
  leftProps: Record<string, any> | undefined
  leftRuns: { text: string; props: Record<string, any> }[]
  outerProps: Record<string, any> | undefined
  /** The hand-drawn glyph bar, joined (the fallback), or '' when there is none. */
  glyphs: string
  raster: Record<string, any> | undefined
  svg: Record<string, any> | undefined
  /** The outer Box (the column of the two rows) and row 1's Box (the one that spreads left and tail). */
  outer: Record<string, any> | undefined
  rowBox: Record<string, any> | undefined
}

/** Mounts the band once and reads what it drew. */
export async function look($: any, surface: Surface = 'terminal', extra: Record<string, unknown> = {}): Promise<Look> {
  const ui = await $.ui.mount(band(surface, extra))
  const texts = await ui.findAll({ type: 'Text' })
  const boxes = await ui.findAll({ type: 'Box' })
  const raster = (await ui.find({ type: 'Raster' }))?.props
  const svg = (await ui.find({ type: 'Svg' }))?.props
  await ui.unmount()
  // Row 1 is an outer Text that truncates (holding the styled state run and the dim step run), then the tail Text.
  const outers = texts.filter((t: any) => t.props.wrap === 'truncate-end')
  const first = texts.indexOf(outers[0])
  const left = outers[0]?.text as string | undefined
  const nested: any[] = []
  let joined = ''
  for (let i = first + 1; left !== undefined && i < texts.length && joined !== left; i += 1) {
    if (!left.startsWith(joined + texts[i].text)) break
    joined += texts[i].text
    nested.push(texts[i])
  }
  const tail = outers[1]?.text as string | undefined
  const glyphTexts = texts.filter((t: any) => !outers.includes(t) && !nested.includes(t))
  return {
    row: left === undefined ? undefined : tail === undefined ? left : `${left}  ${tail}`,
    left,
    tail,
    leftProps: nested[0]?.props,
    leftRuns: nested.map((t: any) => ({ text: t.text, props: t.props })),
    outerProps: outers[0]?.props,
    glyphs: glyphTexts.map((t: any) => t.text).join(''),
    raster,
    svg,
    outer: boxes.find((b: any) => b.props.flexDirection === 'column')?.props,
    rowBox: boxes.find((b: any) => b.props.justifyContent === 'space-between')?.props,
  }
}

/** Row 1 as one string, or undefined when the plugin drew nothing. */
export async function drawn($: any, surface: Surface = 'terminal'): Promise<string | undefined> {
  return (await look($, surface)).row
}
