import * as session from '@/lib/session';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Record the visitor's own X app credentials against their session.
 *
 * Bringing your own app is what makes the rest of this yours: the tokens minted
 * in the next step belong to that app, so the reads and the messages count
 * against your quota and appear as your handle rather than the deployment's.
 *
 * Write-only by design. The secret is never returned by any endpoint, including
 * this one.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      clientId?: string;
      clientSecret?: string;
    };
    const clientId = String(body.clientId ?? '').trim();
    const clientSecret = String(body.clientSecret ?? '').trim();

    if (!clientId || !clientSecret) {
      return json({ error: 'clientId and clientSecret are both required' }, { status: 400 });
    }

    const row = await session.ensure();
    await session.setCredentials(row.id, clientId, clientSecret);
    return json(await session.describe(row.id));
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
