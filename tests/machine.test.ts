import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as machine from '@/lib/machine';
import { operate } from '@/lib/operator';
import { query, pool } from '@/lib/db';
import { env } from '@/lib/env';
import { fixtureBusiness } from './helpers';
import { resetBreaker } from '@/lib/guardrails';

/**
 * Proves a business can actually run itself on its own machine.
 *
 * This provisions a REAL Superserve microVM, has Claude drive a real shell on
 * it, and bills real machine time. It is therefore opt-in:
 *
 *   FOUNDRY_RUN_MACHINE=1 pnpm vitest run tests/machine.test.ts
 */

const ENABLED = process.env.FOUNDRY_RUN_MACHINE === '1' && Boolean(env.superserveApiKey);
const BUSINESS = `biz_fixture_machine_${Date.now().toString(36)}`;

describe.skipIf(!ENABLED)('company machine', () => {
  beforeAll(async () => {
    await resetBreaker();
    await fixtureBusiness(BUSINESS);
  });

  afterAll(async () => {
    // Never leave a microVM running after a test.
    await machine.kill(BUSINESS, 'test teardown').catch(() => false);
    await pool().end().catch(() => {});
  });

  it('provisions a machine and seeds it with the company brief', async () => {
    const result = await machine.provision({
      businessId: BUSINESS,
      name: 'Fixture Co',
      niche: 'test fixtures',
      offer: 'a test artifact',
      targetCustomer: 'the test suite',
      priceCents: 2900,
      url: 'https://example.invalid',
      thesis: 'Exercises the machine lifecycle end to end.',
      cycleId: 'cyc_machine_test',
    });

    expect(result.ok, result.reason).toBe(true);
    expect(result.machine?.external_id).toBeTruthy();
    expect(result.machine?.status).toBe('active');

    // The brief is really on the disk of a really-running VM.
    const brief = await machine.run(BUSINESS, 'cat /root/company/COMPANY.md');
    expect(brief.exitCode).toBe(0);
    expect(brief.stdout).toContain('Fixture Co');
    expect(brief.stdout).toContain(env.disclosureLine);
  });

  it('is a real Linux machine, not a shim', async () => {
    const out = await machine.run(BUSINESS, 'uname -s && cat /etc/os-release | head -1');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('Linux');
  });

  it('persists state between separate connections', async () => {
    const token = `persisted-${Date.now().toString(36)}`;
    await machine.run(BUSINESS, `echo ${token} >> /root/company/NOTES.md`);

    // A separate run reconnects to the same machine from scratch.
    const read = await machine.run(BUSINESS, 'cat /root/company/NOTES.md');
    expect(read.stdout).toContain(token);
  });

  it('records every command in an append-only transcript', async () => {
    const rows = await query<{ command: string; exit_code: number }>(
      `SELECT command, exit_code FROM machine_runs WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows.length).toBeGreaterThan(0);

    await expect(
      query(`UPDATE machine_runs SET stdout = 'rewritten' WHERE business_id = $1`, [BUSINESS]),
    ).rejects.toThrow(/append-only/i);
  });

  it('lets the operator agent do real work on the machine', async () => {
    const session = await operate(
      {
        id: BUSINESS,
        name: 'Fixture Co',
        niche: 'test fixtures',
        url: 'https://example.invalid',
        status: 'TESTING',
        ageMinutes: 5,
        visitors: 12,
        conversions: 0,
        revenueUsd: 0,
        cogsUsd: 0,
        opexUsd: 1,
        netUsd: -1,
        cacUsd: null,
      },
      { cycleId: 'cyc_machine_test', maxTurns: 5 },
    );

    console.log(`\n  operator: ${session.turns} turn(s), ${session.commands} command(s)`);
    console.log(`  summary : ${session.summary.slice(0, 300)}`);
    console.log(`  artifacts: ${session.artifacts.join(', ')}`);
    console.log(`  next    : ${session.nextStep}`);

    expect(session.error).toBeNull();
    expect(session.commands).toBeGreaterThan(0);
    expect(session.summary.length).toBeGreaterThan(20);

    // It actually left something behind.
    const ls = await machine.run(BUSINESS, 'ls -la /root/company && wc -c /root/company/NOTES.md');
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toContain('NOTES.md');

    // And the session is in the append-only decision log.
    const [decision] = await query<{ action: string; reasoning: string }>(
      `SELECT action, reasoning FROM decisions WHERE id = $1`,
      [session.decisionId],
    );
    expect(decision.action).toBe('OPERATOR_SESSION');
  });

  it('meters machine time as OPEX and parks idle machines', async () => {
    const before = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ledger_entries WHERE business_id = $1 AND kind = 'OPEX'`,
      [BUSINESS],
    );
    const result = await machine.meterAndPark();
    expect(result).toHaveProperty('billed');
    expect(result).toHaveProperty('paused');

    const after = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ledger_entries WHERE business_id = $1 AND kind = 'OPEX'`,
      [BUSINESS],
    );
    // Billing is only posted once a period is worth at least a cent, so this
    // asserts the meter never goes backwards rather than a specific amount.
    expect(Number(after[0].n)).toBeGreaterThanOrEqual(Number(before[0].n));
  });

  it('kills the machine when the business is killed', async () => {
    const killed = await machine.kill(BUSINESS, 'test: business killed');
    expect(killed).toBe(true);

    const row = await machine.forBusiness(BUSINESS);
    expect(row).toBeNull();

    const [dead] = await query<{ status: string; killed_at: string | null }>(
      `SELECT status, killed_at FROM machines WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(dead.status).toBe('killed');
    expect(dead.killed_at).toBeTruthy();
  });
});
