// pace-maker hooks: observers plus the drawing. The M2 hooks are observers only. Every hook passes the event on first and returns the answer unchanged;
// its own bookkeeping runs after, inside try/catch, so a bug here can never change a tool call or a turn.
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';
import { applyBackgroundEvent, emptyBackground, type BackgroundEvent } from './lib/background.ts';
import { applyTaskList, applyToolEvent, emptyModel, isComplete, type ToolEvent } from './lib/progress.ts';
import { applyEvent, emptyState, type StateEvent } from './lib/state.ts';
import { deriveState, type View } from './lib/view.ts';
import { easeValue, formatView, type Formatted } from './lib/format.ts';
import { EXPLAIN_REQUEST, buildExplainPrompt, clampReason, shouldExplain } from './lib/explain.ts';
import { failureEvent, isDeniedResult } from './lib/failure.ts';
import { defaultSettings, normalizeSettings, type Settings } from './lib/settings.ts';

// The per-conversation state lives in $.state (a hot reload keeps it); the engine's scan needs the atoms spelled in this file.
const progress = atom({ plugin: 'pace-maker', key: 'progress' } as const, emptyModel(), { shape: 'progress-1' });
const session = atom({ plugin: 'pace-maker', key: 'session' } as const, emptyState(), { shape: 'state-2' });
const bg = atom({ plugin: 'pace-maker', key: 'bg' } as const, emptyBackground(), { shape: 'bg-1' });

type Rec = Record<string, unknown>;
type Dollar = EngineInterface;

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

const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The settings: the manifest's userConfig values, read once per module load (a change in /config reloads the module).
let cached: Settings = defaultSettings();

export function getSettings(): Settings {
  return cached;
}

// ---- Drawing ---------------------------------------------------------------------------------------------------
// Module-level timers and the displayed bar value; a hot reload resets them and the next event or render restarts them.
const TICK_MS = 1000;
const FAST_MS = 50;
const EASE_MS = 300;
let tick: Timer | null = null;
let fast: Timer | null = null;
let shown: number | null = null;
let tween: { from: number; to: number; t0: number } | null = null;
let vscodeSeen = false;
let lastStatus: string | undefined;

const BAND_SURFACES = new Set(['terminal', 'desktop', 'mobile']);

/** The bar fraction to draw at `now`: the real one, or an eased step toward it. Never invents progress inside a step. */
function displayedFraction(view: View, now: number): number | undefined {
  if (view.kind !== 'progress') {
    shown = null;
    tween = null;
    return undefined;
  }
  const target = view.fraction;
  if (shown === null) {
    shown = target;
    tween = null;
    return target;
  }
  if (tween === null ? shown !== target : tween.to !== target) tween = { from: shown, to: target, t0: now };
  if (tween !== null) {
    shown = easeValue(tween.from, tween.to, now - tween.t0, EASE_MS);
    if (shown === tween.to) tween = null;
  }
  return shown;
}

/** Starts or stops the timers: a 1 s redraw while progress or working shows, nothing while hidden or idle. */
function syncTimers($: Dollar, view: View, settings: Settings): void {
  const active = settings.enabled && (view.kind === 'progress' || view.kind === 'working');
  if (active && tick === null) {
    tick = $.clock.every(TICK_MS, () => {
      try {
        $.ui.invalidate('ui.render');
        void refresh($);
      } catch { /* ignore */ }
    });
  } else if (!active && tick !== null) {
    tick.cancel();
    tick = null;
  }
  if (tween !== null && fast === null) {
    // Ends on its own clock, not on a render: a collapsed band or a survey draws nothing, and the timer must not outlive the ease.
    fast = $.clock.every(FAST_MS, () => {
      void (async () => {
        try {
          const t = tween;
          const done = t === null || (await $.clock.now()) - t.t0 >= EASE_MS;
          if (done && t !== null) {
            shown = t.to;
            tween = null;
          }
          $.ui.invalidate('ui.render');
          if (done) {
            fast?.cancel();
            fast = null;
          }
        } catch { /* ignore */ }
      })();
    });
  } else if (tween === null && fast !== null) {
    fast.cancel();
    fast = null;
  }
}

