import { createHash, randomBytes } from 'node:crypto';
import { env } from './env';
import { one, query } from './db';

/**
 * X (Twitter) API v2 client.
 *
 * Reading an audience needs **user context**, not an app-only bearer: the
 * following list is scoped to the authenticated account. X's OAuth 2.0 app
 * credentials only work through the Authorization Code + PKCE redirect, which
 * is why this module exists — `/api/x/login` starts it, `/api/x/callback`
 * finishes it, and the tokens are stored and refreshed here.
 *
 * The client credentials alone cannot mint a token headlessly; `oauth2/token`
 * with `grant_type=client_credentials` expects the older consumer key pair and
 * returns 403 for OAuth 2.0 app credentials.
 */

const API = 'https://api.x.com';
const AUTHORIZE = 'https://x.com/i/oauth2/authorize';
const TOKEN = 'https://api.x.com/2/oauth2/token';

/**
 * Read the audience, plus the two writes the consented demo cohort needs.
 *
 * `follows.write` and `dm.write` are only ever exercised against accounts that
 * appear in `consent_cohort` — see lib/cohort.ts. Adding a scope does not widen
 * who can be contacted; the cohort table does that, and only you can write to it.
 */
export const SCOPES = [
  'users.read',
  'follows.read',
  'follows.write',
  'tweet.read',
  'dm.read',
  'dm.write',
  'offline.access',
];

export interface XAccount {
  id: string;
  x_user_id: string;
  username: string;
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_at: string | null;
}

/**
 * Whose account a call acts as.
 *
 * `'server'` is the deployment's own account: the cron loops, which have no
 * browser behind them. Everything driven by a visitor carries their session id
 * instead.
 *
 * This is an explicit parameter rather than implicit request-scoped state on
 * purpose. An implicit default is precisely how a visitor's request ends up
 * spending the owner's rate limit and messaging from the owner's handle, and
 * the failure is silent: it looks like it worked.
 */
export type XActor = 'server' | { sessionId: string };

interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * The X app a given actor authorizes against.
 *
 * A visitor brings their own, so the tokens they mint belong to their app and
 * count against their quota rather than the deployment's.
 */
async function credentialsFor(actor: XActor): Promise<AppCredentials> {
  if (actor === 'server') {
    if (!env.xClientId) throw new Error('X_CLIENT_ID is not set');
    return { clientId: env.xClientId, clientSecret: env.xClientSecret };
  }

  const row = await one<{ client_id: string; client_secret: string }>(
    `SELECT client_id, client_secret FROM x_sessions WHERE id = $1`,
    [actor.sessionId],
  );
  if (!row?.client_id || !row.client_secret) {
    throw new Error('this session has not supplied its own X app credentials');
  }
  return { clientId: row.client_id, clientSecret: row.client_secret };
}

