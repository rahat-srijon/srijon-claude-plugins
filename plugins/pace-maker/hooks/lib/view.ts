// Derives the single view to show from the task list, the session state and background work.
// Pure: a renderer turns the View into pixels or text; this module formats nothing except reason/detail text.

import { activeLabel, blocked, counts, fraction, hasList, isComplete, type Model } from './progress.ts';
import { backgroundSummary, type Background } from './background.ts';
import { endsWithQuestion } from './question.ts';
import type { SessionState } from './state.ts';

export type View =
  | { kind: 'hidden' }
  | { kind: 'progress'; done: number; total: number; fraction: number; label?: string; elapsedMs: number }
  | { kind: 'working'; detail?: string; elapsedMs: number; subagents: number }
  | { kind: 'stopped'; done: number; total: number; left: number; reason?: string }
  | { kind: 'done'; done: number; total: number; durationMs: number }
  | { kind: 'waiting'; why: 'permission' | 'question' | 'usage-limit'; detail?: string; done: number; total: number }
  | { kind: 'blocked'; why: 'error' | 'denied' | 'dependency'; detail?: string; count?: number; done: number; total: number }
  | { kind: 'paused'; why: 'interrupt' | 'plan' | 'command'; detail?: string; done: number; total: number };

/** Picks exactly one view. Precedence: off, permission, pause command, running, colored stop reasons, background, done, stopped, hidden. */
export function deriveState(progress: Model, state: SessionState, bg: Background, now: number): View {
  if (state.disabled) return { kind: 'hidden' };
  const { done, total } = counts(progress);
  const sum = backgroundSummary(bg);
  const elapsedMs = state.startedAt === null ? 0 : now - state.startedAt;
  const withDetail = <T extends object>(v: T, detail: string | undefined): T =>
    detail === undefined ? v : { ...v, detail };
  const working = (): View => withDetail({ kind: 'working' as const, elapsedMs, subagents: sum.agents }, sum.label);
  const left = total - done;

  if (state.permission) {
    return withDetail({ kind: 'waiting' as const, why: 'permission' as const, done, total }, state.permission.tool || undefined);
  }
  if (state.pause) {
    return withDetail({ kind: 'paused' as const, why: 'command' as const, done, total }, state.pause.reason || undefined);
  }
  if (state.running) {
    if (!hasList(progress)) return working();
    const label = activeLabel(progress);
    const v: View = { kind: 'progress', done, total, fraction: fraction(progress), elapsedMs };
    return label === undefined ? v : { ...v, label };
  }

  if (state.error) {
    return withDetail({ kind: 'blocked' as const, why: 'error' as const, done, total }, state.error.message || state.error.code);
  }
  if (state.denied) {
    return withDetail({ kind: 'blocked' as const, why: 'denied' as const, done, total }, state.denied.tool || undefined);
  }
  const waitingOn = blocked(progress);
  if (waitingOn.length > 0 && left > 0) {
    const first = progress.tasks.find((t) => t.id === waitingOn[0]);
    return withDetail(
      { kind: 'blocked' as const, why: 'dependency' as const, count: waitingOn.length, done, total },
      first?.subject || undefined,
    );
  }
  if (state.limit) {
    return withDetail({ kind: 'waiting' as const, why: 'usage-limit' as const, done, total }, state.limit.resetsAt);
  }
  if (state.planWaiting) return { kind: 'paused', why: 'plan', done, total };
  if (state.lastEnd?.isAborted) return { kind: 'paused', why: 'interrupt', done, total };
  if (state.lastEnd && left > 0 && endsWithQuestion(state.lastEnd.answer)) {
    return { kind: 'waiting', why: 'question', done, total };
  }

  if (sum.total > 0) return working();
  if (hasList(progress) && isComplete(progress)) {
    const durationMs = state.startedAt !== null && state.endedAt !== null ? state.endedAt - state.startedAt : 0;
    return { kind: 'done', done, total, durationMs };
  }
  // No signal in the state explains a stop with tasks left, so no reason is given (never invented).
  if (hasList(progress)) return { kind: 'stopped', done, total, left };
  return { kind: 'hidden' };
}
