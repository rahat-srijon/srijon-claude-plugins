// Pure progress model: turns task-list tool calls into a JSON-serializable list.
// No I/O and no classes; every function returns new data and never mutates its input.

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export type Task = {
  id: string;
  subject: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy: string[];
};

/** A TaskUpdate whose task id has not been created yet. */
export type HeldUpdate = {
  taskId: string;
  status?: TaskStatus;
  subject?: string;
  activeForm?: string;
  addBlockedBy?: string[];
};

export type Model = {
  shape: 'progress-1';
  tasks: Task[];
  source: 'task' | 'todo' | 'plan' | null;
  held: HeldUpdate[];
};

export type ToolEvent = {
  tool: string;
  input: Record<string, unknown>;
  result?: unknown;
  text?: string;
  isError?: boolean;
  agentId?: string;
};

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed', 'deleted'];
const MAX_HELD = 100;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
const status = (v: unknown): TaskStatus | undefined =>
  typeof v === 'string' && STATUSES.includes(v) ? (v as TaskStatus) : undefined;
const live = (m: Model): Task[] => m.tasks.filter((t) => t.status !== 'deleted');

/** An empty model with no list. */
export function emptyModel(): Model {
  return { shape: 'progress-1', tasks: [], source: null, held: [] };
}

/** Applies one tool call to the model and returns a new model; unknown or failed calls return the same one. */
export function applyToolEvent(model: Model, event: ToolEvent): Model {
  if (event.isError) return model;
  const input = isRecord(event.input) ? event.input : {};
  switch (event.tool) {
    case 'TaskCreate':
      return taskCreate(model, input, event.result);
    case 'TaskUpdate':
      return taskUpdate(model, input);
    case 'TodoWrite':
      return todoWrite(model, input);
    case 'mcp__ccd_turn__update_plan':
      return updatePlan(model, input, event.text);
    case 'mcp__ccd_turn__wrap_up':
      return wrapUp(model);
    default:
      return model;
  }
}

/** Rebuilds the model from a TaskList result, to recover after compaction or resume. */
export function applyTaskList(
  model: Model,
  tasks: { id: string; subject: string; status: string; blockedBy?: string[] }[],
): Model {
  const rebuilt: Task[] = tasks.map((t) => ({
    id: String(t.id),
    subject: t.subject,
    status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
    blockedBy: (t.blockedBy ?? []).map(String),
  }));
  return { ...model, tasks: rebuilt, source: 'task', held: [] };
}

/** Done and total counts; deleted tasks are excluded. */
export function counts(model: Model): { done: number; total: number } {
  const tasks = live(model);
  return { done: tasks.filter((t) => t.status === 'completed').length, total: tasks.length };
}

/** Completed share of the list from 0 to 1 (0 for an empty list). */
export function fraction(model: Model): number {
  const { done, total } = counts(model);
  return total === 0 ? 0 : done / total;
}

/** Label for the running step: its activeForm, else its subject, else undefined. */
export function activeLabel(model: Model): string | undefined {
  const t = live(model).find((x) => x.status === 'in_progress');
  return t ? t.activeForm || t.subject : undefined;
}

/** True when there is at least one task and all of them are completed. */
export function isComplete(model: Model): boolean {
  const { done, total } = counts(model);
  return total > 0 && done === total;
}

/** True when the list has at least one non-deleted task. */
export function hasList(model: Model): boolean {
  return counts(model).total > 0;
}

/** Ids of open tasks waiting on a blocker that is not completed (a deleted blocker counts as resolved). */
export function blocked(model: Model): string[] {
  const byId = new Map(model.tasks.map((t) => [t.id, t]));
  return live(model)
    .filter((t) => t.status !== 'completed')
    .filter((t) =>
      t.blockedBy.some((id) => {
        const b = byId.get(id);
        return !b || (b.status !== 'completed' && b.status !== 'deleted');
      }),
    )
    .map((t) => t.id);
}

function applyUpdate(task: Task, u: Omit<HeldUpdate, 'taskId'>): Task {
  const next: Task = { ...task, blockedBy: [...task.blockedBy] };
  if (u.status) next.status = u.status;
  if (u.subject !== undefined) next.subject = u.subject;
  if (u.activeForm !== undefined) next.activeForm = u.activeForm;
  for (const id of u.addBlockedBy ?? []) if (!next.blockedBy.includes(id)) next.blockedBy.push(id);
  return next;
}

