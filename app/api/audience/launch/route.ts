import * as audience from '@/lib/audience';
import { hireForSegment } from '@/lib/hiring';
import { spawn } from '@/lib/spawn';
import * as decisions from '@/lib/decisions';
import { slugify } from '@/lib/agent';
import { env } from '@/lib/env';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Turns one identified segment into a running business.
 *
 *   segment -> storefront (spawn) -> paid listing for the human who delivers it
 *
 * The hire is priced from the product, not the other way round: a segment that
 * cannot support a consultant at the configured payout share is one the system
 * declines to staff, and it says so with the arithmetic.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      segmentId?: string;
      role?: string;
      payoutShare?: number;
      hire?: boolean;
    };
    const segmentId = String(body.segmentId ?? '');
    if (!segmentId) return json({ error: 'segmentId is required' }, { status: 400 });

    const seg = await audience.segment(segmentId);
    if (!seg) return json({ error: 'unknown segment' }, { status: 404 });
    if (seg.status === 'LAUNCHED') {
      return json({ error: 'segment already launched', businessId: seg.business_id }, { status: 409 });
    }

    const cycleId = decisions.newCycleId();
    await audience.markStatus(segmentId, 'BUILDING');

    // 1. Build the storefront for the segment's proposed offer.
    const spawned = await spawn({
      niche: seg.label,
      cycleId,
      hypothesis: {
        name: seg.label.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60),
        slug: slugify(seg.label),
        tagline: seg.proposed_offer.slice(0, 200),
        thesis: seg.reasoning.slice(0, 800),
        targetCustomer: seg.description.slice(0, 160),
        offer: seg.proposed_offer.slice(0, 300),
        priceCents: seg.price_cents,
        bullets: seg.keywords.slice(0, 5).map((k) => `Built for ${k}`),
        confidence: seg.willingness,
        reasoning: seg.reasoning,
      },
    });

    if (!spawned.ok) {
      await audience.markStatus(segmentId, 'IDENTIFIED');
      return json(
        { error: spawned.error, guardrailCode: spawned.guardrailCode, segmentId },
        { status: 409 },
      );
    }

    await audience.markStatus(segmentId, 'LAUNCHED', spawned.businessId!);

    // 2. Hire the human who delivers it, priced off the product.
    let hire = null;
    if (body.hire !== false) {
      hire = await hireForSegment({
        segmentId,
        businessId: spawned.businessId,
        role: body.role ?? `${seg.label} consultant`,
        deliverable:
          `Deliver the engagement behind "${seg.proposed_offer}" for a customer in this segment: ` +
          `${seg.description}`,
        expertProfile: `Practitioner with direct experience in: ${seg.keywords.join(', ')}`,
        productPriceCents: seg.price_cents,
        payoutShare: body.payoutShare,
        cycleId,
      });
    }

    return json({
      segment: { id: seg.id, label: seg.label, willingness: seg.willingness },
      business: {
        id: spawned.businessId,
        url: spawned.url,
        priceCents: seg.price_cents,
        elapsedMs: spawned.elapsedMs,
      },
      hire,
      payoutShare: body.payoutShare ?? env.laborPayoutShare,
    });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
