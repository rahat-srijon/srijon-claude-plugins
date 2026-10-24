// @ts-check
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAttentionEvent, loadConfig } from './lib/config.js';
import { log } from './lib/log.js';
import { familyOf, modelFromAgentDefinition, modelFromTranscript } from './lib/model.js';
import { dataDir as defaultDataDir, pluginRoot as defaultPluginRoot } from './lib/paths.js';
import { canSound, playEvent, spawnDetached as defaultSpawnDetached } from './lib/play.js';
import { play as defaultPlay, speak as defaultSpeak } from './lib/player/index.js';
import {
  clearAttention,
  joinUsageReminder,
  leaveUsageReminders,
  readAttention,
  setAttention,
} from './lib/reminders.js';
import { openSession } from './lib/state.js';
import { refreshShim } from './lib/statusline.js';
import { WINDOWS, WINDOW_NAMES, hitWindows, readUsageState } from './lib/usage.js';

/** @typedef {import('./lib/config.js').Config} Config */
/** @typedef {import('./lib/config.js').EventName} EventName */
/** @typedef {import('./lib/state.js').Session} Session */

/**
 * Hook input JSON from Claude Code. Common fields are `session_id`,
 * `transcript_path`, `cwd` and `hook_event_name`; the rest depend on the event.
 * @typedef {Record<string, unknown>} HookInput
 */

/**
 * @typedef {object} Deps
 * @property {typeof defaultPlay} [play]
 * @property {typeof defaultSpeak} [speak]
 * @property {string} [dataDir]
 * @property {string} [pluginRoot]
 * @property {typeof defaultSpawnDetached} [spawnDetached] Starts reminder repeaters.
 */

/**
 * @typedef {object} Outcome
 * @property {'recorded' | 'ignored' | 'skipped' | 'played' | 'failed'} status
 * @property {EventName | null} event Null when the input maps to no sound event.
 * @property {string | null} model
 * @property {string | null} family
 * @property {string} detail What was recorded or played, or why nothing was.
 */

/** @typedef {(input: HookInput, session: Session, projectDir: string | undefined) => string | null} ModelSource */

const STDIN_TIMEOUT_MS = 3000;

/**
 * Hooks that update session state, before any sound they may also play.
 * @type {Readonly<Record<string, (session: Session, input: HookInput) => string>>}
 */
const STATE_HOOKS = Object.freeze({
  UserPromptSubmit: (session) => {
    session.markTurnStart();
    return 'turn start';
  },
  Stop: (session) => endTurn(session),
  StopFailure: (session) => endTurn(session),
  SessionEnd: (session) => endTurn(session),
  SessionStart: (session, input) => recordModel(session, input.model),
  PostModelSwitch: (session, input) => recordModel(session, input.to_model),
});

/** Hooks that end a turn, so usage reminders stop repeating for the session. */
const TURN_END_HOOKS = Object.freeze(['Stop', 'StopFailure', 'SessionEnd']);

/** @type {Readonly<Record<string, EventName>>} */
const TOOL_EVENTS = Object.freeze({
  Agent: 'subagent_start',
  Task: 'subagent_start',
  AskUserQuestion: 'question',
});

/**
 * Hooks that may play a sound, mapped to the event they signal.
 * @type {Readonly<Record<string, (input: HookInput) => EventName | null>>}
 */
const SOUND_HOOKS = Object.freeze({
  UserPromptSubmit: () => 'agent_start',
  Stop: () => 'agent_done',
  SubagentStop: () => 'subagent_done',
  StopFailure: () => 'error',
  PreToolUse: (input) => lookup(TOOL_EVENTS, input.tool_name) ?? null,
  Notification: (input) => (input.notification_type === 'permission_prompt' ? 'permission' : null),
});

/**
 * The main agent's model: the cached one, else the latest in the transcript,
 * since SessionStart does not always report a model.
 * @type {ModelSource}
 */
const sessionModel = (input, session) => (
  session.getModel() ?? modelFromTranscript(nonEmptyString(input.transcript_path))
);

