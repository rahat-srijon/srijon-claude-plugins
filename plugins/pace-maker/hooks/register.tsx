// pace-maker hooks: observers plus the one band row. Every hook passes the event on first and returns the answer unchanged;
// its own bookkeeping runs after, inside try/catch, so a bug here can never change a tool call or a turn.
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';
import { applyBackgroundEvent, emptyBackground, type BackgroundEvent } from './lib/background.ts';
import { applyTaskList, applyToolEvent, emptyModel, isComplete, type ToolEvent } from './lib/progress.ts';
import { applyEvent, emptyState, type StateEvent } from './lib/state.ts';
import { barCells, barSvg, easeToward, packCells, type BarShape } from './lib/bar.ts';
import { deriveState, type View } from './lib/view.ts';
import { formatView, glyphWidth, type Formatted } from './lib/format.ts';
import { EXPLAIN_REQUEST, buildExplainPrompt, clampReason, shouldExplain } from './lib/explain.ts';
import { failureEvent, isDeniedResult } from './lib/failure.ts';
import { defaultSettings, normalizeSettings, type Settings } from './lib/settings.ts';

// The per-conversation state lives in $.state (a hot reload keeps it); the engine's scan needs the atoms spelled in this file.
const progress = atom({ plugin: 'pace-maker', key: 'progress' } as const, emptyModel(), { shape: 'progress-1' });
const session = atom({ plugin: 'pace-maker', key: 'session' } as const, emptyState(), { shape: 'state-3' });
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
// Module-level draw state (plain variables, never $.state: a hot reload resets them and the next event or render restarts
// the timer). Everything here is written by the ticker, `refresh` and the render hook's bookkeeping, and read back by the
// render hook; the render hook never writes $.state.
//
// How the band moves, per surface:
//  - terminal, smooth: the bar is a Raster. One 100 ms ticker moves the sliding segment and eases a determinate fill and
//    repaints with $.ui.blit (no redraw); every tenth tick (once a second) it also asks for a redraw, for the elapsed time.
//    If a blit is denied, that tick asks for a redraw instead (10 a second at most).
//  - desktop, vscode, mobile, smooth: the bar is an Svg that animates itself (SMIL), so the ticker only runs once a second,
//    for the elapsed time.
//  - a glyph style: the Text bar. A sliding one moves a cell every 250 ms by redraw; otherwise once a second.
const RASTER_MS = 100;
const SLIDE_TEXT_MS = 250;
const CLOCK_MS = 1000;
const BAR_KEY = 'pace-bar';
const SVG_WIDTH = 960;
const SVG_HEIGHT = 8;

type BarKind = 'raster' | 'svg' | 'text' | 'none';
const draw = {
  enabled: false,
  live: false,
  kind: 'none' as BarKind,
  requestId: '',
  columns: 0,
  shape: null as BarShape | null,
  /** The determinate fill as drawn: it eases toward `shape.fraction`. */
  shown: 0,
  /** The last determinate fraction an Svg drew, so a new one grows from there. */
  svgFrom: null as number | null,
  inFlight: false,
};
let ticker: Timer | null = null;
let tickerMs = 0;
let frame = 0;

/** True while the band has motion or a clock to keep fresh: progress, working, or a wait or pause raised mid-turn. */
function isLive(view: View): boolean {
  switch (view.kind) {
    case 'progress':
    case 'working':
      return true;
    case 'waiting':
    case 'paused':
      return view.running;
    default:
      return false;
  }
}

const easing = (): boolean =>
  draw.kind === 'raster' && draw.shape?.mode === 'determinate' && Math.abs(draw.shown - draw.shape.fraction) > 0.002;

/** The period the ticker must run at now, or 0 for none: only while a turn runs (or a fill is still easing). */
function wantedMs(): number {
  if (!draw.enabled) return 0;
  const moving = draw.shape?.mode === 'sliding' && draw.shape.moving;
  if (draw.kind === 'raster' && (moving || easing())) return RASTER_MS;
  if (!draw.live) return 0;
  if (draw.kind === 'text' && moving) return SLIDE_TEXT_MS;
  return CLOCK_MS;
}

function redraw($: Dollar): void {
  try {
    $.ui.invalidate('ui.render');
  } catch { /* ignore */ }
}

/** One ticker step: ease and repaint the Raster by blit, and ask for a redraw when the text or a glyph bar needs one. */
function step($: Dollar, ms: number): void {
  frame += 1;
  if (draw.kind === 'raster' && draw.shape !== null) {
    // Paint only what changes: a sliding segment, or a fill still easing (a still bar is not repainted).
    const changing = draw.shape.mode === 'sliding' ? draw.shape.moving : Math.abs(draw.shown - draw.shape.fraction) > 0.002;
    if (draw.shape.mode === 'determinate') draw.shown = easeToward(draw.shown, draw.shape.fraction, ms);
    if (changing && !draw.inFlight) {
      draw.inFlight = true;
      const cells = packCells(barCells({ ...draw.shape, fraction: draw.shown }, draw.columns, frame));
      const failed = (): void => {
        draw.inFlight = false;
        redraw($);
      };
      try {
        $.ui.blit({ requestId: draw.requestId, key: BAR_KEY, cells, columns: draw.columns, rows: 1 }).then(
          (r) => {
            draw.inFlight = false;
            if (r.deny !== undefined) redraw($);
          },
          failed,
        );
      } catch {
        failed();
      }
    }
    // The elapsed time and the count move once a second.
    if (draw.live && frame % Math.round(CLOCK_MS / ms) === 0) redraw($);
  } else if (draw.live) {
    redraw($);
  }
  syncTicker($);
}

