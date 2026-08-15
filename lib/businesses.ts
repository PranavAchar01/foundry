import { query } from './db';
import { allBusinessPnL, dollars, type PnL } from './ledger';
import type { BusinessMetrics } from './agent';

export interface BusinessRow {
  id: string;
  slug: string;
  name: string;
  niche: string;
  tagline: string;
  hypothesis_id: string | null;
  url: string;
  price_cents: number;
  currency: string;
  status: 'TESTING' | 'SCALING' | 'KILLED';
  visitors: number;
  conversions: number;
  is_fixture: boolean;
  archived: boolean;
  billing: 'one_time' | 'subscription';
  billing_interval: string;
  subscriber_target: number;
  kill_reason: string | null;
  killed_at: string | null;
  /** The person this was built for. Empty when it was built for a segment. */
  prospect_username: string;
  prospect_bio: string;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function list(includeFixtures = false): Promise<BusinessRow[]> {
  return query<BusinessRow>(
    `SELECT * FROM businesses ${includeFixtures ? '' : 'WHERE NOT is_fixture AND NOT archived'}
     ORDER BY created_at DESC`,
  );
}

export async function get(businessId: string): Promise<BusinessRow | null> {
  const rows = await query<BusinessRow>(`SELECT * FROM businesses WHERE id = $1`, [businessId]);
  return rows[0] ?? null;
}

export async function live(): Promise<BusinessRow[]> {
  return query<BusinessRow>(
    `SELECT * FROM businesses
      WHERE status <> 'KILLED' AND NOT is_fixture AND NOT archived
      ORDER BY created_at ASC`,
  );
}

export async function countActive(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM businesses
      WHERE status <> 'KILLED' AND NOT is_fixture AND NOT archived`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Real, measured pageviews — never a number the agent made up. */
export async function recordVisit(
  businessId: string,
  opts: { path?: string; referrer?: string; source?: string; counted?: boolean } = {},
): Promise<void> {
  await query(
    `INSERT INTO visits (id, business_id, path, referrer, source)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      `vis_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      businessId,
      opts.path ?? '/',
      (opts.referrer ?? '').slice(0, 300),
      opts.source ?? 'organic',
    ],
  );

  // Every load is logged, but only real outside traffic moves the number the
  // agent makes kill decisions on.
  if (opts.counted === false) return;

  await query(
    `UPDATE businesses SET visitors = visitors + 1, updated_at = now() WHERE id = $1`,
    [businessId],
  );
}

export async function recordConversion(businessId: string): Promise<void> {
  await query(
    `UPDATE businesses
        SET conversions = conversions + 1,
            status = CASE WHEN status = 'TESTING' THEN 'SCALING' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [businessId],
  );
}

export async function kill(businessId: string, reason: string): Promise<void> {
  await query(
    `UPDATE businesses
        SET status = 'KILLED', kill_reason = $2, killed_at = now(), updated_at = now()
      WHERE id = $1`,
    [businessId, reason],
  );
}

export async function scale(businessId: string): Promise<void> {
  await query(
    `UPDATE businesses SET status = 'SCALING', updated_at = now()
      WHERE id = $1 AND status <> 'KILLED'`,
    [businessId],
  );
}

export interface PortfolioCard extends BusinessRow {
  pnl: PnL;
  /** Customer acquisition cost: total spend / conversions. null with no conversions. */
  cacUsd: number | null;
  conversionRate: number;
  /** Whose business this is. Empty string for a segment-built one. */
  prospectUsername: string;
}

export async function portfolio(): Promise<PortfolioCard[]> {
  const [rows, pnls] = await Promise.all([list(false), allBusinessPnL()]);
  const empty: PnL = {
    revenueCents: 0, refundCents: 0, cogsCents: 0,
    opexCents: 0, spendCents: 0, netCents: 0,
  };
  return rows.map((b) => {
    const pnl = pnls[b.id] ?? empty;
    return {
      ...b,
      pnl,
      cacUsd: b.conversions > 0 ? round2(dollars(pnl.spendCents) / b.conversions) : null,
      conversionRate: b.visitors > 0 ? b.conversions / b.visitors : 0,
      // The column is snake_case because the row is; the card is what the
      // dashboard reads, and every other computed field on it is camelCase.
      prospectUsername: b.prospect_username,
    };
  });
}

export function toMetrics(card: PortfolioCard): BusinessMetrics {
  return {
    id: card.id,
    name: card.name,
    niche: card.niche,
    url: card.url,
    status: card.status,
    ageMinutes: Math.max(
      0,
      Math.round((Date.now() - new Date(card.created_at).getTime()) / 60000),
    ),
    visitors: card.visitors,
    conversions: card.conversions,
    revenueUsd: dollars(card.pnl.revenueCents),
    cogsUsd: dollars(card.pnl.cogsCents),
    opexUsd: dollars(card.pnl.opexCents),
    netUsd: dollars(card.pnl.netCents),
    cacUsd: card.cacUsd,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
