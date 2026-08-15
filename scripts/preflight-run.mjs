#!/usr/bin/env node
/**
 * The check you run in the sixty seconds before hitting record.
 *
 *   node scripts/preflight-run.mjs [--targets=8] [https://foundry-biz-eight.vercel.app]
 *
 * A live run builds one business per allowlisted person and DMs each of them.
 * Every way that run can die before it renders a single tile is checked here,
 * and each answer is one PASS/FAIL line so a failure is readable at a glance in
 * a terminal you are about to screen-record.
 *
 * Read-only throughout. It never follows, never DMs, never spawns, never
 * deploys, and never rotates a credential — a preflight that mutates the thing
 * it is checking can break the run it was meant to protect. The one X call is
 * GET /2/users/me.
 *
 * `verify-all.mjs` is the other half of this: it proves the third-party APIs
 * answer at all. This one proves *this particular run* will fit through the
 * ceilings, the allowlist and the schema as they stand right now.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ROOT, bad, dim, loadEnv, ok, warn } from './_env.mjs';

loadEnv();

const BASE = (
  process.argv.find((a) => a.startsWith('http')) ??
  process.env.FOUNDRY_PUBLIC_URL ??
  'http://localhost:3000'
).replace(/\/$/, '');

let failed = false;
const fail = (msg, detail) => {
  failed = true;
  console.log(bad('FAIL') + '  ' + msg);
  if (detail) console.log(dim('       ' + String(detail).slice(0, 300)));
};
const pass = (msg, detail) => {
  console.log(ok('PASS') + '  ' + msg);
  if (detail) console.log(dim('       ' + String(detail).slice(0, 300)));
};
const note = (msg, detail) => {
  console.log(warn('NOTE') + '  ' + msg);
  if (detail) console.log(dim('       ' + String(detail).slice(0, 300)));
};

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined
    ? v
    : fallback;
};
const present = (name) => (process.env[name] ?? '') !== '';

/**
 * What one spawn charges the portfolio, read out of the source rather than
 * copied. A preflight that quotes a stale price would clear a run the budget
 * then refuses halfway through the grid.
 */
const spawnCostUsd = (() => {
  const src = readFileSync(path.join(ROOT, 'lib/spawn.ts'), 'utf8');
  const m = src.match(/SPAWN_INFRA_COST_USD\s*=\s*([\d.]+)/);
  if (!m) throw new Error('SPAWN_INFRA_COST_USD is no longer declared in lib/spawn.ts');
  return Number(m[1]) + num('FOUNDRY_MACHINE_USD_PER_HOUR', 0.05);
})();