// ---------------------------------------------------------------------------
// OAuth 2.0 Authorization Code with PKCE
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function beginAuthorization(
  actor: XActor = 'server',
): Promise<{ url: string; state: string }> {
  const { clientId } = await credentialsFor(actor);

  const state = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  await query(
    `INSERT INTO x_oauth_states (state, code_verifier, session_id) VALUES ($1, $2, $3)
     ON CONFLICT (state) DO UPDATE SET code_verifier = EXCLUDED.code_verifier`,
    [state, codeVerifier, actor === 'server' ? null : actor.sessionId],
  );

  const url = new URL(AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', env.xCallbackUrl);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state };
}

function basicAuth(creds: AppCredentials): string {
  return Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
}

export async function completeAuthorization(code: string, state: string): Promise<XAccount> {
  const row = await one<{ code_verifier: string; session_id: string | null }>(
    `SELECT code_verifier, session_id FROM x_oauth_states WHERE state = $1`,
    [state],
  );
  if (!row) throw new Error('unknown or expired OAuth state');

  // The session is read from the state row rather than the incoming request, so
  // a callback cannot be redirected into a different session than the one that
  // started the flow.
  const actor: XActor = row.session_id ? { sessionId: row.session_id } : 'server';
  const creds = await credentialsFor(actor);

  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(creds)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.xCallbackUrl,
      code_verifier: row.code_verifier,
      client_id: creds.clientId,
    }),
  });

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`x token exchange failed: ${res.status} ${json.error_description ?? json.error ?? ''}`);
  }

  await query(`DELETE FROM x_oauth_states WHERE state = $1`, [state]);

  const me = await fetch(`${API}/2/users/me`, {
    headers: { Authorization: `Bearer ${json.access_token}` },
  }).then((r) => r.json() as Promise<{ data?: { id: string; username: string } }>);

  /*
   * A visitor's authorization is keyed on their session, so it can never
   * overwrite the deployment's own account. Only the server flow writes
   * 'x_primary'.
   */
  const rows = await query<XAccount>(
    actor === 'server'
      ? `INSERT INTO x_accounts (id, x_user_id, username, access_token, refresh_token, scope, expires_at)
         VALUES ('x_primary', $1, $2, $3, $4, $5, now() + make_interval(secs => $6))
         ON CONFLICT (id) DO UPDATE SET
           x_user_id = EXCLUDED.x_user_id, username = EXCLUDED.username,
           access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
           scope = EXCLUDED.scope, expires_at = EXCLUDED.expires_at, updated_at = now()
         RETURNING *`
      : `INSERT INTO x_accounts (id, x_user_id, username, access_token, refresh_token, scope, expires_at, session_id)
         VALUES ($7, $1, $2, $3, $4, $5, now() + make_interval(secs => $6), $8)
         ON CONFLICT (session_id) WHERE session_id IS NOT NULL DO UPDATE SET
           x_user_id = EXCLUDED.x_user_id, username = EXCLUDED.username,
           access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
           scope = EXCLUDED.scope, expires_at = EXCLUDED.expires_at, updated_at = now()
         RETURNING *`,
    [
      me.data?.id ?? '',
      me.data?.username ?? '',
      json.access_token,
      json.refresh_token ?? '',
      json.scope ?? '',
      json.expires_in ?? 7200,
      ...(actor === 'server' ? [] : [`xac_${row.session_id}`.slice(0, 120), row.session_id]),
    ],
  );
  return rows[0];
}

export async function account(actor: XActor = 'server'): Promise<XAccount | null> {
  return actor === 'server'
    ? one<XAccount>(`SELECT * FROM x_accounts WHERE id = 'x_primary'`)
    : one<XAccount>(`SELECT * FROM x_accounts WHERE session_id = $1`, [actor.sessionId]);
}

/**
 * A valid access token for this actor, refreshed if it is close to expiry.
 *
 * There is deliberately no fallback from a session to the server account. A
 * visitor whose authorization is missing gets an error, because the alternative
 * is quietly acting as the owner.
 */
async function accessToken(actor: XActor): Promise<string> {
  const acct = await account(actor);
  if (!acct) {
    throw new Error(
      actor === 'server'
        ? 'no X account connected — visit /api/x/login to authorize'
        : 'connect your own X account before running this',
    );
  }

  const expiresAt = acct.expires_at ? new Date(acct.expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 60_000) return acct.access_token;
  if (!acct.refresh_token) return acct.access_token;

  const creds = await credentialsFor(actor);
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(creds)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: acct.refresh_token,
      client_id: creds.clientId,
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !json.access_token) return acct.access_token;

  await query(
    `UPDATE x_accounts SET access_token = $1, refresh_token = COALESCE(NULLIF($2,''), refresh_token),
            expires_at = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $4`,
    [json.access_token, json.refresh_token ?? '', json.expires_in ?? 7200, acct.id],
  );
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Reading the audience
// ---------------------------------------------------------------------------

export interface XProfile {
  id: string;
  username: string;
  name: string;
  description: string;
  followers: number;
}

