'use client';

import { useEffect, useState } from 'react';

/**
 * One company, opened. Three things and nothing else: the site it sells from,
 * the machine that runs it, and whether it is working.
 */

interface Detail {
  business: {
    id: string;
    name: string;
    niche: string;
    tagline: string;
    url: string;
    status: 'TESTING' | 'SCALING' | 'KILLED';
    visitors: number;
    conversions: number;
    killReason: string | null;
    createdAt: string;
    pagegen: string;
  };
  traction: {
    visitors: number;
    conversions: number;
    conversionRate: number;
    revenueUsd: number;
    cogsUsd: number;
    opexUsd: number;
    spendUsd: number;
    netUsd: number;
    cacUsd: number | null;
    priceUsd: number;
    budgetUsd: number;
  };
  machine: {
    id: string;
    externalId: string;
    provider: string;
    status: string;
    previewUrl: string;
    billedUsd: number;
    createdAt: string;
    bootLog: string[];
  } | null;
  decisions: { id: string; action: string; reasoning: string; model: string; created_at: string }[];
  runs: { id: string; command: string; exit_code: number; stdout: string; created_at: string }[];
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour12: false });

export default function CompanyDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [tab, setTab] = useState<'site' | 'machine'>('site');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await fetch(`/api/company/${id}`, { cache: 'no-store' });
      if (alive && res.ok) setData((await res.json()) as Detail);
    };
    void load();
    const timer = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);

  // Escape closes, and the body must not scroll behind the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const b = data?.business;
  const t = data?.traction;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-bg)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{b?.name ?? 'loading…'}</h2>
            <p className="truncate text-sm text-[var(--color-muted)]">{b?.tagline ?? b?.niche}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-1.5 font-mono text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            close ✕
          </button>
        </header>

        {/* the numbers, plainly */}
        <div className="grid grid-cols-2 gap-px border-b border-[var(--color-line)] bg-[var(--color-line)] md:grid-cols-6">
          <Metric label="visitors" value={t ? String(t.visitors) : '—'} />
          <Metric label="sales" value={t ? String(t.conversions) : '—'} />
          <Metric
            label="revenue"
            value={t ? `$${t.revenueUsd.toFixed(2)}` : '—'}
            tone={t && t.revenueUsd > 0 ? 'acc' : 'default'}
          />
          <Metric label="spend" value={t ? `$${t.spendUsd.toFixed(2)}` : '—'} />
          <Metric
            label="net"
            value={t ? `${t.netUsd < 0 ? '−' : ''}$${Math.abs(t.netUsd).toFixed(2)}` : '—'}
            tone={t && t.netUsd >= 0 ? 'acc' : 'red'}
          />
          <Metric label="CAC" value={t?.cacUsd == null ? '—' : `$${t.cacUsd.toFixed(2)}`} />
        </div>

        {/* tabs */}
        <div className="flex gap-1 border-b border-[var(--color-line)] px-6 pt-3">
          {(['site', 'machine'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-t-lg px-4 py-2 font-mono text-[11px] tracking-wider uppercase ${
                tab === k
                  ? 'bg-[var(--color-panel)] text-[var(--color-acc)]'
                  : 'text-[var(--color-dim)] hover:text-[var(--color-muted)]'
              }`}
            >
              {k === 'site' ? 'the website' : 'the machine running it'}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-3 pb-2 font-mono text-[10px] text-[var(--color-dim)]">
            {b?.url && (
              <a href={b.url} target="_blank" rel="noreferrer" className="text-[var(--color-acc)] underline underline-offset-2">
                open site ↗
              </a>
            )}
            {data?.machine?.previewUrl && (
              <a
                href={data.machine.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--color-acc)] underline underline-offset-2"
              >
                open machine ↗
              </a>
            )}
          </div>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 bg-[var(--color-panel)]">
          {tab === 'site' ? (
            b?.url ? (
              <iframe
                src={b.url}
                title={`${b.name} storefront`}
                className="h-full w-full border-0 bg-white"
                sandbox="allow-scripts allow-same-origin"
              />
            ) : (
              <Empty>This company has no storefront.</Empty>
            )
          ) : (
            <div className="grid h-full grid-rows-2 gap-px bg-[var(--color-line)] lg:grid-cols-2 lg:grid-rows-1">
              {/* what the machine serves */}
              <div className="flex min-h-0 flex-col bg-[var(--color-panel)]">
                <div className="border-b border-[var(--color-line)] px-4 py-2 font-mono text-[10px] text-[var(--color-dim)]">
                  {data?.machine
                    ? `${data.machine.provider} · ${data.machine.status} · $${data.machine.billedUsd.toFixed(2)} of machine time`
                    : 'no machine'}
                </div>
                {data?.machine?.previewUrl ? (
                  <iframe
                    src={data.machine.previewUrl}
                    title="machine view"
                    className="min-h-0 flex-1 border-0 bg-[#08090b]"
                    sandbox="allow-scripts allow-same-origin"
                  />
                ) : (
                  <Empty>This machine is not serving a view.</Empty>
                )}
              </div>

              {/* what it has been doing */}
              <div className="thin-scroll min-h-0 overflow-y-auto bg-[#060709] px-4 py-3 font-mono text-[11px]">
                {(data?.runs.length ?? 0) === 0 ? (
                  <p className="text-[var(--color-dim)]">
                    no commands yet — the operator works this machine each cycle
                  </p>
                ) : (
                  data!.runs.map((r) => (
                    <div key={r.id} className="mb-2">
                      <div className="flex gap-2">
                        <span className="shrink-0 text-[var(--color-dim)]">{clock(r.created_at)}</span>
                        <span
                          className={`shrink-0 ${r.exit_code === 0 ? 'text-[var(--color-acc)]' : 'text-[var(--color-red)]'}`}
                        >
                          {r.exit_code === 0 ? '$' : `✗${r.exit_code}`}
                        </span>
                        <span className="break-all whitespace-pre-wrap text-[#c8cdd4]">
                          {r.command.replace(/^cd \/root\/company && /, '')}
                        </span>
                      </div>
                      {r.stdout.trim() && (
                        <pre className="mt-1 ml-[4.2rem] max-h-24 overflow-y-auto whitespace-pre-wrap break-all text-[10.5px] text-[var(--color-muted)]">
                          {r.stdout.trim().slice(0, 900)}
                        </pre>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* what the agent decided */}
        <footer className="thin-scroll max-h-32 shrink-0 overflow-y-auto border-t border-[var(--color-line)] px-6 py-3">
          {(data?.decisions.length ?? 0) === 0 ? (
            <p className="font-mono text-[11px] text-[var(--color-dim)]">no decisions recorded yet</p>
          ) : (
            data!.decisions.slice(0, 4).map((d) => (
              <p key={d.id} className="mb-1.5 text-[12px] leading-relaxed text-[#c8cdd4]">
                <span className="font-mono text-[10px] text-[var(--color-dim)]">
                  {clock(d.created_at)} {d.action}{' '}
                </span>
                {d.reasoning.slice(0, 260)}
              </p>
            ))
          )}
        </footer>
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  acc: 'text-[var(--color-acc)]',
  red: 'text-[var(--color-red)]',
  default: 'text-[var(--color-fg)]',
};

function Metric({ label, value, tone = 'default' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-[var(--color-bg)] px-4 py-3">
      <p className="font-mono text-[9.5px] tracking-wider text-[var(--color-dim)] uppercase">{label}</p>
      <p className={`mt-0.5 font-mono text-lg ${TONE[tone]}`}>{value}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-[var(--color-dim)]">
      {children}
    </div>
  );
}
