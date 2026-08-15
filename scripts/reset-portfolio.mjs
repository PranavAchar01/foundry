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
 * Not every storefront can be reached from here. A page built through Lovable
 * is hosted by Lovable, and the MCP surface the pagegen provider speaks —
 * create_project, get_project, deploy_project — has no delete and no unpublish.
 * Those sites stay live after a reset. The plan names them and prints their
 * URLs rather than quietly leaving them behind, because an operator who thinks
 * the portfolio is empty and finds seven live storefronts later has been lied
 * to by this script.
 *
 * What does NOT go: `ledger_entries`, `decisions`, `machine_runs` and
 * `conversation_messages` are append-only at the database level. A reset must
 * not be able to rewrite what was actually spent, decided, run or said, so
 * those survive and the P&L keeps showing real historical spend. The corollary
 * is worth saying out loud: a reset frees the business-count ceiling but not
 * the budget ceiling, so the plan prints what is already committed.
 * Archived businesses are hidden from the portfolio instead of deleted.
 *
 * Never touches the Foundry project itself, or `landing`.
 */
import pg from 'pg';
import { bad, dim, loadEnv, ok, warn } from './_env.mjs';

loadEnv();

const DRY = !process.argv.includes('--yes');
const PREFIX = process.env.VERCEL_PROJECT_PREFIX || 'foundry-biz';
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

/**
 * Every project on the team, following the cursor. A single page would silently
 * miss storefronts once the account holds more projects than the page size, and
 * a teardown that misses things is the failure this whole script is about.
 */
async function allVercelProjects() {
  const projects = [];
  let until = '';
  for (let page = 0; page < 20; page++) {
    const res = await vercel('GET', `/v9/projects?limit=100${until ? `&until=${until}` : ''}`);
    if (res.status >= 300) return { projects, error: `vercel /v9/projects -> ${res.status}` };
    projects.push(...(res.json.projects ?? []));
    until = res.json.pagination?.next ?? '';
    if (!until) break;
  }
  return { projects, error: null };
}

/** The name lib/providers/host.ts deploys a storefront under. */
const projectNameFor = (slug) =>
  `${PREFIX}-${slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')}`
    .slice(0, 90)
    .replace(/-$/, '');

