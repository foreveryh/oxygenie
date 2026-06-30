# Kin — English Lessons

This directory contains the English versions of the Kin lessons. The Chinese lesson set is in [`../zh/`](../zh/). For a Chinese index, see [`../reading-map.md`](../reading-map.md).

## Status

| Lesson | File | Status |
|---|---|---|
| 01 — What is an Agent Harness | [01-what-is-agent-harness.md](./01-what-is-agent-harness.md) | Full English lesson |
| 02 — Kin Stack Overview | [02-kin-stack-overview.md](./02-kin-stack-overview.md) | Full English lesson |
| 03 — Per-Message Worker Model | [03-per-message-worker-model.md](./03-per-message-worker-model.md) | Full English lesson (flagship) |
| 04 — Streaming Protocol | [04-streaming-protocol.md](./04-streaming-protocol.md) | Full English lesson |
| 05 — Execution Runtime | [05-execution-runtime.md](./05-execution-runtime.md) | Full English lesson |
| 06 — Tool System | [06-tool-system.md](./06-tool-system.md) | Full English lesson |
| 07 — MCP Capability Center | [07-mcp-capability-center.md](./07-mcp-capability-center.md) | Full English lesson |
| 08 — Skills System | [08-skills-system.md](./08-skills-system.md) | Full English lesson |
| 09 — Ask/Act and HITL | [09-ask-act-hitl.md](./09-ask-act-hitl.md) | Full English lesson |
| 10 — Bash Sandbox | [10-bash-sandbox.md](./10-bash-sandbox.md) | Full English lesson |
| 11 — Single-Organization Multi-User Isolation | [11-single-org-multi-user-isolation.md](./11-single-org-multi-user-isolation.md) | Full English lesson |
| 12 — Session Persistence | [12-session-persistence.md](./12-session-persistence.md) | Full English lesson |
| 13 — Single-Host Concurrency | [13-single-host-concurrency.md](./13-single-host-concurrency.md) | Full English lesson |
| 14 — Multi-Model Routing | [14-multi-model-routing.md](./14-multi-model-routing.md) | Full English lesson |
| 15 — Real Preview | [15-real-preview.md](./15-real-preview.md) | Full English lesson (flagship) |
| 16 — Artifacts and Workbench | [16-artifacts-and-workbench.md](./16-artifacts-and-workbench.md) | Full English lesson |
| 17 — Projects and Branch-on-Reply | [17-projects-and-branch-on-reply.md](./17-projects-and-branch-on-reply.md) | Full English lesson |
| 18 — Billing and Observability | [18-billing-and-observability.md](./18-billing-and-observability.md) | Full English lesson |
| 19 — Dokploy Deployment | [19-dokploy-deploy.md](./19-dokploy-deploy.md) | Full English lesson |
| 20 — Retrospective | [20-retrospective.md](./20-retrospective.md) | Full English lesson |
| D1 — Advanced / Agentic RAG | [d1-advanced-rag.md](./d1-advanced-rag.md) | Full English lesson |
| D2 — Long-Term Memory | [d2-long-term-memory.md](./d2-long-term-memory.md) | Full English lesson |
| D3 — Context Engineering | [d3-context-engineering.md](./d3-context-engineering.md) | Full English lesson |
| D4 — Evaluation | [d4-evaluation.md](./d4-evaluation.md) | Full English lesson |
| D5 — Guardrails | [d5-guardrails.md](./d5-guardrails.md) | Full English lesson |
| D6 — Agent / RAG Tracing | [d6-agent-tracing.md](./d6-agent-tracing.md) | Full English lesson |

## What this series is

An engineering teardown of **Kin**: a self-hosted, single-organization, multi-user Agent workspace built on top of the Claude Agent SDK rather than a from-scratch loop. Each lesson is self-contained and explains one layer of the harness that makes a bare `query()` call safe, persistent, concurrent, collaborative, and deployable.

Code references point to the Kin `main` branch snapshot dated 2026-06-30. Line numbers may drift as the codebase evolves; use the file paths as the primary source of truth.

> Last updated: 2026-06-30.
