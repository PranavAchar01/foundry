import { Sandbox } from '@vercel/sandbox';
import { env } from '@/lib/env';
import type { SandboxProvider, SandboxRun } from './types';

/**
 * Default: Vercel Sandbox — ephemeral Firecracker microVMs. This is where
 * agent-authored code runs, isolated from the Foundry runtime.
 *
 * Credentials come from the same token/team/project triple the host provider
 * uses, so it needs no key beyond what is already set.
 */
export class VercelSandboxProvider implements SandboxProvider {
  readonly info = {
    capability: 'sandbox',
    name: 'vercel',
    configured: Boolean(env.vercelToken && env.vercelProjectId && env.vercelTeamId),
    requires: ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID'],
  };

  async run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<SandboxRun> {
    if (!env.vercelToken) throw new Error('VERCEL_TOKEN is not set');

    const box = await Sandbox.create({
      token: env.vercelToken,
      teamId: env.vercelTeamId,
      projectId: env.vercelProjectId,
      timeout: opts.timeoutMs ?? 120_000,
      runtime: 'node22',
    });

    try {
      const done = await box.runCommand(cmd, args);
      return {
        id: box.name,
        exitCode: done.exitCode,
        stdout: await done.stdout(),
        stderr: await done.stderr(),
        provider: 'vercel',
      };
    } finally {
      await box.stop().catch(() => {});
    }
  }
}

/** Sponsor path: sandbox0.ai isolated agent execution. */
export class Sandbox0Provider implements SandboxProvider {
  readonly info = {
    capability: 'sandbox',
    name: 'sandbox0',
    configured: Boolean(env.sandbox0ApiKey),
    requires: ['SANDBOX0_API_KEY'],
  };

  constructor(private readonly apiKey = env.sandbox0ApiKey) {}

  async run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<SandboxRun> {
    if (!this.apiKey) throw new Error('SANDBOX0_API_KEY is not set');
    const res = await fetch('https://api.sandbox0.ai/v1/executions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: [cmd, ...args].join(' '), timeout_ms: opts.timeoutMs ?? 120_000 }),
    });
    if (!res.ok) throw new Error(`sandbox0 -> ${res.status} ${await res.text().catch(() => '')}`);
    const j = (await res.json()) as { id?: string; exit_code?: number; stdout?: string; stderr?: string };
    return {
      id: j.id ?? 'sandbox0',
      exitCode: j.exit_code ?? 0,
      stdout: j.stdout ?? '',
      stderr: j.stderr ?? '',
      provider: 'sandbox0',
    };
  }
}

/** Sponsor path: superserve.ai long-lived agent sandboxes. */
export class SuperserveSandboxProvider implements SandboxProvider {
  readonly info = {
    capability: 'sandbox',
    name: 'superserve',
    configured: Boolean(env.superserveApiKey),
    requires: ['SUPERSERVE_API_KEY'],
  };

  constructor(private readonly apiKey = env.superserveApiKey) {}

  async run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<SandboxRun> {
    if (!this.apiKey) throw new Error('SUPERSERVE_API_KEY is not set');
    const res = await fetch('https://api.superserve.ai/v1/sandboxes/exec', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cmd, args, timeout_ms: opts.timeoutMs ?? 120_000 }),
    });
    if (!res.ok) throw new Error(`superserve -> ${res.status} ${await res.text().catch(() => '')}`);
    const j = (await res.json()) as { id?: string; exitCode?: number; stdout?: string; stderr?: string };
    return {
      id: j.id ?? 'superserve',
      exitCode: j.exitCode ?? 0,
      stdout: j.stdout ?? '',
      stderr: j.stderr ?? '',
      provider: 'superserve',
    };
  }
}

export const SANDBOX_IMPLEMENTATIONS: Record<string, () => SandboxProvider> = {
  vercel: () => new VercelSandboxProvider(),
  sandbox0: () => new Sandbox0Provider(),
  superserve: () => new SuperserveSandboxProvider(),
};

export function sandboxProvider(name = env.sandboxProvider): SandboxProvider {
  const make = SANDBOX_IMPLEMENTATIONS[name] ?? SANDBOX_IMPLEMENTATIONS.vercel;
  return make();
}
