// Session state and its reducer: what the conversation is doing right now, apart from the task list.
// JSON-serializable (no Map, Set, Date or functions); applyEvent returns a new state and never throws.

export type SessionState = {
  shape: 'state-1';
  disabled: boolean;
  running: boolean;
  startedAt: number | null;
  endedAt: number | null;
  permission: { tool: string } | null;
  pause: { reason: string } | null;
  planWaiting: boolean;
  error: { code?: string; message: string } | null;
  denied: { tool: string } | null;
  limit: { resetsAt?: string } | null;
  lastEnd: { isAborted: boolean; answer: string } | null;
};

export type StateEvent =
  | { kind: 'turnStart' }
  | { kind: 'turnComplete'; isAborted: boolean; answer: string }
  | { kind: 'permissionPrompt'; tool: string }
  | { kind: 'permissionResolved' }
  | { kind: 'permissionDenied'; tool: string }
  | { kind: 'stopFailure'; code?: string; message: string }
  | { kind: 'usageLimit'; resetsAt?: string }
  | { kind: 'planWaiting' }
  | { kind: 'pause'; reason: string }
  | { kind: 'resume' }
  | { kind: 'setDisabled'; value: boolean }
  | { kind: 'resetRun' };

/** A fresh state: enabled, idle, nothing to report. */
export function emptyState(): SessionState {
  return {
    shape: 'state-1',
    disabled: false,
    running: false,
    startedAt: null,
    endedAt: null,
    permission: null,
    pause: null,
    planWaiting: false,
    error: null,
    denied: null,
    limit: null,
    lastEnd: null,
  };
}

/** Applies one event and returns a new state. Unknown or out-of-order events are no-ops. */
export function applyEvent(state: SessionState, event: StateEvent, now: number = Date.now()): SessionState {
  switch (event?.kind) {
    case 'turnStart':
      return {
        ...state,
        running: true,
        startedAt: state.startedAt ?? now,
        permission: null,
        pause: null,
        planWaiting: false,
        error: null,
        denied: null,
        limit: null,
        lastEnd: null,
      };
    case 'turnComplete':
      return {
        ...state,
        running: false,
        endedAt: now,
        permission: null,
        lastEnd: { isAborted: event.isAborted === true, answer: typeof event.answer === 'string' ? event.answer : '' },
      };
    case 'permissionPrompt':
      return { ...state, permission: { tool: String(event.tool ?? '') } };
    case 'permissionResolved':
      return { ...state, permission: null };
    case 'permissionDenied':
      return { ...state, permission: null, denied: { tool: String(event.tool ?? '') } };
    case 'stopFailure': {
      const error: { code?: string; message: string } = { message: String(event.message ?? '') };
      if (event.code !== undefined) error.code = String(event.code);
      return { ...state, running: false, error };
    }
    case 'usageLimit':
      return { ...state, limit: event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt } };
    case 'planWaiting':
      return { ...state, planWaiting: true };
    case 'pause':
      return { ...state, pause: { reason: String(event.reason ?? '') } };
    case 'resume':
      return { ...state, pause: null };
    case 'setDisabled':
      return { ...state, disabled: event.value === true };
    case 'resetRun':
      return { ...state, startedAt: null, endedAt: null, lastEnd: null, error: null, denied: null, limit: null, planWaiting: false };
    default:
      return { ...state };
  }
}
