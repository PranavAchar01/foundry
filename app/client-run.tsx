'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Scan from './scan';

/**
 * The run.
 *
 * One button. It reads the network, writes a different business for every
 * person it is allowed to contact, builds all of them at once, and DMs each
 * person the thing that was built for them.
 *
 * The client drives the sequence stage by stage — plan, sweep, a build per
 * person in parallel, then the DMs — rather than posting once and waiting. A
 * single server call doing all of that would run past the platform's request
 * ceiling, and it would show nothing at all until it was over. Split this way,
 * one slow build holds up only its own tile.
 *
 * Nothing here moves on a timer: a tile is live when its build returns a URL,
 * and a DM is sent when reach says it was sent.
 */

export interface Niche {
  name: string;
  slug: string;
  tagline: string;
  targetCustomer: string;
  offer: string;
  priceCents: number;
  bullets: string[];
  reasoning: string;
}

export interface RunTarget {
  username: string;
  bio: string;
  evidence: string;
  niche: Niche;
}

/** Two small machines per person: what got built, and whether the DM went out. */
export type BuildState = 'queued' | 'building' | 'live' | 'failed';
export type DmState = 'waiting' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface RunPerson {
  target: RunTarget;
  build: BuildState;
  dm: DmState;
  businessId: string | null;
  url: string | null;
  buildMs: number;
  message: string | null;
  followed: boolean;
  buildError: string | null;
  dmError: string | null;
}

interface PlanResponse {
  runId: string;
  pool: string[];
  targets: RunTarget[];
  error?: string;
}

interface BuildResponse {
  username: string;
  businessId: string | null;
  url: string | null;
  /** Written at build time so it can be read before it is sent. */
  message: string | null;
  ms: number;
  error: string | null;
}

interface ReachResponse {
  username: string;
  followed: boolean;
  dmSent: boolean;
  message: string | null;
  error: string | null;
}

type Stage =
  | 'idle'
  | 'planning'
  | 'scanning'
  | 'planned'
  | 'building'
  | 'built'
  | 'reaching'
  | 'done';

interface Props {
  /** The grid draws the tiles, so it gets the same per-person state this owns. */
  onPeople: (people: RunPerson[]) => void;
  /** A business just appeared or changed; the portfolio is worth re-reading. */
  onSettled: () => void;
}

const HEADLINE: Record<Stage, string> = {
  idle: '',
  planning: 'reading the network · writing a business for each person',
  scanning: 'sweeping the network',
  planned: 'dry run · planned only, nothing built and nothing sent',
  building: 'building every business at once',
  built: 'built · nothing sent yet',
  reaching: 'sending each person the thing built for them',
  done: 'run complete',
};

const clock = (s: number) =>
  s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;