export interface FollowingPage {
  profiles: XProfile[];
  nextToken: string | null;
  /** Set when X refused the read — quota, permission, or tier. */
  error: string | null;
}

/**
 * One page of the authenticated account's following list.
 *
 * Deliberately paged rather than exhaustive: on the Basic tier the monthly read
 * budget is small enough that walking a large graph would spend it in one call.
 * Callers decide how deep to go.
 */
export async function following(
  actor: XActor,
  maxResults = 100,
  paginationToken?: string,
): Promise<FollowingPage> {
  const acct = await account();
  if (!acct) return { profiles: [], nextToken: null, error: 'no X account connected' };

  const token = await accessToken(actor);

  /*
   * Whose network gets read.
   *
   * The deployment's own account is pointed at X_AUDIENCE_HANDLE: it holds the
   * tokens and does the following and the messaging, but the network worth
   * segmenting belongs to someone else, and reading another account's public
   * following list is permitted with user context.
   *
   * A visitor gets their own following list and nothing else. Pointing their
   * run at the configured handle would hand them the owner's network, which is
   * the thing sessions exist to prevent.
   */
  let sourceId = acct.x_user_id;
  if (actor === 'server' && env.xAudienceHandle) {
    const target = await lookupByUsername(actor, env.xAudienceHandle).catch(() => null);
    if (!target) {
      return {
        profiles: [], nextToken: null,
        error: `could not resolve X_AUDIENCE_HANDLE @${env.xAudienceHandle}`,
      };
    }
    sourceId = target.id;
  }

  const url = new URL(`${API}/2/users/${sourceId}/following`);
  url.searchParams.set('max_results', String(Math.min(maxResults, 1000)));
  url.searchParams.set('user.fields', 'description,public_metrics,username,name');
  if (paginationToken) url.searchParams.set('pagination_token', paginationToken);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { id: string; username: string; name: string; description?: string; public_metrics?: { followers_count?: number } }[];
    meta?: { next_token?: string };
    detail?: string;
    title?: string;
  };

  if (!res.ok) {
    return {
      profiles: [],
      nextToken: null,
      error: `x following -> ${res.status} ${json.title ?? ''} ${json.detail ?? ''}`.trim(),
    };
  }

  return {
    profiles: (json.data ?? []).map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      description: u.description ?? '',
      followers: u.public_metrics?.followers_count ?? 0,
    })),
    nextToken: json.meta?.next_token ?? null,
    error: null,
  };
}

