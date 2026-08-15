# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through
[GitHub Security Advisories](https://github.com/PranavAchar01/foundry/security/advisories/new),
or by email to **achar.pranav@gmail.com**.

Please include enough detail to reproduce: the affected route or module, the
inputs or sequence involved, and what an attacker gets out of it. A proof of
concept is welcome but not required.

You can expect an acknowledgement within 72 hours and an assessment within
seven days. If a report is valid, you will be credited in the advisory unless
you would rather not be.

## Scope

Foundry spends real money, sends real messages, and provisions real
infrastructure. Findings in these areas are the highest priority:

| Area | Why it matters |
| --- | --- |
| Guardrail bypass | Any path that spends without passing `authorizeSpend`, or that exceeds a budget ceiling or the circuit breaker |
| Allowlist bypass | Any path that can follow or DM an account not recorded in `consent_cohort` |
| Append-only bypass | Any way to update or delete `ledger_entries`, `decisions`, `machine_runs`, or `conversation_messages` |
| Secret exposure | Credentials reaching logs, API responses, generated storefronts, or the repository |
| Generated page injection | Content in a model-authored storefront that reaches a visitor's browser or the checkout path unsafely |
| Webhook forgery | Accepting a Stripe or X webhook without a valid signature |
| Machine escape | Anything letting a business's VM affect Foundry or another business |

## Out of scope

- Missing rate limits on endpoints that only read public state
- Vulnerabilities requiring an already-compromised operator credential
- Findings in third-party services themselves, which should go to that vendor
- Automated scanner output with no demonstrated impact

## Handling secrets

Every credential lives in the environment. `.env*` is gitignored and no key is
read from a committed file. If you believe a secret has been exposed, report it
privately as above and do not include the value in your report.

## Supported versions

This is an actively developed project with no released version line. Security
fixes land on `main`.
