import { query } from '@/lib/db';

/**
 * Tests run against the real Neon database — there is no second, fake one.
 * They operate on fixture businesses, which are excluded from the portfolio and
 * from the P&L (`businesses.is_fixture`), so a test run can never move a number
 * on the dashboard.
 */
export async function fixtureBusiness(
  id: string,
  overrides: { priceCents?: number; status?: string } = {},
): Promise<string> {
  await query(
    `INSERT INTO businesses (id, slug, name, niche, tagline, url, price_cents, status, is_fixture)
     VALUES ($1, $2, $3, 'test fixture', 'fixture', '', $4, $5, true)
     ON CONFLICT (id) DO UPDATE SET is_fixture = true, status = EXCLUDED.status`,
    [id, `fixture-${id}`, `Fixture ${id}`, overrides.priceCents ?? 2900, overrides.status ?? 'TESTING'],
  );
  return id;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.POSTGRES_URL);
}
