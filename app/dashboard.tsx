'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import CompanyDetail from './detail';

/**
 * One page. Every company is a tile showing its actual hero page, live.
 * Click a tile and you get the site, the machine running it, and the numbers.
 */

interface PnL {
  revenueCents: number;
  refundCents: number;
  cogsCents: number;
  opexCents: number;
  spendCents: number;
  netCents: number;
}

interface Card {
  id: string;
  name: string;
  niche: string;
  tagline: string;
  url: string;
  status: 'TESTING' | 'SCALING' | 'KILLED';
  visitors: number;
  conversions: number;
  kill_reason: string | null;
  pnl: PnL;
  cacUsd: number | null;
}

interface Decision {
  id: string;
  business_id: string | null;
  action: string;
  reasoning: string;
  model: string;
  created_at: string;
}

interface Payload {
  generatedAt: string;
  businesses: Card[];
  pnl: PnL;
  budget: {
    totalBudgetUsd: number;
    spentUsd: number;
    remainingUsd: number;
    breakerEnabled: boolean;
    breaker: { tripped: boolean; reason: string };
  };
  decisions: Decision[];
  providers: { capability: string; active: string }[];
}

interface MachineLite {
  businessId: string;
  status: string;
  previewUrl: string;
}

const usd = (cents: number | string) => `$${(Math.abs(Number(cents)) / 100).toFixed(2)}`;

const STATUS: Record<Card['status'], string> = {
  SCALING: 'border-[var(--color-accdim)] bg-[#0d2417] text-[var(--color-acc)]',
  TESTING: 'border-[#3f3312] bg-[#241c07] text-[var(--color-amber)]',
  KILLED: 'border-[#3f1d1d] bg-[#240d0d] text-[var(--color-red)]',
};

