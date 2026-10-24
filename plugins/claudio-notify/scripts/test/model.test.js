// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Keep log.js away from the real ~/.claude.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-model-'));
process.env.CLAUDIO_DATA_DIR = dataDir;

const { modelFromTranscript, modelFromAgentDefinition, familyOf } = await import('../lib/model.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'model');
const KB = 1024;
const MIB = 1024 * 1024;

/** @type {string[]} */
const tempDirs = [dataDir];

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create a fresh temp directory.
 * @returns {string}
 */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-model-case-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * @param {string} name
 * @returns {string}
 */
function fixture(name) {
  return path.join(FIXTURES, name);
}

/**
 * @param {string} model
 * @returns {string}
 */
function assistantLine(model) {
  return JSON.stringify({ type: 'assistant', message: { model, role: 'assistant', content: 'x' } });
}

/**
 * Build user lines totalling at least `bytes` bytes.
 * @param {number} bytes
 * @returns {string}
 */
function userPadding(bytes) {
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'p'.repeat(500) } });
  const count = Math.ceil(bytes / (line.length + 1));
  return `${Array.from({ length: count }, () => line).join('\n')}\n`;
}

/**
 * Write a transcript with an assistant line followed by `padding` bytes of user lines.
 * @param {string} model
 * @param {number} padding
 * @returns {string}
 */
function transcriptWithTrailingPadding(model, padding) {
  const file = path.join(tempDir(), 'transcript.jsonl');
  fs.writeFileSync(file, `${assistantLine(model)}\n${userPadding(padding)}`);
  return file;
}

/**
 * Write an agent definition under `<root>/.claude/agents/<relative>`.
 * @param {string} root
 * @param {string} relative
 * @param {string | Buffer} content
 */
