# FOUNDRY

An autonomous holding company. It writes a hypothesis, spawns a business,
deploys it, wires it to checkout, measures real traffic, reads the P&L, and
either allocates more capital or kills it — on a cron, with no human in the
loop.

**Live:** https://foundry-biz-eight.vercel.app

Every business it launches carries a visible disclosure that it is AI-operated.

---

## What actually runs

```
        ┌─────────────── /api/cron/ceo (every 5 min) ───────────────┐
        │                                                           │
   hypothesis ──▶ spawn ──▶ deploy ──▶ traffic ──▶ metrics ──▶ allocate
   (Claude)      (guarded)  (Vercel)   (beacon)   (ledger)     or kill
        │                                                           │
        └──────── every step writes an append-only decision row ────┘
```

- **Brain** — `claude-opus-5` via forced tool calls, so structured output is an
  API guarantee rather than a parse. `lib/agent.ts`
- **Money** — Stripe Checkout on every spawned business, one webhook
  (`we_1U4ZK32Nyz5Xb21P440IBTfO`) posting revenue to a shared ledger.
- **Labor as COGS** — below a confidence threshold the agent *quotes* human
  expertise, prices it against three ceilings, and buys or declines with a
  logged reason. Purchased labor lands in the same ledger as revenue.
- **Guardrails** — per-escalation cap, per-business budget, portfolio ceiling,
  and a circuit breaker latched in Postgres. Nothing spends without passing
  `authorizeSpend`.

## Ledger and decisions are append-only in the database

`ledger_entries` and `decisions` carry a trigger that raises on `UPDATE` and
`DELETE`. A bug in the agent cannot rewrite its own financial or reasoning
history. `scripts/migrate.mjs` proves the trigger is live on every run by
attempting a delete and asserting it is rejected.

## Swappable capabilities

Eight capabilities, each with a no-key default and at least one sponsor path,
selected purely by environment flag. Flipping a flag needs zero code edits;
`tests/providers.test.ts` walks the registry and instantiates every one.

| Capability | Flag | Default | Alternatives |
|---|---|---|---|
| labor | `LABOR_PROVIDER` | `stub` (seeded, no network) | `terac` |
| pagegen | `FOUNDRY_PAGEGEN_PROVIDER` | `internal` | `lovable` |
| checkout | `FOUNDRY_CHECKOUT_PROVIDER` | `stripe` | `whop`, `dodo` |
| sandbox | `FOUNDRY_SANDBOX_PROVIDER` | `vercel` | `sandbox0`, `superserve` |
| bus | `FOUNDRY_BUS_PROVIDER` | `postgres` | `band` |
| support | `FOUNDRY_SUPPORT_PROVIDER` | `resend` | `linq` |
| qa | `FOUNDRY_QA_PROVIDER` | `playwright` | `replay` |
| host | `FOUNDRY_HOST_PROVIDER` | `vercel` | `render` |

Live state: `GET /api/providers`.

## Endpoints

| Route | What it does |
|---|---|
| `GET /` | Dashboard: portfolio cards, running P&L with COGS broken out, live allocation log |
| `POST /api/spawn` | `{"niche": "..."}` → a deployed, checkout-wired business |
| `GET /api/cron/ceo` | One CEO cycle. Vercel Cron calls this every 5 minutes |
| `POST /api/checkout` | Creates a Stripe session for a business (called cross-origin by spawned pages) |
| `POST /api/stripe/webhook` | Verifies the signature, posts revenue to the ledger |
| `POST /api/track` | Pageview beacon from spawned pages — the only source of `visitors` |
| `GET /api/portfolio` | Everything the dashboard renders |
| `GET /api/stream` | SSE feed of the append-only decision log |
| `GET /api/providers` | Capability registry and which implementation is live |
| `GET /api/health` | Per-dependency health, used by the smoke test |
| `POST /api/breaker` | Trip (no secret) or reset (secret required) the circuit breaker |

## Running it

```bash
pnpm install
cp .env.example .env.local   # then fill it
pnpm migrate                 # applies lib/schema.sql, proves append-only
pnpm verify:all              # live preflight against every dependency
pnpm dev
```

Verify, ship, and check:

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm env:push                # push secrets into the Vercel project
pnpm deploy                  # build and deploy to production
pnpm smoke                   # assert real content on the live URL
```

## Stripe activation

The account behind this has `card_payments` **inactive** and
`charges_enabled=false`. Consequences, verified rather than assumed:

- Checkout sessions **create successfully** — but only with
  `payment_method_types: ['card']` passed explicitly. `automatic_payment_methods`
  resolves to an empty set and returns **400**. `pnpm verify:all` demonstrates
  both outcomes on every run.
- A live payment **cannot complete** until the owner finishes activation at
  <https://dashboard.stripe.com/settings/payment_methods>.

Everything up to that line is built and tested, including a full webhook replay
against the real signing secret (`tests/stripe-webhook.test.ts`).

## Go live in one command

```bash
pnpm go-live
```

Runs preflight → migrate → env push → deploy → smoke, stopping at the first
failure. Every step is independently runnable (`pnpm verify:all`, `pnpm
migrate`, `pnpm env:push`, `pnpm deploy`, `pnpm smoke`).
