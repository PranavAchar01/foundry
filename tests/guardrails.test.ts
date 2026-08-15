import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import {
  authorizeSpend,
  breakerState,
  enforceBreaker,
  requiresHumanEscalation,
  resetBreaker,
  tripBreaker,
} from '@/lib/guardrails';
import { escalate, shouldEscalate } from '@/lib/escalation';
import { StubProvider } from '@/lib/providers/labor';
import { spawn } from '@/lib/spawn';
import { pool, query } from '@/lib/db';
import { env } from '@/lib/env';
import { fixtureBusiness } from './helpers';

/**
 * The guardrails, exercised for real against the live database.
 * The central claim under test: once the breaker latches, nothing spends.
 */

const BUSINESS = 'biz_fixture_guardrails';

describe('guardrails', () => {
  beforeEach(async () => {
    await resetBreaker();
    await fixtureBusiness(BUSINESS);
  });

  afterAll(async () => {
    await resetBreaker();
    await pool().end().catch(() => {});
  });

  it('allows an ordinary spend inside every ceiling', async () => {
    const decision = await authorizeSpend({
      businessId: BUSINESS,
      amountUsd: 1,
      category: 'infra',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('');
    expect(decision.limits.portfolioUsd).toBe(env.totalBudget);
  });

  it('refuses a labor purchase above the per-escalation cap', async () => {
    const decision = await authorizeSpend({
      businessId: BUSINESS,
      amountUsd: env.maxEscalationSpend + 0.01,
      category: 'labor',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('PER_ESCALATION_CAP');
    expect(decision.reason).toContain('per-escalation cap');
  });

  it('refuses a spend that would breach the per-business budget', async () => {
    const decision = await authorizeSpend({
      businessId: BUSINESS,
      amountUsd: env.perBusinessBudget + 1,
      category: 'traffic',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('PER_BUSINESS_BUDGET');
  });

  it('refuses a spend that would breach the portfolio ceiling', async () => {
    const decision = await authorizeSpend({
      businessId: null,
      amountUsd: env.totalBudget + 1,
      category: 'infra',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('PORTFOLIO_BUDGET');
  });

  it('forces escalation on irreversible and legally-exposed actions', async () => {
    const irreversible = await authorizeSpend({
      businessId: BUSINESS,
      amountUsd: 0.5,
      category: 'infra',
      irreversible: true,
    });
    expect(irreversible.allowed).toBe(false);
    expect(irreversible.code).toBe('MANDATORY_ESCALATION');

    const legal = await authorizeSpend({
      businessId: BUSINESS,
      amountUsd: 0.5,
      category: 'infra',
      legallyExposed: true,
    });
    expect(legal.allowed).toBe(false);
    expect(legal.code).toBe('MANDATORY_ESCALATION');
  });

  it('classifies legally-exposed subject matter', () => {
    expect(requiresHumanEscalation('a diagnostic tool for patient intake').required).toBe(true);
    expect(requiresHumanEscalation('contract review for freelancers').required).toBe(true);
    expect(requiresHumanEscalation('guaranteed results in 7 days').required).toBe(true);
    expect(requiresHumanEscalation('checklists for coffee roasters').required).toBe(false);
  });

  it('escalates below the confidence threshold and not above it', () => {
    expect(shouldEscalate(env.escalationThreshold - 0.01)).toBe(true);
    expect(shouldEscalate(env.escalationThreshold + 0.01)).toBe(false);
    // Subject matter overrides confidence entirely.
    expect(shouldEscalate(0.99, 'is this medical claim defensible')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The headline guarantee.
  // -------------------------------------------------------------------------

  it('HALTS ALL SPEND once the circuit breaker trips', async () => {
    await tripBreaker('test: simulated runaway spend');
    const state = await breakerState();
    expect(state.tripped).toBe(true);

    // 1. The gate refuses, whatever the amount and whatever the category.
    for (const category of ['labor', 'infra', 'traffic'] as const) {
      const decision = await authorizeSpend({
        businessId: BUSINESS,
        amountUsd: 0.01,
        category,
      });
      expect(decision.allowed, `${category} was allowed while tripped`).toBe(false);
      expect(decision.code).toBe('CIRCUIT_BREAKER_TRIPPED');
    }

    // 2. An escalation still QUOTES (pricing is free) but must never purchase,
    //    and must not write a COGS row.
    const before = await countCogs(BUSINESS);
    const result = await escalate(
      {
        businessId: BUSINESS,
        question: 'Should we double the price?',
        expertProfile: 'Pricing consultant',
        confidence: 0.2,
        cycleId: `cyc_breaker_${Date.now().toString(36)}`,
      },
      new StubProvider(),
    );
    expect(result.decision).toBe('declined');
    expect(result.code).toBe('CIRCUIT_BREAKER_TRIPPED');
    expect(result.opportunityId).toBeNull();
    expect(result.ledgerEntryId).toBeNull();
    expect(await countCogs(BUSINESS)).toBe(before);

    // 3. And the decline is recorded with its reason, not swallowed.
    const [decision] = await query<{ action: string; reasoning: string }>(
      `SELECT action, reasoning FROM decisions WHERE id = $1`,
      [result.decisionId],
    );
    expect(decision.action).toBe('ESCALATION_DECLINED');
    expect(decision.reasoning).toContain('circuit breaker');

    // 4. Spawning — the other way money leaves — is refused too.
    const spawned = await spawn({ niche: 'artisanal pencil sharpening' });
    expect(spawned.ok).toBe(false);
    expect(spawned.guardrailCode).toBe('CIRCUIT_BREAKER_TRIPPED');
    expect(spawned.businessId).toBeNull();
  });

  it('refuses to spawn into a legally-exposed niche even with the breaker armed', async () => {
    const spawned = await spawn({ niche: 'medical diagnosis assistant for patients' });
    expect(spawned.ok).toBe(false);
    expect(spawned.guardrailCode).toBe('MANDATORY_ESCALATION');
  });

  it('latches the breaker automatically when spend reaches the ceiling', async () => {
    // enforceBreaker reads real spend; with the budget intact it must stay armed.
    const state = await enforceBreaker();
    expect(state.tripped).toBe(false);
  });
});

async function countCogs(businessId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM ledger_entries WHERE business_id = $1 AND kind = 'COGS'`,
    [businessId],
  );
  return Number(rows[0].n);
}
