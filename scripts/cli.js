// @ts-check
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EVENTS,
  EVENT_LABELS,
  effectiveVolume,
  loadConfig,
  resolveSound,
  saveConfig,
} from './lib/config.js';
import { dataDir, pluginRoot } from './lib/paths.js';
import { backend, play, speak } from './lib/player/index.js';
import { ttsBackend } from './lib/player/tts.js';
import { isQuietTime } from './lib/state.js';
import { applySetup, planSetup, readSetupRecord, teardown } from './lib/statusline.js';
import { timerRunning } from './usage.js';

const PREFIX = 'claudio-notify';
const TEST_GAP_MS = 300;
const DEFAULT_MODEL_FAMILY = 'other';
const SERVER_START_TIMEOUT_MS = 10000;

/** Flags that take a value; any other flag is rejected. */
const VALUE_FLAGS = Object.freeze(['data-dir', 'model', 'settings']);
/** Flags that take no value and are stored as 'true'. */
const BOOLEAN_FLAGS = Object.freeze(['no-open', 'yes']);

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
    if (BOOLEAN_FLAGS.includes(name)) {
      flags[name] = 'true';
      continue;
    }
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
    ['Usage alerts', usageStatus(config.usageResetTimer)],
    ['Audio backend', backend() ?? 'none found'],
    ['TTS backend', ttsBackend() ?? 'none found'],
    ['Data dir', dataDir()],
    ['Config file', path.join(dataDir(), 'config.json')],
  ];
  console.log(alignRows(rows).join('\n'));
}

/**
 * @param {boolean} timerEnabled
 * @returns {string}
 */
function usageStatus(timerEnabled) {
  if (!readSetupRecord(dataDir())) {
    return 'not set up (run /claudio-notify:setup-usage)';
  }
  const timer = timerEnabled ? `reset timer ${timerRunning(dataDir()) ? 'running' : 'idle'}` : 'reset timer off';
  return `set up through the status line, ${timer}`;
}

/**
 * @param {import('./lib/statusline.js').StatusLine | null} statusLine
 * @returns {string}
 */
function describeStatusLine(statusLine) {
  return statusLine?.command ? statusLine.command : '(none)';
}

/**
 * Show what usage-limit setup changes, and apply it with --yes.
 * @param {Invocation} invocation
 * @returns {number}
 */
function setupUsage({ flags }) {
  const roots = { dataDir: dataDir(), pluginRoot: pluginRoot() };
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const plan = planSetup({ dataDir: roots.dataDir, settingsFile: flags.settings && path.resolve(flags.settings), projectDir });
  if (plan.status === 'installed') {
    applySetup(plan, roots);
    console.log(`${PREFIX}: usage-limit sounds are already set up. Nothing to change.`);
    console.log(`Status line: ${describeStatusLine(plan.next)}`);
    return 0;
  }
  if (flags.yes === 'true') {
    applySetup(plan, roots);
    console.log(`${PREFIX}: usage-limit sounds are set up. They start with the next status line update.`);
    console.log('Undo with /claudio-notify:teardown-usage.');
    return 0;
  }
  const lines = [
    `${PREFIX}: usage-limit sounds need your status line, the only place Claude Code shares limit data.`,
    '',
    `Planned change to statusLine.command in ${plan.settingsFile}:`,
    `  now:   ${describeStatusLine(plan.previous)}`,
    `  after: ${describeStatusLine(plan.next)}`,
    '',
    plan.previous?.command
      ? 'Your status line shows the same output as before: the shim reads the limit data and passes it on to your command unchanged.'
      : 'You have no status line now, so it stays empty. Note that with any custom status line, Claude Code hides most footer key hints.',
    `The shim is ${plan.shimFile}. Each session start points it at the current plugin version.`,
    `settings.json is backed up to ${plan.backupFile} first.`,
    '',
    'Limit data only reaches the status line on Pro and Max plans, after the first response in a session.',
    'Undo with /claudio-notify:teardown-usage, and run it before uninstalling claudio-notify,',
    'because uninstalling can delete the plugin data directory and the shim with it.',
    ...plan.warnings.map((warning) => `Warning: ${warning}`),
  ];
  console.log(lines.join('\n'));
  return 0;
}

