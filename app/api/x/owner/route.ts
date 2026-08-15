import { NextResponse } from 'next/server';
import * as session from '@/lib/session';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bind this browser to the deployment's own X account.
 *
 * Sessions arrived after the owner had already authorized, so without this the
 * owner would be signed out by their own change. This sets the existing row's
 * session and nothing else: no token is minted, nothing is re-authorized, and
 * an account a visitor connected cannot be claimed this way.
 *
 *   /api/x/owner?key=<FOUNDRY_OWNER_KEY>
 */
export async function GET(req: Request) {
  try {
    const key = new URL(req.url).searchParams.get('key') ?? '';
    const row = await session.ensure();

    if (!(await session.claimOwner(row.id, key))) {
      return json({ error: 'wrong or unset owner key' }, { status: 403 });
    }
    return NextResponse.redirect(new URL('/', req.url));
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
