import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';

/**
 * The brain. Claude decides what to launch and what to kill; everything else in
 * this codebase is plumbing around those two judgements.
 *
 * Structured output comes from a forced tool call rather than JSON-in-prose, so
 * a malformed response is an API error instead of a parse bug. When the API
 * genuinely fails, callers get a clearly-marked heuristic result — the decision
 * row records `model: 'heuristic-fallback'` so the audit trail never claims a
 * reasoning came from the model when it did not.
 */

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) {
    if (!env.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2 });
  }
  return client;
}

export const HEURISTIC = 'heuristic-fallback';

interface ToolCallResult<T> {
  value: T;
  model: string;
  /** True when the model answered; false when the heuristic fallback ran. */
  fromModel: boolean;
  error?: string;
}

async function callTool<T>(
  system: string,
  prompt: string,
  tool: { name: string; description: string; input_schema: Anthropic.Tool.InputSchema },
  fallback: () => T,
  maxTokens = 1600,
): Promise<ToolCallResult<T>> {
  try {
    const res = await anthropic().messages.create({
      model: env.model,
      max_tokens: maxTokens,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: prompt }],
    });

    const block = res.content.find((c) => c.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('model returned no tool_use block');
    return { value: block.input as T, model: res.model, fromModel: true };
  } catch (err) {
    return {
      value: fallback(),
      model: HEURISTIC,
      fromModel: false,
      error: String(err instanceof Error ? err.message : err).slice(0, 300),
    };
  }
}

// ---------------------------------------------------------------------------
// Hypothesis generation
// ---------------------------------------------------------------------------

export interface Hypothesis {
  name: string;
  slug: string;
  tagline: string;
  thesis: string;
  targetCustomer: string;
  offer: string;
  priceCents: number;
  bullets: string[];
  confidence: number;
  reasoning: string;
}

const HYPOTHESIS_TOOL: {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
} = {
  name: 'propose_business',
  description: 'Propose one concrete, immediately-launchable digital micro-business.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Product name. 1-4 words, no generic filler.' },
      slug: { type: 'string', description: 'lowercase-hyphenated, max 30 chars, no spaces' },
      tagline: { type: 'string', description: 'One sentence. What it does and for whom.' },
      thesis: { type: 'string', description: 'Why this can make money in the next hour.' },
      targetCustomer: { type: 'string', description: 'Who pays. Be specific about the role.' },
      offer: { type: 'string', description: 'The concrete deliverable the buyer receives.' },
      priceCents: { type: 'integer', description: 'One-time price in cents, 900-9900.' },
      bullets: {
        type: 'array',
        items: { type: 'string' },
        description: '3-5 short benefit bullets, max 70 chars each.',
      },
      confidence: { type: 'number', description: '0-1 confidence that this converts at all.' },
      reasoning: {
        type: 'string',
        description:
          'Your actual reasoning: why this niche, why this price, what would falsify it. 3-6 sentences.',
      },
    },
    required: [
      'name', 'slug', 'tagline', 'thesis', 'targetCustomer',
      'offer', 'priceCents', 'bullets', 'confidence', 'reasoning',
    ],
  },
};

const CEO_SYSTEM = `You are the CEO of FOUNDRY, an autonomous holding company with no employees.
You spawn digital micro-businesses, fund them from a fixed portfolio budget, read their P&L,
and kill the ones that do not convert. You are ruthless about capital and honest about evidence.

Constraints you must respect:
- Businesses are single-page digital products sold once, via Stripe checkout, at $9-$99.
- No business may make medical, legal, or financial claims, or target minors.
- Every page you spawn carries a visible disclosure that it is AI-operated.
- You have a hard portfolio budget. Spending is a decision, not a default.

Write reasoning the way an operator writes it: specific, falsifiable, and short.`;