/** @type {Readonly<Record<EventName, ModelSource>>} */
const MODEL_SOURCES = Object.freeze({
  agent_start: sessionModel,
  agent_done: (input, session) => modelFromTranscript(nonEmptyString(input.transcript_path)) ?? session.getModel(),
  subagent_done: (input, session) => (
    modelFromTranscript(nonEmptyString(input.agent_transcript_path)) ?? sessionModel(input, session, undefined)
  ),
  subagent_start: (input, session, projectDir) => {
    const toolInput = asRecord(input.tool_input);
    return nonEmptyString(toolInput.model)
      ?? modelFromAgentDefinition(nonEmptyString(toolInput.subagent_type), { projectDir })
      ?? sessionModel(input, session, projectDir);
  },
  question: sessionModel,
  permission: sessionModel,
  error: sessionModel,
  // Usage-limit events come from the status line, not a hook, and belong to no model.
  usage_5h_near: () => null,
  usage_5h_reset: () => null,
  usage_week_near: () => null,
  usage_week_reset: () => null,
});

/**
 * Map hook input to the sound event it signals.
 * @param {HookInput} input
 * @returns {EventName | null} Null when the input should not play a sound.
 */
export function eventFor(input) {
  return lookup(SOUND_HOOKS, input.hook_event_name)?.(input) ?? null;
}

/**
 * Work out which model the event belongs to.
 * @param {HookInput} input
 * @param {Session} session
 * @param {string | undefined} projectDir
 * @returns {string | null} A model id or alias, or null when unknown.
 */
export function modelFor(input, session, projectDir) {
  const event = eventFor(input);
  return event ? MODEL_SOURCES[event](input, session, projectDir) : null;
}

/**
 * Handle one hook invocation: stop a pending reminder, update session state,
 * then gate and play the event's sound and start any reminders it needs.
 * Playback failures are logged, not thrown.
 * @param {HookInput} input
 * @param {Deps} [deps]
 * @returns {Promise<Outcome>}
 */
