---
title: "Per-Message Worker Model — why every message spawns a fresh child process"
slug: 03-per-message-worker-model
date: 2026-06-07
keywords: [child_process, per-message worker, isolation, concurrency, semaphore, Claude Agent SDK]
---

# Per-Message Worker Model — why every message spawns a fresh child process

Kin does not write its own agent loop. The loop lives inside the Claude Agent SDK's `query()`. Kin's core execution decision is therefore not "how to loop" but **where to run that loop**. The answer is: one fresh Node child process per user message. The process is spawned, runs the loop, and exits as soon as the `result` event arrives. This lesson explains why that shape was chosen and what it buys and costs.

## The constraints

Kin must support several users, each in their own browser, sending messages that may invoke tools, run Python, write files, or take minutes. The backend must satisfy five constraints simultaneously:

1. **Isolation**: user A's runaway Python must not kill user B's session or the server.
2. **Interruptibility**: users stop, close tabs, or lose connectivity. The system must clean up the running work.
3. **Streaming**: `query()` produces tokens and events incrementally; the browser must render them as they arrive.
4. **Bounded resources**: a 16 GB / 8-core host should comfortably serve a small team.
5. **No custom loop**: the SDK already provides the loop, context compression, and token accounting.

Because the loop is off-the-shelf, the only remaining architectural question is where to run `query()`.

## Why the naive options fail

- **Run `query()` in the main process**: the SDK executes tools in the same V8 heap as the WebSocket server. One large response, one runaway tool, or a few concurrent queries can OOM the server and disconnect every user.
- **One warm worker per session**: 50 sessions keep 50 processes alive, each holding an initialized SDK and MCP connections. They consume memory even when idle, and their state (globals, timers, half-open connections) leaks between messages.
- **Use worker threads**: threads share the same address space and resource limits. A memory-hungry tool can still take down the whole process, and `prlimit` does not apply to threads.
- **Spawn a container per message**: maximum isolation, but cold-start latency of hundreds of milliseconds to seconds on every message ruins interactivity.

The common problem is that isolation strength, memory cap, startup latency, and state cleanliness pull in different directions. The sweet spot for Kin's target scale is `child_process.spawn`.

## The core design

> **One long-lived WebSocket per browser tab plus one disposable child process per user message.** The main process `ws-server.mjs` only schedules, forwards, and limits; the child process `ws-query-worker.mjs` actually runs `query()`.

```
Browser ──WebSocket──▶ ws-server.mjs
                            │ ① semaphore.acquire()
                            │ ② spawn('node', ['ws-query-worker.mjs'])
                            ▼
                     ws-query-worker.mjs
                            │ stdin: run request
                            │ query({ ... }) loop
                            │ stdout: NDJSON frames with seq
                            ▼
                     result event → process.exit()
```

Why this satisfies the constraints:

- **Isolation**: each message gets a separate V8 heap and PID. A runaway tool can only kill its own worker. The server and other users continue unaffected.
- **Interruptibility**: stop a run by killing the worker. The OS reaps the process and any subprocesses it created.
- **State cleanliness**: the worker exits after the result, so there is no residual state to leak into the next message.
- **Bounded resources**: a semaphore limits the number of concurrent workers (default 8). Each worker has a hard heap cap (default 1.5 GB). 8 × 1.5 GB ≈ 12 GB, leaving margin on a 16 GB host.

The key insight is that **concurrent sessions do not equal concurrent executions**. Many users are idle at any moment; only the semaphore-limited set is actively running.

## Key implementation points

### 1. Acquire the semaphore before spawn, release on `close`

```javascript
// ws-server.mjs
await workerSemaphore.acquire()
const worker = spawn('node', [
  `--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`,
  workerScriptPath,
], { env: buildWorkerEnv(config), stdio: ['pipe','pipe','pipe'] })

worker.on('close', () => {
  workerSemaphore.release()
})
```

The release **must** happen in the `close` event, not when the `result` frame is received. If the worker dies between the result and exit, or never reaches a result, releasing early leaks the slot forever. After `MAX_CONCURRENT_WORKERS` such leaks, the system silently stops accepting new work.

### 2. The semaphore is FIFO and counts active workers only

`src/server/concurrency/semaphore.js` provides a FIFO wait queue. It does not reject overflow; it queues. This limits active worker count, not message arrival rate.

### 3. The worker reads from stdin and writes to stdout

`ws-query-worker.mjs` keeps stdin open and reads one JSON request per line. The first line is the run request; later lines are HITL approval responses. The core loop is:

```javascript
let __frameSeq = 0
const writeFrame = (obj) => process.stdout.write(
  JSON.stringify({ ...obj, seq: __frameSeq++ }) + '\n'
)

for await (const ev of query({ /* ... */ })) {
  writeFrame({ type: 'event', event: ev })
  if (ev.type === 'result') { break }
}
process.exit(0)
```

This is a straight translation of the SDK's async generator into NDJSON frames.

### 4. Environment is injected per worker, secrets are stripped

`ws-server.mjs` builds the worker environment per spawn. When the worker later launches tool subprocesses, `buildSafeEnv()` strips sensitive variables such as `ANTHROPIC_API_KEY` from the child environment. This is independent of the sandbox being active.

### 5. Default concurrency knobs

| Variable | Default | Purpose |
|---|---|---|
| `MAX_CONCURRENT_WORKERS` | 8 | concurrently active workers |
| `WORKER_MAX_OLD_SPACE_MB` | 1536 | per-worker V8 heap cap |
| text batching | 100 ms | batch text deltas to reduce render frequency |
| backpressure | 128 KB / 32 KB | pause worker stdout when send buffer grows |

## The counter-intuitive conclusion

> **The most important engineering decision in Kin is not "how to write the Agent Loop" but "deciding not to write the Agent Loop".**

Once the loop belongs to the SDK, the real problem becomes "where to run it, how to limit it, how to isolate it, and how to clean it up". The answer is a disposable child process. The operating-system process boundary is Kin's isolation primitive. It trades cold-start cost for isolation, interruptibility, and state cleanliness, and it is the reason a 16 GB host can serve ~50 concurrent sessions.

## Production pitfalls

- **Release the slot on `close`, not `result`**. Releasing on `result` leaks slots when the worker dies before exit.
- **Session root paths must be absolute**. If `CLAUDE_SESSIONS_ROOT` is relative, the worker resolves transcript paths differently than `ws-server.mjs`, and resume fails because the transcript cannot be found.
- **Ask-mode approvals can hold a worker forever**. When `canUseTool` emits an `approval_request` and waits for stdin, there is no timeout. A lost or abandoned approval ties up a worker slot indefinitely. A configurable timeout with automatic deny is the fix.

These all share the same root cause: **the per-message model makes process lifetime a resource you must manage explicitly**. Spawn, close, kill, and slot accounting all need matching fallback paths.

## Related Kin documentation

- `ws-server.mjs` — worker scheduler and semaphore
- `ws-query-worker.mjs` — per-message worker implementation
- `src/server/concurrency/semaphore.js` — FIFO concurrency limiter
- `04-streaming-protocol.md` — NDJSON + seq + backpressure
- `13-single-host-concurrency.md` — single-host concurrency details

## Diagrams

1. `docs/blog/assets/img/03-per-message-worker.svg` — per-message worker overview
2. `docs/blog/assets/img/03-exec-approaches.svg` — comparison of execution approaches
3. `docs/blog/assets/img/03-semaphore-lifecycle.svg` — semaphore acquire → spawn → close → release

🔗 Chinese version: [zh/03-per-message-worker-model.md](../zh/03-per-message-worker-model.md)
