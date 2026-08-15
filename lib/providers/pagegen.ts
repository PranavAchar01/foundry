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
  :root{--bg:#08090b;--panel:#0e1014;--line:#1e2228;--fg:#e8eaed;--muted:#8b929c;--acc:#4ade80;--acc-dim:#166534}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--fg);line-height:1.6;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;
    background:radial-gradient(900px 500px at 50% -10%,rgba(74,222,128,.08),transparent 70%)}
  .wrap{max-width:720px;margin:0 auto;padding:72px 24px 96px;position:relative}
  .eyebrow{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;
    text-transform:uppercase;color:var(--acc);margin-bottom:20px}
  h1{font-size:clamp(32px,6vw,52px);line-height:1.08;letter-spacing:-.02em;margin-bottom:18px}
  .tagline{font-size:19px;color:var(--muted);margin-bottom:40px;max-width:56ch}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px}
  .price{font:700 40px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.02em}
  .price span{font-size:15px;color:var(--muted);font-weight:400;margin-left:8px}
  ul{list-style:none;margin:22px 0 26px}
  li{padding-left:26px;position:relative;margin-bottom:10px;color:#c8cdd4}
  li::before{content:"→";position:absolute;left:0;color:var(--acc)}
  button{width:100%;background:var(--acc);color:#04140a;border:0;border-radius:10px;
    padding:15px 22px;font-size:16px;font-weight:650;cursor:pointer;transition:filter .15s}
  button:hover{filter:brightness(1.08)}
  button:disabled{opacity:.6;cursor:progress}
  .who{margin-top:44px;padding-top:26px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
  .disclosure{margin-top:14px;font:400 12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
    color:#6f7681;border-left:2px solid var(--acc-dim);padding-left:12px}
  .err{margin-top:14px;color:#f87171;font-size:14px;min-height:20px}
</style>
</head>
<body>
  <main class="wrap">
    <div class="eyebrow">${esc(spec.niche)}</div>
    <h1>${esc(spec.name)}</h1>
    <p class="tagline">${esc(spec.tagline)}</p>

    <section class="card">
      <div class="price">$${price}<span>one-time</span></div>
      <ul>
        ${bullets}
      </ul>
      <button id="buy" type="button">Get it now</button>
      <div class="err" id="err" role="alert"></div>
    </section>

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
 * Sponsor path: lovable.dev generates the landing page. Falls back to the
 * internal template only if the remote call fails — a spawn must not die
 * because a sponsor API had a bad minute.
 */
export class LovablePagegenProvider implements PagegenProvider {
  readonly info = {
    capability: 'pagegen',
    name: 'lovable',
    configured: Boolean(env.lovableApiKey),
    requires: ['LOVABLE_API_KEY'],
  };

  constructor(private readonly apiKey = env.lovableApiKey) {}

  async generate(spec: PageSpec): Promise<GeneratedPage> {
    if (!this.apiKey) throw new Error('LOVABLE_API_KEY is not set');

    const prompt = [
      `Build a single-file HTML landing page for "${spec.name}" (${spec.niche}).`,
      `Tagline: ${spec.tagline}`,
      `Offer: ${spec.offer} for ${spec.targetCustomer}, priced at $${(spec.priceCents / 100).toFixed(2)}.`,
      `The primary CTA button must have id="buy" and POST {"businessId":"${spec.businessId}"} to ${spec.checkoutEndpoint}, then redirect to the returned "url".`,
      `On load, POST {"businessId":"${spec.businessId}"} to ${spec.beaconEndpoint}.`,
      `Include this disclosure verbatim in the footer: ${spec.disclosure}`,
      'Return only HTML.',
    ].join('\n');

    const res = await fetch('https://api.lovable.dev/v1/generate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt, format: 'html', project: spec.slug }),
    });

    if (!res.ok) {
      throw new Error(`lovable generate failed: ${res.status} ${await res.text().catch(() => '')}`);
    }

    const json = (await res.json()) as { html?: string; output?: string };
    const html = json.html ?? json.output;
    if (!html || !html.includes(spec.businessId)) {
      // A page that lost the business id cannot be wired to checkout. Reject it.
      throw new Error('lovable returned a page without the checkout wiring');
    }
    return { html, provider: 'lovable' };
  }
}

export const PAGEGEN_IMPLEMENTATIONS: Record<string, () => PagegenProvider> = {
  internal: () => new InternalPagegenProvider(),
  lovable: () => new LovablePagegenProvider(),
};

export function pagegenProvider(name = env.pagegenProvider): PagegenProvider {
  const make = PAGEGEN_IMPLEMENTATIONS[name] ?? PAGEGEN_IMPLEMENTATIONS.internal;
  return make();
}
