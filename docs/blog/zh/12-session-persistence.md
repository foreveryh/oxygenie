---
title: "会话持久化 — SDK transcript 为真相，DB 为索引"
slug: 12-session-persistence
date: 2026-06-07
keywords: [会话持久化, transcript, SDK, resume, agent_session]
---

# 会话持久化 — SDK transcript 为真相，DB 为索引

Per-message worker 是无状态的。它退出时，内存中什么也没留下。会话内容必须 survive 这个退出。Kin 的持久化策略是让 SDK 的 transcript JSONL 成为真相，数据库只作为轻量索引。本课解释双 ID 模型、每个表的角色，以及把别人的文件当作真相带来的脆弱性。

## 问题

三个持久化需求必须满足：

1. 刷新浏览器不能丢失对话历史。
2. 打开旧会话并发送新消息必须从断点恢复上下文。
3. UI 中的会话列表必须快速加载，按最近活动时间排序。

SDK 已经为每个对话写 JSONL transcript。给它正确的 resume ID 和路径，它也能处理 resume。重新实现消息存储会重复 SDK 的工作并承担格式漂移风险。

## 为什么朴素方案失败

- **把所有消息存数据库**：SDK 已经在写 transcript。把每条消息复制到 `message` 表意味着解析 transcript 格式、跟踪 SDK schema 变化、维护两个真相源。这正是不重写 SDK 工作的项目所要避免的。
- **没有数据库，每次扫描磁盘**：列会话需要读取工作区里每个 JSONL 文件来提取标题和时间戳。会话数量增长后不可扩展。
- **数据库和 transcript 双写**：把两个副本都作为真相源会引入一致性问题。worker 写 transcript，server 写数据库。任何不匹配都需要对账逻辑。

## 核心设计

> **SDK transcript 是真相。数据库只是索引。消息存在 `workspace/.../.claude/projects/{hash}/{sdkSessionId}.jsonl`；数据库只存会话元数据、指针和 resume ID。**

```
┌─ SDK transcript（真相）───────────────────────────┐
│ workspace/.../.claude/projects/{hash}/             │
│        {sdkSessionId}.jsonl                        │
│   ├─ user / assistant / tool 消息                  │
│   ├─ thread 状态与 token 统计                      │
│   └─ resume 时由 SDK 自身读取                      │
└────────────────────────────────────────────────────┘
              ▲ resume 使用路径 + realSdkSessionId
              │
┌─ DB（索引/UI）─────────────────────────────────────┐
│ agent_session                                       │
│   sdkSessionId      ← Kin 的工作区会话 ID          │
│   realSdkSessionId  ← SDK 的 resume ID              │
│   claudeHomePath    ← transcript 的绝对路径         │
│   title / lastMessageAt                             │
└──────────────────────────────────────────────────────┘
```

`agent_session` 表故意有两个会话 ID。`sdkSessionId` 是 Kin 对话的稳定标识。`realSdkSessionId` 是 SDK resume 自己 transcript 所需的 ID。分离它们让 UI 稳定，同时让 resume 准确。

其他表按领域组织：

| 领域 | 表 |
|---|---|
| 会话 | `agent_session` |
| 文档/文件 | `document`, `session_document`, `message_attachment` |
| 知识库 | `knowledge_base`, `kb_document` |
| 用量/审计 | `usage_record`, `audit_log` |
| 计费 | `plans`, `subscriptions`, `credit_balances`, `credit_ledger`, `invoices` |

没有表存储完整消息内容。那属于 transcript。

## 反直觉结论

> **当 SDK 已经在写 transcript 时，最便宜的持久化策略就是让它成为真相，数据库只当索引。**

这与 per-message worker 的哲学相同：执行单元无状态，状态存在磁盘上。代价是 resume 的可靠性取决于 transcript 路径。如果路径错了、transcript 损坏、或 SDK 行为变化，UI 会看到一个空会话，因为真相不在数据库里。这种脆弱性正是长期计划要把真相移回数据库、把 transcript 当作缓存的原因。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/db/schema/agent-session.schema.ts` | ~L16–55 | `agent_session` 表；双会话 ID；`unique(userId, sdkSessionId)` |
| `src/db/schema/usage-record.schema.ts` | ~L24–67 | 每模型用量行 |
| `src/db/schema/audit-log.schema.ts` | ~L17–46 | append-only 审计日志 |

## 生产坑

- **相对路径 + 不同 worker 工作目录会破坏 resume**。`ws-server.mjs` 和 `ws-query-worker.mjs` 运行在不同工作目录。如果 `claudeHomePath` 存为相对路径，worker 会解析出与 server 意图不同的绝对路径。历史似乎消失。修复方案是存绝对路径。
- **没有 DB 回退意味着 resume 失败产生空会话**。因为消息不在数据库里，resume 失败时 UI 没有东西可渲染。这是当前设计的固有脆弱性。
- **`costUsd` 是近似值，不能用于计费**。该字段从 token 数估算。对非 Claude 模型，token 数可能不完整。任何真实收费或配额逻辑需要不同的真相源。

## 相关 Kin 文档

- `src/db/schema/agent-session.schema.ts` — 会话索引 schema
- `ws-server.mjs` — transcript 路径管理
- `ws-query-worker.mjs` — resume ID 处理
- `zh/03-per-message-worker-model.md` — worker 生命周期
- `zh/11-single-org-multi-user-isolation.md` — 绝对路径要求

## 配图

1. `docs/blog/assets/img/12-dual-source.svg` — transcript 为真相，DB 为索引
2. `docs/blog/assets/img/12-resume-bug.svg` — 相对路径 resume bug
