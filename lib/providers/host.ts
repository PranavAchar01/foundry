import { env } from '@/lib/env';
import type { DeployRequest, DeployResult, HostProvider } from './types';

const VERCEL_API = 'https://api.vercel.com';

interface VercelDeployment {
  id: string;
  url: string;
  readyState?: string;
  alias?: string[];
  error?: { message?: string };
}

/**
 * Default host. Each spawned business gets its own real Vercel project and its
 * own production deployment — not a route on the Foundry app. Static files
 * only, so there is no build step and a deploy reaches READY in tens of
 * seconds, which is what keeps the whole spawn under four minutes.
 */
export class VercelHostProvider implements HostProvider {
  readonly info = {
    capability: 'host',
    name: 'vercel',
    configured: Boolean(env.vercelToken),
    requires: ['VERCEL_TOKEN'],
  };

  constructor(
    private readonly token = env.vercelToken,
    private readonly teamId = env.vercelTeamId,
  ) {}

  private q(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return this.teamId ? `${VERCEL_API}${path}${sep}teamId=${this.teamId}` : `${VERCEL_API}${path}`;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.q(path), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg =
        (json as { error?: { message?: string } })?.error?.message ?? text.slice(0, 300);
      throw new Error(`vercel ${method} ${path} -> ${res.status}: ${msg}`);
    }
    return json as T;
  }

  /** Idempotent: a 409 from an existing project is success, not failure. */
  private async ensureProject(name: string): Promise<void> {
    try {
      await this.api('POST', '/v11/projects', { name, framework: null });
    } catch (err) {
      const msg = String(err);
      if (!/409|already exists|conflict/i.test(msg)) throw err;
    }
  }

  async deploy(req: DeployRequest): Promise<DeployResult> {
    if (!this.token) throw new Error('VERCEL_TOKEN is not set');
    const name = projectName(req.slug);
    await this.ensureProject(name);

    const deployment = await this.api<VercelDeployment>('POST', '/v13/deployments', {
      name,
      project: name,
      target: 'production',
      files: req.files.map((f) => ({
        file: f.path,
        data: Buffer.from(f.content, 'utf8').toString('base64'),
        encoding: 'base64',
      })),
      projectSettings: {
        framework: null,
        buildCommand: null,
        installCommand: null,
        outputDirectory: null,
        devCommand: null,
      },
    });

    const ready = await this.waitReady(deployment.id);
    const url = pickUrl(ready, name);

    return {
      url,
      deploymentId: deployment.id,
      provider: 'vercel',
      ready: ready.readyState === 'READY',
    };
  }

  private async waitReady(deploymentId: string, timeoutMs = 150_000): Promise<VercelDeployment> {
    const started = Date.now();
    let last: VercelDeployment = { id: deploymentId, url: '' };
    while (Date.now() - started < timeoutMs) {
      last = await this.api<VercelDeployment>('GET', `/v13/deployments/${deploymentId}`);
      if (last.readyState === 'READY') return last;
      if (last.readyState === 'ERROR' || last.readyState === 'CANCELED') {
        throw new Error(`vercel deployment ${deploymentId} ${last.readyState}: ${last.error?.message ?? ''}`);
      }
      await sleep(2000);
    }
    return last;
  }
}

/** Sponsor path: Render static site. */
export class RenderHostProvider implements HostProvider {
  readonly info = {
    capability: 'host',
    name: 'render',
    configured: Boolean(env.renderApiKey),
    requires: ['RENDER_API_KEY'],
  };

  constructor(private readonly apiKey = env.renderApiKey) {}

  async deploy(req: DeployRequest): Promise<DeployResult> {
    if (!this.apiKey) throw new Error('RENDER_API_KEY is not set');

    const res = await fetch('https://api.render.com/v1/services', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'static_site',
        name: projectName(req.slug),
        serviceDetails: {
          publishPath: '.',
          buildCommand: '',
        },
        envVars: [],
      }),
    });
    if (!res.ok) throw new Error(`render create -> ${res.status} ${await res.text().catch(() => '')}`);

    const json = (await res.json()) as { service?: { id?: string; serviceDetails?: { url?: string } } };
    const url = json.service?.serviceDetails?.url ?? '';
    return {
      url,
      deploymentId: json.service?.id ?? '',
      provider: 'render',
      ready: Boolean(url),
    };
  }
}

export function projectName(slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Vercel project names are capped at 100 chars; keep well under it.
  return `${env.vercelProjectPrefix}-${clean}`.slice(0, 90).replace(/-$/, '');
}

function pickUrl(d: VercelDeployment, name: string): string {
  const aliases = (d.alias ?? []).filter(Boolean);
  if (aliases.length) {
    // Prefer the stable project alias over the per-deployment hash alias.
    const stable = aliases.find((a) => a === `${name}.vercel.app`);
    const shortest = aliases.slice().sort((a, b) => a.length - b.length)[0];
    return `https://${stable ?? shortest}`;
  }
  return d.url ? `https://${d.url}` : `https://${name}.vercel.app`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const HOST_IMPLEMENTATIONS: Record<string, () => HostProvider> = {
  vercel: () => new VercelHostProvider(),
  render: () => new RenderHostProvider(),
};

export function hostProvider(name = env.hostProvider): HostProvider {
  const make = HOST_IMPLEMENTATIONS[name] ?? HOST_IMPLEMENTATIONS.vercel;
  return make();
}
