import * as audience from '@/lib/audience';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Reads one page of the connected account's following list.
 *
 * Paged deliberately — X's read quota is the scarce resource, so the caller
 * decides how deep to go rather than the system walking the whole graph.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { pageSize?: number; pageToken?: string };
    const result = await audience.sync(
      Math.min(Number(body.pageSize ?? 100), 1000),
      body.pageToken,
    );
    return json(result, { status: result.error ? 502 : 200 });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
