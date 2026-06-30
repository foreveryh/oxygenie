---
title: "Session Persistence — SDK transcript as source of truth, DB as index"
slug: 12-session-persistence
date: 2026-06-07
keywords: [session persistence, transcript, SDK, resume, agent_session]
---

# Session Persistence — SDK transcript as source of truth, DB as index

The per-message worker is stateless. When it exits, nothing remains in its memory. Session content must survive that exit. Kin's persistence strategy is to let the SDK's transcript JSONL be the source of truth and keep the database as a lightweight index. This lesson explains the dual-ID model, the role of each table, and the fragility that comes with treating someone else's file as the truth.

## The problem

Three persistence requirements must be met:

1. Refreshing the browser must not lose the conversation history.
2. Opening an old session and sending a new message must resume context from where it left off.
3. The session list in the UI must load quickly, sorted by last activity.

The SDK already writes a JSONL transcript for each conversation. It also handles resume when given the right resume ID and path. Reimplementing message storage would duplicate the SDK's work and risk format drift.

## Why the naive options fail

- **Store all messages in the database**: the SDK already writes a transcript. Replicating every message into a `message` table means parsing the transcript format, tracking SDK schema changes, and maintaining two sources of truth. This is exactly what the project aims to avoid by not rewriting the SDK's work.
- **No database, scan disk every time**: listing sessions would require reading every JSONL file in the workspace to extract titles and timestamps. This does not scale as the number of sessions grows.
- **Dual-write database and transcript**: keeping two copies as sources of truth introduces consistency problems. The worker writes the transcript; the server writes the database. Any mismatch requires reconciliation logic.

## The core design

> **The SDK transcript is the source of truth. The database is only an index. Messages live in `workspace/.../.claude/projects/{hash}/{sdkSessionId}.jsonl`; the database only stores session metadata, pointers, and resume IDs.**

```
┌─ SDK transcript (truth) ───────────────────────────┐
│ workspace/.../.claude/projects/{hash}/             │
│        {sdkSessionId}.jsonl                        │
│   ├─ user / assistant / tool messages              │
│   ├─ thread state and token accounting             │
│   └─ read by the SDK itself on resume                │
└────────────────────────────────────────────────────┘
              ▲ resume uses path + realSdkSessionId
              │
┌─ DB (index/UI) ─────────────────────────────────────┐
│ agent_session                                       │
│   sdkSessionId      ← Kin's workspace session ID    │
│   realSdkSessionId  ← SDK's resume ID               │
│   claudeHomePath    ← absolute path to transcript   │
│   title / lastMessageAt                             │
└──────────────────────────────────────────────────────┘
```

The `agent_session` table contains two session IDs on purpose. `sdkSessionId` is Kin's stable identifier for the conversation. `realSdkSessionId` is the ID the SDK needs to resume its own transcript. Separating them keeps the UI stable while keeping resume accurate.

Other tables are organized by domain:

| Domain | Tables |
|---|---|
| Sessions | `agent_session` |
| Documents / files | `document`, `session_document`, `message_attachment` |
| Knowledge bases | `knowledge_base`, `kb_document` |
| Usage / audit | `usage_record`, `audit_log` |
| Billing | `plans`, `subscriptions`, `credit_balances`, `credit_ledger`, `invoices` |

No table stores the full message content. That belongs to the transcript.

## The counter-intuitive conclusion

> **When the SDK already writes a transcript, the cheapest persistence strategy is to let it be the truth and keep the database as an index.**

This is the same philosophy as the per-message worker: the execution unit is stateless, and the state lives on disk. The trade-off is that resume is only as reliable as the transcript path. If the path is wrong, the transcript is corrupt, or the SDK changes behavior, the UI sees an empty conversation because the truth is not in the database. This fragility is why the long-term plan is to move the truth back to the database and keep the transcript as a cache.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/db/schema/agent-session.schema.ts` | ~L16–55 | `agent_session` table; dual session IDs; `unique(userId, sdkSessionId)` |
| `src/db/schema/usage-record.schema.ts` | ~L24–67 | per-model usage rows |
| `src/db/schema/audit-log.schema.ts` | ~L17–46` | append-only audit log |

## Production pitfalls

- **Relative paths + different worker cwd break resume**. `ws-server.mjs` and `ws-query-worker.mjs` run with different working directories. If `claudeHomePath` is stored as a relative path, the worker resolves it to a different absolute path than the server intended. History appears to vanish. The fix is to store absolute paths.
- **No DB fallback means resume failures produce empty sessions**. Because messages are not in the database, a resume failure gives the UI nothing to render. This is the inherent fragility of the current design.
- **`costUsd` is approximate and must not be used for billing**. The field is estimated from token counts. For non-Claude models, token counts may be incomplete. Any real charge or quota logic needs a different source of truth.

## Related Kin documentation

- `src/db/schema/agent-session.schema.ts` — session index schema
- `ws-server.mjs` — transcript path management
- `ws-query-worker.mjs` — resume ID handling
- `03-per-message-worker-model.md` — worker lifetime
- `11-single-org-multi-user-isolation.md` — absolute path requirements

## Diagrams

1. `docs/blog/assets/img/12-dual-source.svg` — transcript as truth, DB as index
2. `docs/blog/assets/img/12-resume-bug.svg` — the relative path resume bug
