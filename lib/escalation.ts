import { env } from './env';
import { id, query } from './db';
import { authorizeSpend, requiresHumanEscalation } from './guardrails';
import * as ledger from './ledger';
import * as decisions from './decisions';
import { laborProvider } from './providers/labor';
import type { LaborProvider, LaborQuote } from './providers/types';

/**
 * Escalation economics.
 *
 * When the agent's confidence in a judgement falls below
 * TERAC_ESCALATION_THRESHOLD it does not guess and it does not blindly buy. It
 * QUOTES the labor, prices that quote against three ceilings, and then either
 * purchases — booking the cost as COGS to the same ledger the revenue lands in
 * — or DECLINES with a reason that is written to the append-only decision log.
 *
 * The decline branch is not an error path. A CEO that refuses a $38 consult on
 * a $25-budget business is the guardrail doing its job, and it is a first-class
 * demo outcome.
 *
 * Both LaborProvider implementations run through this identical code path, so
 * the ledger rows and decision rows they produce have identical shapes.
 * `tests/labor-swap.test.ts` asserts exactly that.
 */

export interface EscalationInput {
  businessId: string | null;
  question: string;
  expertProfile: string;
  /** The agent's own confidence, 0–1. Below the threshold is why we are here. */
  confidence: number;
  cycleId: string;
  timelineHours?: number;
  submissionCount?: number;
  /** Set when the underlying action is irreversible or legally exposed. */
  irreversible?: boolean;
}

export interface EscalationResult {
  escalationId: string;
  decision: 'purchased' | 'declined';
  provider: string;
  quote: LaborQuote;
  /** Present only when purchased. */
  opportunityId: string | null;
  /** Why it was declined, or why it cleared. */
  reason: string;
  /** Machine-readable guardrail code when declined. */
  code: string;
  /** COGS ledger entry id when purchased. */
  ledgerEntryId: string | null;
  decisionId: string;
}

export function shouldEscalate(confidence: number, question = ''): boolean {
  if (requiresHumanEscalation(question).required) return true;
  return confidence < env.escalationThreshold;
}

