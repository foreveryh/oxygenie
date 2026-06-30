---
title: "What is an Agent Harness — the 15 layers you still build when the SDK gives you the loop"
slug: 01-what-is-agent-harness
date: 2026-06-07
keywords: [Agent Harness, Claude Agent SDK, self-hosted AI agent, single-organization multi-user]
---

# What is an Agent Harness — the 15 layers you still build when the SDK gives you the loop

A common misconception about Kin is that it is an "agent framework" with its own LLM loop. It is not. **The core loop — call the LLM → parse `tool_use` → execute the tool → feed back → repeat — is already provided by the Claude Agent SDK's `query()`.** The SDK also handles context compression, token accounting, and the tool protocol.

What Kin adds is a **runtime harness** around that SDK call: a set of layers that turn a stateless, single-process, single-user demo into a self-hosted, single-organization, multi-user workspace. This lesson explains what those layers are, why each one is non-optional, and when it is actually worth building your own harness rather than using a hosted service.

## The gap between `query()` and a product

Calling `query({ prompt, options })` is enough for a three-line demo. The SDK will decide which tool to call, parse the tool result, feed it back, and emit a `result`. But that default call is **stateless, single-process, and single-user**. Running it in production for a team introduces seven classes of missing capabilities:

1. **Persistence**: `query()` does not save history for you. Refresh the browser and the conversation is gone.
2. **Isolation**: `query()` runs in the same Node process as the tool execution. One user's runaway Python loop can take down the server for everyone.
3. **Concurrency limits**: without a governor, a few simultaneous messages can OOM a 16 GB host.
4. **Resilience**: WebSocket disconnects mid-run have no recovery mechanism.
5. **Safety**: there is no sandbox, path guard, or secret stripping by default. `rm -rf` and credential exfiltration are one prompt away.
6. **Extensibility**: adding internal tools, skills, or MCP servers requires modifying core code each time.
7. **Operations**: no usage tracking, no audit trail, no deployment pipeline means it cannot be adopted by an organization.

These are not bugs that can be patched one by one. They are architectural layers that must be designed before the product can survive real usage.

## Kin's 15 layers (SDK at layer 0)

Kin can be drawn as a stack. Layer 0 is the SDK's `query()`; layers 1–15 are the harness that Kin provides.

```
15. CI/CD + deployment (multi-stage Docker, GHCR, Dokploy, Traefik)
14. Observability + audit (PostHog, Sentry, audit_log)
13. Billing + quotas (usage_record, token-based credits)
12. Real preview (per-session Docker + subdomain proxy + JWT)
11. Session UI / Workbench (turn cards, artifacts, seq ordering)
10. Multi-model routing (ARK gateway, model aliases, pinned SDK version)
 9. Concurrency + reclamation (semaphore, heap cap, idle reaper)
 8. Session persistence (SDK transcript as source of truth, DB as index)
 7. Single-organization multi-user isolation (per-session workspace + path guard)
 6. Bash sandbox (srt/Docker + prlimit + secret stripping)
 5. Permissions + HITL (Ask/Act + canUseTool approval)
 4. Tools / Skills / MCP (preset + custom MCP + filesystem enablement)
 3. ExecutionRuntime abstraction (local process / Docker backends)
 2. Streaming protocol (NDJSON + seq + backpressure)
 1. Per-Message Worker (one child process per user message)
─────────────────────────────────────
 0. Claude Agent SDK query() (loop, context, tool protocol)
```

The key point is that these layers are **load-bearing dependencies**. Layers 1–3 (per-message worker, streaming protocol, execution runtime) form the foundation. Without them, concurrency limits, sandboxing, and isolation have no place to attach. Layers 4–8 (tools, permissions, sandbox, isolation, persistence) handle safety and memory. Layers 9–15 (concurrency, multi-model, UI, preview, billing, observability, deployment) handle scale and operational readiness.

Each layer exists because a specific user expectation demands it. Refreshing the page and expecting history to remain demands layer 8. Expecting that one user's code cannot be read by another demands layer 7. Expecting that the model cannot delete arbitrary files demands layers 5 and 6. Expecting the tool to be deployable and auditable demands layers 13–15.

## The counter-intuitive conclusion

> **When the SDK provides the loop, the hard work does not disappear — it moves from the center to the perimeter.**

You save the few hundred lines of the loop. You still have to write the thousands of lines around it. And because the loop is the same for everyone using the SDK, **differentiation is forced into the harness**: isolation, streaming resilience, concurrency budgeting, sandboxing, preview fidelity, observability, and deployment ergonomics. The harness is the product; the loop is merely a shared dependency.

This is why Kin intentionally pins the Claude Agent SDK to `0.2.112` and uses the ARK-compatible gateway: it does not compete on loop intelligence. It competes on making the SDK run safely and reliably in a multi-user, self-hosted environment.

## When you should build your own harness

For most people, the answer is **never**. Use a hosted agent platform, or run `query()` as an internal script. Building a harness is worthwhile only when **all three** of the following are true:

1. **You must self-host.** Data cannot leave your infrastructure, or you must use a specific model gateway, or compliance requires that code and workspaces stay on your machines.
2. **You are genuinely multi-user and execution-heavy.** One person occasionally asking the model questions does not need isolation or concurrency limits. A team of colleagues running code, writing files, and starting services does.
3. **It must become a product, not a script.** Billing, audit trails, one-click deployment, and procurement matter.

Kin's target context matches all three. Its threat model is **semi-trusted colleagues**, not anonymous attackers. That is why powerful capabilities such as code execution are treated as legitimate core features and guarded with sandboxing rather than prohibition.

## Related Kin documentation

- `docs/project/VISION.md` — product identity and threat model
- `docs/project/ROADMAP.md` — current phase plan and completed milestones
- `docs/project/STATUS.md` — live project status and decision log
- `CLAUDE.md` — development rules and stack constraints

## Diagrams

1. `docs/blog/assets/img/01-stack-15layers.svg` — Kin 15-layer stack with the SDK at layer 0
2. `docs/blog/assets/img/01-naive-vs-harness.svg` — gap between raw `query()` and a production harness
