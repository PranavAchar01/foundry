import * as prospects from '@/lib/prospects';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `{"action":"sent"}` records that YOU sent it; `{"action":"reject"}` bins it.
 * There is deliberately no action that makes Foundry send a DM.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string; why?: string };

    if (body.action === 'sent') {
      const row = await prospects.markSent(id);
      return row ? json(row) : json({ error: 'unknown draft' }, { status: 404 });
    }
    if (body.action === 'reject') {
      const row = await prospects.reject(id, body.why ?? 'not a fit');
      return row ? json(row) : json({ error: 'unknown draft' }, { status: 404 });
    }
    return json({ error: 'action must be "sent" or "reject"' }, { status: 400 });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