try {
  const { rows: businesses } = await client.query(
    `SELECT id, name, slug, url, status,
            COALESCE(meta->>'host', '') AS host,
            COALESCE(meta->>'deploymentId', '') AS deployment_id
       FROM businesses
      WHERE NOT archived AND NOT is_fixture
      ORDER BY created_at`,
  );
  const { rows: machines } = await client.query(
    `SELECT id, business_id, external_id FROM machines WHERE status <> 'killed'`,
  );
  const { rows: counts } = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM visits
         WHERE business_id IN (SELECT id FROM businesses WHERE NOT archived AND NOT is_fixture)) AS visits,
       (SELECT COUNT(*) FROM prospect_drafts)                     AS drafts,
       (SELECT COUNT(*) FROM conversations)                       AS conversations,
       (SELECT COUNT(*) FROM audience_members)                    AS audience,
       (SELECT COUNT(*) FROM consent_cohort WHERE dm_sent_at IS NOT NULL) AS dmed,
       (SELECT COALESCE(SUM(-amount_cents), 0) FROM ledger_entries l
         WHERE l.kind IN ('COGS','OPEX')
           AND (l.business_id IS NULL
                OR l.business_id NOT IN (SELECT id FROM businesses WHERE is_fixture))) AS spend_cents`,
  );
  const stats = counts[0];

  const { projects, error: projectsError } = await allVercelProjects();
  const doomed = projects.filter(
    (p) => p.name.startsWith(`${PREFIX}-`) && !PROTECTED.has(p.name),
  );
  const doomedNames = new Set(doomed.map((p) => p.name));

  // Storefronts this script cannot delete, for two different reasons.
  const lovable = businesses.filter((b) => b.host === 'lovable');
  const strandedVercel = businesses.filter(
    (b) => b.host === 'vercel' && !doomedNames.has(projectNameFor(b.slug)),
  );

  const machinesKillable = Boolean(process.env.SUPERSERVE_API_KEY) && machines.length > 0;

  console.log(dim('reset plan\n'));
  console.log(`  businesses to archive : ${businesses.length}`);
  console.log(`  pageviews to delete   : ${stats.visits}`);
  console.log(
    `  machines to destroy   : ${machinesKillable ? machines.length : 0}` +
      (machines.length && !process.env.SUPERSERVE_API_KEY
        ? `   ${warn(`(${machines.length} left running — SUPERSERVE_API_KEY is not set)`)}`
        : ''),
  );
  console.log(`  vercel projects to del: ${doomed.length}${projectsError ? warn('  (project list incomplete)') : ''}`);
  for (const p of doomed) console.log(dim(`      ${p.name}`));
  console.log(dim(`  protected             : ${[...PROTECTED].join(', ')}`));

  if (lovable.length || strandedVercel.length || projectsError) {
    console.log('');
    console.log(warn('  cannot be torn down from here:'));
    if (lovable.length) {
      console.log(
        dim(`      ${lovable.length} Lovable storefront(s) stay live — Lovable's MCP has no delete tool.`),
      );
      for (const b of lovable) console.log(dim(`      ${b.url}  (project ${b.deployment_id || 'unknown'})`));
      console.log(dim('      Delete these in the Lovable dashboard if they must actually go.'));
    }
    for (const b of strandedVercel) {
      console.log(
        dim(`      ${b.url} — no project named ${projectNameFor(b.slug)} on the team; the page may stay up`),
      );
    }
    if (projectsError) console.log(dim(`      ${projectsError} — some projects were never listed`));
  }

  console.log('');
  console.log(dim('  untouched by design:'));
  console.log(
    dim('      ledger_entries, decisions, machine_runs, conversation_messages — append-only'),
  );
  console.log(
    dim(
      `      $${(Number(stats.spend_cents) / 100).toFixed(2)} of committed spend stays on the P&L — ` +
        'a reset frees the business-count ceiling, never the budget',
    ),
  );
  console.log(
    dim(
      `      audience_members (${stats.audience}) — the scan reel reads this, clearing it would empty the demo`,
    ),
  );
  console.log(
    dim(
      `      prospect_drafts (${stats.drafts}), conversations (${stats.conversations}), ` +
        `allowlist members already DM'd (${stats.dmed}) — outreach history, not portfolio state`,
    ),
  );
  console.log('');

  if (DRY) {
    console.log(warn('dry run — nothing changed. Re-run with --yes to execute.'));
    process.exit(0);
  }

  let failed = false;

  // 1. machines ------------------------------------------------------------
  let killed = 0;
  let stillRunning = 0;
  if (machines.length && !process.env.SUPERSERVE_API_KEY) {
    failed = true;
    console.log(
      bad('FAIL') +
        `  ${machines.length} machine(s) left running — SUPERSERVE_API_KEY is not set, so nothing could be killed`,
    );
  } else if (machines.length) {
    const { Sandbox } = await import('@superserve/sdk');
    for (const m of machines) {
      let gone = false;
      try {
        const box = await Sandbox.connect(m.external_id, { apiKey: process.env.SUPERSERVE_API_KEY });
        await box.kill();
        gone = true;
        killed++;
      } catch (err) {
        // A sandbox the provider no longer knows about is genuinely dead and the
        // row should say so. Any other failure means the VM is probably still
        // burning, and marking it killed would stop the meter on a live machine.
        gone = /not found|no such|does not exist|404|already/i.test(String(err.message));
        if (gone) killed++;
        else stillRunning++;
        console.log(
          (gone ? warn('NOTE') : bad('FAIL')) +
            `  ${m.external_id} ${gone ? 'already gone' : 'still running'}: ${String(err.message).slice(0, 80)}`,
        );
      }
      if (gone) {
        await client.query(
          `UPDATE machines SET status = 'killed', killed_at = now(),
                  meta = meta || '{"killReason":"operator reset"}'::jsonb
            WHERE id = $1`,
          [m.id],
        );
      }
    }
    if (stillRunning) failed = true;
    console.log(
      (stillRunning ? bad('FAIL') : ok('DONE')) +
        `  ${killed}/${machines.length} machines destroyed` +
        (stillRunning ? `, ${stillRunning} still billable` : ''),
    );
  } else {
    console.log(ok('DONE') + '  no live machines');
  }

  // 2. storefronts ---------------------------------------------------------
  let deleted = 0;
  for (const p of doomed) {
    const res = await vercel('DELETE', `/v9/projects/${p.id}`);
    if (res.status < 300) deleted++;
    else {
      failed = true;
      console.log(bad('FAIL') + `  ${p.name} -> ${res.status}`);
    }
  }
  console.log(ok('DONE') + `  ${deleted}/${doomed.length} vercel projects deleted`);
  if (lovable.length) {
    console.log(
      warn('NOTE') +
        `  ${lovable.length} Lovable storefront(s) are STILL LIVE — this script cannot delete them`,
    );
  }

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
    (failed ? warn('reset finished with gaps') : ok('reset complete')) +
      dim(
        `  live businesses=${after[0].live} machines=${after[0].machines} · ` +
          `preserved ledger=${after[0].ledger} decisions=${after[0].decisions}`,
      ),
  );
  process.exit(failed ? 1 : 0);
} finally {
  await client.end();
}
