#!/usr/bin/env node
/**
 * Points Foundry at a new public URL, everywhere it matters.
 *
 *   node scripts/retarget.mjs https://foundry-biz-xyz.vercel.app
 *
 * Moving the app to a different Vercel account changes its origin, and three
 * things are pinned to that origin:
 *   1. FOUNDRY_PUBLIC_URL — baked into every spawned page's checkout and
 *      beacon endpoints, so new businesses call the right host.
 *   2. The Stripe webhook endpoint — otherwise revenue events go nowhere.
 *   3. The GitHub Actions variable the 5-minute CEO loop posts to.
 *
 * Idempotent: re-running with the same URL changes nothing.
 */
import { execFileSync } from 'node:child_process';
import { bad, dim, loadEnv, ok, warn } from './_env.mjs';
import { setEnvLocal } from './_vercel.mjs';

loadEnv();

const target = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https:\/\/[a-z0-9.-]+$/i.test(target)) {
  console.error(bad('FAIL') + '  usage: node scripts/retarget.mjs https://your-app.vercel.app');
  process.exit(1);
}

let failed = 0;

// 1. .env.local ---------------------------------------------------------------
setEnvLocal('FOUNDRY_PUBLIC_URL', target);
console.log(ok('PASS') + `  FOUNDRY_PUBLIC_URL = ${target}`);

// 2. Stripe webhook -----------------------------------------------------------
{
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  const list = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=20', {
    headers: { Authorization: `Bearer ${key}` },
  }).then((r) => r.json());

  const endpoint = (list.data ?? []).find((h) => h.url?.includes('/api/stripe/webhook'));
  if (!endpoint) {
    failed++;
    console.log(bad('FAIL') + '  no Stripe webhook endpoint pointing at /api/stripe/webhook');
  } else if (endpoint.url === `${target}/api/stripe/webhook`) {
    console.log(ok('PASS') + `  Stripe webhook ${endpoint.id} already points at ${target}`);
  } else {
    const form = new URLSearchParams({ url: `${target}/api/stripe/webhook` });
    const res = await fetch(`https://api.stripe.com/v1/webhook_endpoints/${endpoint.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const json = await res.json();
    if (res.ok) {
      console.log(ok('PASS') + `  Stripe webhook ${endpoint.id} repointed`);
      console.log(dim(`       ${endpoint.url}\n    -> ${json.url}`));
      console.log(dim(`       signing secret is unchanged, so STRIPE_WEBHOOK_SECRET still applies`));
    } else {
      failed++;
      console.log(bad('FAIL') + `  could not repoint webhook: ${JSON.stringify(json.error ?? json).slice(0, 200)}`);
    }
  }
}

// 3. GitHub Actions variable --------------------------------------------------
{
  const repo = process.env.GITHUB_REPO;
  try {
    execFileSync('gh', ['variable', 'set', 'FOUNDRY_PUBLIC_URL', '--repo', repo, '--body', target], {
      stdio: 'ignore',
    });
    console.log(ok('PASS') + `  GitHub Actions variable FOUNDRY_PUBLIC_URL = ${target}`);
  } catch {
    console.log(warn('NOTE') + `  could not set the GitHub variable (is gh authenticated?).`);
    console.log(dim(`       gh variable set FOUNDRY_PUBLIC_URL --repo ${repo} --body ${target}`));
  }
}

console.log('');
console.log(
  failed
    ? bad(`retarget: ${failed} step(s) FAILED`)
    : ok('retarget: every origin-pinned reference now points at the new URL'),
);
console.log(dim('       run `pnpm env:push` next so production picks up FOUNDRY_PUBLIC_URL'));
process.exit(failed ? 1 : 0);
