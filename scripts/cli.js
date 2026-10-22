// @ts-check
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  EVENTS,
  EVENT_LABELS,
  effectiveVolume,
  loadConfig,
  resolveSound,
  saveConfig,
} from './lib/config.js';
import { dataDir } from './lib/paths.js';
import { backend, play, speak } from './lib/player/index.js';
import { ttsBackend } from './lib/player/tts.js';
import { isQuietTime } from './lib/state.js';

const PREFIX = 'claudio-notify';
const TEST_GAP_MS = 300;
const DEFAULT_MODEL_FAMILY = 'other';

/** Flags that take a value; any other flag is rejected. */
const VALUE_FLAGS = Object.freeze(['data-dir', 'model']);

/**
 * @typedef {object} Invocation
 * @property {string[]} args Positional arguments after the command name.
 * @property {Record<string, string>} flags Flag values keyed by name without '--'.
 */

/**
 * @typedef {object} Command
 * @property {string} summary One line shown in the help text.
 * @property {string} [usage] Argument synopsis shown in the help text.
 * @property {(invocation: Invocation) => Promise<number | void> | number | void} run
 *   Returns the exit code, 0 by default.
 */

/**
 * Split argv into a command name, positional arguments and flag values.
 * @param {string[]} argv
 * @returns {{ command: string | undefined, args: string[], flags: Record<string, string> }}
 * @throws {Error} On an unknown flag or a flag without a value.
 */
function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!VALUE_FLAGS.includes(name)) {
      throw new Error(`unknown option ${arg}`);
    }
    const value = argv[++i];
    if (value === undefined) {
      throw new Error(`option ${arg} needs a value`);
    }
    flags[name] = value;
  }
  const [command, ...args] = positional;
  return { command, args, flags };
}

/**
 * Only the global config is touched: saving a merged project config would
 * leak project overrides into the global file.
 * @param {boolean} muted
 * @returns {void}
 */
function setMuted(muted) {
  const config = loadConfig({ dataDir: dataDir() });
  config.muted = muted;
  saveConfig(config, { dataDir: dataDir() });
  console.log(`${PREFIX}: sounds ${muted ? 'muted' : 'unmuted'}.`);
}

/**
 * @param {Array<[string, string]>} rows
 * @returns {string[]}
 */
function alignRows(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}

/** @returns {void} */
function status() {
  const config = loadConfig({ dataDir: dataDir() });
  const { enabled, from, to } = config.quietHours;
  const quietHours = enabled
    ? `${from}-${to} (${isQuietTime(config.quietHours) ? 'active now' : 'inactive now'})`
    : 'off';

  /** @type {Array<[string, string]>} */
  const rows = [
    ['Enabled', config.enabled ? 'yes' : 'no'],
    ['Muted', config.muted ? 'yes' : 'no'],
    ['Quiet hours', quietHours],
    ['Volume', `${Math.round(config.volume * 100)}%`],
    ...EVENTS.map((event) => {
      const eventConfig = config.events[event];
      return /** @type {[string, string]} */ ([
        event,
        `${eventConfig.enabled ? 'on ' : 'off'}  ${eventConfig.sound}`,
      ]);
    }),
    ['Audio backend', backend() ?? 'none found'],
    ['TTS backend', ttsBackend() ?? 'none found'],
    ['Data dir', dataDir()],
    ['Config file', path.join(dataDir(), 'config.json')],
  ];
  console.log(alignRows(rows).join('\n'));
}

/**
 * @param {Invocation} invocation
 * @returns {Promise<number>}
 */
async function test({ args, flags }) {
  const target = args[0] ?? 'all';
  const known = EVENTS.find((event) => event === target);
  if (target !== 'all' && !known) {
    console.error(`${PREFIX}: unknown event '${target}'. Valid events: all, ${EVENTS.join(', ')}`);
    return 1;
  }

  const config = loadConfig({ dataDir: dataDir() });
  const family = flags.model ?? DEFAULT_MODEL_FAMILY;
  if (config.muted) {
    console.log(`${PREFIX}: sounds are muted; playing anyway because this is an explicit test.`);
  }

  const events = EVENTS.filter((event) => (known ? event === known : config.events[event].enabled));
  let failures = 0;
  for (const [index, event] of events.entries()) {
    if (index > 0) {
      await sleep(TEST_GAP_MS);
    }
    const sound = resolveSound(config, event, family);
    const options = { volume: effectiveVolume(config, event) };
    console.log(`▶ ${event} (${EVENT_LABELS[event]}): ${sound.kind === 'file' ? sound.value : 'speech'}`);
    try {
      await (sound.kind === 'file' ? play(sound.value, options) : speak(sound.value, options));
    } catch (err) {
      failures++;
      console.error(`${PREFIX}: ${event} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failures > 0 ? 1 : 0;
}

/**
 * Subcommands by name, used for both dispatch and the help text, so a new
 * command only needs an entry here.
 * @type {Readonly<Record<string, Command>>}
 */
const COMMANDS = Object.freeze({
  mute: { summary: 'Silence all sounds', run: () => setMuted(true) },
  unmute: { summary: 'Turn sounds back on', run: () => setMuted(false) },
  status: { summary: 'Show settings and detected audio backends', run: status },
  test: {
    summary: 'Play the sound of one event, or of every enabled event',
    usage: '[event|all] [--model <family>]',
    run: test,
  },
  help: { summary: 'Show this help', run: () => printHelp() },
});

/** @returns {void} */
function printHelp() {
  const rows = Object.entries(COMMANDS).map(
    ([name, { summary, usage }]) => /** @type {[string, string]} */ ([
      usage ? `${name} ${usage}` : name,
      summary,
    ]),
  );
  console.log([
    'Usage: node scripts/cli.js <command> [args] [--data-dir <dir>]',
    '',
    'Commands:',
    ...alignRows(rows).map((line) => `  ${line}`),
    '',
    'Options:',
    '  --data-dir <dir>  Directory holding config.json (default: the plugin data dir)',
  ].join('\n'));
}

/**
 * Run the CLI.
 * @param {string[]} argv Arguments without the node and script path.
 * @returns {Promise<number>} The process exit code.
 */
export async function main(argv) {
  try {
    const { command = 'help', args, flags } = parseArgs(argv);
    if (flags['data-dir']) {
      process.env.CLAUDIO_DATA_DIR = path.resolve(flags['data-dir']);
    }
    if (!Object.hasOwn(COMMANDS, command)) {
      console.error(`${PREFIX}: unknown command '${command}'. Run 'help' for usage.`);
      return 1;
    }
    return (await COMMANDS[command].run({ args, flags })) ?? 0;
  } catch (err) {
    console.error(`${PREFIX}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
