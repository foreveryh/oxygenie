---
title: "Context Engineering — progressive compaction, offload to disk, summarization, and budgets"
slug: d3-context-engineering
date: 2026-06-07
keywords: [context engineering, context compression, compaction, offload, summarization, budget]
---

# Context Engineering — progressive compaction, offload to disk, summarization, and budgets

Kin currently delegates context management to the Claude Agent SDK. This is convenient but means Kin has no explicit policy for what happens when a long conversation, a large tool output, or a big retrieval result approaches the context limit. This lesson describes the design for an explicit context-engineering layer that Kin does not yet have.

## Status

Design only. Not implemented.

## The problem

Long conversations and large tool outputs (for example, a `grep` that matches ten thousand lines or a 50 KB file) consume the context window quickly. The system must keep the most relevant information within the budget without losing references or drowning the model in noise. The challenge is compounded by the fact that the compaction step itself must not push the budget over the limit.

## Why the naive options fail

- **Single-threshold truncation**: cutting the oldest messages when the limit is reached discards early but still-critical information.
- **Rely entirely on SDK autocompact**: the SDK does not know Kin's business semantics (which messages are retrieval results, which references must be preserved, which outputs can be offloaded).
- **Summarize everything**: summarization is lossy and consumes tokens, which can paradoxically worsen the budget problem.

## The design

> **Progressive compaction with offload-first. Estimate the token budget before calling `query()`, then apply lightweight compression, attachment offloading, and finally LLM summarization of older turns only if necessary.**

- **Budget before the call**: estimate token usage before the next `query()` invocation. This prevents the compaction step itself from exceeding the window.
- **Offload > summarize**: large tool outputs are written to `message_attachment` (the table already exists) and only a short prefix plus an attachment pointer is kept in the context. Moving data out of the context is cheaper and less lossy than summarizing it.
- **Progressive layers**: apply light compression first (deduplication, tail truncation), then offload large blocks, and only as a last step use a cheap model to summarize older turns.
- **Integration with RAG and memory**: retrieval results are loaded on demand, repeated retrieval results are compressed, and retrieval history feeds into memory to avoid repeated searches.

## The counter-intuitive conclusion

> **The best context compression is not summarization; it is offloading plus pointers.**

Summarization is lossy and costs tokens. Offloading a large tool output to `message_attachment` and keeping only a pointer in the context is nearly free and preserves the full text. Kin is fortunate that the `message_attachment` table already exists; the missing piece is wiring it into the context pipeline.

## Production pitfalls

- **Compaction must be decided before the LLM call**, not during it.
- **Streaming buffers must not hold large unloaded outputs**. Write the output to disk first, then include the pointer in the context.
- **If SDK autocompact remains enabled, boundaries must be clear** so that Kin's explicit compaction and the SDK's internal compaction do not fight each other.

## Related Kin documentation

- `12-session-persistence.md` — the `message_attachment` table already exists
- `d1-advanced-rag.md` — retrieval results are a major context consumer
- `d2-long-term-memory.md` — memory reduces the need to keep raw history
- `04-streaming-protocol.md` — worker event streaming and buffer management

## Diagrams

1. `docs/blog/assets/img/d3-progressive-compaction.svg` — progressive compaction waterfall
2. `docs/blog/assets/img/d3-offload-pointer.svg` — offload to attachment + pointer
