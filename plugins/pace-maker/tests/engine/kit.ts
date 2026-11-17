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