/**
 * Restore the status line from before setup.
 * @param {Invocation} invocation
 * @returns {number}
 */
function teardownUsage({ flags }) {
  const result = teardown({ dataDir: dataDir(), settingsFile: flags.settings && path.resolve(flags.settings) });
  if (result.status === 'not-installed') {
    console.log(`${PREFIX}: usage-limit sounds are not set up. Nothing to change.`);
  } else if (result.status === 'changed') {
    console.log(`${PREFIX}: your status line no longer used claudio-notify, so ${result.settingsFile} was left as is. Usage-limit sounds are off.`);
  } else {
    console.log(`${PREFIX}: usage-limit sounds are off. Status line restored to: ${describeStatusLine(result.restored)}`);
  }
  return 0;
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
 * Parse the server's first stdout line.
 * @param {string} line
 * @returns {string | null} The page URL, or null if the line is not valid.
 */
function parseServerUrl(line) {
  try {
    const info = JSON.parse(line);
    return typeof info?.url === 'string' ? info.url : null;
  } catch {
    return null;
  }
}

/**
 * Start the settings server, or reuse the one already running for this data
 * dir, and resolve with its page URL once it has printed it.
 * @param {string} serverPath
 * @returns {Promise<string>}
 */
function startSettingsServer(serverPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath, '--data-dir', dataDir()], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    /**
     * @param {Error | null} err
     * @param {string} [url]
     * @returns {void}
     */
    const settle = (err, url = '') => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      if (err) {
        child.kill();
        reject(err);
        return;
      }
      child.unref();
      resolve(url);
    };
    const timer = setTimeout(
      () => settle(new Error('timed out waiting for the settings server')),
      SERVER_START_TIMEOUT_MS,
    );
    child.on('error', (err) => settle(err));
    child.on('exit', () => settle(new Error('settings server exited before printing its URL')));
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      output += chunk.toString('utf8');
      const newline = output.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const url = parseServerUrl(output.slice(0, newline));
      settle(url === null ? new Error('settings server printed invalid output') : null, url ?? '');
    });
  });
}

/**
 * Open a URL in the default browser without waiting for it. Spawn errors are
 * ignored because the URL is printed as well.
 * @param {string} url
 * @returns {void}
 */
function openBrowser(url) {
  /** @type {string} */
  let command;
  /** @type {string[]} */
  let args;
  if (process.platform === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  opener.on('error', () => {});
  opener.unref();
}

/**
 * Start or reuse the settings server, then open its page unless --no-open is set.
 * @param {Invocation} invocation
 * @returns {Promise<number>}
 */
async function openSettings({ flags }) {
  /** @type {string} */
  let url;
  try {
    url = await startSettingsServer(fileURLToPath(new URL('./ui/server.js', import.meta.url)));
  } catch (err) {
    console.error(`${PREFIX}: cannot open settings: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (flags['no-open'] !== 'true') {
    openBrowser(url);
  }
  console.log(`${PREFIX}: settings page at ${url}`);
  console.log('The page closes its server when you click Done, or after 10 minutes idle.');
  return 0;
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
  config: {
    summary: 'Open the settings page in your browser',
    usage: '[--no-open]',
    run: openSettings,
  },
  'setup-usage': {
    summary: 'Show how usage-limit sounds hook into the status line; --yes applies it',
    usage: '[--yes] [--settings <file>]',
    run: setupUsage,
  },
  'teardown-usage': {
    summary: 'Turn usage-limit sounds off and restore the previous status line',
    usage: '[--settings <file>]',
    run: teardownUsage,
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
    '  --data-dir <dir>   Directory holding config.json (default: the plugin data dir)',
    '  --settings <file>  Claude Code settings file to edit (default: ~/.claude/settings.json)',
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