/** Stores a page of profiles for clustering. Public profile fields only. */
export async function storeProfiles(profiles: XProfile[]): Promise<number> {
  let stored = 0;
  for (const p of profiles) {
    await query(
      `INSERT INTO audience_members (id, source, external_id, username, bio, followers)
       VALUES ($1, 'x', $2, $3, $4, $5)
       ON CONFLICT (source, external_id) DO UPDATE SET
         username = EXCLUDED.username, bio = EXCLUDED.bio,
         followers = EXCLUDED.followers, fetched_at = now()`,
      [`aud_x_${p.id}`, p.id, p.username, p.description.slice(0, 500), p.followers],
    );
    stored++;
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Writes. Every one of these is gated on recorded consent by its caller.
// ---------------------------------------------------------------------------

/** Resolves a handle to its numeric id. */
/**
 * Resolve up to 100 handles in one request.
 *
 * The per-handle endpoint is cheap to call but expensive to call eight times:
 * X's user-lookup quota is per-request, not per-user, so a loop over a small
 * allowlist can exhaust the window and fail silently. One batch call cannot.
 */
export async function lookupMany(
  actor: XActor,
  usernames: string[],
): Promise<{ profiles: XProfile[]; error: string | null }> {
  const handles = usernames.map((u) => u.replace(/^@/, '').trim()).filter(Boolean).slice(0, 100);
  if (!handles.length) return { profiles: [], error: null };

  const token = await accessToken(actor);
  const url = new URL(`${API}/2/users/by`);
  url.searchParams.set('usernames', handles.join(','));
  url.searchParams.set('user.fields', 'description,public_metrics');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { id: string; username: string; name: string; description?: string; public_metrics?: { followers_count?: number } }[];
    detail?: string;
    title?: string;
  };
  if (!res.ok) return { profiles: [], error: json.detail ?? json.title ?? `x users/by ${res.status}` };

  return {
    profiles: (json.data ?? []).map((d) => ({
      id: d.id,
      username: d.username,
      name: d.name,
      description: d.description ?? '',
      followers: d.public_metrics?.followers_count ?? 0,
    })),
    error: null,
  };
}

export async function lookupByUsername(actor: XActor, username: string): Promise<XProfile | null> {
  const token = await accessToken(actor);
  const handle = username.replace(/^@/, '');
  const res = await fetch(
    `${API}/2/users/by/username/${encodeURIComponent(handle)}?user.fields=description,public_metrics`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = (await res.json().catch(() => ({}))) as {
    data?: { id: string; username: string; name: string; description?: string; public_metrics?: { followers_count?: number } };
  };
  if (!res.ok || !json.data) return null;
  return {
    id: json.data.id,
    username: json.data.username,
    name: json.data.name,
    description: json.data.description ?? '',
    followers: json.data.public_metrics?.followers_count ?? 0,
  };
}

export async function follow(actor: XActor, targetUserId: string): Promise<{ ok: boolean; error: string | null }> {
  const acct = await account();
  if (!acct) return { ok: false, error: 'no X account connected' };
  const token = await accessToken(actor);
  const res = await fetch(`${API}/2/users/${acct.x_user_id}/following`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ target_user_id: targetUserId }),
  });
  const json = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
  return res.ok
    ? { ok: true, error: null }
    : { ok: false, error: `${res.status} ${json.title ?? ''} ${json.detail ?? ''}`.trim() };
}

/** Sends a DM. Callers must have verified consent first. */
export async function sendDm(
  actor: XActor,
  targetUserId: string,
  text: string,
): Promise<{ ok: boolean; id: string | null; error: string | null }> {
  const token = await accessToken(actor);
  const res = await fetch(`${API}/2/dm_conversations/with/${targetUserId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 10000) }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { dm_event_id?: string };
    detail?: string;
    title?: string;
  };
  return res.ok
    ? { ok: true, id: json.data?.dm_event_id ?? null, error: null }
    : { ok: false, id: null, error: `${res.status} ${json.title ?? ''} ${json.detail ?? ''}`.trim() };
}

export interface DmEvent {
  id: string;
  senderId: string;
  text: string;
  createdAt: string;
}

/**
 * Recent DM events across every conversation the account is in.
 *
 * Read rather than pushed: the Account Activity webhook delivers these too, but
 * polling works on any tier and does not depend on that product being enabled.
 */
export async function dmEvents(actor: XActor, maxResults = 50): Promise<{ events: DmEvent[]; error: string | null }> {
  const acct = await account();
  if (!acct) return { events: [], error: 'no X account connected' };
  const token = await accessToken(actor);

  const url = new URL(`${API}/2/dm_events`);
  url.searchParams.set('max_results', String(Math.min(maxResults, 100)));
  url.searchParams.set('dm_event.fields', 'id,text,created_at,sender_id,dm_conversation_id');
  url.searchParams.set('event_types', 'MessageCreate');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { id: string; text?: string; sender_id?: string; created_at?: string }[];
    title?: string;
    detail?: string;
  };
  if (!res.ok) {
    return { events: [], error: `x dm_events -> ${res.status} ${json.title ?? ''} ${json.detail ?? ''}`.trim() };
  }
  return {
    events: (json.data ?? []).map((d) => ({
      id: d.id,
      senderId: d.sender_id ?? '',
      text: d.text ?? '',
      createdAt: d.created_at ?? '',
    })),
    error: null,
  };
}

export async function audienceSize(): Promise<number> {
  const rows = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM audience_members`);
  return Number(rows[0]?.n ?? 0);
}