export default function ClientRun({ onPeople, onSettled }: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const [pool, setPool] = useState<string[]>([]);
  const [people, setPeople] = useState<RunPerson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const runId = useRef('');
  const startedAt = useRef(0);
  const stageEl = useRef<HTMLElement | null>(null);
  const glideRaf = useRef(0);
  const sweptRef = useRef<(() => void) | null>(null);
  /* `sendAll` runs long and reads the list as it is now, not as it was on click. */
  const peopleRef = useRef<RunPerson[]>([]);

  const busy =
    stage === 'planning' || stage === 'scanning' || stage === 'building' || stage === 'reaching';

  useEffect(() => {
    peopleRef.current = people;
    onPeople(people);
  }, [people, onPeople]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [busy]);

  /*
   * The run is the point of the button, so bring it to the middle of the screen
   * instead of leaving it below the fold, then lift it to the top once builds
   * start so the tiles landing underneath are what you are looking at.
   *
   * The glide is hand-rolled because native smooth scrolling is a no-op on this
   * page: something above cancels the browser's animation, and an instant jump
   * is a worse answer than owning the easing.
   */
  const glide = useCallback((align: 'center' | 'top') => {
    const el = stageEl.current;
    if (!el) return;

    const box = el.getBoundingClientRect();
    const gap = align === 'center' ? Math.max(24, (window.innerHeight - box.height) / 2) : 80;
    const target = Math.max(0, window.scrollY + box.top - gap);
    const from = window.scrollY;
    const distance = target - from;
    if (Math.abs(distance) < 8) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      window.scrollTo(0, target);
      return;
    }

    const DURATION = 520;
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / DURATION);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      window.scrollTo(0, from + distance * eased);
      if (t < 1) glideRaf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(glideRaf.current);
    glideRaf.current = requestAnimationFrame(step);
  }, []);

  // Measured after the stage has re-rendered, so the height being centred is
  // the height the sweep actually takes up rather than the button's. The last
  // move is back to the middle: by then you are down among the tiles, and the
  // send is a decision that should not be waiting off the top of the screen.
  useEffect(() => {
    if (stage === 'scanning' || stage === 'built') glide('center');
    if (stage === 'building') glide('top');
  }, [stage, glide]);

  useEffect(() => () => cancelAnimationFrame(glideRaf.current), []);

  const patch = useCallback((username: string, next: Partial<RunPerson>) => {
    setPeople((prev) => prev.map((p) => (p.target.username === username ? { ...p, ...next } : p)));
  }, []);

  // The interval stops when the run does, so the final number is taken here
  // rather than left rounded down to whenever the last tick happened to fall.
  const stopClock = useCallback(
    () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)),
    [],
  );

  /** Builds wait for the sweep to settle rather than racing it off screen. */
  const waitForSweep = () =>
    new Promise<void>((resolve) => {
      sweptRef.current = resolve;
    });

  const onSweepDone = useCallback(() => {
    sweptRef.current?.();
    sweptRef.current = null;
  }, []);

  const reachOne = useCallback(
    async (username: string) => {
      patch(username, { dm: 'sending' });
      try {
        const res = await fetch('/api/demo/reach', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId: runId.current, username }),
        });
        const j = (await res.json()) as ReachResponse;
        patch(username, {
          dm: j.dmSent ? 'sent' : 'failed',
          followed: j.followed,
          message: j.message,
          dmError: j.dmSent ? null : (j.error ?? 'the DM did not send'),
        });
      } catch (err) {
        patch(username, { dm: 'failed', dmError: String(err) });
      }
    },
    [patch],
  );

  const execute = useCallback(
    async (targets: RunTarget[]) => {
      setStage('building');

      const builds = targets.map(async (t) => {
        const username = t.username;
        patch(username, { build: 'building' });
        try {
          const res = await fetch('/api/demo/build', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runId: runId.current, username }),
          });
          const j = (await res.json()) as BuildResponse;
          if (!j.url) {
            patch(username, {
              build: 'failed',
              dm: 'skipped',
              buildError: j.error ?? 'no site came back',
            });
            return;
          }
          patch(username, {
            build: 'live',
            businessId: j.businessId,
            url: j.url,
            buildMs: j.ms,
            message: j.message,
          });
          onSettled();
        } catch (err) {
          patch(username, { build: 'failed', dm: 'skipped', buildError: String(err) });
        }
      });

      await Promise.allSettled(builds);
      /*
       * Building stops here. Sending is a separate, deliberate act on its own
       * button: a DM to a real person cannot be taken back, and chaining it to
       * the build meant you could not re-run the build without messaging
       * everyone a second time.
       */
      setStage('built');
      stopClock();
      onSettled();
    },
    [patch, onSettled, stopClock],
  );

  /**
   * The second button. Messages queue rather than going out together — each one
   * quotes the site built for that person, and X throttles a burst of DMs from
   * a single account hard enough to lose half of them.
   */
  const sendAll = useCallback(async () => {
    setStage('reaching');
    for (const person of peopleRef.current) {
      if (person.build !== 'live') continue;
      if (person.dm === 'sent' || person.dm === 'sending') continue;
      await reachOne(person.target.username);
    }
    setStage('done');
    stopClock();
    onSettled();
  }, [reachOne, stopClock, onSettled]);

  const start = useCallback(
    async (dry: boolean) => {
      setError(null);
      setPeople([]);
      setElapsed(0);
      startedAt.current = Date.now();
      setStage('planning');

      try {
        const res = await fetch('/api/demo/plan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const j = (await res.json()) as PlanResponse;
        if (!res.ok) {
          setError(j.error ?? `plan failed (${res.status})`);
          setStage('idle');
          return;
        }
        if (j.targets.length === 0) {
          // /plan answers 200 with an empty target list and its own reason when
          // there is nobody it may build for. That reason is the useful one —
          // overwriting it with a guess is how a live run stalls on a message
          // that does not say what to fix.
          setError(j.error ?? 'nobody on the allowlist to build for');
          setStage('idle');
          return;
        }

        runId.current = j.runId;
        setPool(j.pool);
        setPeople(
          j.targets.map((target) => ({
            target,
            build: 'queued',
            dm: 'waiting',
            businessId: null,
            url: null,
            buildMs: 0,
            message: null,
            followed: false,
            buildError: null,
            dmError: null,
          })),
        );

        // An empty pool has nothing to sweep, and the sweep is what the builds
        // wait on — so skip straight past it rather than waiting forever.
        if (j.pool.length > 0) {
          setStage('scanning');
          await waitForSweep();
        }

        if (dry) {
          setStage('planned');
          stopClock();
          return;
        }
        await execute(j.targets);
      } catch (err) {
        setError(String(err));
        setStage('idle');
      }
    },
    [execute, stopClock],
  );

  const shortlist = useMemo(
    () => people.map((p) => ({ username: p.target.username, reason: p.target.evidence })),
    [people],
  );

  const built = people.filter((p) => p.build === 'live').length;
  const sent = people.filter((p) => p.dm === 'sent').length;
  const outreach = people.filter((p) => p.dm !== 'skipped' && (p.message || p.dm !== 'waiting'));

  if (stage === 'idle') {
    return (
      <section
        id="run"
        ref={stageEl}
        className="mb-10 flex min-h-[46vh] scroll-mt-20 flex-col items-center justify-center"
      >
        <p className="font-mono text-[10.5px] tracking-[0.16em] text-[var(--color-dim)] uppercase">
          the whole company, one button
        </p>
        <h2 className="mt-3 max-w-[16ch] text-center text-[clamp(30px,3.8vw,48px)] leading-[1.06]">
          Find the clients. Build each one a business.
        </h2>
        <p className="mt-4 max-w-[54ch] text-center text-[14px] leading-relaxed text-[var(--color-muted)]">
          It sweeps the network, writes a different product for every person it is allowed to
          contact, and builds all of them at once. Sending is a second, separate press.
        </p>

        <button onClick={() => void start(false)} className="btn-ember btn-ember-xl ember-halo mt-9">
          Run it
        </button>
        <button
          onClick={() => void start(true)}
          className="mt-4 text-[12.5px] text-[var(--color-dim)] underline underline-offset-4 transition hover:text-[var(--color-muted)]"
        >
          Dry run — plan only, nothing built
        </button>

        {error && (
          <p className="mt-6 max-w-[54ch] rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3 text-center text-[13px] text-[var(--color-muted)]">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section id="run" ref={stageEl} className="mb-10 scroll-mt-20">
      <div className="mx-auto w-full max-w-[980px] space-y-3">
        {/* where the run is, and how long it has taken */}
        <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                  busy ? 'pulse bg-[var(--color-acc)]' : 'bg-[var(--color-dim)]'
                }`}
              />
              <span className="truncate font-mono text-[11.5px] text-[var(--color-muted)]">
                {HEADLINE[stage]}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Step label="plan" state={stage === 'planning' ? 'active' : 'done'} note={`${people.length}`} />
              <Step
                label="build"
                state={stage === 'building' ? 'active' : built > 0 ? 'done' : 'idle'}
                note={`${built}/${people.length}`}
              />
              <Step
                label="reach"
                state={stage === 'reaching' ? 'active' : sent > 0 ? 'done' : 'idle'}
                note={`${sent}/${people.length}`}
              />
              <span className="ml-1 font-mono text-[11px] tabular-nums text-[var(--color-dim)]">
                {clock(elapsed)}
              </span>
            </div>
          </div>
        </div>

        {(stage === 'scanning' || stage === 'planned') && (
          <Scan pool={pool} chosen={shortlist} active onDone={onSweepDone} />
        )}

        {outreach.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]">
            <p className="border-b border-[var(--color-line)] px-5 py-2.5 font-mono text-[10px] tracking-[0.14em] text-[var(--color-dim)] uppercase">
              outreach · {stage === 'built' ? 'read these before you send them' : 'what each person is being sent'}
            </p>
            {outreach.map((p) => (
              <div
                key={p.target.username}
                className="row-in border-t border-[var(--color-line)] px-5 py-3 first:border-t-0"
              >
                <p className="font-mono text-[11.5px]">
                  <span className="text-[var(--color-fg)]">@{p.target.username}</span>
                  <span
                    className={`ml-2.5 ${
                      p.dm === 'sent' ? 'text-[var(--color-acc)]' : 'text-[var(--color-dim)]'
                    }`}
                  >
                    {p.dm === 'waiting' && 'drafted · not sent'}
                    {p.dm === 'sending' && 'sending…'}
                    {p.dm === 'sent' && `${p.followed ? 'followed · ' : ''}DM sent`}
                    {p.dm === 'failed' && `not sent — ${p.dmError ?? 'unknown'}`}
                  </span>
                </p>
                {p.message && (
                  <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-line text-[var(--color-muted)]">
                    {p.message}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {stage === 'planned' && (
          <div className="flex flex-wrap items-center justify-center gap-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-4 text-center">
            <p className="text-[13px] text-[var(--color-muted)]">
              {people.length} businesses planned. Nothing was built and nothing was sent.
            </p>
            <button
              onClick={() => void execute(people.map((p) => p.target))}
              className="btn-ember"
            >
              Build them
            </button>
          </div>
        )}

        {stage === 'built' && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-5 text-center">
            <p className="text-[13px] text-[var(--color-muted)]">
              <span className="text-[var(--color-fg)]">{built}</span> of {people.length} businesses
              are live. Nothing has been sent yet.
            </p>
            <button onClick={() => void sendAll()} className="btn-ember btn-ember-xl ember-halo" disabled={built === 0}>
              Send the DMs
            </button>
            <p className="max-w-[46ch] text-[11.5px] text-[var(--color-dim)]">
              {built} real message{built === 1 ? '' : 's'} to {built} real
              {built === 1 ? ' person' : ' people'}, one per person, each quoting the site built for
              them. This cannot be undone.
            </p>
          </div>
        )}

        {stage === 'done' && (
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-4 text-center">
            <p className="text-[13px] text-[var(--color-muted)]">
              <span className="text-[var(--color-fg)]">{built}</span> businesses live ·{' '}
              <span className="text-[var(--color-fg)]">{sent}</span> DMs sent · {clock(elapsed)}
            </p>
            <button
              onClick={() => {
                setPeople([]);
                setStage('idle');
              }}
              className="rounded-full border border-[var(--color-line)] px-4 py-2 text-[12.5px] text-[var(--color-muted)] transition hover:text-[var(--color-fg)]"
            >
              Run again
            </button>
          </div>
        )}

        {error && (
          <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3 text-[13px] text-[var(--color-muted)]">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function Step({
  label,
  state,
  note,
}: {
  label: string;
  state: 'idle' | 'active' | 'done';
  note: string;
}) {
  const tone =
    state === 'active'
      ? 'border-[var(--color-acc)] text-[var(--color-fg)]'
      : state === 'done'
        ? 'border-[var(--color-line)] text-[var(--color-muted)]'
        : 'border-[var(--color-line)] text-[var(--color-dim)]';
  return (
    <span
      className={`rounded-full border px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] uppercase ${tone}`}
    >
      {label} <span className="tabular-nums opacity-70">{note}</span>
    </span>
  );
}
