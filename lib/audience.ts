import { env } from './env';
import { id, query } from './db';
import * as decisions from './decisions';
import { brain, type ToolSpec } from './brain';
import * as x from './x';

/**
 * Audience intelligence: turn a real following list into segments worth
 * building for.
 *
 * The unit of analysis is deliberately the **segment**, not the person. A
 * segment is a market — "founders shipping AI research tooling, ~40 accounts,
 * these recurring words" — and a market is what you can build a product for.
 * Individual accounts are stored only as the public bio text that produced the
 * clustering, and are never assembled into a profile of a named person or used
 * to target one. That is both the ethical line and the more useful analysis:
 * one person is a consulting gig, forty are a business.
 */

export interface Segment {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  member_count: number;
  willingness: number;
  reasoning: string;
  proposed_offer: string;
  price_cents: number;
  business_id: string | null;
  status: 'IDENTIFIED' | 'BUILDING' | 'LAUNCHED' | 'DISCARDED';
  created_at: string;
}

// ---------------------------------------------------------------------------
// 1. Sync — read the audience
// ---------------------------------------------------------------------------

export interface SyncResult {
  fetched: number;
  stored: number;
  total: number;
  nextToken: string | null;
  error: string | null;
}

/**
 * Pulls one page of the following list. Paged on purpose: X's read quota is the
 * scarce resource here, and a full graph walk would spend a month of Basic-tier
 * budget in a single call.
 */
export async function sync(
  actor: x.XActor,
  pageSize = 100,
  pageToken?: string,
): Promise<SyncResult> {
  const page = await x.following(actor, pageSize, pageToken);
  if (page.error) {
    return { fetched: 0, stored: 0, total: await x.audienceSize(), nextToken: null, error: page.error };
  }
  const stored = await x.storeProfiles(page.profiles);
  return {
    fetched: page.profiles.length,
    stored,
    total: await x.audienceSize(),
    nextToken: page.nextToken,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// 2. Cluster — find the segments
// ---------------------------------------------------------------------------

const SEGMENT_TOOL: ToolSpec = {
  name: 'propose_segments',
  description:
    'Group an audience into commercially distinct segments and judge which would pay for a product.',
  schema: {
    type: 'object',
    properties: {
      segments: {
        type: 'array',
        description: '3-6 segments. Each must be a market, not an individual.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short name for the segment, 2-5 words.' },
            description: {
              type: 'string',
              description: 'Who these people are and what they are working on, in aggregate.',
            },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: 'Bio words that define membership.',
            },
            memberCount: { type: 'integer', description: 'Roughly how many of the sampled accounts fit.' },
            willingness: {
              type: 'number',
              description: '0-1: how likely this segment is to pay for a product, and why you think so.',
            },
            reasoning: {
              type: 'string',
              description:
                'Your actual reasoning: the evidence in the bios, what pain they have, what would falsify this. 3-6 sentences.',
            },
            proposedOffer: {
              type: 'string',
              description: 'The concrete thing to sell them. A deliverable, not a category.',
            },
            priceCents: {
              type: 'integer',
              description:
                'RECURRING price in cents per month. Hard ceiling 500 ($5.00). This is a ' +
                'low-priced subscription, not a one-off — price it so a working person ' +
                'subscribes without thinking about it.',
            },
          },
          required: [
            'label', 'description', 'keywords', 'memberCount',
            'willingness', 'reasoning', 'proposedOffer', 'priceCents',
          ],
        },
      },
    },
    required: ['segments'],
  },
};

const SEGMENT_SYSTEM = `You are FOUNDRY's audience analyst. You are given the public bios of accounts
someone follows on X, and you group them into segments that could be sold to.

Rules that matter:
- A segment is a MARKET, never a person. Never single out, name, or design around one account.
- Judge willingness to pay from evidence in the bios — role seniority, whether they run something
  with a budget, whether the work implies a recurring painful task. Say what would falsify it.
- Every offer is a RECURRING subscription priced at or under $5.00 per month. Propose something
  with a reason to keep paying each month — a recurring drop, an updated feed, an ongoing check —
  not a one-off download dressed up as a subscription.
- Offers can be delivered as a digital artifact plus, where useful, expert human time.
- No segment built around medical, legal, or financial advice. Nothing aimed at minors.

Be specific and falsifiable. "Technical people" is not a segment. "Solo founders shipping ML tooling
who write their own launch copy" is.`;

