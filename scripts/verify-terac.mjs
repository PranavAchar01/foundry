#!/usr/bin/env node
/**
 * Verifies TERAC_API_KEY end-to-end. Read-only + pricing:
 * it calls createQuote (which prices labor) but NEVER launchFromQuote (which buys it).
 * Running this costs nothing.
 *
 *   node scripts/verify-terac.mjs
 */
import { readFileSync } from 'node:fs';

// minimal .env.local loader — no dependency on dotenv before the app exists
try {
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* fall back to real env */ }

const BASE = process.env.TERAC_API_BASE ?? 'https://terac.com/api/external/v2';
const KEY = process.env.TERAC_API_KEY;

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

if (!KEY) {
  console.error(bad('FAIL') + '  TERAC_API_KEY is empty in .env.local');
  console.error(dim('       Get a key from the Terac dashboard -> organization settings -> API keys.'));
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

let failed = false;

// 1. auth + live balance
const org = await call('GET', '/organizations/current/context');
if (org.status === 200) {
  console.log(ok('PASS') + `  auth ok — org "${org.json.organizationName}"`);
  console.log(dim(`       balance: $${org.json.balanceDollars}`));
  if (org.json.balanceDollars <= 0) {
    console.log(bad('WARN') + '  balance is $0 — escalations will be declined by the budget check.');
  }
} else {
  failed = true;
  console.log(bad('FAIL') + `  GET /organizations/current/context -> ${org.status}`);
  console.log(dim('       ' + JSON.stringify(org.json).slice(0, 240)));
}

// 2. pricing path — the escalation primitive's first call
if (!failed) {
  const q = await call('POST', '/quotes', {
    taskDescription:
      'Review one line of marketing copy for a dental-practice landing page and state whether the compliance claim is defensible.',
    panelDescription: 'Healthcare marketing compliance professional, US, 3+ years experience',
    timelineHours: 2,
    submissionCount: 1,
  });
  if (q.status === 200 || q.status === 201) {
    console.log(ok('PASS') + `  quote priced — $${q.json.totalCost} total, $${q.json.costPerParticipant}/participant`);
    console.log(dim(`       quoteId ${q.json.quoteId}  expires ${q.json.expiresAt}`));
    const cap = Number(process.env.TERAC_MAX_SPEND_USD ?? 40);
    console.log(
      q.json.totalCost <= cap
        ? ok('PASS') + `  within TERAC_MAX_SPEND_USD ($${cap}) — escalation would proceed`
        : bad('WARN') + `  exceeds TERAC_MAX_SPEND_USD ($${cap}) — escalation would be declined`,
    );
  } else {
    failed = true;
    console.log(bad('FAIL') + `  POST /quotes -> ${q.status}`);
    console.log(dim('       ' + JSON.stringify(q.json).slice(0, 240)));
  }
}

// 3. webhook event types — confirms the COGS callback path exists
if (!failed) {
  const h = await call('GET', '/hooks/event-types');
  if (h.status === 200) {
    console.log(ok('PASS') + `  webhook events: ${h.json.data.map((e) => e.event_type).join(', ')}`);
  } else {
    console.log(bad('WARN') + `  GET /hooks/event-types -> ${h.status} (webhook COGS path unverified)`);
  }
}

console.log('');
console.log(failed ? bad('terac: NOT READY') : ok('terac: READY — escalation path verified, nothing purchased'));
process.exit(failed ? 1 : 0);
