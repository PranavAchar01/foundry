#!/usr/bin/env node
/**
 * Operator reset: tear the portfolio down to a cold start.
 *
 *   node scripts/reset-portfolio.mjs --dry     # show what would go
 *   node scripts/reset-portfolio.mjs --yes     # actually do it
 *
 * Order matters — real resources first, database last, so a failure never
 * leaves a paid-for VM or a live storefront orphaned from its record:
 *   1. kill every Superserve machine
 *   2. delete every spawned Vercel storefront project
 *   3. archive the businesses and delete their pageviews
 *
 * What does NOT go: `ledger_entries`, `decisions` and `machine_runs` are
 * append-only at the database level. A reset must not be able to rewrite what
 * was actually spent or actually decided, so those survive and the P&L keeps
 * showing real historical spend. Archived businesses are hidden from the
 * portfolio instead of deleted.
 *
 * Never touches the Foundry project itself, or `landing`.
 */
import pg from 'pg';
import { bad, dim, loadEnv, ok, warn } from './_env.mjs';

loadEnv();

const DRY = !process.argv.includes('--yes');
const PROTECTED = new Set([process.env.VERCEL_PROJECT_NAME || 'foundry-biz', 'landing']);

const client = new pg.Client({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const vercel = async (method, path) => {
  const res = await fetch(
    `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${process.env.VERCEL_TEAM_ID}`,
    { method, headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } },
  );
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

try {
  const { rows: businesses } = await client.query(
    `SELECT id, name, url, status FROM businesses WHERE NOT archived AND NOT is_fixture`,
  );
  const { rows: machines } = await client.query(
    `SELECT id, business_id, external_id FROM machines WHERE status <> 'killed'`,
  );
  const { projects } = (await vercel('GET', '/v9/projects?limit=100')).json;
  const doomed = (projects ?? []).filter(
    (p) => p.name.startsWith('foundry-biz-') && !PROTECTED.has(p.name),
  );

  console.log(dim('reset plan\n'));
  console.log(`  businesses to archive : ${businesses.length}`);
  console.log(`  machines to destroy   : ${machines.length}`);
  console.log(`  vercel projects to del: ${doomed.length}`);
  for (const p of doomed) console.log(dim(`      ${p.name}`));
  console.log(dim(`  protected             : ${[...PROTECTED].join(', ')}`));
  console.log(dim('  preserved (append-only): ledger_entries, decisions, machine_runs\n'));

  if (DRY) {
    console.log(warn('dry run — nothing changed. Re-run with --yes to execute.'));
    process.exit(0);
  }

  // 1. machines ------------------------------------------------------------
  let killed = 0;
  if (process.env.SUPERSERVE_API_KEY && machines.length) {
    const { Sandbox } = await import('@superserve/sdk');
    for (const m of machines) {
      try {
        const box = await Sandbox.connect(m.external_id, { apiKey: process.env.SUPERSERVE_API_KEY });
        await box.kill();
        killed++;
      } catch (err) {
        console.log(warn('NOTE') + `  ${m.external_id} already gone: ${String(err.message).slice(0, 80)}`);
      }
      await client.query(
        `UPDATE machines SET status = 'killed', killed_at = now(),
                meta = meta || '{"killReason":"operator reset"}'::jsonb
          WHERE id = $1`,
        [m.id],
      );
    }
  }
  console.log(ok('DONE') + `  ${killed}/${machines.length} machines destroyed`);

  // 2. storefronts ---------------------------------------------------------
  let deleted = 0;
  for (const p of doomed) {
    const res = await vercel('DELETE', `/v9/projects/${p.id}`);
    if (res.status < 300) deleted++;
    else console.log(bad('FAIL') + `  ${p.name} -> ${res.status}`);
  }
  console.log(ok('DONE') + `  ${deleted}/${doomed.length} vercel projects deleted`);

  // 3. database ------------------------------------------------------------
  const { rowCount: visitsGone } = await client.query(
    `DELETE FROM visits WHERE business_id IN (SELECT id FROM businesses WHERE NOT archived AND NOT is_fixture)`,
  );
  const { rowCount: archived } = await client.query(
    `UPDATE businesses
        SET archived = true, status = 'KILLED', killed_at = COALESCE(killed_at, now()),
            kill_reason = COALESCE(kill_reason, 'operator reset'), updated_at = now()
      WHERE NOT archived AND NOT is_fixture`,
  );
  console.log(ok('DONE') + `  ${archived} businesses archived, ${visitsGone} pageviews deleted`);

  const { rows: after } = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM businesses WHERE NOT archived AND NOT is_fixture) AS live,
       (SELECT COUNT(*) FROM machines WHERE status <> 'killed')                AS machines,
       (SELECT COUNT(*) FROM ledger_entries)                                   AS ledger,
       (SELECT COUNT(*) FROM decisions)                                        AS decisions`,
  );
  console.log('');
  console.log(
    ok('reset complete') +
      dim(
        `  live businesses=${after[0].live} machines=${after[0].machines} · ` +
          `preserved ledger=${after[0].ledger} decisions=${after[0].decisions}`,
      ),
  );
} finally {
  await client.end();
}
