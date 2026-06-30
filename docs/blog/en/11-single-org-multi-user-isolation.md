---
title: "Single-Organization Multi-User Isolation — per-session workspace and path guard"
slug: 11-single-org-multi-user-isolation
date: 2026-06-07
keywords: [workspace, path guard, single-organization, multi-user, isolation, cross-user]
---

# Single-Organization Multi-User Isolation — per-session workspace and path guard

The sandbox prevents commands from reaching system directories, but it does not prevent user A from accessing user B's session directory. Kin adds a second layer of isolation: each session has its own workspace, and every file tool call passes a logical boundary check before it reaches the sandbox. This lesson explains why the logical check must run before the physical sandbox.

## The problem

Kin is a self-hosted workspace for a single organization. Many users share the same machine and the same `/data/users` directory tree. The sandbox addresses "user vs host" but leaves "user vs user" open. The goal is to prevent one user's file tool from reading or writing another user's session directory, even by accident.

Kin's threat model is semi-trusted colleagues, not anonymous attackers. The isolation does not need to stop every advanced exploit, but it must prevent cross-user mistakes and provide clear defense in depth.

## Why the naive options fail

- **Rely only on the sandbox**: the sandbox is a hard boundary, but it is the last line of defense. If the sandbox configuration is widened by mistake, or if a tool bypasses the sandbox, cross-user access slips through. Defense in depth requires an earlier check.
- **Global permission registry for every path**: a central registry turns every tool call into a query against a shared service. This adds latency and a single point of state. The decision should be a pure function of the path and the current user's root directory.

## The core design

> **Two layers: a physical per-session workspace, and a logical path guard that runs before the sandbox. The path guard is a prefix check with no external lookups.**

- **Per-session workspace**: `/data/users/{userId}/sessions/{sessionId}/workspace/`. The `{userId}` segment separates users; the `{sessionId}` segment gives the SDK a stable working directory for each conversation. Both the session workspace and the transcript directory live under this tree.
- **System prefix blocklist**: `createPathSecurity()` defines blocked prefixes such as `/etc`, `/proc`, `/sys`, `/root`, `/var`, `/bin`, `/usr`, `/sbin`, `/boot`, and `/lib`. Any file tool that targets these prefixes is denied at the logical layer, before execution.
- **Cross-user hard deny**: the key check is in `path-security.js`: if the resolved path is under `sessionsRoot` but not under the current user's `userRoot`, it is hard denied. This check runs in `canUseTool`, before the sandbox sees the command.
- **Symlink resolution**: the path is resolved with `realpath` before the boundary check. A symlink inside the workspace pointing to another user's directory is judged by its real target, not the link path.

```
file tool call (Read/Write/Edit/Glob)
        │
        ▼  ① logical layer: canUseTool (path-security)
   realpath resolves symlink
        │
        ├─ matches blocked prefix (/etc /proc /root …) → deny
        ├─ under sessionsRoot but not current userRoot → hard deny (cross-user)
        └─ inside current userRoot / workspace → allow
        │
        ▼  ② physical layer: srt filesystem fence (sandbox)
```

The two layers have distinct roles. The logical layer is early, cheap, and explanatory. The physical layer is late, hard, and operating-system enforced. Neither alone is enough.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/claude/path-security.js` | ~L1–331 | `createPathSecurity()` and `canUseTool` validation |
| `src/claude/path-security.js` | ~L8–19 | system prefix blocklist |
| `src/claude/path-security.js` | ~L267–331 | per-file-tool workspace / user boundary checks |
| `src/claude/path-security.js` | ~L289–295 | cross-user hard deny, before sandbox |
| `ws-server.mjs` | ~L591–595 | `getSessionWorkspace()` resolves per-session directory |

## The counter-intuitive conclusion

> **The sandbox is the hard boundary, but isolation must also stop the request before it reaches the sandbox.**

The logical layer does not replace the sandbox; it guards against the sandbox's configuration gaps and provides a clear denial reason. The path guard is a pure prefix comparison with no database lookups, so it runs in O(1) time on every tool call. This is the right place to catch cross-user mistakes: early, cheap, and unambiguous.

## Production pitfalls

- **Write scope is the entire userRoot, not just the current session workspace**. This is intentional. A user may want to access files written in an earlier session. The policy widens the same-user surface, but cross-user access remains blocked by the hard deny.
- **The symlink resolution has a TOCTOU window**. `realpath` resolves the link at validation time; the target could change before the tool actually reads or writes. This is a narrow window and low-risk in the semi-trusted model, but it is a known limit.
- **Session root paths must be absolute**. If `CLAUDE_SESSIONS_ROOT` is relative, the worker and ws-server resolve it differently because they run in different working directories. This breaks both boundary checks and transcript resume. The fix is to store absolute paths in the database.

## Related Kin documentation

- `src/claude/path-security.js` — boundary check implementation
- `ws-server.mjs` — session workspace resolution
- `10-bash-sandbox.md` — sandbox layer
- `12-session-persistence.md` — transcript paths and resume

## Diagrams

1. `docs/blog/assets/img/11-two-layer-isolation.svg` — two-layer isolation: per-session workspace + path guard
2. `docs/blog/assets/img/11-cross-tenant.svg` — cross-user deny logic
