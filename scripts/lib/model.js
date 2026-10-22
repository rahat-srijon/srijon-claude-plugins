// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log.js';

const DEFAULT_TAIL_BYTES = 64 * 1024;
const RETRY_TAIL_BYTES = 1024 * 1024;

/**
 * Read the last `maxBytes` of a file as complete lines.
 * @param {string} file
 * @param {number} maxBytes
 * @returns {{ lines: string[], whole: boolean }}
 */
function readTailLines(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (read === 0) {
        break;
      }
      offset += read;
    }
    let text = buffer.toString('utf8', 0, offset);
    if (start > 0) {
      // The first line is almost certainly cut mid-entry (and maybe mid-character).
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return { lines: text.split('\n'), whole: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Find the model of the newest assistant entry among JSONL lines.
 * @param {string[]} lines
 * @returns {string | null}
 */
function lastAssistantModel(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const model = entry?.type === 'assistant' ? entry.message?.model : undefined;
    // Placeholders such as '<synthetic>' mark locally generated messages, not a model.
    if (typeof model === 'string' && model && !model.startsWith('<')) {
      return model;
    }
  }
  return null;
}

/**
 * Infer the model from a Claude Code JSONL transcript (main or subagent) by
 * reading only its tail, retrying once with a larger tail if needed.
 * @param {string | null | undefined} file
 * @param {{ maxBytes?: number }} [options]
 * @returns {string | null}
 */
export function modelFromTranscript(file, { maxBytes = DEFAULT_TAIL_BYTES } = {}) {
  if (!file) {
    return null;
  }
  try {
    const first = readTailLines(file, maxBytes);
    const model = lastAssistantModel(first.lines);
    if (model || first.whole || maxBytes >= RETRY_TAIL_BYTES) {
      return model;
    }
    return lastAssistantModel(readTailLines(file, RETRY_TAIL_BYTES).lines);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') {
      log('debug', `Could not read transcript ${file}`, err);
    }
    return null;
  }
}

/**
 * Parse a scalar YAML value: strip surrounding quotes, or a trailing comment
 * when unquoted.
 * @param {string} raw
 * @returns {string}
 */
function parseScalar(raw) {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === '\'') {
    const end = value.indexOf(quote, 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  return value.replace(/\s+#.*$/, '').trim();
}

/**
 * Parse the simple `key: value` lines of a Markdown file's YAML frontmatter.
 * @param {string} text
 * @returns {Record<string, string> | null}
 */
function parseFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') {
    return null;
  }
  /** @type {Record<string, string>} */
  const fields = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') {
      return fields;
    }
    const match = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line);
    if (match) {
      fields[match[1]] = parseScalar(match[2]);
    }
  }
  return null;
}

/**
 * List the `.md` files in a directory and its immediate subdirectories.
 * @param {string} dir
 * @returns {string[]}
 */
function agentFiles(dir) {
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(dir, entry.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sub = path.join(dir, entry.name);
    try {
      for (const name of fs.readdirSync(sub).sort()) {
        if (name.endsWith('.md')) {
          files.push(path.join(sub, name));
        }
      }
    } catch {
      // An unreadable subdirectory just contributes no agents.
    }
  }
  return files;
}

/**
 * Look up the model declared by a custom agent definition. Project agents in
 * `<projectDir>/.claude/agents/` take precedence over `<homeDir>/.claude/agents/`.
 * @param {string | null | undefined} agentType Subagent type, e.g. `reviewer` or `myplugin:reviewer`.
 * @param {{ projectDir?: string, homeDir?: string }} [options]
 * @returns {string | null} The model, or null for `inherit`, no model, or no matching agent.
 */
export function modelFromAgentDefinition(agentType, { projectDir, homeDir = os.homedir() } = {}) {
  if (!agentType) {
    return null;
  }
  const shortName = agentType.slice(agentType.lastIndexOf(':') + 1);
  const roots = [projectDir, homeDir].filter((root) => typeof root === 'string' && root);
  try {
    for (const root of roots) {
      for (const file of agentFiles(path.join(/** @type {string} */ (root), '.claude', 'agents'))) {
        let fields;
        try {
          fields = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        } catch {
          continue;
        }
        if (!fields?.name || (fields.name !== agentType && fields.name !== shortName)) {
          continue;
        }
        const model = fields.model;
        return !model || model.toLowerCase() === 'inherit' ? null : model;
      }
    }
  } catch (err) {
    log('debug', `Could not resolve agent definition for ${agentType}`, err);
  }
  return null;
}

/**
 * Map a model id to a family using case-insensitive substring patterns,
 * checked in insertion order.
 * @param {string | null | undefined} modelId e.g. `claude-opus-5-5[1m]`, `haiku`.
 * @param {Record<string, string>} patterns e.g. `{ opus: 'opus', sonnet: 'sonnet' }`.
 * @returns {string} The first matching family, or `'other'`.
 */
export function familyOf(modelId, patterns) {
  if (!modelId) {
    return 'other';
  }
  const id = modelId.toLowerCase();
  for (const [family, substring] of Object.entries(patterns ?? {})) {
    if (typeof substring === 'string' && substring && id.includes(substring.toLowerCase())) {
      return family;
    }
  }
  return 'other';
}
