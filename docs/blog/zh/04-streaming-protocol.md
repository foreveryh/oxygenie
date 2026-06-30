---
title: "流式协议 — NDJSON 帧、seq 编号与背压"
slug: 04-streaming-protocol
date: 2026-06-07
keywords: [NDJSON, seq, 背压, WebSocket, 流式, worker]
---

# 流式协议 — NDJSON 帧、seq 编号与背压

worker 运行 SDK 的 `query()` loop。一旦产生事件，这些事件必须增量、有序地到达浏览器。本课描述 `ws-query-worker.mjs`、`ws-server.mjs` 和浏览器之间的流式协议：为什么使用 NDJSON，为什么每帧带 `seq`，以及背压如何防止慢客户端让服务器 OOM。

## 需求

1. **零缓冲转发**：事件应产生即渲染，而不是等整轮完成再批量发送。
2. **顺序修正**：帧可能在 stdout、readline 解析、WebSocket 帧和公网中乱序。
3. **慢客户端保护**：快速模型填满慢网络时，可能导致服务器内存无界增长。
4. **断连弹性**：重连不应强迫用户重新开始一轮。

第 1、2 项是协议形状问题。第 3、4 项是流控问题。

## 为什么常见替代方案失败

- **gRPC / protobuf**：对本地管道来说过度。第一跳是同一主机内的“worker stdout → ws-server stdin”。引入 protobuf 需要 `.proto` 文件和生成代码，调试也更困难，因为你无法 `tail -f` 这条流。
- **按到达顺序隐式排序**：到达顺序不是生产顺序。一个乱序的 `text_delta` 帧会污染渲染出的响应。
- **即发即弃的 WebSocket 发送**：`ws.send()` 是非阻塞的。如果客户端跟不上，数据会在服务器发送缓冲中累积。一个慢客户端配上一轮快速生成，可能消耗数百 MB 并 OOM 进程，断开其他所有用户。

教训是：流式最难的不是把字节推出去，而是**消费者跟不上时怎么办**。

## 核心设计

> **换行分隔的 JSON（NDJSON）帧，每帧带单调递增的 `seq`。worker 使用 `process.stdout.write()` 的返回值做背压；`ws-server.mjs` 在 WebSocket `bufferedAmount` 超过阈值时暂停 `worker.stdout`。中间没有应用层队列。**

```
worker (子进程)          ws-server (主进程)            浏览器 store
   │                             │                           │
   query() 产生事件               │                           │
   writeFrame({seq:n++})          │                           │
   process.stdout.write()         │                           │
   ├─ 返回 true → 继续            │                           │
   └─ 返回 false → 等待 'drain'                            │
   ▼ (OS pipe 满，write 阻塞)                               │
   ─── stdout pipe ──▶ readline 解析 ──▶ ws.send()          │
                                │  检查 bufferedAmount       │
                                │  > 128KB → 暂停 worker     │
                                │  < 32KB  → 恢复 worker     │
                                │                            │
                                └──── WebSocket ──▶ 按 seq 合并
                                                           ▼
                                                     渲染文本
```

每项需求如何满足：

- **NDJSON**：对人类可读、原生 Node、无需构建步骤。流断掉时，第一步调试就是 `tail` 或 `cat` worker stdout。每行是一个 JSON 帧。
- **`seq`**：单个进程局部计数器在帧创建时盖章。计数器只增不减。前端按 `seq` 合并帧，而不是按到达时间。这样把分布式排序问题简化为一次前端排序。
- **背压**：数据不应在应用内存中累积。当 `ws.bufferedAmount` 超过 128 KB，`ws-server.mjs` 调用 `worker.stdout.pause()`。OS stdout pipe 填满。worker 的下一次 `write()` 返回 false，worker 等待 `'drain'`，SDK 的 `for await` loop 停滞。LLM 网关实际上被放缓。当缓冲降到 32 KB 以下，调用 `resume()`，管道重启。唯一的缓冲是 OS pipe，它本身有界。
- **text 批处理**：`text_delta` 事件按 100 ms 批量，避免每秒重渲染 100 次。非 text 事件（`tool_progress`、`result`）立即转发，因为它们携带不应延迟的状态变化。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `ws-query-worker.mjs` | ~630–780 | `query()` loop + 带 seq 的 `writeFrame()` |
| `ws-server.mjs` | ~1170–1287 | readline 解析 → 转发 → 背压暂停/恢复 |
| `src/claude/adapters/ws-adapter.ts` | ~362–367 | WebSocket 单例 + 重连（最多 5 次，1 秒退避） |
| `ws-adapter.ts` | ~759–1577 | `ClaudeAgentWSAdapter.run()` 异步生成器 + 100 ms text 批处理 |
| `ws-adapter.ts` | ~576–595 | session init、messages loaded、approval request 的 `onMessage` 路由 |

背压代码故意很小：`if (bufferedAmount > 128000) worker.stdout.pause(); if (bufferedAmount < 32000) worker.stdout.resume();`。没有计数器、没有定时器、没有应用队列。唯一的缓冲是 OS pipe。

## 反直觉结论

> **流式最难的不是把字节推出去，而是防止快生产者和慢消费者一起把内存撑爆。答案不是应用队列，而是操作系统 pipe 背压。**

添加应用层发送队列只是把无界增长从 WebSocket 缓冲移到队列里。Kin 相反：它添加零应用缓冲，让 OS pipe 背压一路回传到 SDK 的异步生成器。客户端跟不上时，LLM 网关本身也会慢下来。

`seq` 字段是分布式排序的最便宜方案。在帧创建时做一次进程局部递增，就替代了重试、确认和滑动窗口，只需前端一次排序。

## 生产坑

- **重连/resume 时进行中的帧会丢失**。协议没有帧重放缓冲。用户切换会话或刷新时，worker 已发出但尚未渲染的帧会丢失。前端可以检测缺失的 `seq` 值，但服务器没有存储可以重放。一个按最后 seen `seq` 索引的有界环形缓冲是修复方向。
- **32 位 `seq` 回绕和超大单帧**：`seq` 是 32 位整数，超长运行后可能回绕。更实际的是，`readline` 读到 `\n` 才结束；单帧超过 64 KB 会在换行到达前持续累积内存，绕过 128 KB 背压阈值，因为该阈值测量的是 WebSocket 发送缓冲，而不是解析器状态。
- **worker stderr 不会转发给客户端**：stdout 是协议通道；stderr 只在服务器端记录。前端沉默不代表 worker 健康。服务器日志是故障真相来源。

这些都是同一权衡的后果：协议为简单性、可观测性和排序优化，而不是可靠交付。对常见情况这是正确权衡；对边界情况，缺失项是已知并已记录的。

## 相关 Kin 文档

- `ws-query-worker.mjs` — 帧写入与 SDK loop
- `ws-server.mjs` — 帧解析与背压
- `src/claude/adapters/ws-adapter.ts` — 浏览器端适配器与重连
- `03-per-message-worker-model.md` — 为什么每个消息生成新进程
- `13-single-host-concurrency.md` — 并发与背压交互

## 配图

1. `docs/blog/assets/img/04-event-pipeline.svg` — 从 SDK 到浏览器 store 的事件管道
2. `docs/blog/assets/img/04-backpressure.svg` — bufferedAmount 阈值与 worker stdout 暂停
