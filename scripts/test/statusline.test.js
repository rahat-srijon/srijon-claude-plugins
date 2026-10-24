// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Guard directory so that even import-time logging can never reach the real ~/.claude.
const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-statusline-'));
process.env.CLAUDIO_DATA_DIR = guardDir;

const {
  applySetup,
  planSetup,
  readSetupRecord,
  refreshShim,
  shimCommand,
  shimFile,
  teardown,
} = await import('../lib/statusline.js');

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {string} */
let tmp;
/** @type {string} */
let dataDir;
/** @type {string} */
let settingsFile;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-statusline-'));
  dataDir = path.join(tmp, 'data');
  settingsFile = path.join(tmp, 'settings.json');
  process.env.CLAUDIO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env.CLAUDIO_DATA_DIR = guardDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

process.on('exit', () => {
  fs.rmSync(guardDir, { recursive: true, force: true });
});

/** @param {unknown} settings */
function writeSettings(settings) {
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
}

/** @returns {Record<string, any>} */
function readSettings() {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
}

function setUp() {
  const plan = planSetup({ dataDir, settingsFile });
  applySetup(plan, { dataDir, pluginRoot: PLUGIN_ROOT });
  return plan;
}

/**
 * Run the shim the way a status line command does.
 * @param {string} input
 * @param {string[]} args
 * @returns {{ stdout: string, status: number | null }}
 */
function runShim(input, args = []) {
  const result = spawnSync(process.execPath, [shimFile(dataDir), ...args], { input, encoding: 'utf8' });
  return { stdout: result.stdout, status: result.status };
}

describe('shimCommand', () => {
  it('runs the shim alone without a previous command', () => {
    const command = shimCommand(dataDir, undefined);
    assert.equal(command, `node "${shimFile(dataDir).replace(/\\/g, '/')}"`);
    assert.equal(shimCommand(dataDir, '  '), command);
  });

  it('pipes into the previous command', () => {
    assert.equal(shimCommand(dataDir, 'bash ~/sl.sh'), `${shimCommand(dataDir, undefined)} --tee | bash ~/sl.sh`);
  });

  it('uses forward slashes only', () => {
    assert.ok(!shimCommand(dataDir, 'x').includes('\\'));
  });
});

describe('planSetup', () => {
  it('keeps the previous status line and its other keys', () => {
    writeSettings({ model: 'opus', statusLine: { type: 'command', command: 'bash ~/sl.sh', padding: 2 } });
    const plan = planSetup({ dataDir, settingsFile });
    assert.equal(plan.status, 'ready');
    assert.deepEqual(plan.previous, { type: 'command', command: 'bash ~/sl.sh', padding: 2 });
    assert.deepEqual(plan.next, { type: 'command', command: shimCommand(dataDir, 'bash ~/sl.sh'), padding: 2 });
  });

  it('works without a settings file', () => {
    const plan = planSetup({ dataDir, settingsFile });
    assert.equal(plan.previous, null);
    assert.deepEqual(plan.next, { type: 'command', command: shimCommand(dataDir, undefined) });
  });

  it('changes nothing on disk', () => {
    writeSettings({ statusLine: { type: 'command', command: 'x' } });
    planSetup({ dataDir, settingsFile });
    assert.deepEqual(readSettings(), { statusLine: { type: 'command', command: 'x' } });
    assert.ok(!fs.existsSync(dataDir));
  });

  it('refuses a settings file that is not valid JSON', () => {
    fs.writeFileSync(settingsFile, '{ "model": ');
    assert.throws(() => planSetup({ dataDir, settingsFile }), /not valid JSON/);
  });

  it('warns about project settings that override the status line', () => {
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: {} }));
    const plan = planSetup({ dataDir, settingsFile, projectDir });
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /settings\.local\.json/);
  });

  it('reports an existing setup as installed', () => {
    writeSettings({ statusLine: { type: 'command', command: 'bash ~/sl.sh' } });
    setUp();
    const plan = planSetup({ dataDir, settingsFile });
    assert.equal(plan.status, 'installed');
    assert.equal(plan.previous?.command, 'bash ~/sl.sh');
  });

  it('never chains the shim into itself when the setup record is lost', () => {
    writeSettings({ statusLine: { type: 'command', command: 'bash ~/sl.sh' } });
    setUp();
    fs.rmSync(path.join(dataDir, 'usage', 'setup.json'));
    const plan = planSetup({ dataDir, settingsFile });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.previous?.command, 'bash ~/sl.sh');
    assert.equal(plan.next.command, shimCommand(dataDir, 'bash ~/sl.sh'));
    assert.equal(plan.warnings.length, 1);
  });
});

