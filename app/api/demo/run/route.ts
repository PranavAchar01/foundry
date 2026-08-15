import * as audience from '@/lib/audience';
import * as cohort from '@/lib/cohort';
import * as prospects from '@/lib/prospects';
import * as decisions from '@/lib/decisions';
import { hireForSegment } from '@/lib/hiring';
import { spawn } from '@/lib/spawn';
import { slugify } from '@/lib/agent';
import * as x from '@/lib/x';
import * as conversation from '@/lib/conversation';
import { env } from '@/lib/env';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The one-button run: find the client, build the business, staff it, reach out.
 *
 *   cluster the audience -> pick the strongest segment -> spawn the storefront
 *   -> hire the consultant at 75% of price -> follow + DM the people in it
 *
 * Every stage is the real one. The only thing narrowed for the demo is *who is
 * reachable*: `lib/cohort.ts` is an allowlist, and the follow/DM stage skips
 * anyone not on it, so a live run cannot message a stranger.
 */
export async function POST(req: Request) {
  const started = Date.now();
  const stages: { name: string; ms: number; detail: string }[] = [];
  const mark = (name: string, from: number, detail = '') =>
    stages.push({ name, ms: Date.now() - from, detail });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      sampleSize?: number;
      dryRun?: boolean;
      segmentId?: string;
    };
    const dryRun = body.dryRun === true;
    const cycleId = decisions.newCycleId();

    // --- 1. find the client ------------------------------------------------
    let t = Date.now();
    let segment;
    if (body.segmentId) {
      segment = await audience.segment(body.segmentId);
      if (!segment) return json({ error: 'unknown segment' }, { status: 404 });
      mark('cluster', t, 'reused an existing segment');
    } else {
      const clustered = await audience.cluster(Math.min(Number(body.sampleSize ?? 300), 1000));
      segment = clustered.segments.sort((a, b) => b.willingness - a.willingness)[0];
      if (!segment) return json({ error: 'clustering produced no segments' }, { status: 502 });
      mark('cluster', t, `${clustered.segments.length} segment(s), best: ${segment.label}`);
    }

    // --- 2. build the business for them ------------------------------------
    t = Date.now();
    let business: { id: string | null; url: string | null } = { id: null, url: null };
    if (segment.business_id) {
      business = { id: segment.business_id, url: null };
      mark('build', t, 'segment already has a business');
    } else {
      const spawned = await spawn({
        niche: segment.label,
        cycleId,
        hypothesis: {
          name: segment.label.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60),
          slug: slugify(segment.label),
          tagline: segment.proposed_offer.slice(0, 200),
          thesis: segment.reasoning.slice(0, 800),
          targetCustomer: segment.description.slice(0, 160),
          offer: segment.proposed_offer.slice(0, 300),
          priceCents: segment.price_cents,
          bullets: segment.keywords.slice(0, 5).map((k) => `Built for ${k}`),
          confidence: segment.willingness,
          reasoning: segment.reasoning,
        },
      });
      if (!spawned.ok) {
        return json(
          { error: spawned.error, guardrailCode: spawned.guardrailCode, stages },
          { status: 409 },
        );
      }
      business = { id: spawned.businessId, url: spawned.url };
      await audience.markStatus(segment.id, 'LAUNCHED', spawned.businessId!);
      mark('build', t, `${spawned.url}`);
    }

    // --- 3. staff it -------------------------------------------------------
    t = Date.now();
    const hire = await hireForSegment({
      segmentId: segment.id,
      businessId: business.id,
      role: `${segment.label} consultant`,
      deliverable: `Deliver "${segment.proposed_offer}" for a customer in: ${segment.description}`,
      expertProfile: `Practitioner with direct experience in: ${segment.keywords.join(', ')}`,
      productPriceCents: segment.price_cents,
      billing: 'subscription' as const,
      subscriberTarget: env.subscriberTarget,
      cycleId,
    }).catch((err) => ({
      decision: 'declined' as const,
      reason: `hiring unavailable: ${String(err).slice(0, 200)}`,
      listingId: '', code: 'HIRE_FAILED', targetPayoutCents: 0,
      quotedCents: null, opportunityId: null, provider: 'none', decisionId: '',
    }));
    mark('hire', t, `${hire.decision}: ${hire.reason.slice(0, 90)}`);

    // --- 4. write the openers ---------------------------------------------
    t = Date.now();
    const drafted = await prospects
      .draftForSegment(segment, {
        limit: 10,
        businessId: business.id,
        productUrl: business.url ?? undefined,
        cycleId,
      })
      .catch(() => ({ drafts: [], model: 'none', decisionId: '' }));
    mark('draft', t, `${drafted.drafts.length} opener(s)`);

    // --- 5. reach out, allowlist-gated ------------------------------------
    t = Date.now();
    const allowed = await cohort.list();
    const reach: { username: string; followed: boolean; dmSent: boolean; error: string | null }[] = [];

    if (!dryRun) {
      for (const member of allowed) {
        const draft =
          drafted.drafts.find((d) => d.username.toLowerCase() === member.username.toLowerCase()) ??
          drafted.drafts[0];
        if (!draft) break;

        // Belt and braces: re-check the allowlist immediately before writing.
        const gate = await cohort.isAllowed(member.username);
        if (!gate || !gate.x_user_id) {
          reach.push({
            username: member.username, followed: false, dmSent: false,
            error: gate ? 'no resolved X id' : 'not on the allowlist',
          });
          continue;
        }

        let followed = member.followed;
        if (!followed) {
          const f = await x.follow(gate.x_user_id);
          followed = f.ok;
          if (f.ok) await cohort.markFollowed(member.username);
        }

        const message = personalise(draft.message);
        const sent = await x.sendDm(gate.x_user_id, message);
        if (sent.ok) {
          await cohort.markDmSent(member.username);
          await prospects.markSent(draft.id);
          // Opening a conversation is what puts this person under the reply
          // agent: from here it answers what comes back until it closes.
          await conversation.open({
            username: member.username,
            xUserId: gate.x_user_id,
            businessId: business.id,
            segmentId: segment.id,
            text: message,
            externalId: sent.id,
          });
        }
        reach.push({
          username: member.username,
          followed,
          dmSent: sent.ok,
          error: sent.error,
        });
      }
    }
    mark('reach', t, dryRun ? 'dry run — nothing sent' : `${reach.filter((r) => r.dmSent).length} DM(s) sent`);

    await decisions.record({
      cycleId,
      businessId: business.id,
      action: 'CLIENT_RUN',
      reasoning:
        `Ran the client pipeline: segmented the audience, picked "${segment.label}" ` +
        `(willingness ${segment.willingness.toFixed(2)}), built a storefront at ${business.url ?? 'n/a'}, ` +
        `${hire.decision === 'posted' ? 'hired a consultant' : `did not hire — ${hire.reason.slice(0, 120)}`}, ` +
        `wrote ${drafted.drafts.length} opener(s), and reached ${reach.filter((r) => r.dmSent).length} ` +
        `of ${allowed.length} allowlisted account(s).`,
      confidence: segment.willingness,
      model: 'ceo',
      inputs: { segmentId: segment.id, dryRun, allowlisted: allowed.length },
      outputs: { business, hire: { decision: hire.decision, reason: hire.reason }, reach, stages },
    });

    return json({
      elapsedMs: Date.now() - started,
      stages,
      segment: {
        id: segment.id, label: segment.label, description: segment.description,
        willingness: segment.willingness, reasoning: segment.reasoning,
        priceCents: segment.price_cents,
      },
      business,
      hire: {
        decision: hire.decision, reason: hire.reason,
        targetPayoutCents: hire.targetPayoutCents, quotedCents: hire.quotedCents,
        payoutShare: env.laborPayoutShare,
      },
      drafts: drafted.drafts.map((d) => ({
        username: d.username, message: d.message, rationale: d.rationale,
      })),
      reach,
      dryRun,
    });
  } catch (err) {
    return json({ error: errorMessage(err), stages }, { status: 500 });
  }
}

/**
 * The opener stays short on purpose — no appended link. The link is what the
 * agent offers once someone replies, which is what makes the first message read
 * as an opening rather than a broadcast.
 */
function personalise(message: string): string {
  return message.slice(0, 260);
}
