'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types mirroring /api/portfolio
// ---------------------------------------------------------------------------

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
  slug: string;
  niche: string;
  tagline: string;
  url: string;
  status: 'TESTING' | 'SCALING' | 'KILLED';
  visitors: number;
  conversions: number;
  price_cents: number;
  kill_reason: string | null;
  created_at: string;
  pnl: PnL;
  cacUsd: number | null;
  conversionRate: number;
}

interface Decision {
  id: string;
  cycle_id: string;
  business_id: string | null;
  action: string;
  reasoning: string;
  confidence: number;
  model: string;
  created_at: string;
}

interface Escalation {
  id: string;
  business_id: string | null;
  question: string;
  provider: string;
  quote_total_cents: string | number;
  decision: string;
  reason: string;
  created_at: string;
}

interface LedgerRow {
  id: string;
  business_id: string | null;
  kind: 'REVENUE' | 'REFUND' | 'COGS' | 'OPEX';
  amount_cents: string | number;
  description: string;
  created_at: string;
}

interface CapabilityStatus {
  capability: string;
  flag: string;
  active: string;
  options: { name: string; configured: boolean; requires: string[]; isActive: boolean }[];
}

interface Payload {
  generatedAt: string;
  businesses: Card[];
  pnl: PnL;
  budget: {
    totalBudgetUsd: number;
    spentUsd: number;
    remainingUsd: number;
    perBusinessBudgetUsd: number;
    perEscalationCapUsd: number;
    breakerEnabled: boolean;
    breaker: { tripped: boolean; reason: string; trippedAt: string | null };
  };
  decisions: Decision[];
  escalations: Escalation[];
  ledger: LedgerRow[];
  providers: CapabilityStatus[];
}

// ---------------------------------------------------------------------------

