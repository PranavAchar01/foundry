import * as audience from '@/lib/audience';
import { listings } from '@/lib/hiring';
import { account, audienceSize } from '@/lib/x';
import { env } from '@/lib/env';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Current state of the audience pipeline. */
export async function GET() {
  try {
    const [connected, size, segs, hires] = await Promise.all([
      account(),
      audienceSize(),
      audience.segments(),
      listings(15),
    ]);

    return json({
      x: connected
        ? { connected: true, username: connected.username, scope: connected.scope }
        : { connected: false, authorizeUrl: '/api/x/login' },
      audience: { members: size },
      payoutShare: env.laborPayoutShare,
      segments: segs,
      listings: hires,
    });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
