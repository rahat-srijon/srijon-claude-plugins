// pace-maker hooks: observers plus the drawing. The M2 hooks are observers only. Every hook passes the event on first and returns the answer unchanged;
// its own bookkeeping runs after, inside try/catch, so a bug here can never change a tool call or a turn.
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';
import { applyBackgroundEvent, emptyBackground, type BackgroundEvent } from './lib/background.ts';
import { applyTaskList, applyToolEvent, emptyModel, isComplete, type ToolEvent } from './lib/progress.ts';
import { applyEvent, emptyState, type StateEvent } from './lib/state.ts';
import { deriveState, type View } from './lib/view.ts';
import { easeValue, formatView, type Formatted } from './lib/format.ts';
import { EXPLAIN_REQUEST, TASK_LIST_LINE, TASK_LIST_SECTION_ID, buildExplainPrompt, clampReason, shouldAskForTaskList, shouldExplain } from './lib/explain.ts';
import { CONFIG_FILE, dataDirFor, defaultSettings, parseSettingsText, type Settings } from './lib/settings.ts';

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
// A prompt raised by a classic Notification has no call id: cleared by the next completed tool call.
let notified = false;

const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The global settings, cached: render hooks call getSettings() on every draw, so it never does I/O. The file is read at
// session.start, at each main-loop turn.start and on every /pace command (loadSettings), never in tool.call or a render.
let cached: Settings = defaultSettings();

export function getSettings(): Settings {
  return cached;
}

/** Reads <data dir>/config.json into the cache (defaults on any trouble) and redraws when something changed. Never throws. */
async function loadSettings($: Dollar): Promise<void> {
  let next = defaultSettings();
  try {
    const override = await $.env.get('PACE_MAKER_DATA_DIR');
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
    const dir = dataDirFor(override, home);
    if (dir !== undefined) next = parseSettingsText(await $.fs.read(`${dir}/${CONFIG_FILE}`));
  } catch {
    next = defaultSettings();
  }
  try {
    if (JSON.stringify(next) === JSON.stringify(cached)) return;
    cached = next;
    $.ui.invalidate('ui.render');
    poke($);
  } catch { /* ignore */ }
}

/** /pace config: starts the settings page through the Node launcher and answers with its URL in one line. */
async function openSettingsPage($: Dollar): Promise<string> {
  try {
    const ran = await $.process.run(['node', `${$.plugin.root}/scripts/cli.js`, 'config'], { timeoutMs: 20_000 });
    const url = /https?:\/\/\S+/.exec(ran.stdout)?.[0];
    if (ran.exitCode === 0 && url !== undefined) return `Settings page: ${url}`;
    const why = (ran.stderr.split('\n').find((l) => l.trim() !== '') ?? '').replace(/^pace-maker:\s*/, '').trim();
    return couldNotOpen($, why);
  } catch {
    return couldNotOpen($, '');
  }
}

/** One line that tells the user the command to run in a terminal; the reason is added only while the line stays short. */
function couldNotOpen($: Dollar, why: string): string {
  const base = 'Could not open the settings page from this window';
  const manual = `. Run in a terminal: node "${$.plugin.root}/scripts/cli.js" config`;
  const withReason = why === '' ? '' : `${base} (${clip(why, 60)})${manual}`;
  const line = withReason !== '' && withReason.length <= 220 ? withReason : `${base}${manual}`;
  return line.replace(/\s*\n\s*/g, ' ');
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
function displayedFraction(view: View, settings: Settings, now: number): number | undefined {
  if (view.kind !== 'progress') {
    shown = null;
    tween = null;
    return undefined;
  }
  const target = view.fraction;
  if (settings.animation !== 'smooth' || shown === null) {
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
    if (vscode && settings.enabled && settings.showOnVscodeStatus && view.kind !== 'done') {
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

export const register: Register = (on) => {
  // The band above the prompt (terminal, desktop, mobile). Reads only; any failure falls back to the engine's own (nothing).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let f: Formatted | null = null;
    try {
      const settings = getSettings();
      if (e.props.hasSurvey || !settings.enabled) return next(e);
      const { view, now } = await currentView($);
      f = formatView(view, settings, now, displayedFraction(view, settings, now));
      syncTimers($, view, settings);
    } catch {
      f = null;
    }
    if (f === null) return next(e);
    try {
      const { Box, Text, Progress } = $.ui.resolve(e);
      const glyph = f.glyphBar === undefined ? '' : `${f.glyphBar} `;
      return (
        <Box flexDirection="column" width={e.props.bodyColumns}>
          <Text color={f.color} wrap="truncate-end">{`${glyph}${f.text}`}</Text>
          {f.bar === undefined ? null : (
            <Progress label={f.bar.label} value={f.bar.value} max={f.bar.max} valueText={f.bar.valueText} />
          )}
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
      if (!settings.enabled || !settings.showOnVscodeStatus) return next(e);
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
    await loadSettings($);
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
      if (getSettings().ai.explainStop && shouldExplain((await currentView($)).view, getSettings())) void explainStop($, e.answer);
    } catch { /* ignore */ }
    return ran;
  });

  // Opt-in: one short line, appended last at session scope, only while a task tool is offered. Off: exactly what next(e) returned.
  on('prompt.compose', async ($, e, next) => {
    const ran = await next(e);
    try {
      const settings = getSettings();
      if (!settings.ai.askForTaskList || !shouldAskForTaskList(settings, e.tools)) return ran;
      if ((await read($, session)).disabled || ran.sections.some((x) => x.id === TASK_LIST_SECTION_ID)) return ran;
      return { ...ran, sections: [...ran.sections, { id: TASK_LIST_SECTION_ID, text: TASK_LIST_LINE, scope: 'session' as const }] };
    } catch {
      return ran;
    }
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
    await loadSettings($);
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
    cancelExplain();
    try {
      await setBg($, { kind: 'sessionEnded' });
    } catch { /* ignore */ }
    return ran;
  });

  // /pace: answered here with one short line (the model reads a plugin command's text on its next request).
  on('command.run', { command: 'pace' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/);
    await loadSettings($); // a page save applies at the next /pace command at the latest, or at the next turn
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
        return { text: await openSettingsPage($) };
      default:
        return { text: 'Usage: /pace on|off|pause <reason>|resume|config' };
    }
  });
};
