import { env } from '@/lib/env';
import type { GeneratedPage, PagegenProvider, PageSpec } from './types';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** JSON string safe to inline inside a <script> block. */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

export function renderTemplate(spec: PageSpec): string {
  const price = (spec.priceCents / 100).toFixed(2);
  const bullets = spec.bullets
    .slice(0, 5)
    .map((b) => `<li>${esc(b)}</li>`)
    .join('\n        ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.name)}</title>
<meta name="description" content="${esc(spec.tagline)}">
<meta property="og:title" content="${esc(spec.name)}">
<meta property="og:description" content="${esc(spec.tagline)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#9889;</text></svg>">
<style>
  /* Black and white, Apple-flavoured: a full-bleed hero, tight display type,
     and no hue anywhere. The dashboard renders this page as a thumbnail, so
     the hero has to carry at very small sizes. */
  :root{--bg:#ffffff;--grey:#f5f5f7;--line:#d2d2d7;--fg:#1d1d1f;--muted:#6e6e73;--dim:#86868b}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--fg);line-height:1.5;letter-spacing:-.01em;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}

  .hero{min-height:82vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
    text-align:center;padding:80px 24px 64px;background:var(--grey);border-bottom:1px solid var(--line)}
  .eyebrow{font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--muted);margin-bottom:14px}
  h1{font-size:clamp(44px,9vw,88px);line-height:1.03;letter-spacing:-.035em;font-weight:700;
    max-width:14ch;margin-bottom:20px}
  .tagline{font-size:clamp(18px,2.4vw,24px);color:var(--muted);max-width:46ch;
    letter-spacing:-.015em;margin-bottom:34px}
  .cta{display:flex;align-items:center;gap:18px;flex-wrap:wrap;justify-content:center}
  .price{font-size:26px;font-weight:600;letter-spacing:-.02em}
  .price span{font-size:15px;color:var(--dim);font-weight:400;margin-left:6px}
  button{background:var(--fg);color:#fff;border:0;border-radius:980px;
    padding:14px 32px;font-size:17px;font-weight:500;letter-spacing:-.01em;cursor:pointer;
    font-family:inherit;transition:opacity .2s ease}
  button:hover{opacity:.85}
  button:disabled{opacity:.4;cursor:progress}
  .err{margin-top:14px;color:var(--fg);font-size:14px;font-weight:500;min-height:20px}

  .wrap{max-width:720px;margin:0 auto;padding:64px 24px 96px}
  h2{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
    color:var(--dim);margin-bottom:18px}
  ul{list-style:none;margin:0 0 44px}
  li{padding:16px 0;border-bottom:1px solid var(--line);font-size:17px;color:var(--fg)}
  li:first-child{border-top:1px solid var(--line)}
  .who{color:var(--muted);font-size:15px;margin-bottom:28px}
  .disclosure{padding-top:22px;border-top:1px solid var(--line);
    font-size:12.5px;line-height:1.6;color:var(--dim)}
</style>
</head>
<body>
  <header class="hero">
    <div class="eyebrow">${esc(spec.niche)}</div>
    <h1>${esc(spec.name)}</h1>
    <p class="tagline">${esc(spec.tagline)}</p>
    <div class="cta">
      <span class="price">$${price}<span>one-time</span></span>
      <button id="buy" type="button">Get it now</button>
    </div>
    <div class="err" id="err" role="alert"></div>
  </header>

  <main class="wrap">
    <h2>What you get</h2>
    <ul>
      ${bullets}
    </ul>
    <p class="who">Built for ${esc(spec.targetCustomer)}. ${esc(spec.offer)}</p>
    <p class="disclosure">${esc(spec.disclosure)}</p>
  </main>

<script>
(function () {
  var BUSINESS_ID = ${jsonForScript(spec.businessId)};
  var CHECKOUT = ${jsonForScript(spec.checkoutEndpoint)};
  var BEACON = ${jsonForScript(spec.beaconEndpoint)};

  // Real pageview, posted to Foundry. This is the only "traffic" number the
  // CEO agent ever sees — it is measured, never invented.
  try {
    fetch(BEACON, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        businessId: BUSINESS_ID,
        path: location.pathname,
        referrer: document.referrer || '',
      }),
      keepalive: true,
      mode: 'cors',
    }).catch(function () {});
  } catch (e) {}

  var btn = document.getElementById('buy');
  var err = document.getElementById('err');
  btn.addEventListener('click', function () {
    btn.disabled = true;
    err.textContent = '';
    fetch(CHECKOUT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ businessId: BUSINESS_ID }),
      mode: 'cors',
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j.url) { location.href = res.j.url; return; }
        err.textContent = res.j.error || 'Checkout is unavailable right now.';
        btn.disabled = false;
      })
      .catch(function () {
        err.textContent = 'Network error reaching checkout.';
        btn.disabled = false;
      });
  });
})();
</script>
</body>
</html>
`;
}

/**
 * Default, no-key implementation: deterministic internal templates. Fast
 * (single-digit milliseconds), which is most of the headroom in the sub-4-minute
 * spawn budget.
 */
export class InternalPagegenProvider implements PagegenProvider {
  readonly info = {
    capability: 'pagegen',
    name: 'internal',
    configured: true,
    requires: [] as string[],
  };

  async generate(spec: PageSpec): Promise<GeneratedPage> {
    return { html: renderTemplate(spec), provider: 'internal' };
  }
}

/**
 * The brief handed to Lovable's agent.
 *
 * Everything under "REQUIRED BEHAVIOUR" is load-bearing: FOUNDRY's checkout,
 * its pageview beacon, and the disclosure line are the contract between a
 * spawned storefront and the holding company. The wording is deliberately
 * imperative and literal — this prompt was iterated against the live agent
 * until the built page drove a real Stripe session end to end.
 */
export function lovableBrief(spec: PageSpec): string {
  return `Build a single-page marketing landing page for a real product. Keep it to one page, no routing, no auth, no backend.

