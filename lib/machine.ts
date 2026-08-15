import { env } from './env';
import { id, one, query } from './db';
import * as ledger from './ledger';
import * as decisions from './decisions';
import { authorizeSpend } from './guardrails';

/**
 * A machine per business.
 *
 * Every spawned business gets a persistent Firecracker microVM (Superserve)
 * that its operator agent runs the company from. Unlike a scratch sandbox, the
 * machine survives between CEO cycles: files the agent writes on Monday are
 * still there on Tuesday, so a business accumulates real working state —
 * copy drafts, customer notes, generated assets, its own scripts.
 *
 * The machine is metered. Compute is money, so:
 *   - provisioning goes through `authorizeSpend` like any other spend,
 *   - active time is billed by the second and posted as OPEX,
 *   - an idle machine is paused, which stops the meter,
 *   - killing a business kills its machine.
 */

export interface MachineRow {
  id: string;
  business_id: string;
  provider: string;
  external_id: string;
  status: 'active' | 'paused' | 'killed';
  preview_url: string;
  billed_seconds: string | number;
  last_started_at: string | null;
  last_used_at: string;
  killed_at: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface MachineRun {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Superserve's SDK, loaded lazily so the module imports without the key. */
async function sdk() {
  const mod = await import('@superserve/sdk');
  return mod.Sandbox;
}

function requireKey(): string {
  const key = env.superserveApiKey;
  if (!key) throw new Error('SUPERSERVE_API_KEY is not set — no machine provider available');
  return key;
}

export async function forBusiness(businessId: string): Promise<MachineRow | null> {
  return one<MachineRow>(
    `SELECT * FROM machines WHERE business_id = $1 AND status <> 'killed'`,
    [businessId],
  );
}

export async function list(): Promise<MachineRow[]> {
  return query<MachineRow>(
    `SELECT * FROM machines WHERE status <> 'killed' ORDER BY created_at DESC`,
  );
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface ProvisionSpec {
  businessId: string;
  name: string;
  niche: string;
  offer: string;
  targetCustomer: string;
  priceCents: number;
  url: string;
  thesis: string;
  cycleId?: string;
}

export interface ProvisionResult {
  ok: boolean;
  machine: MachineRow | null;
  reason: string;
  guardrailCode: string;
}

/**
 * Gives a business its machine and seeds it with everything the operator agent
 * needs to know about the company it is running.
 */
export async function provision(spec: ProvisionSpec): Promise<ProvisionResult> {
  const existing = await forBusiness(spec.businessId);
  if (existing) return { ok: true, machine: existing, reason: 'already provisioned', guardrailCode: '' };

  // An hour of machine time, authorised up front like any other spend.
  const auth = await authorizeSpend({
    businessId: spec.businessId,
    amountUsd: env.machineCostPerHour,
    category: 'infra',
  });
  if (!auth.allowed) {
    await decisions.record({
      cycleId: spec.cycleId ?? `machine_${Date.now().toString(36)}`,
      businessId: spec.businessId,
      action: 'MACHINE_DECLINED',
      reasoning:
        `Did not provision a machine for ${spec.name}: ${auth.reason}. The business runs ` +
        'without one; its storefront is unaffected.',
      confidence: 1,
      model: 'guardrail',
      outputs: { guardrailCode: auth.code, limits: auth.limits },
    });
    return { ok: false, machine: null, reason: auth.reason, guardrailCode: auth.code };
  }

  const Sandbox = await sdk();
  const box = await Sandbox.create({
    apiKey: requireKey(),
    name: `foundry-${spec.businessId}`.slice(0, 64),
    metadata: { businessId: spec.businessId, niche: spec.niche },
  });

  // Seed the machine with the company's own operating context.
  const seed: [string, string][] = [
    ['/root/company/COMPANY.md', companyBrief(spec)],
    [
      '/root/company/company.json',
      JSON.stringify(
        {
          businessId: spec.businessId,
          name: spec.name,
          niche: spec.niche,
          offer: spec.offer,
          targetCustomer: spec.targetCustomer,
          priceCents: spec.priceCents,
          storefront: spec.url,
          foundry: env.publicUrl,
          disclosure: env.disclosureLine,
        },
        null,
        2,
      ),
    ],
    ['/root/company/NOTES.md', '# Working notes\n\nAppend findings here.\n'],
  ];
  for (const [path, content] of seed) {
    await box.files.write(path, content);
  }

  const machineId = id('mch');
  const rows = await query<MachineRow>(
    `INSERT INTO machines (id, business_id, provider, external_id, status, last_started_at, meta)
     VALUES ($1,$2,'superserve',$3,'active', now(), $4)
     RETURNING *`,
    [machineId, spec.businessId, box.id, JSON.stringify({ name: spec.name, seeded: true })],
  );

  await decisions.record({
    cycleId: spec.cycleId ?? `machine_${Date.now().toString(36)}`,
    businessId: spec.businessId,
    action: 'MACHINE_PROVISIONED',
    reasoning:
      `Gave ${spec.name} its own machine (${box.id}). It is seeded with the company brief, ` +
      'so the operator agent can keep working state between cycles instead of starting cold ' +
      `each time. Metered at $${env.machineCostPerHour}/hour and paused when idle.`,
    confidence: 1,
    model: 'guardrail',
    outputs: { machineId, externalId: box.id, provider: 'superserve' },
  });

  return { ok: true, machine: rows[0], reason: 'provisioned', guardrailCode: '' };
}

function companyBrief(spec: ProvisionSpec): string {
  return `# ${spec.name}

You are the operator agent for this company. This machine is yours; anything you
write here persists between cycles.

- **Niche**: ${spec.niche}
- **Customer**: ${spec.targetCustomer}
- **Offer**: ${spec.offer}
- **Price**: $${(spec.priceCents / 100).toFixed(2)} one-time
- **Storefront**: ${spec.url}
- **Thesis**: ${spec.thesis}

## Rules

1. Every public artefact must carry this line verbatim:
   ${env.disclosureLine}
2. No medical, legal, or financial claims. No guarantees. Nothing aimed at minors.
3. You cannot spend money from here. Budget decisions belong to the CEO loop.
4. Keep durable findings in NOTES.md — it is the only thing that survives you.
`;
}

// ---------------------------------------------------------------------------
// Running work on the machine
// ---------------------------------------------------------------------------

/** Connects, resuming a paused machine first. Updates the billing clock. */
async function connect(machine: MachineRow) {
  const Sandbox = await sdk();
  const box = await Sandbox.connect(machine.external_id, { apiKey: requireKey() });

  if (machine.status === 'paused') {
    await box.resume();
    await query(
      `UPDATE machines SET status = 'active', last_started_at = now() WHERE id = $1`,
      [machine.id],
    );
  }
  return box;
}

/**
 * Runs one command on a business's machine and records it. The recording is
 * append-only, so the transcript of what the agent did cannot be rewritten.
 */
export async function run(
  businessId: string,
  command: string,
  opts: { cycleId?: string; timeoutMs?: number } = {},
): Promise<MachineRun> {
  const machine = await forBusiness(businessId);
  if (!machine) throw new Error(`${businessId} has no machine`);

  const box = await connect(machine);
  const startedAt = Date.now();
  const result = await box.commands.run(command, { timeoutMs: opts.timeoutMs ?? 120_000 });
  const durationMs = Date.now() - startedAt;

  const stdout = truncate(result.stdout ?? '');
  const stderr = truncate(result.stderr ?? '');

  await query(
    `INSERT INTO machine_runs
       (id, machine_id, business_id, cycle_id, command, exit_code, stdout, stderr, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id('run'), machine.id, businessId, opts.cycleId ?? '', command, result.exitCode, stdout, stderr, durationMs],
  );
  await query(`UPDATE machines SET last_used_at = now() WHERE id = $1`, [machine.id]);

  return { command, exitCode: result.exitCode, stdout, stderr, durationMs };
}

function truncate(s: string, max = 8000): string {
  return s.length > max ? `${s.slice(0, max)}\n…[${s.length - max} more characters]` : s;
}

// ---------------------------------------------------------------------------
// Metering and lifecycle
// ---------------------------------------------------------------------------

/**
 * Bills elapsed active time as OPEX and pauses machines that have gone idle.
 * Called once per CEO cycle, so an unused machine costs at most one idle window.
 */
export async function meterAndPark(): Promise<{ billed: number; paused: number }> {
  const machines = await query<MachineRow>(`SELECT * FROM machines WHERE status = 'active'`);
  let billed = 0;
  let paused = 0;

  for (const machine of machines) {
    const startedAt = machine.last_started_at ? new Date(machine.last_started_at).getTime() : null;
    if (startedAt) {
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const cost = (seconds / 3600) * env.machineCostPerHour;

      // Only post once a period is worth at least a cent, so the ledger does
      // not fill with zero-value rows.
      if (cost >= 0.01) {
        await ledger.post({
          businessId: machine.business_id,
          kind: 'OPEX',
          amountCents: ledger.cents(cost),
          description: `Machine time for ${machine.business_id} (${seconds}s @ $${env.machineCostPerHour}/hr)`,
          source: `machine:${machine.provider}`,
          externalId: `machine:${machine.id}:${Math.floor(Date.now() / 1000)}`,
          meta: { machineId: machine.id, seconds },
        });
        await query(
          `UPDATE machines SET billed_seconds = billed_seconds + $2, last_started_at = now() WHERE id = $1`,
          [machine.id, seconds],
        );
        billed++;
      }
    }

    const idleMs = Date.now() - new Date(machine.last_used_at).getTime();
    if (idleMs > env.machineIdleMinutes * 60_000) {
      try {
        const box = await (await sdk()).connect(machine.external_id, { apiKey: requireKey() });
        await box.pause();
        await query(`UPDATE machines SET status = 'paused' WHERE id = $1`, [machine.id]);
        paused++;
      } catch {
        /* a machine that cannot be paused is retried next cycle */
      }
    }
  }

  return { billed, paused };
}

/** Kills a business's machine. Called when the business itself is killed. */
export async function kill(businessId: string, reason: string): Promise<boolean> {
  const machine = await forBusiness(businessId);
  if (!machine) return false;

  try {
    const box = await (await sdk()).connect(machine.external_id, { apiKey: requireKey() });
    await box.kill();
  } catch {
    /* already gone upstream; the row still needs closing */
  }

  await query(
    `UPDATE machines SET status = 'killed', killed_at = now(),
            meta = meta || jsonb_build_object('killReason', $2::text)
      WHERE id = $1`,
    [machine.id, reason],
  );
  return true;
}
