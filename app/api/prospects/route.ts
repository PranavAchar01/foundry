import * as prospects from '@/lib/prospects';
import * as audience from '@/lib/audience';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** The review queue: what the agent wrote, and what you have sent. */
export async function GET() {
  try {
    return json({
      note:
        'Drafts. Sending happens only through /api/demo/run and only to accounts on the ' +
        'contact allowlist (/api/cohort) — anyone else cannot be messaged.',
      drafts: await prospects.drafts(),
    });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}

/** Draft openers for a segment's shortlist. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      segmentId?: string;
      limit?: number;
      productUrl?: string;
    };
    const seg = await audience.segment(String(body.segmentId ?? ''));
    if (!seg) return json({ error: 'unknown segment' }, { status: 404 });

    const result = await prospects.draftForSegment(seg, {
      limit: body.limit ?? 10,
      productUrl: body.productUrl,
    });
    return json(result);
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 400 });
  }
}
