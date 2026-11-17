// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath, defaultConfig, loadConfig } from '../lib/config.js';
import { MAX_BODY_BYTES, TOKEN_HEADER, startServer } from '../ui/server.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

/** @returns {string} A fresh temp data dir. */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pace-server-'));

/**
 * Start a server on a temp dir, run the body, always close it.
 * @param {(ctx: { dir: string, port: number, token: string, url: string, base: string, get: (p: string, headers?: Record<string, string>) => Promise<Response>, put: (body: unknown, headers?: Record<string, string>) => Promise<Response> }) => Promise<void>} body
 * @param {{ idleMs?: number }} [options]
 */
async function withServer(body, options = {}) {
  const dir = tmp();
  const srv = await startServer({ dataDir: dir, idleMs: options.idleMs ?? 60_000 });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    await body({
      dir, port: srv.port, token: srv.token, url: srv.url, base,
      get: (p, headers = {}) => fetch(base + p, { headers: { [TOKEN_HEADER]: srv.token, ...headers } }),
      put: (b, headers = {}) => fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: { [TOKEN_HEADER]: srv.token, 'Content-Type': 'application/json', ...headers },
        body: typeof b === 'string' ? b : JSON.stringify(b),
      }),
    });
  } finally {
    await srv.close();
  }
}

/**
 * A raw request, so the Host header can be chosen.
 * @param {number} port
 * @param {string} host
 * @param {Record<string, string>} headers
 * @returns {Promise<number>}
 */
function rawStatus(port, host, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/config', headers: { Host: host, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('the URL is 127.0.0.1 with a random port and a per-launch token', async () => {
  const a = await startServer({ dataDir: tmp() });
  const b = await startServer({ dataDir: tmp() });
  try {
    const ua = new URL(a.url);
    assert.equal(ua.hostname, '127.0.0.1');
    assert.equal(ua.protocol, 'http:');
    assert.match(ua.searchParams.get('token') ?? '', /^[0-9a-f]{48}$/);
    assert.notEqual(a.port, b.port);
    assert.notEqual(a.token, b.token);
  } finally {
    await a.close();
    await b.close();
  }
});

test('the page needs the token; the API needs it as a header', async () => {
  await withServer(async ({ base, url, token, get }) => {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /Enabled globally/);
    assert.match(html, /Uses AI/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);

    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/?token=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/api/config`)).status, 401);
    assert.equal((await fetch(`${base}/api/config`, { headers: { [TOKEN_HEADER]: 'wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/api/config`, { headers: { [TOKEN_HEADER]: token.slice(0, -1) } })).status, 401);
    // The token in the query is not enough for the API.
    assert.equal((await fetch(`${base}/api/config?token=${token}`)).status, 401);
    assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

    const ok = await get('/api/config');
    assert.equal(ok.status, 200);
    const data = /** @type {any} */ (await ok.json());
    assert.deepEqual(data.config, defaultConfig());
    assert.deepEqual(data.defaults, defaultConfig());
    assert.match(data.path, /config\.json$/);
    assert.equal((await get('/nope')).status, 404);
  });
});

test('only its own host is answered', async () => {
  await withServer(async ({ port, token }) => {
    const h = { [TOKEN_HEADER]: token };
    assert.equal(await rawStatus(port, `127.0.0.1:${port}`, h), 200);
    assert.equal(await rawStatus(port, `localhost:${port}`, h), 200);
    assert.equal(await rawStatus(port, 'evil.example', h), 403);
    assert.equal(await rawStatus(port, `evil.example:${port}`, h), 403);
    assert.equal(await rawStatus(port, `127.0.0.1:${port + 1}`, h), 403);
  });
});

test('it listens on loopback only: no other address of this machine connects', async () => {
  await withServer(async ({ port }) => {
    /** @param {string} host */
    const connects = (host) => new Promise((resolve) => {
      const s = net.connect({ host, port, timeout: 1000 });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
      s.once('timeout', () => { s.destroy(); resolve(false); });
    });
    assert.equal(await connects('127.0.0.1'), true);
    assert.equal(await connects('::1'), false);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const addr of list ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          assert.equal(await connects(addr.address), false, addr.address);
        }
      }
    }
  });
});

test('PUT saves a valid config to the data dir and GET returns it', async () => {
  await withServer(async ({ dir, get, put }) => {
    const next = { ...defaultConfig(), enabled: false, barStyle: 'thin', barWidth: 33, ai: { explainStop: true, askForTaskList: false } };
    const res = await put(next);
    assert.equal(res.status, 200);
    assert.deepEqual(/** @type {any} */ (await res.json()).config, next);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath(dir), 'utf8')), next);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
    assert.deepEqual(/** @type {any} */ (await (await get('/api/config')).json()).config, next);
  });
});

