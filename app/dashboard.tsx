'use client';

import Image from 'next/image';
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
  // Solid peach = earning, outline peach = still being tested, flat violet = dead.
  SCALING: 'border-transparent bg-[var(--color-fg)] text-[#0b0614]',
  TESTING: 'border-[var(--color-fg)] bg-[color:rgba(11,6,20,0.55)] text-[var(--color-fg)]',
  KILLED: 'border-transparent bg-[var(--color-accdim)] text-[var(--color-muted)]',
};

export default function Dashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [machines, setMachines] = useState<MachineLite[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<Decision | null>(null);
  const [introGo, setIntroGo] = useState(false);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Kick the hero choreography after hydration; 'both' fill keeps the end state.
    setIntroGo(true);
  }, []);

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
    <main className={`intro${introGo ? ' intro-go' : ''}`}>
      {/* ---- hero: the painting inside a top-rounded card, dusk scrim, ember CTA ---- */}
      <section className="relative h-[78vh] min-h-[520px] bg-[var(--color-bg)]">
        <div className="absolute top-0 bottom-0 left-4 right-4 overflow-hidden rounded-t-[24px] md:left-6 md:right-6">
          <div className="hero-media absolute inset-0">
            <Image
              src="/hero-foundry.png"
              alt=""
              fill
              priority
              sizes="100vw"
              className="object-cover"
            />
          </div>
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(180deg, rgba(11,6,20,0.45) 0%, rgba(11,6,20,0) 18%, rgba(11,6,20,0) 60%, rgba(11,6,20,0.5) 85%, rgba(11,6,20,0.95) 100%)',
            }}
          />
          <div className="relative flex h-full flex-col items-center justify-center px-6 text-center">
            <p
              className="hero-eyebrow text-[13px] tracking-[0.12em] text-[var(--color-fg)] uppercase"
              style={{ textShadow: '0 1px 12px rgba(11,6,20,0.8)' }}
            >
              An autonomous holding company · {live.length} companies live
            </p>
            <h1
              className="hero-title text-[clamp(48px,7.2vw,88px)] leading-[1.05] font-normal tracking-[-0.015em] text-white"
              style={{ textShadow: '0 4px 50px rgba(11,6,20,0.7)' }}
            >
              The holding company
              <br />
              with no employees.
            </h1>
            <a className="hero-cta btn-ember mt-9" href="#portfolio">
              See the portfolio
            </a>
          </div>
        </div>
      </section>

      {/* ---- the money bar: a slim ledger line under the painting ---- */}
      <div className="border-b border-[var(--color-line)]">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-7 gap-y-2 px-6 py-4 font-mono">
          <Figure
            label="revenue"
            value={usd(pnl.revenueCents)}
            tone={pnl.revenueCents > 0 ? 'acc' : 'default'}
          />
          <Figure label="spend" value={`−${usd(pnl.spendCents)}`} />
          <Figure
            label="net"
            value={`${pnl.netCents < 0 ? '−' : ''}${usd(pnl.netCents)}`}
            tone={pnl.netCents >= 0 ? 'acc' : 'red'}
          />
          <Figure label="budget left" value={`$${budget.remainingUsd.toFixed(2)}`} sub={`of $${budget.totalBudgetUsd}`} />
          <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-dim)]">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-[var(--color-fg)] pulse' : 'bg-[var(--color-dim)]'
              }`}
            />
            {connected ? 'live' : 'reconnecting'}
          </span>
        </div>
      </div>

      <div id="portfolio" className="mx-auto max-w-[1500px] px-6 py-8">
      {budget.breaker.tripped && (
        <div className="mb-6 rounded-2xl border border-[var(--color-line)] bg-[var(--color-fg)] px-5 py-3">
          <span className="font-mono text-[11px] tracking-wider text-[#0b0614] uppercase">
            circuit breaker tripped
          </span>
          <span className="ml-3 text-sm text-[#0b0614]/80">{budget.breaker.reason}</span>
        </div>
      )}

      {/* ---- the wall of companies ---- */}
      {data.businesses.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--color-line)] px-6 py-16 text-center text-sm text-[var(--color-dim)]">
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
                className="group card-shadow card-hover overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] text-left"
              >
                {/* the company's actual hero page */}
                <div className="relative h-44 overflow-hidden border-b border-[var(--color-line)] bg-[var(--color-panel2)]">
                  {b.url ? (
                    <TilePreview url={b.url} name={b.name} />
                  ) : (
                    <div className="flex h-full items-center justify-center font-mono text-[11px] text-[var(--color-dim)]">
                      no storefront
                    </div>
                  )}
                  {b.status === 'KILLED' && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#0b0614]/70 text-[11px] font-medium tracking-[0.18em] text-[var(--color-fg)] backdrop-blur-[2px]">
                      KILLED
                    </div>
                  )}
                  <span
                    className={`absolute top-2 right-2 rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-wider ${STATUS[b.status]}`}
                  >
                    {b.status}
                  </span>
                  {m && (
                    <span className="absolute bottom-2 left-2 rounded-full border border-[var(--color-line)] bg-[#0b0614]/80 px-2 py-0.5 font-mono text-[9px] text-[var(--color-muted)] backdrop-blur-sm">
                      {m.status === 'active' ? <span className="pulse text-[var(--color-fg)]">● </span> : '○ '}
                      VM {m.status}
                    </span>
                  )}
                </div>

                {/* the three numbers that matter */}
                <div className="px-4 py-3">
                  <h3 className="truncate text-base font-normal">{b.name}</h3>
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

      </div>

      {/* ---- the ember slab: Priceflag's footer, recast pink ---- */}
      <footer className="foot-slab mt-16">
        <div className="mx-auto max-w-[1520px] px-5 pt-12 pb-5 md:px-12 md:pt-16">
          <div className="flex flex-wrap justify-between gap-10">
            <div className="flex flex-col items-start gap-5">
              <span className="text-[21px]" style={{ fontFamily: 'var(--font-serif)' }}>
                Foundry
              </span>
              <h2 className="max-w-[18ch] text-[clamp(29px,3.4vw,50px)] leading-[1.1] font-normal tracking-[-0.02em]">
                Companies run by machines, audited by anyone.
              </h2>
              {latest ? (
                <p className="text-[13px]" style={{ color: 'var(--foot-ink-soft)' }}>
                  <span className="font-medium">{latest.action}</span>{' '}
                  {latest.reasoning.slice(0, 260)} · {latest.model}
                </p>
              ) : (
                <p className="text-[13px]" style={{ color: 'var(--foot-ink-soft)' }}>
                  no decisions yet
                </p>
              )}
              <a
                className="btn-plum"
                href="https://github.com/PranavAchar01/foundry"
                target="_blank"
                rel="noreferrer"
              >
                See the source ↗
              </a>
            </div>
            <nav>
              <ul className="space-y-2 text-[14px] font-medium">
                <li>
                  <a href="#portfolio">Portfolio</a>
                </li>
                <li>
                  <a href="/api/health">Health</a>
                </li>
                <li>
                  <a href="/api/providers">Providers</a>
                </li>
                <li>
                  <a href="/api/stream">Decision stream</a>
                </li>
              </ul>
            </nav>
          </div>
          <svg className="foot-word" viewBox="0 0 720 130" aria-hidden>
            <text
              x="360"
              y="104"
              textAnchor="middle"
              fontSize="130"
              style={{ fontFamily: 'var(--font-serif)' }}
              textLength="700"
              lengthAdjust="spacingAndGlyphs"
            >
              FOUNDRY
            </text>
          </svg>
          <div
            className="mt-8 flex flex-wrap justify-between gap-3 border-t pt-4 text-[12px]"
            style={{ borderColor: 'var(--foot-rule)', color: 'var(--foot-ink-soft)' }}
          >
            <span>
              Every company on this page — and this page itself — is operated end-to-end by an AI
              agent. No human runs these businesses.
            </span>
            <span>{data.providers.map((p) => `${p.capability}=${p.active}`).join(' · ')}</span>
          </div>
        </div>
      </footer>

      {open && <CompanyDetail id={open} onClose={() => setOpen(null)} />}
    </main>
  );
}

function TilePreview({ url, name }: { url: string; name: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && <div className="shimmer absolute inset-0" />}
      <iframe
        src={url}
        title={name}
        aria-hidden
        tabIndex={-1}
        scrolling="no"
        sandbox="allow-scripts allow-same-origin"
        onLoad={() => setLoaded(true)}
        className={`pointer-events-none absolute top-0 left-0 origin-top-left border-0 transition-opacity duration-500 ${
          loaded ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ width: '1280px', height: '880px', transform: 'scale(0.29)' }}
      />
    </>
  );
}

const TONE: Record<string, string> = {
  acc: 'text-[var(--color-acc)] font-medium',
  red: 'text-[var(--color-muted)]',
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
