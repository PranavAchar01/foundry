import * as businesses from '@/lib/businesses';
import * as ledger from '@/lib/ledger';
import * as decisions from '@/lib/decisions';
import { budgetSnapshot } from '@/lib/guardrails';
import { recentEscalations } from '@/lib/escalation';
import { describeProviders } from '@/lib/providers';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Everything the dashboard renders, in one round trip. */
export async function GET() {
  try {
    const [cards, pnl, budget, log, escalations, entries] = await Promise.all([
      businesses.portfolio(),
      ledger.portfolioPnL(),
      budgetSnapshot(),
      decisions.recent(40),
      recentEscalations(12),
      ledger.recentEntries(25),
    ]);

    return json({
      generatedAt: new Date().toISOString(),
      businesses: cards,
      pnl,
      budget,
      decisions: log,
      escalations,
      ledger: entries,
      providers: describeProviders(),
    });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
