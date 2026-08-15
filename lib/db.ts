import { Pool, type QueryResultRow } from 'pg';
import { env } from './env';

declare global {
  // eslint-disable-next-line no-var
  var __foundryPool: Pool | undefined;
}

/**
 * One pool per process. Neon's pooler endpoint fronts this, so a small local
 * max is correct even under Vercel's fan-out.
 */
export function pool(): Pool {
  if (!globalThis.__foundryPool) {
    const connectionString = env.postgresUrl;
    if (!connectionString) throw new Error('POSTGRES_URL is not set');
    globalThis.__foundryPool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      ssl: connectionString.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
    });
  }
  return globalThis.__foundryPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query<T>(text, params as never[]);
  return res.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction on a dedicated connection. */
export async function tx<T>(fn: (q: typeof query) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const scoped = async <R extends QueryResultRow = QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<R[]> => (await client.query<R>(text, params as never[])).rows;
    const out = await fn(scoped as typeof query);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Short, sortable, URL-safe id with a type prefix — e.g. `biz_lq3f8x2a`. */
export function id(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}
