import { env } from './env';
import { id, query } from './db';

/**
 * The allocation log. Every judgement the CEO agent makes lands here with the
 * reasoning it actually used — not a label, the prose. The table is append-only
 * at the database level (see lib/schema.sql), so this is a real audit trail.
 */

export interface DecisionInput {
  cycleId: string;
  businessId?: string | null;
  action: string;
  reasoning: string;
  confidence?: number;
  model?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export interface DecisionRow {
  id: string;
  cycle_id: string;
  business_id: string | null;
  action: string;
  reasoning: string;
  confidence: number;
  model: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  created_at: string;
}

export async function record(input: DecisionInput): Promise<DecisionRow> {
  const rows = await query<DecisionRow>(
    `INSERT INTO decisions
       (id, cycle_id, business_id, action, reasoning, confidence, model, inputs, outputs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      id('dec'),
      input.cycleId,
      input.businessId ?? null,
      input.action,
      input.reasoning,
      input.confidence ?? 0.5,
      input.model ?? env.model,
      JSON.stringify(input.inputs ?? {}),
      JSON.stringify(input.outputs ?? {}),
    ],
  );
  return rows[0];
}

/**
 * Test fixtures and archived companies write real decision rows — they must,
 * the table is append-only — but they are not part of the running portfolio and
 * must never surface in the live feed a viewer is reading.
 */
const NOT_FIXTURE = `(business_id IS NULL OR business_id NOT IN
  (SELECT id FROM businesses WHERE is_fixture OR archived))`;

export async function recent(limit = 60): Promise<DecisionRow[]> {
  return query<DecisionRow>(
    `SELECT * FROM decisions WHERE ${NOT_FIXTURE}
      ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit],
  );
}

/** Rows newer than a cursor — the SSE stream's incremental query. */
export async function since(cursorIso: string, limit = 40): Promise<DecisionRow[]> {
  return query<DecisionRow>(
    `SELECT * FROM decisions WHERE created_at > $1 AND ${NOT_FIXTURE}
      ORDER BY created_at ASC, id ASC LIMIT $2`,
    [cursorIso, limit],
  );
}

export function newCycleId(): string {
  return id('cyc');
}
