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

/** Sponsor path: Linq SMS / iMessage support agent. */
export class LinqSupportProvider implements SupportProvider {
  readonly info = {
    capability: 'support',
    name: 'linq',
    configured: Boolean(env.linqApiKey && env.linqPhoneNumber),
    requires: ['LINQ_API_KEY', 'LINQ_PHONE_NUMBER'],
  };

  constructor(
    private readonly apiKey = env.linqApiKey,
    private readonly from = env.linqPhoneNumber,
  ) {}

  async send(msg: SupportMessage): Promise<{ id: string; provider: string; delivered: boolean }> {
    if (!this.apiKey) throw new Error('LINQ_API_KEY is not set');
    const res = await fetch('https://api.linqapp.com/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: msg.to,
        body: `${msg.subject}\n\n${msg.body}\n\n${env.disclosureLine}`,
      }),
    });
    if (!res.ok) throw new Error(`linq -> ${res.status} ${await res.text().catch(() => '')}`);
    const j = (await res.json()) as { id?: string };
    return { id: j.id ?? '', provider: 'linq', delivered: true };
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
