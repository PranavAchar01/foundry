import * as businesses from '@/lib/businesses';
import { env } from '@/lib/env';
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

    /*
     * The dashboard embeds each storefront to show its hero, and those are real
     * page loads that fire this beacon. Counting them would mean that looking
     * at the portfolio inflates the very number the CEO uses to decide whether
     * a business is dead. A load referred by Foundry itself is therefore
     * recorded — for honesty — but never counted as a visitor.
     */
    const referrer = body.referrer ?? '';
    let selfReferred = false;
    try {
      selfReferred = Boolean(referrer) && new URL(referrer).origin === new URL(env.publicUrl).origin;
    } catch {
      selfReferred = false;
    }

    /*
     * Same problem from the other direction: the QA provider drives the page in
     * headless Chromium before a spawn is trusted, and that executes the beacon
     * too. An automated check is not a customer.
     */
    const ua = req.headers.get('user-agent') ?? '';
    const automated = /headless|bot|crawler|spider|playwright|puppeteer|foundry-qa/i.test(ua);
    const uncounted = selfReferred || automated;

    await businesses.recordVisit(businessId, {
      path: body.path,
      referrer,
      source: selfReferred ? 'dashboard-preview' : automated ? 'automated-qa' : (body.source ?? 'organic'),
      counted: !uncounted,
    });

    return json({ ok: true, counted: !uncounted }, { cors: true });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500, cors: true });
  }
}
