import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Loads .env.local into process.env without a dependency. Real environment
 * variables always win, so CI can override anything.
 */
export function loadEnv(file = '.env.local') {
  try {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      // Strip trailing inline comments and surrounding quotes.
      const value = m[2].replace(/\s+#.*$/, '').trim().replace(/^["'](.*)["']$/, '$1');
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
    }
  } catch {
    /* fall back to the real environment */
  }
  return process.env;
}

export const ROOT = root;

export const ok = (s) => `\x1b[32m${s}\x1b[0m`;
export const bad = (s) => `\x1b[31m${s}\x1b[0m`;
export const warn = (s) => `\x1b[33m${s}\x1b[0m`;
export const dim = (s) => `\x1b[2m${s}\x1b[0m`;
