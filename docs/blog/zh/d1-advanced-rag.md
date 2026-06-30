---
title: "高级 / Agentic RAG — 从空 schema 到 agent 驱动的检索工具"
slug: d1-advanced-rag
date: 2026-06-07
keywords: [Agentic RAG, Advanced RAG, pgvector, embedding, rerank, 混合搜索, MCP 检索工具]
---

# 高级 / Agentic RAG — 从空 schema 到 agent 驱动的检索工具

本课描述 Kin 如何构建 RAG。它是设计时代唯一已整条落地的能力。课程涵盖最初思考、实际落地方案，以及现实修正设计的五个方面。

## 问题

Kin 是私有团队知识工作台。用户期望 agent 从内部文档回答，而不是幻觉。检索系统必须满足四个需求：

1. **语义召回**：关于“去年退款政策”的问题应该匹配标题为“售后条款 3”的文档段落，即使没有关键词重叠。
2. **单组织多用户隔离**：用户 A 不能看到用户 B 的文档。
3. **上下文纪律**：知识库可能包含数千个 chunk；系统不能把它们全部塞进 prompt。
4. **不改造 loop**：检索必须接入 SDK 现有工具机制。

## 初始缺口

一开始，Kin 有 schema 但没有管线：

- `documentChunks` 有 `embedding` 列但从没写入。
- `documentChunkRepo` 存在但未被使用。
- `markitdown-mcp` 已安装但未被摄入路径调用。
- 唯一搜索是 Meilisearch BM25；没有向量、没有 rerank、没有混合。
- `ws-query-worker.mjs` 没有注册 `kb_search` 工具。

缺失的不是 schema，而是从解析到检索的端到端链。

## 为什么常见方案失败

- **静态检索再生成**：在每次 `query()` 前检索 top-K，会在问题不需要检索时膨胀上下文，并移除 agent 对何时、如何搜索的控制权。
- **纯向量或纯关键词**：纯关键词漏掉同义改写；纯向量漏掉精确产品名或错误码。
- **查询时嵌入**：每次查询时索引数千个 chunk 太慢。
- **让 agent grep 文件**：这只对小工作区有效，没有语义召回。

## 设计

> **RAG 不是预查询管线。它是一个叫 `kb_search` 的 MCP 工具，由 agent 决定是否调用。离线，文档被解析、切块、嵌入到 pgvector；在线，工具运行向量 + BM25 混合召回、RRF 融合、可选 rerank、small-to-big parent 回取，并通过 SQL 层的 `userId` 和 `kbId` 隔离。**

```
离线（BullMQ 任务）                          在线（worker 中的 MCP 工具）
file → parse → chunk → embed → pgvector    Agent 决定搜索 → kb_search(query,k)
   → content_hash 去重                        │
                                                ├─ 向量召回（pgvector）∥ BM25（Meili）
                                                ├─ RRF 融合 → 可选 rerank
                                                └─ small-to-big parent 回取
                                                   返回带页码引用的 top-K passages
                                                   WHERE userId=? AND kbId IN (...)
```

- **离线**：用 parser sidecar 解析文档，结构切块，用选定 provider 嵌入，写入带 HNSW 索引的 `documentChunks`。
- **在线**：agent 像调用其他工具一样调用 `kb_search`。工具并行运行向量和 BM25 召回，RRF 融合，可选 rerank，返回 top passages。
- **隔离**：SQL `WHERE` 在任何相似度评分之前先按用户和知识库成员关系过滤。

## 实现修正了哪些设计

核心设计正确，但系统构建时五个具体细节变了：

1. **嵌入维度**：设计假设 1536（OpenAI 默认）。生产使用 `doubao-embedding-vision` 和智谱 embedding-3，维度是 **1024**。维度由 provider 决定，不是设计者。
2. **解析器**：设计计划用 `markitdown-mcp`。生产使用专用 **parser sidecar**（基于 Java 的 `opendataloader-pdf`），因为 markitdown 不产生页码，而页码对引用至关重要。
3. **切块**：设计假设带重叠的递归切块。生产使用 **结构切块**，有 parent/child 层级，无重叠，靠 `sectionPath` 前缀注入和 small-to-big 检索补上下文。
4. **Rerank**：设计假设 rerank 是固定管线阶段。评估显示在生产 `k=8` 时，rerank 没有提升召回，因为模型反正会读全部 8 个 passages。rerank 现在默认关闭，仅由 `RAG_RERANK_ENABLED` 启用。
5. **查询改写 / HyDE**：设计假设用便宜模型做显式查询改写。生产发现不需要，因为 agent 可以简单地用不同措辞再次调用 `kb_search`。loop 自己处理迭代。

