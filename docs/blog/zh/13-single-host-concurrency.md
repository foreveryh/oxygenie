---
title: "单机并发 — 信号量(max 8)、worker 堆上限与 idle reaper"
slug: 13-single-host-concurrency
date: 2026-06-07
keywords: [并发, 信号量, 堆上限, idle reaper, 单机, 预算]
---

# 单机并发 — 信号量(max 8)、worker 堆上限与 idle reaper

Kin 目标是一台 16 GB / 8 核 VPS 服务一个小团队。标题“50 并发会话”之所以可能，是因为一个区分：**并发会话不等于并发执行**。大多数会话空闲；只有有限数量的 worker 允许同时运行。本课解释保护主机预算的三道门。

## 问题

Per-message worker 默认有 1.5 GB 堆上限。如果 20 条消息同时到达，每条都生成一个无限制 worker，内存使用达到 20 × 1.5 GB = 30 GB，超过 16 GB 主机并导致 OOM kill，可能拖垮整台服务器。同时，限制并发过于激进会让用户等待太久。

## 为什么朴素方案失败

- **消息到达时无限制生成**：内存安全取决于用户不会同时发消息。这是一个最终会输的赌局。
- **每个会话一个常驻 worker**：50 个活跃会话保持 50 个常驻进程，每个都持有 SDK 状态和 MCP 连接。即使空闲也各消耗数百 MB，轻松超过主机内存预算。
- **限制 WebSocket 连接**：大多数连接是空闲的。限制连接针对错误维度，损害用户体验，却解决不了执行尖峰。

## 核心设计

> **三道门：容量 8 的 FIFO 信号量限制活跃 worker；1.5 GB 堆上限限制每个 worker；idle reaper 清理长期不活跃连接。这些门把“在线规模”和“执行规模”分开。**

```
50 个在线会话
  └─ 大部分空闲（仅 WebSocket 连接）
  └─ 活跃执行 ≤ 8（信号量槽位）
        └─ 每个 ≤ 1.5 GB 堆（堆上限）
              └─ 8 × 1.5 ≈ 12 GB < 16 GB ✅
```

- **门 1：FIFO 信号量**。`MAX_CONCURRENT_WORKERS` 默认 8。每个 worker 在生成前获取槽位，在 `worker.on('close')` 释放。FIFO 等待队列防止饥饿。信号量限制活跃 worker，不是连接或消息到达率。
- **门 2：单 worker 堆上限**。`WORKER_MAX_OLD_SPACE_MB` 默认 1536。失控 worker 只会自己 OOM，不会杀死服务器或其他用户会话。
- **门 3：idle reaper**。`shouldReapIdle()` 在空闲超时且没有活跃 worker 时回收不活跃连接。默认关闭（`idleTimeoutMs <= 0`），用于更大部署。

预算算术是故意的：8 × 1.5 GB ≈ 12 GB，给 ws-server、Postgres 和 OS 留 4 GB。这是可预测的最坏情况规划，不是动态扩展。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `ws-server.mjs` | ~L45–58 | `MAX_CONCURRENT_WORKERS` 默认 8 |
| `ws-server.mjs` | ~L61–72 | `WORKER_MAX_OLD_SPACE_MB` 默认 1536 |
| `src/server/concurrency/semaphore.js` | ~L11–60 | FIFO 信号量 acquire/release |
| `src/server/concurrency/idle-reaper.js` | ~L30–35 | `shouldReapIdle()`（默认关闭） |

## 反直觉结论

> **“50 并发”不需要更大的机器；它只需要区分会话与执行。**

容量规划从识别真正的稀缺资源开始。在 Kin 中，这个资源是执行槽位，不是连接。一个小信号量和一个堆上限把在线规模转化为部署前就能解决的乘法问题。

## 生产坑

- **~50 并发是 per-message spawn 的设计上限**。如果大多数会话同时活跃，FIFO 队列会积压，冷启动延迟变得明显。需要更高真实并发时就得用 warm pool，那是不同模型、不同成本。
- **磁盘没有上限**。三道门保护内存和执行，但会话仍可能填满磁盘。目前 workspace 前没有硬磁盘配额。监控磁盘使用并考虑 per-workspace 配额。
- **Idle reaper 默认关闭**。僵尸标签页保持 WebSocket 连接。小部署可忽略；大部署请把 `idleTimeoutMs` 设为正数。

## 相关 Kin 文档

- `ws-server.mjs` — worker 调度器与限制
- `src/server/concurrency/semaphore.js` — FIFO 并发限制器
- `src/server/concurrency/idle-reaper.js` — 空闲连接清理
- `zh/03-per-message-worker-model.md` — 为什么每个消息生成新进程
- `zh/04-streaming-protocol.md` — 背压交互

## 配图

1. `docs/blog/assets/img/13-three-gates.svg` — 三道门
2. `docs/blog/assets/img/13-budget.svg` — 50 会话 → ≤8 执行 → ≤12 GB 预算
