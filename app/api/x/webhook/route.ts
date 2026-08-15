import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { query, id } from '@/lib/db';
import * as decisions from '@/lib/decisions';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * X Account Activity API webhook.
 *
 * Registration performs a Challenge-Response Check: X GETs this URL with a
 * `crc_token` and expects `{"response_token":"sha256=<base64 HMAC-SHA256>"}`
 * within a few seconds. Pointing the webhook at the site root fails with
 * `Invalid response_token` because the root serves HTML, not that JSON.
 *
 * The HMAC key is the **consumer API Key Secret**, not the OAuth 2.0 client
 * secret — the Account Activity API is OAuth 1.0a-based. `X_API_KEY_SECRET`
 * holds it; falling back to the OAuth 2.0 secret would sign with the wrong key
 * and fail the check just as opaquely, so an unset value is reported plainly
 * instead.
 */
function signingSecret(): string {
  return env.xApiKeySecret;
}

export async function GET(req: Request) {
  const crcToken = new URL(req.url).searchParams.get('crc_token');

  if (!crcToken) {
    // Not a CRC call — report readiness so setup problems are visible.
    return json({
      endpoint: 'x-account-activity',
      ready: Boolean(signingSecret()),
      expects: 'GET ?crc_token=… → {"response_token":"sha256=…"}',
      note: signingSecret()
        ? 'Signing with X_API_KEY_SECRET (consumer API Key Secret).'
        : 'X_API_KEY_SECRET is not set. CRC will fail: the HMAC key is the consumer ' +
          'API Key Secret from Keys and tokens, not the OAuth 2.0 client secret.',
    });
  }

  const secret = signingSecret();
  if (!secret) {
    return json({ error: 'X_API_KEY_SECRET is not set; cannot answer the CRC' }, { status: 500 });
  }

  const responseToken =
    'sha256=' + createHmac('sha256', secret).update(crcToken).digest('base64');

  // Must be exactly this shape, and fast — X times the challenge out.
  return NextResponse.json({ response_token: responseToken });
}

/** X signs every delivery; an unsigned or mis-signed body is not from X. */
function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = signingSecret();
  if (!secret || !header) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ActivityPayload {
  for_user_id?: string;
  direct_message_events?: {
    id: string;
    message_create?: {
      sender_id?: string;
      message_data?: { text?: string };
    };
  }[];
  follow_events?: { type: string; source?: { id: string; screen_name?: string } }[];
}

/**
 * Inbound activity. The useful signal here is a DM someone sent *to* Foundry —
 * that is a conversation they started, which is exactly the opt-in that
 * outbound DMs lack, so it can be answered automatically.
 */
export async function POST(req: Request) {
  const raw = await req.text();

  if (!verifySignature(raw, req.headers.get('x-twitter-webhooks-signature'))) {
    return json({ error: 'signature verification failed' }, { status: 403 });
  }

  try {
    const payload = JSON.parse(raw) as ActivityPayload;
    const inbound = payload.direct_message_events ?? [];
    const follows = payload.follow_events ?? [];

    for (const event of inbound) {
      const senderId = event.message_create?.sender_id ?? '';
      // Foundry's own outbound messages echo back here; ignore them.
      if (!senderId || senderId === payload.for_user_id) continue;

      await query(
        `INSERT INTO inbound_messages (id, source, external_id, sender_id, text)
         VALUES ($1, 'x', $2, $3, $4)
         ON CONFLICT (source, external_id) DO NOTHING`,
        [id('inb'), event.id, senderId, (event.message_create?.message_data?.text ?? '').slice(0, 2000)],
      );
    }

    if (inbound.length || follows.length) {
      await decisions.record({
        cycleId: `x_webhook_${Date.now().toString(36)}`,
        action: 'X_ACTIVITY_RECEIVED',
        reasoning:
          `Received ${inbound.length} inbound DM(s) and ${follows.length} follow event(s) from X. ` +
          'Inbound messages are conversations the other person started, so they can be answered ' +
          'without the opt-in problem that outbound DMs have.',
        confidence: 1,
        model: 'x-webhook',
        outputs: { dms: inbound.length, follows: follows.length },
      });
    }

    return json({ received: true, dms: inbound.length, follows: follows.length });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
