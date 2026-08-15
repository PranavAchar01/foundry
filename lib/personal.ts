import { env } from './env';
import { id, one, query } from './db';
import { brain, type ToolSpec } from './brain';
import { slugify } from './agent';
import type { BusinessRow } from './businesses';
import type { Draft } from './prospects';

/**
 * The per-person pipeline.
 *
 * `lib/audience.ts` deliberately refuses to reason about individuals: it groups
 * an anonymised corpus of bios into markets, because one person is a consulting
 * gig and forty are a business. This module is the other half of that trade,
 * and it is only lawful because of the allowlist — every person it reads has
 * agreed to be contacted, and `lib/cohort.ts` is checked before anything is
 * written to them. Inside that consent boundary, building for one named person
 * is the more useful analysis: the recurring chore in their work is legible in
 * their own bio, and a product aimed at it does not have to be averaged across
 * a segment first.
 *
 * The bio is the entire evidence base. Nothing here infers, enriches, or stores
 * anything about a person beyond the public text they wrote about themselves.
 */

export interface Person {
  username: string;
  bio: string;
}

export interface Niche {
  name: string;
  slug: string;
  tagline: string;
  targetCustomer: string;
  offer: string;
  priceCents: number;
  bullets: string[];
  reasoning: string;
}

export interface PlannedTarget {
  username: string;
  bio: string;
  /** Short, human-readable "why them" — the evidence, not a compliment. */
  evidence: string;
  niche: Niche;
}

/** The decision action /plan writes and /build reads its plan back from. */
export const PLAN_ACTION = 'PERSON_RUN_PLANNED';

// ---------------------------------------------------------------------------
// 1. The niche — one person's bio in, one recurring product out
// ---------------------------------------------------------------------------

const NICHE_TOOL: ToolSpec = {
  name: 'design_micro_business',
  description:
    'Design one recurring micro-product for the single person whose public bio you were given.',
  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Product name. 1-4 words, no generic filler, and never the person\'s handle.',
      },
      slug: { type: 'string', description: 'lowercase-hyphenated, max 30 chars, no spaces' },
      tagline: {
        type: 'string',
        description: 'One line: what arrives, and how often. Under 90 characters.',
      },
      targetCustomer: {
        type: 'string',
        description:
          'The recurring chore in THEIR work that this removes, written in the vocabulary their ' +
          'own bio uses.',
      },
      offer: {
        type: 'string',
        description:
          'What actually lands, each period. A deliverable with a shape and a cadence, not a category.',
      },
      priceCents: {
        type: 'integer',
        description:
          'RECURRING price in cents per month. Hard ceiling 500 ($5.00). Price it so someone ' +
          'subscribes without thinking about it.',
      },
      bullets: {
        type: 'array',
        items: { type: 'string' },
        description: '3-5 short storefront lines. Each is a specific thing the subscription does.',
      },
      reasoning: {
        type: 'string',
        description:
          'The words in the bio you keyed on, the recurring chore you inferred from them, why ' +
          'this person is still paying in month three, and what would falsify it. 3-6 sentences.',
      },
    },
    required: [
      'name', 'slug', 'tagline', 'targetCustomer',
      'offer', 'priceCents', 'bullets', 'reasoning',
    ],
  },
};

const NICHE_SYSTEM = `You design one small recurring product for one person, working only from the
public bio they wrote about themselves.

Rules that matter:
- The bio is the entire evidence base. Never invent a company, a role, a raise, a headcount, a
  launch, or a project it does not state. If the bio is thin, build for the one thing it does
  say and admit the thinness in your reasoning rather than filling the gap.
- Find the RECURRING CHORE inside the work the bio describes — the task that comes back every
  week whether or not they have time for it. That chore is the product. "AI tools" is not a
  niche. "A weekly changelog digest for people shipping agent tooling" is.
- It is a subscription at or under $5.00 per month and it has to earn the second month. Say what
  arrives on a schedule. A one-off download with a monthly invoice attached is not a subscription.
- No product that gives medical, legal, or financial advice. Nothing aimed at minors.
- Build it as a product, not a favour. It is derived from their work, not addressed to them: no
  product named after them, no copy that speaks to them by name. Someone else doing the same job
  should want it too.`;

