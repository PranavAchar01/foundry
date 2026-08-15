## What this changes

<!-- What was wrong, and what it does now. Explain the cause, not just the diff. -->

## Why

<!-- What breaks or stays broken without it. Link the issue if there is one. -->

## How it was verified

<!-- What you actually ran or observed. "Typecheck passes" is not verification
     of behaviour; say what you exercised and what you saw. -->

## Checklist

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] No `any`, `@ts-ignore`, or eslint disable added to silence an error
- [ ] No secret or account-specific identifier added to a tracked file
- [ ] Comments explain why, not what

## Safety properties

Confirm each still holds, or say explicitly which one you changed and why.

- [ ] `ledger_entries`, `decisions`, `machine_runs` and `conversation_messages`
      remain append-only
- [ ] `cohort.isAllowed()` is still re-checked immediately before every follow
      and every DM
- [ ] Building and sending remain separate, deliberate actions
- [ ] The disclosure line still ships verbatim on every generated storefront
- [ ] Nothing in the interface advances on a timer rather than on a real result
