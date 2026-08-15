import { env } from './env';
import { brain, type BrainMessage, type BrainToolResult, type ToolSpec } from './brain';
import * as machine from './machine';
import * as decisions from './decisions';
import { query } from './db';
import type { BusinessMetrics } from './agent';

/**
 * The operator agent: one per business, working inside that business's machine.
 *
 * The CEO decides *whether* a business lives. The operator decides *what the
 * business does today* — and it does it by running real commands on a real
 * machine, not by describing what it would do. Its output is the shell history
 * in `machine_runs`, which is append-only.
 *
 * It has no Foundry credentials and no way to spend money. The machine is
 * isolated, so the blast radius of a bad command is that one microVM.
 */

const MAX_TURNS = 8;
const OUTPUT_BUDGET = 4000;

const OPERATOR_SYSTEM = `You are the operator agent for a single micro-business inside FOUNDRY,
an autonomous holding company. You are working on that business's own persistent machine
(Ubuntu). Files you write survive between sessions; the shell is real.

Read /root/company/COMPANY.md first — it is the brief for the company you run.

Your job each session is to leave the company measurably better off using only this machine:
draft and refine sales copy, build assets the storefront needs, analyse what you know about
traffic and conversion, write scripts that make the next session faster, and record durable
findings in /root/company/NOTES.md.

Hard rules:
- No medical, legal, or financial claims. No guarantees. Nothing aimed at minors.
- Every public-facing artefact carries the disclosure line in COMPANY.md, verbatim.
- You cannot spend money and must not try. Budget belongs to the CEO loop.
- Do not attempt to reach FOUNDRY's own APIs or read credentials.

Work in small steps. Prefer appending to NOTES.md over re-deriving things you already knew.
When you are done, call finish with an honest summary of what changed on disk.`;

const TOOLS: ToolSpec[] = [
  {
    name: 'run_command',
    description:
      'Run a shell command on the company machine. Returns exit code, stdout and stderr. ' +
      'The working directory is /root/company.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        why: { type: 'string', description: 'One short line: why this command, now.' },
      },
      required: ['command', 'why'],
    },
  },
  {
    name: 'finish',
    description: 'End the session and report what actually changed.',
    schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'What you changed on the machine and why it helps. 2-5 sentences.',
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths you created or modified.',
        },
        nextStep: { type: 'string', description: 'The single most useful next action.' },
      },
      required: ['summary', 'artifacts', 'nextStep'],
    },
  },
];

export interface OperatorSession {
  businessId: string;
  turns: number;
  commands: number;
  summary: string;
  artifacts: string[];
  nextStep: string;
  decisionId: string;
  model: string;
  error: string | null;
}

export async function operate(
  metrics: BusinessMetrics,
  opts: { cycleId: string; maxTurns?: number } = { cycleId: '' },
): Promise<OperatorSession> {
  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const box = await machine.forBusiness(metrics.id);
  if (!box) {
    throw new Error(`${metrics.id} has no machine — provision one before operating`);
  }

  const thinker = brain();
  const messages: BrainMessage[] = [
    {
      role: 'user',
      text: [
        `Session for ${metrics.name} (${metrics.id}).`,
        `Storefront: ${metrics.url}`,
        `Measured so far: ${metrics.visitors} pageviews, ${metrics.conversions} conversions, ` +
          `$${metrics.revenueUsd.toFixed(2)} revenue against $${(metrics.cogsUsd + metrics.opexUsd).toFixed(2)} spend.`,
        `Age: ${metrics.ageMinutes} minutes.`,
        '',
        'Start by reading the brief and your previous notes.',
      ].join('\n'),
    },
  ];

  let turns = 0;
  let commands = 0;
  let finished: { summary: string; artifacts: string[]; nextStep: string } | null = null;
  let model = thinker.info.model;
  let error: string | null = null;

  try {
    while (turns < maxTurns && !finished) {
      turns++;
      const turn = await thinker.converse({
        system: OPERATOR_SYSTEM,
        messages,
        tools: TOOLS,
        maxTokens: 2000,
      });
      model = turn.model;
      messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });

      if (!turn.toolCalls.length) break;

      const results: BrainToolResult[] = [];
      for (const use of turn.toolCalls) {
        if (use.name === 'finish') {
          const input = use.input as { summary?: string; artifacts?: string[]; nextStep?: string };
          finished = {
            summary: String(input.summary ?? '').slice(0, 2000),
            artifacts: (input.artifacts ?? []).map(String).slice(0, 20),
            nextStep: String(input.nextStep ?? '').slice(0, 400),
          };
          results.push({ id: use.id, content: 'session closed' });
          continue;
        }

        if (use.name === 'run_command') {
          const command = String((use.input as { command?: string }).command ?? '');
          commands++;
          try {
            const out = await machine.run(metrics.id, `cd /root/company && ${command}`, {
              cycleId: opts.cycleId,
            });
            results.push({
              id: use.id,
              content:
                `exit ${out.exitCode}\n` +
                `stdout:\n${out.stdout.slice(0, OUTPUT_BUDGET)}\n` +
                (out.stderr ? `stderr:\n${out.stderr.slice(0, 1000)}` : ''),
              isError: out.exitCode !== 0,
            });
          } catch (err) {
            results.push({
              id: use.id,
              content: `command failed: ${String(err).slice(0, 300)}`,
              isError: true,
            });
          }
        }
      }

      messages.push({ role: 'tool', results });
    }
  } catch (err) {
    error = String(err instanceof Error ? err.message : err).slice(0, 300);
  }

  const summary =
    finished?.summary ??
    (error
      ? `Session ended early: ${error}`
      : `Session ended after ${turns} turn(s) without an explicit finish.`);

  const row = await decisions.record({
    cycleId: opts.cycleId,
    businessId: metrics.id,
    action: 'OPERATOR_SESSION',
    reasoning:
      `Operator worked ${commands} command(s) on ${metrics.name}'s own machine. ${summary}` +
      (finished?.nextStep ? ` Next: ${finished.nextStep}` : ''),
    confidence: finished ? 0.8 : 0.4,
    model,
    inputs: { metrics, maxTurns },
    outputs: {
      turns,
      commands,
      artifacts: finished?.artifacts ?? [],
      nextStep: finished?.nextStep ?? '',
      machineId: box.id,
      error,
    },
  });

  return {
    businessId: metrics.id,
    turns,
    commands,
    summary,
    artifacts: finished?.artifacts ?? [],
    nextStep: finished?.nextStep ?? '',
    decisionId: row.id,
    model,
    error,
  };
}

export interface MachineRunRow {
  id: string;
  business_id: string;
  command: string;
  exit_code: number;
  stdout: string;
  duration_ms: number;
  created_at: string;
}

export async function recentRuns(limit = 30): Promise<MachineRunRow[]> {
  return query<MachineRunRow>(
    `SELECT id, business_id, command, exit_code, stdout, duration_ms, created_at
       FROM machine_runs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}
