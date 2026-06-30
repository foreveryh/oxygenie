---
title: "Single-Host Concurrency — semaphore(max 8), worker heap cap, and idle reaper"
slug: 13-single-host-concurrency
date: 2026-06-07
keywords: [concurrency, semaphore, heap cap, idle reaper, single-host, budget]
---

# Single-Host Concurrency — semaphore(max 8), worker heap cap, and idle reaper

Kin targets a 16 GB / 8-core VPS serving a small team. The headline "50 concurrent sessions" is possible because of one distinction: **concurrent sessions are not concurrent executions**. Most sessions are idle; only a bounded number of workers are allowed to run at once. This lesson explains the three gates that protect the host budget.

## The problem

A per-message worker has a default 1.5 GB heap cap. If 20 messages arrive simultaneously and each spawns a worker without a limit, memory usage reaches 20 × 1.5 GB = 30 GB, which exceeds the 16 GB host and causes an OOM kill that can take down the entire server. At the same time, limiting concurrency too aggressively makes users wait too long for responses.

## Why the naive options fail

- **Unlimited spawn on message arrival**: memory safety depends on users not sending messages at the same time. This is a bet that will eventually lose.
- **One warm worker per session**: 50 active sessions keep 50 resident processes, each holding SDK state and MCP connections. Even idle, they consume hundreds of megabytes each, easily exceeding the host memory budget.
- **Limit WebSocket connections**: most connections are idle. Limiting connections addresses the wrong dimension and harms the user experience without solving the execution spike.

## The core design

> **Three gates: a FIFO semaphore of capacity 8 limits active workers; a 1.5 GB heap cap limits each worker; and an idle reaper cleans up long-inactive connections. These gates separate "online scale" from "execution scale".**

```
50 sessions online
  └─ most idle (only a WebSocket connection)
  └─ active execution ≤ 8 (semaphore slots)
        └─ each ≤ 1.5 GB heap (heap cap)
              └─ 8 × 1.5 ≈ 12 GB < 16 GB ✅
```

- **Gate 1: FIFO semaphore**. `MAX_CONCURRENT_WORKERS` defaults to 8. Each worker acquires a slot before spawn and releases it on `worker.on('close')`. The FIFO wait queue prevents starvation. The semaphore limits active workers, not connections or message arrival rate.
- **Gate 2: per-worker heap cap**. `WORKER_MAX_OLD_SPACE_MB` defaults to 1536. A runaway worker OOMs itself without killing the server or other users' sessions.
- **Gate 3: idle reaper**. `shouldReapIdle()` reclaims inactive connections when both idle timeout has passed and no worker is active. It is disabled by default (`idleTimeoutMs <= 0`) and is intended for larger deployments.

The budget arithmetic is deliberate: 8 × 1.5 GB ≈ 12 GB leaves 4 GB for ws-server, Postgres, and the OS. This is predictable worst-case planning, not dynamic scaling.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `ws-server.mjs` | ~L45–58 | `MAX_CONCURRENT_WORKERS` default 8 |
| `ws-server.mjs` | ~L61–72 | `WORKER_MAX_OLD_SPACE_MB` default 1536 |
| `src/server/concurrency/semaphore.js` | ~L11–60 | FIFO semaphore acquire/release |
| `src/server/concurrency/idle-reaper.js` | ~L30–35 | `shouldReapIdle()` (default off) |

## The counter-intuitive conclusion

> **"50 concurrent" does not require a bigger machine; it requires distinguishing sessions from executions.**

Capacity planning starts by identifying the real scarce resource. In Kin, that resource is the execution slot, not the connection. A small semaphore and a heap cap convert online scale into a multiplication problem that can be solved before deployment.

## Production pitfalls

- **~50 concurrent is the design ceiling for per-message spawn**. If most sessions are active at once, the FIFO queue backs up and cold-start latency becomes noticeable. A warm pool would be needed for higher true concurrency, but that is a different model with different costs.
- **Disk is not capped**. The three gates protect memory and execution, but a session can still fill disk. There is currently no hard disk quota before the workspace. Monitor disk usage and consider per-workspace quotas.
- **Idle reaper is off by default**. Zombie tabs keep WebSocket connections open. For small deployments this is negligible; for larger deployments, set `idleTimeoutMs` to a positive value.

## Related Kin documentation

- `ws-server.mjs` — worker scheduler and limits
- `src/server/concurrency/semaphore.js` — FIFO concurrency limiter
- `src/server/concurrency/idle-reaper.js` — idle connection cleanup
- `03-per-message-worker-model.md` — why each message spawns a new process
- `04-streaming-protocol.md` — backpressure interaction

## Diagrams

1. `docs/blog/assets/img/13-three-gates.svg` — the three gates
2. `docs/blog/assets/img/13-budget.svg` — 50 sessions → ≤8 executions → ≤12 GB budget
