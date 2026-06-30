---
title: "Per-Message Worker 模型 — 为什么每个消息都生成一个全新子进程"
slug: 03-per-message-worker-model
date: 2026-06-07
keywords: [child_process, per-message worker, 隔离, 并发, 信号量, Claude Agent SDK]
---

# Per-Message Worker 模型 — 为什么每个消息都生成一个全新子进程

Kin 不写自己的 agent loop。loop 在 Claude Agent SDK 的 `query()` 内部。Kin 的核心执行决策因此不是“如何 loop”，而是**在哪里运行这个 loop**。答案是：每个用户消息生成一个崭新的 Node 子进程。进程生成、运行 loop、在 `result` 事件到达后立即退出。本课解释选择这种形状的原因、收益和成本。

## 约束

Kin 需要支持多个用户，各自在浏览器中发送消息，这些消息可能调用工具、运行 Python、写文件，或持续数分钟。后端必须同时满足五个约束：

1. **隔离**：用户 A 的失控 Python 不能杀死用户 B 的会话或服务器。
2. **可中断性**：用户会停止、关闭标签页或失去连接。系统必须清理正在运行的工作。
3. **流式**：`query()` 增量产生 token 和事件；浏览器必须实时渲染。
4. **资源有界**：16 GB / 8 核主机应能舒适地服务一个小团队。
5. **不自写 loop**：SDK 已经提供 loop、上下文压缩和 token 统计。

因为 loop 是现成的，唯一剩下的架构问题就是**在哪里运行 `query()`**。

## 为什么朴素方案失败

- **在主进程运行 `query()`**：SDK 在同一 V8 堆中执行工具。一次大响应、一个失控工具，或几个并发查询就能 OOM 服务器并断开所有用户。
- **每个会话一个常驻 worker**：50 个会话保持 50 个进程存活，每个都持有初始化后的 SDK 和 MCP 连接。即使空闲也消耗内存，且它们的状态（全局变量、定时器、半开连接）会泄漏到消息之间。
- **使用 worker threads**：线程共享地址空间和资源限制。内存饥渴工具仍能拖垮整个进程，且 `prlimit` 不适用于线程。
- **每个消息生成一个容器**：隔离最强，但每条消息冷启动数百毫秒到数秒，毁掉交互性。

共同问题是：隔离强度、内存上限、启动延迟和状态清洁度朝不同方向拉扯。对 Kin 的目标规模来说，甜点是 `child_process.spawn`。

## 核心设计

> **每个浏览器标签一个长连接 WebSocket，加上每个用户消息一个一次性子进程。** 主进程 `ws-server.mjs` 只负责调度、转发和限制；子进程 `ws-query-worker.mjs` 实际运行 `query()`。

```
Browser ──WebSocket──▶ ws-server.mjs
                            │ ① semaphore.acquire()
                            │ ② spawn('node', ['ws-query-worker.mjs'])
                            ▼
                     ws-query-worker.mjs
                            │ stdin: 运行请求
                            │ query({ ... }) loop
                            │ stdout: 带 seq 的 NDJSON 帧
                            ▼
                     result event → process.exit()
```

它如何满足约束：

- **隔离**：每个消息获得独立的 V8 堆和 PID。失控工具只能杀死自己的 worker。服务器和其他用户不受影响。
- **可中断性**：通过 `worker.kill()` 停止运行。操作系统会回收进程及其所有子进程。
- **状态清洁**：worker 在 result 后退出，没有残留状态泄漏到下一条消息。
- **资源有界**：信号量限制并发 worker 数量（默认 8）。每个 worker 有硬堆上限（默认 1.5 GB）。8 × 1.5 GB ≈ 12 GB，在 16 GB 主机上留有余量。

关键洞察是**并发会话不等于并发执行**。任何时刻很多用户都是空闲的；只有被信号量限制的那部分在真正运行。

## 关键实现点

### 1. 生成前获取信号量，在 `close` 时释放

```javascript
// ws-server.mjs
await workerSemaphore.acquire()
const worker = spawn('node', [
  `--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`,
  workerScriptPath,
], { env: buildWorkerEnv(config), stdio: ['pipe','pipe','pipe'] })

worker.on('close', () => {
  workerSemaphore.release()
})
```

