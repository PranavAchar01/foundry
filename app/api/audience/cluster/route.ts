import * as audience from '@/lib/audience';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Groups the stored audience into segments worth building for.
 *
 * Operates on bios with handles withheld: the model is grouping descriptions of
 * work, and it is not given the identities that would let it reason about a
 * specific person.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { sampleSize?: number };
    const result = await audience.cluster(Math.min(Number(body.sampleSize ?? 300), 1000));
    return json(result);
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 400 });
  }
}
