---
title: "Execution Runtime — local-process and per-session Docker backends with FAIL-CLOSED"
slug: 05-execution-runtime
date: 2026-06-07
keywords: [ExecutionRuntime, sandbox, srt, bubblewrap, Docker, FAIL-CLOSED, secret stripping]
---

# Execution Runtime — local-process and per-session Docker backends with FAIL-CLOSED

Tools may execute arbitrary commands: Python scripts, shell commands, build steps. Those commands must run inside a sandbox. But "sandbox" means different things on a Linux production host and a Mac developer laptop. Kin solves this with an `ExecutionRuntime` interface and two swappable backends: a local-process backend wrapped by `srt`, and a per-session Docker backend. This lesson explains the interface and the invariant that matters most: **FAIL-CLOSED**.

## The problem

Three environments need to be supported safely:

1. **Linux production**: `srt` (based on bubblewrap) is available for lightweight namespace + seccomp isolation.
2. **Mac development**: bubblewrap is Linux-only, so `srt` cannot run locally.
3. **Stronger isolation needs**: a full per-session container with its own filesystem and network namespace is required.

Two questions must be answered together: how do the upper layers (worker, tool system) avoid caring which backend is active, and what does the system do when the sandbox is not ready?

## Why the naive options fail

- **Hard-code `spawn('python', ...)` or `spawn('bash', ...)` everywhere**: execution logic becomes welded to one backend. Changing to Docker requires touching every call site. Worse, on Mac where `srt` is unavailable, this approach silently falls back to running on the bare host.
- **Graceful degradation to bare host**: when sandbox initialization fails, fall back to unprotected execution. This sounds user-friendly, but in a sandbox context it means "when the safety mechanism fails, pretend it does not exist". A single failed `srt` initialization or a Docker daemon hiccup removes every defense, and it does so silently.

The real issue is not which isolation technology to use. It is the default behavior when that technology is unavailable.

## The core design

> **A single `ExecutionRuntime` interface with two swappable backends; a factory chooses the backend from environment variables; the interface contract requires FAIL-CLOSED — if the sandbox is not ready, execution is refused; secrets are stripped unconditionally.**

```
              getExecutionRuntime()
                       │
       ┌───────────────┴────────────────┐
LocalProcessBackend              DockerBackend
(srt on Linux)                   (EXEC_RUNTIME=docker)
       │                                  │
       └────── buildSafeEnv() strips secrets ──────┘
       └────── FAIL-CLOSED: sandbox not ready → refuse
```

The four rules:

1. **Factory selects the backend**: `EXEC_RUNTIME=docker` returns DockerBackend; otherwise LocalProcessBackend. Upper layers call the same methods regardless of the backend.
2. **srt is enabled by default on Linux and disabled on Mac/Windows**: `isEnabled()` reports platform reality honestly. Mac developers who need to run Bash must explicitly set `EXEC_RUNTIME=docker`.
3. **FAIL-CLOSED**: `ensureSandbox()` only passes if either `srt` is active or the backend is Docker. If neither is true, it throws and refuses execution. There is no fallback to bare host.
4. **Secrets are stripped unconditionally**: `buildSafeEnv()` builds a whitelist-based environment for every tool subprocess. It runs regardless of whether the sandbox is active. Even if the sandbox is misconfigured, the subprocess never sees `ANTHROPIC_API_KEY` or similar secrets.

FAIL-CLOSED works because the abstraction is a single interface. If execution were scattered across the codebase, "refuse when unsafe" would have to be repeated at every call site, and one missed call site would become an open hole. A single interface gives `ensureSandbox()` one unavoidable checkpoint.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/claude/execution/index.js` | full file | factory selecting the backend by `EXEC_RUNTIME` |
| `src/claude/execution/local-process-backend.js` | ~139 | subprocess execution + `srt` wrapping on Linux |
| `src/claude/execution/docker-backend.js` | ~175 | per-session Docker container backend |
| `src/claude/execution/sandbox.js` | ~43–49 | `buildSafeEnv()` whitelist-based secret stripping |
| `src/claude/execution/sandbox.js` | ~86–115 | `ensureSandbox()` one-time init and FAIL-CLOSED gate |
| `src/claude/execution/sandbox.js` | ~51–62 | `isEnabled()` platform check |

`ensureSandbox()` is the physical gate. `buildSafeEnv()` is the second line of defense. The backend files are implementation details and do not know whether the caller is running Python or Bash.

## The counter-intuitive conclusion

> **The most important part of sandbox design is not "how to isolate" but "what to do when isolation is unavailable". Graceful degradation is a virtue in most systems; in a sandbox it is a vulnerability.**

Kin's value order is deliberate: safety is ranked above availability. A single refused execution is acceptable; a single unprotected execution is not. The abstraction makes that value order structurally enforceable, because every execution path goes through the same gate.

## Production pitfalls

- **On Mac, Bash is refused unless `EXEC_RUNTIME=docker` is set**. This is FAIL-CLOSED working as intended. The first time a developer hits this, it may look like a bug. It is not. Removing the check creates a bare-host execution hole.
- **The environment whitelist is default-deny**: any new environment variable a tool legitimately needs must be added to `buildSafeEnv()`. A missing variable is silently stripped, causing confusing tool behavior without any "variable removed" log message.
- **Docker backend is opt-in**: on Linux, the default is LocalProcessBackend with `srt`. Switching to Docker without confirming that the Docker daemon, images, and per-session container lifecycle are fully configured can leave you with a backend that claims to be ready but does not actually isolate.

All three pitfalls are the cost of the default-deny philosophy. In a system that executes arbitrary model-generated commands, that cost is worth paying.

## Related Kin documentation

- `src/claude/execution/index.js` — backend factory
- `src/claude/execution/sandbox.js` — `ensureSandbox()`, `buildSafeEnv()`, `isEnabled()`
- `src/claude/execution/local-process-backend.js` — Linux `srt` process backend
- `src/claude/execution/docker-backend.js` — per-session Docker backend
- `10-bash-sandbox.md` — Bash-specific sandbox rules and runtime hardening
- `11-single-org-multi-user-isolation.md` — workspace isolation above the sandbox layer

## Diagrams

1. `docs/blog/assets/img/05-execution-runtime.svg` — ExecutionRuntime interface + dual backends
2. `docs/blog/assets/img/05-fail-closed.svg` — FAIL-CLOSED decision tree
