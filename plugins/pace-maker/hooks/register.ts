// pace-maker hooks: observers only. Every hook passes the event on first and returns the answer unchanged;
// its own bookkeeping runs after, inside try/catch, so a bug here can never change a tool call or a turn.
import { atom, read, update } from 'claude-code';
import type { Register } from 'claude-code';
import { applyBackgroundEvent, emptyBackground, type BackgroundEvent } from './lib/background.ts';
import { applyTaskList, applyToolEvent, emptyModel, isComplete, type ToolEvent } from './lib/progress.ts';
import { applyEvent, emptyState, type StateEvent } from './lib/state.ts';

// The per-conversation state lives in $.state (a hot reload keeps it); the engine's scan needs the atoms spelled in this file.
const progress = atom({ plugin: 'pace-maker', key: 'progress' } as const, emptyModel(), { shape: 'progress-1' });
const session = atom({ plugin: 'pace-maker', key: 'session' } as const, emptyState(), { shape: 'state-1' });
const bg = atom({ plugin: 'pace-maker', key: 'bg' } as const, emptyBackground(), { shape: 'bg-1' });

type Rec = Record<string, unknown>;
type Dollar = Parameters<typeof read>[0];

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const PLAN = 'mcp__ccd_turn__update_plan';
const PROGRESS_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite', PLAN, 'mcp__ccd_turn__wrap_up', 'TaskList']);
const WATCHED = new Set([
  ...PROGRESS_TOOLS, 'AskUserQuestion', 'ExitPlanMode', 'Bash', 'Agent', 'Task', 'Monitor', 'TaskStop',
]);
const RESERVED = ['tool', 'tool_use_id', 'agentId', 'requestMeta'];
const ENDED = /^(completed|failed|killed|stopped|cancelled|canceled|error|timeout|timed_out)$/i;

// Tool-use ids whose permission prompt this plugin raised; cleared when that call completes.
const pending = new Set<string>();
// A prompt raised by a classic Notification has no call id: cleared by the next completed tool call.
let notified = false;

const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function setState($: Dollar, event: StateEvent, now?: number): Promise<void> {
  const at = now ?? Date.now();
  await update($, session, (s) => applyEvent(s, event, at));
}
async function setBg($: Dollar, event: BackgroundEvent): Promise<void> {
  await update($, bg, (b) => applyBackgroundEvent(b, event));
}

/** Folds a finished task-list call into the progress model (and starts a fresh run when a new list begins). */
async function observeProgress($: Dollar, e: Rec, ran: Rec): Promise<void> {
  const tool = String(e.tool);
  const input: Rec = {};
  for (const [k, v] of Object.entries(e)) if (!RESERVED.includes(k)) input[k] = v;
  if (ran.deny !== undefined) return;
  if (tool === 'TaskList') {
    const tasks = isRec(ran.result) ? ran.result.tasks : undefined;
    if (Array.isArray(tasks)) await update($, progress, (m) => applyTaskList(m, tasks as never));
    return;
  }
  const ev: ToolEvent = { tool, input, isError: ran.isError === true };
  if (ran.result !== undefined) ev.result = ran.result;
  if (typeof ran.text === 'string') ev.text = ran.text;
  if (typeof e.agentId === 'string') ev.agentId = e.agentId;
  const startsList = tool === 'TaskCreate' || tool === 'TodoWrite' || (tool === PLAN && Array.isArray(input.items));
  if (startsList && ev.isError !== true && isComplete(await read($, progress))) await setState($, { kind: 'resetRun' });
  await update($, progress, (m) => applyToolEvent(m, ev));
}

/** Starts or ends background items from a finished call. */
async function observeBackground($: Dollar, e: Rec, ran: Rec): Promise<void> {
  if (ran.deny !== undefined || ran.isError === true) return;
  const tool = String(e.tool);
  const result = isRec(ran.result) ? ran.result : {};
  const callId = text(e.tool_use_id) ?? '';
  if (tool === 'Bash') {
    const id = text(result.backgroundTaskId) ?? (e.run_in_background === true ? callId : '');
    if (id) await setBg($, { kind: 'started', id, itemKind: 'shell', label: clip(text(e.description) ?? text(e.command) ?? 'shell') });
  } else if (tool === 'Agent' || tool === 'Task') {
    if (e.run_in_background === true || result.status === 'async_launched') {
      const id = text(result.agentId) ?? text(result.taskId) ?? callId;
      if (id) await setBg($, { kind: 'started', id, itemKind: 'agent', label: clip(text(e.description) ?? 'agent') });
    }
  } else if (tool === 'Monitor') {
    const id = text(result.taskId) ?? callId;
    if (id) await setBg($, { kind: 'started', id, itemKind: 'monitor', label: clip(text(e.description) ?? 'monitor') });
  } else if (tool === 'TaskStop') {
    const id = text(e.task_id) ?? text(e.shell_id) ?? text(result.task_id);
    if (id) await setBg($, { kind: 'ended', id });
  }
}

