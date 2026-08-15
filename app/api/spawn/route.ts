import { spawn } from '@/lib/spawn';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/spawn { "niche": "..." }
 *
 * Niche string in; a deployed, checkout-wired business out. Target is under
 * four minutes end to end — the response carries the measured `elapsedMs` and a
 * per-stage breakdown so the claim is checkable rather than asserted.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { niche?: string };
    const niche = String(body.niche ?? '').trim();
    if (!niche) return json({ error: 'niche is required' }, { status: 400 });
    if (niche.length > 200) return json({ error: 'niche is too long' }, { status: 400 });

    const result = await spawn({ niche });

    return json(result, { status: result.ok ? 200 : 409 });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
