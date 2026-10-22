// @ts-check
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the plugin's root directory.
 * @returns {string}
 */
export function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/**
 * Resolve the directory used for persistent plugin data (not created here).
 * @returns {string}
 */
export function dataDir() {
  return (
    process.env.CLAUDIO_DATA_DIR
    || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claudio-notify')
  );
}