interface RawNiche {
  name?: string;
  slug?: string;
  tagline?: string;
  targetCustomer?: string;
  offer?: string;
  priceCents?: number;
  bullets?: string[];
  reasoning?: string;
}

/**
 * Reads one person's bio and returns the product to build for them.
 *
 * Never throws: a run of eight of these is on the critical path of a live demo,
 * and one unavailable model must degrade that person's tile rather than take
 * the whole run down. The fallback marks itself as a fallback in `reasoning`,
 * so a placeholder can never be mistaken for a judgement.
 */
export async function deriveNiche(person: Person): Promise<Niche> {
  const bio = trim(person.bio, 500);
  try {
    const out = await brain().structured<RawNiche>({
      system: NICHE_SYSTEM,
      prompt: [
        `Handle: @${person.username}`,
        `Public bio: ${bio || '(this account has no public bio)'}`,
        '',
        'Design the one recurring product this person would still be paying for in month three.',
      ].join('\n'),
      tool: NICHE_TOOL,
      maxTokens: 1600,
    });
    return normalise(out.value, person);
  } catch {
    return heuristicNiche(person);
  }
}

function normalise(raw: RawNiche, person: Person): Niche {
  const base = heuristicNiche(person);
  const name = trim(raw.name, 60) || base.name;
  const bullets = (raw.bullets ?? []).map((b) => trim(b, 90)).filter(Boolean).slice(0, 5);
  return {
    name,
    slug: slugify(trim(raw.slug, 30) || name),
    tagline: trim(raw.tagline, 200) || base.tagline,
    targetCustomer: trim(raw.targetCustomer, 160) || base.targetCustomer,
    offer: trim(raw.offer, 300) || base.offer,
    // The ceiling is the product decision, not a suggestion: a recurring price
    // above it is not the business this company is in.
    priceCents: Math.min(
      env.maxPriceCents,
      Math.max(100, Math.round(Number(raw.priceCents ?? env.maxPriceCents))),
    ),
    bullets: bullets.length ? bullets : base.bullets,
    reasoning: trim(raw.reasoning, 2000) || base.reasoning,
  };
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'here', 'they', 'them', 'your',
  'about', 'also', 'into', 'just', 'like', 'more', 'most', 'over', 'some', 'than', 'then',
  'building', 'builder', 'making', 'people', 'things', 'stuff', 'working', 'previously',
]);

/**
 * The deterministic stand-in, in the same spirit as heuristicSegments(): raw
 * text, no judgement, and it says so. With a single bio there is no frequency
 * to count, so it keys on the longest content word — the one most likely to be
 * the specific thing the person does rather than the connective tissue.
 */
function heuristicNiche(person: Person): Niche {
  const words = (person.bio.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w));
  const topic = words.reduce((best, w) => (w.length > best.length ? w : best), '') || 'independent work';
  const Topic = topic.charAt(0).toUpperCase() + topic.slice(1);

  return {
    name: `${Topic} Monday`,
    slug: slugify(`${topic}-monday`),
    tagline: `A Monday brief for people working on ${topic}.`,
    targetCustomer: `Someone whose public bio puts their work in ${topic}.`,
    offer:
      `Every Monday: what moved in ${topic} last week in five lines, and the one thing worth ` +
      'doing about it this week.',
    priceCents: env.maxPriceCents,
    bullets: [
      `Five lines on ${topic}, every Monday`,
      'One concrete action, not a link dump',
      'Cancel from inside the first email',
    ],
    reasoning:
      'Heuristic fallback: the model was unavailable, so this is keyed on the most distinctive ' +
      `word in @${person.username}'s public bio ("${topic}") rather than a reading of what they ` +
      'actually do. It is a placeholder, not a judgement about willingness to pay.',
  };
}

