import * as session from '@/lib/session';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who this browser is, and how far through connecting it has got.
 *
 * Creates the session on first read, so simply opening the site is enough to
 * get an identity. Returns nothing replayable: no client secret, no access
 * token, only whether they exist and which handle was authorized.
 */
export async function GET() {
  try {
    const row = await session.ensure();
    return json(await session.describe(row.id));
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
