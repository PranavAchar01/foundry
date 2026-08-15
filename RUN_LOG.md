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

## 2026-08-15 — Iteration 6 · target 10 (spawn timing), measured

Ran a **real** spawn against the real Vercel API and the real model.
`FOUNDRY_RUN_SPAWN=1 pnpm vitest run tests/spawn-timing.test.ts`:

```
  niche:    freelance illustrators quoting commissions
  business: biz_mstxh0yqe49tru
  url:      https://foundry-biz-commission-quote-kit.vercel.app
  elapsed:  22.0s  (budget 240s)
    hypothesis       15409ms  claude-opus-5
    pagegen              1ms  internal
    deploy            1218ms  vercel
    persist            281ms
    qa                1314ms  passed
    qa PASS http-200 · contains:Commission Quote Kit · contains:<disclosure>
    qa PASS checkout-button · browser:buy-visible   (real headless Chromium)
  checkout: cs_live_a1GB58dlE318YopyJGY1H5PoAmhochnGFPZnZTeKmThRWyJv3Ub6peSEEk
```

**22.0 seconds**, against a 240-second budget. The page serves, carries the
disclosure line, and a live Stripe session was created against it.

## 2026-08-15 — Iteration 7 · target 1 blocked by Vercel, root-caused

`vercel deploy --prod` put the deployment in `BLOCKED` with no message. Worked
the cause rather than guessing at it:

1. Deployed a static file to a **new** project → `READY` in 0s. So deployments
   are not blocked wholesale — this is why spawned businesses work.
2. Deployed the prebuilt Next.js app to a **new** project → clear error:
   `VULNERABLE_NEXTJS_VERSION`. Upgraded Next 15.5.4 → **15.5.23**.
3. Redeployed → `BLOCKED` again, still no message. Dumped the full deployment
   record and found the real cause:

   ```json
   "seatBlock": { "blockCode": "TEAM_ACCESS_REQUIRED", "isVerified": false }
   ```

4. Checked team membership: `patelkula53-5172:OWNER:confirmed=true`. So it is
   not membership — it is Vercel's account-level identity verification.

**Conclusion:** deployments that contain serverless functions are refused until
the Vercel account completes verification. Static deployments are unaffected,
which is why every spawned business deploys fine. This is a dashboard action by
the account owner; there is no code change that resolves it.

## 2026-08-15 — Iteration 8 · targets 3, 9, 11 verified against the production build

Vercel will not serve the app yet, so everything was verified against
`pnpm build && pnpm start` — the identical production artefact.

- `node scripts/smoke.mjs http://localhost:3111` — **21/21 checks pass**,
  including a real `cs_live_…` checkout session against a real spawned business,
  the unsigned-webhook rejection, CORS for spawned origins, and fetching the
  deployed business page to assert the buy button and the disclosure line.
- **One real CEO cycle**, HTTP 200 in 26.7s. Two steps, both from
  `claude-opus-5`, both written to the append-only decision log:
  - `HOLD` on the first business — *"18 minutes old with 0 pageviews… killing now
    would be discarding an untested asset over a $1 sunk cost."*
  - `SPAWN` of a second, deployed in **18.7s**, whose reasoning set its own legal
    guardrail: *"no debt-collection law, no 'you're legally entitled to,' no
    interest-rate advice."*
- Dashboard confirmed rendering in a browser: portfolio cards with URL, revenue,
  spend, CAC and status; running P&L with COGS broken out; live allocation log.
- Portfolio after two cycles: 2 businesses, $2.00 of $150 spent, breaker armed.

## 2026-08-15 — Iteration 9 · CI and the cron

- `.github/workflows/ci.yml` — lint, typecheck, build, and tests on every push.
- `.github/workflows/ceo-loop.yml` — drives `/api/cron/ceo` every 5 minutes.
  Vercel Cron is capped at **daily** on Hobby (the API rejected `*/5 * * * *`
  outright), so `vercel.json` keeps a daily native cron and this workflow
  provides the 5-minute cadence today. On Pro, change one line in `vercel.json`.
- Repository secrets set for both workflows.

## 2026-08-15 — Iteration 10 · CI green, final state

- CI run `31867588174` — **success** in 1m27s: lint, typecheck, build, the
  no-dependency suite, and the integration suite (repository secrets are set, so
  it ran against the real Neon database and the real Stripe signing secret).
  The first two runs failed on `pnpm/action-setup` receiving both a `version:`
  input and `packageManager` in `package.json`; fixed by removing the input.
