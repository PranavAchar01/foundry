'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import CompanyDetail, { type Prospect } from './detail';
import ClientRun, { type RunPerson } from './client-run';

/**
 * One page. Every company is a tile showing its actual hero page, live.
 * Click a tile and you get the site, the machine running it, and the numbers.
 *
 * A company built for a named person carries their handle on the tile. While a
 * run is in flight the same grid holds the people it is still building for, so
 * the eight tiles appear the moment they are chosen and fill in one by one
 * instead of arriving all at once when the last build finishes.
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
  /** The person this was built for; empty when it belongs to nobody in particular. */
  prospectUsername: string;
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

interface Opened {
  id: string;
  prospect: Prospect | null;
}

export default function Dashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [machines, setMachines] = useState<MachineLite[]>([]);
  const [people, setPeople] = useState<RunPerson[]>([]);
  const [open, setOpen] = useState<Opened | null>(null);
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
      const payload = p as Payload;
      // A row written before the prospect column was migrated in comes back
      // without the field at all, and the grid reads it as a handle on every
      // card it lays out — which took the whole page down rather than one tile.
      setData({
        ...payload,
        businesses: payload.businesses.map((b) => ({
          ...b,
          prospectUsername: b.prospectUsername ?? '',
        })),
      });
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

  /*
   * People currently being run for come first and keep their place in the grid
   * from the moment they are chosen: the same tile carries them from queued to
   * built to DM'd. Once the portfolio catches up the card takes over inside
   * that tile, which is why the run person and the card are matched here rather
   * than rendered as two separate cards that swap.
   *
   * Tiles are keyed by handle wherever there is one, so a tile keeps the same
   * identity when the run state falls away and only the card is left. A key
   * that changed there would remount the tile and reload the site inside it.
   */
  const byHandle = new Map(
    data.businesses.filter((b) => b.prospectUsername).map((b) => [b.prospectUsername.toLowerCase(), b]),
  );
  const inRun = new Set(people.map((p) => p.target.username.toLowerCase()));
  const key = (handle: string, id: string) => (handle ? `p-${handle.toLowerCase()}` : id);
  const tiles: { key: string; card?: Card; person?: RunPerson }[] = [
    ...people.map((person) => ({
      key: key(person.target.username, ''),
      card: byHandle.get(person.target.username.toLowerCase()),
      person,
    })),
    ...data.businesses
      .filter((b) => !inRun.has(b.prospectUsername.toLowerCase()))
      .map((card) => ({ key: key(card.prospectUsername, card.id), card })),
  ];

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
              An autonomous holding company · {live.length}{' '}
              {live.length === 1 ? 'company' : 'companies'} live
            </p>
            <h1
              className="hero-title text-[clamp(48px,7.2vw,88px)] leading-[1.05] font-normal tracking-[-0.015em] text-white"
              style={{ textShadow: '0 4px 50px rgba(11,6,20,0.7)' }}
            >
              The holding company
              <br />
              with no employees.
            </h1>
            <a className="hero-cta btn-ember mt-9" href="#run">
              Watch it find a client
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

      <ClientRun onPeople={setPeople} onSettled={refresh} />

      {/* ---- the wall of companies ---- */}
      {tiles.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--color-line)] px-6 py-16 text-center text-sm text-[var(--color-dim)]">
          No companies yet. Press <span className="text-[var(--color-fg)]">Run it</span> and one gets
          built for every person it finds.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {tiles.map((t, i) => (
            <Tile
              key={t.key}
              card={t.card}
              person={t.person}
              machine={machines.find(
                (x) => x.businessId === (t.card?.id ?? t.person?.businessId),
              )}
              index={i}
              onOpen={setOpen}
            />
          ))}
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

      {open && (
        <CompanyDetail id={open.id} prospect={open.prospect} onClose={() => setOpen(null)} />
      )}
    </main>
  );
}

/**
 * One company on the wall.
 *
 * The same component draws a finished company and one that is still being
 * built, because they are the same tile at different moments — swapping
 * components mid-run would remount the iframe and reload the site under it.
 */
