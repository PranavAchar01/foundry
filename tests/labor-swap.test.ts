import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { escalate } from '@/lib/escalation';
import { StubProvider, TeracProvider } from '@/lib/providers/labor';
import { laborProvider } from '@/lib/providers';
import { query, pool } from '@/lib/db';
import { resetBreaker } from '@/lib/guardrails';
import { fixtureBusiness } from './helpers';
import type { LaborProvider, LaborQuote } from '@/lib/providers/types';

/**
 * Proves the labor swap is free: run the identical escalation through two
 * different LaborProvider implementations and assert the ledger rows and
 * decision rows that come out have identical shapes.
 *
 * The stub stands in for Terac when TERAC_API_KEY is empty, which is the state
 * this was built in. A second stub with a different provider name plays the
 * role of the swapped-in implementation so the assertion runs with no key.
 */

/** A distinct implementation with the same contract — the "other" provider. */
class AltProvider implements LaborProvider {
  readonly info = { capability: 'labor', name: 'alt', configured: true, requires: [] as string[] };
  private inner = new StubProvider();

  async quote(q: string, p: string, o?: Parameters<StubProvider['quote']>[2]): Promise<LaborQuote> {
    const base = await this.inner.quote(q, p, o);
    // Different id namespace, different price, different rationale — same shape.
    return {
      ...base,
      quoteId: base.quoteId.replace('stubq_', 'altq_'),
      totalCost: Math.round(base.totalCost * 0.5 * 100) / 100,
      costPerParticipant: Math.round(base.costPerParticipant * 0.5 * 100) / 100,
      reasoning: 'Alt marketplace pricing: half the stub rate for the same panel.',
      provider: 'alt',
    };
  }

  async purchase(quoteId: string) {
    const res = await this.inner.purchase(quoteId);
    return { ...res, opportunityId: res.opportunityId.replace('stubopp_', 'altopp_'), provider: 'alt' };
  }

  async poll(opportunityId: string) {
    return { ...(await this.inner.poll(opportunityId)), provider: 'alt' };
  }
}

const QUESTION =
  'Our landing page claims "cuts invoicing time in half". Is that defensible without a citation?';
const PROFILE = 'Direct-response marketer who has sold to freelance designers';

function shapeOf(v: Record<string, unknown>): string[] {
  return Object.keys(v).sort();
}

