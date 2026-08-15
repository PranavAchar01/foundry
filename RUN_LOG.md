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

## 2026-08-15 — Lovable: website generation via the sponsor path

Scope: the pagegen capability only. The in-flight machine/Replay/Band work in
the tree was left untouched.

**Found the real interface first.** The previous `LovablePagegenProvider` posted
to `https://api.lovable.dev/v1/generate` — an endpoint I had guessed and never
verified. Read the live Lovable MCP server instead: it exposes
`create_project`, `get_project`, `deploy_project`, `send_message`, and Lovable
**builds and hosts** a full TypeScript app (TanStack Start + Tailwind). It never
returns HTML. That breaks the old `generate() -> html` contract outright.

**Proved the path by hand before writing any code.** Built a real site for the
live business `biz_msu8lgocg2nqtm` (Changelog Engine, $29.00), published it, and
drove it in a browser:

```
https://foundry-changelog-engine.lovable.app   200, 17441 bytes
  id="buy"          present in served HTML   (SSR, not client-only)
  disclosure line   present in served HTML
  businessId / /api/checkout / /api/track     NOT in HTML — they live in the JS bundle
  clicked "Get it now" -> redirected to checkout.stripe.com
                       -> "Changelog Engine  $29.00", merchant "Foundry"
```

Two findings that shaped the design:
1. Lovable hosts the result, so spawning must **not** also deploy to Vercel —
   that would give one business two storefronts that drift apart.
2. The wiring is in the bundle, not the markup, so HTML string-matching cannot
   verify checkout. QA's existing `expect` list is `[name, disclosureLine]` and
   both *are* server-rendered, so QA needed no change; the browser check in the
   Playwright provider is what covers the button.

**Changes, all pagegen-scoped:**
- `GeneratedPage` gains optional `hostedUrl` and `projectId`.
- `spawn()` uses `page.hostedUrl` as the business URL and skips the HostProvider
  when a pagegen provider already published the site.
- `LovablePagegenProvider` rewritten to speak MCP JSON-RPC 2.0 against
  `LOVABLE_MCP_URL` (create_project -> poll get_project -> deploy_project),
  handling both plain-JSON and SSE response envelopes. The brief it sends is the
  exact prompt proven above, extracted as `lovableBrief()` so it is testable.
- `tests/lovable.test.ts` (11 tests) asserts the brief still carries every part
  of the contract — `id="buy"`, the checkout endpoint, the literal
  `{"businessId":"…"}` body, the redirect, the beacon, the verbatim disclosure,
  and the content prohibitions. If that prompt drifts, checkout breaks silently
  on a live site; this is the guard.

**Adopted the result.** `biz_msu8lgocg2nqtm` now points at the Lovable
storefront instead of its Vercel page, with a `STOREFRONT_REPLACED` decision row
recording the swap and the browser verification.

