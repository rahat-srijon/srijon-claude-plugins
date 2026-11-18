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
    props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 11 }, ...extra },
  }) as never

/** The whole band row as one string (every Text joined), or undefined when the plugin drew nothing. */
export async function drawn($: any, surface: Surface = 'terminal'): Promise<string | undefined> {
  const ui = await $.ui.mount(band(surface))
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.length === 0 ? undefined : texts.map((t: { text: string }) => t.text).join('')
}

/** How many cells of a drawn row are used and rest, counted from the `blocks` glyphs. */
export const cellsOf = (row: string | undefined) => ({
  used: (row?.match(/█/g) ?? []).length,
  rest: (row?.match(/░/g) ?? []).length,
})

/** The bar cells of a drawn `blocks` row, in track order. */
export const trackOf = (row: string | undefined): string => row?.match(/[█░]+/g)?.join('') ?? ''