export interface ClusterResult {
  segments: Segment[];
  sampled: number;
  model: string;
  fromModel: boolean;
  decisionId: string;
}

/**
 * Write down who actually landed in each segment.
 *
 * The clustering model is shown bios with the handles stripped, so it returns
 * segments in aggregate and never says who went where — and its own memberCount
 * is an estimate it was asked to guess. Re-matching every stored bio against the
 * keywords it keyed on turns membership into something the database can answer,
 * and makes member_count a count rather than a claim.
 *
 * Members matching nothing are left unassigned rather than forced into the
 * nearest segment: "no segment fits this person" is a real answer.
 */
export async function assign(segments: Segment[]): Promise<{ assigned: number; scanned: number }> {
  if (!segments.length) return { assigned: 0, scanned: 0 };

  const members = await query<{ id: string; bio: string }>(
    `SELECT id, bio FROM audience_members WHERE bio <> ''`,
  );
  const prepared = segments.map((s) => ({
    id: s.id,
    terms: (s.keywords ?? []).map((k) => k.toLowerCase().trim()).filter((k) => k.length > 2),
  }));

  const ids: string[] = [];
  const segs: string[] = [];
  let assigned = 0;

  for (const m of members) {
    const bio = m.bio.toLowerCase();
    let best: { id: string; score: number } | null = null;
    for (const s of prepared) {
      let score = 0;
      for (const t of s.terms) if (bio.includes(t)) score++;
      if (score > 0 && (!best || score > best.score)) best = { id: s.id, score };
    }
    ids.push(m.id);
    // Empty means unassigned — the same pass clears memberships left behind by
    // an earlier clustering run, so no member points at a stale segment.
    segs.push(best?.id ?? '');
    if (best) assigned++;
  }

  if (ids.length) {
    await query(
      `UPDATE audience_members m SET segment_id = NULLIF(v.seg, '')
         FROM (SELECT unnest($1::text[]) AS mid, unnest($2::text[]) AS seg) v
        WHERE m.id = v.mid`,
      [ids, segs],
    );
  }

  await query(
    `UPDATE audience_segments s
        SET member_count = (SELECT count(*) FROM audience_members m WHERE m.segment_id = s.id)`,
  );

  return { assigned, scanned: members.length };
}

