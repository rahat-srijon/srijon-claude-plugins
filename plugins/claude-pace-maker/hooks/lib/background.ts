// Background work tracking: shells, subagents and monitors that keep running outside the main turn.
// JSON-serializable; the reducer returns a new value and ignores duplicates and unknown ids.

export type BackgroundKind = 'shell' | 'agent' | 'monitor';
export type BackgroundItem = { id: string; kind: BackgroundKind; label: string };
export type Background = { shape: 'bg-1'; items: BackgroundItem[] };

export type BackgroundEvent =
  | { kind: 'started'; id: string; itemKind: BackgroundKind; label: string }
  | { kind: 'ended'; id: string }
  | { kind: 'sessionEnded' };

/** No background work. */
export function emptyBackground(): Background {
  return { shape: 'bg-1', items: [] };
}

/** Applies one event and returns a new value; duplicates, unknown ids and unknown events change nothing. */
export function applyBackgroundEvent(bg: Background, event: BackgroundEvent): Background {
  switch (event?.kind) {
    case 'started':
      if (bg.items.some((i) => i.id === event.id)) return { ...bg, items: [...bg.items] };
      return { ...bg, items: [...bg.items, { id: event.id, kind: event.itemKind, label: event.label }] };
    case 'ended':
      return { ...bg, items: bg.items.filter((i) => i.id !== event.id) };
    case 'sessionEnded':
      return { ...bg, items: [] };
    default:
      return { ...bg, items: [...bg.items] };
  }
}

/** Counts per kind plus the newest item's label. */
export function backgroundSummary(bg: Background): {
  shells: number;
  agents: number;
  monitors: number;
  total: number;
  label?: string;
} {
  const count = (k: BackgroundKind): number => bg.items.filter((i) => i.kind === k).length;
  const out: { shells: number; agents: number; monitors: number; total: number; label?: string } = {
    shells: count('shell'),
    agents: count('agent'),
    monitors: count('monitor'),
    total: bg.items.length,
  };
  const newest = bg.items[bg.items.length - 1];
  if (newest) out.label = newest.label;
  return out;
}
