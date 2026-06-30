---
title: "Streaming Protocol — NDJSON frames, seq numbers, and backpressure"
slug: 04-streaming-protocol
date: 2026-06-07
keywords: [NDJSON, seq, backpressure, WebSocket, streaming, worker]
---

# Streaming Protocol — NDJSON frames, seq numbers, and backpressure

The worker runs the SDK's `query()` loop. Once it produces events, those events must reach the browser incrementally and in order. This lesson describes the streaming protocol between `ws-query-worker.mjs`, `ws-server.mjs`, and the browser: why it uses NDJSON, why every frame carries a `seq`, and how backpressure prevents a slow client from OOMing the server.

## The requirements

1. **Zero-buffered forwarding**: events should be rendered as they are produced, not batched until the whole turn is complete.
2. **Order correction**: frames may be reordered across stdout, readline parsing, WebSocket frames, and the public internet.
3. **Slow-client protection**: a fast model filling a slow network can cause unbounded memory growth in the server.
4. **Disconnect resilience**: reconnections should not force the user to restart the turn.

Items 1 and 2 are protocol-shape questions. Items 3 and 4 are flow-control questions.

## Why common alternatives fail

- **gRPC / protobuf**: overkill for a local pipe. The first hop is "worker stdout → ws-server stdin" inside the same host. Adding protobuf requires `.proto` files and generated code, and it makes debugging harder because you cannot `tail -f` the stream.
- **Implicit ordering by arrival**: arrival order is not production order. A single misordered `text_delta` frame corrupts the rendered response.
- **Fire-and-forget WebSocket sends**: `ws.send()` is non-blocking. If the client cannot keep up, data accumulates in the server's send buffer. One slow client with a fast turn can consume hundreds of megabytes and OOM the process, disconnecting every other user.

The lesson is that the hard part of streaming is not pushing bytes out; it is what to do when the consumer cannot keep up.

## The core design

> **Newline-delimited JSON (NDJSON) frames, each carrying a monotonically increasing `seq`. The worker uses `process.stdout.write()`'s return value for backpressure; `ws-server.mjs` pauses `worker.stdout` when the WebSocket `bufferedAmount` exceeds a threshold. There is no application-layer queue in the middle.**

```
worker (child)          ws-server (main)            browser store
   │                             │                           │
   query() emits event           │                           │
   writeFrame({seq:n++})         │                           │
   process.stdout.write()        │                           │
   ├─ returns true → next        │                           │
   └─ returns false → await 'drain'                         │
   ▼ (OS pipe fills, write blocks)                          │
   ─── stdout pipe ──▶ readline parse ──▶ ws.send()         │
                                │  check bufferedAmount      │
                                │  > 128KB → pause worker    │
                                │  < 32KB  → resume worker   │
                                │                            │
                                └──── WebSocket ──▶ merge by seq
                                                           ▼
                                                     rendered text
```

How each requirement is met:

- **NDJSON**: human-readable, native to Node, no build step. When a stream breaks, the first debugging step is `tail` or `cat` the worker stdout. Each line is one JSON frame.
- **`seq`**: a single process-local counter stamps each frame at creation time. The counter moves only forward. The frontend merges frames by `seq`, not by arrival time. This reduces the distributed-ordering problem to a single frontend sort.
- **Backpressure**: data should not accumulate in application memory. When `ws.bufferedAmount` exceeds 128 KB, `ws-server.mjs` calls `worker.stdout.pause()`. The OS stdout pipe fills up. The worker's next `write()` returns false, the worker awaits `'drain'`, and the SDK's `for await` loop stalls. The LLM gateway is effectively slowed down. When the buffer drops below 32 KB, `resume()` is called and the pipeline restarts. The only buffer is the OS pipe, which already has a bounded size.
- **Text batching**: `text_delta` events are batched to 100 ms to avoid re-rendering 100 times per second. Non-text events (`tool_progress`, `result`) are forwarded immediately because they carry state changes that should not be delayed.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `ws-query-worker.mjs` | ~630–780 | `query()` loop + `writeFrame()` with seq |
| `ws-server.mjs` | ~1170–1287 | readline parse → forward → backpressure pause/resume |
| `src/claude/adapters/ws-adapter.ts` | ~362–367 | WebSocket singleton + reconnect (max 5, 1 s backoff) |
| `ws-adapter.ts` | ~759–1577 | `ClaudeAgentWSAdapter.run()` async generator + 100 ms text batching |
| `ws-adapter.ts` | ~576–595 | `onMessage` routing for session init, messages loaded, approval requests |

The backpressure code is intentionally small: `if (bufferedAmount > 128000) worker.stdout.pause(); if (bufferedAmount < 32000) worker.stdout.resume();`. No counters, no timers, no application queues. The OS pipe is the only buffer.

## The counter-intuitive conclusion

> **The hard part of streaming is not pushing bytes out; it is preventing a fast producer and slow consumer from exploding memory. The answer is not an application queue but operating-system pipe backpressure.**

Adding an application-level send queue would only move the unbounded growth from the WebSocket buffer to the queue. Kin does the opposite: it adds zero application buffering and lets the OS pipe backpressure propagate all the way back to the SDK's async generator. The LLM gateway itself slows down when the client cannot keep up.

The `seq` field is the cheapest possible solution to distributed ordering. A process-local increment at frame creation replaces retries, acknowledgments, and sliding windows with one frontend sort.

## Production pitfalls

- **In-flight frames are dropped on reconnect/resume**: the protocol has no frame replay buffer. When a user switches sessions or refreshes, frames already emitted by the worker but not yet rendered are lost. The frontend can detect missing `seq` values, but there is no server-side store to replay them. A bounded ring buffer keyed by last-seen `seq` would be the fix.
- **32-bit `seq` wraparound and oversized single frames**: `seq` is a 32-bit integer and could wrap after very long runs. More practically, `readline` reads until `\n`; a single frame larger than 64 KB keeps accumulating in memory before the newline arrives, bypassing the 128 KB backpressure threshold because the threshold measures WebSocket send buffer, not parser state.
- **Worker stderr is not forwarded to the client**: stdout is the protocol channel; stderr is logged only on the server. Frontend silence does not mean the worker is healthy. Server logs are the source of truth for failures.

These are all consequences of the same trade-off: the protocol optimizes for simplicity, observability, and ordering rather than reliable delivery. For the common case, that is the right trade-off; for the edge cases, the missing pieces are known and documented.

## Related Kin documentation

- `ws-query-worker.mjs` — frame writing and SDK loop
- `ws-server.mjs` — frame parsing and backpressure
- `src/claude/adapters/ws-adapter.ts` — browser-side adapter and reconnect
- `03-per-message-worker-model.md` — why each message spawns a new process
- `13-single-host-concurrency.md` — concurrency and backpressure interaction

## Diagrams

1. `docs/blog/assets/img/04-event-pipeline.svg` — event pipeline from SDK to browser store
2. `docs/blog/assets/img/04-backpressure.svg` — bufferedAmount thresholds and worker stdout pause
