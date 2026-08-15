import { readFileSync } from 'node:fs';
import path from 'node:path';

// Load .env.local the same way the scripts do. Real env always wins so CI can
// inject secrets without a file on disk.
try {
  const text = readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].replace(/\s+#.*$/, '').trim().replace(/^["'](.*)["']$/, '$1');
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = value;
  }
} catch {
  /* CI supplies the environment directly */
}
