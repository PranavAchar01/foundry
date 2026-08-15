#!/usr/bin/env node
/**
 * Applies lib/schema.sql to POSTGRES_URL. Idempotent — safe on every deploy.
 *
 *   node scripts/migrate.mjs [--verify]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ROOT, bad, dim, loadEnv, ok } from './_env.mjs';

loadEnv();

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error(bad('FAIL') + '  POSTGRES_URL is not set');
  process.exit(1);
}

const sql = readFileSync(path.join(ROOT, 'lib/schema.sql'), 'utf8');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const EXPECTED = [
  'businesses',
  'hypotheses',
  'ledger_entries',
  'decisions',
  'escalations',
  'labor_quotes',
  'visits',
  'bus_messages',
  'circuit_breaker',
  'machines',
  'machine_runs',
];

await client.connect();

try {
  await client.query(sql);
  console.log(ok('PASS') + '  schema applied');

  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const present = new Set(rows.map((r) => r.table_name));
  let failed = false;
  for (const table of EXPECTED) {
    if (present.has(table)) {
      console.log(ok('PASS') + `  table ${table}`);
    } else {
      failed = true;
      console.log(bad('FAIL') + `  table ${table} MISSING`);
    }
  }

  // Prove the append-only trigger is live rather than assuming it.
  // Zero-amount so the probe can never move the P&L it is checking.
  const probe = `migrate_probe_${Date.now()}`;
  await client.query(
    `INSERT INTO ledger_entries (id, business_id, kind, amount_cents, description, external_id)
     VALUES ($1, NULL, 'OPEX', 0, 'append-only trigger probe (zero amount)', $1)`,
    [probe],
  );
  let appendOnly = false;
  try {
    await client.query(`DELETE FROM ledger_entries WHERE id = $1`, [probe]);
  } catch (err) {
    appendOnly = /append-only/i.test(String(err.message));
  }
  console.log(
    appendOnly
      ? ok('PASS') + '  ledger_entries is append-only (DELETE rejected by trigger)'
      : bad('FAIL') + '  ledger_entries accepted a DELETE — append-only trigger is not active',
  );
  if (!appendOnly) failed = true;
  console.log(dim(`       probe row ${probe} stays in the ledger — that is the point of append-only`));

  console.log('');
  console.log(failed ? bad('migrate: FAILED') : ok('migrate: OK'));
  process.exit(failed ? 1 : 0);
} finally {
  await client.end();
}
