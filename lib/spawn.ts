import { env } from './env';
import { id, query } from './db';
import * as decisions from './decisions';
import * as businesses from './businesses';
import { authorizeSpend, breakerState, requiresHumanEscalation } from './guardrails';
import { proposeHypothesis, slugify, type Hypothesis } from './agent';
import { hostProvider, pagegenProvider, qaProvider } from './providers';
import type { PageSpec } from './providers/types';

/**
 * Spawn: niche string in, deployed and checkout-wired business out.
 *
 * The steps are hypothesis -> page -> deploy -> QA -> persist, and the whole
 * thing is budgeted like anything else that spends money: infrastructure for a
 * new business is charged to the portfolio before the deploy starts, so the
 * ceiling stops a spawn the same way it stops a labor purchase.
 */

/** What one spawned business costs the portfolio in hosting, in dollars. */
export const SPAWN_INFRA_COST_USD = 1.0;

export interface SpawnInput {
  niche: string;
  cycleId?: string;
  /** Skip the model call and use this hypothesis verbatim. Used by tests. */
  hypothesis?: Hypothesis;
  /**
   * Who this one is for, when it is being built for a named person rather than
   * a market. It reaches the page generator and nothing else: the storefront is
   * written to one buyer, so it has to know which buyer. Unset on the segment
   * path, where there is nobody to write to.
   */
  prospect?: { bio: string; chore: string };
}

export interface SpawnResult {
  ok: boolean;
  businessId: string | null;
  url: string | null;
  slug: string | null;
  elapsedMs: number;
  stages: { name: string; ms: number; detail: string }[];
  hypothesis: Hypothesis | null;
  qa: { passed: boolean; provider: string; checks: { name: string; passed: boolean; detail: string }[] } | null;
  decisionId: string | null;
  error: string | null;
  guardrailCode: string | null;
}