function parseUpdate(input: Record<string, unknown>): HeldUpdate | undefined {
  const taskId = str(input.taskId);
  if (taskId === undefined) return undefined;
  const u: HeldUpdate = { taskId };
  const s = status(input.status);
  if (s) u.status = s;
  if (typeof input.subject === 'string') u.subject = input.subject;
  if (typeof input.activeForm === 'string') u.activeForm = input.activeForm;
  if (Array.isArray(input.addBlockedBy)) u.addBlockedBy = input.addBlockedBy.map(String);
  return u;
}

function taskCreate(model: Model, input: Record<string, unknown>, result: unknown): Model {
  const task = isRecord(result) && isRecord(result.task) ? result.task : undefined;
  const id = task ? str(task.id) : undefined;
  const subject = str(input.subject);
  if (id === undefined || subject === undefined) return model;
  const finished = model.tasks.length > 0 && model.tasks.every((t) => t.status === 'completed' || t.status === 'deleted');
  const existing = finished ? [] : model.tasks;
  if (existing.some((t) => t.id === id)) return model;
  const created: Task = { id, subject, status: 'pending', blockedBy: [] };
  if (typeof input.activeForm === 'string') created.activeForm = input.activeForm;
  const mine = model.held.filter((h) => h.taskId === id);
  const applied = mine.reduce<Task>((t, h) => applyUpdate(t, h), created);
  return {
    ...model,
    tasks: [...existing, applied],
    source: 'task',
    held: model.held.filter((h) => h.taskId !== id),
  };
}

function taskUpdate(model: Model, input: Record<string, unknown>): Model {
  const u = parseUpdate(input);
  if (!u) return model;
  if (!model.tasks.some((t) => t.id === u.taskId)) {
    return { ...model, held: [...model.held, u].slice(-MAX_HELD) };
  }
  return { ...model, tasks: model.tasks.map((t) => (t.id === u.taskId ? applyUpdate(t, u) : t)) };
}

function todoWrite(model: Model, input: Record<string, unknown>): Model {
  if (!Array.isArray(input.todos)) return model;
  const tasks: Task[] = input.todos.filter(isRecord).map((t, i) => {
    const task: Task = {
      id: `todo-${i + 1}`,
      subject: str(t.content) ?? '',
      status: status(t.status) ?? 'pending',
      blockedBy: [],
    };
    if (typeof t.activeForm === 'string') task.activeForm = t.activeForm;
    return task;
  });
  return { ...model, tasks, source: 'todo', held: [] };
}

function updatePlan(model: Model, input: Record<string, unknown>, text?: string): Model {
  let m = model;
  if (Array.isArray(input.items)) {
    const tasks: Task[] = input.items.filter(isRecord).map((it, i) => {
      const s = status(it.status);
      return {
        id: `plan-${i + 1}`,
        subject: str(it.content) ?? '',
        status: s === 'completed' || s === 'in_progress' ? s : 'pending',
        blockedBy: [],
      };
    });
    m = { ...m, tasks, source: 'plan', held: [] };
  } else {
    if (Array.isArray(input.done)) for (const n of input.done) m = setStep(m, n, 'completed');
    if (typeof input.start === 'number') m = setStep(m, input.start, 'in_progress');
    if (input.advance === true) m = advance(m);
  }
  const match = text ? /step (\d+) of (\d+)/.exec(text) : null;
  if (match && live(m).length === Number(match[2])) m = resync(m, Number(match[1]));
  return m;
}

// Replaces the nth (1-based) non-deleted task's status; out-of-range indexes change nothing.
function setStep(model: Model, n: unknown, to: TaskStatus): Model {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return model;
  const target = live(model)[n - 1];
  if (!target) return model;
  return { ...model, source: 'plan', tasks: model.tasks.map((t) => (t === target ? { ...t, status: to } : t)) };
}

// Completes the running step(s) and starts the first pending one.
function advance(model: Model): Model {
  const tasks = model.tasks.map((t) => (t.status === 'in_progress' ? { ...t, status: 'completed' as const } : t));
  const next = tasks.findIndex((t) => t.status === 'pending');
  const out = tasks.map((t, i) => (i === next ? { ...t, status: 'in_progress' as const } : t));
  return { ...model, tasks: out };
}

// Steps before n are completed and step n is in progress (safety net for a missed call).
function resync(model: Model, n: number): Model {
  let i = 0;
  const tasks = model.tasks.map((t) => {
    if (t.status === 'deleted') return t;
    i += 1;
    if (i < n) return { ...t, status: 'completed' as const };
    if (i === n) return { ...t, status: 'in_progress' as const };
    return t;
  });
  return { ...model, tasks };
}

function wrapUp(model: Model): Model {
  if (!model.tasks.some((t) => t.status === 'in_progress')) return model;
  return { ...model, tasks: model.tasks.map((t) => (t.status === 'in_progress' ? { ...t, status: 'completed' as const } : t)) };
}