describe('applySetup and teardown', () => {
  it('points the status line at the shim, backs up settings and restores them', () => {
    const original = { model: 'opus', statusLine: { type: 'command', command: 'bash ~/sl.sh', padding: 2 } };
    writeSettings(original);
    const plan = setUp();

    assert.equal(readSettings().statusLine.command, plan.next.command);
    assert.equal(readSettings().model, 'opus');
    assert.deepEqual(JSON.parse(fs.readFileSync(plan.backupFile, 'utf8')), original);
    assert.ok(fs.existsSync(shimFile(dataDir)));
    assert.equal(readSetupRecord(dataDir)?.command, plan.next.command);

    const result = teardown({ dataDir, settingsFile });
    assert.equal(result.status, 'restored');
    assert.deepEqual(readSettings(), original);
    assert.ok(!fs.existsSync(shimFile(dataDir)));
    assert.equal(readSetupRecord(dataDir), null);
  });

  it('removes the status line on teardown when there was none', () => {
    writeSettings({ model: 'opus' });
    setUp();
    assert.equal(teardown({ dataDir, settingsFile }).status, 'restored');
    assert.deepEqual(readSettings(), { model: 'opus' });
  });

  it('leaves a status line the user changed since setup alone', () => {
    setUp();
    writeSettings({ statusLine: { type: 'command', command: 'my-new-status-line' } });
    assert.equal(teardown({ dataDir, settingsFile }).status, 'changed');
    assert.deepEqual(readSettings(), { statusLine: { type: 'command', command: 'my-new-status-line' } });
    assert.equal(readSetupRecord(dataDir), null);
  });

  it('reports teardown without setup', () => {
    assert.equal(teardown({ dataDir, settingsFile }).status, 'not-installed');
    assert.ok(!fs.existsSync(settingsFile));
  });
});

describe('refreshShim', () => {
  it('does nothing before setup', () => {
    assert.equal(refreshShim({ dataDir, pluginRoot: PLUGIN_ROOT }), false);
    assert.ok(!fs.existsSync(shimFile(dataDir)));
  });

  it('rewrites the shim only when the plugin root changes', () => {
    setUp();
    assert.equal(refreshShim({ dataDir, pluginRoot: PLUGIN_ROOT }), false);
    assert.equal(refreshShim({ dataDir, pluginRoot: path.join(tmp, 'new-root') }), true);
    assert.match(fs.readFileSync(shimFile(dataDir), 'utf8'), /new-root/);
  });
});

describe('shim', () => {
  const input = JSON.stringify({ model: { display_name: 'Opus ü 😀' }, rate_limits: {} });

  it('prints nothing without --tee', () => {
    setUp();
    assert.deepEqual(runShim(input), { stdout: '', status: 0 });
  });

  it('passes the input on with --tee, as the same JSON', () => {
    setUp();
    const { stdout, status } = runShim(input, ['--tee']);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), JSON.parse(input));
    if (process.platform === 'win32') {
      assert.match(stdout, /^[\x00-\x7f]*$/, 'non-ASCII is escaped for Windows PowerShell');
    } else {
      assert.equal(stdout, input);
    }
  });

  it('keeps passing the input on when the plugin root is gone', () => {
    setUp();
    refreshShim({ dataDir, pluginRoot: path.join(tmp, 'missing') });
    const { stdout, status } = runShim(input, ['--tee']);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), JSON.parse(input));
  });

  it('records the limit windows through the plugin', () => {
    setUp();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ muted: true }));
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    runShim(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 85, resets_at: resetsAt } } }));
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'usage', 'state.json'), 'utf8'));
    assert.deepEqual(state.five_hour, { resetsAt, maxPercent: 85, fired: [80], reset: false });
  });
});
