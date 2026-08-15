#!/usr/bin/env node
/**
 * Live preflight against every external dependency. Read-only or free:
 * it creates a Stripe checkout session (costs nothing, completes nothing) and
 * sends one 16-token Anthropic message. It never buys labor.
 *
 *   node scripts/verify-all.mjs
 */
import pg from 'pg';
import { bad, dim, loadEnv, ok, warn } from './_env.mjs';

loadEnv();

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

// ---------------------------------------------------------------- database --
{
  const client = new pg.Client({
    connectionString: process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM businesses)     AS businesses,
         (SELECT COUNT(*) FROM ledger_entries) AS ledger,
         (SELECT COUNT(*) FROM decisions)      AS decisions`,
    );
    pass(
      'postgres reachable',
      `businesses=${rows[0].businesses} ledger=${rows[0].ledger} decisions=${rows[0].decisions}`,
    );
  } catch (err) {
    fail('postgres unreachable', err.message);
  } finally {
    await client.end().catch(() => {});
  }
}

// --------------------------------------------------------------- anthropic --
{
  const model = process.env.FOUNDRY_MODEL;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      }),
    });
    const json = await res.json();
    if (res.ok) pass(`anthropic model ${model} live`, `resolved to ${json.model}`);
    else fail(`anthropic model ${model} -> ${res.status}`, JSON.stringify(json.error ?? json));
  } catch (err) {
    fail('anthropic unreachable', err.message);
  }
}

// ------------------------------------------------------------------ stripe --
{
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  const base = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': '2900',
    'line_items[0][price_data][product_data][name]': 'Foundry preflight probe',
    success_url: 'https://foundry-biz-eight.vercel.app/thanks',
    cancel_url: 'https://foundry-biz-eight.vercel.app/',
    'metadata[business_id]': 'preflight',
  });

  const create = async (form) => {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    return { status: res.status, json: await res.json() };
  };

  // 1. Explicit payment_method_types — the path the app actually uses.
  const explicit = new URLSearchParams(base);
  for (const [i, t] of (process.env.STRIPE_PAYMENT_METHOD_TYPES ?? 'card').split(',').entries()) {
    explicit.set(`payment_method_types[${i}]`, t.trim());
  }
  const a = await create(explicit);
  if (a.status === 200) {
    pass('stripe session with explicit payment_method_types', `${a.json.id} url=${Boolean(a.json.url)}`);
  } else {
    fail(`stripe explicit -> ${a.status}`, JSON.stringify(a.json.error ?? a.json));
  }

  // 2. Automatic payment methods — documented to 400 on this account. Proving
  //    it here is why the explicit list is not cargo cult.
  const auto = new URLSearchParams(base);
  auto.set('automatic_payment_methods[enabled]', 'true');
  const b = await create(auto);
  if (b.status === 200) {
    console.log(
      warn('NOTE') + '  automatic payment methods now succeed too — activation may be complete',
    );
    console.log(dim(`       ${b.json.id}`));
  } else {
    pass(
      `stripe automatic payment methods correctly rejected (${b.status})`,
      (b.json.error?.message ?? '').slice(0, 200),
    );
  }

  // 3. Account state — the honest reason a live purchase cannot complete yet.
  const acct = await fetch('https://api.stripe.com/v1/account', {
    headers: { Authorization: `Bearer ${key}` },
  });
  const account = await acct.json();
  if (acct.ok) {
    const line =
      `charges_enabled=${account.charges_enabled} ` +
      `payouts_enabled=${account.payouts_enabled} ` +
      `card_payments=${account.capabilities?.card_payments ?? 'n/a'}`;
    if (account.charges_enabled) pass('stripe account can accept live charges', line);
    else console.log(warn('NOTE') + '  stripe activation incomplete — sessions create, payments cannot complete\n' + dim('       ' + line));
  } else {
    fail('stripe account lookup failed', JSON.stringify(account.error ?? account));
  }

  // 4. The webhook endpoint Stripe is configured to call.
  const hooks = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=10', {
    headers: { Authorization: `Bearer ${key}` },
  });
  const hookJson = await hooks.json();
  if (hooks.ok) {
    const target = (hookJson.data ?? []).find((h) => h.url?.includes('/api/stripe/webhook'));
    if (target) {
      pass(
        `stripe webhook endpoint ${target.id} -> ${target.url}`,
        `status=${target.status} events=${(target.enabled_events ?? []).join(',')}`,
      );
    } else {
      fail('no webhook endpoint pointing at /api/stripe/webhook');
    }
  } else {
    fail('stripe webhook lookup failed', JSON.stringify(hookJson.error ?? hookJson));
  }
}

// ------------------------------------------------------------------ vercel --
{
  try {
    // Discovers the team and finds-or-creates the project, so this works
    // against a fresh account with nothing but a token.
    const { resolveTarget } = await import('./_vercel.mjs');
    const { teamId, projectId, projectName } = await resolveTarget();

    const user = await fetch('https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
    }).then((r) => r.json());

    pass(`vercel project ${projectName} ready`, `project=${projectId} team=${teamId}`);

    // `limited` is what refuses deployments containing serverless functions.
    if (user.user?.limited) {
      failed = true;
      console.log(
        bad('FAIL') +
          `  vercel account "${user.user.username}" is limited — deployments with functions will be BLOCKED`,
      );
    } else {
      pass(`vercel account ${user.user?.username} in good standing`, 'limited=false');
    }
  } catch (err) {
    fail('vercel unreachable', err.message);
  }
}

// ------------------------------------------------------------------- terac --
{
  const key = process.env.TERAC_API_KEY;
  if (!key) {
    console.log(
      warn('NOTE') + '  TERAC_API_KEY is empty — LABOR_PROVIDER falls back to the seeded stub',
    );
    console.log(dim('       This is expected before 8:30am and does not block anything.'));
  } else {
    try {
      const res = await fetch(`${process.env.TERAC_API_BASE}/organizations/current/context`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const json = await res.json();
      if (res.ok) pass(`terac auth ok — ${json.organizationName}`, `balance $${json.balanceDollars}`);
      else fail(`terac -> ${res.status}`, JSON.stringify(json.error ?? json));
    } catch (err) {
      fail('terac unreachable', err.message);
    }
  }
}

console.log('');
console.log(failed ? bad('preflight: FAILED') : ok('preflight: ALL LIVE DEPENDENCIES VERIFIED'));
process.exit(failed ? 1 : 0);