function writeAgent(root, relative, content) {
  const file = path.join(root, '.claude', 'agents', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Copy a fixture into `<root>/.claude/agents/<relative>`.
 * @param {string} root
 * @param {string} relative
 * @param {string} name
 */
function installFixture(root, relative, name) {
  writeAgent(root, relative, fs.readFileSync(fixture(name)));
}

describe('modelFromTranscript', () => {
  it('returns the newest assistant model', () => {
    assert.equal(modelFromTranscript(fixture('transcript-basic.jsonl')), 'claude-opus-5-5');
  });

  it('skips the <synthetic> placeholder', () => {
    assert.equal(modelFromTranscript(fixture('transcript-synthetic.jsonl')), 'claude-haiku-4-5');
  });

  it('returns null when only synthetic entries exist', () => {
    const file = path.join(tempDir(), 't.jsonl');
    fs.writeFileSync(file, `${assistantLine('<synthetic>')}\n`);
    assert.equal(modelFromTranscript(file), null);
  });

  it('ignores a truncated last line', () => {
    assert.equal(modelFromTranscript(fixture('transcript-truncated.jsonl')), 'claude-opus-5-5');
  });

  it('ignores a garbage last line', () => {
    const file = path.join(tempDir(), 't.jsonl');
    fs.writeFileSync(file, `${assistantLine('claude-opus-5-5')}\n\u0000\u0001 not json {{{\n`);
    assert.equal(modelFromTranscript(file), 'claude-opus-5-5');
  });

  it('ignores non-assistant lines that carry a model', () => {
    const file = path.join(tempDir(), 't.jsonl');
    const stray = JSON.stringify({ type: 'user', message: { model: 'claude-haiku-4-5' } });
    fs.writeFileSync(file, `${assistantLine('claude-opus-5-5')}\n${stray}\n`);
    assert.equal(modelFromTranscript(file), 'claude-opus-5-5');
  });

  it('handles a file without a trailing newline and with CRLF endings', () => {
    const file = path.join(tempDir(), 't.jsonl');
    fs.writeFileSync(file, `${assistantLine('claude-sonnet-4-5')}\r\n${assistantLine('claude-opus-5-5')}`);
    assert.equal(modelFromTranscript(file), 'claude-opus-5-5');
  });

  it('finds an entry beyond the 64 KB tail via the 1 MiB retry', () => {
    const file = transcriptWithTrailingPadding('claude-opus-5-5', 200 * KB);
    assert.ok(fs.statSync(file).size > 64 * KB);
    assert.equal(modelFromTranscript(file), 'claude-opus-5-5');
  });

  it('returns null for an entry beyond 1 MiB', () => {
    const file = transcriptWithTrailingPadding('claude-opus-5-5', MIB + 64 * KB);
    assert.equal(modelFromTranscript(file), null);
  });

  it('returns null for an empty file', () => {
    const file = path.join(tempDir(), 'empty.jsonl');
    fs.writeFileSync(file, '');
    assert.equal(modelFromTranscript(file), null);
  });

  it('returns null for a missing file', () => {
    assert.equal(modelFromTranscript(path.join(tempDir(), 'missing.jsonl')), null);
  });

  it('returns null for a null, undefined or empty path', () => {
    assert.equal(modelFromTranscript(null), null);
    assert.equal(modelFromTranscript(undefined), null);
    assert.equal(modelFromTranscript(''), null);
  });

  it('returns null for a directory', () => {
    assert.equal(modelFromTranscript(tempDir()), null);
  });

  it('respects a custom maxBytes by not retrying once it reaches 1 MiB', () => {
    const file = transcriptWithTrailingPadding('claude-opus-5-5', MIB + 64 * KB);
    assert.equal(modelFromTranscript(file, { maxBytes: MIB }), null);
    assert.equal(modelFromTranscript(file, { maxBytes: 2 * MIB }), 'claude-opus-5-5');
  });

  it('still retries when a custom maxBytes is smaller than 1 MiB', () => {
    const file = transcriptWithTrailingPadding('claude-opus-5-5', 20 * KB);
    assert.equal(modelFromTranscript(file, { maxBytes: 4 * KB }), 'claude-opus-5-5');
  });

  it('reads only the tail for a custom maxBytes when the newest entry fits', () => {
    const file = path.join(tempDir(), 't.jsonl');
    fs.writeFileSync(file, `${assistantLine('claude-sonnet-4-5')}\n${userPadding(8 * KB)}${assistantLine('claude-opus-5-5')}\n`);
    assert.equal(modelFromTranscript(file, { maxBytes: 2 * KB }), 'claude-opus-5-5');
  });
});

describe('modelFromAgentDefinition', () => {
  it('lets a project definition override home', () => {
    const project = tempDir();
    const home = tempDir();
    writeAgent(project, 'reviewer.md', '---\nname: reviewer\nmodel: opus\n---\n');
    writeAgent(home, 'reviewer.md', '---\nname: reviewer\nmodel: haiku\n---\n');
    assert.equal(modelFromAgentDefinition('reviewer', { projectDir: project, homeDir: home }), 'opus');
  });

  it('falls back to home when the project has no match', () => {
    const project = tempDir();
    const home = tempDir();
    writeAgent(project, 'other.md', '---\nname: other\nmodel: opus\n---\n');
    installFixture(home, 'reviewer.md', 'agent-reviewer.md');
    assert.equal(modelFromAgentDefinition('reviewer', { projectDir: project, homeDir: home }), 'sonnet');
  });

  it('works with a home directory only', () => {
    const home = tempDir();
    installFixture(home, 'reviewer.md', 'agent-reviewer.md');
    assert.equal(modelFromAgentDefinition('reviewer', { homeDir: home }), 'sonnet');
  });

  it('matches on the frontmatter name rather than the file name', () => {
    const home = tempDir();
    installFixture(home, 'whatever.md', 'agent-reviewer.md');
    assert.equal(modelFromAgentDefinition('reviewer', { homeDir: home }), 'sonnet');
  });

  it('searches one level of subdirectory', () => {
    const home = tempDir();
    installFixture(home, path.join('team', 'reviewer.md'), 'agent-reviewer.md');
    assert.equal(modelFromAgentDefinition('reviewer', { homeDir: home }), 'sonnet');
  });

  it('does not search two levels deep', () => {
    const home = tempDir();
    installFixture(home, path.join('team', 'deep', 'reviewer.md'), 'agent-reviewer.md');
    assert.equal(modelFromAgentDefinition('reviewer', { homeDir: home }), null);
  });

  it('matches a plugin-qualified type against the short name', () => {
    const home = tempDir();
    installFixture(home, 'reviewer.md', 'agent-reviewer.md');
    assert.equal(modelFromAgentDefinition('myplugin:reviewer', { homeDir: home }), 'sonnet');
  });

  it('matches a plugin-qualified type against a qualified name', () => {
    const home = tempDir();
    writeAgent(home, 'q.md', '---\nname: myplugin:reviewer\nmodel: opus\n---\n');
    assert.equal(modelFromAgentDefinition('myplugin:reviewer', { homeDir: home }), 'opus');
  });

  it('never matches an agent whose name is empty', () => {
    const home = tempDir();
    writeAgent(home, 'blank.md', '---\nname:\nmodel: opus\n---\n');
    assert.equal(modelFromAgentDefinition('myplugin:', { homeDir: home }), null);
  });

  it('strips quotes from values', () => {
    const home = tempDir();
    installFixture(home, 'quoted.md', 'agent-quoted.md');
    assert.equal(modelFromAgentDefinition('quoted', { homeDir: home }), 'claude-opus-5-5');
  });

  it('strips single quotes and ignores a comment after a quoted value', () => {
    const home = tempDir();
    writeAgent(home, 'a.md', '---\nname: a\nmodel: \'opus\' # note\n---\n');
    assert.equal(modelFromAgentDefinition('a', { homeDir: home }), 'opus');
  });

  it('strips trailing # comments from unquoted values', () => {
    const home = tempDir();
    installFixture(home, 'commented.md', 'agent-commented.md');
    assert.equal(modelFromAgentDefinition('commented', { homeDir: home }), 'haiku');
  });

  it('keeps a # that is not preceded by whitespace', () => {
    const home = tempDir();
    writeAgent(home, 'a.md', '---\nname: a\nmodel: claude#x\n---\n');
    assert.equal(modelFromAgentDefinition('a', { homeDir: home }), 'claude#x');
  });

  it('handles CRLF line endings', () => {
    const home = tempDir();
    writeAgent(home, 'a.md', '---\r\nname: a\r\nmodel: opus\r\n---\r\nBody\r\n');
    assert.equal(modelFromAgentDefinition('a', { homeDir: home }), 'opus');
  });

  it('handles a UTF-8 BOM', () => {
    const home = tempDir();
    writeAgent(home, 'a.md', '﻿---\nname: a\nmodel: opus\n---\n');
    assert.equal(modelFromAgentDefinition('a', { homeDir: home }), 'opus');
  });

  it('handles a BOM together with CRLF', () => {
    const home = tempDir();
    writeAgent(home, 'a.md', '﻿---\r\nname: a\r\nmodel: "opus"\r\n---\r\n');
    assert.equal(modelFromAgentDefinition('a', { homeDir: home }), 'opus');
  });

  it('returns null for model: inherit in any case', () => {
    const home = tempDir();
    installFixture(home, 'inheriting.md', 'agent-inherit.md');
    assert.equal(modelFromAgentDefinition('inheriting', { homeDir: home }), null);
    writeAgent(home, 'upper.md', '---\nname: upper\nmodel: INHERIT\n---\n');
    assert.equal(modelFromAgentDefinition('upper', { homeDir: home }), null);
  });

  it('returns null when the model is missing', () => {
    const home = tempDir();
    installFixture(home, 'nomodel.md', 'agent-nomodel.md');
    assert.equal(modelFromAgentDefinition('nomodel', { homeDir: home }), null);
  });

  it('does not fall through to home when the project match has no model', () => {
    const project = tempDir();
    const home = tempDir();
    installFixture(project, 'nomodel.md', 'agent-nomodel.md');
    writeAgent(home, 'nomodel.md', '---\nname: nomodel\nmodel: opus\n---\n');
    assert.equal(modelFromAgentDefinition('nomodel', { projectDir: project, homeDir: home }), null);
  });

  it('returns null when there is no frontmatter', () => {
    const home = tempDir();
    installFixture(home, 'plain.md', 'agent-nofrontmatter.md');
    assert.equal(modelFromAgentDefinition('reviewer', { homeDir: home }), null);
  });

  it('returns null when the frontmatter is never closed', () => {
    const home = tempDir();
    writeAgent(home, 'a.md', '---\nname: a\nmodel: opus\n');
    assert.equal(modelFromAgentDefinition('a', { homeDir: home }), null);
  });

  it('returns null for an empty, null or undefined type', () => {
    const home = tempDir();
    writeAgent(home, 'blank.md', '---\nname:\nmodel: opus\n---\n');
    assert.equal(modelFromAgentDefinition('', { homeDir: home }), null);
    assert.equal(modelFromAgentDefinition(null, { homeDir: home }), null);
    assert.equal(modelFromAgentDefinition(undefined, { homeDir: home }), null);
  });

  it('returns null when no agent matches or the agents directory is missing', () => {
    const home = tempDir();
    installFixture(home, 'reviewer.md', 'agent-reviewer.md');
    assert.equal(modelFromAgentDefinition('nobody', { homeDir: home }), null);
    assert.equal(modelFromAgentDefinition('reviewer', { homeDir: tempDir() }), null);
  });

  it('ignores non-markdown files', () => {
    const home = tempDir();
    writeAgent(home, 'reviewer.txt', '---\nname: reviewer\nmodel: opus\n---\n');
    assert.equal(modelFromAgentDefinition('reviewer', { homeDir: home }), null);
  });

  it('skips an unreadable entry named like a markdown file', () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, '.claude', 'agents', 'folder.md'), { recursive: true });
    installFixture(home, 'reviewer.md', 'agent-reviewer.md');
    assert.equal(modelFromAgentDefinition('reviewer', { homeDir: home }), 'sonnet');
  });
});

