---
title: "Agent / RAG Tracing — from seq event stream to spans and per-retrieval traces"
slug: d6-agent-tracing
date: 2026-06-07
keywords: [observability, tracing, span, RAG metrics, seq event stream, retrieval trace]
---

# Agent / RAG Tracing — from seq event stream to spans and per-retrieval traces

Kin already has application-level observability: PostHog for behavior, Sentry for errors, and `audit_log` for security. What it lacks is step-level agent tracing and RAG retrieval metrics. This lesson describes the design and the partial implementation that landed.

## Status

RAG retrieval trace table: implemented. Agent-level span exporter from the seq event stream: not implemented.

## The problem

When an agent run is slow, wrong, or off-topic, the team must be able to answer: which step stalled, which tool was called, which retrieval returned what, and how many tokens each step consumed. Today the worker only emits `console.error`, which is hard to query and replay.

## Why the naive options fail

- **Console logs**: not queryable, not aggregated, and require SSH access to the server.
- **Application metrics only**: tell you that errors are up but not which session's step failed.
- **End-to-end latency only**: cannot distinguish a slow LLM call from a slow tool call or a slow retrieval.

## The design

> **The seq event stream already produced by the worker is a trace. Add an exporter that converts those events into spans for a tracing backend. Complement this with per-retrieval internal metrics from `kb_search`.**

- **Seq events as spans**: each `seq`-numbered event from the worker can become a span with ordering and timing. This reuses the stream built for frontend rendering.
- **Step-level token and latency**: attach token usage and wall-clock time to each span.
- **RAG retrieval metrics**: every `kb_search` call records query, recall legs, fusion, rerank, and returned passages.
- **Backends**: export to Langfuse or OpenTelemetry. Sampling and asynchronous export are required to avoid slowing the worker hot path.

## What actually landed

RAG retrieval got its own dedicated trace table rather than being derived from the seq stream. The seq-stream approach did not work for retrieval internals because the critical intermediate data (vector recalls, BM25 recalls, RRF fusion, rerank results) never flows to the frontend.

- **`rag_search_trace`**: `src/db/schema/rag-trace.schema.ts` records every `kb_search` execution with columns for query, visible document count, vector IDs, BM25 IDs, fused IDs, reranked IDs, returned IDs, degradation flags, and latency.

This table answers "why was this answer wrong" by exposing each retrieval leg's output and how the final set was composed. It is an offline analysis table, not a real-time span in a tracing backend.

## What is still missing

- **Agent-level span exporter**: no seq-to-span exporter exists for Langfuse/OTel.
- **Step-level token usage**: `usage_record` remains at the run level, not the tool or step level.
- **Real-time tracing UI**: traces are queryable via SQL, not rendered as a span timeline.

## The counter-intuitive conclusion

> **Reusing existing signals is the ideal observability path, but it only works if the data you need actually flows through those signals.**

The seq event stream is a good trace for the agent's high-level steps, but it does not contain the internal retrieval data. When the critical data never flows through the existing channel, you must build a dedicated channel. The lesson is to prefer reuse, but to recognize when reuse is impossible.

## Production pitfalls

- **Traces must not contain sensitive content**. Prompts and retrieved documents should be redacted before export.
- **Span export must be asynchronous and sampled**. Synchronous full export would slow the streaming worker.
- **`seq` is a 32-bit counter**. If used as a span ordering key for very long runs, wraparound must be handled.

## Related Kin documentation

- `src/db/schema/rag-trace.schema.ts` — per-retrieval trace schema
- `src/server/rag/search.ts` — `searchKb()` writes to `rag_search_trace`
- `04-streaming-protocol.md` — seq event stream
- `17-billing-and-observability.md` — observability three legs and `usage_record`
- `d1-advanced-rag.md` — RAG implementation

## Diagrams

1. `docs/blog/assets/img/d6-seq-to-span.svg` — seq event stream split to UI and tracing backend
2. `docs/blog/assets/img/d6-step-metrics.svg` — step-level token and latency metrics
