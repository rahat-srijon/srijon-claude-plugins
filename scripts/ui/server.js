// @ts-check
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_EVENTS,
  BUNDLED_SOUNDS,
  DEFAULTS,
  EVENTS,
  EVENT_LABELS,
  loadConfig,
  parseSoundSpec,
  resolveSound,
  saveConfig,
  ttsText,
} from '../lib/config.js';
import { log } from '../lib/log.js';
import { dataDir as defaultDataDir, pluginRoot as defaultPluginRoot } from '../lib/paths.js';
import { backend, play, speak } from '../lib/player/index.js';
import { ttsBackend } from '../lib/player/tts.js';

/** @typedef {import('../lib/config.js').Config} Config */
/** @typedef {import('../lib/config.js').EventName} EventName */

/**
 * @typedef {object} ServerOptions
 * @property {string} [dataDir] Directory holding the global config and uploads.
 * @property {string} [pluginRoot] Directory holding the bundled `sounds/`.
 * @property {number} [port] 0 picks a free port.
 * @property {number} [idleMs] Shut down after this long without an API request.
 */

/**
 * @typedef {object} RunningServer
 * @property {string} url Page URL including the token.
 * @property {string} token
 * @property {() => Promise<void>} close
 */

/** @typedef {{ id: string, label: string, source: 'bundled' | 'user' | 'tts' }} SoundEntry */

/**
 * @typedef {object} RequestContext
 * @property {http.IncomingMessage} req
 * @property {http.ServerResponse} res
 * @property {URL} url
 */

const HOST = '127.0.0.1';
const TOKEN_HEADER = 'x-claudio-token';
const MAX_JSON_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const PING_TIMEOUT_MS = 2000;
const CLOSE_GRACE_MS = 5000;
const AUDIO_EXT_RE = /\.(?:wav|mp3)$/i;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
// Windows maps these names to devices whatever the extension.
const RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:";
const PAGE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

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
 * Start the settings UI server on 127.0.0.1.
 * @param {ServerOptions} [options]
 * @returns {Promise<RunningServer>}
 */