test('PUT refuses anything that is not exactly a config and leaves the file alone', async () => {
  await withServer(async ({ dir, put }) => {
    const good = defaultConfig();
    /** @type {unknown[]} */
    const bodies = [
      '{ not json', '[]', 'null', '"x"', '{}',
      { ...good, enabled: 'yes' },
      { ...good, barStyle: 'sparkle' },
      { ...good, barWidth: 1000 },
      { ...good, barWidth: 20.5 },
      { ...good, extra: true },
      { ...good, fields: { ...good.fields, extra: true } },
      { ...good, fields: { stepCount: true } },
      { ...good, ai: 'on' },
      { ...good, ai: { explainStop: 1, askForTaskList: false } },
    ];
    for (const body of bodies) {
      const res = await put(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok(typeof (/** @type {any} */ (await res.json())).error === 'string');
    }
    assert.equal(fs.existsSync(configPath(dir)), false);

    const notJson = await put(JSON.stringify(good), { 'Content-Type': 'text/plain' });
    assert.equal(notJson.status, 415);
    assert.equal(fs.existsSync(configPath(dir)), false);
  });
});

test('PUT from a foreign origin is refused; the page origin is allowed', async () => {
  await withServer(async ({ dir, base, put }) => {
    const res = await put(defaultConfig(), { Origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(configPath(dir)), false);
    assert.equal((await put(defaultConfig(), { Origin: base })).status, 200);
    assert.deepEqual(loadConfig(dir), defaultConfig());
  });
});

test('a body over the cap is refused with 413', async () => {
  await withServer(async ({ dir, put }) => {
    const big = JSON.stringify({ ...defaultConfig(), pad: 'x'.repeat(MAX_BODY_BYTES) });
    assert.ok(big.length > MAX_BODY_BYTES);
    const res = await put(big);
    assert.equal(res.status, 413);
    assert.equal(fs.existsSync(configPath(dir)), false);
  });
});

test('the server shuts itself down after the idle time', async () => {
  const dir = tmp();
  const srv = await startServer({ dataDir: dir, idleMs: 200 });
  const alive = await fetch(`http://127.0.0.1:${srv.port}/api/config`, { headers: { [TOKEN_HEADER]: srv.token } });
  assert.equal(alive.status, 200);
  await new Promise((r) => setTimeout(r, 700));
  await assert.rejects(fetch(`http://127.0.0.1:${srv.port}/api/config`, { headers: { [TOKEN_HEADER]: srv.token } }));
  await srv.close();
});

test('requests keep the idle timer from firing', async () => {
  const srv = await startServer({ dataDir: tmp(), idleMs: 400 });
  try {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/config`, { headers: { [TOKEN_HEADER]: srv.token } });
      assert.equal(res.status, 200);
    }
  } finally {
    await srv.close();
  }
});

test('POST /api/close stops the server', async () => {
  const srv = await startServer({ dataDir: tmp() });
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/close`, { method: 'POST', headers: { [TOKEN_HEADER]: srv.token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  await srv.close();
  await assert.rejects(fetch(`http://127.0.0.1:${srv.port}/api/config`, { headers: { [TOKEN_HEADER]: srv.token } }));
});

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

test('the launcher prints only the URL, leaves a detached server and reuses it', async () => {
  const dir = tmp();
  const first = await runCli(['config', '--no-open', '--data-dir', dir, '--idle-ms', '20000']);
  assert.equal(first.code, 0, first.stderr);
  const lines = first.stdout.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1);
  const url = new URL(lines[0] ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  const token = url.searchParams.get('token') ?? '';
  assert.ok(token.length > 20);
  const head = { [TOKEN_HEADER]: token };
  try {
    // The launcher has exited and the server still answers.
    const res = await fetch(new URL('/api/config', url), { headers: head });
    assert.equal(res.status, 200);
    assert.equal((await fetch(new URL('/api/config', url))).status, 401);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>pace-maker settings<\/title>/);
    const again = await runCli(['config', '--no-open', '--data-dir', dir]);
    assert.equal(again.stdout, first.stdout);
  } finally {
    await fetch(new URL('/api/close', url), { method: 'POST', headers: { ...head, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  }
});

test('the launcher honours PACE_MAKER_DATA_DIR and fails with one line on a bad command', async () => {
  const dir = tmp();
  const ran = await runCli(['config', '--no-open', '--idle-ms', '20000'], { PACE_MAKER_DATA_DIR: dir });
  assert.equal(ran.code, 0, ran.stderr);
  const url = new URL(ran.stdout.trim());
  try {
    const data = /** @type {any} */ (await (await fetch(new URL('/api/config', url), { headers: { [TOKEN_HEADER]: url.searchParams.get('token') ?? '' } })).json());
    assert.equal(data.path, configPath(dir));
  } finally {
    await fetch(new URL('/api/close', url), { method: 'POST', headers: { [TOKEN_HEADER]: url.searchParams.get('token') ?? '', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  }
  const bad = await runCli(['nonsense']);
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, '');
});
