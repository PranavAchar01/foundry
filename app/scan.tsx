'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The scan animation.
 *
 * Handles stream past, dim as they are ruled out, and the ones that survive
 * settle into the shortlist. The pacing is cosmetic; the handles, the counts and
 * the final list all come from the run itself, so what you watch is the real
 * result arriving rather than a canned reel.
 */

export interface ScanTarget {
  username: string;
  reason?: string;
}

interface Props {
  /** Every handle in the network, streamed past during the sweep. */
  pool: string[];
  /** Who survives. The animation lands here. */
  chosen: ScanTarget[];
  /** Called once the animation settles. */
  onDone?: () => void;
  active: boolean;
}

type Phase = 'sweep' | 'narrow' | 'settled';

export default function Scan({ pool, chosen, onDone, active }: Props) {
  const [phase, setPhase] = useState<Phase>('sweep');
  const [cursor, setCursor] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const raf = useRef<number | null>(null);

  // Sweep: run the cursor through the pool, counting as it goes.
  useEffect(() => {
    if (!active || phase !== 'sweep' || pool.length === 0) return;
    const started = performance.now();
    const duration = 2600;

    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      // Ease-out so it decelerates into the narrowing step.
      const eased = 1 - Math.pow(1 - t, 3);
      setCursor(Math.floor(eased * pool.length));
      setScanned(Math.floor(eased * pool.length));
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else setPhase('narrow');
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [active, phase, pool.length]);

  // Narrow: reveal the survivors one at a time.
  useEffect(() => {
    if (phase !== 'narrow') return;
    if (revealed >= chosen.length) {
      const t = setTimeout(() => {
        setPhase('settled');
        onDone?.();
      }, 400);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setRevealed((n) => n + 1), 220);
    return () => clearTimeout(t);
  }, [phase, revealed, chosen.length, onDone]);

  useEffect(() => {
    if (!active) {
      setPhase('sweep');
      setCursor(0);
      setScanned(0);
      setRevealed(0);
    }
  }, [active]);

  if (!active) return null;

  // A moving window of handles for the sweep.
  const window = pool.slice(Math.max(0, cursor - 9), cursor + 9);

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-bg)]">
      {/* status line */}
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2.5 font-mono text-[11px]">
        <span className="text-[var(--color-muted)]">
          {phase === 'sweep'
            ? 'scanning network'
            : phase === 'narrow'
              ? 'narrowing to targetable accounts'
              : 'shortlist'}
        </span>
        <span className="text-[var(--color-dim)] tabular-nums">
          {phase === 'sweep'
            ? `${scanned} / ${pool.length}`
            : `${chosen.length} of ${pool.length}`}
        </span>
      </div>

      {phase === 'sweep' && (
        <div className="relative h-[188px]">
          {/* the stream */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
            {window.map((h, i) => {
              const distance = Math.abs(i - 9);
              return (
                <div
                  key={`${h}-${i}`}
                  className="font-mono text-[12px] whitespace-nowrap transition-none"
                  style={{
                    opacity: Math.max(0.06, 1 - distance * 0.18),
                    transform: `scale(${Math.max(0.86, 1 - distance * 0.03)})`,
                    color: distance === 0 ? 'var(--color-fg)' : 'var(--color-dim)',
                    fontWeight: distance === 0 ? 600 : 400,
                  }}
                >
                  @{h}
                </div>
              );
            })}
          </div>
          {/* the reticle */}
          <div className="pointer-events-none absolute top-1/2 right-6 left-6 h-7 -translate-y-1/2 rounded-md border border-[var(--color-fg)]/25" />
          {/* progress */}
          <div className="absolute right-0 bottom-0 left-0 h-[2px] bg-[var(--color-line)]">
            <div
              className="h-full bg-[var(--color-fg)] transition-none"
              style={{ width: `${(scanned / Math.max(1, pool.length)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {(phase === 'narrow' || phase === 'settled') && (
        <div className="grid grid-cols-2 gap-px bg-[var(--color-line)] sm:grid-cols-4">
          {chosen.map((c, i) => (
            <div
              key={c.username}
              className="bg-[var(--color-panel)] px-4 py-3"
              style={{
                opacity: i < revealed || phase === 'settled' ? 1 : 0,
                transform: i < revealed || phase === 'settled' ? 'none' : 'translateY(6px)',
                transition: 'opacity .35s ease, transform .35s ease',
              }}
            >
              <p className="truncate font-mono text-[12px] font-medium">@{c.username}</p>
              {c.reason && (
                <p className="mt-0.5 truncate text-[10.5px] text-[var(--color-dim)]" title={c.reason}>
                  {c.reason}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