export async function startServer(options = {}) {
  const {
    dataDir = defaultDataDir(),
    pluginRoot = defaultPluginRoot(),
    port = 0,
    idleMs = 600000,
  } = options;
  const token = randomBytes(24).toString('hex');
  const tokenBuffer = Buffer.from(token);
  const soundsDir = path.join(dataDir, 'sounds');
  const uiFile = path.join(dataDir, 'ui.json');

  /** @type {Promise<void>} */
  let previewQueue = Promise.resolve();
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let graceTimer;
  /** @type {Promise<void> | undefined} */
  let closing;
  let allowedHosts = new Set();
  let allowedOrigins = new Set();
  let url = '';

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('error', `ui: ${req.method} ${req.url} failed`, err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      } else {
        res.destroy();
      }
    });
  });
  server.on('error', (err) => log('error', 'ui: server error', err));

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handle(req, res) {
    req.on('error', (err) => log('warn', 'ui: request stream error', err));
    if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) {
      sendJson(res, 403, { error: 'Forbidden host' });
      return;
    }
    const reqUrl = new URL(req.url ?? '/', `http://${HOST}`);
    try {
      if (reqUrl.pathname.startsWith('/api/')) {
        authorize(req, reqUrl);
        resetIdleTimer();
        await routeApi({ req, res, url: reqUrl });
      } else if (req.method === 'GET' && reqUrl.pathname === '/') {
        await servePage(res);
      } else {
        throw new HttpError(404, 'Not found');
      }
    } catch (err) {
      if (!(err instanceof HttpError)) {
        throw err;
      }
      if (err.status === 413) {
        // Stop reading an oversized body instead of draining it.
        res.setHeader('Connection', 'close');
        res.on('finish', () => req.destroy());
      }
      sendJson(res, err.status, { error: err.message });
    }
  }

  /**
   * Check the Origin and token of an API request.
   * @param {http.IncomingMessage} req
   * @param {URL} reqUrl
   * @returns {void}
   * @throws {HttpError}
   */
  function authorize(req, reqUrl) {
    const { origin } = req.headers;
    if (req.method !== 'GET' && origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) {
      throw new HttpError(403, 'Forbidden origin');
    }
    const header = req.headers[TOKEN_HEADER];
    let given = typeof header === 'string' ? header : null;
    // navigator.sendBeacon cannot set headers, so close may carry the token in the query.
    if (given === null && req.method === 'POST' && reqUrl.pathname === '/api/close') {
      given = reqUrl.searchParams.get('token');
    }
    const givenBuffer = Buffer.from(given ?? '');
    if (givenBuffer.length !== tokenBuffer.length || !timingSafeEqual(givenBuffer, tokenBuffer)) {
      throw new HttpError(401, 'Invalid or missing token');
    }
  }

  /**
   * @param {RequestContext} ctx
   * @returns {Promise<void>}
   */
  async function routeApi(ctx) {
    const route = `${ctx.req.method} ${ctx.url.pathname}`;
    switch (route) {
      case 'GET /api/ping':
        sendJson(ctx.res, 200, { ok: true });
        return;
      case 'GET /api/config':
        sendJson(ctx.res, 200, getConfig());
        return;
      case 'PUT /api/config':
        sendJson(ctx.res, 200, await putConfig(ctx.req));
        return;
      case 'GET /api/sounds':
        sendJson(ctx.res, 200, { sounds: await listSounds() });
        return;
      case 'DELETE /api/sounds':
        sendJson(ctx.res, 200, await deleteSound(ctx.url));
        return;
      case 'POST /api/preview':
        sendJson(ctx.res, 200, await preview(ctx.req));
        return;
      case 'POST /api/upload':
        sendJson(ctx.res, 200, await upload(ctx.req, ctx.url));
        return;
      case 'POST /api/close':
        if (ctx.url.searchParams.get('grace') === '1') {
          // Sent when the tab is hidden: a reload's first API request cancels it.
          graceTimer = setTimeout(() => {
            close().catch((err) => log('error', 'ui: close failed', err));
          }, CLOSE_GRACE_MS);
          graceTimer.unref();
        } else {
          ctx.res.on('finish', () => {
            close().catch((err) => log('error', 'ui: close failed', err));
          });
        }
        sendJson(ctx.res, 200, { ok: true });
        return;
      default:
        throw new HttpError(404, 'Not found');
    }
  }

  /**
   * @param {http.ServerResponse} res
   * @returns {Promise<void>}
   */
  async function servePage(res) {
    let html;
    try {
      html = await fs.promises.readFile(PAGE_FILE);
    } catch (err) {
      log('error', `ui: cannot read ${PAGE_FILE}`, err);
      sendJson(res, 500, { error: 'Settings page is missing' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Content-Security-Policy': PAGE_CSP,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
  }

  /** @returns {{ config: Config, meta: object }} */
  function getConfig() {
    const config = loadConfig({ dataDir });
    return {
      config,
      meta: {
        events: EVENTS.map((id) => ({
          id,
          label: EVENT_LABELS[id],
          agent: /** @type {readonly string[]} */ (AGENT_EVENTS).includes(id),
        })),
        families: Object.keys(config.modelPatterns),
        defaults: DEFAULTS,
        backend: safeCall(backend),
        ttsBackend: safeCall(ttsBackend),
        dataDir,
        configFile: path.join(dataDir, 'config.json'),
      },
    };
  }

  /**
   * @param {http.IncomingMessage} req
   * @returns {Promise<{ config: Config }>}
   */
  async function putConfig(req) {
    const body = await readJson(req);
    if (!isObject(body)) {
      throw new HttpError(400, 'Config must be a JSON object');
    }
    return { config: saveConfig(body, { dataDir }) };
  }

  /** @returns {Promise<SoundEntry[]>} */
  async function listSounds() {
    /** @type {SoundEntry[]} */
    const bundled = BUNDLED_SOUNDS.map((id) => ({
      id: `default:${id}`,
      label: `${titleCase(id)} (built-in)`,
      source: /** @type {const} */ ('bundled'),
    }));
    /** @type {SoundEntry[]} */
    const user = (await listUserFiles())
      .map((name) => ({ id: `user:${name}`, label: name, source: /** @type {const} */ ('user') }));
    return [...bundled, ...user, { id: 'tts', label: 'Spoken (text-to-speech)', source: 'tts' }];
  }

  /** @returns {Promise<string[]>} */
  async function listUserFiles() {
    let entries;
    try {
      entries = await fs.promises.readdir(soundsDir, { withFileTypes: true });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    return entries
      .filter((entry) => entry.isFile() && parseSoundSpec(`user:${entry.name}`) !== null)
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * @param {URL} reqUrl
   * @returns {Promise<{ config: Config }>}
   */
  async function deleteSound(reqUrl) {
    const id = reqUrl.searchParams.get('id') ?? '';
    const parsed = parseSoundSpec(id);
    if (parsed?.type !== 'user') {
      throw new HttpError(400, 'Only uploaded sounds (user:<file>) can be deleted');
    }
    try {
      await fs.promises.unlink(path.join(soundsDir, parsed.value));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        throw new HttpError(404, 'Sound not found');
      }
      throw err;
    }
    log('info', `ui: deleted sound ${parsed.value}`);

    const config = loadConfig({ dataDir });
    let changed = false;
    for (const event of EVENTS) {
      const eventConfig = config.events[event];
      if (eventConfig.sound === id) {
        eventConfig.sound = DEFAULTS.events[event].sound;
        changed = true;
      }
      for (const [family, spec] of Object.entries(eventConfig.byModel ?? {})) {
        if (spec === id) {
          delete eventConfig.byModel?.[family];
          changed = true;
        }
      }
    }
    return { config: changed ? saveConfig(config, { dataDir }) : config };
  }

  /**
   * @param {http.IncomingMessage} req
   * @returns {Promise<{ ok: true }>}
   */
  async function preview(req) {
    const body = await readJson(req);
    if (!isObject(body)) {
      throw new HttpError(400, 'Body must be a JSON object');
    }
    const parsed = parseSoundSpec(body.sound);
    if (!parsed) {
      throw new HttpError(400, 'Invalid sound spec');
    }
    if (body.event !== undefined && !(/** @type {readonly unknown[]} */ (EVENTS)).includes(body.event)) {
      throw new HttpError(400, 'Unknown event');
    }
    if (body.family !== undefined && typeof body.family !== 'string') {
      throw new HttpError(400, 'family must be a string');
    }
    const { volume } = body;
    if (volume !== undefined && (typeof volume !== 'number' || !(volume >= 0 && volume <= 1))) {
      throw new HttpError(400, 'volume must be a number from 0 to 1');
    }
    const event = /** @type {EventName} */ (body.event ?? 'agent_done');
    const family = /** @type {string} */ (body.family ?? 'other');
    const config = loadConfig({ dataDir });
    const options = { volume: volume ?? config.volume };

    // Play under a clone whose event uses the previewed spec, so it resolves
    // with the same path rules as a real notification. Clearing byModel keeps
    // a per-model override from taking precedence.
    const clone = /** @type {Config} */ (structuredClone(config));
    clone.events[event].sound = /** @type {string} */ (body.sound);
    if (clone.events[event].byModel) {
      clone.events[event].byModel = {};
    }
    const task = parsed.type === 'tts'
      ? () => speak(ttsText(config, event, family), options)
      : () => play(resolveSound(clone, event, family, { pluginRoot, dataDir }).value, options);

    const run = previewQueue.then(task);
    previewQueue = run.catch(() => {});
    try {
      await run;
    } catch (err) {
      log('error', `ui: preview of ${String(body.sound)} failed`, err);
      throw new HttpError(500, err instanceof Error ? err.message : String(err));
    }
    return { ok: true };
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {URL} reqUrl
   * @returns {Promise<{ sound: SoundEntry }>}
   */
  async function upload(req, reqUrl) {
    const name = reqUrl.searchParams.get('name') ?? '';
    if (!isUploadName(name)) {
      throw new HttpError(400, 'File name must be a plain .wav or .mp3 name');
    }
    const data = await readBody(req, MAX_UPLOAD_BYTES);
    if (!hasAudioMagic(name, data)) {
      throw new HttpError(415, `File content is not a valid ${path.extname(name).slice(1).toUpperCase()}`);
    }
    await fs.promises.mkdir(soundsDir, { recursive: true });
    const file = path.join(soundsDir, name);
    const tmp = path.join(soundsDir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, file);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    log('info', `ui: uploaded sound ${name} (${data.length} bytes)`);
    return { sound: { id: `user:${name}`, label: name, source: 'user' } };
  }

  /** @returns {void} */
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    clearTimeout(graceTimer);
    if (closing) {
      return;
    }
    idleTimer = setTimeout(() => {
      log('info', `ui: idle for ${idleMs} ms, shutting down`);
      close().catch((err) => log('error', 'ui: close failed', err));
    }, idleMs);
    idleTimer.unref();
  }

  /** @returns {Promise<void>} */
  function close() {
    closing ??= (async () => {
      clearTimeout(idleTimer);
      clearTimeout(graceTimer);
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        // Node 18.0 and 18.1 lack this; idle keep-alive sockets then close on their own.
        server.closeAllConnections?.();
      });
      removeUiFile(uiFile, url);
      log('info', `ui: stopped ${url ? new URL(url).origin : ''}`.trimEnd());
    })();
    return closing;
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  allowedHosts = new Set([`${HOST}:${address.port}`, `localhost:${address.port}`]);
  allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));
  url = `http://${HOST}:${address.port}/?token=${token}`;

  try {
    writeUiFile(uiFile, { url, pid: process.pid });
  } catch (err) {
    await close();
    throw err;
  }
  resetIdleTimer();
  log('info', `ui: listening on http://${HOST}:${address.port} (data dir ${dataDir})`);
  return { url, token, close };
}

