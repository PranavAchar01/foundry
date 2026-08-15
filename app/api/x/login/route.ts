import { NextResponse } from 'next/server';
import { beginAuthorization } from '@/lib/x';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Starts the X OAuth 2.0 PKCE flow.
 *
 * This is the one step that cannot be automated: reading an account's following
 * list requires user context, and user context requires the account holder to
 * approve the scopes in a browser. Open this URL once; the callback stores the
 * tokens and everything after it runs headlessly on the refresh token.
 */
export async function GET(req: Request) {
  try {
    const { url } = await beginAuthorization();
    // ?json=1 returns the URL instead of redirecting, for scripted setup.
    if (new URL(req.url).searchParams.get('json') === '1') return json({ authorizeUrl: url });
    return NextResponse.redirect(url);
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
