---
title: "Ask/Act 与 HITL — canUseTool、approval_request 与 stdin 往返"
slug: 09-ask-act-hitl
date: 2026-06-07
keywords: [HITL, canUseTool, permission mode, Ask, Act, 审批]
---

# Ask/Act 与 HITL — `canUseTool`、`approval_request` 与 stdin 往返

Kin 提供两种交互模式：**Ask**，每个 action tool 暂停等待人工审批；**Act**，agent 自主运行。本课描述它们如何映射到 SDK 的 `permissionMode`，`canUseTool` 如何实现，以及为什么审批通过 worker 的 stdin 往返而不是独立通道。

## 问题

`Write`、`Edit`、`Bash`、`Python` 等 action tool 都有副作用。Ask 模式让用户在工具运行前批准每个动作。挑战在于审批必须发生在工具执行前，而 worker 是一个一次性子进程，与浏览器之间只有一条 stdin/stdout 通道。

## 为什么朴素方案失败

- **在 SDK 外建独立权限引擎**：SDK 已经提供 `canUseTool`，在模型想要使用工具的确切时刻被调用。在 SDK 外重新实现会拦截错误层级，并与 SDK 调度脱节。
- **增加轮询 HTTP 端点审批**：这在 worker 和浏览器之间引入第二条通道和第二个状态存储。worker 已有 stdin/stdout 管道，增加 HTTP 是不必要的故障面。
- **先执行再让用户否决**：对 `Write` 或 `Bash` 来说，动作不可逆。事后否决无法提供 Ask 模式应有的安全。

## 核心设计

> **两种用户模式映射到两种 SDK 权限模式。审批通过填充 SDK 的 `canUseTool` 钩子实现，stdout 发请求，stdin 回响应。**

- `ask` 映射到 SDK `permissionMode: 'default'`，为每个工具启用 `canUseTool`。
- `act` 映射到 SDK `permissionMode: 'acceptEdits'`，自动允许大多数工具。
- 默认模式是 `act`（`DEFAULT_MODE='act'`）。Ask 是用于仔细监督的 opt-in 模式。
- 只读工具（`Read`、`Glob`、`Grep`、`Ls`）在 Ask 模式下始终允许，避免用户被每读一个文件就审批一次压垮。
- action tool 在 stdout 发出 `approval_request` 帧，并在 pending map 中等待 Promise。浏览器发送 `approval_response` 到 stdin，解析 Promise，让 `canUseTool` 返回 `allow` 或 `deny`。

```
worker.canUseTool(actionTool)
  stdout: { type: 'approval_request', toolUseID, tool, input }
  await pending.get(toolUseID)

浏览器用户点击允许/拒绝
  ws-server 写入 worker.stdin:
  { type: 'approval_response', toolUseID, decision }

worker 解析 pending Promise
  canUseTool 返回 { behavior: 'allow' | 'deny' }
```

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/lib/permission-tier.js` | ~L25–63 | `ask` / `act` → SDK `permissionMode`；默认 `act` |
| `ws-query-worker.mjs` | ~L296–320 | Ask 模式下发出 `approval_request` 并等待 |
| `ws-query-worker.mjs` | ~L305 | 只读工具自动允许 |
| `ws-query-worker.mjs` | ~L185–200, ~L342 | stdin pending map 与 `approval_response` 解析 |
| `ws-server.mjs` | ~L1605–1680 | 把 `approval_response` 转发到 worker stdin |

`canUseTool` 是异步的。SDK loop 在 await Promise 时暂停。没有轮询、没有 CPU 空转、没有超时。缺少超时既是特性也是隐患（见生产坑）。

## 反直觉结论

> **HITL 不需要新通道。worker 的 stdin 已经是一条双向管道：请求从 stdout 出去，响应从 stdin 回来。**

这是与 SDK 对齐的最小实现。审批钩子在 SDK 决定是否执行工具的确切时刻触发。通过现有 stdin/stdout 管道填充这个钩子，比建一个并行审批子系统更干净。

## 生产坑

- **审批没有超时**。如果用户断开连接或响应帧丢失，worker 会永远挂起，消耗一个 worker 槽位。修复方案是可配置审批超时并自动拒绝。
- **过早关闭 worker stdin 会破坏往返**。如果清理代码在杀死进程前关闭 stdin，pending 审批永远无法解析。优先用 `worker.kill()` 而非部分清理。
- **审批是串行的**。SDK 一次只问一个工具。同一个 worker 不能同时有两个 pending 审批。这是好 UX（一次只做一个决定），但排除了批量审批。

## 相关 Kin 文档

- `ws-query-worker.mjs` — `canUseTool` 与 stdin 处理
- `ws-server.mjs` — 审批转发
- `src/lib/permission-tier.js` — 模式映射
- `zh/03-per-message-worker-model.md` — worker 生命周期与信号量
- `zh/10-bash-sandbox.md` — 审批后的 Bash 执行

## 配图

1. `docs/blog/assets/img/09-mode-mapping.svg` — Ask/Act 到 SDK 权限模式映射
2. `docs/blog/assets/img/09-hitl-roundtrip.svg` — HITL 请求/响应通过 stdin 往返
