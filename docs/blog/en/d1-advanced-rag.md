---
title: "Advanced / Agentic RAG — from empty schema to an agent-driven retrieval tool"
slug: d1-advanced-rag
date: 2026-06-07
keywords: [Agentic RAG, Advanced RAG, pgvector, embedding, rerank, hybrid search, MCP retrieval tool]
---

# Advanced / Agentic RAG — from empty schema to an agent-driven retrieval tool

This lesson describes how Kin built RAG. It is the only design-era capability that has been fully shipped to production. The lesson covers the initial reasoning, the implementation that landed, and the five ways reality corrected the design.

## The problem

Kin is a private team knowledge workspace. Users expect the agent to answer from internal documents rather than hallucinate. The retrieval system must satisfy four requirements:

1. **Semantic recall**: a question about "last year's refund policy" should match a document section titled "after-sales service clause 3" even without keyword overlap.
2. **Single-organization multi-user isolation**: user A must not see user B's documents.
3. **Context discipline**: a knowledge base may contain thousands of chunks; the system must not stuff them all into the prompt.
4. **No loop rewrite**: retrieval must plug into the SDK's existing tool mechanism.

## The initial gap

At the start, Kin had the schema but not the pipeline:

- `documentChunks` had an `embedding` column but never wrote to it.
- `documentChunkRepo` existed but was unused.
- `markitdown-mcp` was installed but never called by the ingestion path.
- The only search was Meilisearch BM25; no vector, no rerank, no hybrid.
- `ws-query-worker.mjs` registered no `kb_search` tool.

The missing piece was not the schema. It was the end-to-end chain from parsing to retrieval.

## Why common approaches fail

- **Static retrieve-then-generate**: retrieving top-K before every `query()` call bloats the context when the question does not need retrieval and removes the agent's control over when and how to search.
- **Vector-only or keyword-only**: keyword-only misses paraphrases; vector-only misses exact product names or error codes.
- **Embed at query time**: indexing thousands of chunks on every query is too slow.
- **Let the agent grep files**: this works only for small workspaces and has no semantic recall.

## The design

> **RAG is not a pre-query pipeline. It is an MCP tool called `kb_search` that the agent decides to invoke. Offline, documents are parsed, chunked, and embedded into pgvector. Online, the tool runs vector + BM25 hybrid recall, RRF fusion, optional rerank, and small-to-big parent retrieval, with SQL-level isolation by `userId` and `kbId`.**

```
Offline (BullMQ job)                         Online (MCP tool in worker)
file → parse → chunk → embed → pgvector    Agent decides to search → kb_search(query,k)
   → content_hash dedup                        │
                                                ├─ vector recall (pgvector) ∥ BM25 (Meili)
                                                ├─ RRF fusion → optional rerank
                                                └─ small-to-big parent retrieval
                                                   returns top-K passages with page citations
                                                   WHERE userId=? AND kbId IN (...)
```

- **Offline**: parse documents with a parser sidecar, structure-chunk them, embed with the chosen provider, write to `documentChunks` with HNSW indexing.
- **Online**: the agent calls `kb_search` like any other tool. The tool runs parallel vector and BM25 recall, fuses with RRF, optionally reranks, and returns the top passages.
- **Isolation**: the SQL `WHERE` clause filters by user and knowledge-base membership before any similarity scoring happens.

## What the implementation changed

The core design was correct, but five specifics changed when the system was built:

1. **Embedding dimension**: the design assumed 1536 (OpenAI default). Production uses `doubao-embedding-vision` and Zhipu embedding-3 at **1024** dimensions. The provider chooses the dimension, not the designer.
2. **Parser**: the design planned to use `markitdown-mcp`. Production uses a dedicated **parser sidecar** (Java-based `opendataloader-pdf`) because markitdown did not produce page numbers, which are essential for citations.
3. **Chunking**: the design assumed recursive chunking with overlap. Production uses **structure-based chunking** with parent/child levels and no overlap, relying on `sectionPath` prefix injection and small-to-big retrieval for context.
4. **Rerank**: the design assumed rerank was a fixed pipeline stage. Evaluation showed that at production `k=8`, rerank did not improve recall because the model read all 8 passages anyway. Rerank is now off by default and enabled only by `RAG_RERANK_ENABLED`.
5. **Query rewriting / HyDE**: the design assumed an explicit query-rewrite step with a cheap model. Production found it unnecessary because the agent can simply call `kb_search` again with a different phrasing. The loop handles iteration.

