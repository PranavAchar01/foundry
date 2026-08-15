import * as machine from '@/lib/machine';
import { env } from '@/lib/env';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Force every live machine onto the current serve.pl.
 *
 * The CEO cycle does this on its own through `meterAndPark`, but that only
 * reaches machines it does not first decide to park, so a fleet can lag a
 * release. This applies the upgrade to all of them at once and reports what
 * each one is now serving — which also makes it obvious when production itself
 * is running an older build.
 */
export async function POST(req: Request) {
  if (env.cronSecret) {
    const auth = req.headers.get('authorization') ?? '';
    const secret = new URL(req.url).searchParams.get('secret');
    if (auth !== `Bearer ${env.cronSecret}` && secret !== env.cronSecret) {
      return json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  try {
    const results = await machine.upgradeAll();
    return json({
      serveVersion: machine.SERVE_VERSION,
      upgraded: results.filter((r) => r.ok).length,
      total: results.length,
      results,
    });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