const usd = (cents: number | string) =>
  `$${(Math.abs(Number(cents)) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const STATUS_STYLE: Record<Card['status'], string> = {
  SCALING: 'border-[var(--color-accdim)] bg-[#0d2417] text-[var(--color-acc)]',
  TESTING: 'border-[#3f3312] bg-[#241c07] text-[var(--color-amber)]',
  KILLED: 'border-[#3f1d1d] bg-[#240d0d] text-[var(--color-red)]',
};

const ACTION_COLOR: Record<string, string> = {
  SPAWN: 'text-[var(--color-acc)]',
  SCALE: 'text-[var(--color-acc)]',
  KILL: 'text-[var(--color-red)]',
  HOLD: 'text-[var(--color-muted)]',
  REVENUE_BOOKED: 'text-[var(--color-acc)]',
  ESCALATION_PURCHASED: 'text-[#7dd3fc]',
  ESCALATION_DECLINED: 'text-[var(--color-amber)]',
  ALLOCATION_DECLINED: 'text-[var(--color-amber)]',
  SPAWN_REFUSED: 'text-[var(--color-amber)]',
  SPAWN_SKIPPED: 'text-[var(--color-dim)]',
  CYCLE_HALTED: 'text-[var(--color-red)]',
  CIRCUIT_BREAKER_TRIPPED: 'text-[var(--color-red)]',
};

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
}

export default function Dashboard({ initial }: { initial: Payload | null }) {
  const [data, setData] = useState<Payload | null>(initial);
  const [live, setLive] = useState<Decision[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/portfolio', { cache: 'no-store' });
      if (!res.ok) throw new Error(`portfolio ${res.status}`);
      setData((await res.json()) as Payload);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Live allocation log over SSE.
  useEffect(() => {
    const source = new EventSource(`/api/stream?since=${new Date(Date.now() - 900_000).toISOString()}`);
    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('decision', (ev) => {
      const row = JSON.parse((ev as MessageEvent).data) as Decision;
      if (seen.current.has(row.id)) return;
      seen.current.add(row.id);
      setLive((prev) => [row, ...prev].slice(0, 120));
      void refresh();
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [refresh]);

  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-24">
        <p className="font-mono text-sm text-[var(--color-muted)]">
          {error ? `dashboard error: ${error}` : 'loading portfolio…'}
        </p>
      </main>
    );
  }

  const { pnl, budget } = data;
  const merged = mergeLog(live, data.decisions);
  const activeCount = data.businesses.filter((b) => b.status !== 'KILLED').length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      {/* ---- header ---- */}
      <header className="mb-9 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-line)] pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            FOUNDRY<span className="text-[var(--color-acc)]">.</span>
          </h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            An autonomous holding company. It spawns businesses, funds them, reads the P&amp;L, and
            kills the losers.
          </p>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              connected ? 'bg-[var(--color-acc)] pulse' : 'bg-[var(--color-dim)]'
            }`}
          />
          <span className="text-[var(--color-muted)]">
            {connected ? 'live' : 'reconnecting'} · {activeCount} active ·{' '}
            {new Date(data.generatedAt).toLocaleTimeString('en-US', { hour12: false })}
          </span>
        </div>
      </header>

      {budget.breaker.tripped && (
        <div className="mb-8 rounded-xl border border-[#3f1d1d] bg-[#180b0b] px-5 py-4">
          <p className="font-mono text-xs tracking-wider text-[var(--color-red)] uppercase">
            circuit breaker tripped
          </p>
          <p className="mt-1 text-sm text-[var(--color-fg)]">{budget.breaker.reason}</p>
          <p className="mt-1 text-xs text-[var(--color-dim)]">
            All spending is halted. Nothing further will be purchased until it is reset.
          </p>
        </div>
      )}

      {/* ---- running P&L ---- */}
      <section className="mb-10">
        <SectionTitle>running P&amp;L</SectionTitle>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="revenue" value={usd(pnl.revenueCents)} tone="acc" />
          <Stat label="COGS (human labor)" value={`−${usd(pnl.cogsCents)}`} tone="sky" />
          <Stat label="OPEX (infra + traffic)" value={`−${usd(pnl.opexCents)}`} tone="muted" />
          <Stat
            label="net"
            value={`${pnl.netCents < 0 ? '−' : ''}${usd(pnl.netCents)}`}
            tone={pnl.netCents >= 0 ? 'acc' : 'red'}
          />
          <Stat
            label="budget left"
            value={`$${budget.remainingUsd.toFixed(2)}`}
            sub={`of $${budget.totalBudgetUsd}`}
            tone={budget.remainingUsd > 0 ? 'default' : 'red'}
          />
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-panel2)]">
          <div
            className="h-full bg-[var(--color-acc)] transition-[width] duration-500"
            style={{
              width: `${Math.min(100, (budget.spentUsd / Math.max(budget.totalBudgetUsd, 1)) * 100)}%`,
            }}
          />
        </div>
        <p className="mt-2 font-mono text-xs text-[var(--color-dim)]">
          ${budget.spentUsd.toFixed(2)} spent of ${budget.totalBudgetUsd} portfolio ceiling · $
          {budget.perBusinessBudgetUsd}/business · ${budget.perEscalationCapUsd}/escalation cap ·
          breaker {budget.breakerEnabled ? 'armed' : 'disabled'}
        </p>
      </section>

      {/* ---- portfolio ---- */}
      <section className="mb-10">
        <SectionTitle>portfolio</SectionTitle>
        {data.businesses.length === 0 ? (
          <Empty>No businesses yet. The next CEO cycle will spawn one.</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data.businesses.map((b) => (
              <article
                key={b.id}
                className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium">{b.name}</h3>
                    <p className="truncate text-xs text-[var(--color-dim)]">{b.niche}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-wider ${STATUS_STYLE[b.status]}`}
                  >
                    {b.status}
                  </span>
                </div>

                {b.url && (
                  <a
                    href={b.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mb-3 block truncate font-mono text-xs text-[var(--color-acc)] underline underline-offset-2"
                  >
                    {b.url.replace(/^https?:\/\//, '')}
                  </a>
                )}

                <dl className="grid grid-cols-4 gap-2 border-t border-[var(--color-line)] pt-3 font-mono text-xs">
                  <Cell label="revenue" value={usd(b.pnl.revenueCents)} />
                  <Cell label="spend" value={usd(b.pnl.spendCents)} />
                  <Cell
                    label="CAC"
                    value={b.cacUsd === null ? '—' : `$${b.cacUsd.toFixed(2)}`}
                  />
                  <Cell label="visits" value={`${b.visitors}/${b.conversions}`} />
                </dl>

                {b.pnl.cogsCents > 0 && (
                  <p className="mt-2 font-mono text-[11px] text-[#7dd3fc]">
                    incl. {usd(b.pnl.cogsCents)} bought human labor (COGS)
                  </p>
                )}
                {b.kill_reason && (
                  <p className="mt-2 line-clamp-3 text-xs text-[var(--color-red)]">
                    killed: {b.kill_reason}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ---- allocation log ---- */}
      <section className="mb-10">
        <SectionTitle>
          allocation log{' '}
          <span className="ml-2 font-normal text-[var(--color-dim)] normal-case">
            append-only · the agent&apos;s own reasoning
          </span>
        </SectionTitle>
        <div className="thin-scroll max-h-[26rem] overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
          {merged.length === 0 ? (
            <Empty>No decisions recorded yet.</Empty>
          ) : (
            merged.map((d, i) => (
              <div
                key={d.id}
                className={`border-b border-[var(--color-line)] px-5 py-3 last:border-0 ${i === 0 ? 'row-in' : ''}`}
              >
                <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
                  <span className="text-[var(--color-dim)]">{timeOf(d.created_at)}</span>
                  <span className={ACTION_COLOR[d.action] ?? 'text-[var(--color-fg)]'}>
                    {d.action}
                  </span>
                  {d.business_id && (
                    <span className="text-[var(--color-dim)]">{d.business_id}</span>
                  )}
                  <span className="text-[var(--color-dim)]">
                    conf {Number(d.confidence).toFixed(2)} · {d.model}
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed text-[#c8cdd4]">{d.reasoning}</p>
              </div>
            ))
          )}
        </div>
      </section>

      {/* ---- escalations ---- */}
      <section className="mb-10">
        <SectionTitle>
          labor escalations{' '}
          <span className="ml-2 font-normal text-[var(--color-dim)] normal-case">
            quote → budget check → purchase or decline
          </span>
        </SectionTitle>
        {data.escalations.length === 0 ? (
          <Empty>No escalations yet.</Empty>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
            {data.escalations.map((e) => (
              <div key={e.id} className="border-b border-[var(--color-line)] px-5 py-3 last:border-0">
                <div className="mb-1 flex flex-wrap items-center gap-x-3 font-mono text-[11px]">
                  <span className="text-[var(--color-dim)]">{timeOf(e.created_at)}</span>
                  <span
                    className={
                      e.decision === 'purchased'
                        ? 'text-[#7dd3fc]'
                        : 'text-[var(--color-amber)]'
                    }
                  >
                    {e.decision.toUpperCase()}
                  </span>
                  <span className="text-[var(--color-fg)]">{usd(e.quote_total_cents)}</span>
                  <span className="text-[var(--color-dim)]">via {e.provider}</span>
                </div>
                <p className="text-[13px] text-[#c8cdd4]">{e.question}</p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">{e.reason}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---- ledger ---- */}
      <section className="mb-10">
        <SectionTitle>ledger</SectionTitle>
        <div className="thin-scroll max-h-64 overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
          {data.ledger.length === 0 ? (
            <Empty>No entries yet.</Empty>
          ) : (
            data.ledger.map((row) => (
              <div
                key={row.id}
                className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-2 font-mono text-xs last:border-0"
              >
                <span className="text-[var(--color-dim)]">{timeOf(row.created_at)}</span>
                <span
                  className={`w-24 shrink-0 ${
                    row.kind === 'REVENUE'
                      ? 'text-[var(--color-acc)]'
                      : row.kind === 'COGS'
                        ? 'text-[#7dd3fc]'
                        : 'text-[var(--color-muted)]'
                  }`}
                >
                  {row.kind}
                </span>
                <span className="flex-1 truncate text-[var(--color-muted)]">{row.description}</span>
                <span className={Number(row.amount_cents) >= 0 ? 'text-[var(--color-acc)]' : ''}>
                  {Number(row.amount_cents) >= 0 ? '+' : '−'}
                  {usd(row.amount_cents)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* ---- providers ---- */}
      <section className="mb-14">
        <SectionTitle>
          capabilities{' '}
          <span className="ml-2 font-normal text-[var(--color-dim)] normal-case">
            flip a flag, no code edit
          </span>
        </SectionTitle>
        <div className="grid gap-2 md:grid-cols-2">
          {data.providers.map((c) => (
            <div
              key={c.capability}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3 font-mono text-xs"
            >
              <span className="w-20 shrink-0 text-[var(--color-muted)]">{c.capability}</span>
              {c.options.map((o) => (
                <span
                  key={o.name}
                  title={o.requires.length ? `needs ${o.requires.join(', ')}` : 'no key required'}
                  className={`rounded border px-2 py-0.5 ${
                    o.isActive
                      ? 'border-[var(--color-accdim)] bg-[#0d2417] text-[var(--color-acc)]'
                      : o.configured
                        ? 'border-[var(--color-line)] text-[var(--color-muted)]'
                        : 'border-[var(--color-line)] text-[var(--color-dim)]'
                  }`}
                >
                  {o.name}
                  {!o.configured && !o.isActive ? ' ·' : ''}
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-[var(--color-line)] pt-5 font-mono text-[11px] leading-relaxed text-[var(--color-dim)]">
        Every business above was proposed, priced, deployed and judged by an agent. Ledger and
        decision tables are append-only at the database level.
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------

function mergeLog(live: Decision[], stored: Decision[]): Decision[] {
  const byId = new Map<string, Decision>();
  for (const row of [...live, ...stored]) byId.set(row.id, row);
  return [...byId.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 font-mono text-[11px] tracking-[0.14em] text-[var(--color-muted)] uppercase">
      {children}
    </h2>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-[var(--color-line)] px-5 py-6 text-center text-sm text-[var(--color-dim)]">
      {children}
    </p>
  );
}

const TONE: Record<string, string> = {
  acc: 'text-[var(--color-acc)]',
  red: 'text-[var(--color-red)]',
  sky: 'text-[#7dd3fc]',
  muted: 'text-[var(--color-muted)]',
  default: 'text-[var(--color-fg)]',
};

function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: keyof typeof TONE;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3">
      <p className="mb-1 font-mono text-[10px] tracking-wider text-[var(--color-dim)] uppercase">
        {label}
      </p>
      <p className={`font-mono text-xl tracking-tight ${TONE[tone]}`}>{value}</p>
      {sub && <p className="mt-0.5 font-mono text-[10px] text-[var(--color-dim)]">{sub}</p>}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] text-[var(--color-dim)]">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
