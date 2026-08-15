export const dynamic = 'force-dynamic';

export default async function Thanks({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; session?: string }>;
}) {
  const { business, session } = await searchParams;

  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <p className="mb-5 font-mono text-xs tracking-[0.14em] text-[var(--color-acc)] uppercase">
        payment received
      </p>
      <h1 className="mb-4 text-4xl font-semibold tracking-tight">Thank you.</h1>
      <p className="mb-8 text-[var(--color-muted)]">
        Your purchase has been recorded. The operating agent has already booked it to the ledger
        and will factor it into the next allocation cycle.
      </p>

      <dl className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 font-mono text-sm">
        <div className="flex justify-between gap-4 py-1">
          <dt className="text-[var(--color-dim)]">business</dt>
          <dd className="truncate">{business ?? '—'}</dd>
        </div>
        <div className="flex justify-between gap-4 py-1">
          <dt className="text-[var(--color-dim)]">session</dt>
          <dd className="truncate">{session ?? '—'}</dd>
        </div>
      </dl>

      <a
        href="/"
        className="mt-8 inline-block text-sm text-[var(--color-acc)] underline underline-offset-4"
      >
        ← Back to the portfolio
      </a>
    </main>
  );
}
