import { TeracClient, type Quote, type QuoteDetail } from '@/lib/terac';
import { env } from '@/lib/env';
import type {
  LaborAnswer,
  LaborProvider,
  LaborPurchase,
  LaborQuote,
  LaborQuoteOptions,
} from './types';

// ---------------------------------------------------------------------------
// Terac — the real thing. Thin wrapper over the existing client in lib/terac.ts.
// ---------------------------------------------------------------------------

export class TeracProvider implements LaborProvider {
  readonly info = {
    capability: 'labor',
    name: 'terac',
    configured: Boolean(env.teracApiKey),
    requires: ['TERAC_API_KEY'],
  };

  private client: TeracClient | null = null;

  constructor(private readonly apiKey = env.teracApiKey) {}

  /** Lazily constructed so an unconfigured TeracProvider can still be listed. */
  private c(): TeracClient {
    if (!this.client) this.client = new TeracClient(this.apiKey);
    return this.client;
  }

  async quote(
    question: string,
    expertProfile: string,
    opts: LaborQuoteOptions = {},
  ): Promise<LaborQuote> {
    const timelineHours = opts.timelineHours ?? 2;
    const submissionCount = opts.submissionCount ?? 1;

    const q: Quote = await this.c().createQuote({
      taskDescription: question,
      panelDescription: expertProfile,
      timelineHours,
      submissionCount,
    });

    // The price reasoning lives on the detail record, not the create response.
    let reasoning = '';
    try {
      const detail: QuoteDetail = await this.c().getQuote(q.quoteId);
      reasoning = detail.reasoning ?? '';
    } catch {
      reasoning = `Terac priced this panel at $${q.totalCost} across ${submissionCount} submission(s).`;
    }

    return {
      quoteId: q.quoteId,
      totalCost: Number(q.totalCost),
      costPerParticipant: Number(q.costPerParticipant),
      expiresAt: q.expiresAt,
      reasoning,
      timelineHours: q.timelineHours ?? timelineHours,
      submissionCount: q.submissionCount ?? submissionCount,
      provider: 'terac',
    };
  }

  async purchase(quoteId: string, opts: { name?: string } = {}): Promise<LaborPurchase> {
    const res = await this.c().launchFromQuote(quoteId, { name: opts.name });
    return { opportunityId: res.opportunityId, status: res.status, provider: 'terac' };
  }

  async poll(opportunityId: string): Promise<LaborAnswer> {
    const { data } = await this.c().listSubmissions(opportunityId, { limit: 10 });
    const approved = data.find((s) => s.status === 'approved');
    if (approved) {
      return {
        opportunityId,
        status: 'answered',
        answer: summariseSubmission(approved.screening_answers),
        provider: 'terac',
      };
    }
    const working = data.some((s) => s.status === 'in_progress' || s.status === 'awaiting_review');
    return {
      opportunityId,
      status: working ? 'in_progress' : 'pending',
      answer: null,
      provider: 'terac',
    };
  }
}

function summariseSubmission(
  answers: { question: string; answer: string[] }[] | undefined,
): string {
  if (!answers?.length) return 'Submission approved with no structured answer payload.';
  return answers.map((a) => `${a.question}: ${a.answer.join(' / ')}`).join('\n');
}

// ---------------------------------------------------------------------------
// Stub — deterministic, seeded, zero network. Same shapes, same code paths.
// ---------------------------------------------------------------------------

/** FNV-1a. Stable across processes and Node versions — the seed must not drift. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 — small, fast, fully deterministic given a seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The stub is not a mock that returns a constant. It prices labor from the
 * shape of the request the same way a marketplace would — expertise premium,
 * urgency premium, panel size — so the escalation economics (cap breach,
 * budget breach, decline) are exercised for real without a key.
 */
export class StubProvider implements LaborProvider {
  readonly info = {
    capability: 'labor',
    name: 'stub',
    configured: true,
    requires: [] as string[],
  };

  /** Deterministic clock base so `expiresAt` is reproducible in tests. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  async quote(
    question: string,
    expertProfile: string,
    opts: LaborQuoteOptions = {},
  ): Promise<LaborQuote> {
    const timelineHours = opts.timelineHours ?? 2;
    const submissionCount = opts.submissionCount ?? 1;
    const seed = hash(`${question}|${expertProfile}|${timelineHours}|${submissionCount}`);
    const rand = rng(seed);

    const base = 6 + rand() * 14; // $6–$20 per participant, baseline
    const expertisePremium = /senior|expert|attorney|lawyer|counsel|physician|cpa|licensed|compliance/i.test(
      expertProfile,
    )
      ? 2.4
      : 1;
    const urgency = timelineHours <= 1 ? 1.75 : timelineHours <= 4 ? 1.25 : 1;

    const costPerParticipant = round2(base * expertisePremium * urgency);
    const totalCost = round2(costPerParticipant * submissionCount);

    return {
      quoteId: `stubq_${seed.toString(36)}`,
      totalCost,
      costPerParticipant,
      expiresAt: new Date(this.now() + 60 * 60 * 1000).toISOString(),
      reasoning:
        `Seeded stub pricing: base $${round2(base)}/participant` +
        `, expertise x${expertisePremium}` +
        `, urgency x${urgency} for a ${timelineHours}h turnaround` +
        `, x${submissionCount} submission(s) = $${totalCost}.`,
      timelineHours,
      submissionCount,
      provider: 'stub',
    };
  }

  async purchase(quoteId: string): Promise<LaborPurchase> {
    return {
      opportunityId: `stubopp_${hash(quoteId).toString(36)}`,
      status: 'launched',
      provider: 'stub',
    };
  }

  async poll(opportunityId: string): Promise<LaborAnswer> {
    const rand = rng(hash(opportunityId));
    // Deterministic per opportunity: the same id always resolves the same way.
    const answered = rand() > 0.25;
    return {
      opportunityId,
      status: answered ? 'answered' : 'in_progress',
      answer: answered
        ? 'Panel consensus: the claim as written is defensible only with a cited source; ' +
          'recommend softening to a comparative statement and adding a disclosure line.'
        : null,
      provider: 'stub',
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function laborProvider(name = env.laborProvider): LaborProvider {
  return name === 'terac' ? new TeracProvider() : new StubProvider();
}

export const LABOR_IMPLEMENTATIONS: Record<string, () => LaborProvider> = {
  terac: () => new TeracProvider(),
  stub: () => new StubProvider(),
};