export const register: Register = (on) => {
  // Every tool call: pass it on, then observe the few tools that matter. Tools we ignore return at once.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string;
    if (!WATCHED.has(tool) && pending.size === 0 && !notified) return next(e);
    const call = e as unknown as Rec;
    const isMain = call.agentId === undefined;
    const id = text(call.tool_use_id);
    let asked = false;
    try {
      if (tool === 'AskUserQuestion' && isMain) {
        asked = true;
        await setState($, { kind: 'permissionPrompt', tool });
      }
    } catch { /* never break the call */ }
    let ran;
    try {
      ran = await next(e);
    } finally {
      try {
        const wasPending = id !== undefined && pending.delete(id);
        if (asked || notified || wasPending) {
          notified = false;
          await setState($, { kind: 'permissionResolved' });
        }
      } catch { /* ignore */ }
    }
    try {
      const r = ran as unknown as Rec;
      if (PROGRESS_TOOLS.has(tool)) await observeProgress($, call, r);
      else if (tool === 'ExitPlanMode') {
        if (r.deny === undefined && isMain) await setState($, { kind: 'planWaiting' });
      } else if (WATCHED.has(tool)) await observeBackground($, call, r);
    } catch { /* ignore */ }
    return ran;
  });

  // A permission dialog is about to show when a real call's check resolves to ask and somebody can answer it.
  on('tool.check', async ($, e, next) => {
    const ran = await next(e);
    try {
      if (e.tool_use_id !== undefined && ran.decision === 'ask' && e.approver !== undefined) {
        pending.add(e.tool_use_id);
        await setState($, { kind: 'permissionPrompt', tool: e.tool });
      }
    } catch { /* ignore */ }
    return ran;
  });

  // Second signal for the permission prompt; a plugin above may bypass classic hooks, so this is never the only one.
  on('classic.Notification', async ($, e, next) => {
    const ran = await next(e);
    try {
      if (e.notification_type === 'permission_prompt') {
        const st = await read($, session);
        if (st.running && st.permission === null) {
          const m = /\buse\s+(\S+?)[.:]?(?:\s|$)/i.exec(e.message ?? '');
          notified = true;
          await setState($, { kind: 'permissionPrompt', tool: m?.[1] ?? 'a tool' });
        }
      }
    } catch { /* ignore */ }
    return ran;
  });

  on('classic.PermissionDenied', async ($, e, next) => {
    const ran = await next(e);
    try {
      notified = false;
      pending.delete(e.tool_use_id);
      await setState($, { kind: 'permissionDenied', tool: e.tool_name });
    } catch { /* ignore */ }
    return ran;
  });

  on('classic.StopFailure', async ($, e, next) => {
    const ran = await next(e);
    try {
      const details = e.error_details ?? e.last_assistant_message ?? '';
      if (e.error === 'rate_limit') {
        const at = /\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/.exec(details)?.[0];
        await setState($, at === undefined ? { kind: 'usageLimit' } : { kind: 'usageLimit', resetsAt: at });
      } else {
        await setState($, { kind: 'stopFailure', code: e.error, message: clip(details || e.error, 120) });
      }
    } catch { /* ignore */ }
    return ran;
  });

  // Main loop only: subagent turns carry an agentId and are ignored.
  on('turn.start', async ($, e, next) => {
    const ran = await next(e);
    if (e.agentId !== undefined) return ran;
    try {
      await setState($, { kind: 'turnStart' }, await $.clock.now());
    } catch { /* ignore */ }
    return ran;
  });

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e);
    if (e.agentId !== undefined) return ran;
    try {
      await setState($, { kind: 'turnComplete', isAborted: e.isAborted, answer: e.answer }, await $.clock.now());
    } catch { /* ignore */ }
    return ran;
  });

  // A task-notification row says a background task ended: <task-id> with a terminal <status>.
  on('session.append', { door: 'delivery' }, async ($, e, next) => {
    const ran = await next(e);
    try {
      if (e.origin.kind === 'task-notification') {
        const body = e.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(body)?.[1];
        const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(body)?.[1];
        if (id !== undefined && status !== undefined && ENDED.test(status)) await setBg($, { kind: 'ended', id });
      }
    } catch { /* ignore */ }
    return ran;
  });

  // The Stop hook lists what is still in flight: drop anything we track that is no longer there.
  on('classic.Stop', async ($, e, next) => {
    const ran = await next(e);
    try {
      const live = e.background_tasks;
      if (Array.isArray(live)) {
        const ids = new Set(live.map((t) => t.id));
        const gone = (await read($, bg)).items.filter((i) => !ids.has(i.id));
        for (const i of gone) await setBg($, { kind: 'ended', id: i.id });
      }
    } catch { /* ignore */ }
    return ran;
  });

  on('classic.SubagentStop', async ($, e, next) => {
    const ran = await next(e);
    try {
      await setBg($, { kind: 'ended', id: e.agent_id });
    } catch { /* ignore */ }
    return ran;
  });

  on('session.start', async ($, e, next) => {
    const ran = await next(e);
    try {
      await $.command.register({
        name: 'pace',
        description: 'Control the pace-maker progress band for this conversation',
        argumentHint: 'on|off|pause <reason>|resume|config',
      });
    } catch { /* ignore */ }
    return ran;
  });

  on('session.end', async ($, e, next) => {
    const ran = await next(e);
    try {
      await setBg($, { kind: 'sessionEnded' });
    } catch { /* ignore */ }
    return ran;
  });

  // /pace: answered here with one short line (the model reads a plugin command's text on its next request).
  on('command.run', { command: 'pace' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/);
    switch (sub.toLowerCase()) {
      case 'off':
        await setState($, { kind: 'setDisabled', value: true });
        return { text: 'pace-maker is off for this conversation.' };
      case 'on':
        await setState($, { kind: 'setDisabled', value: false });
        await setState($, { kind: 'resume' });
        return { text: 'pace-maker is on.' };
      case 'pause': {
        const reason = rest.join(' ').trim() || 'paused';
        await setState($, { kind: 'pause', reason });
        return { text: `Paused: ${clip(reason, 40)}` };
      }
      case 'resume':
        await setState($, { kind: 'resume' });
        return { text: 'Resumed.' };
      case 'config':
        return { text: 'The settings page arrives in a later version.' };
      default:
        return { text: 'Usage: /pace on|off|pause <reason>|resume (config comes later).' };
    }
  });
};
