import { describe, expect, it, afterAll } from 'vitest';
import * as machine from '@/lib/machine';
import { pool } from '@/lib/db';
import { env } from '@/lib/env';
import { fixtureBusiness } from './helpers';
import { resetBreaker } from '@/lib/guardrails';

const ENABLED = process.env.FOUNDRY_RUN_MACHINE === '1' && Boolean(env.superserveApiKey);
const BUSINESS = `biz_fixture_boot_${Date.now().toString(36)}`;

describe.skipIf(!ENABLED)('machine boot is visible', () => {
  afterAll(async () => {
    await machine.kill(BUSINESS, 'boot test teardown').catch(() => false);
    await pool().end().catch(() => {});
  });

  it('boots a web view the outside world can actually load', async () => {
    await resetBreaker();
    await fixtureBusiness(BUSINESS);

    const result = await machine.provision({
      businessId: BUSINESS,
      name: 'Boot Co',
      niche: 'boot testing',
      offer: 'a visible machine',
      targetCustomer: 'the demo',
      priceCents: 2900,
      url: 'https://example.invalid',
      thesis: 'A machine you can watch.',
      cycleId: 'cyc_boot_test',
    });

    console.log('\n  boot log :', (result.machine?.meta as { bootLog?: string[] })?.bootLog);
    console.log('  preview  :', result.machine?.preview_url);

    expect(result.ok, result.reason).toBe(true);
    expect(result.machine?.preview_url, 'no preview URL was published').toMatch(/^https:\/\//);

    const res = await fetch(result.machine!.preview_url);
    const html = await res.text();
    console.log('  fetch    :', res.status, `${html.length} bytes`);
    expect(res.status).toBe(200);
    expect(html).toContain('Boot Co');
    expect(html).toContain(env.disclosureLine);

    // The machine serves its own working files, and updates as the agent works.
    await machine.run(BUSINESS, 'echo "<h1>rewritten by the operator</h1>" > /root/company/index.html');
    const after = await fetch(result.machine!.preview_url).then((r) => r.text());
    expect(after).toContain('rewritten by the operator');

    const notes = await fetch(`${result.machine!.preview_url}/NOTES.md`);
    expect(notes.status).toBe(200);
  });
});
