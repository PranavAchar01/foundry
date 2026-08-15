import { env } from './env';
import * as decisions from './decisions';
import * as businesses from './businesses';
import * as ledger from './ledger';
import { authorizeSpend, breakerState, budgetSnapshot, enforceBreaker } from './guardrails';
import { collectAnswers, escalate, shouldEscalate } from './escalation';
import { judge } from './agent';
import { spawn } from './spawn';
import * as machine from './machine';
import { operate } from './operator';
import { laborProvider, busProvider } from './providers';

/**
 * The CEO loop.
 *
 *   hypothesis -> spawn -> deploy -> traffic -> metrics -> allocate or kill
 *
 * One pass is one cycle. Every cycle writes at least one timestamped,
 * append-only decision row carrying the reasoning the model actually produced.
 * Nothing in here spends money without going through `authorizeSpend` first.
 */

/** Niches the CEO rotates through when it has room for another business. */
const NICHE_QUEUE = [
  'freelance designers who invoice clients',
  'indie game developers shipping on Steam',
  'small-batch coffee roasters',
  'wedding photographers managing shot lists',
  'bootstrapped SaaS founders writing changelogs',
  'personal trainers building client programs',
  'Etsy sellers optimising listings',
  'newsletter writers growing to 1000 subscribers',
];

/** Dollars of promotion the agent may put behind a converting business. */
const MAX_ALLOCATION_PER_CYCLE_USD = 5;

export interface CycleStep {
  businessId: string | null;
  action: string;
  reasoning: string;
  decisionId: string;
  model: string;
  spentUsd: number;
}

export interface CycleResult {
  cycleId: string;
  startedAt: string;
  elapsedMs: number;
  halted: boolean;
  haltReason: string;
  steps: CycleStep[];
  spawned: { businessId: string; url: string; elapsedMs: number } | null;
  budget: Awaited<ReturnType<typeof budgetSnapshot>>;
}

export interface CycleOptions {
  /** Skip the spawn stage — used when a cycle should only re-evaluate. */
  spawn?: boolean;
  /** Force a specific niche instead of the rotation. */
  niche?: string;
}

