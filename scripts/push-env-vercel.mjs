#!/usr/bin/env node
/**
 * Pushes every runtime secret from .env.local into the existing Vercel project
 * so production actually runs. Idempotent (upsert), and it never prints a value.
 *
 *   node scripts/push-env-vercel.mjs
 *
 * Vercel reserves the VERCEL_ prefix for variables it injects itself, so those
 * four are additionally written under a FOUNDRY_ alias that lib/env.ts reads.
 */
import { bad, dim, loadEnv, ok, warn } from './_env.mjs';
import { resolveTarget } from './_vercel.mjs';

loadEnv();

const TOKEN = process.env.VERCEL_TOKEN;

if (!TOKEN) {
  console.error(bad('FAIL') + '  VERCEL_TOKEN is required');
  process.exit(1);
}

// Same resolution the deploy uses, so both agree on where they are writing.
const { teamId: TEAM, projectId: PROJECT } = await resolveTarget();

/** Everything production needs. Anything not listed here stays local. */
const KEYS = [
  'ANTHROPIC_API_KEY',
  'FOUNDRY_MODEL',
  // Brain is swappable; either vendor can be the one that thinks.
  'OPENAI_API_KEY',
  'FOUNDRY_OPENAI_MODEL',
  'FOUNDRY_BRAIN_PROVIDER',
  'STRIPE_SECRET_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ACCOUNT_COUNTRY',
  'STRIPE_ACCOUNT_ID',
  'STRIPE_PAYMENT_METHOD_TYPES',
  'FOUNDRY_PUBLIC_URL',
  'GITHUB_REPO',
  'TERAC_API_KEY',
  'TERAC_API_BASE',
  'TERAC_ESCALATION_THRESHOLD',
  'TERAC_MAX_SPEND_USD',
  'LABOR_PROVIDER',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'FOUNDRY_TOTAL_BUDGET_USD',
  'FOUNDRY_PER_BUSINESS_BUDGET_USD',
  'FOUNDRY_KILL_THRESHOLD_VISITORS',
  'FOUNDRY_KILL_THRESHOLD_CONVERSIONS',
  'FOUNDRY_MAX_BUSINESSES',
  'FOUNDRY_CIRCUIT_BREAKER',
  'FOUNDRY_COLD_START_AT',
  'FOUNDRY_PAGEGEN_PROVIDER',
  'FOUNDRY_CHECKOUT_PROVIDER',
  'FOUNDRY_SANDBOX_PROVIDER',
  'FOUNDRY_BUS_PROVIDER',
  'FOUNDRY_SUPPORT_PROVIDER',
  'FOUNDRY_QA_PROVIDER',
  'FOUNDRY_HOST_PROVIDER',
  'LOVABLE_API_KEY',
  'RENDER_API_KEY',
  'WHOP_API_KEY',
  'WHOP_COMPANY_ID',
  'DODO_PAYMENTS_API_KEY',
  'SANDBOX0_API_KEY',
  'SUPERSERVE_API_KEY',
  'BAND_API_KEY',
  'LINQ_API_KEY',
  'LINQ_PHONE_NUMBER',
  'REPLAY_API_KEY',
  'RESEND_API_KEY',
  'FOUNDRY_DISCLOSURE_LINE',
  // Band authenticates as a registered agent; the human key only mints it.
  'BAND_AGENT_API_KEY',
  'BAND_AGENT_ID',
  'BAND_CHAT_ID',
  // Per-business machines.
  'FOUNDRY_MACHINE_USD_PER_HOUR',
  'FOUNDRY_MACHINE_IDLE_MINUTES',
];

/** Reserved prefix — pushed under an alias lib/env.ts also reads. */
const ALIASED = {
  FOUNDRY_VERCEL_TOKEN: 'VERCEL_TOKEN',
  FOUNDRY_VERCEL_TEAM_ID: 'VERCEL_TEAM_ID',
  FOUNDRY_VERCEL_PROJECT_ID: 'VERCEL_PROJECT_ID',
  FOUNDRY_VERCEL_PROJECT_PREFIX: 'VERCEL_PROJECT_PREFIX',
};

const url = (path) =>
  `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${TEAM}`;

async function upsert(key, value) {
  const res = await fetch(url(`/v10/projects/${PROJECT}/env?upsert=true`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      key,
      value,
      type: key.startsWith('NEXT_PUBLIC_') ? 'plain' : 'encrypted',
      target: ['production', 'preview', 'development'],
    }),
  });
  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => ({}));
  return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}` };
}

let pushed = 0;
let skipped = 0;
let failed = 0;

const entries = [
  ...KEYS.map((k) => [k, process.env[k]]),
  ...Object.entries(ALIASED).map(([alias, source]) => [alias, process.env[source]]),
];

for (const [key, value] of entries) {
  if (value === undefined || value === '') {
    skipped++;
    console.log(dim(`SKIP  ${key} (empty)`));
    continue;
  }
  const res = await upsert(key, value);
  if (res.ok) {
    pushed++;
    console.log(ok('PUSH') + `  ${key}` + dim(` (${value.length} chars)`));
  } else {
    failed++;
    console.log(bad('FAIL') + `  ${key}: ${res.error}`);
  }
}

// A cron secret the project generates for itself, so /api/cron/ceo cannot be
// poked anonymously from outside Vercel's scheduler.
if (!process.env.CRON_SECRET) {
  const generated = [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const res = await upsert('CRON_SECRET', generated);
  if (res.ok) {
    pushed++;
    console.log(ok('PUSH') + '  CRON_SECRET (generated)');
    console.log(warn('NOTE') + '  add this to .env.local to poke the cron by hand:');
    console.log(dim(`       CRON_SECRET=${generated}`));
  }
}

console.log('');
console.log(
  failed
    ? bad(`env push: ${pushed} pushed, ${skipped} empty, ${failed} FAILED`)
    : ok(`env push: ${pushed} pushed, ${skipped} empty (unset sponsor keys)`),
);
process.exit(failed ? 1 : 0);