export async function handle(input, deps = {}) {
  const {
    play = defaultPlay,
    speak = defaultSpeak,
    dataDir = defaultDataDir(),
    pluginRoot = defaultPluginRoot(),
    spawnDetached = defaultSpawnDetached,
  } = deps;
  const hook = String(input.hook_event_name);
  const sessionId = nonEmptyString(input.session_id) ?? '';
  const roots = { dataDir, pluginRoot };

  // Claude Code also sends a permission prompt for a question dialog it shows.
  if (sessionId && eventFor(input) === 'permission' && readAttention(dataDir, sessionId)?.event === 'question') {
    return finish(hook, {
      status: 'ignored',
      event: null,
      model: null,
      family: null,
      detail: 'permission prompt for the pending question',
    });
  }
  // Any later hook in the session means the question or error was dealt with.
  if (sessionId && clearAttention(dataDir, sessionId)) {
    log('debug', `hook: ${hook} stopped the reminder for session ${sessionId}`);
  }
  if (hook === 'SessionStart') {
    // Plugin updates move CLAUDE_PLUGIN_ROOT, which the status line shim imports from.
    refreshShim(roots);
  }
  const record = lookup(STATE_HOOKS, input.hook_event_name);
  const recorded = record ? record(openSession(dataDir, sessionId), input) : null;
  if (sessionId && TURN_END_HOOKS.includes(hook)) {
    leaveUsageReminders(dataDir, WINDOW_NAMES, sessionId);
  }

  const event = eventFor(input);
  if (!event) {
    if (recorded !== null) {
      return finish(hook, { status: 'recorded', event: null, model: null, family: null, detail: recorded });
    }
    const subject = nonEmptyString(input.tool_name) ?? nonEmptyString(input.notification_type);
    const detail = subject ? `nothing to play for ${subject}` : 'nothing to play';
    return finish(hook, { status: 'ignored', event: null, model: null, family: null, detail });
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || nonEmptyString(input.cwd) || undefined;
  const config = loadConfig({ dataDir, projectDir });
  const session = openSession(dataDir, sessionId);
  const model = modelFor(input, session, projectDir);
  const family = familyOf(model, config.modelPatterns);

  const result = await playEvent(config, event, { family, session, play, speak, dataDir, pluginRoot });
  if (event === 'agent_start') {
    await remindUsageOnPrompt(config, input, sessionId, { play, speak, spawnDetached, ...roots });
  }
  if (sessionId && isAttentionEvent(event)) {
    // Recorded even when it does not repeat, so the question's own permission prompt is recognized.
    const transcriptPath = nonEmptyString(input.transcript_path);
    const reminder = setAttention(dataDir, sessionId, { event, family, transcriptPath, projectDir: projectDir ?? null });
    if ((config.events[event].repeatMs ?? 0) > 0 && canSound(config, event)) {
      spawnDetached('remind.js', ['attention', sessionId, reminder.id], roots);
    }
  }
  return finish(hook, { ...result, event, model, family });
}

/**
 * On a prompt, for each usage window past a threshold: play its "near" sound
 * again if `remindOnPrompt` is on, and join the repeater that plays it while
 * the turn runs if `repeatWhileWorkingMs` is set.
 * @param {Config} config
 * @param {HookInput} input
 * @param {string} sessionId
 * @param {Required<Deps>} deps
 * @returns {Promise<void>}
 */
async function remindUsageOnPrompt(config, input, sessionId, deps) {
  const { dataDir, pluginRoot, spawnDetached } = deps;
  for (const window of hitWindows(readUsageState(dataDir), Date.now() / 1000)) {
    const near = WINDOWS[window].near;
    const { repeatWhileWorkingMs = 0, remindOnPrompt = false } = config.events[near];
    if (sessionId && repeatWhileWorkingMs > 0 && canSound(config, near)
      && joinUsageReminder(dataDir, window, sessionId, nonEmptyString(input.transcript_path))) {
      spawnDetached('remind.js', ['usage', window], { dataDir, pluginRoot });
    }
    if (remindOnPrompt) {
      const { status, detail } = await playEvent(config, near, deps);
      log('debug', `hook: UserPromptSubmit event=${near} reminder ${status}: ${detail}`);
    }
  }
}

/**
 * @param {Session} session
 * @returns {string}
 */
function endTurn(session) {
  session.markTurnEnd();
  return 'turn end';
}

/**
 * @param {Session} session
 * @param {unknown} model
 * @returns {string}
 */
function recordModel(session, model) {
  const id = nonEmptyString(model);
  if (!id) {
    return 'no model in input';
  }
  session.setModel(id);
  return `model ${id}`;
}

/**
 * Log the one debug line for this invocation and return the outcome.
 * @param {string} hook
 * @param {Outcome} outcome
 * @returns {Outcome}
 */
function finish(hook, outcome) {
  const { status, event, model, family, detail } = outcome;
  const context = event ? ` event=${event} model=${model ?? 'unknown'} family=${family}` : '';
  log('debug', `hook: ${hook}${context} ${status}: ${detail}`);
  return outcome;
}

/**
 * Own-property lookup, so input such as 'constructor' never hits the prototype.
 * @template T
 * @param {Readonly<Record<string, T>>} table
 * @param {unknown} key
 * @returns {T | undefined}
 */
function lookup(table, key) {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * @param {unknown} value
 * @returns {HookInput}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {HookInput} */ (value)
    : {};
}

/**
 * @param {string} text
 * @returns {HookInput | null}
 */
function parseInput(text) {
  if (!text.trim()) {
    return null;
  }
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read all of stdin, giving up after `timeoutMs`.
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    const done = () => {
      clearTimeout(timer);
      // An open stdin would otherwise keep the process alive after a timeout.
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.once('end', done);
    process.stdin.once('error', done);
  });
}

/**
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    // Node resolves symlinks in the main module's URL, so compare real paths.
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/**
 * Async hook output reaches Claude on the next turn, so this never writes to
 * stdout or stderr and always leaves the exit code at 0.
 * @returns {Promise<void>}
 */
async function main() {
  process.exitCode = 0;
  /** @param {unknown} err */
  const onUncaught = (err) => {
    log('error', 'hook: uncaught error', err);
    process.exitCode = 0;
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  try {
    const text = await readStdin(STDIN_TIMEOUT_MS);
    const input = parseInput(text);
    if (!input) {
      log('debug', `hook: ignoring empty or invalid input (${text.length} chars)`);
      return;
    }
    await handle(input);
  } catch (err) {
    log('error', 'hook: failed', err);
  }
}

if (isEntryPoint()) {
  main();
}
