import { id, query } from './db';

export type LedgerKind = 'REVENUE' | 'REFUND' | 'COGS' | 'OPEX';

export interface LedgerEntryInput {
  businessId: string | null;
  kind: LedgerKind;
  /** Always positive here; sign is applied from `kind`. */
  amountCents: number;
  currency?: string;
  description: string;
  source?: string;
  /** Idempotency key. A replayed webhook must never double-book. */
  externalId?: string | null;
  meta?: Record<string, unknown>;
}

export interface LedgerEntry {
  id: string;
  business_id: string | null;
  kind: LedgerKind;
  amount_cents: string | number;
  currency: string;
  description: string;
  source: string;
  external_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

/** Money out is stored negative, so the P&L is a plain SUM. */
export function signed(kind: LedgerKind, amountCents: number): number {
  const magnitude = Math.abs(Math.round(amountCents));
  return kind === 'REVENUE' ? magnitude : -magnitude;
}

/**
 * Append a ledger row. Returns `{ created: false }` when `externalId` has been
 * seen before — that is the idempotency guarantee the Stripe webhook relies on,
 * and it is enforced by a UNIQUE constraint rather than a read-then-write.
 */
export async function post(
  entry: LedgerEntryInput,
): Promise<{ created: boolean; entry: LedgerEntry }> {
  const rowId = id('led');
  const amount = signed(entry.kind, entry.amountCents);

  const inserted = await query<LedgerEntry>(
    `INSERT INTO ledger_entries
       (id, business_id, kind, amount_cents, currency, description, source, external_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (external_id) DO NOTHING
     RETURNING *`,
    [
      rowId,
      entry.businessId,
      entry.kind,
      amount,
      entry.currency ?? 'usd',
      entry.description,
      entry.source ?? 'foundry',
      entry.externalId ?? null,
      JSON.stringify(entry.meta ?? {}),
    ],
  );

  if (inserted.length) return { created: true, entry: inserted[0] };

  const existing = await query<LedgerEntry>(
    `SELECT * FROM ledger_entries WHERE external_id = $1`,
    [entry.externalId],
  );
  return { created: false, entry: existing[0] };
}

export interface PnL {
  revenueCents: number;
  refundCents: number;
  cogsCents: number;
  opexCents: number;
  spendCents: number;
  netCents: number;
}

function toPnL(row: Record<string, string | null> | undefined): PnL {
  const n = (k: string) => Math.abs(Number(row?.[k] ?? 0));
  const revenueCents = n('revenue');
  const refundCents = n('refund');
  const cogsCents = n('cogs');
  const opexCents = n('opex');
  const spendCents = cogsCents + opexCents;
  return {
    revenueCents,
    refundCents,
    cogsCents,
    opexCents,
    spendCents,
    netCents: revenueCents - refundCents - spendCents,
  };
}

const PNL_SELECT = `
  SELECT
    COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'REVENUE'), 0) AS revenue,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'REFUND'),  0) AS refund,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'COGS'),    0) AS cogs,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'OPEX'),    0) AS opex
  FROM ledger_entries l`;

/** Portfolio P&L. Fixture businesses are excluded so tests never move it. */
export async function portfolioPnL(): Promise<PnL> {
  const rows = await query<Record<string, string>>(
    `${PNL_SELECT}
     WHERE l.business_id IS NULL
        OR l.business_id NOT IN (SELECT id FROM businesses WHERE is_fixture)`,
  );
  return toPnL(rows[0]);
}

export async function businessPnL(businessId: string): Promise<PnL> {
  const rows = await query<Record<string, string>>(`${PNL_SELECT} WHERE l.business_id = $1`, [
    businessId,
  ]);
  return toPnL(rows[0]);
}

/** Every business's P&L in one round trip — the dashboard's hot path. */
export async function allBusinessPnL(): Promise<Record<string, PnL>> {
  const rows = await query<Record<string, string>>(
    `SELECT business_id,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'REVENUE'), 0) AS revenue,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'REFUND'),  0) AS refund,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'COGS'),    0) AS cogs,
            COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'OPEX'),    0) AS opex
       FROM ledger_entries
      WHERE business_id IS NOT NULL
      GROUP BY business_id`,
  );
  const out: Record<string, PnL> = {};
  for (const row of rows) out[row.business_id] = toPnL(row);
  return out;
}

export async function recentEntries(limit = 50): Promise<LedgerEntry[]> {
  return query<LedgerEntry>(
    `SELECT * FROM ledger_entries ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit],
  );
}

export const dollars = (cents: number): number => Math.round(cents) / 100;
export const cents = (usd: number): number => Math.round(usd * 100);
