import { describe, expect, it } from 'vitest';
import { BandBusProvider } from '@/lib/providers/bus';
import { env } from '@/lib/env';

/**
 * Band round-trip against the live API. Opt-in because it creates a real chat
 * room on the account:
 *
 *   FOUNDRY_RUN_BAND=1 pnpm vitest run tests/bus.test.ts
 */
const ENABLED = process.env.FOUNDRY_RUN_BAND === '1' && Boolean(env.bandAgentApiKey);

describe.skipIf(!ENABLED)('band bus', () => {
  it('publishes a cycle event and reads it back', async () => {
    const bus = new BandBusProvider();
    const topic = 'test.roundtrip';
    const marker = `probe-${Date.now().toString(36)}`;

    const published = await bus.publish(topic, { marker, cycleId: 'cyc_test' });
    expect(published.id, 'no event id returned').toBeTruthy();

    const messages = await bus.consume(topic, 20);
    console.log(`\n  published ${published.id}, room has ${messages.length} record(s)`);

    // The event must come back with its structured payload intact.
    const mine = messages.find((m) => (m.payload as { marker?: string }).marker === marker);
    expect(mine, 'published event was not readable back').toBeTruthy();
    expect((mine!.payload as { cycleId?: string }).cycleId).toBe('cyc_test');
  });
});
