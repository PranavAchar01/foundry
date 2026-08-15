# Recording the live run

One page, one press, eight businesses. This is what to do and what you will see.

## Before you hit record

```bash
node scripts/preflight-run.mjs
```

It exits non-zero if anything would break the run, and it names what. A green
run tells you the allowlist is resolved, the spawn ceiling has room, the circuit
breaker is open, the budget covers eight spawns, and the X token carries
`follows.write` and `dm.write`.

If the portfolio still has tiles from a previous take:

```bash
node scripts/reset-portfolio.mjs --dry
```

Read the plan, then re-run with `--yes`. It archives the businesses, destroys
their machines, and deletes their Vercel projects. It does **not** delete the
Lovable storefronts — Lovable's MCP has no delete tool, so the script names them
and tells you to remove them in the Lovable dashboard. It also never touches
`ledger_entries`, `decisions`, `machine_runs` or `conversation_messages`: those
are append-only in Postgres, so a reset frees the business-count ceiling but
never rewrites what was actually spent or actually decided.

## The take

Open <https://foundry-biz-eight.vercel.app> and scroll to the run section.

1. **Press `Run it`.** The page glides the run surface to the centre of the
   viewport. `/api/demo/plan` reads the follow graph and writes a different
   product for each person on the allowlist. Roughly **8 seconds**.
2. **The sweep.** The reel runs the real 1,880-account following list under a
   fixed reticle. Accounts that clear the filter flash and lock into the
   shortlist on the right. It settles on the eight, each labelled with evidence
   taken from their own bio. Roughly **4 seconds**.
3. **The builds.** All eight go out at once. Each tile appears as its own build
   returns — a tile reads live only when a URL actually came back. Roughly
   **15–25 seconds** for the set; a single build took 14s measured.
4. **Press `Send the DMs`.** This is a separate button on purpose. The messages
   queue one behind another rather than going out together, because X throttles
   a burst from one account hard enough to lose half of them. Each message
   quotes the site built for that person.

Clicking a tile opens the person, their site, the machine running it, and its
traction on one page.

## What is real

Everything except who is reachable. The clustering, the products, the sites, the
machines, the Stripe wiring and the messages are all live. The one thing narrowed
is the contact list: `lib/cohort.ts` is an allowlist and the send path re-checks
it immediately before every follow and every DM, so a run physically cannot
message someone who did not agree to it.

## If something goes wrong on camera

- **A tile says the build failed.** The run does not stop; the other seven carry
  on. That person is marked skipped and never gets a DM, because a DM quoting a
  site that does not exist is worse than no DM.
- **`Run it` refuses with a ceiling error.** Too many active businesses. Run the
  reset.
- **A DM fails.** The tile says so and names the reason rather than showing a
  green tick. Nothing retries silently.

## Re-recording

The build and the send are separate presses precisely so you can re-shoot the
build without messaging anyone a second time. Reset, press `Run it` again, and
only press `Send the DMs` on the take you intend to keep — a DM cannot be
unsent, and the people on the allowlist are real.
