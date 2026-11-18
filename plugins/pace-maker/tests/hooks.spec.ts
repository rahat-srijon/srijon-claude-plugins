import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|jsx?|json)$/.test(n) ? [p] : [];
  });
const code = sources(join(root, 'hooks')).map((p) => [p, readFileSync(p, 'utf8')] as const);

// A plugin above ours skips classic.* and prompt.compose hooks and the engine prints a notice for each, so none may be registered.
test('no hook is registered on a classic.* event or on prompt.compose', () => {
  assert.ok(code.length > 0);
  for (const [path, text] of code) {
    assert.doesNotMatch(text, /\bon\(\s*['"`]classic\./, `${path} registers a classic.* hook`);
    assert.doesNotMatch(text, /\bon\(\s*['"`]prompt\.compose/, `${path} registers prompt.compose`);
  }
});

test('the settings server, the config file and the AI task-list option are gone', () => {
  assert.equal(existsSync(join(root, 'scripts')), false);
  for (const [path, text] of code) {
    assert.doesNotMatch(text, /askForTaskList|PACE_MAKER_DATA_DIR|config\.json|\$\.fs\b|\$\.env\b|\$\.process\b/, path);
  }
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(JSON.stringify(manifest.userConfig).includes('askForTaskList'), false);
  const hooks = readFileSync(join(root, 'hooks', 'register.tsx'), 'utf8');
  assert.doesNotMatch(hooks, /\bconfig\b['"`]|\|config/);
});

test('the module reads its options from register', () => {
  const register = readFileSync(join(root, 'hooks', 'register.tsx'), 'utf8');
  assert.match(register, /register: Register = \(on, options\)/);
  assert.match(register, /normalizeSettings\(options\)/);
});
