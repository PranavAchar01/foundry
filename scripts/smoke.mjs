#!/usr/bin/env node
/**
 * Smoke test against a LIVE deployment. Asserts real content, not just a 200.
 *
 *   node scripts/smoke.mjs [https://foundry-biz-eight.vercel.app]
 */
import { bad, dim, loadEnv, ok, warn } from './_env.mjs';

loadEnv();

const BASE = (process.argv[2] ?? process.env.FOUNDRY_PUBLIC_URL ?? 'https://foundry-biz-eight.vercel.app')
  .replace(/\/$/, '');

let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(ok('PASS') + `  ${name}`);
    if (detail) console.log(dim('       ' + String(detail).slice(0, 200)));
  } else {
    failed++;
    console.log(bad('FAIL') + `  ${name}`);
    if (detail) console.log(dim('       ' + String(detail).slice(0, 300)));
  }
};

console.log(dim(`smoke target: ${BASE}\n`));

// 1. The dashboard actually serves.
{
  const res = await fetch(BASE, { headers: { 'user-agent': 'foundry-smoke/1.0' } });
  const html = await res.text();
  check('GET / -> 200', res.status === 200, `${res.status} ${res.headers.get('content-type')}`);
  check('/ is the Foundry dashboard', html.includes('FOUNDRY'), `${html.length} bytes`);
}

// 2. Health, with its per-dependency detail.
{
  const res = await fetch(`${BASE}/api/health`);
  const json = await res.json().catch(() => ({}));
  check('/api/health responds', res.status === 200 || res.status === 503, `status ${res.status}`);
  check('database reachable from production', json?.checks?.database?.ok === true, json?.checks?.database?.detail);
  check('stripe configured in production', json?.checks?.stripe?.ok === true, json?.checks?.stripe?.detail);
  check('brain configured in production', json?.checks?.brain?.ok === true, json?.checks?.brain?.detail);
  check('circuit breaker armed', json?.checks?.circuitBreaker?.ok === true, json?.checks?.circuitBreaker?.detail);
}

// 3. Portfolio payload — the dashboard's data source.
{
  const res = await fetch(`${BASE}/api/portfolio`);
  const json = await res.json().catch(() => ({}));
  check('/api/portfolio -> 200', res.status === 200, `status ${res.status}`);
  check('portfolio has a P&L', typeof json?.pnl?.revenueCents === 'number',
    `revenue=${json?.pnl?.revenueCents} cogs=${json?.pnl?.cogsCents} opex=${json?.pnl?.opexCents}`);
  check('portfolio has businesses array', Array.isArray(json?.businesses), `${json?.businesses?.length ?? 0} businesses`);
  check('portfolio has the decision log', Array.isArray(json?.decisions), `${json?.decisions?.length ?? 0} decisions`);
}

// 4. Provider registry — every capability, every implementation.
{
  const res = await fetch(`${BASE}/api/providers`);
  const json = await res.json().catch(() => ({}));
  const caps = json?.capabilities ?? [];
  check('/api/providers lists 9 capabilities', caps.length === 9,
    caps.map((c) => `${c.capability}=${c.active}`).join(' '));
  check('every capability has an active implementation',
    caps.every((c) => c.options.some((o) => o.isActive)));
}

// 5. Checkout — the money path. A 404 for an unknown business proves the route
//    is live and validating; a real session is created below if one exists.
{
  const res = await fetch(`${BASE}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessId: 'definitely-not-a-real-business' }),
  });
  check('/api/checkout rejects an unknown business with 404', res.status === 404, `status ${res.status}`);
  check('/api/checkout sends CORS headers for spawned origins',
    res.headers.get('access-control-allow-origin') === '*');
}

// 6. Webhook signature enforcement — an unsigned POST must be refused.
{
  const res = await fetch(`${BASE}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'checkout.session.completed' }),
  });
  const json = await res.json().catch(() => ({}));
  check('/api/stripe/webhook refuses an unsigned payload', res.status === 400, json?.error);
}

// 7. Live checkout session against a real business, if the portfolio has one.
{
  const portfolio = await fetch(`${BASE}/api/portfolio`).then((r) => r.json()).catch(() => ({}));
  const target = (portfolio.businesses ?? []).find((b) => b.status !== 'KILLED');
  if (!target) {
    console.log(warn('NOTE') + '  no live business yet — skipping the real checkout session check');
  } else {
    const res = await fetch(`${BASE}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ businessId: target.id }),
    });
    const json = await res.json().catch(() => ({}));
    check(`/api/checkout creates a real session for ${target.id}`, res.status === 200,
      res.status === 200 ? `${json.sessionId} via ${json.provider}` : JSON.stringify(json).slice(0, 240));
    check('checkout session has a hosted payment URL', typeof json?.url === 'string' && json.url.startsWith('https://'));

    // 8. The deployed business page itself.
    if (target.url) {
      const page = await fetch(target.url);
      const html = await page.text();
      check(`spawned business ${target.url} serves 200`, page.status === 200);
      check('spawned page carries the buy button', html.includes('id="buy"'));
      check('spawned page carries the AI disclosure',
        html.includes(process.env.FOUNDRY_DISCLOSURE_LINE ?? 'operated end-to-end by an AI agent'));
    }
  }
}

console.log('');
console.log(failed ? bad(`smoke: ${failed} CHECK(S) FAILED`) : ok('smoke: LIVE DEPLOYMENT VERIFIED'));
process.exit(failed ? 1 : 0);
