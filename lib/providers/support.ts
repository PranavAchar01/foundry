import { env } from '@/lib/env';
import type { SupportProvider, SupportMessage } from './types';

/** Default: Resend transactional email. */
export class ResendSupportProvider implements SupportProvider {
  readonly info = {
    capability: 'support',
    name: 'resend',
    configured: Boolean(env.resendApiKey),
    requires: ['RESEND_API_KEY'],
  };

  constructor(
    private readonly apiKey = env.resendApiKey,
    private readonly from = 'Foundry <onboarding@resend.dev>',
  ) {}

  async send(msg: SupportMessage): Promise<{ id: string; provider: string; delivered: boolean }> {
    if (!this.apiKey) throw new Error('RESEND_API_KEY is not set');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [msg.to],
        subject: msg.subject,
        text: `${msg.body}\n\n—\n${env.disclosureLine}`,
      }),
    });
    if (!res.ok) throw new Error(`resend -> ${res.status} ${await res.text().catch(() => '')}`);
    const j = (await res.json()) as { id?: string };
    return { id: j.id ?? '', provider: 'resend', delivered: true };
  }
}

/**
 * Sponsor path: Linq — the customer-support channel over iMessage / RCS / SMS.
 *
 * Base URL and auth confirmed against the live API: the Partner API is at
 * `/api/partner/v3` with a Bearer token provisioned by Linq (the `/v1/*` paths
 * a naive guess would reach are 404s). `phone_numbers` is the discovery call —
 * the token decides which numbers may send.
 */
export class LinqSupportProvider implements SupportProvider {
  readonly info = {
    capability: 'support',
    name: 'linq',
    configured: Boolean(env.linqApiKey),
    requires: ['LINQ_API_KEY'],
  };

  private readonly base = 'https://api.linqapp.com/api/partner/v3';

  constructor(
    private readonly apiKey = env.linqApiKey,
    private readonly from = env.linqPhoneNumber,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) throw new Error('LINQ_API_KEY is not set');
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`linq ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Numbers this token may send from. Also the cheapest credential check. */
  async phoneNumbers(): Promise<{ id: string; phone_number: string }[]> {
    const out = await this.call<{ data?: { id: string; phone_number: string }[] }>(
      'GET',
      '/phone_numbers',
    );
    return out.data ?? [];
  }

  async send(msg: SupportMessage): Promise<{ id: string; provider: string; delivered: boolean }> {
    // Resolve a sending number when one is not pinned in config.
    let from = this.from;
    if (!from) {
      const numbers = await this.phoneNumbers();
      from = numbers[0]?.phone_number ?? '';
    }
    if (!from) throw new Error('linq: no sending phone number available for this token');

    const out = await this.call<{ data?: { id?: string } }>('POST', '/messages', {
      from,
      to: msg.to,
      body: `${msg.subject}\n\n${msg.body}\n\n${env.disclosureLine}`,
    });
    return { id: out.data?.id ?? '', provider: 'linq', delivered: true };
  }
}

export const SUPPORT_IMPLEMENTATIONS: Record<string, () => SupportProvider> = {
  resend: () => new ResendSupportProvider(),
  linq: () => new LinqSupportProvider(),
};

export function supportProvider(name = env.supportProvider): SupportProvider {
  const make = SUPPORT_IMPLEMENTATIONS[name] ?? SUPPORT_IMPLEMENTATIONS.resend;
  return make();
}
