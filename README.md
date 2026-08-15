<div align="center">

# FOUNDRY

**An autonomous holding company.**

It reads a real audience, writes a different business for each person in it,
builds and deploys every storefront, gives each one its own machine, posts the
human work behind it to a labor marketplace, and reaches out. On a schedule,
with no human in the loop.

[![CI](https://github.com/PranavAchar01/foundry/actions/workflows/ci.yml/badge.svg)](https://github.com/PranavAchar01/foundry/actions/workflows/ci.yml)
[![CEO loop](https://github.com/PranavAchar01/foundry/actions/workflows/ceo-loop.yml/badge.svg)](https://github.com/PranavAchar01/foundry/actions/workflows/ceo-loop.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)

[**Live dashboard**](https://foundry-biz-eight.vercel.app) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md) ·
[Changelog](CHANGELOG.md)

</div>

---

> Every business Foundry launches carries a visible disclosure that it is
> AI-operated. Every outbound message is gated on a recorded allowlist. Neither
> is optional, and neither can be turned off by a flag.

## Contents

- [What it does](#what-it-does)
- [The two loops](#the-two-loops)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Swappable capabilities](#swappable-capabilities)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [API](#api)
- [Testing](#testing)
- [Deployment](#deployment)
- [Project layout](#project-layout)
- [License](#license)

## What it does

Foundry is a holding company with no employees. Given an audience, it decides
what to sell, builds the thing that sells it, arranges the human labor that
fulfils it, and books the result to a ledger it is not able to rewrite.

The unit of work is one person. Foundry reads what someone publicly says they
do, derives a recurring product priced at or under $5 a month, builds a
storefront designed specifically for that trade, provisions a machine to operate
it, posts the monthly work to a labor marketplace, and prepares an opening
message. Sending that message is a separate, deliberate act.

## The two loops

**The client run** turns an audience into businesses. The client drives it stage
by stage, so one slow build holds up only its own tile.

```
POST /api/demo/plan     read the follow graph, pick the reachable people,
                        derive one product per person from their own bio
        │
        ▼
POST /api/demo/build    per person, in parallel:
                        spawn ─▶ author page ─▶ deploy ─▶ QA ─▶ machine
                                              └─▶ post the labor listing
        │
        ▼
POST /api/demo/reach    follow, DM, open a conversation the agent then works
                        (a separate press: sending is never automatic)
```

**The CEO loop** runs the portfolio it created, on a cron.

```
metrics ─▶ read the ledger ─▶ allocate more capital or kill ─▶ work the inbox
   ▲                                                                │
   └────────── every step writes an append-only decision row ───────┘
```

## Design decisions worth knowing

**The ledger cannot be rewritten.** `ledger_entries`, `decisions`,
`machine_runs` and `conversation_messages` carry a database trigger that raises
on `UPDATE` and `DELETE`. A bug in the agent cannot revise its own financial or
reasoning history. `scripts/migrate.mjs` proves the trigger is live on every run
by attempting a delete and asserting that it is rejected.

**Design is dealt before the model is asked.** Eight storefronts built in the
same minute and shown side by side will converge on one layout if a model is
simply asked to be distinctive. `lib/providers/poster.ts` deals each page an
archetype, palette, type pairing, motif, ratio, angle and motion, keyed on the
business slug, before the page is written. Distinctness is a property of the
code rather than a hope about sampling temperature. The result is checked
against a machine-readable gate and given exactly one repair attempt before a
deterministic template ships instead.

**Outreach is gated on an allowlist.** `lib/cohort.ts` is checked immediately
before every follow and every DM, not once at the top of the run. The send path
physically cannot message an account that is not recorded in it.

**Labor is listed, not silently purchased.** Each product posts a draft
opportunity: really created, really priced, visible on the marketplace
dashboard, recruiting nobody until it is launched. A dashboard reporting hires
that had not been paid for would be false, so it reports listings.

**A deal is closed by money, not by the agent.** The sales agent can work a
conversation to `CLOSING`. Only the Stripe webhook can mark it `WON`.

## Swappable capabilities

Nine capabilities, each with a no-key default and at least one alternative,
selected purely by environment flag. Flipping a flag requires zero code edits;
`tests/providers.test.ts` walks the registry and instantiates every one.

| Capability | Flag | Default | Alternatives |
| --- | --- | --- | --- |
| brain | `FOUNDRY_BRAIN_PROVIDER` | whichever key is present | `anthropic`, `openai` |
| labor | `LABOR_PROVIDER` | `terac` when keyed, else `stub` | `terac`, `stub` |
| pagegen | `FOUNDRY_PAGEGEN_PROVIDER` | `internal` | `lovable` |
| checkout | `FOUNDRY_CHECKOUT_PROVIDER` | `stripe` | `whop`, `dodo` |
| sandbox | `FOUNDRY_SANDBOX_PROVIDER` | `vercel` | `sandbox0`, `superserve` |
| bus | `FOUNDRY_BUS_PROVIDER` | `postgres` | `band` |
| support | `FOUNDRY_SUPPORT_PROVIDER` | `resend` | `linq` |
| qa | `FOUNDRY_QA_PROVIDER` | `playwright` | `replay` |
| host | `FOUNDRY_HOST_PROVIDER` | `vercel` | `render` |

Two of these select themselves: `brain` and `labor` pick the vendor whose key
is present, and fall back to the offline default when none is. Setting the flag
explicitly overrides that.

Which implementation is live right now: `GET /api/providers`.

## Quick start

**Requirements:** Node 20 or newer, pnpm 11, and a Postgres database.

```bash
git clone https://github.com/PranavAchar01/foundry.git
cd foundry
pnpm install
cp .env.example .env.local
```

Fill in `.env.local`, then:

```bash
pnpm migrate      # applies lib/schema.sql and proves the append-only triggers
pnpm dev          # http://localhost:3000
```

Foundry runs with no sponsor keys at all. Every capability falls back to a
default that needs no network, so `POSTGRES_URL` plus one model key is enough to
see the whole system work end to end.

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that
change behaviour rather than supply credentials:

| Variable | Default | What it controls |
| --- | --- | --- |
| `FOUNDRY_MAX_BUSINESSES` | `8` | Portfolio ceiling. `spawn` refuses past it. |
| `FOUNDRY_TOTAL_BUDGET_USD` | `150` | Hard spend ceiling across everything. |
| `FOUNDRY_PER_BUSINESS_BUDGET_USD` | `25` | Per-business spend ceiling. |
| `FOUNDRY_MAX_PRICE_CENTS` | `500` | Price ceiling. Products are subscriptions. |
| `FOUNDRY_CIRCUIT_BREAKER` | `true` | Master stop, latched in Postgres. |
| `FOUNDRY_DISCLOSURE_LINE` | required | Printed verbatim on every storefront. |
| `TERAC_MAX_SPEND_USD` | `40` | Ceiling on a single labor purchase. |
| `FOUNDRY_LABOR_PAYOUT_SHARE` | `0.75` | Share of price budgeted for the human. |

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Local development server |
| `pnpm lint` / `pnpm typecheck` | ESLint and `tsc --noEmit` |
| `pnpm test` | Vitest suite |
| `pnpm build` | Production build |
| `pnpm migrate` | Apply the schema, assert append-only is live |
| `pnpm verify:all` | Live preflight against every configured dependency |
| `pnpm env:push` | Push local env into the Vercel project |
| `pnpm deploy` | Build and deploy to production |
| `pnpm smoke` | Assert real content on the live URL |
| `pnpm go-live` | preflight, migrate, env push, deploy, smoke, in order |

Operational scripts live in [`scripts/`](scripts) and are individually
runnable, including `preflight-run.mjs` (readiness check before a live run) and
`reset-portfolio.mjs` (tear the portfolio down; append-only history survives).

## API

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Dashboard: tiles, running P&L, live decision log |
| `/api/demo/plan` | POST | Read the audience, derive one product per person |
| `/api/demo/build` | POST | Build one person's business and list its labor |
| `/api/demo/reach` | POST | Follow, DM, and open the conversation |
| `/api/spawn` | POST | `{"niche": "..."}` to a deployed, checkout-wired business |
| `/api/cron/ceo` | GET | One CEO cycle |
| `/api/checkout` | POST | Create a Stripe session (called cross-origin by storefronts) |
| `/api/stripe/webhook` | POST | Verify signature, post revenue, close the deal |
| `/api/track` | POST | Pageview beacon, the only source of `visitors` |
| `/api/conversations` | GET, POST | Read transcripts; pull and answer inbound DMs |
| `/api/portfolio` | GET | Everything the dashboard renders |
| `/api/machines` | GET | Machines and their state |
| `/api/providers` | GET | Capability registry and what is live |
| `/api/health` | GET | Per-dependency health |
| `/api/breaker` | POST | Trip the circuit breaker, or reset it with the secret |

## Testing

```bash
pnpm test
```

43 tests across 9 files. Tests that require live credentials skip cleanly
without them, so the suite is green on a fresh clone. Coverage is deliberately
concentrated on the parts where being wrong is expensive: the guardrails, the
append-only triggers, provider swapping, spawn timing, and a full Stripe webhook
replay against a real signing secret.

## Deployment

Vercel is the reference target and the only one wired end to end.

```bash
pnpm env:push
pnpm deploy
pnpm smoke
```

`pnpm go-live` chains preflight, migration, env push, deploy and smoke, stopping
at the first failure.

## Project layout

```
app/            Next.js App Router: dashboard, run UI, and every API route
  api/demo/     plan, build, reach — the per-person client run
lib/            The system itself
  spawn.ts        hypothesis to deployed, checkout-wired business
  personal.ts     one person's bio to one product
  providers/      the nine swappable capabilities
    poster.ts     the art-direction deck dealt before a page is written
  guardrails.ts   budgets, ceilings, circuit breaker
  conversation.ts the sales agent that works a deal to close
  schema.sql      schema, including the append-only triggers
scripts/        migration, verification, deployment, reset, preflight
tests/          Vitest
docs/           Architecture and operations
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please read
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first, and report vulnerabilities
privately per [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Pranav Achar