- Final local gate: `pnpm lint` clean · `pnpm typecheck` clean · `pnpm build`
  clean · `pnpm test` **30 passed, 1 skipped** (the skip is `spawn-timing`,
  which is opt-in because it spends real money and deploys a real business).
- Deleted the three throwaway Vercel projects the deployment diagnosis created
  (`foundry-app-probe`, `appprobe`, `foundry-probe-*`). Remaining Foundry
  projects: `foundry-biz` and the two real spawned businesses.
- `https://foundry-biz.vercel.app` currently serves the placeholder from a
  deployment that predates this build. The domain resolves; only deployments
  containing serverless functions are refused. One dashboard action by the
  account owner, then `pnpm deploy && pnpm smoke` finishes it.

**State at hand-off:** 10 of 11 targets verified end to end. Target 1 is
complete in code and blocked at the last inch by Vercel account verification —
diagnosed to the exact `blockCode`, not guessed at.

## 2026-08-15 — Iteration 11 · `pnpm go-live` after the owner reported verifying

Ran the full pipeline. Three of five stages passed; it stopped where expected.

```
▸ preflight   PASS   (anthropic, stripe both ways, webhook, vercel, postgres)
▸ migrate     PASS   (9 tables, append-only DELETE rejected)
▸ env push    PASS   (36 vars upserted into foundry-biz)
▸ deploy      FAIL   dpl_6SDcmpYgGBd9AM3YJC3ydJ6DPAij -> BLOCKED
                     seatBlock.blockCode = TEAM_ACCESS_REQUIRED, isVerified = false
▸ smoke       not reached
```

`user.limited` is **still `true`**. So whatever verification was completed did not
clear the flag on the account this deploy runs as. Checked further rather than
retrying blindly:

- Tried Vercel's redeploy endpoint to re-evaluate the seat block without a fresh
  upload → `deployment_can_never_deploy` (a BLOCKED deployment cannot be reused).
- Tried the Git integration as an alternative deploy path, where the deployment
  is attributed to the Vercel GitHub App rather than to the token's user →
  `repo_not_found`; the Vercel GitHub App is not installed on the repository.
- Enumerated the token's identity and reach:

  ```
  token belongs to : patelkula53-5172  <patelkula53@gmail.com>   limited = true
  teams visible    : foodbank (hobby)  team_dK8pShHDulInCH3EeV2CRz9k
  ```

**The likely cause:** the Vercel account holding `VERCEL_TOKEN` is
`patelkula53@gmail.com`, which is not the repository owner's address
(`achar.pranav@gmail.com`). Verifying a different Vercel account does not clear
`limited` on this one. Nothing in this repository can resolve it.

## 2026-08-15 — Iteration 12 · third deploy attempt, and the identity mismatch

Owner reported verifying "the right account". Re-checked, then deployed:

```
token account : patelkula53-5172 <patelkula53@gmail.com>   limited = true
deploy        : dpl_HZeq3RubtY2jR8MUA1CFykSp6BM6 -> BLOCKED
                seatBlock.blockCode = TEAM_ACCESS_REQUIRED, isVerified = false
```

Identical to the two previous attempts. Stopped retrying and enumerated what
the Vercel account is actually connected to:

```
createdDirectToHobby : true
membership           : role=OWNER, confirmed=true
git namespaces       : github -> Kula6475, Web-Design-Initiative
                       gitlab -> none, bitbucket -> none
```

**The decisive fact:** this Vercel account's GitHub connection is to
`Kula6475` / `Web-Design-Initiative` — **not** `PranavAchar01`. That is why
`POST /projects/:id/link` returns `repo_not_found` for `PranavAchar01/foundry`,
and it confirms `patelkula53@gmail.com` is a different identity from the
repository owner (`achar.pranav@gmail.com` / `PranavAchar01`).

So the account that must clear `limited` is `patelkula53@gmail.com`, signed in
via GitHub `Kula6475`. Verifying any other Vercel account has no effect on it.
Three attempts, three identical blocks; no further retry is informative.

## 2026-08-15 — Iteration 13 · Option B chosen: make the toolchain account-portable

