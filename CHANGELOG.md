# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does not yet publish versioned releases; everything below has
landed on `main`.

## [Unreleased]

### Added

- **One business per person.** The run now derives a product from each
  individual's own public bio and builds a separate business for each, rather
  than picking one audience segment and building a single storefront for it.
  Split across `POST /api/demo/plan`, `POST /api/demo/build` and
  `POST /api/demo/reach` so builds run in parallel and results appear as they
  land.
- **Art-directed storefronts.** `lib/providers/poster.ts` deals each page an
  archetype, palette, type pairing, motif, ratio, angle and motion before the
  model is called, keyed on the business slug. Pages are checked against a
  machine-readable gate with one repair attempt.
- **A load animation per storefront**, matched to the page's dealt archetype
  and wrapped in a reduced-motion guard.
- **Labor listings at build time.** Every product posts a draft opportunity to
  the marketplace the moment its storefront exists: really created and really
  priced, recruiting nobody until launched.
- **A sales agent** that answers inbound replies until a conversation closes,
  bounded by a turn cap, terminal states, and the rule that it only ever
  replies to something inbound.
- **`scripts/preflight-run.mjs`**, a readiness check covering the database,
  schema, append-only triggers, allowlist, spawn ceiling, breaker, budget and
  every configured credential.
- Project documentation: architecture guide, contribution guide, security
  policy, code of conduct, issue and pull request templates.

### Changed

- **Sending is a separate act.** Building the businesses and sending the
  messages are now distinct calls behind distinct controls.
- **Products are recurring** and capped at $5 per month. Labor economics are
  amortised across a subscriber target rather than tested against a single
  sale, which had declined every worthwhile hire.
- The audience clustering now records which members actually landed in each
  segment, so `member_count` is a count rather than the model's estimate.

### Fixed

- **The checkout script was never appended to authored pages.** The brief told
  the model a script would be added for it and rejected pages that wrote their
  own, and nothing added one. Every authored storefront would have shipped a
  dead buy button and no pageview.
- **The art-direction deck was never called.** `pagegen` still shipped the
  deterministic template, so every storefront was the same page with different
  words.
- **`build/` was unanchored in `.gitignore`**, matching a directory of that
  name at any depth, which silently kept `app/api/demo/build` out of git and
  out of every deploy.
- **Labor listings failed on every build.** The marketplace rejects a timeline
  under 72 hours and the provider sent 2, which surfaced as an economics
  decision rather than a malformed request.
- **The network sweep undercounted its own matches**, testing only the row
  under the reticle while crossing several rows per frame.
- **The sweep re-rendered its whole list every frame**, despite a comment
  claiming otherwise, starving the main thread.
- **Shortlist labels leaked demo scaffolding** instead of showing the evidence
  the clustering actually keyed on.
- **The follow graph was truncated** at 600 of 1,880 accounts.
- Self-inflicted traffic from dashboard previews and automated QA no longer
  counts toward the visitor numbers that drive kill decisions.
