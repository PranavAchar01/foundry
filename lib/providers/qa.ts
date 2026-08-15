import { env } from '@/lib/env';
import type { QaCheck, QaProvider, QaResult } from './types';

/**
 * Default QA. Playwright drives the page when it is installed; when it is not
 * (Vercel's function runtime has no browser), the same assertions run against
 * the served HTML over fetch.
 *
 * Both modes check the same three things, because those three are what a spawn
 * is allowed to be trusted for: the page is up, the required strings are
 * present, and the checkout button exists.
 */
export class PlaywrightQaProvider implements QaProvider {
  readonly info = {
    capability: 'qa',
    name: 'playwright',
    configured: true,
    requires: [] as string[],
  };

  async verify(check: QaCheck): Promise<QaResult> {
    const checks: QaResult['checks'] = [];

    const res = await fetch(check.url, { headers: { 'user-agent': 'foundry-qa/1.0' } });
    checks.push({
      name: 'http-200',
      passed: res.ok,
      detail: `GET ${check.url} -> ${res.status}`,
    });

    const html = await res.text();
    for (const needle of check.expect) {
      checks.push({
        name: `contains:${needle.slice(0, 40)}`,
        passed: html.includes(needle),
        detail: html.includes(needle) ? 'found' : 'missing from served HTML',
      });
    }

    checks.push({
      name: 'checkout-button',
      passed: /id="buy"/.test(html),
      detail: /id="buy"/.test(html) ? 'buy button present' : 'no element with id="buy"',
    });

    const browser = await this.tryBrowser(check.url);
    if (browser) checks.push(browser);

    return { passed: checks.every((c) => c.passed), provider: 'playwright', checks };
  }

  /**
   * Only runs where a browser binary is actually present. Vercel's function
   * runtime has none, so this is skipped there and the fetch assertions above
   * stand alone; locally and in CI it adds a real rendered-DOM check.
   */
  private async tryBrowser(url: string): Promise<QaResult['checks'][number] | null> {
    const pw = await import('playwright').catch(() => null);
    if (!pw?.chromium) return null;

    const browser = await pw.chromium.launch({ headless: true }).catch(() => null);
    if (!browser) return null;
    try {
      const page = await browser.newPage();
      await page.goto(url);
      const visible = await page.isVisible('#buy');
      return {
        name: 'browser:buy-visible',
        passed: visible,
        detail: visible ? 'buy button rendered and visible' : 'buy button not visible in browser',
      };
    } catch (err) {
      return { name: 'browser:buy-visible', passed: false, detail: String(err).slice(0, 200) };
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

/** Sponsor path: replay.io recorded QA session. */
export class ReplayQaProvider implements QaProvider {
  readonly info = {
    capability: 'qa',
    name: 'replay',
    configured: Boolean(env.replayApiKey),
    requires: ['REPLAY_API_KEY'],
  };

  constructor(private readonly apiKey = env.replayApiKey) {}

  async verify(check: QaCheck): Promise<QaResult> {
    if (!this.apiKey) throw new Error('REPLAY_API_KEY is not set');
    const res = await fetch('https://api.replay.io/v1/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        url: check.url,
        assertions: check.expect.map((e) => ({ type: 'text_present', value: e })),
      }),
    });
    if (!res.ok) throw new Error(`replay -> ${res.status} ${await res.text().catch(() => '')}`);
    const j = (await res.json()) as {
      passed?: boolean;
      checks?: { name: string; passed: boolean; detail: string }[];
    };
    return {
      passed: Boolean(j.passed),
      provider: 'replay',
      checks: j.checks ?? [{ name: 'replay-run', passed: Boolean(j.passed), detail: 'remote run' }],
    };
  }
}

export const QA_IMPLEMENTATIONS: Record<string, () => QaProvider> = {
  playwright: () => new PlaywrightQaProvider(),
  replay: () => new ReplayQaProvider(),
};

export function qaProvider(name = env.qaProvider): QaProvider {
  const make = QA_IMPLEMENTATIONS[name] ?? QA_IMPLEMENTATIONS.playwright;
  return make();
}
