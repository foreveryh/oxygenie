---
title: "Multi-Model Routing — ARK gateway, model aliases, and the SDK 0.2.112 pin"
slug: 14-multi-model-routing
date: 2026-06-07
keywords: [multi-model, ARK, model alias, ANTHROPIC_AUTH_TOKEN, SDK version pin]
---

# Multi-Model Routing — ARK gateway, model aliases, and the SDK 0.2.112 pin

Kin does not only run Claude. It also runs GLM, Doubao, DeepSeek, Kimi, and MiniMax through the ByteDance ARK gateway. The mechanism is protocol reuse: the Claude Agent SDK speaks the Anthropic protocol, and the ARK gateway accepts the Anthropic protocol. This lesson explains how "pointing the base URL at ARK" enables multiple models, and why that strategy locks the SDK to version 0.2.112.

## The problem

The team wants to use different models for different tasks — cheap models for routine work, stronger models for hard tasks. The harness around the agent (worker, streaming, concurrency, persistence) should not change when the model changes. The challenge is to avoid maintaining a separate SDK or adapter for each vendor.

## Why the naive options fail

- **Multiple SDKs with a router**: maintaining Anthropic, GLM, Doubao, and other SDKs creates N adapters and a fragile glue layer. It also violates the rule of not introducing a second agent runtime.
- **Runtime model selection API**: model choice is a low-frequency configuration. Adding a per-query RPC between ws-server and worker for model selection adds latency to the hot path for no benefit.

## The core design

> **ARK acts as a protocol translator. The SDK sends Anthropic requests to `ANTHROPIC_BASE_URL` pointing at ARK. ARK routes the request to the actual model. Model selection is reduced to environment aliases, injected at worker spawn time.**

```
worker query() ── Anthropic protocol ──▶ ANTHROPIC_BASE_URL
   (thinks it is talking to Claude)        Bearer: ANTHROPIC_AUTH_TOKEN
                                                       │
                                                       ▼
                                            ARK /api/coding
                                            routes by model alias:
                                            ├─ glm-5.1
                                            ├─ doubao-...
                                            ├─ deepseek-...
                                            ├─ kimi-...
                                            └─ minimax-...
```

Key points:

- **ARK accepts Anthropic protocol**: this is the entire trick. The SDK does not need to know which model is behind the gateway.
- **Bearer token only**: set `ANTHROPIC_AUTH_TOKEN`. Do **not** set `ANTHROPIC_API_KEY`, because the SDK changes its request format to `x-api-key` when that variable is present, and ARK rejects it.
- **Model aliases map effort tiers to real models**: `ANTHROPIC_MODEL` (main), `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, and `CLAUDE_CODE_SUBAGENT_MODEL`. For example, the SDK's cheap "haiku" tier can map to `doubao-seed-2.0-lite`.
- **Configuration is injected at spawn time**: ws-server reads the config, writes it into the worker's environment variables, and spawns the worker. No runtime RPC is needed.
- **SDK pinned to 0.2.112**: 0.2.113+ switched to a native binary that is not compatible with the ARK traditional API. The dependency must be exact: `"0.2.112"`, not `^0.2.112` or `~0.2.112`.

## The counter-intuitive conclusion

> **Multi-model routing does not require multiple SDKs. A shared protocol absorbs the adapter complexity.**

The cost of this free adapter is a hard version lock. The project does not write model adapters; it relies on ARK's protocol translation. That choice is valid only as long as the SDK version remains compatible. The version pin is the bill for the free adapter.

## Key implementation points

| File | Lines | Mechanism |
|---|---|---|
| `ws-server.mjs` | ~L106–111 | read `ANTHROPIC_*` config |
| `ws-server.mjs` | ~L1058–1070 | inject worker env, including `ANTHROPIC_API_URL` alias |
| `ws-query-worker.mjs` | ~L23–26 | read env and pass to `query()` |
| `package.json` | — | exact `@anthropic-ai/claude-agent-sdk: "0.2.112"` |

## Production pitfalls

- **Do not set `ANTHROPIC_API_KEY` with ARK**. The SDK switches to `x-api-key` authentication and ARK returns 401. Use only `ANTHROPIC_AUTH_TOKEN`.
- **Do not allow floating versions**. `^0.2.112` can resolve to 0.2.113+, which breaks ARK compatibility. Pin exactly and protect the lockfile.
- **Token accounting is incomplete for non-Claude models**. The SDK's usage fields are calibrated for Anthropic models. Models routed through ARK may not return complete token counts. Treat `costUsd` as an estimate, not a billing source.
- **No automatic fallback**. If the selected model is unavailable, the query fails. High-availability switching must be built above the harness.

## Related Kin documentation

- `ws-server.mjs` — model config injection
- `ws-query-worker.mjs` — env reading and `query()` options
- `CLAUDE.md` — SDK version and ARK rules
- `12-session-persistence.md` — usage accounting caveats

## Diagrams

1. `docs/blog/assets/img/14-ark-routing.svg` — Anthropic request path through ARK
2. `docs/blog/assets/img/14-version-lock.svg` — SDK 0.2.112 compatibility window
