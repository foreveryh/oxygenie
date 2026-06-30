---
title: "Ask/Act and HITL — canUseTool, approval_request, and stdin round-trip"
slug: 09-ask-act-hitl
date: 2026-06-07
keywords: [HITL, canUseTool, permission mode, Ask, Act, approval]
---

# Ask/Act and HITL — `canUseTool`, `approval_request`, and stdin round-trip

Kin exposes two interaction modes: **Ask**, where every action tool pauses for human approval, and **Act**, where the agent runs autonomously. This lesson describes how they map to the SDK's `permissionMode`, how `canUseTool` is implemented, and why approval round-trips through the worker's stdin rather than a separate channel.

## The problem

Action tools such as `Write`, `Edit`, `Bash`, and `Python` have side effects. Ask mode lets the user approve each action before it runs. The challenge is that this approval must happen **before** the tool executes, and the worker is a disposable child process with a single stdin/stdout channel to the browser.

## Why the naive options fail

- **Build a separate permission engine outside the SDK**: the SDK already provides `canUseTool`, an async callback invoked at the exact moment the model wants to use a tool. Reimplementing this outside the SDK intercepts the wrong layer and drifts from the SDK's scheduling.
- **Add a polling HTTP endpoint for approvals**: this introduces a second channel and a second state store between the worker and the browser. The worker already has a stdin/stdout pipe; adding HTTP is unnecessary failure surface.
- **Execute first, then let the user veto**: for `Write` or `Bash`, the action is irreversible. Post-hoc veto does not provide the safety Ask mode is meant to provide.

## The core design

> **Two user modes map to two SDK permission modes. Approval is implemented by filling the SDK's `canUseTool` hook, using stdout for the request and stdin for the response.**

- `ask` maps to SDK `permissionMode: 'default'`, which enables `canUseTool` for every tool.
- `act` maps to SDK `permissionMode: 'acceptEdits'`, which auto-allows most tools.
- Default mode is `act` (`DEFAULT_MODE='act'`). Ask is an opt-in mode for careful oversight.
- Read-only tools (`Read`, `Glob`, `Grep`, `Ls`) are always allowed in Ask mode, so the user is not overwhelmed by one approval per file access.
- Action tools emit an `approval_request` frame on stdout and await a Promise stored in a pending map. The browser sends an `approval_response` line on stdin, which resolves the Promise and lets `canUseTool` return `allow` or `deny`.

```
worker.canUseTool(actionTool)
  stdout: { type: 'approval_request', toolUseID, tool, input }
  await pending.get(toolUseID)

browser user clicks allow/deny
  ws-server writes to worker.stdin:
  { type: 'approval_response', toolUseID, decision }

worker resolves pending Promise
  canUseTool returns { behavior: 'allow' | 'deny' }
```

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/lib/permission-tier.js` | ~L25–63 | `ask` / `act` → SDK `permissionMode`; default `act` |
| `ws-query-worker.mjs` | ~L296–320 | `canUseTool`: emit `approval_request` and await in Ask mode |
| `ws-query-worker.mjs` | ~L305 | Read-only tools auto-allowed |
| `ws-query-worker.mjs` | ~L185–200, ~L342 | stdin pending map and `approval_response` resolution |
| `ws-server.mjs` | ~L1605–1680 | forward `approval_response` into worker stdin |

`canUseTool` is async. The SDK loop pauses while awaiting the Promise. No polling, no CPU burn, and no timeout. The lack of a timeout is both a feature and a hazard (see pitfalls).

## The counter-intuitive conclusion

> **HITL needs no new channel. The worker's stdin is already a duplex pipe: requests go out on stdout, responses come back on stdin.**

This is the minimal implementation that aligns with the SDK. The approval hook fires at the exact moment the SDK decides whether to execute a tool. Filling that hook through the existing stdin/stdout pipe is cleaner than building a parallel approval subsystem.

## Production pitfalls

- **Approval has no timeout**. If the user disconnects or the response frame is lost, the worker hangs forever, consuming one worker slot. The fix is a configurable approval timeout with automatic deny.
- **Closing worker stdin early breaks the round-trip**. If cleanup code closes stdin before the process is killed, pending approvals can never resolve. Prefer `worker.kill()` over partial cleanup.
- **Approvals are serial**. The SDK asks for one tool at a time. The same worker cannot have two pending approvals simultaneously. This is good UX (one decision at a time) but rules out batched approvals.

## Related Kin documentation

- `ws-query-worker.mjs` — `canUseTool` and stdin handling
- `ws-server.mjs` — approval forwarding
- `src/lib/permission-tier.js` — mode mapping
- `03-per-message-worker-model.md` — worker lifetime and semaphore
- `10-bash-sandbox.md` — Bash execution after approval

## Diagrams

1. `docs/blog/assets/img/09-mode-mapping.svg` — Ask/Act to SDK permission mode mapping
2. `docs/blog/assets/img/09-hitl-roundtrip.svg` — HITL request/response via stdin
