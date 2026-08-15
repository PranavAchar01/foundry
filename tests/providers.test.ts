import { describe, expect, it } from 'vitest';
import { REGISTRY, describeProviders, providers } from '@/lib/providers';
import { renderTemplate } from '@/lib/providers/pagegen';
import { env } from '@/lib/env';

/**
 * The zero-code-edit claim, made testable.
 *
 * Every capability has a no-key default and at least one sponsor path. This
 * walks the registry, instantiates every implementation of every capability,
 * and asserts each one declares which env var it needs. If a sponsor key
 * arrives tomorrow, flipping the flag is the whole change.
 */

const EXPECTED: Record<string, { flag: string; default: string; options: string[] }> = {
  brain: { flag: 'FOUNDRY_BRAIN_PROVIDER', default: 'anthropic', options: ['anthropic', 'openai'] },
  labor: { flag: 'LABOR_PROVIDER', default: 'stub', options: ['terac', 'stub'] },
  pagegen: { flag: 'FOUNDRY_PAGEGEN_PROVIDER', default: 'internal', options: ['internal', 'lovable'] },
  checkout: { flag: 'FOUNDRY_CHECKOUT_PROVIDER', default: 'stripe', options: ['stripe', 'whop', 'dodo'] },
  sandbox: { flag: 'FOUNDRY_SANDBOX_PROVIDER', default: 'vercel', options: ['vercel', 'sandbox0', 'superserve'] },
  bus: { flag: 'FOUNDRY_BUS_PROVIDER', default: 'postgres', options: ['postgres', 'band'] },
  support: { flag: 'FOUNDRY_SUPPORT_PROVIDER', default: 'resend', options: ['resend', 'linq'] },
  qa: { flag: 'FOUNDRY_QA_PROVIDER', default: 'playwright', options: ['playwright', 'replay'] },
  host: { flag: 'FOUNDRY_HOST_PROVIDER', default: 'vercel', options: ['vercel', 'render'] },
};

describe('provider registry', () => {
  it('covers every swappable capability, including the brain', () => {
    expect(REGISTRY.map((r) => r.capability).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('instantiates every implementation of every capability', () => {
    for (const entry of REGISTRY) {
      const expected = EXPECTED[entry.capability];
      expect(Object.keys(entry.implementations).sort(), entry.capability).toEqual(
        expected.options.slice().sort(),
      );

      for (const [name, make] of Object.entries(entry.implementations)) {
        // Construction must never require the key — only using it may.
        const instance = make();
        expect(instance, `${entry.capability}/${name}`).toBeTruthy();
        expect(instance.info.capability).toBe(entry.capability);
        expect(instance.info.name).toBe(name);
        expect(Array.isArray(instance.info.requires)).toBe(true);
        expect(typeof instance.info.configured).toBe('boolean');
      }
    }
  });

  it('exposes every capability method the callers use', () => {
    const active = providers();
    expect(typeof active.brain.structured).toBe('function');
    expect(typeof active.brain.converse).toBe('function');
    expect(typeof active.labor.quote).toBe('function');
    expect(typeof active.labor.purchase).toBe('function');
    expect(typeof active.labor.poll).toBe('function');
    expect(typeof active.pagegen.generate).toBe('function');
    expect(typeof active.checkout.createSession).toBe('function');
    expect(typeof active.sandbox.run).toBe('function');
    expect(typeof active.bus.publish).toBe('function');
    expect(typeof active.bus.consume).toBe('function');
    expect(typeof active.support.send).toBe('function');
    expect(typeof active.qa.verify).toBe('function');
    expect(typeof active.host.deploy).toBe('function');
  });

  it('every default implementation needs no sponsor key', () => {
    for (const entry of REGISTRY) {
      const fallback = entry.implementations[entry.default]();
      const sponsorKeys = fallback.info.requires.filter(
        (r) => !['POSTGRES_URL', 'STRIPE_SECRET_KEY', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY'].includes(r),
      );
      expect(sponsorKeys, `${entry.capability} default ${entry.default}`).toEqual([]);
    }
  });

  it('selects an implementation purely from the env flag', () => {
    const original = process.env.FOUNDRY_CHECKOUT_PROVIDER;
    try {
      process.env.FOUNDRY_CHECKOUT_PROVIDER = 'whop';
      expect(env.checkoutProvider).toBe('whop');
      expect(providers().checkout.info.name).toBe('whop');

      process.env.FOUNDRY_CHECKOUT_PROVIDER = 'dodo';
      expect(providers().checkout.info.name).toBe('dodo');

      process.env.FOUNDRY_CHECKOUT_PROVIDER = 'stripe';
      expect(providers().checkout.info.name).toBe('stripe');
    } finally {
      process.env.FOUNDRY_CHECKOUT_PROVIDER = original;
    }
  });

  it('describes each capability with the flag that switches it', () => {
    const described = describeProviders();
    for (const capability of described) {
      const expected = EXPECTED[capability.capability];
      expect(capability.flag).toBe(expected.flag);
      expect(capability.options.filter((o) => o.isActive)).toHaveLength(1);
    }
  });

  it('renders a checkout-wired, disclosed page from the internal template', async () => {
    const html = renderTemplate({
      businessId: 'biz_test',
      slug: 'test-biz',
      name: 'Test Biz',
      tagline: 'A tagline',
      niche: 'testing',
      offer: 'a thing',
      targetCustomer: 'testers',
      priceCents: 2900,
      bullets: ['one', 'two', 'three'],
      checkoutEndpoint: 'https://foundry-biz.vercel.app/api/checkout',
      beaconEndpoint: 'https://foundry-biz.vercel.app/api/track',
      disclosure: env.disclosureLine,
    });

    expect(html).toContain('id="buy"');
    expect(html).toContain('biz_test');
    expect(html).toContain('/api/checkout');
    expect(html).toContain('/api/track');
    expect(html).toContain('$29.00');
    // Every spawned business carries the disclosure. Non-negotiable.
    expect(html).toContain(env.disclosureLine);
  });

  it('escapes hostile copy rather than injecting it into the page', () => {
    const html = renderTemplate({
      businessId: 'biz_x',
      slug: 'x',
      name: '<script>alert(1)</script>',
      tagline: '"onload="alert(2)',
      niche: 'x',
      offer: 'x',
      targetCustomer: 'x',
      priceCents: 900,
      bullets: ['<img src=x onerror=alert(3)>'],
      checkoutEndpoint: 'https://example.com/api/checkout',
      beaconEndpoint: 'https://example.com/api/track',
      disclosure: 'disclosed',
    });
    // The payloads survive as visible text; what must not survive is the markup.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(3)&gt;');
    // The attribute-breakout payload cannot close the attribute it sits in.
    expect(html).toContain('&quot;onload=&quot;alert(2)');
  });
});