PRODUCT
- Name: ${spec.name}
- For: ${spec.targetCustomer}
- Tagline: ${spec.tagline}
- Price: $${(spec.priceCents / 100).toFixed(2)} one-time
- What the buyer gets: ${spec.offer}
${spec.bullets.length ? `- Key points:\n${spec.bullets.map((b) => `  * ${b}`).join('\n')}` : ''}

REQUIRED BEHAVIOUR — this must be exact, because a payment system depends on it:

1. The primary call-to-action must be a <button> with the literal attribute id="buy" and visible text "Get it now".
2. When clicked, it must POST to ${spec.checkoutEndpoint}
   with header content-type: application/json
   and body exactly: {"businessId":"${spec.businessId}"}
   Then read the JSON response and set window.location.href to the response's "url" field.
   If the response is not ok, or has no url, show the response's "error" field as visible text near the button and re-enable it. Disable the button while the request is in flight.
3. On page load, fire a POST to ${spec.beaconEndpoint}
   with body {"businessId":"${spec.businessId}","path":"/","referrer":document.referrer}
   Ignore its response and never block rendering on it. Wrap it so a failure is silent.
4. The footer must contain this sentence verbatim, as plain visible text:
   ${spec.disclosure}

CONTENT RULES — do not violate these:
- No medical, legal, or financial claims.
- No guarantees of results, income, or outcomes.
- Nothing aimed at minors.
- Do not invent testimonials, customer logos, user counts, or review scores. No fake social proof of any kind.

HERO — this is the part that must stand out:

The page opens with a full-viewport hero section, and it has to be the most
striking thing about the site. It is seen first as a small thumbnail in a wall of
other companies, so it must read instantly at a glance:

- The product name as a very large headline — the dominant element on screen.
- The tagline directly beneath it, one line, clearly secondary.
- The price and the "Get it now" button both visible without scrolling.
- A distinctive full-bleed visual treatment behind the text: a bold colour
  field, gradient, or geometric/CSS-drawn composition. No stock photography and
  no placeholder image services.

Choose the palette and typography to suit THIS product and its buyer — a kit for
wedding photographers should not look like a tool for game developers. Pick one
strong, saturated accent colour that fits the niche and commit to it. Vary the
typography with the same intent: a display serif, a heavy geometric sans, or a
condensed grotesque, whichever matches the audience.

Deliberately do NOT default to a dark, monospace, terminal aesthetic — that is
the house style of the fallback generator and this page must be visually
distinguishable from it at thumbnail size.