export async function cluster(sampleSize = 300): Promise<ClusterResult> {
  const members = await query<{ username: string; bio: string; followers: number }>(
    `SELECT username, bio, followers FROM audience_members
      WHERE bio <> '' ORDER BY followers DESC LIMIT $1`,
    [sampleSize],
  );

  if (!members.length) {
    throw new Error('no audience stored — run /api/audience/sync first');
  }

  // Bios only, no handles: the model is grouping descriptions of work, and
  // withholding identity keeps it from reasoning about individuals.
  const corpus = members.map((m) => `- ${m.bio.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');

  const cycleId = decisions.newCycleId();
  const thinker = brain();
  let model = thinker.info.model;
  let fromModel = true;
  let proposed: { segments: RawSegment[] } = { segments: [] };

  try {
    const out = await thinker.structured<{ segments: RawSegment[] }>({
      system: SEGMENT_SYSTEM,
      prompt: `Here are ${members.length} public bios from one person's X following list.\n\n${corpus}\n\nGroup them into the segments most worth building a product for.`,
      tool: SEGMENT_TOOL,
      maxTokens: 3000,
    });
    proposed = out.value;
    model = out.model;
  } catch (err) {
    fromModel = false;
    model = 'heuristic-fallback';
    proposed = { segments: heuristicSegments(members) };
    void err;
  }

  const saved: Segment[] = [];
  for (const s of proposed.segments ?? []) {
    const rows = await query<Segment>(
      `INSERT INTO audience_segments
         (id, label, description, keywords, member_count, willingness, reasoning, proposed_offer, price_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        id('seg'),
        String(s.label ?? 'unnamed').slice(0, 120),
        String(s.description ?? '').slice(0, 1000),
        (s.keywords ?? []).map(String).slice(0, 12),
        Math.max(0, Number(s.memberCount ?? 0)),
        Math.min(1, Math.max(0, Number(s.willingness ?? 0))),
        String(s.reasoning ?? '').slice(0, 2000),
        String(s.proposedOffer ?? '').slice(0, 500),
        Math.min(env.maxPriceCents, Math.max(100, Math.round(Number(s.priceCents ?? env.maxPriceCents)))),
      ],
    );
    saved.push(rows[0]);
  }

  const membership = await assign(saved);
  const withCounts = saved.length
    ? await query<Segment>(
        `SELECT * FROM audience_segments WHERE id = ANY($1::text[]) ORDER BY member_count DESC`,
        [saved.map((s) => s.id)],
      )
    : [];

  const row = await decisions.record({
    cycleId,
    action: 'AUDIENCE_CLUSTERED',
    reasoning:
      `Grouped ${members.length} sampled bios into ${saved.length} segment(s): ` +
      withCounts.map((s) => `${s.label} (${s.member_count}, willingness ${s.willingness.toFixed(2)})`).join('; ') +
      `. ${membership.assigned} of ${membership.scanned} stored bios matched a segment's keywords; ` +
      'the rest were left unassigned. Segments are markets, not individuals — no account was ' +
      'profiled or targeted.',
    confidence: 0.7,
    model,
    inputs: { sampled: members.length },
    outputs: {
      segments: withCounts.map((s) => ({ id: s.id, label: s.label, willingness: s.willingness, members: s.member_count })),
      modelSourced: fromModel,
      membership,
    },
  });

  return { segments: withCounts, sampled: members.length, model, fromModel, decisionId: row.id };
}

interface RawSegment {
  label?: string;
  description?: string;
  keywords?: string[];
  memberCount?: number;
  willingness?: number;
  reasoning?: string;
  proposedOffer?: string;
  priceCents?: number;
}

/** Word-frequency grouping, used only when the model is unavailable. */
function heuristicSegments(members: { bio: string }[]): RawSegment[] {
  const stop = new Set([
    'the','and','for','with','that','this','from','have','are','you','your','our','all','can',
    'building','builder','make','making','love','world','people','things','stuff','work','working',
  ]);
  const counts = new Map<string, number>();
  for (const m of members) {
    for (const w of new Set(m.bio.toLowerCase().match(/[a-z]{4,}/g) ?? [])) {
      if (!stop.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  return top.map(([word, n]) => ({
    label: `${word} accounts`,
    description: `Accounts whose bio mentions "${word}".`,
    keywords: [word],
    memberCount: n,
    willingness: 0.3,
    reasoning:
      'Heuristic fallback: the model was unavailable, so this is raw bio word frequency, ' +
      'not a judgement about willingness to pay. Treat it as a starting point only.',
    proposedOffer: `A practical toolkit for people working on ${word}.`,
    priceCents: env.maxPriceCents,
  }));
}

// ---------------------------------------------------------------------------

export async function segments(status?: Segment['status']): Promise<Segment[]> {
  return status
    ? query<Segment>(`SELECT * FROM audience_segments WHERE status = $1 ORDER BY willingness DESC`, [status])
    : query<Segment>(`SELECT * FROM audience_segments ORDER BY willingness DESC, created_at DESC`);
}

export async function segment(segmentId: string): Promise<Segment | null> {
  const rows = await query<Segment>(`SELECT * FROM audience_segments WHERE id = $1`, [segmentId]);
  return rows[0] ?? null;
}

export async function markStatus(segmentId: string, status: Segment['status'], businessId?: string) {
  await query(
    `UPDATE audience_segments SET status = $2, business_id = COALESCE($3, business_id), updated_at = now()
      WHERE id = $1`,
    [segmentId, status, businessId ?? null],
  );
}

export { env as audienceEnv };
