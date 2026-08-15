import { checkoutProvider } from '@/lib/providers';
import { env } from '@/lib/env';
import * as businesses from '@/lib/businesses';
import { errorMessage, json, preflight } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return preflight();
}

/**
 * Called by the Buy button on every spawned business page (cross-origin).
 *
 * The account backing this has card_payments INACTIVE, so the checkout provider
 * passes `payment_method_types` explicitly — see lib/providers/checkout.ts.
 * Session creation returns 200 today; a live payment cannot COMPLETE until the
 * owner finishes Stripe activation.
 */
export async function POST(req: Request) {
  let businessId = '';
  try {
    const body = (await req.json().catch(() => ({}))) as { businessId?: string };
    businessId = String(body.businessId ?? '');
    if (!businessId) return json({ error: 'businessId is required' }, { status: 400, cors: true });

    const business = await businesses.get(businessId);
    if (!business) return json({ error: 'unknown business' }, { status: 404, cors: true });
    if (business.status === 'KILLED') {
      return json(
        { error: 'This business has been shut down by the operator agent.' },
        { status: 410, cors: true },
      );
    }

    const provider = checkoutProvider();
    const session = await provider.createSession({
      businessId,
      productName: business.name,
      description: business.tagline || business.niche,
      amountCents: business.price_cents,
      currency: business.currency,
      billing: (business.billing as 'one_time' | 'subscription') ?? 'one_time',
      interval: (business.billing_interval as 'month') ?? 'month',
      successUrl: `${env.publicUrl}/thanks?business=${businessId}&session={CHECKOUT_SESSION_ID}`,
      cancelUrl: business.url || env.publicUrl,
    });

    return json(
      {
        url: session.url,
        sessionId: session.sessionId,
        provider: session.provider,
        amountCents: session.amountCents,
      },
      { cors: true },
    );
  } catch (err) {
    const message = errorMessage(err);
    return json(
      {
        error: message,
        businessId,
        hint: message.includes('payment method')
          ? 'Stripe account activation is incomplete; sessions require explicit payment_method_types.'
          : undefined,
      },
      { status: 502, cors: true },
    );
  }
}
