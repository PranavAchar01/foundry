import * as businesses from '@/lib/businesses';
import * as machine from '@/lib/machine';
import * as ledger from '@/lib/ledger';
import { query } from '@/lib/db';
import { env } from '@/lib/env';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Everything one company's detail view shows: its storefront, the machine
 * running it, its traction, and what the agent decided about it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;

    const business = await businesses.get(id);
    if (!business) return json({ error: 'unknown business' }, { status: 404 });

    const [pnl, box, decisions, runs] = await Promise.all([
      ledger.businessPnL(id),
      machine.forBusiness(id),
      query<{ id: string; action: string; reasoning: string; model: string; created_at: string }>(
        `SELECT id, action, reasoning, model, created_at FROM decisions
          WHERE business_id = $1 ORDER BY created_at DESC LIMIT 12`,
        [id],
      ),
      query<{ id: string; command: string; exit_code: number; stdout: string; created_at: string }>(
        `SELECT id, command, exit_code, LEFT(stdout, 2000) AS stdout, created_at
           FROM machine_runs WHERE business_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [id],
      ),
    ]);

    const spendUsd = ledger.dollars(pnl.spendCents);

    return json({
      business: {
        id: business.id,
        name: business.name,
        niche: business.niche,
        tagline: business.tagline,
        url: business.url,
        status: business.status,
        priceCents: business.price_cents,
        visitors: business.visitors,
        conversions: business.conversions,
        killReason: business.kill_reason,
        createdAt: business.created_at,
        pagegen: (business.meta as { pagegen?: string })?.pagegen ?? 'internal',
      },
      traction: {
        visitors: business.visitors,
        conversions: business.conversions,
        conversionRate: business.visitors > 0 ? business.conversions / business.visitors : 0,
        revenueUsd: ledger.dollars(pnl.revenueCents),
        cogsUsd: ledger.dollars(pnl.cogsCents),
        opexUsd: ledger.dollars(pnl.opexCents),
        spendUsd,
        netUsd: ledger.dollars(pnl.netCents),
        cacUsd: business.conversions > 0 ? Math.round((spendUsd / business.conversions) * 100) / 100 : null,
        priceUsd: business.price_cents / 100,
        budgetUsd: env.perBusinessBudget,
      },
      machine: box
        ? {
            id: box.id,
            externalId: box.external_id,
            provider: box.provider,
            status: box.status,
            previewUrl: box.preview_url,
            billedUsd:
              Math.round((Number(box.billed_seconds ?? 0) / 3600) * env.machineCostPerHour * 100) / 100,
            createdAt: box.created_at,
            bootLog: (box.meta?.bootLog as string[]) ?? [],
          }
        : null,
      decisions,
      runs,
    });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
