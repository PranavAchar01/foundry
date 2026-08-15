import { id, one, query } from './db';
import * as x from './x';

/**
 * The contactable allowlist.
 *
 * Foundry's outreach path physically cannot message an account that is not in
 * this table. For the hackathon it holds the handful of people who volunteered,
 * which is what makes the demo's DMs solicited rather than cold.
 *
 * It is a safety mechanism, not a product surface — nothing in the demo flow
 * shows it off. If the outreach model later becomes lawful at scale, what
 * changes is the policy that populates this table, not the fact that the send
 * path checks it.
 */

export interface CohortMember {
  id: string;
  username: string;
  x_user_id: string;
  note: string;
  followed: boolean;
  dm_sent_at: string | null;
  created_at: string;
}

/** Records that someone agreed to be contacted, and resolves their X id. */
export async function add(username: string, note = 'volunteered for the demo'): Promise<CohortMember> {
  const handle = username.replace(/^@/, '').trim();
  if (!handle) throw new Error('username is required');

  // Resolve the handle now so the send path never has to guess.
  let xUserId = '';
  try {
    const profile = await x.lookupByUsername(handle);
    xUserId = profile?.id ?? '';
  } catch {
    xUserId = '';
  }

  const rows = await query<CohortMember>(
    `INSERT INTO consent_cohort (id, username, x_user_id, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE SET
       x_user_id = COALESCE(NULLIF(EXCLUDED.x_user_id, ''), consent_cohort.x_user_id),
       note = EXCLUDED.note
     RETURNING *`,
    [id('coh'), handle, xUserId, note.slice(0, 300)],
  );
  return rows[0];
}

export async function list(): Promise<CohortMember[]> {
  return query<CohortMember>(`SELECT * FROM consent_cohort ORDER BY created_at ASC`);
}

export async function remove(username: string): Promise<void> {
  await query(`DELETE FROM consent_cohort WHERE username = $1`, [username.replace(/^@/, '')]);
}

/** The gate. Every follow and every DM goes through this. */
export async function isAllowed(username: string): Promise<CohortMember | null> {
  return one<CohortMember>(`SELECT * FROM consent_cohort WHERE username = $1`, [
    username.replace(/^@/, ''),
  ]);
}

export async function markFollowed(username: string): Promise<void> {
  await query(`UPDATE consent_cohort SET followed = true WHERE username = $1`, [
    username.replace(/^@/, ''),
  ]);
}

export async function markDmSent(username: string): Promise<void> {
  await query(`UPDATE consent_cohort SET dm_sent_at = now() WHERE username = $1`, [
    username.replace(/^@/, ''),
  ]);
}
