import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';
import { handle, verify } from '@/lib/stripe-webhook';
import { query, pool } from '@/lib/db';
import { fixtureBusiness } from './helpers';

/**
 * The money path, end to end, against the real database and the real webhook
 * secret: build a checkout.session.completed payload, sign it exactly the way
 * Stripe signs it, push it through the same verify+handle code the deployed
 * endpoint runs, and assert the ledger row that comes out the other side.
 */

const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const BUSINESS_ID = 'biz_fixture_webhook';

function signedEvent(payload: Record<string, unknown>): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  return { body, signature };
}

function checkoutCompleted(sessionId: string, amountCents: number) {
  return {
    id: `evt_test_${sessionId}`,
    object: 'event',
    api_version: '2025-01-27.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        amount_total: amountCents,
        amount_subtotal: amountCents,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
        status: 'complete',
        payment_intent: `pi_test_${sessionId}`,
        customer_details: { email: 'buyer@example.com' },
        metadata: { business_id: BUSINESS_ID, foundry: '1' },
      },
    },
  };
}

describe('stripe webhook', () => {
  beforeAll(async () => {
    await fixtureBusiness(BUSINESS_ID);
  });

  afterAll(async () => {
    await pool().end().catch(() => {});
  });

  it('has a webhook secret configured', () => {
    expect(SECRET).toMatch(/^whsec_/);
  });

  it('rejects a payload whose signature does not match', () => {
    const { body } = signedEvent(checkoutCompleted('cs_test_bad', 2900));
    const forged = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: 'whsec_this_is_not_the_real_secret',
    });
    expect(() => verify(body, forged)).toThrow();
  });

  it('rejects a payload that was tampered with after signing', () => {
    const { body, signature } = signedEvent(checkoutCompleted('cs_test_tamper', 2900));
    const tampered = body.replace('"amount_total":2900', '"amount_total":999999');
    expect(() => verify(tampered, signature)).toThrow();
  });

  it('verifies a real signed payload and posts REVENUE to the ledger', async () => {
    // Unique per run so this asserts a genuine insert rather than a prior row.
    const sessionId = `cs_test_${Date.now().toString(36)}`;
    const amount = 2900;
    const { body, signature } = signedEvent(checkoutCompleted(sessionId, amount));

    const event = verify(body, signature);
    expect(event.type).toBe('checkout.session.completed');

    const outcome = await handle(event);
    expect(outcome.handled).toBe(true);
    expect(outcome.created).toBe(true);
    expect(outcome.businessId).toBe(BUSINESS_ID);
    expect(outcome.ledgerEntryId).toBeTruthy();

    const rows = await query<{
      id: string;
      kind: string;
      amount_cents: string;
      business_id: string;
      external_id: string;
      currency: string;
    }>(`SELECT * FROM ledger_entries WHERE external_id = $1`, [`stripe:session:${sessionId}`]);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('REVENUE');
    expect(Number(rows[0].amount_cents)).toBe(amount);
    expect(rows[0].business_id).toBe(BUSINESS_ID);
    expect(rows[0].currency).toBe('usd');

    // The conversion is counted and a decision row records the reasoning.
    const biz = await query<{ conversions: number; status: string }>(
      `SELECT conversions, status FROM businesses WHERE id = $1`,
      [BUSINESS_ID],
    );
    expect(biz[0].conversions).toBeGreaterThan(0);
    expect(biz[0].status).toBe('SCALING');

    const decisions = await query<{ action: string; reasoning: string }>(
      `SELECT action, reasoning FROM decisions WHERE cycle_id = $1`,
      [`webhook_${event.id}`],
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('REVENUE_BOOKED');
    expect(decisions[0].reasoning).toContain('29.00');
  });

  it('is idempotent — replaying the same event books revenue exactly once', async () => {
    const sessionId = `cs_test_replay_${Date.now().toString(36)}`;
    const { body, signature } = signedEvent(checkoutCompleted(sessionId, 4900));

    const first = await handle(verify(body, signature));
    const second = await handle(verify(body, signature));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ledgerEntryId).toBe(first.ledgerEntryId);

    const rows = await query(`SELECT id FROM ledger_entries WHERE external_id = $1`, [
      `stripe:session:${sessionId}`,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('books a refund as a negative ledger entry', async () => {
    const chargeId = `ch_test_${Date.now().toString(36)}`;
    const payload = {
      id: `evt_refund_${chargeId}`,
      object: 'event',
      created: Math.floor(Date.now() / 1000),
      type: 'charge.refunded',
      data: {
        object: {
          id: chargeId,
          object: 'charge',
          amount: 2900,
          amount_refunded: 2900,
          currency: 'usd',
          refunded: true,
          metadata: { business_id: BUSINESS_ID },
        },
      },
    };
    const { body, signature } = signedEvent(payload);
    const outcome = await handle(verify(body, signature));
    expect(outcome.created).toBe(true);

    const rows = await query<{ kind: string; amount_cents: string }>(
      `SELECT kind, amount_cents FROM ledger_entries WHERE external_id = $1`,
      [`stripe:refund:${chargeId}:2900`],
    );
    expect(rows[0].kind).toBe('REFUND');
    expect(Number(rows[0].amount_cents)).toBe(-2900);
  });

  it('keeps the ledger append-only — the database rejects an UPDATE', async () => {
    await expect(
      query(`UPDATE ledger_entries SET amount_cents = 1 WHERE business_id = $1`, [BUSINESS_ID]),
    ).rejects.toThrow(/append-only/i);
  });
});
