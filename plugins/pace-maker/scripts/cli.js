// @ts-check
// pace-maker launcher. `node cli.js config [--no-open] [--data-dir <dir>]` starts the settings page server detached,
// waits until it is ready, prints ONLY its URL on stdout and exits at once (the /pace config command runs this).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = fileURLToPath(new URL('./ui/server.js', import.meta.url));
const START_TIMEOUT_MS = 8000;

/**
 * Start (or reuse) the server and resolve with its page URL once it has printed it.
 * @param {string[]} serverArgs
 * @returns {Promise<string>}
 */
function startServer(serverArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, ...serverArgs], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    /**
     * @param {Error | null} err
     * @param {string} [url]
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
    const timer = setTimeout(() => settle(new Error('timed out waiting for the settings server')), START_TIMEOUT_MS);
    child.on('error', (err) => settle(err));
    child.on('exit', () => settle(new Error('the settings server exited before it was ready')));
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      output += chunk.toString('utf8');
      const end = output.indexOf('\n');
      if (end === -1) {
        return;
      }
      try {
        const info = JSON.parse(output.slice(0, end));
        settle(typeof info?.url === 'string' ? null : new Error('the settings server printed no URL'), info?.url);
      } catch {
        settle(new Error('the settings server printed invalid output'));
      }
    });
  });
}

/**
 * Open a URL in the default browser without waiting for it; the URL is printed anyway.
 * @param {string} url
 * @returns {void}
 */
function openBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const opener = spawn(/** @type {string} */ (command), /** @type {string[]} */ (args), { detached: true, stdio: 'ignore', windowsHide: true });
    opener.on('error', () => {});
    opener.unref();
  } catch { /* ignore */ }
}

/**
 * @param {string[]} argv Arguments without the node and script path.
 * @returns {Promise<number>} The exit code.
 */
export async function main(argv) {
  const [command = 'help', ...rest] = argv;
  if (command !== 'config') {
    console.error('Usage: node cli.js config [--no-open] [--data-dir <dir>]');
    return command === 'help' ? 0 : 1;
  }
  /** @type {string[]} */
  const serverArgs = [];
  const dir = rest.indexOf('--data-dir');
  if (dir !== -1) {
    const value = rest[dir + 1];
    if (!value) {
      console.error('pace-maker: --data-dir needs a directory');
      return 1;
    }
    serverArgs.push('--data-dir', path.resolve(value));
  }
  const idle = rest.indexOf('--idle-ms');
  if (idle !== -1 && rest[idle + 1]) {
    serverArgs.push('--idle-ms', String(rest[idle + 1]));
  }
  try {
    const url = await startServer(serverArgs);
    if (!rest.includes('--no-open')) {
      openBrowser(url);
    }
    console.log(url);
    return 0;
  } catch (err) {
    console.error(`pace-maker: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
