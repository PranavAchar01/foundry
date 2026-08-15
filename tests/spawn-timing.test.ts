import { describe, expect, it, afterAll } from 'vitest';
import { spawn } from '@/lib/spawn';
import { pool, query } from '@/lib/db';
import { checkoutProvider } from '@/lib/providers';
import { env } from '@/lib/env';

/**
 * The sub-four-minute claim, measured rather than asserted.
 *
 * This spawns a REAL business: it calls Claude, deploys to a real Vercel
 * project, books $1 of hosting as OPEX, and leaves the business in the
 * portfolio. It is therefore opt-in — set FOUNDRY_RUN_SPAWN=1 to run it.
 *
 *   FOUNDRY_RUN_SPAWN=1 pnpm vitest run tests/spawn-timing.test.ts
 */

const ENABLED = process.env.FOUNDRY_RUN_SPAWN === '1';
const BUDGET_MS = 4 * 60 * 1000;

describe.skipIf(!ENABLED)('spawn timing', () => {
  afterAll(async () => {
    await pool().end().catch(() => {});
  });

  it(
    'produces a deployed, checkout-wired business in under four minutes',
    async () => {
      const niche = process.env.FOUNDRY_SPAWN_NICHE ?? 'freelance illustrators quoting commissions';

      const started = Date.now();
      const result = await spawn({ niche });
      const elapsed = Date.now() - started;

      // Always print the breakdown — the number is the deliverable.
      console.log(`\n  niche:    ${niche}`);
      console.log(`  ok:       ${result.ok}`);
      console.log(`  business: ${result.businessId}`);
      console.log(`  url:      ${result.url}`);
      console.log(`  elapsed:  ${(elapsed / 1000).toFixed(1)}s (budget ${BUDGET_MS / 1000}s)`);
      for (const stage of result.stages) {
        console.log(`    ${stage.name.padEnd(18)} ${String(stage.ms).padStart(7)}ms  ${stage.detail}`);
      }
      if (result.error) console.log(`  error:    ${result.error}`);
      if (result.qa) {
        for (const c of result.qa.checks) {
          console.log(`    qa ${c.passed ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
        }
      }

      expect(result.error).toBeNull();
      expect(result.ok).toBe(true);
      expect(elapsed).toBeLessThan(BUDGET_MS);
      expect(result.url).toMatch(/^https:\/\//);
      expect(result.businessId).toBeTruthy();

      // The model, not a template, produced the hypothesis.
      expect(result.hypothesis?.reasoning.length ?? 0).toBeGreaterThan(40);

      // The deployed page is real, serves, and carries the disclosure.
      const page = await fetch(result.url!);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain('id="buy"');
      expect(html).toContain(result.businessId!);
      expect(html).toContain(env.disclosureLine);

      // Checkout is wired: a real Stripe session for this business, 200.
      const session = await checkoutProvider().createSession({
        businessId: result.businessId!,
        productName: result.hypothesis!.name,
        description: result.hypothesis!.tagline,
        amountCents: result.hypothesis!.priceCents,
        currency: 'usd',
        successUrl: `${env.publicUrl}/thanks`,
        cancelUrl: result.url!,
      });
      console.log(`  checkout: ${session.sessionId} (${session.provider})`);
      expect(session.url).toMatch(/^https:\/\//);

      // And the spawn is recorded in the append-only decision log.
      const [decision] = await query<{ action: string; reasoning: string }>(
        `SELECT action, reasoning FROM decisions WHERE id = $1`,
        [result.decisionId],
      );
      expect(decision.action).toBe('SPAWN');
      expect(decision.reasoning).toContain(result.hypothesis!.name);
    },
    BUDGET_MS + 60_000,
  );
});
