import * as cohort from '@/lib/cohort';
import * as decisions from '@/lib/decisions';
import { deriveNiche, PLAN_ACTION, type PlannedTarget } from '@/lib/personal';
import { query } from '@/lib/db';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Stage one of the run: decide what to build, for whom.
 *
 * The unit is the person, not the segment. Everyone here is on the contact
 * allowlist — they agreed to be contacted — and each one gets a product derived
 * from the recurring chore in their own public bio, which is what makes the
 * eight businesses this run spawns eight different businesses.
 *
 * Nothing is built or sent here. /build and /reach are separate calls per
 * person so each stays well inside the function timeout and the tiles arrive
 * one at a time instead of all at the end.
 */
export async function POST() {
  try {
    const runId = decisions.newCycleId();

    const [allowed, poolRows] = await Promise.all([
      cohort.list(),
      // The follow graph, for the scan reel: real handles, read in the same
      // order the sweep reads them.
      query<{ username: string }>(
        `SELECT username FROM audience_members WHERE username <> '' ORDER BY followers DESC LIMIT 600`,
      ),
    ]);
    const pool = poolRows.map((p) => p.username);

    if (!allowed.length) {
      return json({
        runId,
        pool,
        targets: [],
        error: 'the contact allowlist is empty — there is nobody this run is permitted to build for',
      });
    }

    /*
     * Not everyone on the allowlist is in the follow graph. Where they are, the
     * network's copy of the bio is the fresher one and the clustering has
     * already placed them in a segment; where they are not, the allowlist's own
     * bio is the only evidence there is.
     */
    const known = await query<{ username: string; bio: string; segment: string | null }>(
      `SELECT m.username, m.bio, s.label AS segment
         FROM audience_members m
         LEFT JOIN audience_segments s ON s.id = m.segment_id
        WHERE lower(m.username) = ANY($1::text[])`,
      [allowed.map((a) => a.username.toLowerCase())],
    );
    const inNetwork = new Map(known.map((k) => [k.username.toLowerCase(), k]));

    // Concurrently, not in a loop: eight sequential model calls is most of a
    // minute of dead air in the middle of a live run.
    const targets: PlannedTarget[] = await Promise.all(
      allowed.map(async (member) => {
        const found = inNetwork.get(member.username.toLowerCase());
        const bio = (found?.bio || member.bio || '').replace(/\s+/g, ' ').trim();
        return {
          username: member.username,
          bio,
          evidence: bio
            ? clip(bio, 90)
            : found?.segment ?? 'on the contact allowlist; no public bio to read',
          niche: await deriveNiche({ username: member.username, bio }),
        };
      }),
    );

    await decisions.record({
      cycleId: runId,
      action: PLAN_ACTION,
      reasoning:
        `Planned a per-person run across ${targets.length} allowlisted account(s), read against a ` +
        `${pool.length}-account follow graph. ` +
        targets
          .map((t) => `@${t.username} → ${t.niche.name} at $${(t.niche.priceCents / 100).toFixed(2)}/mo`)
          .join('; ') +
        '. Each product was derived from that person\'s own public bio rather than from a market ' +
        'segment, so every business this run spawns is built for one named person who agreed to ' +
        'be contacted.',
      confidence: 0.7,
      inputs: { allowlisted: allowed.length, pool: pool.length },
      outputs: { targets },
    });

    return json({ runId, pool, targets });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}

/** Cuts at a word boundary — the evidence line is read, not parsed. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
