'use client';

import { useState } from 'react';

/**
 * The demo control: one button that runs the whole client pipeline and shows
 * each stage as it lands.
 */

interface RunResult {
  elapsedMs: number;
  stages: { name: string; ms: number; detail: string }[];
  segment: {
    id: string;
    label: string;
    description: string;
    willingness: number;
    reasoning: string;
    priceCents: number;
  };
  business: { id: string | null; url: string | null };
  hire: {
    decision: string;
    reason: string;
    targetPayoutCents: number;
    quotedCents: number | null;
    payoutShare: number;
  };
  drafts: { username: string; message: string; rationale: string }[];
  reach: { username: string; followed: boolean; dmSent: boolean; error: string | null }[];
  dryRun: boolean;
  error?: string;
}

export default function ClientRun() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (dryRun: boolean) => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/demo/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      });
      const j = (await res.json()) as RunResult;
      if (!res.ok) setError(j.error ?? `run failed (${res.status})`);
      else setResult(j);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="mb-8 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Find a client</h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            Segments the audience, builds a product for the strongest segment, hires the human who
            delivers it, and reaches out.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => run(true)}
            disabled={running}
            className="rounded-full border border-[var(--color-line)] px-4 py-2 text-sm text-[var(--color-muted)] transition hover:text-[var(--color-fg)] disabled:opacity-50"
          >
            Dry run
          </button>
          <button
            onClick={() => run(false)}
            disabled={running}
            className="rounded-full bg-[var(--color-fg)] px-5 py-2 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-50"
          >
            {running ? 'Working…' : 'Find a client'}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-4 py-3 text-sm">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-5 space-y-4">
          {/* stages */}
          <div className="flex flex-wrap gap-2 font-mono text-[10.5px]">
            {result.stages.map((s) => (
              <span
                key={s.name}
                className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-[var(--color-muted)]"
                title={s.detail}
              >
                {s.name} {(s.ms / 1000).toFixed(1)}s
              </span>
            ))}
            <span className="rounded-full bg-[var(--color-accdim)] px-2.5 py-1">
              total {(result.elapsedMs / 1000).toFixed(1)}s
            </span>
          </div>

          {/* the segment it picked */}
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-4">
            <p className="font-mono text-[10px] tracking-wider text-[var(--color-dim)] uppercase">
              client identified · willingness {result.segment.willingness.toFixed(2)}
            </p>
            <p className="mt-1 font-medium">{result.segment.label}</p>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{result.segment.description}</p>
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-muted)]">
              {result.segment.reasoning}
            </p>
          </div>

          {/* what it built and who it hired */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-4">
              <p className="font-mono text-[10px] tracking-wider text-[var(--color-dim)] uppercase">
                business built
              </p>
              {result.business.url ? (
                <a
                  href={result.business.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block truncate text-sm underline underline-offset-2"
                >
                  {result.business.url.replace(/^https?:\/\//, '')}
                </a>
              ) : (
                <p className="mt-1 text-sm text-[var(--color-muted)]">—</p>
              )}
              <p className="mt-1 font-mono text-[11px] text-[var(--color-dim)]">
                ${(result.segment.priceCents / 100).toFixed(2)} one-time
              </p>
            </div>

            <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-4">
              <p className="font-mono text-[10px] tracking-wider text-[var(--color-dim)] uppercase">
                consultant · {Math.round(result.hire.payoutShare * 100)}% payout
              </p>
              <p className="mt-1 text-sm">
                {result.hire.decision === 'posted' ? 'Hired' : 'Declined'}
                {result.hire.quotedCents != null && (
                  <span className="ml-2 font-mono text-[11px] text-[var(--color-dim)]">
                    quoted ${(result.hire.quotedCents / 100).toFixed(2)} · budget $
                    {(result.hire.targetPayoutCents / 100).toFixed(2)}
                  </span>
                )}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">
                {result.hire.reason}
              </p>
            </div>
          </div>

          {/* outreach */}
          {result.drafts.length > 0 && (
            <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-4">
              <p className="font-mono text-[10px] tracking-wider text-[var(--color-dim)] uppercase">
                outreach {result.dryRun ? '· dry run, nothing sent' : ''}
              </p>
              {result.drafts.slice(0, 4).map((d) => {
                const r = result.reach.find((x) => x.username === d.username);
                return (
                  <div key={d.username} className="mt-3 border-t border-[var(--color-line)] pt-3 first:border-0 first:pt-0">
                    <p className="font-mono text-[11px]">
                      @{d.username}
                      {r && (
                        <span className="ml-2 text-[var(--color-dim)]">
                          {r.followed ? 'followed' : 'not followed'} ·{' '}
                          {r.dmSent ? 'DM sent' : r.error ? `not sent: ${r.error.slice(0, 60)}` : 'not sent'}
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-[13px] leading-relaxed">{d.message}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