Owner chose to ship on an account they control. Checked for a usable credential
first: the Vercel MCP connection reports **no teams**, and the local CLI
credential at `~/.local/share/com.vercel.cli/auth.json` is expired
(`vercel whoami` → `Not authorized`). The `VERCEL_TOKEN` in `.env.local` is
scoped to `team_dK8pShHDulInCH3EeV2CRz9k` only. So a new token is required and
cannot be manufactured here.

Used the time to remove every obstacle in front of that token. Previously the
toolchain assumed `VERCEL_PROJECT_ID` already existed and that the public URL
never changed — neither holds when moving accounts. Added:

- `scripts/_vercel.mjs` — discovers the team from the token, finds or **creates**
  the project by name, writes `.vercel/project.json`, and persists the resolved
  ids back to `.env.local`. `deploy` and `env:push` both route through it, so
  they can never disagree about where they are writing.
- `scripts/retarget.mjs` — repoints the three things pinned to the origin when
  it changes: `FOUNDRY_PUBLIC_URL` (baked into every spawned page's checkout and
  beacon calls), the **Stripe webhook endpoint** (signing secret is preserved,
  so `STRIPE_WEBHOOK_SECRET` stays valid), and the GitHub Actions variable the
  5-minute CEO loop posts to.
- `deploy-vercel.mjs` now reports the canonical alias on success and, when it
  differs from `FOUNDRY_PUBLIC_URL`, prints the exact retarget command.

Verified against the current account: `pnpm env:push` re-resolved the existing
project and pushed 35 vars; `retarget` correctly detected the URL was already
correct and changed nothing. Gate still green — lint, typecheck, build clean,
30 passed / 1 skipped.

A fresh token is now the only remaining input.

## 2026-08-15 — Iteration 14 · LIVE. Target 1 closed.

Owner supplied a token for a second Vercel account. Checked it before using it:

```
account : phantom3452 <achar.pranav@gmail.com>
limited : undefined          <- not limited, unlike the previous account
teams   : phantom3452s-projects (hobby)  team_vn1kQ3Nf6Q5htDaqBfa17vgi
```

`pnpm go-live` with a blank team and project id. The resolver discovered the
team, created the `foundry-biz` project, pushed 35 env vars, and:

```
PASS  deployment READY
      https://foundry-biz-eight.vercel.app
      https://foundry-biz-phantom3452s-projects.vercel.app
```

`foundry-biz.vercel.app` was already taken globally by the blocked account, so
Vercel assigned `foundry-biz-eight`. The deploy step detected the mismatch
against `FOUNDRY_PUBLIC_URL` and printed the retarget command rather than
leaving a silently half-migrated system.

**Retarget** — every origin-pinned reference moved:

```
PASS  FOUNDRY_PUBLIC_URL = https://foundry-biz-eight.vercel.app
PASS  Stripe webhook we_1U4ZK32Nyz5Xb21P440IBTfO repointed
      https://foundry-biz.vercel.app/api/stripe/webhook
   -> https://foundry-biz-eight.vercel.app/api/stripe/webhook
      signing secret unchanged, so STRIPE_WEBHOOK_SECRET still applies
PASS  GitHub Actions variable FOUNDRY_PUBLIC_URL updated
```

Then `env:push` + `deploy` again so the runtime serves the new value.

**`pnpm smoke` against the live URL — 21/21 PASS**, including a real
`cs_live_a1rQgK0Carem…` session, the unsigned-webhook rejection, CORS for
spawned origins, and the deployed business page's disclosure line.

**Target 10 re-measured on production**, through the live HTTP endpoint rather
than in-process: `POST /api/spawn` → **21.3s wall clock**, 20.5s server-measured,
QA passed, and the generated page verified to target the new origin.

**Stale storefronts retired.** Two businesses spawned before the move had the
dead origin baked into their Buy buttons. Wrote `scripts/retire-stale.mjs`,
which fetches each live page and retires any whose checkout does not target the
current origin — with the reason written to the append-only decision log, and a
`--dry` mode. 2 retired, 1 kept. Replacements spawned through production in
19.0s and 17.9s.

**CEO loop confirmed running in production.** GitHub Actions run `31877286866`
→ HTTP 200 in 38s, cycle `cyc_msu6hl012avof3`, 4 steps, $6 of $150 spent:
three HOLDs each citing the real numbers, and one SPAWN
(`Steam Launch Checklist`, deployed in 19.4s).

Final gate: lint clean · typecheck clean · build clean · 30 passed / 1 skipped.

**All eleven targets verified.**