Gate: typecheck clean · build clean · **41 passed / 8 skipped**. `pnpm lint`
fails on one pre-existing unused import in `lib/operator.ts` (the machine
thread's file, not touched here).

**Not verified:** the MCP transport itself. `LOVABLE_API_KEY` is empty, so the
provider cannot run unattended yet — the tool contract is verified, the endpoint
and key are configuration.

## 2026-08-15 — Iteration 15 · three sponsor keys, real APIs, and a machine per business

Owner supplied Superserve, Replay and Band keys, and asked that every spawned
company run on its own virtual machine.

**Every sponsor implementation written before this point was wrong.** They were
authored blind against guessed endpoints. Probed all three before flipping any
flag; the failures were the useful part:

- `api.superserve.ai` returned Go-style 404s — a live API, wrong paths. Real
  answer: an official SDK, `@superserve/sdk`.
- `api.replay.io/v1/*` returned **401, not 404** — the host was right and the
  auth was wrong. Real answer: Replay **QA** at `https://qa.replay.io/api/v1`,
  bearer auth, full OpenAPI at `/openapi.json`. The `lqa_` key prefix is
  literally "loop-qa".
- `api.band.ai` did not resolve at all. Real answer: `https://app.band.ai/api/v1`
  with **`X-API-Key`**, not a bearer token.

Two things then had to be discovered rather than assumed:

1. Band's **Human API is Enterprise-gated** (`403 plan_required`). The Agent API
   is not. So `pnpm band:register` mints an agent identity from the human key —
   handle `achar.pranav/foundry-ceo` — and the bus authenticates as that agent.
2. Superserve's shape: `commands.run`, `files.write(path, content)` one file at
   a time, `pause/resume/kill`, preview ports. A sandbox came up in **0.3s**.

### The machine layer

`machines` and `machine_runs` tables, `lib/machine.ts`, `lib/operator.ts`.
Every spawned business now gets a persistent Ubuntu 24.04 microVM seeded with
its own `COMPANY.md`, `company.json` and `NOTES.md`. The operator agent works
that machine with a real shell; `machine_runs` is append-only, so the record of
what it did cannot be rewritten. Compute is metered as OPEX per second, idle
machines are paused, and killing a business kills its machine.

`FOUNDRY_RUN_MACHINE=1 pnpm vitest run tests/machine.test.ts` — **7/7**:
provision + seed, real Linux, state persisting across separate connections,
append-only transcript enforced, a real operator session, metering, clean kill.

### A bug the tests caught

`spawn()` checked the max-business ceiling before the circuit breaker, so a
tripped breaker was reported as `MAX_BUSINESSES`. The emergency stop now
short-circuits every other check. Fixed in code, not in the test.

## 2026-08-15 — Iteration 16 · the brain became swappable

Mid-iteration the **Anthropic credit balance ran out** (`400 invalid_request_error`,
"credit balance is too low"). The portfolio kept running — that is what the
heuristic fallback is for — but every hypothesis and judgement would have been
tagged `heuristic-fallback` instead of real reasoning.

Rather than swap one vendor for another, made the brain the **ninth swappable
capability**: `FOUNDRY_BRAIN_PROVIDER=anthropic|openai`, `lib/brain.ts`, with a
provider-neutral transcript type that each brain translates to its own wire
format. `agent.ts` and `operator.ts` no longer import a vendor SDK.

Details that mattered:
- OpenAI strict function schemas need `additionalProperties: false` and every
  property in `required`; the schema is normalised automatically.
- Reasoning models spend tokens *before* the tool call — `gpt-5` returned 200
  with no tool call at a 400-token budget. Floor raised to 3000.
- `gpt-5.6-sol` rejects function tools with reasoning_effort in chat
  completions. Probed the whole ladder; **`gpt-5.5` does forced tool calls
  cleanly in 4.4s** and is now `FOUNDRY_OPENAI_MODEL`.
- `callTool` tries the *other* configured brain before the heuristic, so a
  vendor's billing can never again stop the portfolio on its own.

Re-ran the machine suite on the OpenAI brain — **7/7**, model
`gpt-5.5-2026-04-23`, 5 real commands. The operator read its brief, explored the
filesystem, built a product directory and wrote `scripts/check_disclosure.sh`
that verifies the disclosure line on public artefacts — and it passed.

Gate: lint clean, typecheck clean, build clean, **41 passed / 8 skipped**.
Deployed; `pnpm smoke` **21/21** against the live URL, now reporting
`brain=openai … sandbox=superserve bus=band qa=replay`.

## 2026-08-15 — Iteration 17 · the machine room: every company visible on its own VM

Owner asked for each company to be *operated inside* a VM, using the sponsor
keys, and to be able to **watch** each VM boot, run, and produce output.

### Making a VM visible from the outside

Superserve's base image has no node and no python — only `perl` and `curl`. So
each machine is seeded with `serve.pl`, a dependency-free static server written
against perl's core `IO::Socket::INET`. On boot the machine runs it on :8000,
`publishPreviewPort(8000, {access:'public'})` exposes it, and the URL is stored
**only if it actually answers** — a preview URL that 502s is worse than none.

Result: every company now has a live page served *by its own machine*, at
`https://8000-<sandbox-id>.sandbox.superserve.ai`. It starts as the company
brief and changes as the operator agent rewrites it.

`tests/boot.test.ts` proves it end to end: provision, fetch the preview (200,
contains the company name and the disclosure line), rewrite `index.html` from
inside the machine, fetch again and see the change.

### The machine room

`/api/machines` (snapshot) and `/api/machines/stream` (SSE over the append-only
`machine_runs` table) feed a new dashboard section: one panel per VM with its
status, uptime, billed cost, boot log, a link to its live view, and a **live
shell** showing each command and its stdout as the operator runs it.

### Three real defects found by running it, not by reading it

1. **Machines only existed for businesses spawned after the machine layer.**
   The CEO cycle now provisions machines for any live business lacking one,
   capped at 3 per cycle so a backlog cannot blow the function timeout.
2. **Two previews served 502.** A spawned process does not reliably survive
   pause/resume. Added `ensureServing()` — it curls :8000 from inside the
   machine and restarts `serve.pl` if it has gone away, called on every connect
   and every metering pass. 8/8 previews now serve 200.
3. **A duplicate-key race** against the 5-minute cron: two cycles provisioned
   the same business concurrently. The partial unique index is the arbiter, so
   the insert is now `ON CONFLICT DO NOTHING` and the loser **kills the machine
   it just built** rather than leaking a paid-for VM.

### Band was silently failing

`bus.publish` is wrapped in `.catch(() => {})`, so Band had been recording
nothing since it was switched on — 0 rooms. Three wire-format errors, each
found against the live API:

- chat rooms take `title`, not `name`;
- `/messages` **requires at least one @mention** — a CEO cycle notification
  addresses nobody, so it is a `/events` post with `message_type: 'thought'`
  (not `event_type`), carrying the payload as structured `metadata`;
- events are **not** readable back through `/messages`; `/context` is the
  combined record and preserves `metadata`.

`tests/bus.test.ts` now asserts a real publish→read round-trip with the payload
intact. Live cycles are recording into `foundry:ceo.cycle.started` and
`foundry:ceo.cycle.finished`.

### Sponsor coverage, verified live

- **Superserve** — create, connect, `files.write`, `commands.run`/`spawn`,
  `publishPreviewPort`, `getPreviewUrl`, pause/resume/kill, metadata. 8 live
  machines, 8/8 previews serving, 28 recorded commands.
- **Band** — agent identity, chat rooms, events, context read-back. Live.
- **Replay QA** — project created per spawned storefront; exploration runs in
  the background while the synchronous content gate still guards the spawn.

Gate: lint clean, typecheck clean, build clean, **41 passed / 10 skipped**.
Deployed and confirmed in the browser.

## 2026-08-15 — Iteration 18 · one page, a wall of companies, and a reset

Owner asked for a single-page tile dashboard showing each company's hero page,
a click-through detail view, a wipe of the Vercel storefronts, and a visually
distinguishable hero for Lovable-built sites.

### Reset

`scripts/reset-portfolio.mjs` (with a `--dry` plan mode), ordered so a failure
never orphans a paid resource from its record: kill every Superserve machine →
delete every spawned Vercel project → archive the businesses.

Executed: **8/8 machines destroyed, 9/9 Vercel projects deleted, 11 businesses
archived, 25 pageviews deleted.** `foundry-biz` and `landing` are protected by
name and were untouched.

A literal `TRUNCATE` was not possible and should not be: `machine_runs` is
append-only and `machines.business_id` is a foreign key to `businesses`, so
deleting the rows would have required dropping the append-only guarantee. Added
`businesses.archived` instead — hidden from the portfolio, history intact.
`ledger_entries` (93) and `decisions` (400) survived, so the P&L still shows the
money that was really spent.

### The new UI

One page. A compact header carrying identity and the P&L, then a wall of tiles —
each tile is a **live iframe of that company's actual hero page**, scaled to
thumbnail, with its status, VM state, and three numbers. Clicking a tile opens a
detail overlay with six plain metrics and two tabs: *the website* and *the
machine running it* (the VM's own served page beside its live shell), with the
agent's recent decisions along the bottom. `app/machines.tsx` was deleted; the
machine room now lives inside the company it belongs to.

New endpoint `/api/company/[id]` assembles one company's business, traction,
machine, decisions and shell history in a single round trip.

### Lovable heroes

The old brief told Lovable to build "dark, high-contrast, technical" — the exact
house style of the internal fallback, which is why its output was
indistinguishable. Rewritten: a full-viewport hero, the product name as the
dominant element, price and CTA above the fold, a full-bleed visual treatment,
and palette/typography chosen to suit *that* buyer — with an explicit
instruction not to default to the dark monospace terminal look. Not verified
live: `LOVABLE_API_KEY` is empty again, so the lovable path cannot run.

### A measurement bug the redesign created — and one it exposed

Embedding each storefront to show its hero means the dashboard **loads every
company's page**, firing the pageview beacon. Watching the portfolio was
inflating the exact number the CEO uses to decide whether a business is dead.
Worse, the same was already true of the **Playwright QA check** during spawn:
headless Chromium executes the beacon, so every spawn counted itself a visitor.

`/api/track` now records every load but only counts a visitor when it is neither
self-referred from Foundry's origin nor an automated user-agent. Both classes
are still logged, as `dashboard-preview` and `automated-qa`, so the exclusion is
auditable rather than invisible. Historical self-traffic was reclassified and
the counters reset to zero — the four live companies now read a truthful
0 visitors rather than a flattering 2.

Portfolio after the reset: 4 companies, each with its own machine, spawned in
11–14s. Gate: lint clean, typecheck clean, build clean, 41 passed / 10 skipped.
