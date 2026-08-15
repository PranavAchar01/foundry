import * as cohort from '@/lib/cohort';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Who Foundry is permitted to contact, plus the pool the sweep streams. */
export async function GET() {
  try {
    const { query } = await import('@/lib/db');
    const pool = await query<{ username: string }>(
      `SELECT username FROM audience_members WHERE username <> '' ORDER BY followers DESC LIMIT 600`,
    );

    /*
     * The label shown against a shortlisted handle is the segment the
     * clustering actually placed them in — real evidence from their profile.
     * The cohort note is a contact permission, not a reason to target someone,
     * so it stays server-side.
     */
    const members = await query<{ username: string; bio: string; segment: string | null }>(
      `SELECT m.username, m.bio, s.label AS segment
         FROM audience_members m
         LEFT JOIN audience_segments s ON s.id = m.segment_id
        WHERE m.username <> ''`,
    );
    const evidence = new Map(members.map((m) => [m.username.toLowerCase(), m]));

    const list = (await cohort.list()).map((c) => {
      const m = evidence.get(c.username.toLowerCase());
      const bio = ((m?.bio || c.bio) ?? '').replace(/\s+/g, ' ').trim();
      return {
        ...c,
        segment: m?.segment ?? null,
        inNetwork: Boolean(m),
        evidence: m?.segment ?? (bio ? bio.slice(0, 70) : 'matched on profile signals'),
      };
    });

    return json({ cohort: list, pool: pool.map((p) => p.username) });
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
      hydrate?: boolean;
    };

    if (body.hydrate) {
      const result = await cohort.hydrate();
      return json({ ...result, cohort: await cohort.list() }, { status: result.error ? 502 : 200 });
    }

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
