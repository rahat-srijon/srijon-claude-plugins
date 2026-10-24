// @ts-check
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openSession, tryAcquire, isQuietTime } from '../lib/state.js';

const STATE_URL = pathToFileURL(path.resolve(import.meta.dirname, '../lib/state.js')).href;

/** @type {string} */
let dataDir;
/** @type {string | undefined} */
let previousEnv;

beforeEach(() => {
  previousEnv = process.env.CLAUDIO_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-state-'));
  process.env.CLAUDIO_DATA_DIR = dataDir;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (previousEnv === undefined) {
    delete process.env.CLAUDIO_DATA_DIR;
  } else {
    process.env.CLAUDIO_DATA_DIR = previousEnv;
  }
});

/**
 * Run a script as a fresh ES module process and collect its stdout.
 * @param {string} script
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CLAUDIO_DATA_DIR: dataDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

describe('openSession', () => {
  test('round-trips the turn start with explicit now values', () => {
    const session = openSession(dataDir, 's1');
    session.markTurnStart(10_000);
    assert.equal(session.turnSeconds(12_500), 2.5);
  });

  test('turnSeconds is null before any turn start', () => {
    assert.equal(openSession(dataDir, 's1').turnSeconds(5000), null);
  });

  test('turnSeconds never goes negative', () => {
    const session = openSession(dataDir, 's1');
    session.markTurnStart(10_000);
    assert.equal(session.turnSeconds(5000), 0);
  });

  test('round-trips the model and is null before it is set', () => {
    const session = openSession(dataDir, 's1');
    assert.equal(session.getModel(), null);
    session.setModel('claude-opus-4');
    assert.equal(session.getModel(), 'claude-opus-4');
  });

  test('setModel keeps the turn start and vice versa', () => {
    const session = openSession(dataDir, 's1');
    session.markTurnStart(1000);
    session.setModel('m');
    assert.equal(session.turnSeconds(3000), 2);
    session.markTurnStart(5000);
    assert.equal(session.getModel(), 'm');
  });

  test('state persists across two openSession calls', () => {
    openSession(dataDir, 's1').markTurnStart(1000);
    openSession(dataDir, 's1').setModel('m1');
    const second = openSession(dataDir, 's1');
    assert.equal(second.turnSeconds(4000), 3);
    assert.equal(second.getModel(), 'm1');
  });

  test('sessions are isolated by id', () => {
    openSession(dataDir, 'a').setModel('model-a');
    assert.equal(openSession(dataDir, 'b').getModel(), null);
  });

  test('corrupt state file is treated as empty', () => {
    const sessionsDir = path.join(dataDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 's1.json'), '{not json');
    const session = openSession(dataDir, 's1');
    assert.equal(session.turnSeconds(1), null);
    assert.equal(session.getModel(), null);
  });

  test('a path traversal id stays inside sessions/', () => {
    openSession(dataDir, '../evil').setModel('m');
    const sessionsDir = path.join(dataDir, 'sessions');
    assert.deepEqual(fs.readdirSync(sessionsDir), ['evil.json']);
    assert.equal(fs.existsSync(path.join(dataDir, 'evil.json')), false);
    assert.equal(fs.existsSync(path.join(path.dirname(dataDir), 'evil.json')), false);
  });

  test('an empty id becomes unknown', () => {
    openSession(dataDir, '').setModel('m');
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'sessions')), ['unknown.json']);
  });

  test('prunes session files older than 7 days', async () => {
    // Pruning runs once per process, so use a fresh process.
    const sessionsDir = path.join(dataDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const oldFile = path.join(sessionsDir, 'old.json');
    const newFile = path.join(sessionsDir, 'new.json');
    fs.writeFileSync(oldFile, '{}');
    fs.writeFileSync(newFile, '{}');
    const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const sixDays = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, eightDays, eightDays);
    fs.utimesSync(newFile, sixDays, sixDays);

    const script = `
      import { openSession } from ${JSON.stringify(STATE_URL)};
      openSession(${JSON.stringify(dataDir)}, 'current');
    `;
    const result = await runNode(script);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
  });
});

describe('tryAcquire', () => {
  test('true, then false within the cooldown, then true after it', () => {
    assert.equal(tryAcquire(dataDir, 'k', 1000, 100_000), true);
    assert.equal(tryAcquire(dataDir, 'k', 1000, 100_500), false);
    assert.equal(tryAcquire(dataDir, 'k', 1000, 100_999), false);
    assert.equal(tryAcquire(dataDir, 'k', 1000, 101_000), true);
  });

  test('a refused call does not extend the cooldown', () => {
    assert.equal(tryAcquire(dataDir, 'k', 1000, 100_000), true);
    assert.equal(tryAcquire(dataDir, 'k', 1000, 100_900), false);
    assert.equal(tryAcquire(dataDir, 'k', 1000, 101_000), true);
  });

  test('cooldownMs 0 is always true and creates no files', () => {
    assert.equal(tryAcquire(dataDir, 'k', 0, 1), true);
    assert.equal(tryAcquire(dataDir, 'k', 0, 1), true);
    assert.deepEqual(fs.readdirSync(dataDir), []);
  });

  test('keys are independent', () => {
    assert.equal(tryAcquire(dataDir, 'a', 1000, 5000), true);
    assert.equal(tryAcquire(dataDir, 'b', 1000, 5000), true);
    assert.equal(tryAcquire(dataDir, 'a', 1000, 5001), false);
    assert.equal(tryAcquire(dataDir, 'b', 1000, 5001), false);
  });

  test('a fresh mutex file makes it return false', () => {
    const locksDir = path.join(dataDir, 'locks');
    fs.mkdirSync(locksDir, { recursive: true });
    const mutex = path.join(locksDir, 'k.lock');
    fs.writeFileSync(mutex, '');
    assert.equal(tryAcquire(dataDir, 'k', 1000, 5000), false);
    assert.equal(fs.existsSync(mutex), true);
  });

  test('a stale mutex (older than 2 s) is recovered', () => {
    const locksDir = path.join(dataDir, 'locks');
    fs.mkdirSync(locksDir, { recursive: true });
    const mutex = path.join(locksDir, 'k.lock');
    fs.writeFileSync(mutex, '');
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(mutex, old, old);
    assert.equal(tryAcquire(dataDir, 'k', 1000, 5000), true);
    assert.equal(fs.existsSync(mutex), false);
  });

  test('no mutex is left behind after success or refusal', () => {
    tryAcquire(dataDir, 'k', 1000, 5000);
    tryAcquire(dataDir, 'k', 1000, 5001);
    const files = fs.readdirSync(path.join(dataDir, 'locks'));
    assert.deepEqual(files.filter((f) => f.endsWith('.lock')), []);
    assert.ok(files.includes('k.json'));
    assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
  });

  test('key sanitizing keeps lock files inside locks/', () => {
    assert.equal(tryAcquire(dataDir, '../evil', 1000, 5000), true);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'locks')), ['evil.json']);
    assert.equal(fs.existsSync(path.join(dataDir, 'evil.json')), false);
  });

  test('exactly one of 5 concurrent processes acquires', { timeout: 20_000 }, async () => {
    const script = `
      import { tryAcquire } from ${JSON.stringify(STATE_URL)};
      console.log(String(tryAcquire(${JSON.stringify(dataDir)}, 'k', 5000)));
    `;
    const results = await Promise.all(Array.from({ length: 5 }, () => runNode(script)));
    for (const r of results) {
      assert.equal(r.code, 0, r.stderr);
    }
    const outputs = results.map((r) => r.stdout);
    assert.equal(outputs.filter((o) => o === 'true').length, 1, outputs.join(','));
    assert.equal(outputs.filter((o) => o === 'false').length, 4, outputs.join(','));
  });
});

describe('isQuietTime', () => {
  /**
   * @param {number} h
   * @param {number} m
   * @returns {Date}
   */
  const at = (h, m) => new Date(2026, 0, 1, h, m);

  test('disabled gives false', () => {
    assert.equal(isQuietTime({ enabled: false, from: '00:00', to: '23:59' }, at(12, 0)), false);
  });

  test('from === to gives false', () => {
    assert.equal(isQuietTime({ enabled: true, from: '09:00', to: '09:00' }, at(9, 0)), false);
  });

  test('same-day window', () => {
    const q = { enabled: true, from: '09:00', to: '17:00' };
    assert.equal(isQuietTime(q, at(8, 59)), false);
    assert.equal(isQuietTime(q, at(12, 30)), true);
    assert.equal(isQuietTime(q, at(17, 30)), false);
    assert.equal(isQuietTime(q, at(23, 0)), false);
  });

  test('window wrapping midnight', () => {
    const q = { enabled: true, from: '22:00', to: '07:00' };
    assert.equal(isQuietTime(q, at(21, 59)), false);
    assert.equal(isQuietTime(q, at(23, 30)), true);
    assert.equal(isQuietTime(q, at(0, 0)), true);
    assert.equal(isQuietTime(q, at(3, 15)), true);
    assert.equal(isQuietTime(q, at(7, 30)), false);
    assert.equal(isQuietTime(q, at(12, 0)), false);
  });

  test('start is inclusive and end exclusive (same-day)', () => {
    const q = { enabled: true, from: '09:00', to: '17:00' };
    assert.equal(isQuietTime(q, at(9, 0)), true);
    assert.equal(isQuietTime(q, at(16, 59)), true);
    assert.equal(isQuietTime(q, at(17, 0)), false);
  });

  test('start is inclusive and end exclusive (wrapping)', () => {
    const q = { enabled: true, from: '22:00', to: '07:00' };
    assert.equal(isQuietTime(q, at(22, 0)), true);
    assert.equal(isQuietTime(q, at(6, 59)), true);
    assert.equal(isQuietTime(q, at(7, 0)), false);
  });

  test('accepts single-digit hours', () => {
    const q = { enabled: true, from: '9:00', to: '17:00' };
    assert.equal(isQuietTime(q, at(10, 0)), true);
  });

  test('malformed times give false', () => {
    const bad = ['', 'abc', '25:00', '12:60', '12', '12:5', '24:00', '-1:00', '12:00:00'];
    for (const value of bad) {
      assert.equal(
        isQuietTime({ enabled: true, from: value, to: '17:00' }, at(10, 0)),
        false,
        `from=${value}`,
      );
      assert.equal(
        isQuietTime({ enabled: true, from: '09:00', to: value }, at(10, 0)),
        false,
        `to=${value}`,
      );
    }
  });

  test('missing quiet hours object gives false', () => {
    // @ts-expect-error deliberately invalid input
    assert.equal(isQuietTime(undefined, at(10, 0)), false);
  });
});
