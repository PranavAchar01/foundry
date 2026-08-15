import Stripe from 'stripe';
import { env } from '@/lib/env';
import type { CheckoutProvider, CheckoutRequest, CheckoutSession } from './types';

let cached: Stripe | null = null;

export function stripeClient(): Stripe {
  if (!cached) {
    if (!env.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not set');
    cached = new Stripe(env.stripeSecretKey, { maxNetworkRetries: 2 });
  }
  return cached;
}

/**
 * Default checkout. One hard-won detail: this Stripe account has card_payments
 * INACTIVE and charges_enabled=false, so `automatic_payment_methods` resolves
 * to an empty set and the API returns 400. `payment_method_types` is therefore
 * always passed explicitly, from STRIPE_PAYMENT_METHOD_TYPES.
 *
 * Session creation succeeds today. Completing a live payment needs the owner to
 * finish account activation; that is the only step outside this system.
 */
export class StripeCheckoutProvider implements CheckoutProvider {
  readonly info = {
    capability: 'checkout',
    name: 'stripe',
    configured: Boolean(env.stripeSecretKey),
    requires: ['STRIPE_SECRET_KEY'],
  };

  async createSession(req: CheckoutRequest): Promise<CheckoutSession> {
    const stripe = stripeClient();

    const subscription = req.billing === 'subscription';

    const session = await stripe.checkout.sessions.create({
      mode: subscription ? 'subscription' : 'payment',
      // Explicit. Never `automatic_payment_methods` on this account.
      payment_method_types: env.stripePaymentMethodTypes as Stripe.Checkout.SessionCreateParams.PaymentMethodType[],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: req.currency,
            unit_amount: req.amountCents,
            // Stripe rejects `recurring` in payment mode, so it appears only
            // when the product actually bills on a cycle.
            ...(subscription ? { recurring: { interval: req.interval ?? 'month' } } : {}),
            product_data: {
              name: req.productName,
              description: req.description.slice(0, 500),
            },
          },
        },
      ],
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      // Read back by the webhook to attribute revenue to the right business.
      metadata: { business_id: req.businessId, foundry: '1' },
      // `payment_intent_data` is invalid in subscription mode — the
      // subscription carries the attribution metadata instead.
      ...(subscription
        ? { subscription_data: { metadata: { business_id: req.businessId, foundry: '1' } } }
        : { payment_intent_data: { metadata: { business_id: req.businessId, foundry: '1' } } }),
    });

    if (!session.url) throw new Error('Stripe returned a session without a URL');

    return {
      sessionId: session.id,
      url: session.url,
      provider: 'stripe',
      amountCents: session.amount_total ?? req.amountCents,
    };
  }
}

/** Sponsor path: Whop storefront checkout. */
export class WhopCheckoutProvider implements CheckoutProvider {
  readonly info = {
    capability: 'checkout',
    name: 'whop',
    configured: Boolean(env.whopApiKey && env.whopCompanyId),
    requires: ['WHOP_API_KEY', 'WHOP_COMPANY_ID'],
  };

  constructor(
    private readonly apiKey = env.whopApiKey,
    private readonly companyId = env.whopCompanyId,
  ) {}

  async createSession(req: CheckoutRequest): Promise<CheckoutSession> {
    if (!this.apiKey) throw new Error('WHOP_API_KEY is not set');

    const plan = await this.post('/v2/plans', {
      company_id: this.companyId,
      plan_type: 'one_time',
      base_currency: req.currency,
      initial_price: req.amountCents / 100,
      internal_notes: `foundry:${req.businessId}`,
      metadata: { business_id: req.businessId, foundry: '1' },
    });

    const checkout = await this.post('/v2/checkout_sessions', {
      plan_id: plan.id,
      redirect_url: req.successUrl,
      metadata: { business_id: req.businessId, foundry: '1' },
    });

    const url = checkout.purchase_url ?? checkout.url;
    if (!url) throw new Error('Whop returned a checkout session without a URL');
    return { sessionId: String(checkout.id), url: String(url), provider: 'whop', amountCents: req.amountCents };
  }

  private async post(path: string, body: unknown): Promise<Record<string, string>> {
    const res = await fetch(`https://api.whop.com${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`whop ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
    return (await res.json()) as Record<string, string>;
  }
}

/** Sponsor path: Dodo Payments, merchant-of-record checkout. */
export class DodoCheckoutProvider implements CheckoutProvider {
  readonly info = {
    capability: 'checkout',
    name: 'dodo',
    configured: Boolean(env.dodoApiKey),
    requires: ['DODO_PAYMENTS_API_KEY'],
  };

  constructor(private readonly apiKey = env.dodoApiKey) {}

  async createSession(req: CheckoutRequest): Promise<CheckoutSession> {
    if (!this.apiKey) throw new Error('DODO_PAYMENTS_API_KEY is not set');

    const res = await fetch('https://live.dodopayments.com/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        payment_link: true,
        billing: { country: 'US' },
        customer: { email: `customer@${req.businessId}.foundry.invalid`, name: 'Foundry customer' },
        product_cart: [
          {
            product_id: req.businessId,
            quantity: 1,
            amount: req.amountCents,
            name: req.productName,
          },
        ],
        return_url: req.successUrl,
        metadata: { business_id: req.businessId, foundry: '1' },
      }),
    });

    if (!res.ok) throw new Error(`dodo payments -> ${res.status} ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as { payment_id?: string; payment_link?: string };
    if (!json.payment_link) throw new Error('Dodo returned no payment_link');
    return {
      sessionId: json.payment_id ?? 'dodo_unknown',
      url: json.payment_link,
      provider: 'dodo',
      amountCents: req.amountCents,
    };
  }
}

export const CHECKOUT_IMPLEMENTATIONS: Record<string, () => CheckoutProvider> = {
  stripe: () => new StripeCheckoutProvider(),
  whop: () => new WhopCheckoutProvider(),
  dodo: () => new DodoCheckoutProvider(),
};

export function checkoutProvider(name = env.checkoutProvider): CheckoutProvider {
  const make = CHECKOUT_IMPLEMENTATIONS[name] ?? CHECKOUT_IMPLEMENTATIONS.stripe;
  return make();
}
