---
title: "Kin Stack Overview — the four processes, pinned SDK, ARK gateway, and TanStack Start"
slug: 02-kin-stack-overview
date: 2026-06-07
keywords: [Kin, TanStack Start, Nitro, WebSocket, Claude Agent SDK, ARK, Docker]
---

# Kin Stack Overview — the four processes, pinned SDK, ARK gateway, and TanStack Start

This lesson describes the physical runtime of Kin: the four long-running processes, how they communicate, and the major technical choices behind each one. It complements the logical 15-layer stack in `01-what-is-agent-harness.md` by showing what actually runs after `docker compose up`.

## The four processes

Kin is a set of cooperating processes rather than a single monolithic server. Each process has a distinct responsibility and failure domain.

```
Browser
   │ WebSocket /ws/agent
   ▼
ws-server.mjs (port 3001)  ← WebSocket connection manager, session scheduler, worker spawner
   │ child_process.spawn per message
   ▼
ws-query-worker.mjs        ← one child process per user message, runs Claude Agent SDK query()
   ▲
   │ stdout NDJSON frames
   │
Nitro / TanStack Start (port 5000)  ← SSR web app, auth, DB, API routes, settings
   │
   ▼
preview sidecar / controller        ← per-session Docker preview environment
```

### 1. Nitro / TanStack Start (port 5000)

The user-facing web application is built on **TanStack Start** with **React** and **shadcn/ui**. It is served by **Nitro** on port 5000. It handles authentication, the chat UI, session management, admin boards, settings, and the database-backed API. It is the only process a user interacts with directly in the browser.

Key details from `CLAUDE.md`:

- `pnpm dev` is currently unavailable; use `scripts/local-prod.sh` for local development.
- The client adapter for the WebSocket lives in `src/claude/adapters/ws-adapter.ts`.

### 2. ws-server.mjs (port 3001)

`ws-server.mjs` is a dedicated WebSocket server. It owns the lifecycle of every `ws-query-worker.mjs` child process: it spawns workers, limits concurrency with a semaphore, forwards NDJSON frames to browsers, and handles session persistence. It is deliberately separate from the SSR web server so that a worker crash or a slow client cannot take down the public web app.

### 3. ws-query-worker.mjs

This is the actual per-message worker. Each user message causes `ws-server.mjs` to spawn one instance of `ws-query-worker.mjs`. Inside, the worker:

- reads the run request from stdin,
- calls `query()` from the pinned Claude Agent SDK,
- streams events back to `ws-server.mjs` as NDJSON frames with monotonic `seq` numbers,
- exits after the `result` event.

The worker is intentionally disposable. It is spawned, does one job, and dies. This is the isolation primitive described in `03-per-message-worker-model.md`.

### 4. Preview sidecar / controller

Real previews run in a per-session Docker container orchestrated by a preview controller. This is separate from the per-message worker because previews are long-lived and may need to host multiple generated artifacts, whereas a worker is short-lived. The preview system is described in `15-real-preview.md`.

## Key technical choices

### Claude Agent SDK pinned to 0.2.112

Kin does not write its own agent loop. It uses the Claude Agent SDK `query()` and pins the version to `0.2.112`. The reason for pinning is twofold:

1. **Anthropic compatibility**: Kin uses the SDK over an Anthropic-compatible gateway, primarily ARK (Volcengine). The SDK's gateway behavior and environment-variable handling differ between versions.
2. **Predictability**: an unpinned SDK can change streaming event shapes, tool schemas, or transcript formats. Pinning is treated as a dependency that is upgraded intentionally, not accidentally.

### ARK gateway and environment variables

When using the ARK gateway, only `ANTHROPIC_AUTH_TOKEN` should be set. `ANTHROPIC_API_KEY` must not be set, because the SDK changes its request format (x-api-key header) when that variable is present, which breaks ARK's Bearer-token authentication.

### TanStack Start + Nitro

TanStack Start is used for SSR and file-system routing. It lets Kin keep the frontend and backend in one codebase while still producing a deployable artifact. Nitro is the underlying server that handles SSR, static assets, and API routes. The build is integrated into the Docker image, so the running container is self-contained.

## Why this shape?

The four-process topology is a consequence of the product requirements:

- **Isolation**: the worker runs in a separate process from the web server, so a tool crash or OOM cannot kill the UI.
- **Streaming resilience**: the WebSocket server is a separate process, so network backpressure and reconnections can be handled independently of the web app.
- **Preview longevity**: previews need to live longer than one message, so they get their own containers and controller.
- **SSR simplicity**: TanStack Start + Nitro provides SSR and API routes without introducing a separate backend framework.

## Related Kin documentation

- `docs/project/CLAUDE.md` — development rules, local run instructions, and SDK constraints
- `docs/project/VISION.md` — product identity and threat model
- `ws-server.mjs` — WebSocket server and worker scheduler
- `ws-query-worker.mjs` — per-message worker
- `src/claude/adapters/ws-adapter.ts` — browser-side WebSocket adapter
- `03-per-message-worker-model.md` — why each message spawns a new process
- `04-streaming-protocol.md` — NDJSON + seq + backpressure

## Diagrams

1. `docs/blog/assets/img/02-four-processes.svg` — the four-corner process topology