## 设计遗漏的最后一公里

> **只注册工具不够；模型必须知道知识库存在。**

工具注册成功，但 agent 遇到知识库问题时仍去网络搜索。原因是 agent 不知道有哪些文档可用。修复方案是获取用户可访问文档的 `/api/rag/overview`，并作为 `kbInventoryInstructions` 注入系统提示。一旦 agent 知道能检索什么，它就能正确使用工具。这对任何“agent 调用检索”的系统都是通用教训：agent 需要工具，也需要工具能触及的清单。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/server/rag/search.ts` | ~L85 | `searchKb()` — 向量 + BM25 + RRF + rerank + small-to-big |
| `src/server/rag/chunker.ts` | — | 结构 parent/child 切块 |
| `src/server/rag/tier.ts` | ~L65 | 文档大小分层 |
| `src/server/rag/parser-client.ts` | — | parser sidecar 客户端 |
| `parser-sidecar/server.mjs` | — | Java PDF 解析器 + pageMap 输出 |
| `src/server/rag/embedding.ts` | — | OpenAI 兼容的嵌入端点 |
| `src/server/rag/queue.ts` | — | BullMQ 摄入队列 |
| `ws-query-worker.mjs` | ~L527–L580 | `kbSearchTool` 注册与 MCP 服务器 |
| `src/server/rag/flag.ts` | ~L13 | `RAG_ENABLED` 总开关 |
| `src/db/schema/rag-trace.schema.ts` | — | 每次检索的 `rag_search_trace` |

## 反直觉结论

> **在包裹 Agent SDK 的 harness 中，RAG 不是预生成管线，而是 agent 调用的工具。**

这是把 RAG 适配进 SDK loop 的最干净方式。agent 决定何时搜索、如何措辞、是否再次搜索。harness 提供工具、索引、混合检索和隔离。retrieve-then-generate 是 harness 工作；when-to-retrieve 是 loop 的工作。

## 生产坑

- **隔离必须在 SQL `WHERE` 中，而不是后过滤**。后过滤会泄露文档并偏置结果。
- **嵌入昂贵，属于离线任务**。摄入必须是异步、增量的，用 `content_hash` 只重新嵌入变化的 chunk。
- **不要用 SDK `query()` 做嵌入**。SDK 是聊天接口。用单独的 OpenAI 兼容嵌入客户端指向同一网关。
- **页码引用是可信度信号**。返回的 passage 包含 `[n] 标题 — 段落 (p.21) 正文`，前端把 `[1][2]` 渲染为可点击 chip，弹出原文。对非技术用户这比抽象召回分数更重要。
- **只有 `ingestStatus='ready'` 的文档可搜索**。chunk 仍在嵌入时搜索会返回半成品结果。

## 相关 Kin 文档

- `src/server/rag/search.ts` — `searchKb()` 与混合检索
- `src/server/rag/chunker.ts` — 结构切块
- `src/server/rag/embedding.ts` — 嵌入客户端
- `src/server/rag/queue.ts` — 摄入队列
- `ws-query-worker.mjs` — `kb_search` 工具注册
- `zh/d4-evaluation.md` — RAG 评估如何驱动 rerank 决策
- `zh/d5-guardrails.md` — 返回文档的检索护栏
- `zh/d6-agent-tracing.md` — `rag_search_trace` 可观测

## 配图

1. `docs/blog/assets/img/d1-rag-gap.svg` — 空 schema vs agentic RAG
2. `docs/blog/assets/img/d1-agentic-rag.svg` — 离线摄入 + 在线混合检索
3. `docs/blog/assets/img/d1-retrieval-as-tool.svg` — agent loop 中的 `kb_search`