Below the hero, keep it short: the key points, what the buyer receives, and the
footer disclosure. Mobile responsive throughout.`;
}

/**
 * Sponsor path: lovable.dev builds the storefront.
 *
 * Lovable is not a template renderer — it builds and *hosts* a full TypeScript
 * app, so this provider returns a `hostedUrl` and empty `html`. `spawn` sees
 * the hosted URL and skips the HostProvider rather than deploying a second,
 * divergent copy of the same storefront.
 *
 * The transport is Lovable's MCP endpoint speaking JSON-RPC 2.0. The three
 * tools used here — create_project, get_project, deploy_project — and their
 * argument shapes were read off the live server, and the whole path was driven
 * end to end: the built page called FOUNDRY's /api/checkout and redirected to a
 * real Stripe session.
 */
export class LovablePagegenProvider implements PagegenProvider {
  readonly info = {
    capability: 'pagegen',
    name: 'lovable',
    configured: Boolean(env.lovableApiKey),
    requires: ['LOVABLE_API_KEY'],
  };

  constructor(
    private readonly apiKey = env.lovableApiKey,
    private readonly mcpUrl = env.lovableMcpUrl,
  ) {}

  /** One JSON-RPC tools/call against Lovable's MCP endpoint. */
  private async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) throw new Error('LOVABLE_API_KEY is not set');

    const res = await fetch(this.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `foundry-${Date.now().toString(36)}`,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });

    if (!res.ok) {
      throw new Error(`lovable ${tool} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    }

    const envelope = parseRpc(await res.text());
    if (envelope.error) {
      throw new Error(`lovable ${tool}: ${envelope.error.message ?? JSON.stringify(envelope.error)}`);
    }

    // MCP returns tool output as content blocks; the JSON payload is the text
    // of the first block. `structuredContent` is preferred when present.
    const result = envelope.result ?? {};
    if (result.structuredContent) return result.structuredContent as T;

    const text = (result.content ?? []).find((c) => c.type === 'text')?.text;
    if (!text) throw new Error(`lovable ${tool} returned no content`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`lovable ${tool} returned non-JSON content`);
    }
  }

  async generate(spec: PageSpec): Promise<GeneratedPage> {
    const created = await this.call<{ id?: string; project?: { id?: string } }>('create_project', {
      ...(env.lovableWorkspaceId ? { workspace_id: env.lovableWorkspaceId } : {}),
      initial_message: lovableBrief(spec),
      wait: true,
      timeout_seconds: Math.min(600, env.lovableBuildTimeout),
    });

    const projectId = created.id ?? created.project?.id;
    if (!projectId) throw new Error('lovable create_project returned no project id');

    // create_project can return before the agent finishes; wait for the build.
    await this.awaitReady(projectId);

    const deployed = await this.call<{ url?: string; preview_url?: string }>('deploy_project', {
      project_id: projectId,
      name: `foundry-${spec.slug}`.slice(0, 60),
    });

    const hostedUrl = deployed.url ?? deployed.preview_url;
    if (!hostedUrl) throw new Error('lovable deploy_project returned no URL');

    // Publishing is asynchronous; do not hand back a URL that 404s.
    await waitReachable(hostedUrl);

    return { html: '', provider: 'lovable', hostedUrl, projectId };
  }

  private async awaitReady(projectId: string): Promise<void> {
    const deadline = Date.now() + env.lovableBuildTimeout * 1000;
    while (Date.now() < deadline) {
      const project = await this.call<{ status?: string; project?: { status?: string } }>(
        'get_project',
        { project_id: projectId },
      );
      const status = project.status ?? project.project?.status;
      if (status === 'completed' || status === 'ready') return;
      if (status === 'failed' || status === 'error') {
        throw new Error(`lovable build ${status} for ${projectId}`);
      }
      await sleep(5000);
    }
    throw new Error(`lovable build did not finish within ${env.lovableBuildTimeout}s`);
  }
}

interface RpcEnvelope {
  result?: { content?: { type: string; text?: string }[]; structuredContent?: unknown };
  error?: { message?: string };
}

/**
 * The endpoint may answer as plain JSON or as an SSE stream, depending on the
 * Accept negotiation. Handle both rather than assuming.
 */
function parseRpc(body: string): RpcEnvelope {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as RpcEnvelope;

  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload && payload !== '[DONE]') return JSON.parse(payload) as RpcEnvelope;
  }
  throw new Error('lovable returned an unreadable response envelope');
}

async function waitReachable(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fetch(url, { headers: { 'user-agent': 'foundry-pagegen/1.0' } })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await sleep(5000);
  }
  // Not fatal: QA runs next and will report an unreachable storefront properly.
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const PAGEGEN_IMPLEMENTATIONS: Record<string, () => PagegenProvider> = {
  internal: () => new InternalPagegenProvider(),
  lovable: () => new LovablePagegenProvider(),
};

export function pagegenProvider(name = env.pagegenProvider): PagegenProvider {
  const make = PAGEGEN_IMPLEMENTATIONS[name] ?? PAGEGEN_IMPLEMENTATIONS.internal;
  return make();
}
