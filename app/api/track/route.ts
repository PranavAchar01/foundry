import * as businesses from '@/lib/businesses';
import { errorMessage, json, preflight } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return preflight();
}

/**
 * The pageview beacon every spawned page fires on load. This is the only source
 * of the `visitors` number the CEO agent reads, which is the point: traffic is
 * measured, never asserted.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      businessId?: string;
      path?: string;
      referrer?: string;
      source?: string;
    };
    const businessId = String(body.businessId ?? '');
    if (!businessId) return json({ error: 'businessId is required' }, { status: 400, cors: true });

    const business = await businesses.get(businessId);
    if (!business) return json({ error: 'unknown business' }, { status: 404, cors: true });

    await businesses.recordVisit(businessId, {
      path: body.path,
      referrer: body.referrer,
      source: body.source,
    });

    return json({ ok: true }, { cors: true });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500, cors: true });
  }
}