function Tile({
  card,
  person,
  machine,
  index,
  onOpen,
}: {
  card?: Card;
  person?: RunPerson;
  machine?: MachineLite;
  index: number;
  onOpen: (o: Opened) => void;
}) {
  const handle = person?.target.username ?? card?.prospectUsername ?? '';
  const url = card?.url || person?.url || '';
  const name = card?.name ?? person?.target.niche.name ?? '';
  const sub = card?.niche || person?.target.niche.tagline || '';
  const id = card?.id ?? person?.businessId ?? null;
  const build = person?.build ?? 'live';

  return (
    <button
      onClick={() =>
        id &&
        onOpen({
          id,
          prospect: handle
            ? {
                username: handle,
                evidence: person?.target.evidence ?? null,
                dm: person?.dm === 'sent' ? person.message : null,
              }
            : null,
        })
      }
      disabled={!id}
      style={{ animationDelay: `${Math.min(index, 11) * 45}ms` }}
      className={`group card-shadow relative overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] text-left tile-in ${
        id ? 'card-hover' : 'cursor-default'
      } ${build === 'live' && person ? 'tile-land' : ''}`}
    >
      {/* the company's actual hero page — or an honest account of why it isn't there yet */}
      <div className="relative h-44 overflow-hidden border-b border-[var(--color-line)] bg-[var(--color-panel2)]">
        {url ? (
          <TilePreview url={url} name={name} />
        ) : build === 'building' ? (
          <>
            <div className="shimmer absolute inset-0" />
            <div className="absolute inset-0 flex items-center justify-center gap-2 font-mono text-[11px] text-[var(--color-muted)]">
              <span className="pulse inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-acc)]" />
              building the site
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center font-mono text-[11px] text-[var(--color-dim)]">
            {build === 'queued'
              ? 'queued — waiting for a builder'
              : build === 'failed'
                ? (person?.buildError ?? 'build failed')
                : 'no storefront'}
          </div>
        )}

        {card?.status === 'KILLED' && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0b0614]/70 text-[11px] font-medium tracking-[0.18em] text-[var(--color-fg)] backdrop-blur-[2px]">
            KILLED
          </div>
        )}

        {card ? (
          <span
            className={`absolute top-2 right-2 rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-wider ${STATUS[card.status]}`}
          >
            {card.status}
          </span>
        ) : (
          <span className="absolute top-2 right-2 rounded-full border border-[var(--color-line)] bg-[#0b0614]/80 px-2 py-0.5 font-mono text-[9px] tracking-wider text-[var(--color-muted)] backdrop-blur-sm">
            {build.toUpperCase()}
          </span>
        )}

        {machine && (
          <span className="absolute bottom-2 left-2 rounded-full border border-[var(--color-line)] bg-[#0b0614]/80 px-2 py-0.5 font-mono text-[9px] text-[var(--color-muted)] backdrop-blur-sm">
            {machine.status === 'active' ? <span className="pulse text-[var(--color-fg)]">● </span> : '○ '}
            VM {machine.status}
          </span>
        )}
      </div>

      <div className="px-4 py-3">
        {handle && (
          <p className="mb-1 flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-acc)]">
            <span className="truncate">@{handle}</span>
            {person && person.build === 'live' && person.buildMs > 0 && (
              <span className="ml-auto shrink-0 text-[10px] text-[var(--color-dim)]">
                built in {(person.buildMs / 1000).toFixed(1)}s
              </span>
            )}
          </p>
        )}
        <h3 className="truncate text-base font-normal">{name}</h3>
        <p className="truncate text-[11px] text-[var(--color-dim)]">{sub}</p>

        {card ? (
          <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px]">
            <Cell label="visits" value={String(card.visitors)} />
            <Cell label="sales" value={String(card.conversions)} />
            <Cell
              label="net"
              value={`${card.pnl.netCents < 0 ? '−' : ''}${usd(card.pnl.netCents)}`}
              tone={card.pnl.netCents >= 0 ? 'acc' : 'muted'}
            />
          </dl>
        ) : (
          person && (
            <p className="mt-3 font-mono text-[11px] text-[var(--color-muted)]">
              ${(person.target.niche.priceCents / 100).toFixed(2)}/month ·{' '}
              <span className="text-[var(--color-dim)]">{person.target.niche.targetCustomer}</span>
            </p>
          )
        )}
      </div>

      {/* the DM, on the tile of the person it goes to */}
      {person && person.dm !== 'waiting' && (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-bg)] px-4 py-2.5">
          <p className="font-mono text-[10px] tracking-wider uppercase">
            {person.dm === 'sending' && (
              <span className="text-[var(--color-muted)]">
                <span className="pulse mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-acc)] align-middle" />
                sending the DM
              </span>
            )}
            {person.dm === 'sent' && (
              <span className="text-[var(--color-acc)]">
                {person.followed ? 'followed · DM sent' : 'DM sent'}
              </span>
            )}
            {person.dm === 'failed' && (
              <span className="text-[var(--color-dim)]">DM not sent — {person.dmError}</span>
            )}
            {person.dm === 'skipped' && <span className="text-[var(--color-dim)]">no DM — nothing to send</span>}
          </p>
          {person.message && (
            <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
              {person.message}
            </p>
          )}
        </div>
      )}
    </button>
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
