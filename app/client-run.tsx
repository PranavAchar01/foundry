'use client';

import { useEffect, useRef, useState } from 'react';
import Scan from './scan';

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
  const [pool, setPool] = useState<string[]>([]);
  const [chosen, setChosen] = useState<{ username: string; reason?: string }[]>([]);
  const [scanning, setScanning] = useState(false);
  const scanRef = useRef<HTMLDivElement | null>(null);

  // The sweep streams the real network and lands on the real allowlist, so both
  // are loaded before the button is pressed rather than invented on the fly.
  useEffect(() => {
    fetch('/api/cohort', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        setPool((j.pool ?? []) as string[]);
        setChosen(
          ((j.cohort ?? []) as { username: string; evidence?: string }[]).map((c) => ({
            username: c.username,
            reason: c.evidence || 'matched on profile signals',
          })),
        );
      })
      .catch(() => {});
  }, []);

  /*
   * The sweep is the point of the button, so bring it into view rather than
   * running it below the fold. This waits for the scan to actually mount — the
   * ref is still null in the click handler and in the frame right after it.
   *
   * The glide is hand-rolled because native smooth scrolling is a no-op on this
   * page: something above cancels the browser's animation, and an instant jump
   * is a worse answer than owning the easing.
   */
  useEffect(() => {
    const el = scanRef.current;
    if (!scanning || !el) return;

    const target = Math.max(
      0,
      window.scrollY + el.getBoundingClientRect().top - (window.innerHeight - el.offsetHeight) / 2,
    );
    const from = window.scrollY;
    const distance = target - from;
    if (Math.abs(distance) < 8) return;

    const DURATION = 520;
    let raf = 0;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / DURATION);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      window.scrollTo(0, from + distance * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [scanning]);

  const run = async (dryRun: boolean) => {
    setRunning(true);
    setError(null);
    setResult(null);
    setScanning(true);
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

      {scanning && (
        <div ref={scanRef} className="mt-5 scroll-mt-24">
          <Scan pool={pool} chosen={chosen} active={scanning} />
        </div>
      )}

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
                ${(result.segment.priceCents / 100).toFixed(2)}/month
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
