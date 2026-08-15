import { restyleAll } from '@/lib/spawn';
import { env } from '@/lib/env';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Redeploy every live storefront with the current page template.
 *
 * Spawned sites are static, so a template change only reaches businesses
 * spawned after it. This brings the existing ones forward without touching
 * their URLs or their records.
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
    // Default is repair-only. `?all=1` forces every storefront to be rebuilt.
    const all = new URL(req.url).searchParams.get('all') === '1';
    const results = await restyleAll({ onlyBroken: !all });
    return json({ restyled: results.filter((r) => r.ok).length, total: results.length, results });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
