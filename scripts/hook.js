// @ts-check
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, effectiveVolume, loadConfig, resolveSound } from './lib/config.js';
import { log } from './lib/log.js';
import { familyOf, modelFromAgentDefinition, modelFromTranscript } from './lib/model.js';
import { dataDir as defaultDataDir, pluginRoot as defaultPluginRoot } from './lib/paths.js';
import { play as defaultPlay, speak as defaultSpeak } from './lib/player/index.js';
import { isQuietTime, openSession, tryAcquire } from './lib/state.js';

/** @typedef {import('./lib/config.js').Config} Config */
/** @typedef {import('./lib/config.js').EventName} EventName */
/** @typedef {import('./lib/config.js').ResolvedSound} ResolvedSound */
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
 * Hooks that only update session state.
 * @type {Readonly<Record<string, (session: Session, input: HookInput) => string>>}
 */
const STATE_HOOKS = Object.freeze({
  UserPromptSubmit: (session) => {
    session.markTurnStart();
    return 'turn start';
  },
  SessionStart: (session, input) => recordModel(session, input.model),
  PostModelSwitch: (session, input) => recordModel(session, input.to_model),
});

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
  Stop: () => 'agent_done',
  SubagentStop: () => 'subagent_done',
  StopFailure: () => 'error',
  PreToolUse: (input) => lookup(TOOL_EVENTS, input.tool_name) ?? null,
  Notification: (input) => (input.notification_type === 'permission_prompt' ? 'permission' : null),
});

/** @type {ModelSource} */
const sessionModel = (_input, session) => session.getModel();

/** @type {Readonly<Record<EventName, ModelSource>>} */
const MODEL_SOURCES = Object.freeze({
  agent_done: (input, session) => modelFromTranscript(nonEmptyString(input.transcript_path)) ?? session.getModel(),
  subagent_done: (input, session) => (
    modelFromTranscript(nonEmptyString(input.agent_transcript_path)) ?? session.getModel()
  ),
  subagent_start: (input, session, projectDir) => {
    const toolInput = asRecord(input.tool_input);
    return nonEmptyString(toolInput.model)
      ?? modelFromAgentDefinition(nonEmptyString(toolInput.subagent_type), { projectDir })
      ?? session.getModel();
  },
  question: sessionModel,
  permission: sessionModel,
  error: sessionModel,
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
 * Handle one hook invocation: update session state, or gate and play the
 * event's sound. Playback failures are logged, not thrown.
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
  } = deps;
  const hook = String(input.hook_event_name);
  const sessionId = nonEmptyString(input.session_id) ?? '';

  const record = lookup(STATE_HOOKS, input.hook_event_name);
  if (record) {
    const detail = record(openSession(dataDir, sessionId), input);
    return finish(hook, { status: 'recorded', event: null, model: null, family: null, detail });
  }

  const event = eventFor(input);
  if (!event) {
    const subject = nonEmptyString(input.tool_name) ?? nonEmptyString(input.notification_type);
    const detail = subject ? `nothing to play for ${subject}` : 'nothing to play';
    return finish(hook, { status: 'ignored', event: null, model: null, family: null, detail });
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || nonEmptyString(input.cwd) || undefined;
  const config = loadConfig({ dataDir, projectDir });
  const session = openSession(dataDir, sessionId);
  const model = modelFor(input, session, projectDir);
  const family = familyOf(model, config.modelPatterns);

  const reason = skipReason(config, event, session, dataDir);
  if (reason) {
    return finish(hook, { status: 'skipped', event, model, family, detail: reason });
  }

  const volume = effectiveVolume(config, event);
  const roots = { pluginRoot, dataDir };
  const sound = resolveSound(config, event, family, roots);
  // DEFAULTS has no overrides, so this resolves to the event's bundled sound.
  const bundled = resolveSound(DEFAULTS, event, family, roots);
  const attempts = sound.kind === bundled.kind && sound.value === bundled.value ? [sound] : [sound, bundled];
  for (const attempt of attempts) {
    try {
      if (attempt.kind === 'tts') {
        await speak(attempt.value, { volume });
      } else {
        await play(attempt.value, { volume });
      }
      const detail = attempt === sound ? describe(attempt) : `${describe(attempt)} (fallback)`;
      return finish(hook, { status: 'played', event, model, family, detail });
    } catch (err) {
      log('warn', `hook: cannot play ${describe(attempt)}`, err);
    }
  }
  return finish(hook, { status: 'failed', event, model, family, detail: attempts.map(describe).join(', then ') });
}

/**
 * @param {Config} config
 * @param {EventName} event
 * @param {Session} session
 * @param {string} dataDir
 * @returns {string | null} Why the sound should not play, or null to play it.
 */
function skipReason(config, event, session, dataDir) {
  if (!config.enabled) {
    return 'plugin disabled';
  }
  if (config.muted) {
    return 'muted';
  }
  if (isQuietTime(config.quietHours)) {
    return 'quiet hours';
  }
  if (!config.events[event].enabled) {
    return 'event disabled';
  }
  if (event === 'agent_done') {
    const seconds = session.turnSeconds();
    if (seconds !== null && seconds < config.minTurnSeconds) {
      return `turn took ${seconds.toFixed(1)}s, under minTurnSeconds ${config.minTurnSeconds}`;
    }
  }
  // Last, so an event skipped for another reason does not start a cooldown.
  if (!tryAcquire(dataDir, event, config.cooldownMs)) {
    return 'cooldown';
  }
  return null;
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
 * @param {ResolvedSound} sound
 * @returns {string}
 */
function describe(sound) {
  return sound.kind === 'tts' ? `tts "${sound.value}"` : sound.value;
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