describe('familyOf', () => {
  const patterns = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' };

  it('maps full model ids', () => {
    assert.equal(familyOf('claude-opus-5-5', patterns), 'opus');
    assert.equal(familyOf('claude-sonnet-4-5-20250929', patterns), 'sonnet');
    assert.equal(familyOf('claude-haiku-4-5', patterns), 'haiku');
  });

  it('maps ids with a context suffix', () => {
    assert.equal(familyOf('claude-opus-5-5[1m]', patterns), 'opus');
  });

  it('maps aliases', () => {
    assert.equal(familyOf('opus', patterns), 'opus');
    assert.equal(familyOf('sonnet', patterns), 'sonnet');
    assert.equal(familyOf('haiku', patterns), 'haiku');
  });

  it('is case-insensitive for ids and patterns', () => {
    assert.equal(familyOf('Claude-OPUS-5-5', patterns), 'opus');
    assert.equal(familyOf('claude-opus-5-5', { big: 'OPUS' }), 'big');
  });

  it('lets insertion order win when two patterns match', () => {
    assert.equal(familyOf('claude-opus-sonnet', { opus: 'opus', sonnet: 'sonnet' }), 'opus');
    assert.equal(familyOf('claude-opus-sonnet', { sonnet: 'sonnet', opus: 'opus' }), 'sonnet');
    assert.equal(familyOf('claude-opus-5-5', { broad: 'claude', opus: 'opus' }), 'broad');
  });

  it('supports user-defined families', () => {
    const custom = { fast: 'haiku', smart: 'opus', local: 'llama' };
    assert.equal(familyOf('claude-haiku-4-5', custom), 'fast');
    assert.equal(familyOf('claude-opus-5-5', custom), 'smart');
    assert.equal(familyOf('my-llama-3', custom), 'local');
  });

  it('returns other for null, undefined or empty ids', () => {
    assert.equal(familyOf(null, patterns), 'other');
    assert.equal(familyOf(undefined, patterns), 'other');
    assert.equal(familyOf('', patterns), 'other');
  });

  it('returns other when nothing matches', () => {
    assert.equal(familyOf('gpt-5', patterns), 'other');
  });

  it('returns other for empty or missing patterns', () => {
    assert.equal(familyOf('claude-opus-5-5', {}), 'other');
    // @ts-expect-error exercising a defensive null check
    assert.equal(familyOf('claude-opus-5-5', null), 'other');
  });

  it('ignores empty-string patterns', () => {
    assert.equal(familyOf('claude-opus-5-5', { any: '', opus: 'opus' }), 'opus');
  });
});
