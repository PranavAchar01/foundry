# Contributing to Foundry

Thanks for taking the time. This document covers how to get set up, what the
bar is for a change, and the few conventions that are not obvious from reading
the code.

## Getting set up

**Requirements:** Node 20 or newer, pnpm 11, and a Postgres database.

```bash
pnpm install
cp .env.example .env.local
pnpm migrate
pnpm dev
```

You do not need any sponsor credentials. Every capability has a default that
works with no network, so `POSTGRES_URL` and one model key are enough to run
the whole system. Tests that require live credentials skip cleanly without
them.

## Before you open a pull request

All four of these must pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI runs the same four on every push. A red pipeline will not be reviewed.

## What a good change looks like

**Fix the cause, not the symptom.** If a type does not line up, change the
type. Do not reach for `any`, `@ts-ignore`, or an eslint disable to make an
error go away. If you genuinely need one, say why in a comment.

**No feature flags for your own work.** This codebase changes code rather than
accumulating switches and compatibility shims. The nine capability flags exist
to swap a vendor, not to gate a change.

**No defensive handling of impossible cases.** A check that can never fire is
noise that reads as caution.

**Validate at system boundaries only.** User input and external API responses
get validated. Internal function calls do not.

**Do not fake progress.** A tile is live when its build returns a URL. A
message is sent when the send call says it was sent. Nothing in this interface
advances on a timer, and a change that makes it do so will be rejected.

## Comments

Comments explain *why*, not *what*. The bar is that a comment should tell a
future reader something the code cannot: the tradeoff taken, the failure it
prevents, or the reason an obvious alternative is wrong.

```ts
// Good: names the failure it prevents.
// The reel crosses several rows per frame at speed, so checking only the row
// under the reticle silently skips matches.

// Not useful: restates the line below it.
// Loop over the rows.
```

Match the surrounding prose. This codebase writes plain declarative English in
full sentences, not telegraphic notes.

## Things that are not negotiable

These are safety properties, not preferences. A change that weakens one will be
declined regardless of what else it does.

- **The append-only tables stay append-only.** `ledger_entries`, `decisions`,
  `machine_runs` and `conversation_messages` carry database triggers that raise
  on `UPDATE` and `DELETE`. Do not add a code path that tries to work around
  them, and do not drop a trigger to make a migration easier.
- **Outreach stays gated on the allowlist.** `cohort.isAllowed()` is re-checked
  immediately before every follow and every DM. Not once per run, not at the
  top of the loop, and not cached.
- **Sending stays a deliberate act.** Building and sending are separate calls
  behind separate controls. Do not collapse them.
- **The disclosure line ships verbatim.** Every generated storefront prints it
  as plain visible text. It is checked by QA against the served page.
- **Never commit a secret.** `.env*` is gitignored. Do not paste keys into
  code, comments, tests, fixtures, or documentation, and do not add
  account-specific identifiers to files that are published.

## Commit messages

Write a subject line that says what changed and why it mattered, then a body
that explains what was actually wrong. The history here is meant to be
readable as a record of decisions.

```
The sweep reports what it actually found

Match detection tested only the row under the reticle, so every match the reel
crossed at speed went unrecorded. It now sweeps the crossed range.
```

Avoid subject lines that describe the diff rather than the reason, such as
"update scan.tsx" or "fix bug".

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/PranavAchar01/foundry/issues/new/choose).
For anything security related, do not open an issue. Follow
[SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
