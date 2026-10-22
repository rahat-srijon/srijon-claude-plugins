// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Guard directory so that even import-time logging can never reach the real ~/.claude.
const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-config-'));
process.env.CLAUDIO_DATA_DIR = guardDir;

const {
  DEFAULTS,
  effectiveVolume,
  loadConfig,
  parseSoundSpec,
  resolveSound,
  saveConfig,
  ttsText,
} = await import('../lib/config.js');

/** @type {string} */
let tmp;
/** @type {string} */
let dataDir;
/** @type {string} */
let projectDir;
/** @type {string} */
let pluginRoot;
/** @type {string | undefined} */
let savedDataEnv;

/**
 * @param {string} file
 * @param {unknown} content Objects are serialized; strings are written verbatim.
 */
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

/** @param {unknown} content */
function writeGlobal(content) {
  write(path.join(dataDir, 'config.json'), content);
}

/** @param {unknown} content */
function writeProject(content) {
  write(path.join(projectDir, '.claude', 'claudio.json'), content);
}

function load() {
  return loadConfig({ dataDir, projectDir });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-config-'));
  dataDir = path.join(tmp, 'data');
  projectDir = path.join(tmp, 'project');
  pluginRoot = path.join(tmp, 'plugin');
  savedDataEnv = process.env.CLAUDIO_DATA_DIR;
  process.env.CLAUDIO_DATA_DIR = tmp;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'sounds'), { recursive: true });
});

