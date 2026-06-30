---
title: "Retrospective — from AI SDK starter to self-hosted agent platform: wins, debts, and coupling"
slug: 20-retrospective
date: 2026-06-07
keywords: [retrospective, architecture reflection, Claude Agent SDK, technical debt, Kin]
---

# Retrospective — from AI SDK starter to self-hosted agent platform: wins, debts, and coupling

Kin began from an official AI SDK starter and grew into a self-hosted, single-organization, multi-user agent workspace. This retrospective looks at which decisions proved right, which became debt, and which were trades between capability and coupling to the SDK.

## What Kin built

The core proposition is: **do not write the agent loop yourself; put all engineering effort into the layers around the SDK**. The Claude Agent SDK's `query()` handles the LLM loop, context compression, and token accounting. Kin's work is the 15 layers around it: execution, tool extension, sandboxing, permissions, isolation, persistence, concurrency, multi-model routing, artifact preview, billing, and deployment.

None of these layers is optional. Each was forced by a concrete product requirement: isolation from multi-user risk, persistence across refreshes, concurrency limits on a 16 GB host, sandboxing for arbitrary code execution, and deployment on a real VPS.

## Four decisions that were right

1. **Wrap the SDK, do not rewrite the loop**. The saved work is not just code; it is the ability to follow SDK improvements in tools, context management, and token accounting.
2. **Per-message child process as the isolation primitive**. Process boundaries give isolation, interruptibility, and clean state in one mechanism. They make concurrency budgeting simple.
3. **ExecutionRuntime abstraction + FAIL-CLOSED**. A single interface with a "refuse if unsafe" contract prevents the most dangerous failure mode: silently falling back to unprotected execution.
4. **Observability-first billing**. `usage_record` is a read-only ledger before it is a billing source. Quotas are not enforced until the conversion rate from tokens to credits is calibrated from real data.

## Five debts

1. **Session UI lacks `seq`-based ordering**. The worker protocol already carries `seq`, but the frontend store does not yet merge and render by it. This causes occasional queue stalls and ghosting after resume.
2. **Structured outputs are off due to SDK stop-hook pollution**. The fallback is heuristic + manifest detection. It is locally brittle but globally safe.
3. **Per-message worker and per-session preview are two runtimes**. The agent is stateless per-message; the preview is persistent per-session. Both share the same workspace but have different lifecycles. This is the largest remaining architectural tension.
4. **Skills copy-on-enable scales linearly with users**. One hundred users enabling the same skill creates one hundred copies. The planned fix is a database catalog with lazy filesystem materialization.
5. **Resume once broke because `claudeHomePath` was stored as a relative path**. The worker and ws-server run in different working directories. Relative paths are a cross-process bug. Absolute paths are now enforced.

## Two trades that are now coupling

1. **Pinning the SDK to 0.2.112 for ARK multi-model routing**. This bought cheap access to many models through a single protocol, but it sacrifices version freedom. 0.2.113+ uses a native binary incompatible with the ARK gateway. A migration path to native Anthropic + native binary is a future contingency.
2. **SDK transcript as the source of truth**. This was the cheapest starting point because the SDK already writes the transcript. But it makes resume fragile — the UI has no fallback if the transcript is missing. The plan is to make the database the source of truth and keep the transcript as a cache.

Both trades share a pattern: **they handed a foundation to the upstream SDK in exchange for early speed**. That is a valid choice when the team is small, but it must be tracked and repaid intentionally.

## Three small-team trade-offs

- **Single-machine Compose instead of Kubernetes**. Kubernetes is over-engineering for the target scale.
- **Idle reaper disabled by default**. A few idle containers are acceptable for small teams; the complexity of reclamation can be deferred.
- **Billing records but does not gate**. Building a gate before calibration would be a poor use of limited attention.

## Known next steps

- Unify the per-message and per-session runtimes.
- Add `seq`-based ordering and deduplication to the frontend store.
- Flip persistence so the database owns message truth and the transcript is a cache.
- Connect the quota gate after token-to-credit conversion is calibrated.
- Replace copy-on-enable Skills with a database catalog + lazy load.
- Plan the migration path away from the 0.2.112 pin.

## The counter-intuitive conclusion

> **Wrapping the official SDK saves the kernel but creates coupling. Kin's best decision and its largest debts are two sides of the same coin.**

The maturity of a system built on a third-party SDK is not whether it uses the SDK, but whether it knows exactly where it has handed control to the SDK and has a plan to take it back. Kin hands the SDK the loop, the model version, and the transcript format, but it tracks each of those hand-overs and has a contingency for each. That is the honest engineering posture: use the SDK, know the price, and keep the exits marked.

## Related Kin documentation

- `docs/project/VISION.md` — product identity and threat model
- `docs/project/ROADMAP.md` — current phase plan
- `docs/project/STATUS.md` — live status and decision log
- `01-what-is-agent-harness.md` — the 15-layer stack
- `17-projects-and-branch-on-reply.md` — collaboration and branch-on-reply

## Diagrams

1. `docs/blog/assets/img/19-tradeoff-matrix.svg` — wins vs debts
2. `docs/blog/assets/img/19-sdk-coupling-map.svg` — points of SDK coupling and escape routes
