---
title: "Project 与 branch-on-reply — 共享会话、access resolver 与 fork 语义"
slug: 17-projects-and-branch-on-reply
date: 2026-06-07
keywords: [Projects, collaboration, 项目分享, branch-on-reply, forkSession, access control]
---

# Project 与 branch-on-reply — 共享会话、access resolver 与 fork 语义

Kin 不只是私人聊天集合。它有一个 **Project** 容器，让团队共享会话、文档和知识库。本课解释数据模型、单一 access resolver，以及最微妙的交互：当非 owner 在共享会话中回复时，系统会 fork 它而不是允许并发写入。

## 问题

三个需求相互冲突：

1. **团队可见性**：同一项目成员应看到彼此的会话和产物。
2. **不能跨用户写入**：一个用户不能往另一个用户的会话追加消息。
3. **从上下文继续**：团队成员应能接棒，携带完整对话历史。

直接方案——让所有人对同一会话可写——违反需求 2，并引入并发和归属问题。替代方案——让会话对他人只读——违反需求 3。Kin 用 **branch-on-reply** 解决这个问题。

## 为什么朴素方案失败

- **共享可变会话**：两个用户写入同一 transcript 会导致归属、排序和锁定问题。SDK 不是为多写者设计的。
- **打开即复制**：如果用户打开共享会话就立即复制，会在还没产生价值前创建大量重复会话。
- **每会话写锁**：可行但复杂；用户仍可能意外永远锁住会话。
- **完全不分享**：违背团队工作台的初衷。

## 核心设计

> **Project 是权限容器。成员资格授予对所有项目作用域会话的读访问。写是单 owner 的；非 owner 回复会把源会话 fork 成回复者的新会话，并通过 `branchedFromSessionId` 指回源会话。**

```
用户 A 在项目 X 创建会话 D1
        │
        ▼ 用户 B（项目 X 成员）打开 D1 — 只读
        │
        ▼ 用户 B 在 D1 中回复
        │
        ▼ ① ws-server 检测到非 owner 回复
        │ ② 创建 D2 行，同一项目，branchedFromSessionId = D1.id
        │ ③ worker 调用 forkSession(D1) → 新 realSdkSessionId
        │ ④ worker 用 forked 上下文在 D2 上运行 query()
        │
        ▼ D2 是 B 的会话，在项目 X 中，带有 D1 完整上下文
```

这与 ChatGPT 的 branch-on-reply 模型相同：共享只读上下文，私有续写。

## 关键数据模型

```typescript
// project
id, ownerUserId, name, description, instructions, isDefault

// project_member
projectId, userId, role ('owner' | 'member')

// agent_session
userId, projectId, branchedFromSessionId, sdkSessionId, realSdkSessionId, claudeHomePath
```

- `projectId = null` → 个人 / loose 会话，仅 `userId` 可见。
- `projectId != null` → 该项目任何成员可见。
- `branchedFromSessionId != null` → 该会话是另一个会话的分支。
- 每个用户自动创建一个默认的 `个人/Personal` 项目。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/db/schema/project.schema.ts` | 全文 | `project` + `projectMember` + `projectRoleEnum` |
| `src/db/schema/agent-session.schema.ts` | 全文 | `projectId` + `branchedFromSessionId` 列 |
| `src/server/projects/access.ts` | 全文 | 单一 access resolver、SQL 谓词、`canAccessSession` |
| `src/server/projects/access-logic.ts` | 全文 | 纯函数、单元测试的可见性/可变性规则 |
| `src/server/function/projects.server.ts` | 全文 | `listProjects`、`createProject`、`addProjectMember`、`assignSessionToProject` |
| `src/server/workspace-session.ts` | 全文 | `getWorkspaceSession` — 先加载再授权 |
| `ws-server.mjs` | ~L1270–L1395 | branch-on-reply 检测、D2 预创建、forkSession 请求 |
| `ws-query-worker.mjs` | ~L960–L1050 | `forkSdkSession()` + `query({ resume: forkedId })` |
| `src/lib/hooks/use-session-branch-info.ts` | 全文 | 前端分支状态与横幅 |
| `src/components/projects/share-project-dialog.tsx` | 全文 | 成员邀请 UI |
| `src/components/projects/project-menu.tsx` | 全文 | owner/member 菜单操作 |

## 单一 access resolver

最重要的工程规则是 **"never scatter `WHERE user_id`"**。所有可见性检查都走 `src/server/projects/access.ts`。

```typescript
// SQL 谓词：该用户可见的会话
visibleSessionsWhere(userId, accessibleProjectIds) {
  const personal = and(isNull(agentSession.projectId), eq(agentSession.userId, userId));
  return or(personal, inArray(agentSession.projectId, accessibleProjectIds));
}
```

这意味着：

- 列表在 SQL 层过滤，而不是内存后过滤。
- 单条加载行用 `canAccessSession(userId, row)` 检查。
- 可变性与可见性分离：成员可以看到队友的会话，但不能重命名、收藏或删除（`isSessionMutable` 检查 `userId`）。

同样的原语通过 `visibleDocumentsWhere` 和 `visibleKbWhere` 扩展到文档和知识库。

## Branch-on-reply 详解

### 触发条件？

当用户向一个已有会话发送消息，且 `session.userId !== currentUserId`，并且该会话位于当前用户所属项目中。

### worker 里发生什么？

```javascript
// ws-query-worker.mjs
import { forkSession as forkSdkSession } from '@anthropic-ai/claude-agent-sdk'

