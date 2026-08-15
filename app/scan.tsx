'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The scan.
 *
 * A continuous reel of the real network runs under a fixed reticle. Accounts
 * that clear the filter flash and lock into the shortlist on the right as they
 * are passed; everything else dims and keeps moving. When the reel finishes the
 * shortlist expands into the final grid.
 *
 * The rAF loop touches the DOM directly and deliberately: it writes one
 * transform and moves one CSS class. Driving row emphasis through React state
 * instead means re-rendering the whole list on every frame, which starves the
 * main thread badly enough to stall animations running next to it — so the only
 * things that reach React here are the shortlist locking in and a throttled
 * counter.
 */

export interface ScanTarget {
  username: string;
  reason?: string;
}

interface Props {
  pool: string[];
  chosen: ScanTarget[];
  active: boolean;
  onDone?: () => void;
}

type Phase = 'sweep' | 'settled';

const ROW_H = 26;
const SWEEP_MS = 4200;
const VISIBLE = 11;
/** The counter is read, not watched — refreshing it ~12×/s is plenty. */
const COUNTER_MS = 80;

export default function Scan({ pool, chosen, active, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('sweep');
  const [scanned, setScanned] = useState(0);
  const [locked, setLocked] = useState<string[]>([]);

  const reel = useRef<HTMLDivElement | null>(null);
  const reticle = useRef<HTMLDivElement | null>(null);
  const raf = useRef<number | null>(null);
  const lockedRef = useRef<Set<string>>(new Set());
  const lastIndex = useRef(-1);
  const currentRow = useRef<HTMLElement | null>(null);
  const flashUntil = useRef(0);

  const chosenSet = useMemo(
    () => new Set(chosen.map((c) => c.username.toLowerCase())),
    [chosen],
  );

  /*
   * Put the shortlist at even intervals through the reel so matches land
   * steadily instead of clumping wherever the follower count happened to sort
   * them. The handles are real; only their position in the reel is arranged.
   */
  const ordered = useMemo(() => {
    if (!pool.length) return [];
    const rest = pool.filter((p) => !chosenSet.has(p.toLowerCase()));
    const out = [...rest];
    const names = chosen.map((c) => c.username);
    const gap = Math.max(1, Math.floor(out.length / (names.length + 1)));
    names.forEach((n, i) => out.splice(Math.min(out.length, (i + 1) * gap), 0, n));
    return out;
  }, [pool, chosen, chosenSet]);

  useEffect(() => {
    if (!active) {
      setPhase('sweep');
      setScanned(0);
      setLocked([]);
      lockedRef.current = new Set();
      lastIndex.current = -1;
      currentRow.current = null;
      return;
    }
    if (phase !== 'sweep' || ordered.length === 0) return;

    const started = performance.now();
    let counterAt = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / SWEEP_MS);
      // Fast start, long settle — reads as "searching" then "deciding".
      const eased = 1 - Math.pow(1 - t, 2.4);
      const pos = eased * (ordered.length - 1);
      const i = Math.floor(pos);

      if (reel.current) {
        reel.current.style.transform = `translate3d(0, ${-pos * ROW_H}px, 0)`;
      }

      if (i !== lastIndex.current) {
        // Move the emphasis by hand: two class writes, whatever the reel size.
        const next = reel.current?.children[i] as HTMLElement | undefined;
        if (next !== currentRow.current) {
          currentRow.current?.classList.remove('is-current');
          next?.classList.add('is-current');
          currentRow.current = next ?? null;
        }

        /*
         * The reel crosses several rows per frame at speed, so checking only the
         * row under the reticle silently skips matches — which is what made the
         * counter disagree with the shortlist. Sweep everything crossed since
         * the last frame instead.
         */
        for (let k = lastIndex.current + 1; k <= i; k++) {
          const handle = ordered[k];
          if (!handle || !chosenSet.has(handle.toLowerCase())) continue;
          if (lockedRef.current.has(handle)) continue;
          lockedRef.current.add(handle);
          setLocked((prev) => [...prev, handle]);
          flashUntil.current = now + 380;
        }
        lastIndex.current = i;
      }

      if (reticle.current) {
        reticle.current.classList.toggle('reticle-hot', now < flashUntil.current);
      }
      if (now - counterAt > COUNTER_MS) {
        counterAt = now;
        setScanned(i + 1);
      }

      if (t < 1) {
        raf.current = requestAnimationFrame(tick);
        return;
      }

      setScanned(ordered.length);
      setTimeout(() => {
        // Anything the sweep somehow missed still lands when it settles.
        setLocked(chosen.map((c) => c.username));
        setPhase('settled');
        onDone?.();
      }, 320);
    };

    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [active, phase, ordered, chosenSet, chosen, onDone]);

  if (!active) return null;

  const seen = Math.min(scanned, ordered.length);
  const progress = ordered.length ? seen / ordered.length : 0;

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-bg)]">
      {/* header */}
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              phase === 'sweep' ? 'bg-[var(--color-fg)] pulse' : 'bg-[var(--color-dim)]'
            }`}
          />
          <span className="font-mono text-[11px] tracking-wide text-[var(--color-muted)]">
            {phase === 'sweep' ? 'scanning network' : 'shortlist'}
          </span>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-[var(--color-dim)]">
          {seen.toLocaleString()} / {ordered.length.toLocaleString()}
          <span className="mx-2 text-[var(--color-line)]">·</span>
          <span className="text-[var(--color-fg)]">{locked.length} matched</span>
        </span>
      </div>

      {phase === 'sweep' ? (
        <div className="grid grid-cols-[1fr_auto] gap-px bg-[var(--color-line)]">
          {/* the reel */}
          <div
            className="relative overflow-hidden bg-[var(--color-bg)]"
            style={{
              height: VISIBLE * ROW_H,
              maskImage:
                'linear-gradient(to bottom, transparent, #000 22%, #000 78%, transparent)',
              WebkitMaskImage:
                'linear-gradient(to bottom, transparent, #000 22%, #000 78%, transparent)',
            }}
          >
            <div
              ref={reel}
              className="absolute inset-x-0 will-change-transform"
              style={{ top: (VISIBLE * ROW_H) / 2 - ROW_H / 2 }}
            >
              {ordered.map((h, i) => {
                const isMatch = chosenSet.has(h.toLowerCase());
                return (
                  <div
                    key={`${h}-${i}`}
                    className={`scan-row${isMatch ? ' is-match' : ''}`}
                    style={{ height: ROW_H }}
                  >
                    <span className="truncate">@{h}</span>
                    {isMatch && <span className="scan-match">MATCH</span>}
                  </div>
                );
              })}
            </div>

            {/* reticle */}
            <div className="pointer-events-none absolute top-1/2 right-3 left-3 -translate-y-1/2">
              <div ref={reticle} className="reticle h-[26px] rounded-md border" />
            </div>
          </div>

          {/* the locking shortlist */}
          <div
            className="w-[210px] bg-[var(--color-panel)] px-4 py-3"
            style={{ height: VISIBLE * ROW_H }}
          >
            <p className="mb-2 font-mono text-[9.5px] tracking-[0.14em] text-[var(--color-dim)] uppercase">
              targetable
            </p>
            <div className="space-y-1.5">
              {locked.map((h) => (
                <p
                  key={h}
                  className="truncate font-mono text-[11.5px]"
                  style={{ animation: 'foundry-in .32s ease-out' }}
                >
                  @{h}
                </p>
              ))}
              {locked.length === 0 && (
                <p className="font-mono text-[11px] text-[var(--color-dim)]">—</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-px bg-[var(--color-line)] sm:grid-cols-4">
          {chosen.map((c, i) => (
            <div
              key={c.username}
              className="bg-[var(--color-panel)] px-4 py-3"
              style={{ animation: `foundry-in .4s ease-out ${i * 45}ms both` }}
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

      {/* progress */}
      <div className="h-[2px] bg-[var(--color-line)]">
        <div
          className="h-full bg-[var(--color-fg)]"
          style={{ width: `${progress * 100}%`, transition: 'width .12s linear' }}
        />
      </div>
    </div>
  );
}
