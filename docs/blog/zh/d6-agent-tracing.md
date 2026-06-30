---
title: "Agent / RAG 追踪 — 从 seq 事件流到 span 与每次检索 trace"
slug: d6-agent-tracing
date: 2026-06-07
keywords: [可观测性, 追踪, span, RAG 指标, seq 事件流, 检索 trace]
---

# Agent / RAG 追踪 — 从 seq 事件流到 span 与每次检索 trace

Kin 已有应用级可观测性：PostHog 行为、Sentry 错误、`audit_log` 安全。缺失的是步骤级 agent 追踪和 RAG 检索指标。本课描述设计与部分落地情况。

## 状态

RAG 检索 trace 表：已实现。从 seq 事件流导出的 agent 级 span：未实现。

## 问题

当 agent 运行变慢、出错或偏离主题时，团队必须能回答：哪个步骤卡了、调用了哪个工具、哪次检索返回了什么、每个步骤消耗多少 token。目前 worker 只 emit `console.error`，难以查询和回放。

## 为什么朴素方案失败

- **控制台日志**：不可查询、不可聚合，还需要 SSH 进服务器。
- **仅应用指标**：只能告诉你错误上升了，但不知道哪个会话的哪步失败。
- **仅端到端延迟**：无法区分慢 LLM 调用、慢工具调用或慢检索。

## 设计

> **worker 已经产生的 seq 事件流就是一种 trace。添加一个 exporter，把这些事件转换为追踪后端的 span。辅以 `kb_search` 的每次检索内部指标。**

- **Seq 事件作为 span**：worker 每个 `seq` 编号事件都可以成为带顺序和计时的 span。这复用了为前端渲染而建的流。
- **步骤级 token 与延迟**：把 token 用量和墙上时间附加到每个 span。
- **RAG 检索指标**：每次 `kb_search` 调用记录查询、召回腿、融合、rerank 和返回 passages。
- **后端**：导出到 Langfuse 或 OpenTelemetry。需要采样和异步导出，避免拖慢 worker 热路径。

## 实际落地了什么

RAG 检索有了自己的专用 trace 表，而不是从 seq 流推导。seq 流方法无法拿到检索内部数据，因为关键中间产物（向量召回、BM25 召回、RRF 融合、rerank 结果）不会流向前端。

- **`rag_search_trace`**：`src/db/schema/rag-trace.schema.ts` 记录每次 `kb_search` 执行，包括查询、可见文档数、向量 ID、BM25 ID、融合 ID、rerank ID、返回 ID、降级标志和延迟。

这个表回答“为什么这个答案错了”，通过暴露每个检索腿的输出以及最终集合如何组成。它是离线分析表，不是追踪后端里的实时 span。

## 仍然缺失什么

- **Agent 级 span exporter**：没有 seq 到 Langfuse/OTel 的 exporter。
- **步骤级 token 用量**：`usage_record` 仍在运行级别，而非工具或步骤级别。
- **实时追踪 UI**：trace 可通过 SQL 查询，但没有渲染为 span 时间线。

## 反直觉结论

> **复用现有信号是理想的可观测路径，但前提是你需要的数据确实流过这些信号。**

seq 事件流是 agent 高层步骤的好 trace，但不包含检索内部数据。当关键数据从未流过现有通道时，你必须建专用通道。教训是优先复用，但要识别何时复用不可能。

## 生产坑

- **Trace 不能包含敏感内容**。prompt 和检索文档在导出前应被红。
- **Span 导出必须异步且采样**。同步全量导出会拖慢流式 worker。
- **`seq` 是 32 位计数器**。如果用作超长运行的 span 排序键，需要处理回绕。

## 相关 Kin 文档

- `src/db/schema/rag-trace.schema.ts` — 每次检索 trace schema
- `src/server/rag/search.ts` — `searchKb()` 写入 `rag_search_trace`
- `zh/04-streaming-protocol.md` — seq 事件流
- `zh/18-billing-and-observability.md` — 可观测三条腿与 `usage_record`
- `zh/d1-advanced-rag.md` — RAG 实现

## 配图

1. `docs/blog/assets/img/d6-seq-to-span.svg` — seq 事件流分岔到 UI 和追踪后端
2. `docs/blog/assets/img/d6-step-metrics.svg` — 步骤级 token 与延迟指标
