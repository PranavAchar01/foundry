'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * One company, everything at once.
 *
 * No tabs: the storefront, the machine running it, the traction and the agent's
 * reasoning are all on screen together, because the whole point is seeing that
 * they belong to the same thing.
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

/**
 * The viewport the storefront is rendered at before being scaled to fit.
 *
 * A real desktop frame, deliberately. These heroes are sized in `vh`, so a
 * taller iframe does not reveal more page — it stretches the hero. 1280x900
 * renders the design at the proportions it was built for, and scaling that
 * whole frame down means the complete hero, price and CTA are visible rather
 * than the top slice of them.
 */
const SITE_W = 1280;
const SITE_H = 900;

/**
 * The storefront, whole.
 *
 * Dropping the page into a pane-width iframe crops it — you get the top 420px
 * of a full-height hero and nothing else. So it is rendered at a real desktop
 * viewport and scaled down by however much it takes to fit the pane, with the
 * container's height following the same scale. The result is the entire frame,
 * proportioned correctly, rather than a window onto its top-left corner.
 */
function SiteFrame({ url, title }: { url: string; title: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / SITE_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className="relative w-full overflow-hidden bg-[var(--color-panel2)]"
         style={{ height: scale ? SITE_H * scale : 420 }}>
      {!painted && <div className="shimmer absolute inset-0" />}
      {scale > 0 && (
        <iframe
          src={url}
          title={title}
          scrolling="no"
          onLoad={() => setPainted(true)}
          sandbox="allow-scripts allow-same-origin"
          className="absolute top-0 left-0 origin-top-left border-0"
          style={{ width: SITE_W, height: SITE_H, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}

export default function CompanyDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [console_, setConsole] = useState<string>('');
  const [consoleAt, setConsoleAt] = useState<string>('');
  const [consoleErr, setConsoleErr] = useState<string>('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await fetch(`/api/company/${id}`, { cache: 'no-store' });
      if (alive && res.ok) setData((await res.json()) as Detail);
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);

  // The live OS view: raw stdout from a real command on the real machine.
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      source = new EventSource(`/api/company/${id}/console`);
      source.addEventListener('frame', (ev) => {
        const f = JSON.parse((ev as MessageEvent).data) as { at: string; text: string };
        setConsole(f.text);
        setConsoleAt(f.at);
        setConsoleErr('');
      });
      source.addEventListener('error', (ev) => {
        const raw = (ev as MessageEvent).data;
        if (raw) setConsoleErr((JSON.parse(raw) as { message: string }).message);
      });
      // The endpoint closes itself before the platform timeout; reconnect.
      source.onerror = () => {
        source?.close();
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, [id]);

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
  const m = data?.machine;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#170c2b]/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card-shadow-lg w-full max-w-[1400px] overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-bg)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-normal">{b?.name ?? 'loading…'}</h2>
            <p className="truncate text-sm text-[var(--color-muted)]">{b?.tagline || b?.niche}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3 font-mono text-[10px]">
            {b?.url && (
              <a href={b.url} target="_blank" rel="noreferrer" className="text-[var(--color-fg)] underline underline-offset-2 hover:text-[var(--color-acc)]">
                site ↗
              </a>
            )}
            {m?.previewUrl && (
              <a href={m.previewUrl} target="_blank" rel="noreferrer" className="text-[var(--color-fg)] underline underline-offset-2 hover:text-[var(--color-acc)]">
                machine ↗
              </a>
            )}
            <button
              onClick={onClose}
              className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3.5 py-1.5 text-xs text-[var(--color-fg)] transition hover:bg-[var(--color-accdim)]"
            >
              close ✕
            </button>
          </div>
        </header>

        {/* traction, plainly, across the top */}
        <div className="grid grid-cols-3 gap-px border-b border-[var(--color-line)] bg-[var(--color-line)] md:grid-cols-6">
          <Metric label="visitors" value={t ? String(t.visitors) : '—'} />
          <Metric label="sales" value={t ? String(t.conversions) : '—'} />
          <Metric label="revenue" value={t ? `$${t.revenueUsd.toFixed(2)}` : '—'} tone={t && t.revenueUsd > 0 ? 'acc' : 'default'} />
          <Metric label="spend" value={t ? `$${t.spendUsd.toFixed(2)}` : '—'} />
          <Metric
            label="net"
            value={t ? `${t.netUsd < 0 ? '−' : ''}$${Math.abs(t.netUsd).toFixed(2)}` : '—'}
            tone={t && t.netUsd >= 0 ? 'acc' : 'red'}
          />
          <Metric label="CAC" value={t?.cacUsd == null ? '—' : `$${t.cacUsd.toFixed(2)}`} />
        </div>

        {/* the website and the machine, side by side */}
        <div className="grid gap-px bg-[var(--color-line)] lg:grid-cols-2">
          <Pane
            title="the website customers see"
            sub={b?.url?.replace(/^https?:\/\//, '') ?? ''}
            badge={b ? b.status : ''}
          >
            {b?.url ? (
              <SiteFrame url={b.url} title={`${b.name} storefront`} />
            ) : (
              <Empty>No storefront.</Empty>
            )}
          </Pane>

          <Pane
            title="the machine running the company · live"
            sub={m ? `${m.externalId.slice(0, 8)} · ${m.provider} · ${m.status} · $${m.billedUsd.toFixed(2)} of machine time` : 'no machine'}
            badge={m?.status ?? ''}
          >
            {m ? (
              <div className="relative h-full min-h-[320px] bg-[var(--color-panel2)] lg:min-h-[420px]">
                <pre className="thin-scroll h-full overflow-auto px-4 py-3 font-mono text-[11px] leading-[1.45] whitespace-pre text-[var(--color-fg)]">
{console_ ||
  (consoleErr
    ? /conflict|valid state/i.test(consoleErr)
      ? 'machine is parked — waking it…'
      : `! ${consoleErr}`
    : 'connecting to the machine…')}
                </pre>
                <span className="absolute right-3 bottom-2 font-mono text-[9.5px] text-[var(--color-dim)]">
                  {consoleAt ? `live · ${clock(consoleAt)}` : 'live'}
                </span>
              </div>
            ) : (
              <Empty>No machine attached to this company.</Empty>
            )}
          </Pane>
        </div>

        {/* what the machine has been doing, and what the agent concluded */}
        <div className="grid gap-px border-t border-[var(--color-line)] bg-[var(--color-line)] lg:grid-cols-2">
          <div className="bg-[var(--color-panel2)]">
            <PaneTitle>machine shell</PaneTitle>
            <div className="thin-scroll max-h-56 overflow-y-auto px-4 pb-3 font-mono text-[11px]">
              {(data?.runs.length ?? 0) === 0 ? (
                <p className="text-[var(--color-dim)]">
                  no commands yet — the operator works this machine each cycle
                </p>
              ) : (
                data!.runs.map((r) => (
                  <div key={r.id} className="mb-2">
                    <div className="flex gap-2">
                      <span className="shrink-0 text-[var(--color-dim)]">{clock(r.created_at)}</span>
                      <span className={`shrink-0 ${r.exit_code === 0 ? 'text-[var(--color-dim)]' : 'text-[var(--color-acc)] font-semibold'}`}>
                        {r.exit_code === 0 ? '$' : `✗${r.exit_code}`}
                      </span>
                      <span className="break-all whitespace-pre-wrap text-[var(--color-fg)]">
                        {r.command.replace(/^cd \/root\/company && /, '')}
                      </span>
                    </div>
                    {r.stdout.trim() && (
                      <pre className="mt-1 ml-[4.2rem] max-h-20 overflow-y-auto whitespace-pre-wrap break-all text-[10.5px] text-[var(--color-muted)]">
                        {r.stdout.trim().slice(0, 700)}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-[var(--color-panel)]">
            <PaneTitle>what the agent decided</PaneTitle>
            <div className="thin-scroll max-h-56 overflow-y-auto px-4 pb-3">
              {(data?.decisions.length ?? 0) === 0 ? (
                <p className="font-mono text-[11px] text-[var(--color-dim)]">nothing recorded yet</p>
              ) : (
                data!.decisions.map((d) => (
                  <p key={d.id} className="mb-2 text-[12px] leading-relaxed text-[var(--color-fg)]">
                    <span className="font-mono text-[10px] text-[var(--color-dim)]">
                      {clock(d.created_at)}{' '}
                    </span>
                    <span className="font-mono text-[10px] font-medium text-[var(--color-fg)]">{d.action} </span>
                    {d.reasoning.slice(0, 400)}
                  </p>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  acc: 'text-[var(--color-acc)] font-medium',
  red: 'text-[var(--color-muted)]',
  default: 'text-[var(--color-fg)]',
};

function Metric({ label, value, tone = 'default' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-[var(--color-panel2)] px-4 py-3">
      <p className="font-mono text-[9.5px] tracking-wider text-[var(--color-dim)] uppercase">{label}</p>
      <p className={`mt-0.5 font-mono text-lg ${TONE[tone]}`}>{value}</p>
    </div>
  );
}

function PaneTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-2 font-mono text-[10px] tracking-wider text-[var(--color-muted)] uppercase">
      {children}
    </p>
  );
}

function Pane({
  title,
  sub,
  badge,
  children,
}: {
  title: string;
  sub: string;
  badge: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex h-full flex-col bg-[var(--color-panel)]">
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-wider text-[var(--color-muted)] uppercase">
            {title}
          </p>
          <p className="truncate font-mono text-[10px] text-[var(--color-dim)]">{sub}</p>
        </div>
        {badge && (
          <span className="shrink-0 rounded-full border border-[var(--color-line)] px-2 py-0.5 font-mono text-[9px] tracking-wider text-[var(--color-muted)]">
            {badge}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center p-8 text-center text-sm text-[var(--color-dim)] lg:min-h-[420px]">
      {children}
    </div>
  );
}