## The last mile that the design missed

> **Registering the tool is not enough; the model must know the knowledge base exists.**

The tool was registered successfully, but the agent still went to web search for knowledge-base questions. The reason was that the agent had no idea what documents were available. The fix was to fetch a `/api/rag/overview` of the user's accessible documents and inject it into the system prompt as `kbInventoryInstructions`. Once the agent knew what it could retrieve, it used the tool correctly. This is a general lesson for any "agent calls retrieval" system: the agent needs both the tool and the inventory of what the tool can reach.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `src/server/rag/search.ts` | ~L85 | `searchKb()` — vector + BM25 + RRF + rerank + small-to-big |
| `src/server/rag/chunker.ts` | — | structure-based parent/child chunking |
| `src/server/rag/tier.ts` | ~L65 | document size tiering |
| `src/server/rag/parser-client.ts` | — | parser sidecar client |
| `parser-sidecar/server.mjs` | — | Java PDF parser + pageMap output |
| `src/server/rag/embedding.ts` | — | OpenAI-compatible embeddings endpoint |
| `src/server/rag/queue.ts` | — | BullMQ ingestion queue |
| `ws-query-worker.mjs` | ~L527–L580 | `kbSearchTool` registration and MCP server |
| `src/server/rag/flag.ts` | ~L13 | `RAG_ENABLED` master switch |
| `src/db/schema/rag-trace.schema.ts` | — | `rag_search_trace` per retrieval |

## The counter-intuitive conclusion

> **In a harness that wraps an Agent SDK, RAG is not a pre-generation pipeline. It is a tool the agent invokes.**

This is the cleanest way to fit RAG into the SDK's loop. The agent decides when to search, how to phrase the query, and whether to search again. The harness provides the tool, the indexing, the hybrid retrieval, and the isolation. Retrieve-then-generate is harness work; when-to-retrieve is the loop's work.

## Production pitfalls

- **Isolation must be in the SQL `WHERE`, not post-filtered**. Filtering after retrieval leaks documents and biases results.
- **Embedding is expensive and belongs offline**. Ingestion must be asynchronous and incremental, using `content_hash` to re-embed only changed chunks.
- **Do not use the SDK `query()` for embeddings**. The SDK is a chat interface. Use a separate OpenAI-compatible embeddings client pointing at the same gateway.
- **Page citations are the credibility signal**. Returned passages include `[n] title — section (p.21) body`, and the frontend renders `[1][2]` as clickable chips that pop up the original passage. This matters more than abstract recall scores for non-technical users.
- **Only documents with `ingestStatus='ready'` are searchable**. Searching while chunks are still being embedded surfaces half-finished results.

## Related Kin documentation

- `src/server/rag/search.ts` — `searchKb()` and hybrid retrieval
- `src/server/rag/chunker.ts` — structure chunking
- `src/server/rag/embedding.ts` — embeddings client
- `src/server/rag/queue.ts` — ingestion queue
- `ws-query-worker.mjs` — `kb_search` tool registration
- `d4-evaluation.md` — RAG evaluation and how it drove the rerank decision
- `d5-guardrails.md` — retrieval guardrails for the returned documents
- `d6-agent-tracing.md` — `rag_search_trace` observability

## Diagrams

1. `docs/blog/assets/img/d1-rag-gap.svg` — empty schema vs agentic RAG
2. `docs/blog/assets/img/d1-agentic-rag.svg` — offline ingestion + online hybrid retrieval
3. `docs/blog/assets/img/d1-retrieval-as-tool.svg` — `kb_search` inside the agent loop