export async function spawn(input: SpawnInput): Promise<SpawnResult> {
  const startedAt = Date.now();
  const cycleId = input.cycleId ?? decisions.newCycleId();
  const stages: SpawnResult['stages'] = [];
  const mark = (name: string, from: number, detail = '') =>
    stages.push({ name, ms: Date.now() - from, detail });

  const fail = async (
    error: string,
    code: string | null,
    hypothesis: Hypothesis | null,
  ): Promise<SpawnResult> => {
    const row = await decisions.record({
      cycleId,
      action: 'SPAWN_REFUSED',
      reasoning: error,
      confidence: 0.9,
      inputs: { niche: input.niche },
      outputs: { guardrailCode: code, stages },
    });
    return {
      ok: false, businessId: null, url: null, slug: null,
      elapsedMs: Date.now() - startedAt, stages, hypothesis,
      qa: null, decisionId: row.id, error, guardrailCode: code,
    };
  };

  // --- guardrail: the emergency stop outranks every other check ------------
  // Checked first and explicitly: when the breaker is latched the answer must
  // be "the breaker is tripped", not whichever ceiling happens to be nearest.
  const breaker = await breakerState();
  if (env.circuitBreaker && breaker.tripped) {
    return fail(
      `Refused to spawn: circuit breaker is tripped (${breaker.reason || 'no reason recorded'}).`,
      'CIRCUIT_BREAKER_TRIPPED',
      null,
    );
  }

  // --- guardrail: legally-exposed niches never auto-spawn -------------------
  const flagged = requiresHumanEscalation(input.niche);
  if (flagged.required) {
    return fail(
      `Refused to spawn into "${input.niche}": ${flagged.why}. This class of action is ` +
        'mandatory-escalation and cannot be taken on the agent\'s own authority.',
      'MANDATORY_ESCALATION',
      null,
    );
  }

  // --- guardrail: portfolio headroom ---------------------------------------
  const activeCount = await businesses.countActive();
  if (activeCount >= env.maxBusinesses) {
    return fail(
      `Refused to spawn: ${activeCount} active businesses is at the FOUNDRY_MAX_BUSINESSES ceiling of ${env.maxBusinesses}.`,
      'MAX_BUSINESSES',
      null,
    );
  }

  const auth = await authorizeSpend({
    businessId: null,
    amountUsd: SPAWN_INFRA_COST_USD,
    category: 'infra',
  });
  if (!auth.allowed) {
    return fail(`Refused to spawn: ${auth.reason}`, auth.code, null);
  }

  // --- 1. hypothesis --------------------------------------------------------
  let t = Date.now();
  let hypothesis: Hypothesis;
  let model = 'preset';
  let fromModel = false;
  if (input.hypothesis) {
    hypothesis = input.hypothesis;
    mark('hypothesis', t, 'supplied by caller');
  } else {
    const existing = (await businesses.list()).map((b) => b.name);
    const proposed = await proposeHypothesis(input.niche, {
      existing,
      remainingBudgetUsd: auth.limits.remainingPortfolioUsd,
    });
    hypothesis = proposed.value;
    model = proposed.model;
    fromModel = proposed.fromModel;
    mark('hypothesis', t, `${model}${proposed.error ? ` (fallback: ${proposed.error})` : ''}`);
  }

  const businessId = id('biz');
  const slug = await uniqueSlug(slugify(hypothesis.slug || hypothesis.name));

  // --- 2. page generation ---------------------------------------------------
  t = Date.now();
  const spec: PageSpec = {
    businessId,
    slug,
    name: hypothesis.name,
    tagline: hypothesis.tagline,
    niche: input.niche,
    offer: hypothesis.offer,
    targetCustomer: hypothesis.targetCustomer,
    priceCents: hypothesis.priceCents,
    bullets: hypothesis.bullets,
    checkoutEndpoint: `${env.publicUrl}/api/checkout`,
    beaconEndpoint: `${env.publicUrl}/api/track`,
    disclosure: env.disclosureLine,
    prospectBio: input.prospect?.bio,
    prospectChore: input.prospect?.chore,
  };

  const pagegen = pagegenProvider();
  const page = await pagegen.generate(spec).catch(async (err: unknown) => {
    // A sponsor pagegen having a bad minute must not kill the spawn.
    mark('pagegen-fallback', t, String(err).slice(0, 160));
    const { InternalPagegenProvider } = await import('./providers/pagegen');
    return new InternalPagegenProvider().generate(spec);
  });
  mark('pagegen', t, page.provider);

  // --- 3. deploy ------------------------------------------------------------
  // A pagegen provider may have published the site itself (Lovable builds and
  // hosts a full app rather than returning a file). Deploying a copy would give
  // the business two storefronts that drift apart, so use what it published.
  t = Date.now();
  let deployed: { url: string; deploymentId: string; provider: string; ready: boolean };
  if (page.hostedUrl) {
    deployed = {
      url: page.hostedUrl,
      deploymentId: page.projectId ?? '',
      provider: page.provider,
      ready: true,
    };
    mark('deploy', t, `hosted by ${page.provider}: ${deployed.url}`);
  } else {
    const host = hostProvider();
    try {
      deployed = await host.deploy({
        slug,
        files: [{ path: 'index.html', content: page.html }],
      });
    } catch (err) {
      return fail(`Deploy failed: ${String(err).slice(0, 400)}`, null, hypothesis);
    }
    mark('deploy', t, `${deployed.provider} ${deployed.url}`);
  }

  // --- 4. persist -----------------------------------------------------------
  t = Date.now();
  const hypothesisId = id('hyp');
  await query(
    `INSERT INTO hypotheses
       (id, niche, thesis, target_customer, offer, price_cents, confidence, reasoning, source, business_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      hypothesisId, input.niche, hypothesis.thesis, hypothesis.targetCustomer,
      hypothesis.offer, hypothesis.priceCents, hypothesis.confidence,
      hypothesis.reasoning, fromModel ? model : 'heuristic', businessId,
    ],
  );

  await query(
    `INSERT INTO businesses
       (id, slug, name, niche, tagline, hypothesis_id, url, price_cents, status, meta,
        billing, billing_interval, subscriber_target)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'TESTING',$9,'subscription',$10,$11)`,
    [
      businessId, slug, hypothesis.name, input.niche, hypothesis.tagline,
      hypothesisId, deployed.url, hypothesis.priceCents,
      JSON.stringify({
        deploymentId: deployed.deploymentId,
        host: deployed.provider,
        pagegen: page.provider,
        bullets: hypothesis.bullets,
      }),
      env.billingInterval,
      env.subscriberTarget,
    ],
  );

  // Hosting is real money: book it as OPEX the moment the business exists.
  const { post } = await import('./ledger');
  await post({
    businessId,
    kind: 'OPEX',
    amountCents: Math.round(SPAWN_INFRA_COST_USD * 100),
    description: `Hosting and deploy for ${hypothesis.name} via ${deployed.provider}`,
    source: `host:${deployed.provider}`,
    externalId: `infra:${businessId}`,
    meta: { deploymentId: deployed.deploymentId, url: deployed.url },
  });
  mark('persist', t, businessId);

  // --- 5. machine -----------------------------------------------------------
  // The business's own persistent VM. Best-effort: a business without a machine
  // still sells, it just has no operator working on it between cycles.
  t = Date.now();
  let machineDetail = 'skipped (no SUPERSERVE_API_KEY)';
  if (env.superserveApiKey) {
    try {
      const { provision } = await import('./machine');
      const provisioned = await provision({
        businessId,
        name: hypothesis.name,
        niche: input.niche,
        offer: hypothesis.offer,
        targetCustomer: hypothesis.targetCustomer,
        priceCents: hypothesis.priceCents,
        url: deployed.url,
        thesis: hypothesis.thesis,
        cycleId,
      });
      machineDetail = provisioned.ok
        ? `provisioned ${provisioned.machine?.external_id}`
        : `declined: ${provisioned.reason}`;
    } catch (err) {
      machineDetail = `failed: ${String(err).slice(0, 140)}`;
    }
  }
  mark('machine', t, machineDetail);

  // --- 6. QA ----------------------------------------------------------------
  t = Date.now();
  const qa = await qaProvider()
    .verify({
      url: deployed.url,
      expect: [hypothesis.name, env.disclosureLine],
    })
    .catch((err: unknown) => ({
      passed: false,
      provider: env.qaProvider,
      checks: [{ name: 'qa-error', passed: false, detail: String(err).slice(0, 200) }],
    }));
  mark('qa', t, qa.passed ? 'passed' : 'FAILED');

  const elapsedMs = Date.now() - startedAt;

  const row = await decisions.record({
    cycleId,
    businessId,
    action: 'SPAWN',
    reasoning:
      `Spawned "${hypothesis.name}" into ${input.niche} at $${(hypothesis.priceCents / 100).toFixed(2)}. ` +
      `${hypothesis.reasoning} Deployed to ${deployed.url} in ${(elapsedMs / 1000).toFixed(1)}s; ` +
      `QA ${qa.passed ? 'passed' : 'FAILED'} via ${qa.provider}. ` +
      `Booked $${SPAWN_INFRA_COST_USD.toFixed(2)} hosting as OPEX against the portfolio.`,
    confidence: hypothesis.confidence,
    model,
    inputs: { niche: input.niche, limits: auth.limits },
    outputs: {
      businessId, slug, url: deployed.url, priceCents: hypothesis.priceCents,
      elapsedMs, stages, qa, pagegen: page.provider, host: deployed.provider,
      modelSourced: fromModel,
    },
  });

  return {
    ok: true, businessId, url: deployed.url, slug,
    elapsedMs, stages, hypothesis, qa, decisionId: row.id,
    error: null, guardrailCode: null,
  };
}

async function uniqueSlug(base: string): Promise<string> {
  const rows = await query<{ slug: string }>(
    `SELECT slug FROM businesses WHERE slug = $1 OR slug LIKE $2`,
    [base, `${base}-%`],
  );
  if (!rows.some((r) => r.slug === base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!rows.some((r) => r.slug === candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

/**
 * Re-render and redeploy every live business's storefront with the current
 * template.
 *
 * A spawned site is a static deployment frozen at spawn time, so changing the
 * template only affects businesses spawned afterwards. This brings the existing
 * ones forward. It redeploys to the same project, so each business keeps its
 * URL and nothing in the database changes.
 */
export async function restyleAll(
  opts: { onlyBroken?: boolean } = {},
): Promise<{ businessId: string; name: string; ok: boolean; detail: string }[]> {
  const live = await businesses.live();
  const pagegen = pagegenProvider();
  const host = hostProvider();
  const out: { businessId: string; name: string; ok: boolean; detail: string }[] = [];

  for (const b of live) {
    try {
      // Default to repairing only what is actually broken. Rebuilding a healthy
      // storefront costs a provider build and can churn a working site.
      if (opts.onlyBroken !== false) {
        const reachable = await fetch(b.url, { signal: AbortSignal.timeout(8000) })
          .then((r) => r.ok)
          .catch(() => false);
        if (reachable) {
          out.push({ businessId: b.id, name: b.name, ok: true, detail: 'already serving, left alone' });
          continue;
        }
      }

      const meta = b.meta as { bullets?: string[] };
      const page = await pagegen.generate({
        businessId: b.id,
        slug: b.slug,
        name: b.name,
        tagline: b.tagline,
        niche: b.niche,
        offer: b.tagline,
        targetCustomer: b.niche,
        priceCents: b.price_cents,
        bullets: meta.bullets ?? [],
        checkoutEndpoint: `${env.publicUrl}/api/checkout`,
        beaconEndpoint: `${env.publicUrl}/api/track`,
        disclosure: env.disclosureLine,
      });

      // A provider that hosts the site itself gives back a new URL. That URL is
      // now the business's storefront, so it must be persisted — otherwise the
      // record keeps pointing at whatever it was hosted on before, which may no
      // longer exist.
      if (page.hostedUrl) {
        await query(`UPDATE businesses SET url = $2, updated_at = now() WHERE id = $1`, [
          b.id,
          page.hostedUrl,
        ]);
        out.push({
          businessId: b.id,
          name: b.name,
          ok: true,
          detail: `rebuilt and rehosted by ${page.provider}: ${page.hostedUrl}`,
        });
        continue;
      }

      const deployed = await host.deploy({
        slug: b.slug,
        files: [{ path: 'index.html', content: page.html }],
      });
      if (deployed.url && deployed.url !== b.url) {
        await query(`UPDATE businesses SET url = $2, updated_at = now() WHERE id = $1`, [b.id, deployed.url]);
      }
      out.push({
        businessId: b.id,
        name: b.name,
        ok: true,
        detail: `redeployed to ${deployed.url}`,
      });
    } catch (err) {
      out.push({ businessId: b.id, name: b.name, ok: false, detail: String(err).slice(0, 200) });
    }
  }
  return out;
}
