---
title: "Evaluation — golden sets, retrieval/generation metrics, offline + online, and regression gates"
slug: d4-evaluation
date: 2026-06-07
keywords: [evaluation, golden set, RAGAS, retrieval metrics, generation metrics, regression gate]
---

# Evaluation — golden sets, retrieval/generation metrics, offline + online, and regression gates

Evaluation was originally a design-only capability. Building RAG forced it into existence. This lesson describes the retrieval evaluation that exists, the generation evaluation that does not, and how evaluation changed a concrete design decision.

## Status

Retrieval evaluation: implemented. Generation evaluation and CI regression gate: not yet implemented.

## The problem

Every change to chunking, embedding, rerank, or prompts can make the system better or worse. Without repeatable metrics, optimization is guesswork and regressions go unnoticed.

## Why the naive options fail

- **Manual spot-checking**: misses regressions and cannot scale.
- **Online-only feedback**: too slow and too late; cannot block a bad merge before it reaches users.
- **End-to-end testing only**: a bad answer could be caused by retrieval, reranking, or generation. Testing only the final answer hides where the failure is.

## The design

> **A curated golden set per knowledge base, split by retrieval-leg type, with layered retrieval and generation metrics, run offline in CI and supplemented by online signals.**

- **Golden set**: maintain a set of questions, expected relevant chunks, and expected answers. Questions should be typed by the retrieval skill they exercise: keyword, paraphrase, entity, and clause.
- **Layered metrics**: retrieval metrics (Recall@K, MRR, NDCG) and generation metrics (faithfulness, answer relevance, citation correctness).
- **Offline CI**: run the evaluation on every merge as a regression gate. Key metrics falling below a threshold block the merge.
- **Online**: sample usage and feedback from `usage_record` and `audit_log` to catch long-tail issues.

## What actually landed

The retrieval evaluation layer was built alongside RAG and drove one major design reversal.

- **Golden set typed by retrieval leg**: `tests/golden/rag-golden-set.ts` contains questions categorized as keyword, paraphrase, entity, or clause. This prevents a single category (such as paraphrase) from making one retrieval leg look useless.
- **Ablation modes**: `scripts/rag-eval-v2.ts` reports `R@1`, `R@4`, and `R@8` plus MRR, and runs in three modes: vector-only, hybrid, and hybrid+rerank. This isolates the contribution of each leg.
- **Rerank default turned off**: evaluation showed that at production `k=8`, rerank did not improve `R@8`. The model reads all 8 passages, so reranking them only changed order without improving recall, while adding ~1.4 seconds per query. Rerank is now controlled by `RAG_RERANK_ENABLED` and defaults to false.

## What is still missing

- **Generation metrics**: faithfulness, answer relevance, and LLM-as-judge scoring are not yet implemented.
- **CI regression gate**: `scripts/rag-eval-v2.ts` is run manually. It is not yet part of `.github/workflows`.

## The counter-intuitive conclusion

> **Evaluation is not a post-feature checklist; it is a prerequisite for optimization.**

Without repeatable metrics, no design change can be proven better or worse. The value of evaluation is not only proving that an approach works; it is discovering that an approach does not work before it is baked into production. The rerank reversal is the canonical example.

## Production pitfalls

- **Golden sets go stale**. Update them as the knowledge base changes.
- **LLM-as-judge has variance**. Fix the judge model and average over multiple samples.
- **End-to-end tests mask layered failures**. Report retrieval and generation metrics separately.

## Related Kin documentation

- `scripts/rag-eval-v2.ts` — retrieval evaluation script
- `tests/golden/rag-golden-set.ts` — typed golden set
- `src/server/rag/search.ts` — `searchKb()` and rerank toggle
- `d1-advanced-rag.md` — RAG implementation and rerank reversal
- `17-billing-and-observability.md` — usage and audit signals

## Diagrams

1. `docs/blog/assets/img/d4-layered-eval.svg` — retrieval metrics + generation metrics
2. `docs/blog/assets/img/d4-eval-pipeline.svg` — offline golden set CI gate + online signals