afterEach(() => {
  process.env.CLAUDIO_DATA_DIR = savedDataEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

process.on('exit', () => {
  fs.rmSync(guardDir, { recursive: true, force: true });
});

describe('DEFAULTS', () => {
  it('is deep-frozen', () => {
    assert.ok(Object.isFrozen(DEFAULTS));
    assert.ok(Object.isFrozen(DEFAULTS.quietHours));
    assert.ok(Object.isFrozen(DEFAULTS.events));
    assert.ok(Object.isFrozen(DEFAULTS.events.agent_done));
    assert.ok(Object.isFrozen(DEFAULTS.events.agent_done.byModel));
    assert.ok(Object.isFrozen(DEFAULTS.modelPatterns));
  });

  it('rejects mutation of nested values', () => {
    assert.throws(() => {
      /** @type {any} */ (DEFAULTS).quietHours.from = '01:00';
    }, TypeError);
  });
});

describe('loadConfig: layering', () => {
  it('returns the defaults when no files exist', () => {
    assert.deepEqual(load(), DEFAULTS);
  });

  it('returns a fresh mutable copy on every call', () => {
    const first = load();
    first.volume = 0.1;
    first.events.agent_done.sound = 'tts';
    assert.equal(DEFAULTS.volume, 0.8);
    assert.equal(DEFAULTS.events.agent_done.sound, 'default:done');
    assert.equal(load().volume, 0.8);
  });

  it('applies the global file over the defaults', () => {
    writeGlobal({ volume: 0.3, muted: true });
    const config = load();
    assert.equal(config.volume, 0.3);
    assert.equal(config.muted, true);
    assert.equal(config.cooldownMs, DEFAULTS.cooldownMs);
  });

  it('applies the project file over the global file', () => {
    writeGlobal({ volume: 0.3, minTurnSeconds: 5 });
    writeProject({ volume: 0.6 });
    const config = load();
    assert.equal(config.volume, 0.6);
    assert.equal(config.minTurnSeconds, 5);
  });

  it('ignores the project file when no projectDir is given', () => {
    writeProject({ volume: 0.6 });
    assert.equal(loadConfig({ dataDir }).volume, DEFAULTS.volume);
  });

  it('deep-merges plain objects across layers', () => {
    writeGlobal({ quietHours: { enabled: true, from: '23:00' } });
    writeProject({ quietHours: { to: '06:30' }, events: { question: { enabled: false } } });
    const config = load();
    assert.deepEqual(config.quietHours, { enabled: true, from: '23:00', to: '06:30' });
    assert.equal(config.events.question.enabled, false);
    assert.equal(config.events.question.sound, 'default:question');
    assert.equal(config.events.permission.enabled, true);
  });

  it('deep-merges byModel maps across layers', () => {
    writeGlobal({ events: { agent_done: { byModel: { opus: 'tts' } } } });
    writeProject({ events: { agent_done: { byModel: { sonnet: 'tts' } } } });
    assert.deepEqual(load().events.agent_done.byModel, { opus: 'tts', sonnet: 'tts' });
  });

  it('lets the project layer replace scalars from the global layer', () => {
    writeGlobal({ events: { error: { volume: 0.2 } } });
    writeProject({ events: { error: { volume: 0.9 } } });
    assert.equal(load().events.error.volume, 0.9);
  });

  it('lets a project clear a global event volume with null', () => {
    writeGlobal({ events: { error: { volume: 0.2 } } });
    writeProject({ events: { error: { volume: null } } });
    assert.equal(load().events.error.volume, null);
  });

  it('replaces an object with an array rather than merging', () => {
    writeGlobal({ quietHours: { enabled: true } });
    writeProject({ quietHours: ['22:00', '07:00'] });
    // The array replaces the object, then normalization restores the default.
    assert.deepEqual(load().quietHours, DEFAULTS.quietHours);
  });

  it('replaces an object with a scalar rather than merging', () => {
    writeGlobal({ quietHours: 'always' });
    assert.deepEqual(load().quietHours, DEFAULTS.quietHours);
  });

  it('does not pollute prototypes through a __proto__ key', () => {
    writeGlobal('{"__proto__": {"polluted": true}, "volume": 0.4}');
    const config = load();
    assert.equal(config.volume, 0.4);
    assert.equal(/** @type {any} */ ({}).polluted, undefined);
    assert.equal(/** @type {any} */ (config).polluted, undefined);
  });
});

describe('loadConfig: bad files', () => {
  it('skips a file with invalid JSON', () => {
    writeGlobal('{ not json');
    assert.deepEqual(load(), DEFAULTS);
  });

  it('keeps the global layer when the project file is invalid JSON', () => {
    writeGlobal({ volume: 0.3 });
    writeProject('{ nope');
    assert.equal(load().volume, 0.3);
  });

  it('accepts a file that starts with a UTF-8 BOM', () => {
    writeGlobal(`﻿${JSON.stringify({ volume: 0.25 })}`);
    assert.equal(load().volume, 0.25);
  });

  for (const [name, text] of /** @type {const} */ ([
    ['an array', '[1, 2]'],
    ['a string', '"hello"'],
    ['a number', '42'],
    ['null', 'null'],
  ])) {
    it(`skips a file containing ${name}`, () => {
      writeGlobal(text);
      assert.deepEqual(load(), DEFAULTS);
    });
  }

  it('skips an unreadable path such as a directory named config.json', () => {
    fs.mkdirSync(path.join(dataDir, 'config.json'));
    assert.deepEqual(load(), DEFAULTS);
  });

  it('does not throw when projectDir does not exist', () => {
    const config = loadConfig({ dataDir, projectDir: path.join(tmp, 'missing') });
    assert.deepEqual(config, DEFAULTS);
  });
});

describe('loadConfig: normalization', () => {
  it('clamps volume into 0..1', () => {
    writeGlobal({ volume: 7 });
    assert.equal(load().volume, 1);
    writeGlobal({ volume: -3 });
    assert.equal(load().volume, 0);
  });

  it('clamps event volume into 0..1', () => {
    writeGlobal({ events: { error: { volume: 2 }, question: { volume: -1 } } });
    const config = load();
    assert.equal(config.events.error.volume, 1);
    assert.equal(config.events.question.volume, 0);
  });

  it('replaces a non-numeric volume with the default', () => {
    writeGlobal({ volume: 'loud' });
    assert.equal(load().volume, DEFAULTS.volume);
  });

  it('keeps a null event volume', () => {
    writeGlobal({ events: { error: { volume: null } } });
    assert.equal(load().events.error.volume, null);
  });

  it('replaces a non-numeric event volume with the default', () => {
    writeGlobal({ events: { error: { volume: 'x' } } });
    assert.equal(load().events.error.volume, null);
  });

  it('replaces a malformed quiet-hours time with the default', () => {
    writeGlobal({ quietHours: { from: '25:00', to: '7:5' } });
    const { quietHours } = load();
    assert.equal(quietHours.from, DEFAULTS.quietHours.from);
    assert.equal(quietHours.to, DEFAULTS.quietHours.to);
  });

  it('accepts boundary HH:MM values', () => {
    writeGlobal({ quietHours: { from: '00:00', to: '23:59' } });
    const { quietHours } = load();
    assert.equal(quietHours.from, '00:00');
    assert.equal(quietHours.to, '23:59');
  });

  it('replaces non-boolean flags with defaults', () => {
    writeGlobal({ enabled: 'yes', muted: 1, quietHours: { enabled: 'no' } });
    const config = load();
    assert.equal(config.enabled, DEFAULTS.enabled);
    assert.equal(config.muted, DEFAULTS.muted);
    assert.equal(config.quietHours.enabled, DEFAULTS.quietHours.enabled);
  });

  it('floors negative counts at zero', () => {
    writeGlobal({ minTurnSeconds: -5, cooldownMs: -1 });
    const config = load();
    assert.equal(config.minTurnSeconds, 0);
    assert.equal(config.cooldownMs, 0);
  });

  it('rounds float counts to integers', () => {
    writeGlobal({ minTurnSeconds: 2.6, cooldownMs: 100.2 });
    const config = load();
    assert.equal(config.minTurnSeconds, 3);
    assert.equal(config.cooldownMs, 100);
  });

  it('replaces non-number counts with defaults', () => {
    writeGlobal({ minTurnSeconds: '10', cooldownMs: null });
    const config = load();
    assert.equal(config.minTurnSeconds, DEFAULTS.minTurnSeconds);
    assert.equal(config.cooldownMs, DEFAULTS.cooldownMs);
  });

  it('drops unknown top-level keys', () => {
    writeGlobal({ bogus: 1, volume: 0.5 });
    assert.equal('bogus' in load(), false);
  });

  it('drops unknown nested keys and unknown events', () => {
    writeGlobal({
      quietHours: { extra: true },
      tts: { extra: true },
      events: { nonsense: { enabled: true }, question: { color: 'red' } },
    });
    const config = load();
    assert.equal('extra' in config.quietHours, false);
    assert.equal('extra' in config.tts, false);
    assert.equal('nonsense' in config.events, false);
    assert.equal('color' in config.events.question, false);
  });

  it('drops byModel on events that do not support it', () => {
    writeGlobal({ events: { question: { byModel: { opus: 'tts' } } } });
    assert.equal('byModel' in load().events.question, false);
  });

  it('replaces an invalid event sound with the default', () => {
    writeGlobal({ events: { error: { sound: 'user:../x.wav' } } });
    assert.equal(load().events.error.sound, 'default:error');
  });

  it('replaces a non-string event sound with the default', () => {
    writeGlobal({ events: { error: { sound: 42 } } });
    assert.equal(load().events.error.sound, 'default:error');
  });

  it('keeps a valid sound spec', () => {
    writeGlobal({ events: { error: { sound: 'tts' } } });
    assert.equal(load().events.error.sound, 'tts');
  });

  it('replaces an empty tts template with the default', () => {
    writeGlobal({ tts: { template: '   ' } });
    assert.equal(load().tts.template, DEFAULTS.tts.template);
  });

  it('keeps valid byModel entries', () => {
    writeGlobal({ events: { agent_done: { byModel: { opus: 'default:error' } } } });
    assert.deepEqual(load().events.agent_done.byModel, { opus: 'default:error' });
  });

  it('drops byModel entries for an unknown family', () => {
    writeGlobal({ events: { agent_done: { byModel: { gemini: 'tts', opus: 'tts' } } } });
    assert.deepEqual(load().events.agent_done.byModel, { opus: 'tts' });
  });

  it('drops byModel entries with an invalid sound spec', () => {
    writeGlobal({ events: { agent_done: { byModel: { opus: 'nope.ogg', haiku: 'tts' } } } });
    assert.deepEqual(load().events.agent_done.byModel, { haiku: 'tts' });
  });

  it('replaces a non-object byModel with an empty object', () => {
    writeGlobal({ events: { agent_done: { byModel: 'opus' } } });
    assert.deepEqual(load().events.agent_done.byModel, {});
  });

  it('keeps a user-added model family and lets byModel reference it', () => {
    writeGlobal({
      modelPatterns: { mistral: 'mistral' },
      events: { agent_done: { byModel: { mistral: 'tts' } } },
    });
    const config = load();
    assert.equal(config.modelPatterns.mistral, 'mistral');
    assert.equal(config.modelPatterns.opus, 'opus');
    assert.deepEqual(config.events.agent_done.byModel, { mistral: 'tts' });
  });

  it('drops a user-added family with an invalid pattern', () => {
    writeGlobal({ modelPatterns: { mistral: '' } });
    assert.equal('mistral' in load().modelPatterns, false);
  });

  it('reverts an invalid built-in family pattern to its default', () => {
    writeGlobal({ modelPatterns: { opus: 5 } });
    assert.equal(load().modelPatterns.opus, 'opus');
  });
});

describe('parseSoundSpec', () => {
  const abs = (/** @type {string} */ name) => path.join(os.tmpdir(), name);

  it('parses tts', () => {
    assert.deepEqual(parseSoundSpec('tts'), { type: 'tts', value: '' });
  });

  it('parses a bundled default', () => {
    assert.deepEqual(parseSoundSpec('default:done'), { type: 'default', value: 'done' });
  });

  it('parses a user file with wav or mp3 (case-insensitive)', () => {
    assert.deepEqual(parseSoundSpec('user:ding.wav'), { type: 'user', value: 'ding.wav' });
    assert.deepEqual(parseSoundSpec('user:ding.MP3'), { type: 'user', value: 'ding.MP3' });
  });

  it('parses an absolute path', () => {
    const file = abs('x.wav');
    assert.deepEqual(parseSoundSpec(file), { type: 'path', value: file });
  });

  for (const spec of [
    'user:../x.wav',
    'user:a/b.wav',
    'user:a\\b.wav',
    'user:c:x.wav',
    'user:noext',
    'default:nope',
    'default:',
    'relative/x.wav',
    'x.wav',
    '',
    'TTS',
  ]) {
    it(`rejects ${JSON.stringify(spec)}`, () => {
      assert.equal(parseSoundSpec(spec), null);
    });
  }

  it('rejects the .ogg extension for user and path specs', () => {
    assert.equal(parseSoundSpec('user:x.ogg'), null);
    assert.equal(parseSoundSpec(abs('x.ogg')), null);
  });

  it('rejects a NUL character', () => {
    assert.equal(parseSoundSpec('user:x\0.wav'), null);
    assert.equal(parseSoundSpec(`${abs('x')}\0.wav`), null);
  });

  it('rejects non-string input', () => {
    assert.equal(parseSoundSpec(undefined), null);
    assert.equal(parseSoundSpec(null), null);
    assert.equal(parseSoundSpec(5), null);
  });
});

describe('resolveSound', () => {
  /** @param {string} id */
  const bundledPath = (id) => path.join(pluginRoot, 'sounds', `${id}.wav`);
  const options = () => ({ pluginRoot, dataDir });

  /** @param {string} file */
  function touch(file) {
    write(file, 'RIFF');
  }

  it('returns the event sound when the file exists', () => {
    touch(bundledPath('done'));
    const result = resolveSound(load(), 'agent_done', 'opus', options());
    assert.deepEqual(result, { kind: 'file', value: bundledPath('done') });
  });

  it('applies a byModel override for an agent event', () => {
    touch(bundledPath('done'));
    touch(bundledPath('error'));
    writeGlobal({ events: { agent_done: { byModel: { opus: 'default:error' } } } });
    const result = resolveSound(load(), 'agent_done', 'opus', options());
    assert.deepEqual(result, { kind: 'file', value: bundledPath('error') });
  });

  it('ignores the byModel override for a different family', () => {
    touch(bundledPath('done'));
    touch(bundledPath('error'));
    writeGlobal({ events: { agent_done: { byModel: { opus: 'default:error' } } } });
    const result = resolveSound(load(), 'agent_done', 'sonnet', options());
    assert.equal(result.value, bundledPath('done'));
  });

  it('never applies byModel to non-agent events', () => {
    touch(bundledPath('question'));
    touch(bundledPath('error'));
    const config = load();
    // Force a byModel onto a non-agent event, bypassing normalization.
    /** @type {any} */ (config.events.question).byModel = { opus: 'default:error' };
    const result = resolveSound(config, 'question', 'opus', options());
    assert.equal(result.value, bundledPath('question'));
  });

  it('falls back to the event sound when a byModel file is missing', () => {
    touch(bundledPath('done'));
    writeGlobal({ events: { agent_done: { byModel: { opus: 'user:gone.wav' } } } });
    const result = resolveSound(load(), 'agent_done', 'opus', options());
    assert.equal(result.value, bundledPath('done'));
  });

  it('resolves a user sound under <dataDir>/sounds', () => {
    const file = path.join(dataDir, 'sounds', 'mine.wav');
    touch(file);
    writeGlobal({ events: { error: { sound: 'user:mine.wav' } } });
    assert.deepEqual(resolveSound(load(), 'error', 'other', options()), { kind: 'file', value: file });
  });

  it('falls back to the bundled default when a user file is missing', () => {
    writeGlobal({ events: { error: { sound: 'user:missing.wav' } } });
    const result = resolveSound(load(), 'error', 'other', options());
    assert.deepEqual(result, { kind: 'file', value: bundledPath('error') });
  });

  it('resolves an absolute path sound', () => {
    const file = path.join(tmp, 'elsewhere.wav');
    touch(file);
    writeGlobal({ events: { error: { sound: file } } });
    const result = resolveSound(load(), 'error', 'other', options());
    assert.deepEqual(result, { kind: 'file', value: path.resolve(file) });
  });

  it('treats a directory as a missing sound', () => {
    fs.mkdirSync(path.join(dataDir, 'sounds', 'dir.wav'), { recursive: true });
    writeGlobal({ events: { error: { sound: 'user:dir.wav' } } });
    const result = resolveSound(load(), 'error', 'other', options());
    assert.equal(result.value, bundledPath('error'));
  });

  it('returns the bundled default even when it is missing on disk', () => {
    const result = resolveSound(load(), 'permission', 'other', options());
    assert.deepEqual(result, { kind: 'file', value: bundledPath('permission') });
    assert.equal(fs.existsSync(result.value), false);
  });

  it('falls back to the bundled default for an invalid spec in a hand-built config', () => {
    const config = load();
    config.events.error.sound = 'bogus';
    const result = resolveSound(config, 'error', 'other', options());
    assert.equal(result.value, bundledPath('error'));
  });

  it('resolves tts to the spoken text', () => {
    writeGlobal({ events: { agent_done: { sound: 'tts' } } });
    const result = resolveSound(load(), 'agent_done', 'opus', options());
    assert.deepEqual(result, { kind: 'tts', value: 'Opus finished' });
  });

  it('resolves a tts byModel override ahead of a file sound', () => {
    touch(bundledPath('done'));
    writeGlobal({ events: { agent_done: { byModel: { haiku: 'tts' } } } });
    const result = resolveSound(load(), 'agent_done', 'haiku', options());
    assert.deepEqual(result, { kind: 'tts', value: 'Haiku finished' });
  });
});

describe('ttsText', () => {
  it('capitalizes a known family', () => {
    assert.equal(ttsText(load(), 'agent_done', 'sonnet'), 'Sonnet finished');
  });

  it('uses Claude for the other family', () => {
    assert.equal(ttsText(load(), 'question', 'other'), 'Claude has a question');
  });

  it('uses Claude for a family that is not configured', () => {
    assert.equal(ttsText(load(), 'error', 'gemini'), 'Claude hit an error');
  });

  it('does not treat inherited object keys as families', () => {
    assert.equal(ttsText(load(), 'error', 'constructor'), 'Claude hit an error');
  });

  it('supports a custom template with repeated placeholders', () => {
    writeGlobal({ tts: { template: '{model}! {model} {event}' } });
    assert.equal(ttsText(load(), 'permission', 'fable'), 'Fable! Fable needs permission');
  });

  it('inserts replacement text literally', () => {
    const config = load();
    config.modelPatterns['$&'] = 'x';
    assert.equal(ttsText(config, 'error', '$&'), '$& hit an error');
  });

  it('trims the result', () => {
    writeGlobal({ tts: { template: '  {event}  ' } });
    assert.equal(ttsText(load(), 'agent_done', 'opus'), 'finished');
  });
});

describe('effectiveVolume', () => {
  it('uses the global volume when the event volume is null', () => {
    writeGlobal({ volume: 0.4 });
    assert.equal(effectiveVolume(load(), 'error'), 0.4);
  });

  it('uses the event volume when set', () => {
    writeGlobal({ volume: 0.4, events: { error: { volume: 0.9 } } });
    assert.equal(effectiveVolume(load(), 'error'), 0.9);
  });

  it('treats an event volume of zero as set, not as null', () => {
    writeGlobal({ volume: 0.4, events: { error: { volume: 0 } } });
    assert.equal(effectiveVolume(load(), 'error'), 0);
  });
});

describe('saveConfig', () => {
  it('round-trips through loadConfig', () => {
    const config = load();
    config.volume = 0.35;
    config.events.error.sound = 'tts';
    saveConfig(config, { dataDir });
    assert.deepEqual(loadConfig({ dataDir }), config);
  });

  it('returns the normalized config it wrote', () => {
    const result = saveConfig({ volume: 5, bogus: true }, { dataDir });
    assert.equal(result.volume, 1);
    assert.equal('bogus' in result, false);
  });

  it('writes normalized JSON with a trailing newline', () => {
    saveConfig({ volume: 5, bogus: true }, { dataDir });
    const text = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
    assert.ok(text.endsWith('}\n'));
    assert.ok(!text.endsWith('\n\n'));
    const parsed = JSON.parse(text);
    assert.equal(parsed.volume, 1);
    assert.equal('bogus' in parsed, false);
  });

  it('falls back to defaults for a non-object config', () => {
    assert.deepEqual(saveConfig('nonsense', { dataDir }), DEFAULTS);
  });

  it('creates missing directories', () => {
    const nested = path.join(tmp, 'a', 'b', 'c');
    saveConfig({}, { dataDir: nested });
    assert.ok(fs.existsSync(path.join(nested, 'config.json')));
  });

  it('overwrites an existing config', () => {
    saveConfig({ volume: 0.1 }, { dataDir });
    saveConfig({ volume: 0.2 }, { dataDir });
    assert.equal(loadConfig({ dataDir }).volume, 0.2);
  });

  it('leaves no temp files behind after success', () => {
    saveConfig({}, { dataDir });
    saveConfig({}, { dataDir });
    assert.deepEqual(fs.readdirSync(dataDir), ['config.json']);
  });

  it('leaves no temp files behind and rethrows when the write fails', () => {
    // A directory at the target path makes the final rename fail.
    fs.mkdirSync(path.join(dataDir, 'config.json'));
    fs.writeFileSync(path.join(dataDir, 'config.json', 'keep'), 'x');
    assert.throws(() => saveConfig({}, { dataDir }));
    assert.deepEqual(fs.readdirSync(dataDir), ['config.json']);
  });
});
