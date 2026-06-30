---
title: "Kin 技术栈概览 — 四个进程、钉死的 SDK、ARK 网关与 TanStack Start"
slug: 02-kin-stack-overview
date: 2026-06-07
keywords: [Kin, TanStack Start, Nitro, WebSocket, Claude Agent SDK, ARK, Docker]
---

# Kin 技术栈概览 — 四个进程、钉死的 SDK、ARK 网关与 TanStack Start

本课描述 Kin 的物理运行时：四个常驻进程、它们如何通信，以及每个主要技术选择背后的原因。它补充了 `01-what-is-agent-harness.md` 中的逻辑 15 层栈，展示 `docker compose up` 之后实际运行的是什么。

## 四个进程

Kin 是一组协作进程，而不是单一单体服务器。每个进程有独立的职责和故障域。

```
Browser
   │ WebSocket /ws/agent
   ▼
ws-server.mjs (port 3001)  ← WebSocket 连接管理、会话调度、worker 生成器
   │ child_process.spawn per message
   ▼
ws-query-worker.mjs        ← 每个用户消息一个子进程，运行 Claude Agent SDK query()
   ▲
   │ stdout NDJSON 帧
   │
Nitro / TanStack Start (port 5000)  ← SSR 网页应用、认证、数据库、API、设置
   │
   ▼
preview sidecar / controller        ← 每个会话一个 Docker 预览环境
```

### 1. Nitro / TanStack Start（端口 5000）

用户面对的网页应用基于 **TanStack Start** + **React** + **shadcn/ui**，由 **Nitro** 在端口 5000 提供服务。它负责认证、聊天 UI、会话管理、管理后台、设置和数据库后端 API。它是用户直接在浏览器中交互的唯一进程。

`CLAUDE.md` 中的关键细节：

- `pnpm dev` 当前不可用；本地开发请使用 `scripts/local-prod.sh`。
- WebSocket 客户端适配器位于 `src/claude/adapters/ws-adapter.ts`。

### 2. ws-server.mjs（端口 3001）

`ws-server.mjs` 是独立的 WebSocket 服务器。它拥有每个 `ws-query-worker.mjs` 子进程的生命周期：生成 worker、用信号量限制并发、转发 NDJSON 帧到浏览器、处理会话持久化。它故意与 SSR 网页服务器分离，因此 worker 崩溃或慢客户端不会拖垮公共 Web 应用。

### 3. ws-query-worker.mjs

这是实际的 per-message worker。每个用户消息都会让 `ws-server.mjs` 生成一个 `ws-query-worker.mjs` 实例。worker 内部：

- 从 stdin 读取运行请求；
- 调用钉死的 Claude Agent SDK 的 `query()`；
- 把事件作为带单调 `seq` 的 NDJSON 帧流回 `ws-server.mjs`；
- 在 `result` 事件后退出。

worker 被设计为一次性使用：生成、执行一次任务、死亡。`03-per-message-worker-model.md` 详细解释了这个隔离原语。

### 4. 预览 sidecar / controller

真预览在由预览控制器编排的 per-session Docker 容器中运行。预览是长生命周期的，可能承载多个生成的 artifact；而 worker 是短生命周期的。预览系统见 `15-real-preview.md`。

## 关键技术选择

### Claude Agent SDK 钉死在 0.2.112

Kin 不写自己的 agent loop。它使用 Claude Agent SDK 的 `query()`，并把版本钉死在 `0.2.112`。原因有二：

1. **Anthropic 兼容性**：Kin 通过 Anthropic 兼容网关（主要是 ARK / 火山）使用 SDK。SDK 的网关行为和 env 变量处理在不同版本间有差异。
2. **可预测性**：未固定的 SDK 可能改变流事件形状、工具 schema 或 transcript 格式。固定版本意味着只在你有意升级时才升级，不会意外升级。

### ARK 网关与环境变量

使用 ARK 网关时，只应设置 `ANTHROPIC_AUTH_TOKEN`。**不能**设置 `ANTHROPIC_API_KEY`，因为当该变量存在时，SDK 会改用 x-api-key 请求格式，导致 ARK 的 Bearer-token 认证失败。

### TanStack Start + Nitro

TanStack Start 用于 SSR 和文件系统路由。它让 Kin 把前后端放在同一代码库中，同时产出可部署产物。Nitro 作为底层服务器处理 SSR、静态资源和 API 路由。构建集成到 Docker 镜像中，因此运行容器是自包含的。

## 为什么是这个形状？

四角进程拓扑是产品需求的产物：

- **隔离**：worker 在独立进程中运行，工具崩溃或 OOM 不会杀死 UI。
- **流式弹性**：WebSocket 服务器是独立进程，网络背压和重连可以独立于网页应用处理。
- **预览 longevity**：预览需要比一个消息活得更久，因此有自己的容器和控制器。
- **SSR 简洁**：TanStack Start + Nitro 提供 SSR 和 API 路由，无需引入独立后端框架。

## 相关 Kin 文档

- `docs/project/CLAUDE.md` — 开发规则、本地运行说明、SDK 约束
- `docs/project/VISION.md` — 产品定位与威胁模型
- `ws-server.mjs` — WebSocket 服务器与 worker 调度
- `ws-query-worker.mjs` — per-message worker
- `src/claude/adapters/ws-adapter.ts` — 浏览器端 WebSocket 适配器
- `03-per-message-worker-model.md` — 为什么每个消息生成新进程
- `04-streaming-protocol.md` — NDJSON + seq + 背压

## 配图

1. `docs/blog/assets/img/02-four-processes.svg` — 四角进程拓扑
