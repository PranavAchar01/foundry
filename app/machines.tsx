'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The machine room.
 *
 * One panel per business VM: its boot log, its live shell, and a link to the
 * page the machine serves about itself. Commands stream in over SSE as the
 * operator agent runs them, so this is the company being operated, watched.
 */

interface Run {
  id: string;
  command: string;
  exitCode: number;
  stdout: string;
  durationMs: number;
  createdAt: string;
}

interface Machine {
  id: string;
  businessId: string;
  businessName: string;
  niche: string;
  provider: string;
  externalId: string;
  status: 'active' | 'paused' | 'killed';
  previewUrl: string;
  billedSeconds: number;
  billedUsd: number;
  createdAt: string;
  lastUsedAt: string;
  bootLog: string[];
  runs: Run[];
}

interface Payload {
  generatedAt: string;
  costPerHourUsd: number;
  idleMinutes: number;
  machines: Machine[];
}

const STATUS: Record<Machine['status'], { label: string; cls: string }> = {
  active: { label: 'RUNNING', cls: 'border-[var(--color-accdim)] bg-[#0d2417] text-[var(--color-acc)]' },
  paused: { label: 'PARKED', cls: 'border-[#3f3312] bg-[#241c07] text-[var(--color-amber)]' },
  killed: { label: 'DESTROYED', cls: 'border-[#3f1d1d] bg-[#240d0d] text-[var(--color-red)]' },
};

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour12: false });

function uptime(from: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function MachineRoom() {
  const [data, setData] = useState<Payload | null>(null);
  const [live, setLive] = useState<Record<string, Run[]>>({});
  const [connected, setConnected] = useState(false);
  const seen = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/machines', { cache: 'no-store' });
      if (res.ok) setData((await res.json()) as Payload);
    } catch {
      /* the stream keeps the view fresh between snapshots */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const source = new EventSource('/api/machines/stream');
    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('run', (ev) => {
      const row = JSON.parse((ev as MessageEvent).data) as Run & { business_id: string };
      if (seen.current.has(row.id)) return;
      seen.current.add(row.id);
      setLive((prev) => ({
        ...prev,
        [row.business_id]: [
          {
            id: row.id,
            command: row.command,
            exitCode: (row as unknown as { exit_code: number }).exit_code,
            stdout: row.stdout,
            durationMs: (row as unknown as { duration_ms: number }).duration_ms,
            createdAt: (row as unknown as { created_at: string }).created_at,
          },
          ...(prev[row.business_id] ?? []),
        ].slice(0, 40),
      }));
    });
    source.addEventListener('machines', (ev) => {
      const states = JSON.parse((ev as MessageEvent).data) as {
        business_id: string;
        status: Machine['status'];
        preview_url: string;
      }[];
      setData((prev) =>
        prev
          ? {
              ...prev,
              machines: prev.machines.map((m) => {
                const s = states.find((x) => x.business_id === m.businessId);
                return s ? { ...m, status: s.status, previewUrl: s.preview_url || m.previewUrl } : m;
              }),
            }
          : prev,
      );
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  const machines = data?.machines ?? [];

  return (
    <section className="mb-10">
      <h2 className="mb-3 flex flex-wrap items-center gap-x-3 font-mono text-[11px] tracking-[0.14em] text-[var(--color-muted)] uppercase">
        machine room
        <span className="font-normal text-[var(--color-dim)] normal-case">
          one VM per company · {data ? `$${data.costPerHourUsd}/hr, parked after ${data.idleMinutes}m idle` : '…'}
        </span>
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            connected ? 'bg-[var(--color-acc)] pulse' : 'bg-[var(--color-dim)]'
          }`}
        />
      </h2>

      {machines.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] px-5 py-6 text-center text-sm text-[var(--color-dim)]">
          No machines yet. Each spawned business boots one.
        </p>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {machines.map((m) => {
            const runs = [...(live[m.businessId] ?? []), ...m.runs]
              .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i)
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .slice(0, 30);

            return (
              <article
                key={m.id}
                className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]"
              >
                {/* header */}
                <div className="flex items-start justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium">{m.businessName}</h3>
                    <p className="truncate font-mono text-[10px] text-[var(--color-dim)]">
                      {m.provider} · {m.externalId.slice(0, 18)}… · up {uptime(m.createdAt)} · $
                      {m.billedUsd.toFixed(2)}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-wider ${STATUS[m.status].cls}`}
                  >
                    {m.status === 'active' && <span className="pulse">● </span>}
                    {STATUS[m.status].label}
                  </span>
                </div>

                {/* boot log + preview */}
                <div className="border-b border-[var(--color-line)] px-4 py-2 font-mono text-[10.5px] text-[var(--color-dim)]">
                  <span className="text-[var(--color-muted)]">boot</span>{' '}
                  {m.bootLog.length ? m.bootLog.join(' · ') : 'seeded workspace, no boot log recorded'}
                  {m.previewUrl && (
                    <>
                      {' · '}
                      <a
                        href={m.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--color-acc)] underline underline-offset-2"
                      >
                        open live machine view ↗
                      </a>
                    </>
                  )}
                </div>

                {/* shell */}
                <div className="thin-scroll max-h-72 overflow-y-auto bg-[#060709] px-4 py-3 font-mono text-[11px] leading-relaxed">
                  {runs.length === 0 ? (
                    <p className="text-[var(--color-dim)]">
                      no commands yet — the operator works this machine each cycle
                    </p>
                  ) : (
                    runs.map((r, i) => (
                      <div key={r.id} className={i === 0 ? 'row-in mb-2' : 'mb-2'}>
                        <div className="flex gap-2">
                          <span className="shrink-0 text-[var(--color-dim)]">{time(r.createdAt)}</span>
                          <span
                            className={`shrink-0 ${r.exitCode === 0 ? 'text-[var(--color-acc)]' : 'text-[var(--color-red)]'}`}
                          >
                            {r.exitCode === 0 ? '$' : `✗${r.exitCode}`}
                          </span>
                          <span className="break-all whitespace-pre-wrap text-[#c8cdd4]">
                            {r.command.replace(/^cd \/root\/company && /, '')}
                          </span>
                        </div>
                        {r.stdout.trim() && (
                          <pre className="mt-1 ml-[4.2rem] max-h-28 overflow-y-auto whitespace-pre-wrap break-all text-[10.5px] text-[var(--color-muted)]">
                            {r.stdout.trim().slice(0, 1200)}
                          </pre>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
