---
title: "Bash Sandbox — srt FAIL-CLOSED, prlimit, and unconditional secret stripping"
slug: 10-bash-sandbox
date: 2026-06-07
keywords: [Bash sandbox, srt, bubblewrap, prlimit, secret stripping, FAIL-CLOSED]
---

# Bash Sandbox — srt FAIL-CLOSED, prlimit, and unconditional secret stripping

Bash is the most powerful and dangerous tool in the agent set. Kin does not use the SDK's native Bash. Instead, it wraps every command in three layers: srt filesystem isolation, `prlimit` resource hard caps, and `buildSafeEnv()` secret stripping. The governing rule is **FAIL-CLOSED**: if the sandbox is not ready, Bash is refused, never downgraded to bare host execution.

## The problem

Bash executes arbitrary shell commands sourced from a user via the model. The threats include:

1. **Unauthorized reads and writes**: touching `/etc`, `/root`, other users' session directories.
2. **Resource exhaustion**: fork bombs, memory bombs, disk-filling writes.
3. **Secret exfiltration**: printing `ANTHROPIC_AUTH_TOKEN` or other environment keys to the network.
4. **Silent sandbox failure**: the sandbox is misconfigured, but Bash still runs unprotected.

## Why the naive options fail

- **Command blacklists**: an attacker can write `rm -rf /` in endless variants. You cannot enumerate the space of dangerous commands; you must deny access to the targets.
- **Graceful degradation to bare host**: this is the most dangerous convenience. A single sandbox initialization failure silently removes every protection.

## The core design

> **Four stacked layers: FAIL-CLOSED gate, srt filesystem fence, prlimit resource hard caps, and unconditional secret stripping.**

- **FAIL-CLOSED**: `runBash()` calls `ensureSandbox()` before any command. If neither srt nor Docker is active, execution is refused. There is no bare-host fallback.
- **srt filesystem fence**: based on bubblewrap, srt denies read access to `/` by default, then whitelists only the current session workspace, `/usr`, and other necessary paths. Write is allowed only to the workspace and `/tmp`. The command cannot see sensitive host files in the first place.
- **prlimit hard caps**: Linux kernel limits on memory (2 GB), process count (512), and single file size (2 GB). These stop fork bombs and memory bombs before the timeout fires.
- **Secret stripping**: `buildSafeEnv()` runs on every command regardless of sandbox state. It whitelists only environment variables necessary for execution (PATH, HOME, LANG, PYTHON*, etc.) and strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and other secrets.

Safety numbers: Bash timeout 300 s, output cap 512 KB, disk 2 GB, prlimit 2 GB / 512 processes / 2 GB file.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/claude/bash/runner.js` | ~L179–197 | FAIL-CLOSED: refuse if sandbox not ready |
| `src/claude/bash/runner.js` | ~L120–127 | prlimit: 2 GB memory / 512 processes / 2 GB file |
| `src/claude/bash/runner.js` | ~L135–145, ~L219–227 | Disk before/after measurement + overrun warning |
| `src/claude/execution/sandbox.js` | ~L43–49 | `buildSafeEnv()` whitelist secret stripping |
| `src/claude/execution/sandbox.js` | ~L86–115 | `ensureSandbox()` gate and filesystem policy |

## The counter-intuitive conclusion

> **The most important part of a sandbox is its default behavior when it fails. In Kin, a sandbox failure results in refusal, not fallback.**

This is a deliberate value ordering. The system accepts occasional unavailability in exchange for never executing unprotected commands. The secret-stripping layer is independent of the sandbox, so even if the sandbox is bypassed, the command has no keys to steal.

## Production pitfalls

- **Command validation is a second line of defense, not the main one**. srt's filesystem fence is the real boundary. Do not relax the sandbox because a heuristic check exists.
- **On macOS, srt may block legitimate Python paths**. Use `EXEC_RUNTIME=docker` for local development on Mac. srt is the production path on Linux.
- **prlimit is Linux-only**. On non-Linux hosts, the hard resource caps are missing. Production must run on Linux.

## Related Kin documentation

- `src/claude/bash/runner.js` — Bash execution and limits
- `src/claude/execution/sandbox.js` — `ensureSandbox()` and `buildSafeEnv()`
- `src/claude/execution/local-process-backend.js` — Linux srt process backend
- `05-execution-runtime.md` — ExecutionRuntime abstraction and FAIL-CLOSED
- `11-single-org-multi-user-isolation.md` — workspace isolation above the sandbox layer

## Diagrams

1. `docs/blog/assets/img/10-bash-three-gates.svg` — Bash three gates: srt / prlimit / secret strip
2. `docs/blog/assets/img/10-fail-closed.svg` — FAIL-CLOSED decision tree
