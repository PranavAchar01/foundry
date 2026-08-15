import * as personal from '@/lib/personal';
import { listingFor, postListing } from '@/lib/hiring';
import { env } from '@/lib/env';
import { spawn } from '@/lib/spawn';
import { slugify } from '@/lib/agent';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Stage two: build one person's business.
 *
 * One person per call, so the client can fan out across the whole cohort and
 * each storefront lands on the dashboard the moment it is deployed rather than
 * all of them arriving together at the end of a single long request.
 *
 * The spawn itself is the same real one the segment path uses — hypothesis,
 * page, deploy, QA, ledger — handed a hypothesis built from this person's
 * niche instead of a segment's.
 */
export async function POST(req: Request) {
  const started = Date.now();
  const body = (await req.json().catch(() => ({}))) as { runId?: string; username?: string };
  const runId = String(body.runId ?? '').trim();
  const username = String(body.username ?? '').replace(/^@/, '').trim();

  // Every exit carries the same keys, including the failures: the client types
  // `message` as always-present, and a body that drops it on some paths is the
  // kind of difference that only shows up on the one run that goes wrong.
  const fail = (error: string, status: number) =>
    json(
      { username, businessId: null, url: null, message: null, hire: null, ms: Date.now() - started, error },
      { status },
    );

  if (!runId || !username) return fail('runId and username are required', 400);

  try {
    // Idempotent: a retry or a double-click gets the business this run already
    // built for this person, not a second one on a second URL.
    const already = await personal.businessFor(runId, username);
    if (already) {
      const prepared = await personal.draftFor(runId, username);
      const posted = await listingFor(already.id);
      return json({
        username,
        businessId: already.id,
        url: already.url,
        message: prepared?.draft.message ?? null,
        hire: posted && {
          decision: posted.decision,
          reason: posted.reason,
          opportunityId: posted.opportunity_id,
          dashboardUrl: null,
          provider: 'terac',
          targetPayoutCents: posted.target_payout_cents,
          quotedCents: posted.quoted_cents,
        },
        ms: Date.now() - started,
        error: null,
      });
    }

    const target = await personal.plannedTarget(runId, username);
    if (!target) return fail('this person is not in this run\'s plan', 404);

    const { niche } = target;
    const spawned = await spawn({
      // The market this storefront is in, as read off one bio. It is what the
      // escalation check reads and what the tile shows under the name.
      niche: niche.targetCustomer,
      cycleId: runId,
      // What makes this storefront theirs rather than a segment's: the page is
      // written to the person whose bio produced it, in the vocabulary of their
      // own trade. Without it eight builds in one minute render eight variants
      // of the same page.
      prospect: { bio: target.bio, chore: niche.targetCustomer },
      hypothesis: {
        name: niche.name.slice(0, 60),
        slug: slugify(niche.slug || niche.name),
        tagline: niche.tagline.slice(0, 200),
        thesis: niche.reasoning.slice(0, 800),
        targetCustomer: niche.targetCustomer.slice(0, 160),
        offer: niche.offer.slice(0, 300),
        priceCents: niche.priceCents,
        bullets: niche.bullets.slice(0, 5),
        // Evidence-backed but unvalidated: it is read off a real bio, and no
        // one has paid for it yet.
        confidence: 0.7,
        reasoning: niche.reasoning,
      },
    });

    if (!spawned.ok) {
      return json(
        {
          username,
          businessId: null,
          url: null,
          message: null,
          hire: null,
          ms: Date.now() - started,
          error: spawned.guardrailCode ? `${spawned.guardrailCode}: ${spawned.error}` : spawned.error,
        },
        { status: 409 },
      );
    }

    await personal.attributeBusiness(spawned.businessId!, {
      runId,
      username,
      bio: target.bio,
    });

    /*
     * Post the work the moment the storefront exists.
     *
     * The product is a subscription that has to deliver something every month,
     * and the thing it delivers is expert human time — so the listing is not a
     * later step, it is the other half of the product going live. Posting it
     * here means the marketplace opportunity and the page selling it are
     * created in the same breath, against the same price.
     *
     * Best-effort on purpose: Terac being slow or declining the economics is a
     * fact about this product's margin, not a reason to withhold a storefront
     * that is already deployed and taking payment. The decision is recorded
     * either way, and `hire` reports which it was.
     */
    const hire = await postListing({
      businessId: spawned.businessId!,
      productName: niche.name,
      role: 'consultant',
      deliverable:
        `Produce this month's "${niche.offer}" for subscribers to ${niche.name}. ` +
        `They are ${niche.targetCustomer}.`,
      expertProfile: `Practitioner with direct working experience in: ${niche.targetCustomer}`,
      productPriceCents: niche.priceCents,
      subscriberTarget: env.subscriberTarget,
      cycleId: runId,
    });

    /*
     * Write the opener now, while the site it quotes is fresh. Sending is a
     * separate press, so the message has to exist before that press in order to
     * be read on screen first — and the send path reuses this exact row rather
     * than asking the model again.
     */
    const prepared = await personal.draftFor(runId, username);

    return json({
      username,
      businessId: spawned.businessId,
      url: spawned.url,
      message: prepared?.draft.message ?? null,
      hire: {
        decision: hire.decision,
        reason: hire.reason,
        opportunityId: hire.opportunityId,
        dashboardUrl: hire.dashboardUrl,
        provider: hire.provider,
        targetPayoutCents: hire.targetPayoutCents,
        quotedCents: hire.quotedCents,
      },
      ms: Date.now() - started,
      error: null,
    });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}
