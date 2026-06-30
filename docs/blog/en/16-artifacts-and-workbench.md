---
title: "Artifact Detection and the Session UI / Workbench"
slug: 16-artifacts-and-workbench
date: 2026-06-07
keywords: [artifact, workbench, structured outputs, seq, session UI, turn card]
---

# Artifact Detection and the Session UI / Workbench

With a real preview environment in place, the frontend must answer two questions: how does it know a conversation turn produced an artifact, and how does it present the resulting stream of events to the user? This lesson explains artifact detection, the session UI's ordering problem, and the Workbench's current state.

## The problem

Four things must happen correctly at the UI layer:

1. **Identify deliverables**: among all the files a model writes or edits in a turn, which ones constitute a deliverable artifact rather than incidental output?
2. **Converge to one card per turn**: a multi-file app is one deliverable, not four separate files. The UI should not produce one card per `Write` call.
3. **Maintain an ordered timeline**: historical messages and real-time events come from different sources and can arrive out of order. They must be merged into a single, duplicate-free thread.
4. **Fill the Workbench**: the right-hand panel shows progress, sub-agents, files, and context. Each panel needs a real data source.

## Why the naive options fail

- **One card per `Write`**: a Vite project generates `package.json`, `src/main.tsx`, `src/App.tsx`, and `index.html`. Creating a card for each file produces a confusing wall of near-identical cards.
- **SDK structured outputs for artifact declaration**: `outputFormat` would let the model declare artifacts structurally, but the SDK's stop-hook leaks `You MUST call the StructuredOutput tool` into the conversation context, polluting the model's behavior. The structured output is useful but not trustworthy as the sole source.
- **Order by arrival time**: WebSocket frames and resumed messages can arrive interleaved. Without a common ordering key, the timeline corrupts.
- **Scrape tool names for Workbench data**: progress is inferred from `TodoWrite` and sub-agents from `Task`. This is brittle and lags behind the actual state.

## The core design

> **Heuristic artifact detection + `seq`-based event ordering + per-turn card folding + Workbench fed from real data sources.**

- **Heuristic detection**: `use-artifact-detection.ts` scans tool results for file paths and maps extensions to artifact types (HTML, SVG, Markdown, React, JSON, CSV, images). This is the stable baseline.
- **Structured outputs as enhancement**: if enabled, `ENABLE_STRUCTURED_OUTPUTS` can improve artifact detection, but it is never the only source of truth. The stop-hook pollution makes it unsafe to rely on alone.
- **Seq ordering**: every event carries a monotonically increasing `seq` from the worker. The frontend merges events by `seq`, not by arrival time. This gives historical and real-time events a common ordering key.
- **Turn card folding**: a turn is rendered as one card containing the text response, an optional preview card, and a collapsible summary of steps and changed files.
- **Workbench real data**: Files are read from the actual workspace filesystem via server function. Context is built from usage metadata (model, tokens, skills, MCPs). Progress and sub-agents are still derived from tool events but are now aligned with the rest of the UI.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/lib/hooks/use-artifact-detection.ts` | ~L49–75 / L97–121 / L243–256 | extension map / extract artifacts / build cards |
| `src/lib/artifacts/artifact-registry.ts` | ~L43–50 / L52,59 | content hash, `MAX_VERSIONS=10`, currently `ENABLE_VERSION_RECORDING=false` |
| `src/lib/chat-session-store.ts` | ~L401–538 | `mergeMessagesIntoThread` + tool_result backfill |
| `src/claude/adapters/ws-adapter.ts` | ~L524–531 | `messages_loaded` handling |
| `src/components/claude-chat/workbench-panel.tsx` | various | Workbench panels |

## Status: most pieces delivered, seq ordering still the main structural debt

Artifact detection and Workbench hardening have been delivered. The Workbench now reads real workspace files, integrates `info` into Context, auto-opens the right tab, supports collapsible side rails, and uses a unified session-file button to control the right panel.

The remaining structural debt is the front-end event store's **use of `seq` for ordering and deduplication**. Although the worker protocol already carries `seq` on every frame, the frontend store does not yet merge and render by it. This is the root cause of occasional queue stalls and message ghosting after resume. Fixing it is a known, bounded task.

## The counter-intuitive conclusion

> **When a structured SDK feature leaks internal instructions into the conversation, falling back to heuristics is the cleaner engineering choice.**

Heuristic detection is brittle locally — a missing extension can be added with one line — but it does not change the model's context. A polluted context is global and invisible. The trade-off favors control over elegance. The same principle applies to every SDK feature that is consumed: trust the core loop, but validate features that expose their internals.

## Production pitfalls

- **Heuristic detection can mistake explanatory code blocks for deliverables**. A model may include an example snippet in its text answer. Without a structured manifest, the detector may create a card for it. Heuristic + manifest is the stable baseline; structured output is an optional precision boost.
- **`messages_loaded` is handled in both the adapter and the event queue**. If `queue.switch()` misses the event type, the queue can stall after resume. This is the most active structural pitfall in the session UI.
- **`ENABLE_VERSION_RECORDING=false`**. Artifact version recording is implemented but currently disabled, so the "10 versions" limit is inactive.

## Related Kin documentation

- `src/lib/hooks/use-artifact-detection.ts` — heuristic detection
- `src/lib/artifacts/artifact-registry.ts` — artifact registry and version policy
- `src/lib/chat-session-store.ts` — message merging and thread state
- `src/claude/adapters/ws-adapter.ts` — adapter and message loading
- `04-streaming-protocol.md` — seq numbering in the worker protocol
- `15-real-preview.md` — manifest and real preview pipeline

## Diagrams

1. `docs/blog/assets/img/16-artifact-detection.svg` — tool results → extension map → artifact card
2. `docs/blog/assets/img/16-seq-ordering.svg` — session UI ordering problem and seq-based merge