/** Starts, retimes or stops the ticker to match the draw state. Never throws. */
function syncTicker($: Dollar): void {
  try {
    const ms = wantedMs();
    if (ms === tickerMs && (ms === 0) === (ticker === null)) return;
    ticker?.cancel();
    ticker = null;
    tickerMs = ms;
    if (ms > 0) ticker = $.clock.every(ms, () => step($, ms));
  } catch { /* no timer: the band still draws, without motion */ }
}

/** Notes the view in the draw state (what the ticker reads), then keeps the ticker in step. */
function track($: Dollar, view: View, settings: Settings, shape: BarShape | null): void {
  // A fill with nothing before it, or after a slide, starts at its target instead of growing from zero.
  if (shape?.mode === 'determinate' && (draw.shape?.mode !== 'determinate' || draw.kind !== 'raster')) draw.shown = shape.fraction;
  draw.enabled = settings.enabled;
  draw.live = isLive(view);
  draw.shape = shape;
  syncTicker($);
}

async function currentView($: Dollar): Promise<{ view: View; now: number }> {
  const now = await $.clock.now();
  const [p, s, b] = await Promise.all([read($, progress), read($, session), read($, bg)]);
  return { view: deriveState(p, s, b, now), now };
}

/** Keeps the ticker in step with the state. Called after every state change; never throws. */
async function refresh($: Dollar): Promise<void> {
  try {
    const settings = getSettings();
    const { view, now } = await currentView($);
    const f = formatView(view, settings, frame, now);
    track($, view, settings, f?.shape ?? null);
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

/** One more tool call by the main loop in this turn (a turn that made any counts as having done work). */
async function countCall($: Dollar): Promise<void> {
  try {
    await setState($, { kind: 'toolCall' });
  } catch { /* never break the call */ }
}

export const register: Register = (on, options) => {
  cached = normalizeSettings(options);
  // The band above the prompt on every surface: row 1 is one line of text (state, step, and a right-aligned tail), row 2
  // is the bar. Reads only; it never writes state.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let f: Formatted | null = null;
    let kind: BarKind = 'none';
    let columns = 80;
    try {
      const settings = getSettings();
      if (e.props.hasSurvey) return next(e);
      if (!settings.enabled) {
        draw.enabled = false;
        syncTicker($);
        return next(e);
      }
      columns = Math.max(1, Math.min(512, Math.floor(Number(e.props.bodyColumns)) || 80));
      const { view, now } = await currentView($);
      f = formatView(view, settings, frame, now, glyphWidth(columns));
      kind = f?.shape == null ? 'none' : settings.barStyle !== 'smooth' ? 'text' : e.surface === 'terminal' ? 'raster' : 'svg';
      draw.kind = kind;
      draw.requestId = e.requestId;
      draw.columns = columns;
      track($, view, settings, f?.shape ?? null);
    } catch {
      return next(e);
    }
    if (f === null) return next(e);
    try {
      const ui = $.ui.resolve(e);
      const { Box, Text } = ui;
      const shape = f.shape;
      let barRow: unknown = null;
      if (shape !== null && kind === 'raster' && e.surface === 'terminal') {
        const cells = packCells(barCells({ ...shape, fraction: shape.mode === 'determinate' ? draw.shown : shape.fraction }, columns, frame));
        barRow = $.ui.resolve(e).Raster({ key: BAR_KEY, columns, rows: 1, cells });
      } else if (shape !== null && kind === 'svg' && e.surface !== 'terminal') {
        const from = shape.mode === 'determinate' && draw.svgFrom !== null ? draw.svgFrom : undefined;
        draw.svgFrom = shape.mode === 'determinate' ? shape.fraction : null;
        const source = barSvg(shape, { width: SVG_WIDTH, height: SVG_HEIGHT, ...(from === undefined ? {} : { from }) });
        const alt = shape.mode === 'determinate' ? `${f.text}, ${Math.round(shape.fraction * 100)}%` : f.text;
        barRow = $.ui.resolve(e).Svg({ source, alt, height: SVG_HEIGHT, isInteractive: true });
      } else if (f.bar !== null) {
        const bar = f.bar;
        barRow = (
          <Box key="bar" flexDirection="row">
            <Text dimColor>{bar.open}</Text>
            {bar.parts.map((part, i) => (
              <Text key={`p${i}`} color={part.used ? f.tone : undefined} dimColor={!part.used}>{part.text}</Text>
            ))}
            <Text dimColor>{bar.close}</Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={f.tone} bold>{`${f.icon} ${f.text}`}</Text>
                {f.label === '' ? null : <Text dimColor>{` · ${f.label}`}</Text>}
              </Text>
            </Box>
            {f.tail === '' ? null : (
              <Box flexShrink={0} marginLeft={2}>
                <Text dimColor wrap="truncate-end">{f.tail}</Text>
              </Box>
            )}
          </Box>
          {barRow as never}
        </Box>
      );
    } catch {
      return next(e);
    }
  });

  // Every tool call: pass it on, then observe the few tools that matter. Tools we ignore return at once.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string;
    const call = e as unknown as Rec;
    const isMain = call.agentId === undefined;
    if (!WATCHED.has(tool) && pending.size === 0) {
      const done = await next(e);
      if (isMain) await countCall($);
      return done;
    }
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
    if (isMain) await countCall($);
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
    ticker?.cancel();
    ticker = null;
    tickerMs = 0;
    draw.enabled = false;
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