export async function proposeHypothesis(
  niche: string,
  context: { existing: string[]; remainingBudgetUsd: number },
): Promise<ToolCallResult<Hypothesis>> {
  const prompt = [
    `Niche to attack: ${niche}`,
    context.existing.length
      ? `Already in the portfolio (do not duplicate): ${context.existing.join(', ')}`
      : 'The portfolio is empty.',
    `Remaining portfolio budget: $${context.remainingBudgetUsd.toFixed(2)}.`,
    '',
    'Propose exactly one business. It must be sellable as a single digital artifact delivered instantly.',
  ].join('\n');

  const result = await callTool<Hypothesis>(
    CEO_SYSTEM,
    prompt,
    HYPOTHESIS_TOOL,
    () => heuristicHypothesis(niche),
  );

  return { ...result, value: normaliseHypothesis(result.value, niche) };
}

function normaliseHypothesis(h: Partial<Hypothesis>, niche: string): Hypothesis {
  const base = heuristicHypothesis(niche);
  const priceCents = clamp(Math.round(Number(h.priceCents ?? base.priceCents)), 900, 9900);
  return {
    name: (h.name ?? base.name).slice(0, 60),
    slug: slugify(h.slug ?? h.name ?? base.slug),
    tagline: (h.tagline ?? base.tagline).slice(0, 200),
    thesis: (h.thesis ?? base.thesis).slice(0, 800),
    targetCustomer: (h.targetCustomer ?? base.targetCustomer).slice(0, 160),
    offer: (h.offer ?? base.offer).slice(0, 300),
    priceCents,
    bullets: (Array.isArray(h.bullets) && h.bullets.length ? h.bullets : base.bullets)
      .slice(0, 5)
      .map((b) => String(b).slice(0, 90)),
    confidence: clamp(Number(h.confidence ?? base.confidence), 0, 1),
    reasoning: (h.reasoning ?? base.reasoning).slice(0, 2000),
  };
}

function heuristicHypothesis(niche: string): Hypothesis {
  const clean = niche.trim() || 'small business operations';
  const title = clean
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return {
    name: `${title} Kit`,
    slug: slugify(`${clean}-kit`),
    tagline: `A ready-to-use toolkit for ${clean}, delivered instantly.`,
    thesis: `Operators in ${clean} repeatedly rebuild the same assets by hand; a packaged kit removes that hour.`,
    targetCustomer: `Independent operators working in ${clean}`,
    offer: `A downloadable kit of templates and checklists for ${clean}.`,
    priceCents: 2900,
    bullets: [
      'Instant download, no account required',
      'Built from the patterns that actually convert',
      'One-time price, no subscription',
    ],
    confidence: 0.4,
    reasoning:
      'Heuristic fallback: the model call did not return, so this hypothesis is a template ' +
      'derived from the niche string alone. Treat its confidence as low and validate with traffic.',
  };
}

// ---------------------------------------------------------------------------
// Allocation judgement
// ---------------------------------------------------------------------------

export type Action = 'SCALE' | 'HOLD' | 'KILL' | 'ESCALATE';

export interface Judgement {
  action: Action;
  reasoning: string;
  confidence: number;
  allocateUsd: number;
  escalationQuestion: string;
  expertProfile: string;
}

export interface BusinessMetrics {
  id: string;
  name: string;
  niche: string;
  url: string;
  status: string;
  ageMinutes: number;
  visitors: number;
  conversions: number;
  revenueUsd: number;
  cogsUsd: number;
  opexUsd: number;
  netUsd: number;
  cacUsd: number | null;
}

const JUDGEMENT_TOOL: {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
} = {
  name: 'allocate',
  description: 'Decide what to do with one business in the portfolio this cycle.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['SCALE', 'HOLD', 'KILL', 'ESCALATE'],
        description:
          'SCALE: it converts, put more money in. HOLD: not enough evidence yet. ' +
          'KILL: enough traffic, no conversions, stop spending. ESCALATE: you need a human expert.',
      },
      reasoning: {
        type: 'string',
        description:
          'Your actual reasoning, citing the specific numbers you used. 2-5 sentences.',
      },
      confidence: { type: 'number', description: '0-1 confidence in this call.' },
      allocateUsd: {
        type: 'number',
        description: 'Dollars to put into this business this cycle. 0 unless SCALE.',
      },
      escalationQuestion: {
        type: 'string',
        description: 'If ESCALATE: the exact question for a human expert. Otherwise "".',
      },
      expertProfile: {
        type: 'string',
        description: 'If ESCALATE: who should answer it. Otherwise "".',
      },
    },
    required: ['action', 'reasoning', 'confidence', 'allocateUsd', 'escalationQuestion', 'expertProfile'],
  },
};

