import { env } from './env';
import { query } from './db';
import { businessPnL, cents, dollars, portfolioPnL } from './ledger';

/**
 * The guardrails. Every code path that can spend money calls `authorizeSpend`
 * first; there is no second way to spend.
 *
 * Three independent ceilings, checked in order of blast radius:
 *   1. circuit breaker  — latched in Postgres, halts everything
 *   2. portfolio budget — FOUNDRY_TOTAL_BUDGET_USD
 *   3. business budget  — FOUNDRY_PER_BUSINESS_BUDGET_USD
 * plus a per-escalation cap for labor purchases specifically.
 */

export type SpendCategory = 'labor' | 'infra' | 'traffic';

export interface SpendRequest {
  businessId: string | null;
  amountUsd: number;
  category: SpendCategory;
  /** Irreversible or legally-exposed actions must escalate, never auto-approve. */
  irreversible?: boolean;
  legallyExposed?: boolean;
}

export interface SpendDecision {
  allowed: boolean;
  /** Machine-readable rejection cause; '' when allowed. */
  code:
    | ''
    | 'CIRCUIT_BREAKER_TRIPPED'
    | 'PER_ESCALATION_CAP'
    | 'PER_BUSINESS_BUDGET'
    | 'PORTFOLIO_BUDGET'
    | 'MANDATORY_ESCALATION';
  reason: string;
  limits: {
    perEscalationUsd: number;
    perBusinessUsd: number;
    portfolioUsd: number;
    spentOnBusinessUsd: number;
    spentTotalUsd: number;
    remainingPortfolioUsd: number;
  };
}

export interface BreakerState {
  tripped: boolean;
  reason: string;
  trippedAt: string | null;
}

export async function breakerState(): Promise<BreakerState> {
  const rows = await query<{ tripped: boolean; reason: string; tripped_at: string | null }>(
    `SELECT tripped, reason, tripped_at FROM circuit_breaker WHERE id = 1`,
  );
  const row = rows[0];
  return {
    tripped: Boolean(row?.tripped),
    reason: row?.reason ?? '',
    trippedAt: row?.tripped_at ?? null,
  };
}

export async function tripBreaker(reason: string): Promise<BreakerState> {
  await query(
    `UPDATE circuit_breaker SET tripped = true, reason = $1, tripped_at = now() WHERE id = 1`,
    [reason],
  );
  return breakerState();
}

export async function resetBreaker(): Promise<BreakerState> {
  await query(
    `UPDATE circuit_breaker SET tripped = false, reason = '', tripped_at = NULL WHERE id = 1`,
  );
  return breakerState();
}

/**
 * Actions the agent is never allowed to take on its own authority, regardless
 * of budget. Matching one forces a human escalation instead of a spend.
 */
const MANDATORY_ESCALATION_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /\b(medical|health|diagnos|patient|hipaa)\b/i, why: 'health claims carry regulatory exposure' },
  { pattern: /\b(legal advice|attorney|lawsuit|litigat|contract review)\b/i, why: 'legal advice requires a licensed human' },
  { pattern: /\b(financial advice|investment advice|securities|tax filing)\b/i, why: 'regulated financial advice' },
  { pattern: /\b(guarantee|guaranteed results|cure|FDA)\b/i, why: 'unqualified guarantees are legally exposed' },
  { pattern: /\b(minor|child|children under)\b/i, why: 'content aimed at minors' },
];

export function requiresHumanEscalation(text: string): { required: boolean; why: string } {
  for (const rule of MANDATORY_ESCALATION_PATTERNS) {
    if (rule.pattern.test(text)) return { required: true, why: rule.why };
  }
  return { required: false, why: '' };
}

/**
 * The single gate. Returns a decision — it never throws for an ordinary
 * rejection, because "declined, and here is why" is a first-class outcome that
 * gets logged to the decision ledger.
 */
