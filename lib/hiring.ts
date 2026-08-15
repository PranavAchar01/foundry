import { env } from './env';
import { id, query } from './db';
import * as decisions from './decisions';
import * as ledger from './ledger';
import { authorizeSpend } from './guardrails';
import { laborProvider } from './providers/labor';
import type { LaborProvider } from './providers/types';

/**
 * Hiring: post a paid listing for the human who actually delivers a segment's
 * offer, and price it as a share of what the product sells for.
 *
 * The economics are the whole point. A segment is only worth building if the
 * expert time it needs costs less than it sells for, so the listing is priced
 * from the product: `payout = price × FOUNDRY_LABOR_PAYOUT_SHARE` (0.75 by
 * default). If the marketplace quotes above that, the margin is gone and the
 * listing is declined with the arithmetic written down — which is the same
 * first-class decline path the rest of the system uses.
 *
 * Nothing here posts a listing without passing `authorizeSpend` first.
 */

export interface HireRequest {
  segmentId: string;
  businessId?: string | null;
  /** e.g. "AI research consultant". */
  role: string;
  /** What the human is being asked to produce. */
  deliverable: string;
  /** Who is qualified, in marketplace panel terms. */
  expertProfile: string;
  /** What the product sells for, in cents (per interval when recurring). */
  productPriceCents: number;
  /** 'subscription' amortises the hire across `subscriberTarget`. */
  billing?: 'one_time' | 'subscription';
  /** Subscribers the one-off expert cost is spread across. */
  subscriberTarget?: number;
  /** Override the default share. */
  payoutShare?: number;
  cycleId?: string;
  timelineHours?: number;
}

export interface HireResult {
  listingId: string;
  decision: 'posted' | 'declined';
  reason: string;
  code: string;
  targetPayoutCents: number;
  quotedCents: number | null;
  opportunityId: string | null;
  provider: string;
  decisionId: string;
}