export async function escalate(
  input: EscalationInput,
  provider: LaborProvider = laborProvider(),
): Promise<EscalationResult> {
  const escalationId = id('esc');
  const mandatory = requiresHumanEscalation(input.question);

  // 1. QUOTE. Pricing is free; committing is not.
  const quote = await provider.quote(input.question, input.expertProfile, {
    timelineHours: input.timelineHours ?? 2,
    submissionCount: input.submissionCount ?? 1,
    businessId: input.businessId ?? undefined,
  });

  await query(
    `INSERT INTO escalations
       (id, business_id, question, expert_profile, confidence, provider, quote_id,
        quote_total_cents, decision, reason, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','',$9)`,
    [
      escalationId,
      input.businessId,
      input.question,
      input.expertProfile,
      input.confidence,
      provider.info.name,
      quote.quoteId,
      ledger.cents(quote.totalCost),
      'open',
    ],
  );

  await query(
    `INSERT INTO labor_quotes
       (id, escalation_id, business_id, provider, provider_quote_id, total_cost_cents,
        cost_per_participant_cents, timeline_hours, submission_count, expires_at, reasoning, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id('lq'),
      escalationId,
      input.businessId,
      provider.info.name,
      quote.quoteId,
      ledger.cents(quote.totalCost),
      ledger.cents(quote.costPerParticipant),
      quote.timelineHours,
      quote.submissionCount,
      quote.expiresAt,
      quote.reasoning,
      JSON.stringify(quote),
    ],
  );

  // 2. PRICE IT AGAINST THE CEILINGS.
  const auth = await authorizeSpend({
    businessId: input.businessId,
    amountUsd: quote.totalCost,
    category: 'labor',
    irreversible: input.irreversible,
    legallyExposed: mandatory.required ? false : undefined,
  });

  const settle = async (
    outcome: 'purchased' | 'declined',
    reason: string,
    code: string,
    opportunityId: string | null,
    ledgerEntryId: string | null,
  ): Promise<EscalationResult> => {
    await query(
      `UPDATE escalations
          SET decision = $2, reason = $3, opportunity_id = $4,
              status = $5, resolved_at = now()
        WHERE id = $1`,
      [escalationId, outcome, reason, opportunityId, outcome === 'purchased' ? 'purchased' : 'declined'],
    );

    const row = await decisions.record({
      cycleId: input.cycleId,
      businessId: input.businessId,
      action: outcome === 'purchased' ? 'ESCALATION_PURCHASED' : 'ESCALATION_DECLINED',
      reasoning: reason,
      confidence: input.confidence,
      inputs: {
        question: input.question,
        expertProfile: input.expertProfile,
        confidence: input.confidence,
        threshold: env.escalationThreshold,
        mandatory: mandatory.required,
        mandatoryWhy: mandatory.why,
      },
      outputs: {
        escalationId,
        provider: provider.info.name,
        quoteId: quote.quoteId,
        quoteTotalUsd: quote.totalCost,
        costPerParticipantUsd: quote.costPerParticipant,
        expiresAt: quote.expiresAt,
        providerReasoning: quote.reasoning,
        decision: outcome,
        guardrailCode: code,
        opportunityId,
        ledgerEntryId,
        limits: auth.limits,
      },
    });

    return {
      escalationId,
      decision: outcome,
      provider: provider.info.name,
      quote,
      opportunityId,
      reason,
      code,
      ledgerEntryId,
      decisionId: row.id,
    };
  };

  if (!auth.allowed) {
    return settle(
      'declined',
      `Declined human labor at $${quote.totalCost}: ${auth.reason}. ` +
        `Provider rationale for the price: ${quote.reasoning}`,
      auth.code,
      null,
      null,
    );
  }

  // 3. BUY IT. This is the only place Foundry commits money to labor.
  const purchase = await provider.purchase(quote.quoteId, {
    name: `foundry-${input.businessId ?? 'portfolio'}-escalation`,
  });

  // 4. Book it as COGS, into the same ledger revenue lands in.
  const { entry } = await ledger.post({
    businessId: input.businessId,
    kind: 'COGS',
    amountCents: ledger.cents(quote.totalCost),
    description: `Human expertise via ${provider.info.name}: ${input.question.slice(0, 160)}`,
    source: `labor:${provider.info.name}`,
    externalId: `labor:${provider.info.name}:${purchase.opportunityId}`,
    meta: {
      escalationId,
      quoteId: quote.quoteId,
      opportunityId: purchase.opportunityId,
      expertProfile: input.expertProfile,
      costPerParticipantUsd: quote.costPerParticipant,
      providerReasoning: quote.reasoning,
    },
  });

  return settle(
    'purchased',
    `Bought human expertise for $${quote.totalCost} (confidence ${input.confidence.toFixed(2)} < ` +
      `threshold ${env.escalationThreshold}${mandatory.required ? `; mandatory: ${mandatory.why}` : ''}). ` +
      `Cleared per-escalation cap $${auth.limits.perEscalationUsd}, business budget ` +
      `$${auth.limits.perBusinessUsd}, portfolio ceiling $${auth.limits.portfolioUsd}. ` +
      `Provider rationale: ${quote.reasoning}`,
    '',
    purchase.opportunityId,
    entry?.id ?? null,
  );
}

export interface EscalationRow {
  id: string;
  business_id: string | null;
  question: string;
  expert_profile: string;
  confidence: number;
  provider: string;
  quote_id: string | null;
  quote_total_cents: string | number;
  decision: string;
  reason: string;
  opportunity_id: string | null;
  status: string;
  created_at: string;
}

export async function recentEscalations(limit = 25): Promise<EscalationRow[]> {
  return query<EscalationRow>(
    `SELECT * FROM escalations ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

/** Pull answers for purchased escalations that have not resolved yet. */
export async function collectAnswers(
  provider: LaborProvider = laborProvider(),
): Promise<number> {
  const open = await query<{ id: string; opportunity_id: string }>(
    `SELECT id, opportunity_id FROM escalations
      WHERE decision = 'purchased' AND answer IS NULL AND opportunity_id IS NOT NULL
      LIMIT 10`,
  );
  let resolved = 0;
  for (const row of open) {
    const res = await provider.poll(row.opportunity_id).catch(() => null);
    if (res?.status === 'answered' && res.answer) {
      await query(`UPDATE escalations SET answer = $2, status = 'answered' WHERE id = $1`, [
        row.id,
        res.answer,
      ]);
      resolved++;
    }
  }
  return resolved;
}
