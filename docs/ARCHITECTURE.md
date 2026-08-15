# Architecture

How Foundry is put together, and why it is put together that way. For what it
does and how to run it, see the [README](../README.md).

## Contents

- [The shape of the system](#the-shape-of-the-system)
- [The client run](#the-client-run)
- [Spawn](#spawn)
- [Storefront generation](#storefront-generation)
- [Guardrails](#guardrails)
- [The ledger](#the-ledger)
- [Outreach and conversations](#outreach-and-conversations)
- [Labor](#labor)
- [Machines](#machines)
- [The capability registry](#the-capability-registry)
- [Data model](#data-model)
- [Failure behaviour](#failure-behaviour)

## The shape of the system

Foundry is a single Next.js application. There is no separate worker, queue
service, or agent runtime. Everything is a route, a library module, or a script,
and state lives in Postgres.

That is a deliberate constraint. An autonomous system that spends money is
easier to reason about when every action it can take is an HTTP handler you can
read, call by hand, and see in a log.

```
app/api/        every action the system can take
lib/            the system's actual logic
lib/providers/  the nine vendor-swappable capabilities
scripts/        operations run by a human, never by the agent
```

## The client run

The run is split into three endpoints, driven by the client rather than by one
long server call.

| Stage | Route | Work |
| --- | --- | --- |
| Plan | `POST /api/demo/plan` | Read the follow graph, select reachable people, derive one product per person from their own bio |
| Build | `POST /api/demo/build` | Per person: spawn, author, deploy, QA, machine, labor listing |
| Reach | `POST /api/demo/reach` | Follow, DM, open the conversation |

Three reasons for the split:

1. **Request ceilings.** A single call doing all of it exceeds the platform's
   maximum duration. Split, each call is comfortably inside it.
2. **Progressive results.** Builds run in parallel, one request each, so a tile
   appears the moment its own build lands rather than all of them arriving at
   the end.
3. **Sending is a separate act.** Reach is its own endpoint behind its own
   control. Building cannot cause a message to be sent.

`build` is idempotent per `(runId, username)`. A retry or a double click returns
the business already built rather than spawning a second one on a second URL.

## Spawn

`lib/spawn.ts` takes a niche or an explicit hypothesis and returns a deployed,
checkout-wired business.

```
guardrails ─▶ hypothesis ─▶ page ─▶ deploy ─▶ QA ─▶ machine ─▶ ledger
```

Ordering that matters:

- **Guardrails are checked first**, and the circuit breaker before the ceilings,
  so a tripped breaker reports itself as the reason rather than whichever limit
  happens to be nearest.
- **A pagegen provider may publish its own site.** When it returns a hosted URL,
  spawn skips the host provider rather than deploying a second, divergent copy
  of the same storefront.
- **The machine is best-effort.** A business without a machine is still a
  business, so a provisioning failure is recorded and the spawn proceeds.

## Storefront generation

The problem is sameness. Eight pages built in the same minute and shown side by
side as tiles will converge on one layout if a model is simply asked to be
distinctive, because that is what a model does.

So the look is decided in TypeScript before the model is called.
`lib/providers/poster.ts` deals six axes plus motion, each hashed separately
from the business slug:

| Axis | Purpose |
| --- | --- |
| Archetype | The skeleton. The only axis that changes the tile's silhouette. |
| Palette | The fastest identifier at thumbnail size. |
| Type pairing | Display and text faces. |
| Motif | An ornament used at two scales, which is what reads as a system. |
| Ratio | One modular scale, so sizes are steps rather than noise. |
| Angle | One angle everywhere, so it reads as a decision. |
| Motion | One load-time move, matched to the archetype. |

Each axis is salted with its own name. A single hash divided seven ways
correlates the axes, so two pages colliding on archetype would then also collide
on palette, and a doubled collision reads twice as loudly in a grid.

The deal is keyed on the slug rather than anything time-varying, so rebuilding a
broken storefront reproduces the same design instead of silently turning it into
a different-looking company while its URL sits in someone's inbox.

The returned document goes through `posterViolations`, a machine-readable gate
covering the things the rest of the system depends on: the checkout button's
id, the verbatim disclosure, no script tag, no external request, no invented
social proof, an animation that completes and holds. One repair attempt is
allowed. A second failure ships the deterministic template, because a plain page
is a worse tile but a page that fails the gate is a broken storefront.

The checkout and beacon script is appended after the gate runs, not before. The
gate rejects a page that wrote its own script, so appending first would fail
every page.

## Guardrails

Four independent limits, checked in `lib/guardrails.ts`. Nothing spends without
passing `authorizeSpend`.

| Guard | Scope |
| --- | --- |
| Circuit breaker | Master stop, latched in Postgres. Survives a restart. |
| Total budget | Every dollar across the whole system. |
| Per-business budget | One business's lifetime spend. |
| Portfolio ceiling | How many businesses may be live at once. |

The breaker is latched in the database rather than held in memory on purpose: a
process that has decided to stop spending must still be stopped after it
restarts.

## The ledger

`ledger_entries`, `decisions`, `machine_runs` and `conversation_messages` carry
a trigger that raises on `UPDATE` and `DELETE`.

This is the property the whole system rests on. Foundry decides how to spend
money based on what it previously spent and previously concluded. If a bug could
rewrite that history, no number it reports would mean anything. Enforcing it in
the database rather than in application code means it holds even for a query
written by a future contributor who has not read this document.

`scripts/migrate.mjs` proves the trigger is live on every run by attempting a
delete and asserting that it is rejected. The probe row it writes stays in the
ledger, which is the point.

A portfolio reset therefore archives businesses rather than deleting them, and
committed spend stays on the P&L. A reset frees the business-count ceiling. It
never frees the budget.

## Outreach and conversations

`lib/cohort.ts` is an allowlist. The send path cannot message an account that is
not recorded in it, and `isAllowed()` is re-checked immediately before every
follow and every DM rather than once at the top of a run.

`lib/conversation.ts` is the agent that works a reply to a close. Three
properties bound it:

1. Terminal states (`WON`, `LOST`, `HANDED_OFF`) are never messaged into.
2. `agent_turns` caps how many times it will reply.
3. **A reply is only ever generated in response to an inbound message**, so
   silence ends the conversation rather than triggering a follow-up.

Only the Stripe webhook marks a conversation `WON`. The agent can talk a
conversation to `CLOSING`; money arriving is what closes it.

## Labor

A subscription that owes its buyer expert work each month is not really live
until that work is posted. `postListing` in `lib/hiring.ts` creates a draft
opportunity on the labor marketplace at the moment the storefront exists.

A draft is really created and really priced, but recruits nobody and charges
nothing until it is launched. That is the honest option at eight per run:
launching all of them would commit several times the account balance, and a
dashboard reporting hires it had not paid for would be false.

`hireForSegment` is the other path. It quotes, checks the economics against the
budget, and spends. Both write the same `labor_listings` row, so the P&L reads
one table whichever way the work was posted.

The economics are amortised. A $5 product cannot fund a $40 expert from one
sale, but an expert review is a one-off cost every subscriber receives, so the
budget is `price × payoutShare × subscriberTarget`.

## Machines

Each business gets a persistent microVM. Provisioning races are resolved with
`ON CONFLICT DO NOTHING`, and the loser's VM is destroyed rather than left
running and unreferenced.

Processes are detached with `setsid nohup`, because a process spawned through
the SDK connection dies with it and leaves the preview port returning errors.

## The capability registry

Nine capabilities, each an interface with a no-key default and at least one
alternative, selected by environment flag. `tests/providers.test.ts` walks the
registry and instantiates every implementation, and `tests/labor-swap.test.ts`
proves a vendor swap needs no code edit.

The default path always works offline. That is what makes the system runnable
from a fresh clone, and it means a sponsor outage degrades one capability rather
than stopping the company.

## Data model

Selected tables. Full schema in [`lib/schema.sql`](../lib/schema.sql).

| Table | Holds | Append-only |
| --- | --- | --- |
| `businesses` | The portfolio, including the person a business was built for | No |
| `ledger_entries` | Every dollar in and out | **Yes** |
| `decisions` | Every decision, with reasoning and inputs | **Yes** |
| `machine_runs` | Command history on each VM | **Yes** |
| `conversation_messages` | The transcript of every conversation | **Yes** |
| `conversations` | Sales state per person | No |
| `consent_cohort` | The outreach allowlist | No |
| `audience_members` | The follow graph, and the scan's source | No |
| `audience_segments` | Clustered markets | No |
| `labor_listings` | Work posted to the marketplace | No |

## Failure behaviour

The general rule: a failure in something that makes a business *better* must not
destroy a business that already exists.

| Failure | Result |
| --- | --- |
| Model unavailable during page authoring | Deterministic template ships |
| Page fails the gate twice | Deterministic template ships |
| Machine provisioning fails | Business lives without a machine, recorded |
| Labor marketplace refuses | Storefront stays live, listing recorded as declined |
| One build fails in a parallel run | Only that tile fails |
| Budget or ceiling exceeded | Spawn refuses, with the specific guard named |
| Circuit breaker latched | Everything refuses, breaker named as the reason |
