import { runCycle } from '@/lib/ceo';
import { env } from '@/lib/env';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The CEO loop's entry point. Vercel Cron calls this on the schedule in
 * vercel.json; it can also be poked by hand with CRON_SECRET.
 *
 * Vercel signs its own cron invocations with an `x-vercel-cron` header. When
 * CRON_SECRET is set, everything else must present it.
 */
function authorized(req: Request): boolean {
  if (req.headers.get('x-vercel-cron')) return true;
  if (!env.cronSecret) return true;
  const auth = req.headers.get('authorization') ?? '';
  const url = new URL(req.url);
  return auth === `Bearer ${env.cronSecret}` || url.searchParams.get('secret') === env.cronSecret;
}

async function run(req: Request) {
  if (!authorized(req)) return json({ error: 'unauthorized' }, { status: 401 });

  try {
    const url = new URL(req.url);
    const result = await runCycle({
      spawn: url.searchParams.get('spawn') !== '0',
      niche: url.searchParams.get('niche') ?? undefined,
    });
    return json(result);
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
