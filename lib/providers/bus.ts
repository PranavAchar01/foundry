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

/**
 * Sponsor path: band.ai — persistent agent identity and multi-agent chat rooms.
 *
 * Two things learned from the live API and encoded here:
 *   1. Auth is `X-API-Key`, not a bearer token.
 *   2. Band's *Human* API (`/me/*`) is Enterprise-gated, but the *Agent* API
 *      (`/agent/*`) is not. So the bus authenticates as a registered agent,
 *      whose key `pnpm band:register` mints once and stores as
 *      BAND_AGENT_API_KEY.
 *
 * A topic maps to a Band chat room, so the coordination log is a conversation a
 * human can open and read rather than an opaque queue.
 */
export class BandBusProvider implements BusProvider {
  readonly info = {
    capability: 'bus',
    name: 'band',
    configured: Boolean(env.bandAgentApiKey),
    requires: ['BAND_AGENT_API_KEY'],
  };

  private readonly base = 'https://app.band.ai/api/v1';
  /** topic -> chat room id, resolved once per process. */
  private rooms = new Map<string, string>();

  constructor(private readonly apiKey = env.bandAgentApiKey) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) {
      throw new Error('BAND_AGENT_API_KEY is not set — run `pnpm band:register` to mint one');
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'X-API-Key': this.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`band ${method} ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Finds the chat room for a topic, creating it on first use. */
  private async room(topic: string): Promise<string> {
    const cached = this.rooms.get(topic);
    if (cached) return cached;

    const name = `foundry:${topic}`;
    const list = await this.call<{ data?: { id: string; name: string }[] }>('GET', '/agent/chats');
    const found = (list.data ?? []).find((c) => c.name === name);
    if (found) {
      this.rooms.set(topic, found.id);
      return found.id;
    }

    const made = await this.call<{ data?: { id: string } }>('POST', '/agent/chats', { chat: { name } });
    const id = made.data?.id;
    if (!id) throw new Error(`band could not create a chat room for ${topic}`);
    this.rooms.set(topic, id);
    return id;
  }

  async publish(topic: string, payload: Record<string, unknown>): Promise<{ id: string }> {
    const chatId = await this.room(topic);
    const out = await this.call<{ data?: { id: string } }>(
      'POST',
      `/agent/chats/${chatId}/messages`,
      { message: { content: JSON.stringify(payload) } },
    );
    return { id: out.data?.id ?? '' };
  }

  async consume(topic: string, limit = 10): Promise<BusMessage[]> {
    const chatId = await this.room(topic);
    const out = await this.call<{ data?: { id: string; content: string }[] }>(
      'GET',
      `/agent/chats/${chatId}/messages?limit=${limit}`,
    );
    return (out.data ?? []).map((m) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(m.content) as Record<string, unknown>;
      } catch {
        parsed = { content: m.content };
      }
      return { id: m.id, topic, payload: parsed };
    });
  }

  async ack(messageId: string): Promise<void> {
    // Band tracks per-message processing state on the agent's inbox.
    await this.call<void>('POST', `/agent/messages/${messageId}/processed`).catch(() => {});
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