// ---------------------------------------------------------------------------
// 2. Run state — the plan, and which business belongs to whom
// ---------------------------------------------------------------------------

/**
 * The plan for one person, read back out of the run's decision row.
 *
 * /plan and /build are separate requests so each stays well under the function
 * timeout and the tiles can appear one at a time. That means the plan has to
 * outlive a request, and the decision log is already the durable, append-only
 * record of what the run decided — so it is the plan, rather than something
 * that shadows it and can disagree with it.
 */
export async function plannedTarget(runId: string, username: string): Promise<PlannedTarget | null> {
  const row = await one<{ outputs: { targets?: PlannedTarget[] } }>(
    `SELECT outputs FROM decisions WHERE cycle_id = $1 AND action = $2
      ORDER BY created_at DESC LIMIT 1`,
    [runId, PLAN_ACTION],
  );
  const handle = username.replace(/^@/, '').toLowerCase();
  return (row?.outputs.targets ?? []).find((t) => t.username.toLowerCase() === handle) ?? null;
}

/** The business this run built for this person, or null if it has not yet. */
export async function businessFor(runId: string, username: string): Promise<BusinessRow | null> {
  return one<BusinessRow>(
    `SELECT * FROM businesses
      WHERE lower(prospect_username) = lower($1) AND meta->>'runId' = $2 AND NOT archived
      ORDER BY created_at DESC LIMIT 1`,
    [username.replace(/^@/, ''), runId],
  );
}

/**
 * Marks a freshly spawned business as this person's.
 *
 * The run id goes into `meta` because it is what makes /build idempotent: a
 * second call for the same person in the same run finds this row and returns
 * it instead of spawning a twin, while a later run still gets to build fresh.
 */
export async function attributeBusiness(
  businessId: string,
  opts: { runId: string; username: string; bio: string },
): Promise<void> {
  await query(
    `UPDATE businesses
        SET prospect_username = $2,
            prospect_bio      = $3,
            meta              = meta || jsonb_build_object('runId', $4::text),
            updated_at        = now()
      WHERE id = $1`,
    [businessId, opts.username.replace(/^@/, ''), trim(opts.bio, 500), opts.runId],
  );
}

// ---------------------------------------------------------------------------
// 3. The opener
// ---------------------------------------------------------------------------

const OPENER_TOOL: ToolSpec = {
  name: 'write_opener',
  description: 'Write the first DM to one person about the product built for their work.',
  schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'The opening DM. HARD LIMIT 220 characters. One sentence on what was built for them ' +
          'and the chore it removes, then the monthly price. No link, no bullet lists, no pitch stack.',
      },
      rationale: {
        type: 'string',
        description: 'One sentence: the line in their bio this product is answering.',
      },
    },
    required: ['message', 'rationale'],
  },
};

const OPENER_SYSTEM = `You write the first DM on behalf of FOUNDRY, an agent-operated company that has
already built and deployed one small product for the person you are writing to.

Rules:
- HARD LIMIT 220 characters. One idea. A first DM that scrolls is a first DM that is ignored.
- Lead with the thing that exists and the recurring chore it takes off them, in the vocabulary of
  their own bio. Never invent facts about them or their work.
- Say the monthly price. Do NOT paste the link — offer it, so replying is the next move.
- Disclose that FOUNDRY is agent-operated. Do not hide it.
- No flattery openers. No "I noticed", "I came across", "Hope this finds you well".`;

export interface Product {
  id: string;
  name: string;
  tagline: string;
  priceCents: number;
}

/**
 * The opener for this person in this run, written once and then reused.
 *
 * `openerFor` asks the model afresh every call, so generating at build time and
 * again at send time would show one message on screen and put a different one
 * in the DM. The draft is written when the business is built and the send path
 * reads that same row back, which is what makes the message you approve the
 * message that goes out.
 */