describe('labor provider swap', () => {
  // Fresh fixtures per run. Purchased labor posts real COGS against the
  // per-business budget, so reusing one id would make the second run of the
  // suite hit the $25 ceiling and decline — the guardrail working, but not
  // what this test is measuring.
  const run = Date.now().toString(36);
  const businessA = `biz_fixture_labor_a_${run}`;
  const businessB = `biz_fixture_labor_b_${run}`;

  beforeAll(async () => {
    await resetBreaker();
    await fixtureBusiness(businessA);
    await fixtureBusiness(businessB);
  });

  afterAll(async () => {
    await pool().end().catch(() => {});
  });

  it('defaults to the stub when TERAC_API_KEY is empty', () => {
    const provider = laborProvider();
    if (process.env.TERAC_API_KEY) {
      expect(provider.info.name).toBe('terac');
    } else {
      expect(provider.info.name).toBe('stub');
    }
  });

  it('constructs a TeracProvider without a key and without a network call', () => {
    // Listing an unconfigured provider must never throw — the registry walks it.
    const terac = new TeracProvider('');
    expect(terac.info.name).toBe('terac');
    expect(terac.info.requires).toContain('TERAC_API_KEY');
  });

  it('prices deterministically — the stub is seeded, not random', async () => {
    const stub = new StubProvider();
    const a = await stub.quote(QUESTION, PROFILE);
    const b = await stub.quote(QUESTION, PROFILE);
    expect(a.quoteId).toBe(b.quoteId);
    expect(a.totalCost).toBe(b.totalCost);
    expect(a.totalCost).toBeGreaterThan(0);

    const different = await stub.quote('A completely different question', PROFILE);
    expect(different.quoteId).not.toBe(a.quoteId);
  });

  it('makes the same LaborQuote shape from both implementations', async () => {
    const stub = await new StubProvider().quote(QUESTION, PROFILE);
    const alt = await new AltProvider().quote(QUESTION, PROFILE);
    expect(shapeOf(alt as unknown as Record<string, unknown>)).toEqual(
      shapeOf(stub as unknown as Record<string, unknown>),
    );
    expect(alt.provider).not.toBe(stub.provider);
  });

  it('produces identical ledger and decision row shapes through both providers', async () => {
    const cycleId = `cyc_swap_${Date.now().toString(36)}`;

    const viaStub = await escalate(
      {
        businessId: businessA,
        question: QUESTION,
        expertProfile: PROFILE,
        confidence: 0.31,
        cycleId,
      },
      new StubProvider(),
    );

    const viaAlt = await escalate(
      {
        businessId: businessB,
        question: QUESTION,
        expertProfile: PROFILE,
        confidence: 0.31,
        cycleId,
      },
      new AltProvider(),
    );

    // Both must reach a real outcome, and both must reach the SAME outcome:
    // identical question, identical budget posture, so identical branch.
    expect(viaStub.decision).toBe('purchased');
    expect(viaAlt.decision).toBe('purchased');
    expect(viaStub.provider).toBe('stub');
    expect(viaAlt.provider).toBe('alt');

    expect(shapeOf(viaAlt as unknown as Record<string, unknown>)).toEqual(
      shapeOf(viaStub as unknown as Record<string, unknown>),
    );

    // --- ledger rows -------------------------------------------------------
    const [stubLedger] = await query<Record<string, unknown>>(
      `SELECT * FROM ledger_entries WHERE id = $1`,
      [viaStub.ledgerEntryId],
    );
    const [altLedger] = await query<Record<string, unknown>>(
      `SELECT * FROM ledger_entries WHERE id = $1`,
      [viaAlt.ledgerEntryId],
    );

    expect(shapeOf(altLedger)).toEqual(shapeOf(stubLedger));
    expect(stubLedger.kind).toBe('COGS');
    expect(altLedger.kind).toBe('COGS');
    // COGS is money out: stored negative, in the same ledger as revenue.
    expect(Number(stubLedger.amount_cents)).toBeLessThan(0);
    expect(Number(altLedger.amount_cents)).toBeLessThan(0);
    expect(shapeOf(stubLedger.meta as Record<string, unknown>)).toEqual(
      shapeOf(altLedger.meta as Record<string, unknown>),
    );

    // --- decision rows -----------------------------------------------------
    const [stubDecision] = await query<Record<string, unknown>>(
      `SELECT * FROM decisions WHERE id = $1`,
      [viaStub.decisionId],
    );
    const [altDecision] = await query<Record<string, unknown>>(
      `SELECT * FROM decisions WHERE id = $1`,
      [viaAlt.decisionId],
    );

    expect(shapeOf(altDecision)).toEqual(shapeOf(stubDecision));
    expect(stubDecision.action).toBe('ESCALATION_PURCHASED');
    expect(altDecision.action).toBe('ESCALATION_PURCHASED');
    expect(shapeOf(stubDecision.outputs as Record<string, unknown>)).toEqual(
      shapeOf(altDecision.outputs as Record<string, unknown>),
    );
    expect(shapeOf(stubDecision.inputs as Record<string, unknown>)).toEqual(
      shapeOf(altDecision.inputs as Record<string, unknown>),
    );

    // --- escalation + quote rows ------------------------------------------
    const [stubQuote] = await query<Record<string, unknown>>(
      `SELECT * FROM labor_quotes WHERE escalation_id = $1`,
      [viaStub.escalationId],
    );
    const [altQuote] = await query<Record<string, unknown>>(
      `SELECT * FROM labor_quotes WHERE escalation_id = $1`,
      [viaAlt.escalationId],
    );
    expect(shapeOf(altQuote)).toEqual(shapeOf(stubQuote));
    expect(stubQuote.provider).toBe('stub');
    expect(altQuote.provider).toBe('alt');
    // Both recorded the provider's own price rationale verbatim.
    expect(String(stubQuote.reasoning).length).toBeGreaterThan(20);
    expect(String(altQuote.reasoning).length).toBeGreaterThan(20);
  });
});
