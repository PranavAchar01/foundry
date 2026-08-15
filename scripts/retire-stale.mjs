#!/usr/bin/env node
/**
 * Retires businesses whose deployed page still calls a dead origin.
 *
 *   node scripts/retire-stale.mjs [--dry]
 *
 * A spawned page bakes FOUNDRY_PUBLIC_URL into its checkout and beacon calls at
 * generation time. If the app moves to a new origin, pages spawned before the
 * move keep posting to the old one and their Buy button silently fails. That is
 * a broken storefront, not a business judgement, so it is retired with a reason
 * that says so — and the retirement is written to the append-only decision log
 * like every other state change.
 */
import pg from 'pg';
import { bad, dim, loadEnv, ok, warn } from './_env.mjs';

loadEnv();

const DRY = process.argv.includes('--dry');
const BASE = (process.env.FOUNDRY_PUBLIC_URL ?? '').replace(/\/$/, '');
if (!BASE) {
  console.error(bad('FAIL') + '  FOUNDRY_PUBLIC_URL is not set');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const id = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

try {
  const { rows } = await client.query(
    `SELECT id, name, url FROM businesses
      WHERE status <> 'KILLED' AND NOT is_fixture AND url <> ''
      ORDER BY created_at`,
  );
  console.log(dim(`checking ${rows.length} live business page(s) against ${BASE}\n`));

  let retired = 0;
  for (const b of rows) {
    let html = '';
    let reachable = true;
    try {
      const res = await fetch(b.url, { headers: { 'user-agent': 'foundry-retire/1.0' } });
      html = await res.text();
      reachable = res.ok;
    } catch {
      reachable = false;
    }

    const pointsAtLiveOrigin = html.includes(`${BASE}/api/checkout`);

    if (reachable && pointsAtLiveOrigin) {
      console.log(ok('KEEP') + `  ${b.name} — checkout targets the live origin`);
      continue;
    }

    const reason = !reachable
      ? `Retired: ${b.url} no longer serves.`
      : `Retired: this page was generated before Foundry moved origins, so its checkout still ` +
        `posts to a dead host instead of ${BASE}. The storefront cannot take money, which makes ` +
        `its traffic and conversion numbers meaningless. Retiring it rather than leaving a broken ` +
        `Buy button in the portfolio; a replacement can be spawned against the current origin.`;

    console.log(warn('RETIRE') + `  ${b.name} (${b.id})`);
    console.log(dim(`        ${b.url}`));

    if (DRY) continue;

    await client.query(
      `UPDATE businesses SET status = 'KILLED', kill_reason = $2, killed_at = now(),
              updated_at = now() WHERE id = $1`,
      [b.id, reason],
    );
    await client.query(
      `INSERT INTO decisions (id, cycle_id, business_id, action, reasoning, confidence, model, inputs, outputs)
       VALUES ($1,$2,$3,'KILL',$4,1,'operator',$5,$6)`,
      [
        id('dec'),
        `retarget_${Date.now().toString(36)}`,
        b.id,
        reason,
        JSON.stringify({ url: b.url, reachable, expectedOrigin: BASE }),
        JSON.stringify({ status: 'KILLED', cause: 'origin-migration' }),
      ],
    );
    retired++;
  }

  console.log('');
  console.log(
    DRY
      ? warn('dry run — nothing changed')
      : ok(`retire-stale: ${retired} retired, ${rows.length - retired} kept`),
  );
} finally {
  await client.end();
}
