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

/**
 * Sponsor path: Replay QA — an agent explores the deployed site and reports
 * bugs. Base URL and auth confirmed against the live OpenAPI document at
 * https://qa.replay.io/api/v1/openapi.json.
 *
 * Exploration is asynchronous and takes minutes, which is far longer than a
 * spawn can wait. So `verify()` runs the same synchronous content assertions
 * the default provider does — a spawn must never be trusted on an unchecked
 * page — and additionally *starts* a Replay project so the deep exploration
 * proceeds in the background. `collectBugs()` folds the findings back in later.
 */
export class ReplayQaProvider implements QaProvider {
  readonly info = {
    capability: 'qa',
    name: 'replay',
    configured: Boolean(env.replayApiKey),
    requires: ['REPLAY_API_KEY'],
  };

  private readonly base = 'https://qa.replay.io/api/v1';

  constructor(private readonly apiKey = env.replayApiKey) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) throw new Error('REPLAY_API_KEY is not set');
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`replay ${method} ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async verify(check: QaCheck): Promise<QaResult> {
    const checks: QaResult['checks'] = [];

    // Synchronous gate — identical assertions to the default provider.
    const res = await fetch(check.url, { headers: { 'user-agent': 'foundry-qa/1.0' } });
    const html = await res.text();
    checks.push({ name: 'http-200', passed: res.ok, detail: `GET ${check.url} -> ${res.status}` });
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

    // Asynchronous deep exploration, started but not waited on.
    try {
      const project = await this.call<{ id: string }>('POST', '/projects', {
        name: `foundry ${new URL(check.url).hostname}`,
        target_url: check.url,
        instructions:
          'This is a single-page digital product. Verify the primary Buy button reaches a ' +
          'checkout page, and report anything that would stop a visitor from paying.',
      });
      checks.push({
        name: 'replay-exploration-started',
        passed: true,
        detail: `project ${project.id} exploring in the background`,
      });
    } catch (err) {
      // A sponsor service being down must not fail an otherwise-good spawn.
      checks.push({
        name: 'replay-exploration-started',
        passed: true,
        detail: `deep exploration unavailable: ${String(err).slice(0, 120)}`,
      });
    }

    return { passed: checks.every((c) => c.passed), provider: 'replay', checks };
  }

  /** Bugs Replay's agent has found since the project was created. */
  async collectBugs(projectId: string): Promise<{ id: string; title: string; status: string }[]> {
    const out = await this.call<{ items?: { id: string; title: string; status: string }[] }>(
      'GET',
      `/projects/${projectId}/bugs`,
    );
    return out.items ?? [];
  }

  async projects(): Promise<{ id: string; name: string }[]> {
    const out = await this.call<{ items?: { id: string; name: string }[] }>('GET', '/projects');
    return out.items ?? [];
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
