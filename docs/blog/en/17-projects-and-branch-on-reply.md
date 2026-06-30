---
title: "Projects and Branch-on-Reply — shared sessions, access resolver, and fork semantics"
slug: 17-projects-and-branch-on-reply
date: 2026-06-07
keywords: [Projects, collaboration, project sharing, branch-on-reply, forkSession, access control]
---

# Projects and Branch-on-Reply — shared sessions, access resolver, and fork semantics

Kin is not just a collection of private chats. It has a **Project** container that lets a team share sessions, documents, and knowledge bases. This lesson explains the data model, the single access resolver, and the most subtle interaction: when a non-owner replies to a shared session, the system forks it rather than allowing a concurrent write.

## The problem

Three requirements conflict:

1. **Team visibility**: members of the same project should see each other's sessions and artifacts.
2. **No cross-user writes**: one user must not be able to append messages to another user's session.
3. **Continue from context**: a teammate should be able to pick up where another left off, carrying the full conversation history.

The straightforward solution — give everyone write access to the same session — violates requirement 2 and introduces concurrency and attribution problems. The alternative — make every session read-only to others — violates requirement 3. Kin resolves this with **branch-on-reply**.

## Why the naive options fail

- **Shared mutable session**: two users writing to the same transcript causes attribution, ordering, and locking problems. The SDK is not designed for multi-writer.
- **Copy-on-open**: if a user opens a shared session, copying it immediately creates many duplicate sessions before any value is added.
- **Per-session write locks**: feasible but complex; a user could still accidentally lock a session open forever.
- **No sharing at all**: defeats the purpose of a team workspace.

## The core design

> **A Project is a permission container. Membership grants read access to all project-scoped sessions. Write is single-owner; a non-owner reply forks the source session into a new session owned by the replier, with `branchedFromSessionId` pointing back to the source.**

```
User A creates session D1 in Project X
        │
        ▼ User B (member of Project X) opens D1 — read-only
        │
        ▼ User B replies in D1
        │
        ▼ ① ws-server detects non-owner reply
        │ ② creates D2 row, same project, branchedFromSessionId = D1.id
        │ ③ worker calls forkSession(D1) → new realSdkSessionId
        │ ④ worker runs query() on D2 with the forked context
        │
        ▼ D2 is B's session, in Project X, with D1's full context
```

This is the same model as ChatGPT's branch-on-reply: shared read-only context, private continuation.

## Key data model

```typescript
// project
id, ownerUserId, name, description, instructions, isDefault

// project_member
projectId, userId, role ('owner' | 'member')

// agent_session
userId, projectId, branchedFromSessionId, sdkSessionId, realSdkSessionId, claudeHomePath
```

- `projectId = null` → personal / loose session, visible only to `userId`.
- `projectId != null` → visible to any member of that project.
- `branchedFromSessionId != null` → this session is a fork of another.
- Every user gets one auto-created default `个人/Personal` project.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/db/schema/project.schema.ts` | full | `project` + `projectMember` + `projectRoleEnum` |
| `src/db/schema/agent-session.schema.ts` | full | `projectId` + `branchedFromSessionId` columns |
| `src/server/projects/access.ts` | full | single access resolver, SQL predicates, `canAccessSession` |
| `src/server/projects/access-logic.ts` | full | pure, unit-tested visibility/mutability rules |
| `src/server/function/projects.server.ts` | full | `listProjects`, `createProject`, `addProjectMember`, `assignSessionToProject` |
| `src/server/workspace-session.ts` | full | `getWorkspaceSession` — load then authorize |
| `ws-server.mjs` | ~L1270–L1395 | branch-on-reply detection, D2 pre-creation, forkSession request |
| `ws-query-worker.mjs` | ~L960–L1050 | `forkSdkSession()` + `query({ resume: forkedId })` |
| `src/lib/hooks/use-session-branch-info.ts` | full | frontend branch state and banner |
| `src/components/projects/share-project-dialog.tsx` | full | member invite UI |
| `src/components/projects/project-menu.tsx` | full | owner/member menu actions |

## The single access resolver

The most important engineering rule is **"never scatter `WHERE user_id`"**. Every visibility check routes through `src/server/projects/access.ts`.

```typescript
// SQL predicate for "sessions this user may see"
visibleSessionsWhere(userId, accessibleProjectIds) {
  const personal = and(isNull(agentSession.projectId), eq(agentSession.userId, userId));
  return or(personal, inArray(agentSession.projectId, accessibleProjectIds));
}
```

This means:

- Lists are filtered in SQL, not post-filtered in memory.
- A single loaded row is checked with `canAccessSession(userId, row)`.
- Mutability is separate from visibility: a member can see a teammate's session but cannot rename, favorite, or delete it (`isSessionMutable` checks `userId`).

The same primitive extends to documents and knowledge bases via `visibleDocumentsWhere` and `visibleKbWhere`.

## Branch-on-reply in detail

### When does it trigger?

When a user sends a message to an existing session where `session.userId !== currentUserId` and the session is in a project the current user belongs to.

### What happens in the worker?

```javascript
// ws-query-worker.mjs
import { forkSession as forkSdkSession } from '@anthropic-ai/claude-agent-sdk'

