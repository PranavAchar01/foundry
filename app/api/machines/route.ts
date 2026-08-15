import * as machine from '@/lib/machine';
import * as businesses from '@/lib/businesses';
import { recentRuns } from '@/lib/operator';
import { env } from '@/lib/env';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Everything the machine room renders: one VM per business, plus its shell. */
export async function GET() {
  try {
    const [machines, cards, runs] = await Promise.all([
      machine.list(),
      businesses.portfolio(),
      recentRuns(120),
    ]);

    const byBusiness = new Map(cards.map((c) => [c.id, c]));

    return json({
      generatedAt: new Date().toISOString(),
      costPerHourUsd: env.machineCostPerHour,
      idleMinutes: env.machineIdleMinutes,
      machines: machines.map((m) => {
        const seconds = Number(m.billed_seconds ?? 0);
        return {
          id: m.id,
          businessId: m.business_id,
          businessName: byBusiness.get(m.business_id)?.name ?? m.business_id,
          niche: byBusiness.get(m.business_id)?.niche ?? '',
          provider: m.provider,
          externalId: m.external_id,
          status: m.status,
          previewUrl: m.preview_url,
          billedSeconds: seconds,
          billedUsd: Math.round((seconds / 3600) * env.machineCostPerHour * 100) / 100,
          createdAt: m.created_at,
          lastUsedAt: m.last_used_at,
          bootLog: (m.meta?.bootLog as string[]) ?? [],
          runs: runs
            .filter((r) => r.business_id === m.business_id)
            .slice(0, 25)
            .map((r) => ({
              id: r.id,
              command: r.command,
              exitCode: r.exit_code,
              stdout: r.stdout,
              durationMs: r.duration_ms,
              createdAt: r.created_at,
            })),
        };
      }),
    });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