const client = new pg.Client({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------------------------------------------------------------- database --
let dbUp = false;
try {
  await client.connect();
  await client.query('SELECT 1');
  dbUp = true;
  pass('postgres reachable');
} catch (err) {
  fail('postgres unreachable — nothing else can run', err.message);
}

// Whether `node scripts/migrate.mjs` has been applied against THIS database.
// The expectation is read out of lib/schema.sql rather than listed here: the
// per-person run needed two new columns on `businesses`, and a preflight
// carrying its own copy of the schema would have passed while the run failed on
// an unknown column. The forward-migration ALTERs are exactly the set that
// tells you whether a database is current.
if (dbUp) {
  const schema = readFileSync(path.join(ROOT, 'lib/schema.sql'), 'utf8');
  const matches = (re) => [...schema.matchAll(re)];
  const EXPECTED_TABLES = matches(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g).map((m) => m[1]);
  const EXPECTED_COLUMNS = matches(
    /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/g,
  ).map((m) => [m[1], m[2]]);
  const APPEND_ONLY = matches(/CREATE TRIGGER\s+(\w+)_append_only/g).map((m) => m[1]);

  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const have = new Set(tables.map((r) => r.table_name));
  const missingTables = EXPECTED_TABLES.filter((t) => !have.has(t));

  const { rows: cols } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const haveCols = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
  const missingCols = EXPECTED_COLUMNS.filter(([t, c]) => !haveCols.has(`${t}.${c}`));

  const { rows: trig } = await client.query(
    `SELECT DISTINCT event_object_table AS tbl FROM information_schema.triggers
      WHERE trigger_name LIKE '%append%'`,
  );
  const guarded = new Set(trig.map((r) => r.tbl));
  const unguarded = APPEND_ONLY.filter((t) => !guarded.has(t));

  if (missingTables.length || missingCols.length) {
    fail(
      'schema is behind — run `node scripts/migrate.mjs`',
      `missing tables: ${missingTables.join(', ') || 'none'} · ` +
        `missing columns: ${missingCols.map(([t, c]) => `${t}.${c}`).join(', ') || 'none'}`,
    );
  } else {
    pass(
      'schema migrated',
      `${EXPECTED_TABLES.length} tables and ${EXPECTED_COLUMNS.length} forward-migrated columns present`,
    );
  }

  if (unguarded.length) {
    fail(
      `append-only enforcement missing on ${unguarded.join(', ')}`,
      'a reset or a bug could rewrite spend or decision history',
    );
  } else {
    pass('append-only triggers live', APPEND_ONLY.join(', '));
  }
}

// ------------------------------------------------------------- the targets --
// How many businesses this run will try to spawn. The allowlist is the real
// answer — it is the only set of people who can be contacted.
let allowlist = [];
if (dbUp) {
  const { rows } = await client.query(
    `SELECT c.username,
            c.x_user_id <> '' AS has_id,
            c.bio       <> '' AS has_bio,
            c.dm_sent_at IS NOT NULL AS dmed,
            EXISTS (SELECT 1 FROM prospect_drafts d WHERE d.username = c.username) AS drafted,
            EXISTS (SELECT 1 FROM conversations v WHERE v.username = c.username)   AS in_conversation
       FROM consent_cohort c ORDER BY c.created_at`,
  );
  allowlist = rows;
}

const flag = process.argv.find((a) => a.startsWith('--targets='));
const targets = flag ? Number(flag.slice('--targets='.length)) : allowlist.length;

if (dbUp && !allowlist.length) {
  fail('the contact allowlist is empty — the run has nobody to build for');
} else if (dbUp) {
  const incomplete = allowlist.filter((m) => !m.has_id || !m.has_bio);
  if (incomplete.length) {
    fail(
      `${incomplete.length}/${allowlist.length} allowlist member(s) are missing evidence`,
      incomplete
        .map((m) => `@${m.username}: ${[!m.has_id && 'no x_user_id', !m.has_bio && 'no bio'].filter(Boolean).join(', ')}`)
        .join(' · ') + ' — POST /api/cohort/hydrate, or re-add them',
    );
  } else {
    pass(
      `allowlist has ${allowlist.length} member(s), every one resolved`,
      allowlist.map((m) => `@${m.username}`).join(' '),
    );
  }

  // Second-take hazards. None of these block a first run; all of them make a
  // second take behave differently from the one you just recorded.
  const stale = allowlist.filter((m) => m.dmed || m.drafted || m.in_conversation);
  if (stale.length) {
    note(
      `${stale.length} allowlist member(s) already carry outreach state from an earlier run`,
      stale
        .map((m) => `@${m.username}(${[m.dmed && 'dm', m.drafted && 'draft', m.in_conversation && 'convo'].filter(Boolean).join('+')})`)
        .join(' ') + ' — conversation_messages is append-only, so this cannot be cleared',
    );
  }
}

// ------------------------------------------------------------ spawn ceiling --
if (dbUp) {
  const maxBusinesses = num('FOUNDRY_MAX_BUSINESSES', 8);
  const { rows } = await client.query(
    `SELECT COUNT(*) AS n FROM businesses
      WHERE status <> 'KILLED' AND NOT is_fixture AND NOT archived`,
  );
  const active = Number(rows[0].n);
  const detail = `${active} active + ${targets} new vs FOUNDRY_MAX_BUSINESSES=${maxBusinesses}`;
  if (active + targets > maxBusinesses) {
    fail(
      `the spawn ceiling blocks this run after ${Math.max(0, maxBusinesses - active)} tile(s)`,
      `${detail} — run \`node scripts/reset-portfolio.mjs --yes\` or raise the ceiling`,
    );
  } else {
    pass(`spawn ceiling has room for all ${targets} tile(s)`, detail);
  }
}

// ----------------------------------------------------------------- spending --
if (dbUp) {
  const { rows } = await client.query(
    `SELECT tripped, reason, tripped_at FROM circuit_breaker WHERE id = 1`,
  );
  const breaker = rows[0] ?? { tripped: false, reason: '' };
  const armed = (process.env.FOUNDRY_CIRCUIT_BREAKER ?? 'on').toLowerCase();
  const enforced = armed === 'on' || armed === 'true' || armed === '1' || armed === 'yes';

  if (breaker.tripped && enforced) {
    fail(
      `circuit breaker is LATCHED — every spend path refuses: ${breaker.reason || 'no reason recorded'}`,
      `tripped at ${breaker.tripped_at} — POST /api/breaker to reset it`,
    );
  } else if (breaker.tripped) {
    note('circuit breaker is latched but FOUNDRY_CIRCUIT_BREAKER is off — spending is unguarded');
  } else {
    pass('circuit breaker armed and not latched');
  }

  const { rows: spendRows } = await client.query(
    `SELECT COALESCE(SUM(-amount_cents), 0) AS spend_cents
       FROM ledger_entries l
      WHERE l.kind IN ('COGS','OPEX')
        AND (l.business_id IS NULL
             OR l.business_id NOT IN (SELECT id FROM businesses WHERE is_fixture))`,
  );
  const spentUsd = Number(spendRows[0].spend_cents) / 100;
  const budget = num('FOUNDRY_TOTAL_BUDGET_USD', 150);
  const remaining = budget - spentUsd;
  const cost = targets * spawnCostUsd;
  const detail =
    `$${remaining.toFixed(2)} left of $${budget.toFixed(2)} · ` +
    `${targets} spawn(s) cost $${cost.toFixed(2)} at $${spawnCostUsd.toFixed(2)} each`;

  if (remaining < cost) {
    fail('the portfolio budget cannot fund this run', detail);
  } else if (remaining < cost * 2) {
    note('budget clears this run but leaves little for hiring or machine time', detail);
  } else {
    pass('budget covers the run', detail);
  }
}

// ------------------------------------------------------------------------ X --
// One read. The run's follow and DM stages are never exercised here.
if (dbUp) {
  const { rows } = await client.query(
    `SELECT username, access_token, refresh_token, scope, expires_at FROM x_accounts WHERE id = 'x_primary'`,
  );
  const acct = rows[0];
  if (!acct) {
    fail('no X account connected', `authorize at ${BASE}/api/x/login`);
  } else {
    const need = ['users.read', 'follows.write', 'dm.write'];
    const scopes = new Set(acct.scope.split(/\s+/).filter(Boolean));
    const missing = need.filter((s) => !scopes.has(s));

    const res = await fetch('https://api.x.com/2/users/me', {
      headers: { Authorization: `Bearer ${acct.access_token}` },
    });
    const body = await res.json().catch(() => ({}));
    const ttlMin = acct.expires_at
      ? Math.round((new Date(acct.expires_at).getTime() - Date.now()) / 60000)
      : null;

    if (res.ok) {
      pass(`x credentials live as @${body.data?.username ?? acct.username}`, `token valid for ${ttlMin}m`);
      if (ttlMin !== null && ttlMin < 10) {
        note(`the stored X token expires in ${ttlMin}m`, 'the app refreshes it on first use, but do not stall the take');
      }
    } else {
      fail(
        `x /2/users/me -> ${res.status}`,
        `${body.detail ?? body.title ?? ''} · token expired ${ttlMin}m ago · re-authorize at ${BASE}/api/x/login`,
      );
    }

    if (missing.length) {
      fail(`the X token is missing ${missing.join(', ')}`, `the reach stage cannot follow or DM — re-authorize at ${BASE}/api/x/login`);
    } else {
      pass('x token carries follows.write and dm.write');
    }
  }
}

// ---------------------------------------------------------------- the keys --
{
  const brain = (process.env.FOUNDRY_BRAIN_PROVIDER ?? '').toLowerCase() ||
    (present('ANTHROPIC_API_KEY') ? 'anthropic' : 'openai');
  const brainKey = brain === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const model = brain === 'openai'
    ? process.env.FOUNDRY_OPENAI_MODEL || 'gpt-5.5'
    : process.env.FOUNDRY_MODEL || 'claude-opus-5';

  if (present(brainKey)) pass(`brain key present`, `provider=${brain} model=${model}`);
  else fail(`${brainKey} is empty but FOUNDRY_BRAIN_PROVIDER=${brain}`, 'the plan stage has nothing to think with');

  if (present('STRIPE_SECRET_KEY') && present('STRIPE_WEBHOOK_SECRET')) {
    pass('stripe key and webhook secret present');
  } else {
    fail('stripe credentials incomplete', `STRIPE_SECRET_KEY ${present('STRIPE_SECRET_KEY') ? 'present' : 'EMPTY'}, STRIPE_WEBHOOK_SECRET ${present('STRIPE_WEBHOOK_SECRET') ? 'present' : 'EMPTY'}`);
  }

  // The silent one. `spawn` catches a pagegen failure and falls back to the
  // internal template, so an empty key does not error — it just quietly ships
  // eight identical dark monospace pages instead of eight designed ones.
  const pagegen = (process.env.FOUNDRY_PAGEGEN_PROVIDER ?? 'internal').toLowerCase();
  if (pagegen === 'lovable' && !present('LOVABLE_API_KEY')) {
    fail(
      'FOUNDRY_PAGEGEN_PROVIDER=lovable but LOVABLE_API_KEY is empty',
      'every storefront will silently fall back to the internal template',
    );
  } else if (pagegen === 'lovable') {
    pass('lovable key present and selected', `storefronts build on ${process.env.LOVABLE_MCP_URL || 'https://mcp.lovable.dev/mcp'}`);
  } else {
    note(
      `FOUNDRY_PAGEGEN_PROVIDER=${pagegen} — storefronts use the internal template`,
      present('LOVABLE_API_KEY')
        ? 'set FOUNDRY_PAGEGEN_PROVIDER=lovable for the designed pages'
        : 'LOVABLE_API_KEY is also empty, so lovable cannot be selected',
    );
  }

  if (present('SUPERSERVE_API_KEY')) pass('superserve key present', 'each business gets its own machine');
  else note('SUPERSERVE_API_KEY is empty — businesses spawn without a machine', 'storefronts and DMs are unaffected');
}

// ------------------------------------------------------- the deployed app --
// The recording drives the deployed dashboard, not this shell. A green local
// preflight against a production that never got the same env is the exact
// failure this check exists to catch.
{
  try {
    const res = await fetch(`${BASE}/api/health`, { headers: { 'user-agent': 'foundry-preflight/1.0' } });
    const health = await res.json().catch(() => ({}));
    if (!health.ok) {
      fail(`${BASE}/api/health is not ok`, JSON.stringify(health.checks ?? health).slice(0, 280));
    } else {
      const active = Object.fromEntries((health.providers ?? []).map((p) => [p.capability, p.active]));
      pass(`${BASE} healthy`, `pagegen=${active.pagegen} host=${active.host} brain=${active.brain} sandbox=${active.sandbox}`);

      const localPagegen = (process.env.FOUNDRY_PAGEGEN_PROVIDER ?? 'internal').toLowerCase();
      if (active.pagegen !== localPagegen) {
        note(
          `deployed pagegen is ${active.pagegen}, .env.local says ${localPagegen}`,
          'the run uses the deployed value — `pnpm env:push` then redeploy to change it',
        );
      }
    }
  } catch (err) {
    fail(`${BASE} unreachable`, err.message);
  }
}

console.log('');
console.log(
  failed
    ? bad('preflight: DO NOT START THE RUN')
    : ok(`preflight: READY — ${targets} tile(s), ${targets} DM(s)`),
);
await client.end().catch(() => {});
process.exit(failed ? 1 : 0);
