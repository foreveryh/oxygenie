---
title: "Long-Term Memory — two layers, LLM-driven updates, and system prompt injection"
slug: d2-long-term-memory
date: 2026-06-07
keywords: [long-term memory, memory, two-layer memory, LLM memory update, system prompt injection]
---

# Long-Term Memory — two layers, LLM-driven updates, and system prompt injection

RAG gives the agent access to external documents. Long-term memory gives the agent access to facts about the user and the project across sessions. This lesson describes the design for a memory system that Kin does not yet have.

## Status

Design only. Not implemented.

## The problem

Users expect the agent to remember preferences, project background, and conclusions from previous conversations. When a session restarts, the agent should not need to be reintroduced. The challenge is that memory cannot be implemented by feeding the entire transcript history back into the prompt; the context window is finite and most of the history is noise.

## Why the naive options fail

- **Feed all history into the prompt**: the context window overflows and the noise drowns the signal.
- **Rely only on SDK resume**: transcript resume restores a single conversation, not a distilled, cross-session profile.
- **Ask the user to maintain a memory file manually**: users will not do it, and the memory will drift away from the conversation.

## The design

> **Two layers of memory, updated by a cheap background LLM job, and injected into the system prompt on each `query()` call.**

- **Global / user layer**: stable facts that apply across all sessions — identity, preferences, long-term projects.
- **Workspace / session layer**: recent context for the current task.
- **LLM-driven update**: a cheap model (for example, `doubao-seed-2.0-lite`) runs in a background BullMQ job after each conversation turn, extracting facts worth remembering and incrementally updating the memory store.
- **Injection**: both layers are merged and prepended to the system prompt, reusing the same injection path as skill context.
- **Storage**: memory can live either as per-user filesystem JSON under `~/.claude/` (consistent with MCP and Skills enablement) or in a dedicated `user_memory` table.

## The counter-intuitive conclusion

> **Memory is a write problem, not a read problem.**

Reading memory is easy: concatenate it into the system prompt. The hard part is deciding what to write — distilling a long conversation into a small set of facts that remain useful across sessions. The core engineering is the background LLM updater that judges "this is worth remembering" and "this old fact is now stale."

## Production pitfalls

- **Memory updates must be asynchronous**. Running them synchronously would slow every turn.
- **Layer priority must be defined**. If workspace-level memory conflicts with user-level memory, the agent's behavior will drift.
- **Memory is a PII surface**. Writes and injections must be sanitized and isolated, consistent with audit and guardrails practices.

## Related Kin documentation

- `08-skills-system.md` — skill context injection path that memory can reuse
- `07-mcp-capability-center.md` — per-user filesystem configuration pattern
- `12-session-persistence.md` — session transcript persistence, not memory
- `d5-guardrails.md` — PII and content guardrails
- `d3-context-engineering.md` — how memory interacts with context budgets

## Diagrams

1. `docs/blog/assets/img/d2-two-layer-memory.svg` — global/user layer + workspace/session layer
2. `docs/blog/assets/img/d2-memory-update.svg` — background LLM distillation → system prompt injection
