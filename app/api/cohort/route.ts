import * as cohort from '@/lib/cohort';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Who Foundry is permitted to contact. Nothing else can be messaged. */
export async function GET() {
  try {
    return json({ cohort: await cohort.list() });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}

/** `{"usernames":["a","b"]}` records that these people agreed to be contacted. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      usernames?: string[];
      note?: string;
      remove?: string;
    };

    if (body.remove) {
      await cohort.remove(body.remove);
      return json({ removed: body.remove, cohort: await cohort.list() });
    }

    const added = [];
    for (const u of body.usernames ?? []) {
      added.push(await cohort.add(u, body.note ?? 'volunteered for the demo'));
    }
    return json({ added: added.length, cohort: await cohort.list() });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 400 });
  }
}