export async function draftFor(
  runId: string,
  username: string,
): Promise<{ draft: Draft; model: string; business: BusinessRow } | null> {
  const business = await businessFor(runId, username);
  if (!business) return null;

  const existing = await one<Draft>(
    `SELECT * FROM prospect_drafts
      WHERE lower(username) = lower($1) AND business_id = $2 AND status <> 'SENT'
      ORDER BY created_at DESC LIMIT 1`,
    [username.replace(/^@/, ''), business.id],
  );
  if (existing) return { draft: existing, model: 'reused-draft', business };

  const written = await openerFor({
    person: { username: business.prospect_username || username, bio: business.prospect_bio },
    business: {
      id: business.id,
      name: business.name,
      tagline: business.tagline,
      priceCents: business.price_cents,
    },
  });
  return { ...written, business };
}

/**
 * Writes a fresh opener and puts it on the record before it is sent.
 *
 * Private on purpose: every caller wants `draftFor`, which reuses what is
 * already drafted. Reaching past it asks the model again, and the message on
 * screen stops being the message that goes out.
 *
 * The draft row is written first and only marked SENT once X has accepted the
 * message, so what the log says was sent is what actually left.
 */
async function openerFor(opts: {
  person: Person;
  business: Product;
}): Promise<{ draft: Draft; model: string }> {
  const bio = trim(opts.person.bio, 500);
  const price = `$${(opts.business.priceCents / 100).toFixed(2)}`;

  let message = heuristicOpener(opts.business);
  let rationale =
    'Heuristic fallback: the model was unavailable, so this is the product line rather than a ' +
    'reading of their bio.';
  let model = 'heuristic-fallback';

  try {
    const out = await brain().structured<{ message?: string; rationale?: string }>({
      system: OPENER_SYSTEM,
      prompt: [
        `Writing to: @${opts.person.username}`,
        `Their public bio: ${bio || '(this account has no public bio)'}`,
        `Built for them: ${opts.business.name} — ${opts.business.tagline}`,
        `Price: ${price} per month, recurring`,
        '',
        'Write the opening DM.',
      ].join('\n'),
      tool: OPENER_TOOL,
      maxTokens: 700,
    });
    const written = trim(out.value.message, 220);
    if (written) {
      message = written;
      rationale = trim(out.value.rationale, 400);
      model = out.model;
    }
  } catch {
    // Keep the deterministic opener. A model outage should cost the phrasing,
    // not the outreach.
  }

  /*
   * One draft per handle is the table's rule, and the allowlist is small enough
   * that a second demo run reaches the same people. The latest opener wins and
   * the send state resets with it, so the row describes the run you are
   * watching rather than the one before it.
   */
  const rows = await query<Draft>(
    `INSERT INTO prospect_drafts
       (id, segment_id, business_id, username, bio, message, rationale, fit, status)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, 'DRAFT')
     ON CONFLICT (username) DO UPDATE SET
       business_id = EXCLUDED.business_id,
       bio         = EXCLUDED.bio,
       message     = EXCLUDED.message,
       rationale   = EXCLUDED.rationale,
       fit         = EXCLUDED.fit,
       status      = 'DRAFT',
       sent_at     = NULL
     RETURNING *`,
    [
      id('psp'),
      opts.business.id,
      opts.person.username.replace(/^@/, ''),
      bio.slice(0, 300),
      message,
      rationale,
      // Fit is 1 by construction here, not by judgement: the product was
      // derived from this person's own bio rather than matched against them.
      1,
    ],
  );

  return { draft: rows[0], model };
}

function heuristicOpener(business: Product): string {
  const price = `$${(business.priceCents / 100).toFixed(2)}/mo`;
  return trim(
    `Built you ${trim(business.name, 40)} — ${trim(business.tagline, 90)}. ${price}. ` +
      'FOUNDRY is agent-operated; no human wrote this. Want the link?',
    220,
  );
}

// ---------------------------------------------------------------------------

function trim(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
