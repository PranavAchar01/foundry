import { breakerState, resetBreaker, tripBreaker } from '@/lib/guardrails';
import { env } from '@/lib/env';
import * as decisions from '@/lib/decisions';
import { errorMessage, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return json(await breakerState());
}

/**
 * The kill switch, exposed deliberately. Tripping it needs no secret — halting
 * spend should always be easy. Resetting it does, because resetting re-arms
 * spending.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string; secret?: string };
    const action = String(body.action ?? '');

    if (action === 'trip') {
      const reason = String(body.reason ?? 'tripped manually');
      const state = await tripBreaker(reason);
      await decisions.record({
        cycleId: `manual_${Date.now().toString(36)}`,
        action: 'CIRCUIT_BREAKER_TRIPPED',
        reasoning: `Breaker tripped through /api/breaker: ${reason}. All spending is halted.`,
        confidence: 1,
        model: 'operator',
        outputs: { state },
      });
      return json(state);
    }

    if (action === 'reset') {
      if (env.cronSecret && body.secret !== env.cronSecret) {
        return json({ error: 'reset requires the shared secret' }, { status: 401 });
      }
      const state = await resetBreaker();
      await decisions.record({
        cycleId: `manual_${Date.now().toString(36)}`,
        action: 'CIRCUIT_BREAKER_RESET',
        reasoning: 'Breaker reset through /api/breaker. Spending is re-armed.',
        confidence: 1,
        model: 'operator',
        outputs: { state },
      });
      return json(state);
    }

    return json({ error: 'action must be "trip" or "reset"' }, { status: 400 });
  } catch (err) {
    return json({ error: errorMessage(err) }, { status: 500 });
  }
}
