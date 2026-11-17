// @ts-check
// The settings page server: 127.0.0.1 only, a random port, a per-launch token, an idle timeout.
// Run directly it prints one JSON line {url, pid} and keeps serving; scripts/cli.js starts it detached.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configPath, dataDir as defaultDataDir, defaultConfig, loadConfig, saveConfig, validateConfig } from '../lib/config.js';

export const HOST = '127.0.0.1';
export const TOKEN_HEADER = 'x-pace-token';
export const MAX_BODY_BYTES = 16 * 1024;
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const PAGE = fileURLToPath(new URL('./index.html', import.meta.url));
const UI_FILE = 'ui.json';

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @returns {void}
 */
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/**
 * Read a JSON body of at most MAX_BODY_BYTES.
 * @param {http.IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      reject(new HttpError(415, 'Content-Type must be application/json'));
      return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'Body too large'));
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (/** @type {Buffer} */ chunk) => {
      if (failed) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => reject(err));
    req.on('end', () => {
      if (failed) {
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON'));
      }
    });
  });
}

/**
 * @typedef {{ url: string, token: string, port: number, close: () => Promise<void> }} Running
 */

/**
 * Start the server.
 * @param {{ dataDir?: string, idleMs?: number, port?: number, onClose?: () => void }} [options]
 * @returns {Promise<Running>}
 */
export async function startServer({ dataDir = defaultDataDir(), idleMs = DEFAULT_IDLE_MS, port = 0, onClose } = {}) {
  const token = randomBytes(24).toString('hex');
  const tokenBuffer = Buffer.from(token);
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer;
  /** @type {Promise<void> | undefined} */
  let closing;
  let allowedHosts = new Set();
  let allowedOrigins = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((/** @type {unknown} */ err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      } else {
        res.destroy();
      }
      process.stderr.write(`pace-maker ui: ${req.method} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
  server.on('error', () => {});

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handle(req, res) {
    resetIdleTimer();
    try {
      if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) {
        throw new HttpError(403, 'Forbidden host');
      }
      const reqUrl = new URL(req.url ?? '/', `http://${HOST}`);
      const { origin } = req.headers;
      if (origin !== undefined && req.method !== 'GET' && !allowedOrigins.has(origin.toLowerCase())) {
        throw new HttpError(403, 'Forbidden origin');
      }
      authorize(req, reqUrl);
      const route = `${req.method} ${reqUrl.pathname}`;
      if (route === 'GET /') {
        sendPage(res);
      } else if (route === 'GET /api/config') {
        sendJson(res, 200, { config: loadConfig(dataDir), defaults: defaultConfig(), path: configPath(dataDir) });
      } else if (route === 'PUT /api/config') {
        const checked = validateConfig(await readJson(req));
        if (!checked.ok) {
          throw new HttpError(400, checked.errors.join('; '));
        }
        saveConfig(checked.value, dataDir);
        sendJson(res, 200, { config: checked.value, path: configPath(dataDir) });
      } else if (route === 'POST /api/close') {
        sendJson(res, 200, { ok: true });
        res.on('finish', () => {
          void close();
        });
      } else if (route === 'GET /api/ping') {
        sendJson(res, 200, { ok: true });
      } else {
        throw new HttpError(404, 'Not found');
      }
    } catch (err) {
      if (!(err instanceof HttpError)) {
        throw err;
      }
      if (err.status === 413) {
        res.setHeader('Connection', 'close');
        res.on('finish', () => req.destroy());
      }
      sendJson(res, err.status, { error: err.message });
    }
  }

  /**
   * The token comes in a header (API) or the page URL's query (the page itself, which then sends it as a header).
   * @param {http.IncomingMessage} req
   * @param {URL} reqUrl
   * @returns {void}
   */
  function authorize(req, reqUrl) {
    const header = req.headers[TOKEN_HEADER];
    const given = typeof header === 'string' ? header : reqUrl.pathname === '/' ? reqUrl.searchParams.get('token') : null;
    const givenBuffer = Buffer.from(given ?? '');
    if (givenBuffer.length !== tokenBuffer.length || !timingSafeEqual(givenBuffer, tokenBuffer)) {
      throw new HttpError(401, 'Invalid or missing token');
    }
  }

  /**
   * @param {http.ServerResponse} res
   * @returns {void}
   */
  function sendPage(res) {
    const html = fs.readFileSync(PAGE);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(html);
  }

  /** Every request moves the shutdown back; nothing else keeps the process alive. */
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void close();
    }, idleMs);
    idleTimer.unref();
  }

  /** @returns {Promise<void>} */
  function close() {
    closing ??= new Promise((resolve) => {
      clearTimeout(idleTimer);
      server.close(() => {
        try {
          onClose?.();
        } catch { /* ignore */ }
        resolve();
      });
      server.closeAllConnections?.();
    });
    return closing;
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(undefined));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  allowedHosts = new Set([`${HOST}:${address.port}`, `localhost:${address.port}`]);
  allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));
  resetIdleTimer();
  // The idle timer is unref'd: the listening socket is what keeps the process alive.
  return { url: `http://${HOST}:${address.port}/?token=${token}`, token, port: address.port, close };
}

// ---- Entry: node server.js [--data-dir <dir>] [--idle-ms <n>] ---------------------------------------------------

/** @returns {boolean} */
function isMain() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

/**
 * @param {string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * Is a server from an earlier launch still answering for this data dir? Then its URL is reused.
 * @param {string} dir
 * @returns {Promise<{ url: string, pid: number } | null>}
 */
async function findRunning(dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, UI_FILE), 'utf8'));
    if (typeof info?.url !== 'string' || typeof info?.pid !== 'number') {
      return null;
    }
    const pageUrl = new URL(info.url);
    const res = await fetch(new URL('/api/ping', pageUrl), {
      headers: { [TOKEN_HEADER]: pageUrl.searchParams.get('token') ?? '' },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? { url: info.url, pid: info.pid } : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dir = flag(args, '--data-dir');
  if (dir) {
    process.env.PACE_MAKER_DATA_DIR = path.resolve(dir);
  }
  const dataDir = defaultDataDir();
  const idleMs = Number(flag(args, '--idle-ms')) || DEFAULT_IDLE_MS;
  const running = await findRunning(dataDir);
  if (running) {
    process.stdout.write(`${JSON.stringify(running)}\n`);
    return;
  }
  const uiFile = path.join(dataDir, UI_FILE);
  const { url, close } = await startServer({
    dataDir,
    idleMs,
    onClose: () => {
      try {
        fs.rmSync(uiFile, { force: true });
      } catch { /* ignore */ }
    },
  });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(uiFile, JSON.stringify({ url, pid: process.pid }), { mode: 0o600 });
  } catch { /* reuse is optional */ }
  const shutdown = () => {
    void close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdout.write(`${JSON.stringify({ url, pid: process.pid })}\n`);
}

if (isMain()) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