export async function authorizeSpend(req: SpendRequest): Promise<SpendDecision> {
  const [breaker, portfolio, business] = await Promise.all([
    breakerState(),
    portfolioPnL(),
    req.businessId ? businessPnL(req.businessId) : Promise.resolve(null),
  ]);

  const spentTotalUsd = dollars(portfolio.spendCents);
  const spentOnBusinessUsd = business ? dollars(business.spendCents) : 0;

  const limits: SpendDecision['limits'] = {
    perEscalationUsd: env.maxEscalationSpend,
    perBusinessUsd: env.perBusinessBudget,
    portfolioUsd: env.totalBudget,
    spentOnBusinessUsd,
    spentTotalUsd,
    remainingPortfolioUsd: round2(env.totalBudget - spentTotalUsd),
  };

  const deny = (code: SpendDecision['code'], reason: string): SpendDecision => ({
    allowed: false,
    code,
    reason,
    limits,
  });

  if (env.circuitBreaker && breaker.tripped) {
    return deny(
      'CIRCUIT_BREAKER_TRIPPED',
      `circuit breaker is tripped: ${breaker.reason || 'no reason recorded'}`,
    );
  }

  if (req.irreversible || req.legallyExposed) {
    return deny(
      'MANDATORY_ESCALATION',
      req.legallyExposed
        ? 'legally-exposed action — must be escalated to a human, not auto-approved'
        : 'irreversible action — must be escalated to a human, not auto-approved',
    );
  }

  if (req.category === 'labor' && req.amountUsd > env.maxEscalationSpend) {
    return deny(
      'PER_ESCALATION_CAP',
      `$${round2(req.amountUsd)} exceeds the per-escalation cap of $${env.maxEscalationSpend}`,
    );
  }

  if (req.businessId && spentOnBusinessUsd + req.amountUsd > env.perBusinessBudget) {
    return deny(
      'PER_BUSINESS_BUDGET',
      `$${round2(req.amountUsd)} would take ${req.businessId} to $${round2(
        spentOnBusinessUsd + req.amountUsd,
      )}, over its $${env.perBusinessBudget} budget`,
    );
  }

  if (spentTotalUsd + req.amountUsd > env.totalBudget) {
    return deny(
      'PORTFOLIO_BUDGET',
      `$${round2(req.amountUsd)} would take the portfolio to $${round2(
        spentTotalUsd + req.amountUsd,
      )}, over the $${env.totalBudget} ceiling`,
    );
  }

  return { allowed: true, code: '', reason: 'within all ceilings', limits };
}

/**
 * Post-spend check. When cumulative spend crosses the portfolio ceiling the
 * breaker latches, so the next cycle is stopped before it starts rather than
 * relying on every future caller to re-check.
 */
export async function enforceBreaker(): Promise<BreakerState> {
  const portfolio = await portfolioPnL();
  const spentUsd = dollars(portfolio.spendCents);
  if (env.circuitBreaker && spentUsd >= env.totalBudget) {
    return tripBreaker(
      `portfolio spend $${round2(spentUsd)} reached the $${env.totalBudget} ceiling`,
    );
  }
  return breakerState();
}

export interface BudgetSnapshot {
  totalBudgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  perBusinessBudgetUsd: number;
  perEscalationCapUsd: number;
  breaker: BreakerState;
  breakerEnabled: boolean;
}

export async function budgetSnapshot(): Promise<BudgetSnapshot> {
  const [portfolio, breaker] = await Promise.all([portfolioPnL(), breakerState()]);
  const spentUsd = dollars(portfolio.spendCents);
  return {
    totalBudgetUsd: env.totalBudget,
    spentUsd,
    remainingUsd: round2(env.totalBudget - spentUsd),
    perBusinessBudgetUsd: env.perBusinessBudget,
    perEscalationCapUsd: env.maxEscalationSpend,
    breaker,
    breakerEnabled: env.circuitBreaker,
  };
}

export { cents, dollars };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