if (forkSessionFlag && sdkResumeId) {
  const forkedId = forkSdkSession(sdkResumeId, { dir: cwd, title: branchTitle })
  // ... validate forkedId !== sdkResumeId
  sdkResumeId = forkedId
}

// then resume from the forked session
for await (const ev of query({ resume: sdkResumeId, ... })) { ... }
```

The fork is done with the SDK's standalone `forkSession()` function, locally, before any network call. This guarantees the source transcript is never written to.

### Why not `query({ forkSession: true })`?

The SDK also supports `query({ resume, forkSession: true })`. Kin deliberately avoids it because in streaming mode the SDK may write the user prompt to the source JSONL before the fork completes. The standalone `forkSession()` is invoked before `query()`, so the source is read-only for the entire reply.

### Workspace continuity

After forking, the new session D2 continues to use the source D1's workspace as its `cwd`. This is because D2's JSONL is written into the D1 project directory, and tools/files created in D1 must remain visible to D2. When a user later continues D2 alone, the system detects `branchedFromSessionId` and still resolves the workspace from the source D1.

## The counter-intuitive conclusion

> **In a team agent workspace, "shared conversation" does not mean "shared mutable conversation". It means shared read-only context with private, attributed continuations.**

Branch-on-reply is the architectural price of avoiding write locks and attribution ambiguity. It makes every session single-writer, which aligns with the per-message worker model and the transcript-as-truth persistence strategy. The UX cost is that teammates see multiple related sessions; the gain is that the data model never has to reconcile concurrent writes.

## Production pitfalls

- **Source deletion after fork**: if D1 is deleted, `branchedFromSessionId` becomes null via `ON DELETE SET NULL`. D2 then loses its workspace reference and may not be able to resume properly. This is a known boundary case.
- **Fork must return a new id**: the worker asserts `forkedId !== sdkResumeId`. If this fails, the branch is aborted to prevent writing into the source session.
- **Email lookup is org-wide**: `addProjectMember` matches by email across the whole `user` table. In a single-organization deployment this is correct; in a multi-organization future it must be constrained by org.
- **Project-level instructions exist but are not yet wired**: `project.instructions` is stored but not automatically injected into every session's system prompt. This is a known gap.

## Related Kin documentation

- `src/db/schema/project.schema.ts` — project and member tables
- `src/db/schema/agent-session.schema.ts` — session lineage columns
- `src/server/projects/access.ts` — single access resolver
- `src/server/projects/access-logic.ts` — pure visibility rules
- `src/server/function/projects.server.ts` — project server functions
- `ws-server.mjs` — branch-on-reply orchestration
- `ws-query-worker.mjs` — `forkSdkSession` call
- `src/lib/hooks/use-session-branch-info.ts` — frontend branch UI state
- `11-single-org-multi-user-isolation.md` — workspace isolation
- `12-session-persistence.md` — transcript-as-truth persistence

## Diagrams

1. `docs/blog/assets/img/17-project-access.svg` — personal vs project-scoped sessions
2. `docs/blog/assets/img/17-branch-on-reply.svg` — D1 → D2 fork flow