/**
 * Send a JSON response that is never cached.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @returns {void}
 */
function sendJson(res, status, body) {
  const json = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': json.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(json);
}

/**
 * Read a request body, failing with 413 as soon as it exceeds `limit`.
 * @param {http.IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      reject(new HttpError(413, `Body exceeds ${limit} bytes`));
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.pause();
        reject(new HttpError(413, `Body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    /** @param {Error} err */
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readJson(req) {
  const text = (await readBody(req, MAX_JSON_BYTES)).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isUploadName(name) {
  return (
    name !== ''
    && !/[\\/:]/.test(name)
    && !name.includes('..')
    && !CONTROL_CHARS_RE.test(name)
    && !RESERVED_NAME_RE.test(name)
    && AUDIO_EXT_RE.test(name)
  );
}

/**
 * Check that the bytes match the format named by the file's extension.
 * @param {string} name
 * @param {Buffer} data
 * @returns {boolean}
 */
function hasAudioMagic(name, data) {
  if (/\.wav$/i.test(name)) {
    return data.length >= 12
      && data.toString('latin1', 0, 4) === 'RIFF'
      && data.toString('latin1', 8, 12) === 'WAVE';
  }
  if (data.length >= 3 && data.toString('latin1', 0, 3) === 'ID3') {
    return true;
  }
  return data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 'subagent-start' becomes 'Subagent Start'.
 * @param {string} id
 * @returns {string}
 */
function titleCase(id) {
  return id
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * @param {() => string | null} fn
 * @returns {string | null}
 */
function safeCall(fn) {
  try {
    return fn();
  } catch (err) {
    log('warn', 'ui: backend detection failed', err);
    return null;
  }
}

/**
 * @param {string} file
 * @param {{ url: string, pid: number }} info
 * @returns {void}
 */
function writeUiFile(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(info)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Remove `ui.json` unless another server has since replaced it.
 * @param {string} file
 * @param {string} url
 * @returns {void}
 */
function removeUiFile(file, url) {
  const info = readUiFile(file);
  if (info && info.url !== url) {
    return;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    log('warn', `ui: cannot remove ${file}`, err);
  }
}

/**
 * @param {string} file
 * @returns {{ url: string, pid: number } | null}
 */
function readUiFile(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(info) && typeof info.url === 'string' && Number.isInteger(info.pid)
      ? { url: info.url, pid: /** @type {number} */ (info.pid) }
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/**
 * Find a server already running for this data dir that answers its ping.
 * @param {string} dataDir
 * @returns {Promise<{ url: string, pid: number } | null>}
 */
async function findRunning(dataDir) {
  const info = readUiFile(path.join(dataDir, 'ui.json'));
  if (!info || !isAlive(info.pid)) {
    return null;
  }
  try {
    const pageUrl = new URL(info.url);
    const res = await fetch(new URL('/api/ping', pageUrl), {
      headers: { 'X-Claudio-Token': pageUrl.searchParams.get('token') ?? '' },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return res.ok ? info : null;
  } catch {
    return null;
  }
}

/**
 * @param {string[]} args
 * @returns {string | undefined}
 */
function dataDirArg(args) {
  const flag = args.indexOf('--data-dir');
  if (flag === -1) {
    return undefined;
  }
  const dir = args[flag + 1];
  if (!dir) {
    throw new Error('--data-dir requires a directory argument');
  }
  return path.resolve(dir);
}

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
 * Script entry: reuse a running server or start one, then print its
 * `{ url, pid }` as the only line on stdout.
 * @returns {Promise<void>}
 */
async function main() {
  const dir = dataDirArg(process.argv.slice(2));
  if (dir) {
    process.env.CLAUDIO_DATA_DIR = dir;
  }
  const dataDir = defaultDataDir();
  const running = await findRunning(dataDir);
  if (running) {
    process.stdout.write(`${JSON.stringify(running)}\n`);
    return;
  }
  const { url, close } = await startServer({ dataDir, pluginRoot: defaultPluginRoot() });
  const shutdown = () => {
    close().catch((err) => log('error', 'ui: close failed', err));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdout.write(`${JSON.stringify({ url, pid: process.pid })}\n`);
}

if (isMain()) {
  main().catch((err) => {
    log('error', 'ui: failed to start', err);
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