async function currentView($: Dollar): Promise<{ view: View; now: number }> {
  const now = await $.clock.now();
  const [p, s, b] = await Promise.all([read($, progress), read($, session), read($, bg)]);
  return { view: deriveState(p, s, b, now), now };
}

/** Keeps the vscode status line and the timers in step with the state. Called after every state change; never throws. */
async function refresh($: Dollar): Promise<void> {
  try {
    const settings = getSettings();
    const { view, now } = await currentView($);
    syncTimers($, view, settings);
    // The status entry is only for a session whose sole surface has no band (vscode); a band surface draws the band.
    const surfaces = await $.session.surfaces();
    const vscode = surfaces.length > 0 ? surfaces.includes('vscode') && !surfaces.some((x) => BAND_SURFACES.has(x)) : vscodeSeen;
    let text: string | undefined;
    if (vscode && settings.enabled && view.kind !== 'done') {
      text = formatView(view, settings, now)?.text;
    }
    if (text !== lastStatus && (vscode || lastStatus !== undefined)) {
      $.ui.status(text);
      lastStatus = text;
    }
  } catch { /* a bug here must never reach a hook */ }
}

const poke = ($: Dollar): void => {
  void refresh($);
};

async function setState($: Dollar, event: StateEvent, now?: number): Promise<void> {
  const at = now ?? Date.now();
  await update($, session, (s) => applyEvent(s, event, at));
  poke($);
}
// ---- Opt-in AI: the stop reason (off by default; the only model call this plugin makes) ----------------------------
// At most one in flight. A new turn or the session ending aborts it, and a reply that arrives after that is dropped.
let explaining: { id: number; abort: AbortController } | null = null;
let explainId = 0;

function cancelExplain(): void {
  const cur = explaining;
  explaining = null;
  try {
    cur?.abort.abort();
  } catch { /* ignore */ }
}

/** One small-model call for an unexplained stop. Fire and forget: it never delays or breaks the turn; every error is swallowed. */
async function explainStop($: Dollar, answer: string): Promise<void> {
  cancelExplain();
  const mine = { id: ++explainId, abort: new AbortController() };
  explaining = mine;
  try {
    const r = await $.model.complete({ ...EXPLAIN_REQUEST, prompt: buildExplainPrompt(answer) }, { signal: mine.abort.signal });
    if (explaining !== mine || mine.abort.signal.aborted || !r.isAnswered) return;
    const reason = clampReason(r.text);
    if (reason === '') return;
    // Still the same stop? (an error, a question or a new turn since would have changed the view)
    if ((await currentView($)).view.kind !== 'stopped' || explaining !== mine) return;
    await setState($, { kind: 'stopReason', text: reason });
  } catch { /* a failed or refused call just leaves the plain stopped line */
  } finally {
    if (explaining === mine) explaining = null;
  }
}

async function setBg($: Dollar, event: BackgroundEvent): Promise<void> {
  await update($, bg, (b) => applyBackgroundEvent(b, event));
  poke($);
}

