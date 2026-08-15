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
    // It names the company it belongs to…
    expect(html).toContain('Boot Co');
    expect(html).toContain(env.disclosureLine);

    // …but it is a view of a MACHINE, read live from this VM, not a file index.
    for (const marker of ['uptime', 'memory', 'disk', 'processes', 'Operator workspace']) {
      expect(html, `machine page is missing "${marker}"`).toContain(marker);
    }
    // Real values, not labels with nothing behind them.
    expect(html, 'no memory figure').toMatch(/\d+(\.\d+)?\s(MB|GB)/);
    expect(html, 'no process count').toMatch(/<div class="v">\d+<\/div>/);
    expect(html, 'not auto-refreshing').toContain('http-equiv="refresh"');

    // The workspace is live: a file the operator writes shows up on the page
    // and is reachable by path.
    const marker = `probe-${Date.now().toString(36)}`;
    await machine.run(BUSINESS, `echo ${marker} >> /root/company/NOTES.md`);
    const after = await fetch(result.machine!.preview_url).then((r) => r.text());
    expect(after, 'NOTES.md tail is not on the machine page').toContain(marker);

    const notes = await fetch(`${result.machine!.preview_url}/NOTES.md`);
    expect(notes.status).toBe(200);
    expect(await notes.text()).toContain(marker);
  });
});
