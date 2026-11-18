// Turns a View into the plain data one band row is drawn from: an icon, a state text, a theme token, an optional bar and a tail.
// Pure and JSX-free. Tones are theme tokens only (never a raw color). The bar is drawn from glyphs, not a native element.

import type { View } from './view.ts';
import type { BarStyle, Settings } from './settings.ts';

/** A run of bar cells drawn in one colour: the tone (`used`) or the dim track. */
export type BarPart = { text: string; used: boolean };

export type Bar = {
  style: BarStyle;
  /** The filled cells, joined. */
  used: string;
  /** The empty cells, joined. */
  rest: string;
  /** determinate: `used` is the finished share; sliding: a short segment that never implies a fraction. */
  mode: 'determinate' | 'sliding';
  /** False for a sliding bar held at a fixed position (a turn is waiting or paused with no list). */
  moving: boolean;
  /** The ends of the track ('[' and ']' for ascii, empty otherwise), drawn dim. */
  open: string;
  close: string;
  /** The cells in track order as runs, so a sliding segment that wraps round the end is two used runs. */
  parts: BarPart[];
};

export type Formatted = {
  kind: View['kind'];
  /** The state's glyph. */
  icon: string;
  /** A theme token such as 'warning'. */
  tone: string;
  /** The state text, without the icon: `Progress`, `Working`, `Waiting for permission: Bash`. */
  text: string;
  bar: Bar | null;
  /** The trailing details per the show* settings, joined with ` · `; empty when there are none. */
  tail: string;
};

const TONES = {
  progress: 'suggestion',
  working: 'suggestion',
  done: 'success',
  waiting: 'warning',
  blocked: 'error',
  paused: 'planMode',
  stopped: 'subtle',
} as const;

const GLYPHS: Record<BarStyle, { used: string; rest: string; open: string; close: string }> = {
  blocks: { used: '█', rest: '░', open: '', close: '' },
  thin: { used: '▬', rest: '─', open: '', close: '' },
  dots: { used: '●', rest: '○', open: '', close: '' },
  ascii: { used: '#', rest: '-', open: '[', close: ']' },
};

const SEP = ' · ';
const DETAIL_MAX = 80;