export default function Dashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [machines, setMachines] = useState<MachineLite[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<Decision | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        fetch('/api/portfolio', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/machines', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      setData(p as Payload);
      setMachines(
        ((m.machines ?? []) as { businessId: string; status: string; previewUrl: string }[]).map(
          (x) => ({ businessId: x.businessId, status: x.status, previewUrl: x.previewUrl }),
        ),
      );
      if (!latest && (p as Payload).decisions?.[0]) setLatest((p as Payload).decisions[0]);
    } catch {
      /* the stream keeps things moving between snapshots */
    }
  }, [latest]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 12_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('decision', (ev) => {
      const row = JSON.parse((ev as MessageEvent).data) as Decision;
      if (seen.current.has(row.id)) return;
      seen.current.add(row.id);
      setLatest(row);
      void refresh();
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [refresh]);

  if (!data) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="font-mono text-sm text-[var(--color-muted)]">loading portfolio…</p>
      </main>
    );
  }

  const { pnl, budget } = data;
  const live = data.businesses.filter((b) => b.status !== 'KILLED');

  return (
    <main className="mx-auto max-w-[1500px] px-6 py-8">
      {/* ---- one compact header: identity, money, pulse ---- */}
      <header className="mb-7 flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border-b border-[var(--color-line)] pb-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            FOUNDRY<span className="text-[var(--color-acc)]">.</span>
          </h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            An autonomous holding company. {live.length} companies, each on its own machine.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-7 gap-y-2 font-mono">
          <Figure label="revenue" value={usd(pnl.revenueCents)} tone="acc" />
          <Figure label="spend" value={`−${usd(pnl.spendCents)}`} />
          <Figure
            label="net"
            value={`${pnl.netCents < 0 ? '−' : ''}${usd(pnl.netCents)}`}
            tone={pnl.netCents >= 0 ? 'acc' : 'red'}
          />
          <Figure label="budget left" value={`$${budget.remainingUsd.toFixed(2)}`} sub={`of $${budget.totalBudgetUsd}`} />
          <span className="flex items-center gap-2 text-[11px] text-[var(--color-dim)]">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-[var(--color-acc)] pulse' : 'bg-[var(--color-dim)]'
              }`}
            />
            {connected ? 'live' : 'reconnecting'}
          </span>
        </div>
      </header>

      {budget.breaker.tripped && (
        <div className="mb-6 rounded-xl border border-[#3f1d1d] bg-[#180b0b] px-5 py-3">
          <span className="font-mono text-[11px] tracking-wider text-[var(--color-red)] uppercase">
            circuit breaker tripped
          </span>
          <span className="ml-3 text-sm text-[var(--color-fg)]">{budget.breaker.reason}</span>
        </div>
      )}

      {/* ---- the wall of companies ---- */}
      {data.businesses.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] px-6 py-16 text-center text-sm text-[var(--color-dim)]">
          No companies yet. The next CEO cycle will spawn one.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.businesses.map((b) => {
            const m = machines.find((x) => x.businessId === b.id);
            return (
              <button
                key={b.id}
                onClick={() => setOpen(b.id)}
                className="group overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] text-left transition hover:border-[#2c333c] hover:shadow-[0_0_0_1px_rgba(74,222,128,0.12)]"
              >
                {/* the company's actual hero page */}
                <div className="relative h-44 overflow-hidden border-b border-[var(--color-line)] bg-[#0b0c0f]">
                  {b.url ? (
                    <iframe
                      src={b.url}
                      title={b.name}
                      aria-hidden
                      tabIndex={-1}
                      scrolling="no"
                      sandbox="allow-scripts allow-same-origin"
                      className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
                      style={{ width: '1280px', height: '880px', transform: 'scale(0.29)' }}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center font-mono text-[11px] text-[var(--color-dim)]">
                      no storefront
                    </div>
                  )}
                  {b.status === 'KILLED' && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/70 font-mono text-[11px] tracking-widest text-[var(--color-red)]">
                      KILLED
                    </div>
                  )}
                  <span
                    className={`absolute top-2 right-2 rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-wider ${STATUS[b.status]}`}
                  >
                    {b.status}
                  </span>
                  {m && (
                    <span className="absolute bottom-2 left-2 rounded-full border border-[var(--color-line)] bg-black/70 px-2 py-0.5 font-mono text-[9px] text-[var(--color-muted)]">
                      {m.status === 'active' ? <span className="pulse text-[var(--color-acc)]">● </span> : '○ '}
                      VM {m.status}
                    </span>
                  )}
                </div>

                {/* the three numbers that matter */}
                <div className="px-4 py-3">
                  <h3 className="truncate text-sm font-medium">{b.name}</h3>
                  <p className="truncate text-[11px] text-[var(--color-dim)]">{b.niche}</p>
                  <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px]">
                    <Cell label="visits" value={String(b.visitors)} />
                    <Cell label="sales" value={String(b.conversions)} />
                    <Cell
                      label="net"
                      value={`${b.pnl.netCents < 0 ? '−' : ''}${usd(b.pnl.netCents)}`}
                      tone={b.pnl.netCents >= 0 ? 'acc' : 'muted'}
                    />
                  </dl>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* ---- the agent's last word, always visible, never in the way ---- */}
      <footer className="mt-8 border-t border-[var(--color-line)] pt-4">
        <div className="flex gap-3 font-mono text-[11px]">
          <span className="shrink-0 tracking-wider text-[var(--color-muted)] uppercase">latest</span>
          {latest ? (
            <p className="line-clamp-2 text-[var(--color-dim)]">
              <span className="text-[var(--color-acc)]">{latest.action}</span>{' '}
              <span className="text-[#c8cdd4]">{latest.reasoning.slice(0, 260)}</span>{' '}
              <span>· {latest.model}</span>
            </p>
          ) : (
            <p className="text-[var(--color-dim)]">no decisions yet</p>
          )}
        </div>
        <p className="mt-3 font-mono text-[10px] text-[var(--color-dim)]">
          {data.providers.map((p) => `${p.capability}=${p.active}`).join(' · ')}
        </p>
      </footer>

      {open && <CompanyDetail id={open} onClose={() => setOpen(null)} />}
    </main>
  );
}

const TONE: Record<string, string> = {
  acc: 'text-[var(--color-acc)]',
  red: 'text-[var(--color-red)]',
  muted: 'text-[var(--color-muted)]',
  default: 'text-[var(--color-fg)]',
};

function Figure({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div>
      <p className="text-[9.5px] tracking-wider text-[var(--color-dim)] uppercase">{label}</p>
      <p className={`text-[15px] ${TONE[tone]}`}>
        {value}
        {sub && <span className="ml-1.5 text-[10px] text-[var(--color-dim)]">{sub}</span>}
      </p>
    </div>
  );
}

function Cell({ label, value, tone = 'default' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[9px] text-[var(--color-dim)]">{label}</dt>
      <dd className={`mt-0.5 ${TONE[tone]}`}>{value}</dd>
    </div>
  );
}