export async function judge(
  m: BusinessMetrics,
  policy: {
    killVisitors: number;
    killConversions: number;
    remainingBudgetUsd: number;
    perBusinessBudgetUsd: number;
    spentOnBusinessUsd: number;
  },
): Promise<ToolCallResult<Judgement>> {
  const prompt = [
    `Business: ${m.name} (${m.id}) — ${m.niche}`,
    `URL: ${m.url}`,
    `Status: ${m.status}, age ${m.ageMinutes} minutes`,
    `Traffic: ${m.visitors} real pageviews, ${m.conversions} paid conversions`,
    `P&L: revenue $${m.revenueUsd.toFixed(2)}, COGS $${m.cogsUsd.toFixed(2)}, ` +
      `OPEX $${m.opexUsd.toFixed(2)}, net $${m.netUsd.toFixed(2)}`,
    `CAC: ${m.cacUsd === null ? 'n/a (no conversions)' : '$' + m.cacUsd.toFixed(2)}`,
    '',
    'Kill policy: a business with at least ' +
      `${policy.killVisitors} visitors and at most ${policy.killConversions} conversions is a kill.`,
    `Budget: $${policy.spentOnBusinessUsd.toFixed(2)} of $${policy.perBusinessBudgetUsd} spent on this business; ` +
      `$${policy.remainingBudgetUsd.toFixed(2)} left across the portfolio.`,
    '',
    'Make the call.',
  ].join('\n');

  const result = await callTool<Judgement>(
    CEO_SYSTEM,
    prompt,
    JUDGEMENT_TOOL,
    () => heuristicJudgement(m, policy),
    1200,
  );

  const v = result.value ?? ({} as Partial<Judgement>);
  const action: Action = (['SCALE', 'HOLD', 'KILL', 'ESCALATE'] as Action[]).includes(v.action as Action)
    ? (v.action as Action)
    : 'HOLD';

  return {
    ...result,
    value: {
      action,
      reasoning: String(v.reasoning ?? 'no reasoning returned').slice(0, 2000),
      confidence: clamp(Number(v.confidence ?? 0.5), 0, 1),
      allocateUsd: Math.max(0, Number(v.allocateUsd ?? 0)),
      escalationQuestion: String(v.escalationQuestion ?? '').slice(0, 600),
      expertProfile: String(v.expertProfile ?? '').slice(0, 300),
    },
  };
}

function heuristicJudgement(
  m: BusinessMetrics,
  policy: { killVisitors: number; killConversions: number },
): Judgement {
  if (m.visitors >= policy.killVisitors && m.conversions <= policy.killConversions) {
    return {
      action: 'KILL',
      reasoning:
        `Heuristic fallback: ${m.visitors} visitors cleared the ${policy.killVisitors} threshold with ` +
        `${m.conversions} conversions, which meets the kill rule. Stopping spend.`,
      confidence: 0.8,
      allocateUsd: 0,
      escalationQuestion: '',
      expertProfile: '',
    };
  }
  if (m.conversions > 0) {
    return {
      action: 'SCALE',
      reasoning: `Heuristic fallback: ${m.conversions} paid conversion(s) on ${m.visitors} visitors is real demand.`,
      confidence: 0.6,
      allocateUsd: 5,
      escalationQuestion: '',
      expertProfile: '',
    };
  }
  return {
    action: 'HOLD',
    reasoning: `Heuristic fallback: ${m.visitors} visitors is below the ${policy.killVisitors} decision threshold. Not enough evidence either way.`,
    confidence: 0.55,
    allocateUsd: 0,
    escalationQuestion: '',
    expertProfile: '',
  };
}

// ---------------------------------------------------------------------------

export function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return base || 'biz';
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
