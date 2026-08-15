/**
 * The provider registry. Everything the agent can swap for a sponsor's product
 * is resolved through this file, and only through this file.
 *
 * `REGISTRY` is the single source of truth: `tests/providers.test.ts` walks it
 * and instantiates every implementation of every capability, which is what
 * proves that flipping a FOUNDRY_*_PROVIDER flag tomorrow needs zero code edits.
 */

import { env } from '@/lib/env';
import { LABOR_IMPLEMENTATIONS, laborProvider } from './labor';
import { PAGEGEN_IMPLEMENTATIONS, pagegenProvider } from './pagegen';
import { CHECKOUT_IMPLEMENTATIONS, checkoutProvider } from './checkout';
import { SANDBOX_IMPLEMENTATIONS, sandboxProvider } from './sandbox';
import { BUS_IMPLEMENTATIONS, busProvider } from './bus';
import { SUPPORT_IMPLEMENTATIONS, supportProvider } from './support';
import { QA_IMPLEMENTATIONS, qaProvider } from './qa';
import { HOST_IMPLEMENTATIONS, hostProvider } from './host';
import type { Capability, ProviderInfo } from './types';

export * from './types';
export { laborProvider, TeracProvider, StubProvider } from './labor';
export { pagegenProvider, renderTemplate } from './pagegen';
export { checkoutProvider, stripeClient } from './checkout';
export { sandboxProvider } from './sandbox';
export { busProvider } from './bus';
export { supportProvider } from './support';
export { qaProvider } from './qa';
export { hostProvider, projectName } from './host';

export interface CapabilityEntry {
  capability: string;
  /** Env var that selects the implementation. */
  flag: string;
  /** Implementation used when the flag is unset. */
  default: string;
  implementations: Record<string, () => Capability>;
  active: () => string;
}

export const REGISTRY: CapabilityEntry[] = [
  {
    capability: 'labor',
    flag: 'LABOR_PROVIDER',
    default: 'stub',
    implementations: LABOR_IMPLEMENTATIONS,
    active: () => env.laborProvider,
  },
  {
    capability: 'pagegen',
    flag: 'FOUNDRY_PAGEGEN_PROVIDER',
    default: 'internal',
    implementations: PAGEGEN_IMPLEMENTATIONS,
    active: () => env.pagegenProvider,
  },
  {
    capability: 'checkout',
    flag: 'FOUNDRY_CHECKOUT_PROVIDER',
    default: 'stripe',
    implementations: CHECKOUT_IMPLEMENTATIONS,
    active: () => env.checkoutProvider,
  },
  {
    capability: 'sandbox',
    flag: 'FOUNDRY_SANDBOX_PROVIDER',
    default: 'vercel',
    implementations: SANDBOX_IMPLEMENTATIONS,
    active: () => env.sandboxProvider,
  },
  {
    capability: 'bus',
    flag: 'FOUNDRY_BUS_PROVIDER',
    default: 'postgres',
    implementations: BUS_IMPLEMENTATIONS,
    active: () => env.busProvider,
  },
  {
    capability: 'support',
    flag: 'FOUNDRY_SUPPORT_PROVIDER',
    default: 'resend',
    implementations: SUPPORT_IMPLEMENTATIONS,
    active: () => env.supportProvider,
  },
  {
    capability: 'qa',
    flag: 'FOUNDRY_QA_PROVIDER',
    default: 'playwright',
    implementations: QA_IMPLEMENTATIONS,
    active: () => env.qaProvider,
  },
  {
    capability: 'host',
    flag: 'FOUNDRY_HOST_PROVIDER',
    default: 'vercel',
    implementations: HOST_IMPLEMENTATIONS,
    active: () => env.hostProvider,
  },
];

export interface CapabilityStatus {
  capability: string;
  flag: string;
  active: string;
  options: (ProviderInfo & { isActive: boolean })[];
}

/** What the dashboard and /api/providers render. */
export function describeProviders(): CapabilityStatus[] {
  return REGISTRY.map((entry) => {
    const active = entry.active();
    return {
      capability: entry.capability,
      flag: entry.flag,
      active,
      options: Object.entries(entry.implementations).map(([name, make]) => {
        let info: ProviderInfo;
        try {
          info = make().info;
        } catch {
          info = { capability: entry.capability, name, configured: false, requires: [] };
        }
        return { ...info, isActive: name === active };
      }),
    };
  });
}

/** Every capability resolved to its currently-selected implementation. */
export function providers() {
  return {
    labor: laborProvider(),
    pagegen: pagegenProvider(),
    checkout: checkoutProvider(),
    sandbox: sandboxProvider(),
    bus: busProvider(),
    support: supportProvider(),
    qa: qaProvider(),
    host: hostProvider(),
  };
}