export async function hireForSegment(
  req: HireRequest,
  provider: LaborProvider = laborProvider(),
): Promise<HireResult> {
  const listingId = id('lst');
  const share = req.payoutShare ?? env.laborPayoutShare;

  /*
   * A $5/month product cannot fund a $100 expert out of a single sale, and
   * testing it that way would decline every worthwhile hire. An expert review
   * is a one-off cost that every subscriber receives, so the budget is the
   * share of revenue it earns across the first `subscriberTarget` subscribers.
   * One-time products keep the original per-sale test.
   */
  const recurring = req.billing === 'subscription';
  const subscribers = recurring ? (req.subscriberTarget ?? env.subscriberTarget) : 1;
  const targetPayoutCents = Math.round(req.productPriceCents * share * subscribers);
  const cycleId = req.cycleId ?? decisions.newCycleId();

  const task =
    `${req.deliverable}\n\n` +
    `This is paid work for a product that sells for $${(req.productPriceCents / 100).toFixed(2)}` +
    `${recurring ? '/month' : ''}. The budget for this engagement is ` +
    `$${(targetPayoutCents / 100).toFixed(2)}.`;

  await query(
    `INSERT INTO labor_listings
       (id, segment_id, business_id, provider, role, expert_profile,
        product_price_cents, payout_share, target_payout_cents, decision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
    [
      listingId, req.segmentId, req.businessId ?? null, provider.info.name,
      req.role, req.expertProfile, req.productPriceCents, share, targetPayoutCents,
    ],
  );

  const settle = async (
    outcome: 'posted' | 'declined',
    reason: string,
    code: string,
    quotedCents: number | null,
    opportunityId: string | null,
  ): Promise<HireResult> => {
    await query(
      `UPDATE labor_listings SET decision = $2, reason = $3, quoted_cents = $4,
              opportunity_id = $5, resolved_at = now() WHERE id = $1`,
      [listingId, outcome, reason, quotedCents, opportunityId],
    );
    const row = await decisions.record({
      cycleId,
      businessId: req.businessId ?? null,
      action: outcome === 'posted' ? 'LISTING_POSTED' : 'LISTING_DECLINED',
      reasoning: reason,
      confidence: 0.9,
      model: 'guardrail',
      inputs: {
        segmentId: req.segmentId, role: req.role,
        productPriceCents: req.productPriceCents, payoutShare: share,
        targetPayoutCents,
      },
      outputs: { listingId, quotedCents, opportunityId, provider: provider.info.name, code },
    });
    return {
      listingId, decision: outcome, reason, code, targetPayoutCents,
      quotedCents, opportunityId, provider: provider.info.name, decisionId: row.id,
    };
  };

  // 1. Price the work. Quoting is free; committing is not.
  let quote;
  try {
    quote = await provider.quote(task, req.expertProfile, {
      timelineHours: req.timelineHours ?? 24,
      submissionCount: 1,
      businessId: req.businessId ?? undefined,
    });
  } catch (err) {
    return settle('declined', `Could not price the listing: ${String(err).slice(0, 240)}`, 'QUOTE_FAILED', null, null);
  }

  const quotedCents = ledger.cents(quote.totalCost);

  // 2. The margin test. This is the reason the listing exists.
  if (quotedCents > targetPayoutCents) {
    return settle(
      'declined',
      `Declined to hire a ${req.role}: the marketplace quoted ` +
        `$${(quotedCents / 100).toFixed(2)} but the product earns ` +
        `$${(req.productPriceCents / 100).toFixed(2)}${recurring ? `/month across ${subscribers} subscribers` : ''}, ` +
        `so at a ${Math.round(share * 100)}% payout the budget is ` +
        `$${(targetPayoutCents / 100).toFixed(2)}. Hiring would cost more than it earns. ` +
        `Provider rationale: ${quote.reasoning}`,
      'MARGIN_NEGATIVE',
      quotedCents,
      null,
    );
  }

  // 3. The usual ceilings still apply.
  const auth = await authorizeSpend({
    businessId: req.businessId ?? null,
    amountUsd: quote.totalCost,
    category: 'labor',
  });
  if (!auth.allowed) {
    return settle(
      'declined',
      `Declined to hire a ${req.role} at $${quote.totalCost}: ${auth.reason}`,
      auth.code,
      quotedCents,
      null,
    );
  }

  // 4. Post it.
  let opportunityId: string;
  try {
    const purchase = await provider.purchase(quote.quoteId, {
      name: `foundry-${req.segmentId}-${req.role}`.slice(0, 60),
    });
    opportunityId = purchase.opportunityId;
  } catch (err) {
    return settle('declined', `Listing could not be launched: ${String(err).slice(0, 240)}`, 'LAUNCH_FAILED', quotedCents, null);
  }

  // 5. Book it as COGS, into the same ledger the revenue lands in.
  await ledger.post({
    businessId: req.businessId ?? null,
    kind: 'COGS',
    amountCents: quotedCents,
    description: `${req.role} hired for ${req.segmentId} via ${provider.info.name}`,
    source: `hire:${provider.info.name}`,
    externalId: `hire:${provider.info.name}:${opportunityId}`,
    meta: {
      listingId, segmentId: req.segmentId, role: req.role,
      productPriceCents: req.productPriceCents, payoutShare: share,
    },
  });

  const cohortRevenueCents = req.productPriceCents * subscribers;
  const marginCents = cohortRevenueCents - quotedCents;
  const paybackSubs = Math.ceil(quotedCents / Math.max(1, req.productPriceCents));
  return settle(
    'posted',
    `Hired a ${req.role} for $${quote.totalCost}. The product bills ` +
      `$${(req.productPriceCents / 100).toFixed(2)}${recurring ? '/month' : ''}` +
      `${recurring ? ` and the cost is amortised across ${subscribers} subscribers` : ''}, ` +
      `a ${Math.round(share * 100)}% payout budget of $${(targetPayoutCents / 100).toFixed(2)}. ` +
      `${recurring ? `It pays for itself at ${paybackSubs} subscriber(s); ` : ''}` +
      `margin across the cohort is $${(marginCents / 100).toFixed(2)}. ` +
      `Provider rationale: ${quote.reasoning}`,
    '',
    quotedCents,
    opportunityId,
  );
}

export interface ListingRow {
  id: string;
  segment_id: string | null;
  business_id: string | null;
  role: string;
  product_price_cents: number;
  payout_share: number;
  target_payout_cents: number;
  quoted_cents: number | null;
  decision: string;
  reason: string;
  opportunity_id: string | null;
  created_at: string;
}

export async function listings(limit = 25): Promise<ListingRow[]> {
  return query<ListingRow>(`SELECT * FROM labor_listings ORDER BY created_at DESC LIMIT $1`, [limit]);
}
