'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The gate.
 *
 * Everything past this point follows and messages real people, so it has to
 * happen as the visitor rather than as whoever deployed this. Two steps: bring
 * your own X app, then authorize your own account against it. The tokens minted
 * belong to that app, so the reads count against your quota and the messages
 * come from your handle.
 *
 * The secret is write-only. It is posted once and never returned, so nothing
 * that could be replayed is ever in the page.
 */

export interface SessionState {
  hasSession: boolean;
  hasCredentials: boolean;
  account: { username: string; x_user_id: string; scope: string } | null;
  isOwner: boolean;
}

interface Props {
  state: SessionState | null;
  onChange: (next: SessionState) => void;
}

const CALLBACK = '/api/x/callback';

export default function Connect({ state, onChange }: Props) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState(CALLBACK);

  // The value the visitor has to paste into their own X app, which is only
  // knowable in the browser that is looking at it.
  useEffect(() => {
    setCallbackUrl(`${window.location.origin}${CALLBACK}`);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/x/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      const j = (await res.json()) as SessionState & { error?: string };
      if (!res.ok) {
        setError(j.error ?? 'could not save those credentials');
        return;
      }
      setClientSecret('');
      onChange(j);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [clientId, clientSecret, onChange]);

  if (state?.account) return null;

  return (
    <section className="mx-auto max-w-[720px] px-6 py-14">
      <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]">
        <div className="border-b border-[var(--color-line)] px-6 py-4">
          <h2 className="text-base font-semibold">Connect your own X account</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-muted)]">
            This runs as you, not as us. It reads your following list and, if you
            press send, messages people from your handle. So it needs your X app
            and your authorization, and it will not run without them.
          </p>
        </div>

        <ol className="divide-y divide-[var(--color-line)]">
          <li className="px-6 py-5">
            <p className="font-mono text-[10px] tracking-[0.14em] text-[var(--color-dim)] uppercase">
              step one · your X app
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
              Create an app at{' '}
              <a
                className="underline decoration-[var(--color-line)] underline-offset-2 hover:text-[var(--color-fg)]"
                href="https://developer.x.com/en/portal/dashboard"
                target="_blank"
                rel="noreferrer noopener"
              >
                developer.x.com
              </a>{' '}
              with OAuth 2.0 enabled, set as a confidential client, and add this
              exact callback URL to it:
            </p>
            <code className="mt-2 block truncate rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[11.5px] text-[var(--color-fg)]">
              {callbackUrl}
            </code>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Client ID"
                autoComplete="off"
                spellCheck={false}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] outline-none focus:border-[var(--color-fg)]"
              />
              <input
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Client Secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] outline-none focus:border-[var(--color-fg)]"
              />
            </div>

            <button
              onClick={() => void save()}
              disabled={saving || !clientId.trim() || !clientSecret.trim()}
              className="mt-3 rounded-full bg-[var(--color-acc)] px-5 py-2 text-[13px] font-medium text-[#0b0614] transition hover:opacity-90 disabled:opacity-40"
            >
              {saving ? 'Saving…' : state?.hasCredentials ? 'Replace credentials' : 'Save credentials'}
            </button>

            {state?.hasCredentials && (
              <p className="mt-2 font-mono text-[11px] text-[var(--color-dim)]">
                credentials on file for this browser
              </p>
            )}
            {error && (
              <p className="mt-2 font-mono text-[11px] text-[var(--color-acc)]">{error}</p>
            )}
          </li>

          <li className="px-6 py-5">
            <p className="font-mono text-[10px] tracking-[0.14em] text-[var(--color-dim)] uppercase">
              step two · authorize
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
              X will ask you to approve reading your following list, following
              accounts, and sending direct messages. Nothing is sent without a
              second, separate press later.
            </p>
            <a
              href={state?.hasCredentials ? '/api/x/login' : undefined}
              aria-disabled={!state?.hasCredentials}
              className={`mt-3 inline-block rounded-full px-5 py-2 text-[13px] font-medium transition ${
                state?.hasCredentials
                  ? 'bg-[var(--color-fg)] text-[#0b0614] hover:opacity-90'
                  : 'pointer-events-none border border-[var(--color-line)] text-[var(--color-dim)]'
              }`}
            >
              Connect X
            </a>
          </li>
        </ol>

        <p className="border-t border-[var(--color-line)] px-6 py-3 text-[11.5px] leading-relaxed text-[var(--color-dim)]">
          Your client secret is stored against this browser&apos;s session and is
          never returned by any endpoint. Clearing cookies ends the session.
        </p>
      </div>
    </section>
  );
}
