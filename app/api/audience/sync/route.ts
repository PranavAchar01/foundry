import * as audience from '@/lib/audience';
import * as session from '@/lib/session';
import type { XActor } from '@/lib/x';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Reads one page of the connected account's following list.
 *
 * Paged deliberately — X's read quota is the scarce resource, so the caller
 * decides how deep to go rather than the system walking the whole graph.
 *
 * Whose following list, and whose quota, follows the site's mode: the
 * deployment's own account when it is shared, the caller's own when
 * FOUNDRY_X_MULTI_TENANT is on.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { pageSize?: number; pageToken?: string };
    const gate = await session.requireConnected();
    if (!gate.ok) return json({ error: gate.error }, { status: 401 });
    const actor: XActor = gate.actor;

    const result = await audience.sync(
      actor,
      Math.min(Number(body.pageSize ?? 100), 1000),
      body.pageToken,
    );
    return json(result, { status: result.error ? 502 : 200 });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
