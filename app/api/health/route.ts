import { query } from '@/lib/db';
import { env } from '@/lib/env';
import { describeProviders } from '@/lib/providers';
import { breakerState } from '@/lib/guardrails';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What the smoke test asserts against after a deploy. */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    const rows = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM businesses`);
    checks.database = { ok: true, detail: `businesses table reachable, ${rows[0]?.n ?? 0} rows` };
  } catch (err) {
    checks.database = { ok: false, detail: errorMessage(err) };
  }

  checks.stripe = {
    ok: Boolean(env.stripeSecretKey && env.stripeWebhookSecret),
    detail: env.stripeSecretKey
      ? `key present (${env.stripeSecretKey.startsWith('sk_live') ? 'live' : 'test'}), webhook secret ${env.stripeWebhookSecret ? 'present' : 'MISSING'}, payment_method_types=${env.stripePaymentMethodTypes.join(',')}`
      : 'STRIPE_SECRET_KEY missing',
  };

  const brainKey = env.brainProvider === 'openai' ? env.openaiApiKey : env.anthropicApiKey;
  checks.brain = {
    ok: Boolean(brainKey),
    detail: brainKey
      ? `provider=${env.brainProvider} model=${env.activeModel}`
      : `${env.brainProvider} selected but its API key is missing`,
  };

  checks.labor = {
    ok: true,
    detail: `provider=${env.laborProvider}${env.teracApiKey ? '' : ' (TERAC_API_KEY empty — stub selected)'}`,
  };

  try {
    const breaker = await breakerState();
    checks.circuitBreaker = {
      ok: !breaker.tripped,
      detail: breaker.tripped ? `TRIPPED: ${breaker.reason}` : 'armed and not tripped',
    };
  } catch (err) {
    checks.circuitBreaker = { ok: false, detail: errorMessage(err) };
  }

  const ok = Object.values(checks).every((c) => c.ok);

  return json(
    {
      ok,
      service: 'foundry',
      publicUrl: env.publicUrl,
      coldStartAt: env.coldStartAt,
      disclosure: env.disclosureLine,
      checks,
      providers: describeProviders().map((p) => ({
        capability: p.capability,
        active: p.active,
        options: p.options.map((o) => o.name),
      })),
    },
    { status: ok ? 200 : 503 },
  );
}