export async function runCycle(opts: CycleOptions = {}): Promise<CycleResult> {
  const cycleId = decisions.newCycleId();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const steps: CycleStep[] = [];
  let spawned: CycleResult['spawned'] = null;

  const bus = busProvider();
  await bus.publish('ceo.cycle.started', { cycleId, startedAt }).catch(() => {});

  // --- 0. circuit breaker ---------------------------------------------------
  const breaker = await breakerState();
  if (env.circuitBreaker && breaker.tripped) {
    const row = await decisions.record({
      cycleId,
      action: 'CYCLE_HALTED',
      reasoning:
        `Circuit breaker is tripped (${breaker.reason}). No stage of this cycle that could ` +
        'spend money was allowed to run. Reset it deliberately to resume.',
      confidence: 1,
      model: 'guardrail',
      inputs: { breaker },
      outputs: {},
    });
    return {
      cycleId, startedAt, elapsedMs: Date.now() - t0,
      halted: true, haltReason: breaker.reason,
      steps: [{
        businessId: null, action: 'CYCLE_HALTED',
        reasoning: row.reasoning, decisionId: row.id,
        model: 'guardrail', spentUsd: 0,
      }],
      spawned: null,
      budget: await budgetSnapshot(),
    };
  }

  // --- 1. collect any human answers that landed since last cycle ------------
  const answered = await collectAnswers(laborProvider()).catch(() => 0);
  if (answered > 0) {
    const row = await decisions.record({
      cycleId,
      action: 'LABOR_ANSWERS_COLLECTED',
      reasoning: `${answered} purchased escalation(s) returned an answer and were folded back into the record.`,
      confidence: 1,
      model: 'guardrail',
      outputs: { answered },
    });
    steps.push({
      businessId: null, action: 'LABOR_ANSWERS_COLLECTED',
      reasoning: row.reasoning, decisionId: row.id, model: 'guardrail', spentUsd: 0,
    });
  }

  // --- 2. metrics -> allocate or kill, one business at a time ---------------
  const cards = await businesses.portfolio();
  const liveCards = cards.filter((c) => c.status !== 'KILLED');

  for (const card of liveCards) {
    const snapshot = await budgetSnapshot();
    const metrics = businesses.toMetrics(card);
    const verdict = await judge(metrics, {
      killVisitors: env.killThresholdVisitors,
      killConversions: env.killThresholdConversions,
      remainingBudgetUsd: snapshot.remainingUsd,
      perBusinessBudgetUsd: env.perBusinessBudget,
      spentOnBusinessUsd: ledger.dollars(card.pnl.spendCents),
    });
    const j = verdict.value;

    // Low confidence is the trigger for buying a human, not for guessing.
    const wantsHuman =
      j.action === 'ESCALATE' || shouldEscalate(j.confidence, `${card.niche} ${j.reasoning}`);

    if (wantsHuman) {
      const question =
        j.escalationQuestion ||
        `Should FOUNDRY keep funding "${card.name}"? ${metrics.visitors} visitors, ` +
          `${metrics.conversions} conversions, $${metrics.netUsd.toFixed(2)} net after ` +
          `$${(metrics.cogsUsd + metrics.opexUsd).toFixed(2)} spend. What would you change first?`;
      const result = await escalate({
        businessId: card.id,
        question,
        expertProfile:
          j.expertProfile || `Direct-response marketer with experience selling to ${card.niche}`,
        confidence: j.confidence,
        cycleId,
      });
      steps.push({
        businessId: card.id,
        action: result.decision === 'purchased' ? 'ESCALATION_PURCHASED' : 'ESCALATION_DECLINED',
        reasoning: result.reason,
        decisionId: result.decisionId,
        model: verdict.model,
        spentUsd: result.decision === 'purchased' ? result.quote.totalCost : 0,
      });
      continue;
    }

    if (j.action === 'KILL') {
      await businesses.kill(card.id, j.reasoning);
      // A killed business must stop costing money: its machine goes with it.
      await machine.kill(card.id, j.reasoning).catch(() => false);
      const row = await decisions.record({
        cycleId,
        businessId: card.id,
        action: 'KILL',
        reasoning: j.reasoning,
        confidence: j.confidence,
        model: verdict.model,
        inputs: { metrics, policy: { killVisitors: env.killThresholdVisitors } },
        outputs: { status: 'KILLED', modelSourced: verdict.fromModel },
      });
      steps.push({
        businessId: card.id, action: 'KILL', reasoning: j.reasoning,
        decisionId: row.id, model: verdict.model, spentUsd: 0,
      });
      continue;
    }

    if (j.action === 'SCALE') {
      const amount = Math.min(j.allocateUsd || 1, MAX_ALLOCATION_PER_CYCLE_USD);
      const auth = await authorizeSpend({
        businessId: card.id,
        amountUsd: amount,
        category: 'traffic',
      });

      if (!auth.allowed) {
        const row = await decisions.record({
          cycleId,
          businessId: card.id,
          action: 'ALLOCATION_DECLINED',
          reasoning:
            `Wanted to put $${amount.toFixed(2)} behind ${card.name} — ${j.reasoning} — but the ` +
            `guardrail refused: ${auth.reason}`,
          confidence: j.confidence,
          model: verdict.model,
          inputs: { metrics, requestedUsd: amount },
          outputs: { guardrailCode: auth.code, limits: auth.limits },
        });
        steps.push({
          businessId: card.id, action: 'ALLOCATION_DECLINED', reasoning: row.reasoning,
          decisionId: row.id, model: verdict.model, spentUsd: 0,
        });
        continue;
      }

      await businesses.scale(card.id);
      await ledger.post({
        businessId: card.id,
        kind: 'OPEX',
        amountCents: ledger.cents(amount),
        description: `Promotion allocated to ${card.name} in cycle ${cycleId}`,
        source: 'ceo:allocation',
        externalId: `alloc:${cycleId}:${card.id}`,
        meta: { cycleId, reasoning: j.reasoning },
      });

      const row = await decisions.record({
        cycleId,
        businessId: card.id,
        action: 'SCALE',
        reasoning: `${j.reasoning} Allocated $${amount.toFixed(2)}; ${auth.limits.remainingPortfolioUsd.toFixed(2)} left in the portfolio before this spend.`,
        confidence: j.confidence,
        model: verdict.model,
        inputs: { metrics, limits: auth.limits },
        outputs: { allocatedUsd: amount, status: 'SCALING', modelSourced: verdict.fromModel },
      });
      steps.push({
        businessId: card.id, action: 'SCALE', reasoning: row.reasoning,
        decisionId: row.id, model: verdict.model, spentUsd: amount,
      });
      continue;
    }

    const row = await decisions.record({
      cycleId,
      businessId: card.id,
      action: 'HOLD',
      reasoning: j.reasoning,
      confidence: j.confidence,
      model: verdict.model,
      inputs: { metrics },
      outputs: { modelSourced: verdict.fromModel },
    });
    steps.push({
      businessId: card.id, action: 'HOLD', reasoning: j.reasoning,
      decisionId: row.id, model: verdict.model, spentUsd: 0,
    });
  }

  // --- 3. spawn, if there is room and money --------------------------------
  if (opts.spawn !== false) {
    const activeCount = await businesses.countActive();
    const snapshot = await budgetSnapshot();
    if (activeCount < env.maxBusinesses && snapshot.remainingUsd > 2) {
      const niche = opts.niche ?? (await nextNiche());
      const result = await spawn({ niche, cycleId });
      if (result.ok && result.businessId && result.url) {
        spawned = { businessId: result.businessId, url: result.url, elapsedMs: result.elapsedMs };
      }
      steps.push({
        businessId: result.businessId,
        action: result.ok ? 'SPAWN' : 'SPAWN_REFUSED',
        reasoning: result.ok
          ? `Spawned ${result.hypothesis?.name} at ${result.url} in ${(result.elapsedMs / 1000).toFixed(1)}s.`
          : (result.error ?? 'spawn failed'),
        decisionId: result.decisionId ?? '',
        model: 'ceo',
        spentUsd: result.ok ? 1 : 0,
      });
    } else {
      const reason =
        activeCount >= env.maxBusinesses
          ? `Not spawning: ${activeCount} active businesses is at the ceiling of ${env.maxBusinesses}.`
          : `Not spawning: $${snapshot.remainingUsd.toFixed(2)} left is too little to fund another launch.`;
      const row = await decisions.record({
        cycleId, action: 'SPAWN_SKIPPED', reasoning: reason,
        confidence: 1, model: 'guardrail',
        inputs: { activeCount, remainingUsd: snapshot.remainingUsd },
      });
      steps.push({
        businessId: null, action: 'SPAWN_SKIPPED', reasoning: reason,
        decisionId: row.id, model: 'guardrail', spentUsd: 0,
      });
    }
  }

  // --- 3b. one operator session, on the least-recently-worked business ------
  // One per cycle keeps the cycle inside Vercel's 300s function ceiling; over
  // successive cycles every business gets worked in turn.
  if (env.superserveApiKey) {
    try {
      const machines = await machine.list();
      const candidates = (await businesses.portfolio()).filter(
        (c) => c.status !== 'KILLED' && machines.some((m) => m.business_id === c.id),
      );
      const oldest = machines
        .filter((m) => candidates.some((c) => c.id === m.business_id))
        .sort((a, b) => new Date(a.last_used_at).getTime() - new Date(b.last_used_at).getTime())[0];

      const target = candidates.find((c) => c.id === oldest?.business_id);
      if (target) {
        const session = await operate(businesses.toMetrics(target), { cycleId });
        steps.push({
          businessId: target.id,
          action: 'OPERATOR_SESSION',
          reasoning: session.summary,
          decisionId: session.decisionId,
          model: session.model,
          spentUsd: 0,
        });
      }
    } catch (err) {
      const row = await decisions.record({
        cycleId,
        action: 'OPERATOR_FAILED',
        reasoning: `Operator session could not run: ${String(err).slice(0, 300)}`,
        confidence: 1,
        model: 'guardrail',
      });
      steps.push({
        businessId: null, action: 'OPERATOR_FAILED', reasoning: row.reasoning,
        decisionId: row.id, model: 'guardrail', spentUsd: 0,
      });
    }

    // Bill elapsed machine time and pause anything idle.
    await machine.meterAndPark().catch(() => ({ billed: 0, paused: 0 }));
  }

  // --- 4. latch the breaker if this cycle exhausted the budget --------------
  const finalBreaker = await enforceBreaker();
  if (finalBreaker.tripped && !breaker.tripped) {
    const row = await decisions.record({
      cycleId,
      action: 'CIRCUIT_BREAKER_TRIPPED',
      reasoning: `Spend ceiling reached: ${finalBreaker.reason}. All further spending is halted until reset.`,
      confidence: 1,
      model: 'guardrail',
      outputs: { breaker: finalBreaker },
    });
    steps.push({
      businessId: null, action: 'CIRCUIT_BREAKER_TRIPPED', reasoning: row.reasoning,
      decisionId: row.id, model: 'guardrail', spentUsd: 0,
    });
  }

  const budget = await budgetSnapshot();
  await bus
    .publish('ceo.cycle.finished', { cycleId, steps: steps.length, spentUsd: budget.spentUsd })
    .catch(() => {});

  return {
    cycleId, startedAt, elapsedMs: Date.now() - t0,
    halted: false, haltReason: '', steps, spawned, budget,
  };
}

/** First niche in the rotation that is not already represented. */
async function nextNiche(): Promise<string> {
  const taken = new Set((await businesses.list()).map((b) => b.niche));
  return NICHE_QUEUE.find((n) => !taken.has(n)) ?? NICHE_QUEUE[Date.now() % NICHE_QUEUE.length];
}

export { NICHE_QUEUE };
