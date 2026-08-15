import { completeAuthorization } from '@/lib/x';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Where X sends the account holder back. Exchanges the code for tokens. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');

  if (denied) {
    return json({ error: `authorization declined: ${denied}` }, { status: 400 });
  }
  if (!code || !state) {
    return json({ error: 'missing code or state' }, { status: 400 });
  }

  try {
    const account = await completeAuthorization(code, state);
    return json({
      connected: true,
      username: account.username,
      scope: account.scope,
      next: 'POST /api/audience/sync to read the following list',
    });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 502 });
  }
}
