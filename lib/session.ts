import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { one, query } from './db';
import { env } from './env';
import type { XActor } from './x';

/**
 * Per-visitor identity.
 *
 * The run this site offers follows and messages real people. A single shared
 * server identity would mean every visitor acting as whoever last authorized
 * the deployment: a stranger spending the owner's rate limit, from the owner's
 * handle, to the owner's contacts. So each browser gets a session, and the
 * session is what an X authorization attaches to.
 *
 * The cookie value is the whole credential, so it is 32 random bytes and
 * httpOnly. There is no login and no password to phish; losing the cookie loses
 * the session, which is the intended blast radius.
 */

const COOKIE = 'foundry_sid';
const YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface SessionRow {
  id: string;
  client_id: string;
  client_secret: string;
  created_at: string;
  last_seen_at: string;
}

/** The session's connected X account, if it has authorized one. */
export interface SessionAccount {
  username: string;
  x_user_id: string;
  scope: string;
}

/**
 * The current session id, without creating one.
 *
 * Returns null for a first-time visitor and for anything with no cookie jar at
 * all, which is what the cron loops look like.
 */
export async function currentId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE)?.value ?? null;
}

/**
 * The current session, creating and setting the cookie if there is none.
 *
 * Only callable from a route handler: setting a cookie needs a response to
 * write it onto.
 */
export async function ensure(): Promise<SessionRow> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;

  if (existing) {
    const row = await one<SessionRow>(`SELECT * FROM x_sessions WHERE id = $1`, [existing]);
    if (row) {
      await query(`UPDATE x_sessions SET last_seen_at = now() WHERE id = $1`, [existing]);
      return row;
    }
    // The cookie names a session the database no longer has. Fall through and
    // issue a new one rather than leaving the visitor in a state where every
    // request looks authenticated and nothing works.
  }

  const id = `ses_${randomBytes(32).toString('base64url')}`;
  const rows = await query<SessionRow>(
    `INSERT INTO x_sessions (id) VALUES ($1) RETURNING *`,
    [id],
  );

  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.publicUrl.startsWith('https://'),
    path: '/',
    maxAge: YEAR_SECONDS,
  });

  return rows[0];
}

/** Record the visitor's own X app credentials against their session. */
export async function setCredentials(
  sessionId: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await query(
    `UPDATE x_sessions SET client_id = $2, client_secret = $3, last_seen_at = now()
      WHERE id = $1`,
    [sessionId, clientId.trim(), clientSecret.trim()],
  );
}

export async function byId(sessionId: string): Promise<SessionRow | null> {
  return one<SessionRow>(`SELECT * FROM x_sessions WHERE id = $1`, [sessionId]);
}

/**
 * What the gate needs to decide what to show. Deliberately omits the client
 * secret and the access token: nothing that could be replayed leaves the server.
 */
export async function describe(sessionId: string | null): Promise<{
  hasSession: boolean;
  hasCredentials: boolean;
  account: SessionAccount | null;
  isOwner: boolean;
  /** False means one shared account and no gate. The interface reads this. */
  multiTenant: boolean;
}> {
  const multiTenant = env.xMultiTenant;

  if (!sessionId) {
    return { hasSession: false, hasCredentials: false, account: null, isOwner: false, multiTenant };
  }

  const session = await byId(sessionId);
  if (!session) {
    return { hasSession: false, hasCredentials: false, account: null, isOwner: false, multiTenant };
  }

  const account = await one<SessionAccount & { id: string }>(
    `SELECT id, username, x_user_id, scope FROM x_accounts WHERE session_id = $1`,
    [sessionId],
  );

  return {
    hasSession: true,
    hasCredentials: Boolean(session.client_id && session.client_secret),
    account: account ? { username: account.username, x_user_id: account.x_user_id, scope: account.scope } : null,
    // The owner is whoever holds the pre-existing server account, so their
    // connection survives this becoming multi-tenant.
    isOwner: account?.id === 'x_primary',
    multiTenant,
  };
}

/**
 * Bind this session to the server's original account.
 *
 * Exists so the owner is not signed out by the introduction of sessions. Their
 * tokens are never touched; only the row's session_id is set, which is why this
 * cannot be used to steal an account that a visitor authorized.
 */
export async function claimOwner(sessionId: string, key: string): Promise<boolean> {
  if (!env.ownerKey || key !== env.ownerKey) return false;
  const updated = await query(
    `UPDATE x_accounts SET session_id = $1
      WHERE id = 'x_primary' RETURNING id`,
    [sessionId],
  );
  return updated.length > 0;
}

/**
 * Who a visitor-driven request acts as, or a reason to refuse it.
 *
 * Every public entry point that spends money, reads a network, or writes to
 * someone goes through this, so the shared-versus-per-visitor decision is made
 * in one place rather than repeated at each route.
 *
 * With FOUNDRY_X_MULTI_TENANT off this hands back the deployment's own account
 * and refuses nobody: one shared identity, which is what a demo the owner
 * drives wants. With it on, a visitor must bring their own X app and authorize
 * their own account, and a missing one is refused rather than falling back —
 * because the fallback is the failure sessions exist to prevent, and it fails
 * silently: the run works, and it works as the owner.
 */
export async function requireConnected(): Promise<
  { ok: true; actor: XActor } | { ok: false; error: string }
> {
  if (!env.xMultiTenant) return { ok: true, actor: 'server' };

  const sessionId = await currentId();
  if (!sessionId) return { ok: false, error: 'connect your own X account first' };

  const state = await describe(sessionId);

  // The owner authorized against the deployment's own X app, before sessions
  // existed, so they have an account and no per-session credentials. Requiring
  // credentials of them would lock out the one account this preserves.
  if (state.isOwner) return { ok: true, actor: { sessionId } };

  if (!state.hasCredentials) {
    return { ok: false, error: 'add your own X app credentials first' };
  }
  if (!state.account) return { ok: false, error: 'connect your own X account first' };

  return { ok: true, actor: { sessionId } };
}
