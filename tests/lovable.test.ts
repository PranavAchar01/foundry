import { describe, expect, it } from 'vitest';
import { LovablePagegenProvider, lovableBrief, InternalPagegenProvider } from '@/lib/providers/pagegen';
import { PAGEGEN_IMPLEMENTATIONS, pagegenProvider } from '@/lib/providers/pagegen';
import { env } from '@/lib/env';
import type { PageSpec } from '@/lib/providers/types';

/**
 * Lovable builds and hosts the storefront, so the only thing standing between a
 * spawned business and a broken Buy button is the brief. If any part of the
 * contract drifts out of that prompt, checkout fails silently on a live site —
 * these assertions are the guard against that.
 */

const SPEC: PageSpec = {
  businessId: 'biz_test123',
  slug: 'changelog-engine',
  name: 'Changelog Engine',
  tagline: 'Turns shipped commits into release notes customers read.',
  niche: 'bootstrapped SaaS founders writing changelogs',
  offer: 'templates, tone guidelines and a checklist, delivered instantly',
  targetCustomer: 'bootstrapped SaaS founders',
  priceCents: 2900,
  bullets: ['Instant download', 'One-time price'],
  checkoutEndpoint: 'https://foundry-biz-eight.vercel.app/api/checkout',
  beaconEndpoint: 'https://foundry-biz-eight.vercel.app/api/track',
  disclosure: env.disclosureLine,
};

describe('lovable brief', () => {
  const brief = lovableBrief(SPEC);

  it('carries every part of the checkout contract', () => {
    expect(brief).toContain('id="buy"');
    expect(brief).toContain(SPEC.checkoutEndpoint);
    expect(brief).toContain(`{"businessId":"${SPEC.businessId}"}`);
    // The redirect is what actually moves the buyer to Stripe.
    expect(brief).toContain('window.location.href');
    expect(brief.toLowerCase()).toContain('"url" field');
  });

  it('carries the pageview beacon, the only real traffic signal', () => {
    expect(brief).toContain(SPEC.beaconEndpoint);
    expect(brief).toContain('never block rendering');
  });

  it('carries the disclosure line verbatim', () => {
    expect(brief).toContain(env.disclosureLine);
    expect(brief).toContain('verbatim');
  });

  it('forbids the claims the guardrails also forbid', () => {
    const lower = brief.toLowerCase();
    expect(lower).toContain('no medical, legal, or financial claims');
    expect(lower).toContain('no guarantees');
    expect(lower).toContain('minors');
    // A generated storefront inventing reviews would be a fabricated record.
    expect(lower).toContain('do not invent testimonials');
  });

  it('describes the actual product, not a placeholder', () => {
    expect(brief).toContain(SPEC.name);
    expect(brief).toContain(SPEC.tagline);
    expect(brief).toContain('$29.00');
    expect(brief).toContain(SPEC.targetCustomer);
    for (const bullet of SPEC.bullets) expect(brief).toContain(bullet);
  });

  /*
   * A run builds eight of these in the same minute. What stops them coming back
   * as eight variants of one page is the buyer block — so it has to appear when
   * the business was built for a named person, and stay out of the way when it
   * was built for a segment and there is nobody to write to.
   */
  it('writes to the named buyer when the business is one person\'s', () => {
    const personal = lovableBrief({
      ...SPEC,
      prospectBio: 'DP + operator. Commercials, music videos. Own an FX9. NYC.',
      prospectChore: 'Rebuilding tomorrow\'s call sheet by hand every night after wrap.',
    });
    expect(personal).toContain('THE BUYER');
    expect(personal).toContain('Own an FX9');
    expect(personal).toContain('call sheet by hand every night after wrap');
  });

  it('omits the buyer block entirely on the segment path', () => {
    expect(brief).not.toContain('THE BUYER');
  });
});

describe('lovable provider', () => {
  it('constructs without a key so the registry can list it', () => {
    const provider = new LovablePagegenProvider('');
    expect(provider.info.name).toBe('lovable');
    expect(provider.info.requires).toContain('LOVABLE_API_KEY');
    expect(provider.info.configured).toBe(Boolean(env.lovableApiKey));
  });

  it('fails loudly rather than silently when the key is missing', async () => {
    const provider = new LovablePagegenProvider('');
    await expect(provider.generate(SPEC)).rejects.toThrow(/LOVABLE_API_KEY/);
  });

  it('is selected purely by the env flag', () => {
    const original = process.env.FOUNDRY_PAGEGEN_PROVIDER;
    try {
      process.env.FOUNDRY_PAGEGEN_PROVIDER = 'lovable';
      expect(pagegenProvider().info.name).toBe('lovable');
      process.env.FOUNDRY_PAGEGEN_PROVIDER = 'internal';
      expect(pagegenProvider().info.name).toBe('internal');
    } finally {
      process.env.FOUNDRY_PAGEGEN_PROVIDER = original;
    }
  });

  it('still offers both implementations', () => {
    expect(Object.keys(PAGEGEN_IMPLEMENTATIONS).sort()).toEqual(['internal', 'lovable']);
  });
});

describe('hosted-page contract', () => {
  it('the internal provider returns html and hosts nothing', async () => {
    const page = await new InternalPagegenProvider().generate(SPEC);
    expect(page.html.length).toBeGreaterThan(500);
    // No hostedUrl means spawn deploys it via the HostProvider.
    expect(page.hostedUrl).toBeUndefined();
  });

  it('a hosted result is what makes spawn skip the HostProvider', () => {
    // Documents the branch condition in lib/spawn.ts: `if (page.hostedUrl)`.
    const hosted = { html: '', provider: 'lovable', hostedUrl: 'https://x.lovable.app', projectId: 'p1' };
    expect(Boolean(hosted.hostedUrl)).toBe(true);
    expect(hosted.html).toBe('');
  });
});
