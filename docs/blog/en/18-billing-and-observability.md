---
title: "Billing and Observability — usage_record, why costUsd is not a bill, and the three observability legs"
slug: 17-billing-and-observability
date: 2026-06-07
keywords: [billing, quota, usage_record, costUsd, PostHog, Sentry, audit log]
---

# Billing and Observability — `usage_record`, why `costUsd` is not a bill, and the three observability legs

Kin runs on a fixed-price ARK plan, so the SDK's `costUsd` field has no direct relationship to real spending. This lesson describes how Kin designs billing as an observability-first system, what the three observability legs are, and why the audit log deliberately does not foreign-key to the user table.

## The problem

A multi-user workspace shares a single ARK budget. Left ungoverned, one user's large run could consume the month's allowance. Two questions must be answered before billing can be turned on:

1. **What do you measure?** `costUsd` is available from every `result` event, but it is estimated from Anthropic public pricing, not from the actual ARK bill.
2. **When do you enforce?** Setting a quota before you know the distribution of typical usage risks either over-permissive or over-restrictive gates.

Additionally, a multi-user system needs to answer security questions: who did what, when, from where.

## Why the naive options fail

- **Bill by `costUsd`**: the number is unrelated to the actual payment model. It misleads users and distorts cost decisions.
- **Enforce a quota immediately**: a quota threshold chosen before measuring real usage is a guess. It creates frustration without evidence.
- **Foreign-key `audit_log.userId` to the user table**: when a user is deleted, the audit record is either orphaned or cascade-deleted. In a security investigation, the deleted user is exactly the one you need to trace.

## The core design

> **Billing is observability-first: `usage_record` is a read-only ledger, tokens are the trusted metric, and quotas are enforced only after the conversion rate is calibrated. Observability is three independent legs: PostHog for behavior, Sentry for errors, and an append-only `audit_log` for security.**

- **Read-only ledger**: `usage_record` stores one row per model per run with `inputTokens`, `outputTokens`, `costUsd` (reference only), `numTurns`, and `isError`. It runs for a period before any charge or gate is active, accumulating real usage data.
- **Token-based credit abstraction**: the internal billing unit is the credit. `1 credit = N tokens`, configurable per model. This isolates users from gateway and model changes. `costUsd` is never used in the charge path.
- **Billing tables ready but not gating**: `plans`, `subscriptions`, `credit_balances`, `credit_ledger`, and `invoices` exist, and Polar webhook integration is in place. The gate logic is not yet connected to the production run flow.
- **Observability three legs**:
  - **PostHog**: behavior events with `sessionId` truncated to 8 characters for privacy.
  - **Sentry**: frontend and backend errors.
  - **`audit_log`**: append-only security events with `action`, `target`, `meta`, and `ip`. `userId` is a plain column, not a foreign key, so audit records survive user deletion.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/db/schema/usage-record.schema.ts` | ~L24–67 | per-model usage row; `costUsd numeric(14,6)` commented as "not for billing" |
| `src/server/usage/build-usage-rows.ts` | ~L49–83 | SDK `result` → one row per model, `'unknown'` fallback |
| `src/db/schema/billing.schema.ts` | ~L52–101 | credit balances, ledger, invoices |
| `src/lib/observability/posthog-events.ts` | ~L7–99 | behavior events with session ID truncation |
| `src/db/schema/audit-log.schema.ts` | ~L17–46 | append-only audit log, userId non-FK |

## The counter-intuitive conclusion

> **The first thing a billing system should build is not a charge path, but an observation path.**

Charge logic is small. The hard part is the conversion rate from tokens to credits. That rate must be derived from real usage; it cannot be guessed. In a deployment where the SDK's cost estimate does not match the actual payment model, observability is the only honest foundation for billing. The same value of independence appears in the audit log: immutability is more important than referential integrity.

## Production pitfalls

- **Do not display `costUsd` as a real bill**. It is a reference value only. The schema and UI must keep this distinction clear.
- **No quota gate is currently active**. The system records usage but does not block runs on low balance. Do not assume the billing tables are enforcing limits.
- **`audit_log` grows without bound**. It is append-only. Plan partitioning or archival for long deployments.
- **`costUsd` is a string in Drizzle**. Do not sum it directly; cast before aggregating.

## Related Kin documentation

- `src/db/schema/usage-record.schema.ts` — usage ledger schema
- `src/db/schema/billing.schema.ts` — billing tables
- `src/server/usage/build-usage-rows.ts` — usage row construction
- `src/lib/observability/posthog-events.ts` — PostHog events
- `src/db/schema/audit-log.schema.ts` — audit schema
- `12-session-persistence.md` — transcript and usage caveats
- `14-multi-model-routing.md` — token accounting for non-Claude models

## Diagrams

1. `docs/blog/assets/img/17-billing-phases.svg` — observe → calibrate → quota
2. `docs/blog/assets/img/17-observability.svg` — PostHog / Sentry / audit_log