if (forkSessionFlag && sdkResumeId) {
  const forkedId = forkSdkSession(sdkResumeId, { dir: cwd, title: branchTitle })
  // ... 校验 forkedId !== sdkResumeId
  sdkResumeId = forkedId
}

// 然后从 forked 会话 resume
for await (const ev of query({ resume: sdkResumeId, ... })) { ... }
```

fork 使用 SDK 的独立 `forkSession()` 函数，在本地、任何网络调用前完成。这保证源 transcript 不会被写入。

### 为什么不用 `query({ forkSession: true })`？

SDK 也支持 `query({ resume, forkSession: true })`。Kin 故意避免它，因为在流式模式下，SDK 可能在 fork 完成前把用户 prompt 写入源 JSONL。独立的 `forkSession()` 在 `query()` 之前调用，因此源在整个回复过程中只读。

### Workspace 连续性

fork 后，新会话 D2 继续使用源 D1 的 workspace 作为 `cwd`。因为 D2 的 JSONL 写入 D1 项目目录，D1 中创建的工具/文件必须继续对 D2 可见。当用户后来单独继续 D2 时，系统检测到 `branchedFromSessionId` 并仍从源 D1 解析 workspace。

## 反直觉结论

> **在团队 agent 工作台中，“共享会话”不是“共享可变会话”。它意味着共享只读上下文与私有、带归属的续写。**

Branch-on-reply 是避免写锁和归属歧义的架构代价。它让每个会话都是单写者，与 per-message worker 模型和 transcript-as-truth 持久化策略一致。UX 代价是 teammates 会看到多个相关会话；收益是数据模型永远不需要对并发写入进行对账。

## 生产坑

- **fork 后源被删除**：如果 D1 被删除，`branchedFromSessionId` 会通过 `ON DELETE SET NULL` 变为 null。D2 随后失去 workspace 引用，可能无法正确 resume。这是已知边界情况。
- **Fork 必须返回新 id**：worker 断言 `forkedId !== sdkResumeId`。如果失败，分支会被中止，防止写入源会话。
- **邮箱查找是组织范围的**：`addProjectMember` 在整个 `user` 表按邮箱匹配。单组织部署中这是正确的；多组织未来必须按 org 约束。
- **项目级 instructions 存在但未接入**：`project.instructions` 已存储，但还没自动注入每个会话的系统提示。这是已知缺口。

## 相关 Kin 文档

- `src/db/schema/project.schema.ts` — 项目与成员表
- `src/db/schema/agent-session.schema.ts` — 会话谱系列
- `src/server/projects/access.ts` — 单一 access resolver
- `src/server/projects/access-logic.ts` — 纯可见性规则
- `src/server/function/projects.server.ts` — 项目 server functions
- `ws-server.mjs` — branch-on-reply 编排
- `ws-query-worker.mjs` — `forkSdkSession` 调用
- `src/lib/hooks/use-session-branch-info.ts` — 前端分支 UI 状态
- `zh/11-single-org-multi-user-isolation.md` — 工作区隔离
- `zh/12-session-persistence.md` — transcript-as-truth 持久化

## 配图

1. `docs/blog/assets/img/17-project-access.svg` — 个人 vs 项目作用域会话
2. `docs/blog/assets/img/17-branch-on-reply.svg` — D1 → D2 fork 流程
