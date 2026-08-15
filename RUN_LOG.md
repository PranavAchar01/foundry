# RUN_LOG

Append-only record of the FOUNDRY build. Every entry is written by the agent
that did the work, in order, at the time it happened. Nothing below was edited
after the fact.

Cold start: repository containing `.env.local`, `lib/terac.ts`, `landing/`, and
nothing else. No `package.json`, no app, no schema.

---

## 2026-08-14 — Iteration 1 · read the ground truth

- Read `.env.local`. Confirmed: live Stripe keys, Neon URLs, Vercel
  token/team/project, `TERAC_API_KEY` **empty** (so labor defaults to the stub,
  exactly as designed), seven sponsor capability flags already declared.
- Read `lib/terac.ts` (existing Terac v2 client) and `scripts/verify-terac.mjs`.
  Decision: **wire the client as-is**, wrap it in a `LaborProvider`; do not
  rewrite it.
- Confirmed `PranavAchar01/foundry` exists, is private, and is empty.

## 2026-08-14 — Iteration 2 · targets 1 & 2 (scaffold + schema)

- Scaffolded Next.js 15 App Router, TypeScript **strict**, Tailwind v4, pnpm.
- Hit `ERR_PNPM_IGNORED_BUILDS` on pnpm 11; resolved with `allowBuilds` in
  `pnpm-workspace.yaml` (pnpm 11 no longer reads the `pnpm` field in
  `package.json`).
- Wrote `lib/schema.sql`: `businesses`, `hypotheses`, `ledger_entries`,
  `decisions`, `escalations`, `labor_quotes`, plus `visits`, `bus_messages`,
  `circuit_breaker`.
- **Applied to Neon** via `node scripts/migrate.mjs`. Verified, not assumed:
  all 9 tables present, and the append-only trigger proven by issuing a real
  `DELETE` against `ledger_entries` and asserting the database rejected it.

  ```
  PASS  schema applied
  PASS  table businesses … table circuit_breaker   (9/9)
  PASS  ledger_entries is append-only (DELETE rejected by trigger)
  migrate: OK
  ```

## 2026-08-14 — Iteration 3 · live preflight (target 4 groundwork)

Wrote `scripts/verify-all.mjs` and ran it against every external dependency.
Results, all real calls:

- `claude-opus-5` — **live**, resolved to `claude-opus-5`.
- Stripe session with explicit `payment_method_types` — **200**,
  `cs_live_a1BzbeuKwraGnLRyQlIlHwuc6vydmKNieEGlxj8GKzv9PrVqWjnjrMQpkM`.
- Stripe with `automatic_payment_methods` — **400**, confirming the explicit
  list is load-bearing rather than cargo cult.
- Account state — `charges_enabled=false`, `card_payments=inactive`. This is the
  documented activation gap and is **not** a build blocker.
- Webhook `we_1U4ZK32Nyz5Xb21P440IBTfO` → `/api/stripe/webhook`, enabled, with
  all three expected events.
- Vercel project `foundry-biz` reachable.
- `TERAC_API_KEY` empty → labor provider resolves to `stub`. Not blocked.

## 2026-08-14 — Iteration 4 · targets 4, 5, 6, 7, 8 (verified locally)

Built the money path, the labor providers, escalation economics, the guardrails,
and the capability registry. Then verified each with tests that touch the real
database and the real Stripe signing secret.

`pnpm test` — **30/30 passing**:

- `tests/stripe-webhook.test.ts` (7) — replays a **real signed**
  `checkout.session.completed` through the same `verify`+`handle` the deployed
  route runs; asserts the `REVENUE` ledger row, the conversion count, the
  `TESTING`→`SCALING` transition, and the `REVENUE_BOOKED` decision row. Also
  asserts a forged signature is rejected, a tampered payload is rejected, replay
  is idempotent (one row, not two), refunds book negative, and the database
  refuses an `UPDATE` to the ledger.
- `tests/labor-swap.test.ts` (5) — runs the identical escalation through two
  different `LaborProvider` implementations and asserts the resulting ledger
  rows, decision rows, `meta`/`inputs`/`outputs` payloads and quote rows have
  **identical shapes**. Also asserts the stub is genuinely seeded (same input →
  same price) and that `TeracProvider` constructs with no key without throwing.
- `tests/guardrails.test.ts` (10) — per-escalation cap, per-business budget,
  portfolio ceiling, mandatory escalation on irreversible/legally-exposed
  actions, and the headline one: **once the breaker trips, nothing spends** —
  the gate refuses every category, an escalation still quotes but never
  purchases and writes no COGS row, the decline is recorded with its reason, and
  `spawn()` is refused too.
- `tests/providers.test.ts` (8) — walks the registry and instantiates **every
  implementation of all 8 capabilities**; asserts every default needs no sponsor
  key, that the active implementation is chosen purely from the env flag, and
  that the generated page carries the checkout wiring and the disclosure line.

Note on test hygiene: tests run against the **real** Neon database — there is no
second fake one — but only against `is_fixture` businesses, which are excluded
from the portfolio and the P&L. A test run cannot move a number on the
dashboard.

## 2026-08-14 — Iteration 5 · target 1 (ship it)

- `pnpm lint` clean, `pnpm typecheck` clean, `pnpm build` clean.
- Pushed 36 environment variables into the existing `foundry-biz` project via
  the Vercel API. Vercel reserves the `VERCEL_` prefix, so the four deploy
  credentials are additionally written under `FOUNDRY_VERCEL_*` aliases that
  `lib/env.ts` reads as a fallback. Generated a `CRON_SECRET` so
  `/api/cron/ceo` cannot be poked anonymously.
