import { env } from '@/lib/env';
import { id, query } from '@/lib/db';
import type { BusMessage, BusProvider } from './types';

/**
 * Default bus: a Postgres queue. `FOR UPDATE SKIP LOCKED` makes concurrent CEO
 * cycles safe without another piece of infrastructure.
 */
export class PostgresBusProvider implements BusProvider {
  readonly info = {
    capability: 'bus',
    name: 'postgres',
    configured: Boolean(env.postgresUrl),
    requires: ['POSTGRES_URL'],
  };

  async publish(topic: string, payload: Record<string, unknown>): Promise<{ id: string }> {
    const messageId = id('msg');
    await query(`INSERT INTO bus_messages (id, topic, payload) VALUES ($1, $2, $3)`, [
      messageId,
      topic,
      JSON.stringify(payload),
    ]);
    return { id: messageId };
  }

  async consume(topic: string, limit = 10): Promise<BusMessage[]> {
    const rows = await query<{ id: string; topic: string; payload: Record<string, unknown> }>(
      `UPDATE bus_messages SET status = 'claimed', claimed_at = now()
         WHERE id IN (
           SELECT id FROM bus_messages
            WHERE topic = $1 AND status = 'pending'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
       RETURNING id, topic, payload`,
      [topic, limit],
    );
    return rows.map((r) => ({ id: r.id, topic: r.topic, payload: r.payload }));
  }

  async ack(messageId: string): Promise<void> {
    await query(`UPDATE bus_messages SET status = 'done' WHERE id = $1`, [messageId]);
  }
}

/** Sponsor path: band.ai multi-agent coordination bus. */
export class BandBusProvider implements BusProvider {
  readonly info = {
    capability: 'bus',
    name: 'band',
    configured: Boolean(env.bandApiKey),
    requires: ['BAND_API_KEY'],
  };

  constructor(private readonly apiKey = env.bandApiKey) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) throw new Error('BAND_API_KEY is not set');
    const res = await fetch(`https://api.band.ai/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`band ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async publish(topic: string, payload: Record<string, unknown>): Promise<{ id: string }> {
    const j = await this.call<{ id: string }>('POST', '/messages', { topic, payload });
    return { id: j.id };
  }

  async consume(topic: string, limit = 10): Promise<BusMessage[]> {
    const j = await this.call<{ data: { id: string; topic: string; payload: Record<string, unknown> }[] }>(
      'POST',
      '/messages/claim',
      { topic, limit },
    );
    return (j.data ?? []).map((m) => ({ id: m.id, topic: m.topic, payload: m.payload }));
  }

  async ack(messageId: string): Promise<void> {
    await this.call<void>('POST', `/messages/${messageId}/ack`);
  }
}

export const BUS_IMPLEMENTATIONS: Record<string, () => BusProvider> = {
  postgres: () => new PostgresBusProvider(),
  band: () => new BandBusProvider(),
};

export function busProvider(name = env.busProvider): BusProvider {
  const make = BUS_IMPLEMENTATIONS[name] ?? BUS_IMPLEMENTATIONS.postgres;
  return make();
}
