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
  | { kind: 'done'; done: number; total: number; durationMs: number } // total 0: a turn that worked with no task list
  | { kind: 'waiting'; why: 'permission' | 'question' | 'usage-limit'; detail?: string; done: number; total: number; running: boolean }
  | { kind: 'blocked'; why: 'error' | 'denied' | 'dependency'; detail?: string; count?: number; done: number; total: number; running: boolean }
  | { kind: 'paused'; why: 'interrupt' | 'plan' | 'command'; detail?: string; done: number; total: number; running: boolean };

/** A turn with no tool call and no list counts as work only from this long (a quick chat reply leaves the band hidden). */
export const WORK_MIN_MS = 8000;

/** Picks exactly one view. Precedence: off, permission, pause command, running, colored stop reasons (a question included, list or not), background, done, stopped, then Done for a list-less turn that worked, else hidden. */
export function deriveState(progress: Model, state: SessionState, bg: Background, now: number): View {
  if (state.disabled) return { kind: 'hidden' };
  const { done, total } = counts(progress);
  const sum = backgroundSummary(bg);
  const listed = hasList(progress);
  // A task list's clock runs from the run's start; with no list it is the turn's own.
  const since = listed ? state.startedAt : state.turnStartedAt;
  const elapsedMs = since === null ? 0 : Math.max(0, now - since);
  const turnMs = state.turnStartedAt !== null && state.endedAt !== null ? Math.max(0, state.endedAt - state.turnStartedAt) : 0;
  const withDetail = <T extends object>(v: T, detail: string | undefined): T =>
    detail === undefined ? v : { ...v, detail };
  const working = (): View => withDetail({ kind: 'working' as const, elapsedMs, subagents: sum.agents }, sum.label);
  const left = total - done;
  const running = state.running;

  if (state.permission) {
    return withDetail({ kind: 'waiting' as const, why: 'permission' as const, done, total, running }, state.permission.tool || undefined);
  }
  if (state.pause) {
    return withDetail({ kind: 'paused' as const, why: 'command' as const, done, total, running }, state.pause.reason || undefined);
  }
  if (state.running) {
    if (!hasList(progress)) return working();
    const label = activeLabel(progress);
    const v: View = { kind: 'progress', done, total, fraction: fraction(progress), elapsedMs };
    return label === undefined ? v : { ...v, label };
  }

  if (state.error) {
    return withDetail({ kind: 'blocked' as const, why: 'error' as const, done, total, running }, state.error.message || state.error.code);
  }
  if (state.denied) {
    return withDetail({ kind: 'blocked' as const, why: 'denied' as const, done, total, running }, state.denied.tool || undefined);
  }
  const waitingOn = blocked(progress);
  if (waitingOn.length > 0 && left > 0) {
    const first = progress.tasks.find((t) => t.id === waitingOn[0]);
    return withDetail(
      { kind: 'blocked' as const, why: 'dependency' as const, count: waitingOn.length, done, total, running },
      first?.subject || undefined,
    );
  }
  if (state.limit) {
    return withDetail({ kind: 'waiting' as const, why: 'usage-limit' as const, done, total, running }, state.limit.resetsAt);
  }
  if (state.planWaiting) return { kind: 'paused', why: 'plan', done, total, running };
  if (state.lastEnd?.isAborted) return { kind: 'paused', why: 'interrupt', done, total, running };
  if (state.lastEnd && endsWithQuestion(state.lastEnd.answer)) {
    return { kind: 'waiting', why: 'question', done, total, running };
  }

  if (sum.total > 0) return working();
  if (listed && isComplete(progress)) {
    const durationMs = state.startedAt !== null && state.endedAt !== null ? state.endedAt - state.startedAt : 0;
    return { kind: 'done', done, total, durationMs };
  }
  // No signal explains a stop with tasks left: the reason is only the opt-in AI one (stopReason), never invented here.
  if (listed) {
    return state.stopReason ? { kind: 'stopped', done, total, left, reason: state.stopReason } : { kind: 'stopped', done, total, left };
  }
  // No list: a turn that did work (a tool call, or 8 s or more) leaves a Done row until the next turn starts.
  // A conversation where nothing has ended yet, or a quick reply that used no tool, stays hidden.
  if (state.lastEnd !== null && (state.toolCalls > 0 || turnMs >= WORK_MIN_MS)) {
    return { kind: 'done', done: 0, total: 0, durationMs: turnMs };
  }
  return { kind: 'hidden' };
}