/** Collapses whitespace so a reason or label can never break the line, and cuts it to a sane length. */
export function oneLine(s: string, max: number = DETAIL_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** `45s`, `12m`, `1h 05m`. Negative, NaN and infinite values read as 0s. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return `${h}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** A reset time as local HH:MM, or undefined when it cannot be read (or is already past, when `now` is given). */
export function formatResetTime(resetsAt: string | undefined, now?: number): string | undefined {
  if (resetsAt === undefined) return undefined;
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return undefined;
  if (now !== undefined && t <= now) return undefined;
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const stepsWord = (n: number): string => (n === 1 ? 'step' : 'steps');
const agentsWord = (n: number): string => (n === 1 ? 'subagent' : 'subagents');

const trackWidth = (width: number): number => (Number.isFinite(width) ? Math.max(3, Math.round(width)) : 20);

function makeBar(style: BarStyle, mode: Bar['mode'], moving: boolean, flags: boolean[]): Bar {
  const g = GLYPHS[style];
  const parts: BarPart[] = [];
  for (const on of flags) {
    const last = parts[parts.length - 1];
    if (last !== undefined && last.used === on) last.text += on ? g.used : g.rest;
    else parts.push({ text: on ? g.used : g.rest, used: on });
  }
  const n = flags.filter(Boolean).length;
  return { style, used: g.used.repeat(n), rest: g.rest.repeat(flags.length - n), mode, moving, open: g.open, close: g.close, parts };
}

/** A determinate bar of `width` cells with round(fraction * width) filled (never a full bar before the work is done). */
export function determinateBar(fraction: number, style: BarStyle, width: number): Bar {
  const w = trackWidth(width);
  const f = clamp01(fraction);
  let filled = Math.round(f * w);
  if (f < 1 && filled >= w) filled = w - 1;
  return makeBar(style, 'determinate', false, Array.from({ length: w }, (_, i) => i < filled));
}

/** The length of the sliding segment: about a fifth of the track, at least two cells. */
export const segmentLength = (width: number): number => {
  const w = trackWidth(width);
  return Math.min(w - 1, Math.max(2, Math.round(w / 5)));
};

/**
 * An indeterminate bar: a segment that starts at cell `tick mod width` and wraps round the end, one cell per tick.
 * With `frozen` it stands still in the middle of the track instead. It never implies a fraction.
 */
export function slidingBar(tick: number, style: BarStyle, width: number, frozen = false): Bar {
  const w = trackWidth(width);
  const seg = segmentLength(w);
  const t = Number.isFinite(tick) ? Math.floor(tick) : 0;
  const pos = frozen ? Math.floor((w - seg) / 2) : ((t % w) + w) % w;
  return makeBar(style, 'sliding', !frozen, Array.from({ length: w }, (_, i) => (i - pos + w) % w < seg));
}

const pieces = (...p: (string | undefined | false)[]): string => p.filter((x): x is string => typeof x === 'string' && x !== '').join(SEP);

/**
 * Formats a view as one band row. `tick` counts 250 ms steps and only moves a sliding bar; `now` only lets a reset
 * time that is already past be left out. Returns null for a hidden view.
 */
export function formatView(view: View, settings: Settings, tick: number, now?: number): Formatted | null {
  const { barStyle: style, barWidth: width } = settings;
  const count = (done: number, total: number): string | false => settings.showCount && total > 0 && `${done}/${total}`;
  const percent = (fraction: number): string | false => settings.showPercent && `${Math.floor(clamp01(fraction) * 100)}%`;
  // The bar of a view that is not progress or working: the list's share, a frozen slide mid-turn, or none.
  const held = (done: number, total: number, running: boolean): Bar | null =>
    total > 0 ? determinateBar(done / total, style, width) : running ? slidingBar(tick, style, width, true) : null;
  const shared = (done: number, total: number): string => pieces(count(done, total), total > 0 && percent(done / total));

  switch (view.kind) {
    case 'hidden':
      return null;

    case 'progress': {
      const tail = pieces(
        count(view.done, view.total),
        percent(view.fraction),
        settings.showLabel && view.label !== undefined && oneLine(view.label),
        settings.showElapsed && view.elapsedMs > 0 && formatElapsed(view.elapsedMs),
      );
      return { kind: 'progress', icon: '▶', tone: TONES.progress, text: 'Progress', bar: determinateBar(view.fraction, style, width), tail };
    }

    case 'working': {
      const tail = pieces(
        settings.showLabel && view.detail !== undefined && `${oneLine(view.detail)} in background`,
        settings.showElapsed && view.elapsedMs > 0 && formatElapsed(view.elapsedMs),
        settings.showSubagents && view.subagents > 0 && `${view.subagents} ${agentsWord(view.subagents)}`,
      );
      return { kind: 'working', icon: '●', tone: TONES.working, text: 'Working', bar: slidingBar(tick, style, width), tail };
    }

    case 'stopped': {
      const text = pieces(`Stopped${SEP}${view.left} of ${view.total} ${stepsWord(view.total)} left`, view.reason !== undefined && oneLine(view.reason));
      return { kind: 'stopped', icon: '○', tone: TONES.stopped, text, bar: held(view.done, view.total, false), tail: shared(view.done, view.total) };
    }

    case 'done': {
      const tail = pieces(count(view.done, view.total), settings.showElapsed && view.durationMs > 0 && formatElapsed(view.durationMs));
      return { kind: 'done', icon: '✓', tone: TONES.done, text: 'Done', bar: determinateBar(1, style, width), tail };
    }

    case 'waiting': {
      let text: string;
      if (view.why === 'question' || (view.why === 'permission' && view.detail === 'AskUserQuestion')) {
        text = 'Waiting for your answer';
      } else if (view.why === 'permission') {
        text = view.detail === undefined ? 'Waiting for permission' : `Waiting for permission: ${oneLine(view.detail, 40)}`;
      } else {
        const at = formatResetTime(view.detail, now);
        text = `Waiting${SEP}${at === undefined ? 'usage limit' : `usage limit, resets ${at}`}`;
      }
      return { kind: 'waiting', icon: '⏸', tone: TONES.waiting, text, bar: held(view.done, view.total, view.running), tail: shared(view.done, view.total) };
    }

    case 'blocked': {
      let text: string;
      if (view.why === 'error') {
        text = view.detail === undefined ? 'error' : oneLine(view.detail);
      } else if (view.why === 'denied') {
        text = view.detail === undefined ? 'permission denied' : `permission denied: ${oneLine(view.detail, 40)}`;
      } else {
        const n = view.count ?? 1;
        text = `${n} ${n === 1 ? 'task waits' : 'tasks wait'} on unmet dependencies`;
      }
      return { kind: 'blocked', icon: '✖', tone: TONES.blocked, text: `Blocked${SEP}${text}`, bar: held(view.done, view.total, view.running), tail: shared(view.done, view.total) };
    }

    case 'paused': {
      let text: string;
      if (view.why === 'plan') text = 'Plan ready for approval';
      else if (view.why === 'interrupt') text = 'Paused by you';
      else text = pieces('Paused', view.detail !== undefined && oneLine(view.detail, 40));
      return { kind: 'paused', icon: '⏸', tone: TONES.paused, text, bar: held(view.done, view.total, view.running), tail: shared(view.done, view.total) };
    }
  }
}
