import { handle, verify } from '@/lib/stripe-webhook';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stripe endpoint we_1U4ZK32Nyz5Xb21P440IBTfO points here.
 * Events: checkout.session.completed, payment_intent.succeeded, charge.refunded.
 *
 * The raw body is required for signature verification — never parse it first.
 */
export async function POST(req: Request) {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return json({ error: 'missing stripe-signature header' }, { status: 400 });

  const raw = await req.text();

  let event;
  try {
    event = verify(raw, signature);
  } catch (err) {
    // 400 tells Stripe not to retry a payload we can never accept.
    return json({ error: `signature verification failed: ${errorMessage(err)}` }, { status: 400 });
  }

  try {
    const outcome = await handle(event);
    return json(outcome);
  } catch (err) {
    // 500 tells Stripe to retry; the ledger's unique external_id makes that safe.
    return json({ error: errorMessage(err), eventId: event.id }, { status: 500 });
  }
}