/** Folds a finished task-list call into the progress model (and starts a fresh run when a new list begins). */
async function observeProgress($: Dollar, e: Rec, ran: Rec): Promise<void> {
  const tool = String(e.tool);
  const input: Rec = {};
  for (const [k, v] of Object.entries(e)) if (!RESERVED.includes(k)) input[k] = v;
  if (ran.deny !== undefined) return;
  if (tool === 'TaskList') {
    const tasks = isRec(ran.result) ? ran.result.tasks : undefined;
    if (Array.isArray(tasks)) {
      await update($, progress, (m) => applyTaskList(m, tasks as never));
      poke($);
    }
    return;
  }
  const ev: ToolEvent = { tool, input, isError: ran.isError === true };
  if (ran.result !== undefined) ev.result = ran.result;
  if (typeof ran.text === 'string') ev.text = ran.text;
  if (typeof e.agentId === 'string') ev.agentId = e.agentId;
  const startsList = tool === 'TaskCreate' || tool === 'TodoWrite' || (tool === PLAN && Array.isArray(input.items));
  if (startsList && ev.isError !== true && isComplete(await read($, progress))) await setState($, { kind: 'resetRun' });
  await update($, progress, (m) => applyToolEvent(m, ev));
  poke($);
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

export const register: Register = (on, options) => {
  cached = normalizeSettings(options);
  // The band above the prompt (terminal, desktop, mobile). Reads only; any failure falls back to the engine's own (nothing).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let f: Formatted | null = null;
    try {
      const settings = getSettings();
      if (e.props.hasSurvey || !settings.enabled) return next(e);
      const { view, now } = await currentView($);
      f = formatView(view, settings, now, displayedFraction(view, now));
      syncTimers($, view, settings);
    } catch {
      f = null;
    }
    if (f === null) return next(e);
    try {
      const { Box, Text } = $.ui.resolve(e);
      const glyph = f.glyphBar === undefined ? '' : `${f.glyphBar} `;
      return (
        <Box flexDirection="column" width={e.props.bodyColumns}>
          <Text color={f.color} wrap="truncate-end">{`${glyph}${f.text}`}</Text>
        </Box>
      );
    } catch {
      return next(e);
    }
  });

  // vscode draws no band: the compact text rides on the spinner line instead (the status entry is kept in refresh()).
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'vscode') return next(e);
    vscodeSeen = true;
    try {
      const settings = getSettings();
      if (!settings.enabled) return next(e);
      const { view, now } = await currentView($);
      const text = formatView(view, settings, now)?.text;
      if (text === undefined) return next(e);
      return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} ${text}` } });
    } catch {
      return next(e);
    }
  });

  // Every tool call: pass it on, then observe the few tools that matter. Tools we ignore return at once.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string;
    if (!WATCHED.has(tool) && pending.size === 0) return next(e);
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
        if (asked || wasPending) {
          await setState($, { kind: 'permissionResolved' });
        }
      } catch { /* ignore */ }
    }
    try {
      const r = ran as unknown as Rec;
      // A refused call (a person said no, or a hook did) is a denied permission, except where the refusal is the tool's own answer.
      if (isDeniedResult(r) && isMain && tool !== 'AskUserQuestion' && tool !== 'ExitPlanMode') await setState($, { kind: 'permissionDenied', tool });
      if (PROGRESS_TOOLS.has(tool)) await observeProgress($, call, r);
      else if (tool === 'ExitPlanMode') {
        if (!isDeniedResult(r) && isMain) await setState($, { kind: 'planWaiting' });
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
      } else if (e.tool_use_id !== undefined && e.agentId === undefined && ran.decision === 'deny') {
        pending.delete(e.tool_use_id);
        await setState($, { kind: 'permissionDenied', tool: e.tool });
      }
    } catch { /* ignore */ }
    return ran;
  });

  // Main loop only: subagent turns carry an agentId and are ignored.
  on('turn.start', async ($, e, next) => {
    const ran = await next(e);
    if (e.agentId !== undefined) return ran;
    cancelExplain();
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
      const fail = failureEvent(e);
      if (fail !== null) await setState($, fail);
      if (shouldExplain((await currentView($)).view, getSettings())) void explainStop($, e.answer);
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

  on('session.start', async ($, e, next) => {
    const ran = await next(e);
    try {
      await $.command.register({
        name: 'pace',
        description: 'Control the pace-maker progress band for this conversation',
        argumentHint: 'on|off|pause <reason>|resume',
      });
    } catch { /* ignore */ }
    return ran;
  });

  on('session.end', async ($, e, next) => {
    const ran = await next(e);
    cancelExplain();
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
        return { text: 'Off for this conversation.' };
      case 'on':
        await setState($, { kind: 'setDisabled', value: false });
        await setState($, { kind: 'resume' });
        return { text: 'On.' };
      case 'pause': {
        const reason = rest.join(' ').trim() || 'paused';
        await setState($, { kind: 'pause', reason });
        return { text: `Paused: ${clip(reason, 40).replace(/[.\s]+$/, '')}.` };
      }
      case 'resume':
        await setState($, { kind: 'resume' });
        return { text: 'Resumed.' };
      default:
        return { text: 'Usage: /pace on|off|pause <reason>|resume' };
    }
  });
};