释放**必须**发生在 `close` 事件，而不是收到 `result` 帧时。如果 worker 在 result 和 exit 之间死亡，或永远到不了 result，提前释放会永久泄漏槽位。泄漏 `MAX_CONCURRENT_WORKERS` 次后，系统会静默停止接受新工作。

### 2. 信号量是 FIFO，且只统计活跃 worker

`src/server/concurrency/semaphore.js` 提供 FIFO 等待队列。它不拒绝溢出，而是排队。这限制的是活跃 worker 数，而不是消息到达率。

### 3. worker 从 stdin 读，向 stdout 写

`ws-query-worker.mjs` 保持 stdin 打开，每行读取一个 JSON 请求。第一行是运行请求；后续行是 HITL 审批响应。核心循环是：

```javascript
let __frameSeq = 0
const writeFrame = (obj) => process.stdout.write(
  JSON.stringify({ ...obj, seq: __frameSeq++ }) + '\n'
)

for await (const ev of query({ /* ... */ })) {
  writeFrame({ type: 'event', event: ev })
  if (ev.type === 'result') { break }
}
process.exit(0)
```

这只是把 SDK 的异步生成器直接翻译成 NDJSON 帧。

### 4. 环境按 worker 注入，secrets 被剥离

`ws-server.mjs` 每次生成时构建 worker 环境。当 worker 随后启动工具子进程时，`buildSafeEnv()` 会从子进程环境中剥离 `ANTHROPIC_API_KEY` 等敏感变量。这与沙箱是否激活无关。

### 5. 默认并发参数

| 变量 | 默认值 | 用途 |
|---|---|---|
| `MAX_CONCURRENT_WORKERS` | 8 | 并发活跃 worker |
| `WORKER_MAX_OLD_SPACE_MB` | 1536 | 单 worker V8 堆上限 |
| text batching | 100 ms | 批量 text delta 降低渲染频率 |
| backpressure | 128 KB / 32 KB | 发送缓冲增长时暂停 worker stdout |

## 反直觉结论

> **Kin 中最重要的工程决策不是“如何写 Agent Loop”，而是“决定不写 Agent Loop”。**

一旦 loop 属于 SDK，真正的问题变成“在哪里运行它、如何限制它、如何隔离它、如何清理它”。答案是一次性子进程。操作系统进程边界是 Kin 的隔离原语。它以冷启动成本换取隔离、可中断性和状态清洁度，也是让 16 GB 主机能服务约 50 并发会话的原因。

## 生产坑

- **在 `close` 而不是 `result` 释放槽位**。在 `result` 释放会在 worker 先于 exit 死亡时泄漏槽位。
- **会话根路径必须是绝对路径**。如果 `CLAUDE_SESSIONS_ROOT` 是相对路径，worker 和 `ws-server.mjs` 解析 transcript 路径会不同，resume 失败因为找不到 transcript。
- **Ask 模式审批可能永远挂住 worker**。当 `canUseTool` 发出 `approval_request` 并等待 stdin 时，没有超时。丢失或放弃的审批会无限占用 worker 槽位。修复方案是可配置审批超时并自动拒绝。

这些有共同根因：**per-message 模型把进程生命周期变成一种必须显式管理的资源**。生成、关闭、杀死、槽位记账都需要对应的兜底路径。

## 相关 Kin 文档

- `ws-server.mjs` — worker 调度器与信号量
- `ws-query-worker.mjs` — per-message worker 实现
- `src/server/concurrency/semaphore.js` — FIFO 并发限制器
- `04-streaming-protocol.md` — NDJSON + seq + 背压
- `13-single-host-concurrency.md` — 单机并发细节

## 配图

1. `docs/blog/assets/img/03-per-message-worker.svg` — per-message worker 概览
2. `docs/blog/assets/img/03-exec-approaches.svg` — 执行方案对比
3. `docs/blog/assets/img/03-semaphore-lifecycle.svg` — 信号量 acquire → spawn → close → release
