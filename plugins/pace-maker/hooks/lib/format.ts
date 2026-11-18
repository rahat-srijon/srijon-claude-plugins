// Turns a View into the plain data a renderer draws: one text line, an icon, a theme color key and an optional bar.
// Pure and JSX-free. Colors are theme tokens only (never a raw color); undefined means the engine's own accent.

import type { View } from './view.ts';
import type { BarStyle, Settings } from './settings.ts';

export type Formatted = {
  kind: View['kind'];
  /** The state's glyph; empty for a bar-led progress line, where the bar is the mark. Already part of `text`. */
  icon: string;
  /** A theme token such as 'warning', or undefined for the engine's accent. */
  color: string | undefined;
  /** The one-line string, icon included, with no line breaks. */
  text: string;
  /** A glyph bar of barWidth cells. */
  glyphBar?: string;
};

const COLORS = {
  working: 'subtle',
  stopped: 'subtle',
  done: 'success',
  waiting: 'warning',
  blocked: 'error',
  paused: 'suggestion',
} as const;

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

/** A glyph bar of exactly `width` cells. Whole cells only, so nothing is drawn that is not done yet. */
export function glyphBar(fraction: number, style: BarStyle, width: number): string {
  const w = Math.max(3, Math.round(width));
  const f = clamp01(fraction);
  const fill = (cells: number): number => (f >= 1 ? cells : Math.floor(f * cells));
  switch (style) {
    case 'blocks':
      return '█'.repeat(fill(w)) + '░'.repeat(w - fill(w));
    case 'thin':
      return '━'.repeat(fill(w)) + '─'.repeat(w - fill(w));
    case 'dots':
      return '●'.repeat(fill(w)) + '○'.repeat(w - fill(w));
    case 'ascii': {
      const inner = w - 2;
      return `[${'#'.repeat(fill(inner))}${'-'.repeat(inner - fill(inner))}]`;
    }
  }
}

/** Where a bar shown at `from` stands `elapsedMs` into a tween to `to` (ease-out, `durationMs` long). */
export function easeValue(from: number, to: number, elapsedMs: number, durationMs: number = 300): number {
  if (!(durationMs > 0) || elapsedMs >= durationMs) return to;
  if (!(elapsedMs > 0)) return from;
  const p = elapsedMs / durationMs;
  return from + (to - from) * (1 - (1 - p) * (1 - p));
}

const stepsWord = (n: number): string => (n === 1 ? 'step' : 'steps');
const agentsWord = (n: number): string => (n === 1 ? 'subagent' : 'subagents');

/**
 * Formats a view for drawing. `now` only lets a reset time that is already past be left out.
 * `shown` is the fraction a smoothed bar is drawn at instead of the real one (progress only).
 */
export function formatView(view: View, settings: Settings, now?: number, shown?: number): Formatted | null {
  const f = { stepCount: settings.showCount, percentage: settings.showPercent, stepLabel: settings.showLabel, elapsed: settings.showElapsed, subagents: settings.showSubagents };
  switch (view.kind) {
    case 'hidden':
      return null;

    case 'progress': {
      const parts: string[] = [];
      if (f.stepCount) parts.push(`${view.done}/${view.total}`);
      const real = clamp01(view.fraction);
      if (f.percentage) parts.push(`${Math.floor(real * 100)}%`);
      if (f.stepLabel && view.label !== undefined) parts.push(oneLine(view.label));
      if (f.elapsed && view.elapsedMs > 0) parts.push(formatElapsed(view.elapsedMs));
      const body = parts.join(SEP);
      const out: Formatted = { kind: 'progress', icon: '', color: undefined, text: body };
      out.glyphBar = glyphBar(shown === undefined ? real : clamp01(shown), settings.barStyle, settings.barWidth);
      return out;
    }

    case 'working': {
      const parts = ['Working'];
      if (view.detail !== undefined) parts.push(`${oneLine(view.detail)} in background`);
      if (f.elapsed && view.elapsedMs > 0) parts.push(formatElapsed(view.elapsedMs));
      if (f.subagents && view.subagents > 0) parts.push(`${view.subagents} ${agentsWord(view.subagents)}`);
      return { kind: 'working', icon: '●', color: COLORS.working, text: `● ${parts.join(SEP)}` };
    }

    case 'stopped': {
      const parts = [`Stopped${SEP}${view.left} of ${view.total} ${stepsWord(view.total)} left`];
      if (view.reason !== undefined) parts.push(oneLine(view.reason));
      return { kind: 'stopped', icon: '○', color: COLORS.stopped, text: `○ ${parts.join(SEP)}` };
    }

    case 'done': {
      const parts = ['Done'];
      if (f.stepCount) parts.push(`${view.done}/${view.total}`);
      if (f.elapsed && view.durationMs > 0) parts.push(formatElapsed(view.durationMs));
      return { kind: 'done', icon: '✓', color: COLORS.done, text: `✓ ${parts.join(SEP)}` };
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
      return { kind: 'waiting', icon: '⏸', color: COLORS.waiting, text: `⏸ ${text}` };
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
      return { kind: 'blocked', icon: '⛔', color: COLORS.blocked, text: `⛔ Blocked${SEP}${text}` };
    }

    case 'paused': {
      const steps = view.total > 0 ? `${view.done}/${view.total}` : undefined;
      let parts: string[];
      if (view.why === 'plan') parts = ['Plan ready for approval'];
      else if (view.why === 'interrupt') parts = steps === undefined ? ['Paused by you'] : ['Paused by you', steps];
      else {
        parts = ['Paused'];
        if (view.detail !== undefined) parts.push(oneLine(view.detail, 40));
        if (steps !== undefined) parts.push(steps);
      }
      return { kind: 'paused', icon: '⏸', color: COLORS.paused, text: `⏸ ${parts.join(SEP)}` };
    }
  }
}
