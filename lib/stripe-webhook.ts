import type Stripe from 'stripe';
import { env } from './env';
import { stripeClient } from './providers/checkout';
import * as ledger from './ledger';
import * as businesses from './businesses';
import * as decisions from './decisions';

/**
 * Webhook handling, extracted from the route so the integration test can replay
 * a real signed payload through the exact same code the deployed endpoint runs.
 */

export interface WebhookOutcome {
  received: true;
  type: string;
  eventId: string;
  handled: boolean;
  ledgerEntryId: string | null;
  /** False when the event had already been booked — replay is a no-op. */
  created: boolean;
  businessId: string | null;
}

export function verify(rawBody: string, signature: string): Stripe.Event {
  if (!env.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return stripeClient().webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
}

function businessIdFrom(obj: { metadata?: Stripe.Metadata | null }): string | null {
  const raw = obj.metadata?.business_id;
  return raw ? String(raw) : null;
}

export async function handle(event: Stripe.Event): Promise<WebhookOutcome> {
  const base = { received: true as const, type: event.type, eventId: event.id };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const businessId = businessIdFrom(session);
      const amount = session.amount_total ?? 0;

      const { created, entry } = await ledger.post({
        businessId,
        kind: 'REVENUE',
        amountCents: amount,
        currency: session.currency ?? 'usd',
        description: `Checkout completed${businessId ? ` for ${businessId}` : ''}`,
        source: 'stripe:checkout.session.completed',
        // Idempotency: the same session can never book revenue twice.
        externalId: `stripe:session:${session.id}`,
        meta: {
          sessionId: session.id,
          eventId: event.id,
          paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
          customerEmail: session.customer_details?.email ?? null,
        },
      });

      if (created && businessId) {
        await businesses.recordConversion(businessId);
        await decisions.record({
          cycleId: `webhook_${event.id}`,
          businessId,
          action: 'REVENUE_BOOKED',
          reasoning:
            `Stripe confirmed a completed checkout for $${(amount / 100).toFixed(2)}. ` +
            'Booked to the ledger as REVENUE and counted as a conversion, which moves this ' +
            'business to SCALING for the next allocation cycle.',
          confidence: 1,
          model: 'stripe-webhook',
          inputs: { eventId: event.id, sessionId: session.id, amountCents: amount },
          outputs: { ledgerEntryId: entry?.id ?? null },
        });
      }

      return { ...base, handled: true, ledgerEntryId: entry?.id ?? null, created, businessId };
    }

    case 'payment_intent.succeeded': {
      // Revenue is booked from checkout.session.completed; this event exists to
      // confirm settlement without double-counting.
      const pi = event.data.object as Stripe.PaymentIntent;
      return {
        ...base,
        handled: true,
        ledgerEntryId: null,
        created: false,
        businessId: businessIdFrom(pi),
      };
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const businessId = businessIdFrom(charge);
      const { created, entry } = await ledger.post({
        businessId,
        kind: 'REFUND',
        amountCents: charge.amount_refunded ?? 0,
        currency: charge.currency ?? 'usd',
        description: `Refund on charge ${charge.id}`,
        source: 'stripe:charge.refunded',
        externalId: `stripe:refund:${charge.id}:${charge.amount_refunded}`,
        meta: { chargeId: charge.id, eventId: event.id },
      });
      return { ...base, handled: true, ledgerEntryId: entry?.id ?? null, created, businessId };
    }

    default:
      return { ...base, handled: false, ledgerEntryId: null, created: false, businessId: null };
  }
}
