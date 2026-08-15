import { id, query } from './db';
import * as decisions from './decisions';
import { brain, type ToolSpec } from './brain';
import type { Segment } from './audience';

/**
 * Prospect outreach — researched, drafted, and held for a human to send.
 *
 * Foundry picks a small number of accounts from the audience that match a
 * segment, reads their public bio, and writes each a specific opener tied to
 * the product built for that segment.
 *
 * It does not send. X's Automation Rules prohibit automated DMs without prior
 * opt-in, and a follow-back is not opt-in — so the send button belongs to a
 * person. At ten prospects that is a two-minute review, and it keeps the
 * account out of suspension range. `approve()` marks a draft as sent once you
 * have actually sent it, so the record reflects reality rather than intent.
 */

export interface Draft {
  id: string;
  segment_id: string;
  business_id: string | null;
  username: string;
  bio: string;
  message: string;
  rationale: string;
  status: 'DRAFT' | 'APPROVED' | 'SENT' | 'REJECTED';
  created_at: string;
  sent_at: string | null;
}

const DRAFT_TOOL: ToolSpec = {
  name: 'write_openers',
  description: 'Write one short, specific outreach opener per prospect.',
  schema: {
    type: 'object',
    properties: {
      drafts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'The prospect handle you are writing to.' },
            message: {
              type: 'string',
              description:
                'The opening DM. HARD LIMIT 220 characters — this is a first message to a ' +
                'stranger, so it earns a reply or it gets ignored. One sentence on what it is, ' +
                'tied to what their bio says they do, and the price. No flattery, no "I came ' +
                'across your profile", no pitch stack, no bullet lists.',
            },
            rationale: {
              type: 'string',
              description: 'One sentence: why this person plausibly has this problem.',
            },
            fit: { type: 'number', description: '0-1: how well they actually match the segment.' },
          },
          required: ['username', 'message', 'rationale', 'fit'],
        },
      },
    },
    required: ['drafts'],
  },
};

const DRAFT_SYSTEM = `You write short outreach messages on behalf of FOUNDRY, which builds small
paid products for specific groups of people.

You are writing to someone whose public bio suggests they have the problem a product solves.
Write like a person who built something relevant, not like a sales sequence.

Rules:
- HARD LIMIT 220 characters. One idea. A first DM that scrolls is a first DM that is ignored.
- Reference what they actually do, from their bio, in concrete terms. Never invent facts about
  them, their company, their funding, or their traffic.
- No flattery openers. No "I noticed", "I came across", "Hope this finds you well".
- Say what it is and what it costs per month. Do not paste the link in the opener — offer it.
- Disclose that FOUNDRY is agent-operated. Do not hide it.
- If the person's bio does not actually suggest the problem, set fit low and say so in the
  rationale rather than writing a message that pretends otherwise.`;

export interface DraftResult {
  drafts: Draft[];
  model: string;
  decisionId: string;
}

/**
 * Writes an opener for each candidate. `limit` is deliberately small — this is
 * a shortlist you will read, not a campaign.
 */
export async function draftForSegment(
  segment: Segment,
  opts: { limit?: number; businessId?: string | null; productUrl?: string; cycleId?: string } = {},
): Promise<DraftResult> {
  const limit = Math.min(opts.limit ?? 10, 25);
  const cycleId = opts.cycleId ?? decisions.newCycleId();

  // Candidates are audience members whose bio matches the segment's keywords
  // and who have not been drafted for already.
  const candidates = await query<{ username: string; bio: string; followers: number }>(
    `SELECT m.username, m.bio, m.followers
       FROM audience_members m
      WHERE m.bio <> ''
        AND ($2::text[] = '{}' OR m.bio ~* ANY($2))
        AND NOT EXISTS (SELECT 1 FROM prospect_drafts d WHERE d.username = m.username)
      ORDER BY m.followers DESC
      LIMIT $1`,
    [limit, segment.keywords.length ? segment.keywords : []],
  );

  if (!candidates.length) {
    throw new Error('no un-contacted audience members match this segment');
  }

  const thinker = brain();
  let model = thinker.info.model;
  let written: { username?: string; message?: string; rationale?: string; fit?: number }[] = [];

  try {
    const out = await thinker.structured<{ drafts: typeof written }>({
      system: DRAFT_SYSTEM,
      prompt: [
        `Product: ${segment.proposed_offer}`,
        `Price: $${(segment.price_cents / 100).toFixed(2)} one-time`,
        opts.productUrl ? `Link: ${opts.productUrl}` : '',
        `Segment: ${segment.label} — ${segment.description}`,
        '',
        'Prospects:',
        ...candidates.map((c) => `@${c.username}: ${c.bio.replace(/\s+/g, ' ').slice(0, 200)}`),
        '',
        'Write one opener per prospect.',
      ]
        .filter(Boolean)
        .join('\n'),
      tool: DRAFT_TOOL,
      maxTokens: 3000,
    });
    written = out.value.drafts ?? [];
    model = out.model;
  } catch (err) {
    throw new Error(`could not draft openers: ${String(err).slice(0, 200)}`);
  }

  const saved: Draft[] = [];
  for (const d of written) {
    const match = candidates.find((c) => c.username === String(d.username ?? '').replace(/^@/, ''));
    if (!match) continue;
    const rows = await query<Draft>(
      `INSERT INTO prospect_drafts
         (id, segment_id, business_id, username, bio, message, rationale, fit, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT')
       ON CONFLICT (username) DO NOTHING
       RETURNING *`,
      [
        id('psp'),
        segment.id,
        opts.businessId ?? segment.business_id,
        match.username,
        match.bio.slice(0, 300),
        String(d.message ?? '').slice(0, 260),
        String(d.rationale ?? '').slice(0, 400),
        Math.min(1, Math.max(0, Number(d.fit ?? 0))),
      ],
    );
    if (rows[0]) saved.push(rows[0]);
  }

  const row = await decisions.record({
    cycleId,
    businessId: opts.businessId ?? segment.business_id,
    action: 'OUTREACH_DRAFTED',
    reasoning:
      `Wrote ${saved.length} outreach draft(s) for "${segment.label}". Sending is gated on the ` +
      'contact allowlist: an account that did not agree to be contacted cannot be messaged, ' +
      'which is what keeps these solicited rather than cold.',
    confidence: 0.7,
    model,
    inputs: { segmentId: segment.id, candidates: candidates.length, limit },
    outputs: { drafted: saved.length, usernames: saved.map((s) => s.username) },
  });

  return { drafts: saved, model, decisionId: row.id };
}

export async function drafts(status?: Draft['status']): Promise<Draft[]> {
  return status
    ? query<Draft>(`SELECT * FROM prospect_drafts WHERE status = $1 ORDER BY created_at DESC`, [status])
    : query<Draft>(`SELECT * FROM prospect_drafts ORDER BY created_at DESC LIMIT 100`);
}

/** Records that you actually sent it. Foundry never sets this on its own. */
export async function markSent(draftId: string): Promise<Draft | null> {
  const rows = await query<Draft>(
    `UPDATE prospect_drafts SET status = 'SENT', sent_at = now() WHERE id = $1 RETURNING *`,
    [draftId],
  );
  return rows[0] ?? null;
}

export async function reject(draftId: string, why: string): Promise<Draft | null> {
  const rows = await query<Draft>(
    `UPDATE prospect_drafts SET status = 'REJECTED', rationale = rationale || ' | rejected: ' || $2
      WHERE id = $1 RETURNING *`,
    [draftId, why.slice(0, 200)],
  );
  return rows[0] ?? null;
}
