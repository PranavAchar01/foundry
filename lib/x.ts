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

// ---------------------------------------------------------------------------
// OAuth 2.0 Authorization Code with PKCE
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function beginAuthorization(): Promise<{ url: string; state: string }> {
  if (!env.xClientId) throw new Error('X_CLIENT_ID is not set');

  const state = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  await query(
    `INSERT INTO x_oauth_states (state, code_verifier) VALUES ($1, $2)
     ON CONFLICT (state) DO UPDATE SET code_verifier = EXCLUDED.code_verifier`,
    [state, codeVerifier],
  );

  const url = new URL(AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.xClientId);
  url.searchParams.set('redirect_uri', env.xCallbackUrl);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state };
}

function basicAuth(): string {
  return Buffer.from(`${env.xClientId}:${env.xClientSecret}`).toString('base64');
}

export async function completeAuthorization(code: string, state: string): Promise<XAccount> {
  const row = await one<{ code_verifier: string }>(
    `SELECT code_verifier FROM x_oauth_states WHERE state = $1`,
    [state],
  );
  if (!row) throw new Error('unknown or expired OAuth state');

  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.xCallbackUrl,
      code_verifier: row.code_verifier,
      client_id: env.xClientId,
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

  const rows = await query<XAccount>(
    `INSERT INTO x_accounts (id, x_user_id, username, access_token, refresh_token, scope, expires_at)
     VALUES ('x_primary', $1, $2, $3, $4, $5, now() + make_interval(secs => $6))
     ON CONFLICT (id) DO UPDATE SET
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
    ],
  );
  return rows[0];
}

export async function account(): Promise<XAccount | null> {
  return one<XAccount>(`SELECT * FROM x_accounts WHERE id = 'x_primary'`);
}

/** Returns a valid access token, refreshing first when it is close to expiry. */
async function accessToken(): Promise<string> {
  const acct = await account();
  if (!acct) throw new Error('no X account connected — visit /api/x/login to authorize');

  const expiresAt = acct.expires_at ? new Date(acct.expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 60_000) return acct.access_token;
  if (!acct.refresh_token) return acct.access_token;

  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: acct.refresh_token,
      client_id: env.xClientId,
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
      WHERE id = 'x_primary'`,
    [json.access_token, json.refresh_token ?? '', json.expires_in ?? 7200],
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
export async function following(maxResults = 100, paginationToken?: string): Promise<FollowingPage> {
  const acct = await account();
  if (!acct) return { profiles: [], nextToken: null, error: 'no X account connected' };

  const token = await accessToken();
  const url = new URL(`${API}/2/users/${acct.x_user_id}/following`);
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
export async function lookupByUsername(username: string): Promise<XProfile | null> {
  const token = await accessToken();
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

export async function follow(targetUserId: string): Promise<{ ok: boolean; error: string | null }> {
  const acct = await account();
  if (!acct) return { ok: false, error: 'no X account connected' };
  const token = await accessToken();
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
  targetUserId: string,
  text: string,
): Promise<{ ok: boolean; id: string | null; error: string | null }> {
  const token = await accessToken();
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

export async function audienceSize(): Promise<number> {
  const rows = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM audience_members`);
  return Number(rows[0]?.n ?? 0);
}
