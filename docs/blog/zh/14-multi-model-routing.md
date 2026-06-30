---
title: "多模型路由 — ARK 网关、模型别名与 SDK 0.2.112 锁定"
slug: 14-multi-model-routing
date: 2026-06-07
keywords: [多模型, ARK, 模型别名, ANTHROPIC_AUTH_TOKEN, SDK 版本锁定]
---

# 多模型路由 — ARK 网关、模型别名与 SDK 0.2.112 锁定

Kin 不只运行 Claude。它还通过字节跳动 ARK 网关运行 GLM、Doubao、DeepSeek、Kimi 和 MiniMax。机制是协议复用：Claude Agent SDK 说 Anthropic 协议，ARK 网关接受 Anthropic 协议。本课解释“把 base URL 指向 ARK”如何启用多模型，以及为什么这个策略把 SDK 锁定到版本 0.2.112。

## 问题

团队希望不同任务用不同模型——日常任务用便宜模型，困难任务用强模型。agent 周围的 harness（worker、流式、并发、持久化）在模型变化时不应改变。挑战是避免为每个厂商维护独立 SDK 或适配器。

## 为什么朴素方案失败

- **多个 SDK 加路由器**：维护 Anthropic、GLM、Doubao 等 SDK 制造 N 个适配器和脆弱的胶水层。这也违反“不引入第二个 agent 运行时”的规则。
- **运行时模型选择 API**：模型选择是低频配置。在 ws-server 和 worker 之间增加每次查询的 RPC 来选择模型，会给热路径增加延迟，没有收益。

## 核心设计

> **ARK 充当协议翻译器。SDK 把 Anthropic 请求发到指向 ARK 的 `ANTHROPIC_BASE_URL`。ARK 把请求路由到实际模型。模型选择被简化成环境别名，在 worker 生成时注入。**

```
worker query() ── Anthropic 协议 ──▶ ANTHROPIC_BASE_URL
   （以为自己跟 Claude 说话）          Bearer: ANTHROPIC_AUTH_TOKEN
                                                       │
                                                       ▼
                                            ARK /api/coding
                                            按模型别名路由：
                                            ├─ glm-5.1
                                            ├─ doubao-...
                                            ├─ deepseek-...
                                            ├─ kimi-...
                                            └─ minimax-...
```

要点：

- **ARK 接受 Anthropic 协议**：这就是整个技巧。SDK 不需要知道网关后面是哪个模型。
- **只用 Bearer token**：设置 `ANTHROPIC_AUTH_TOKEN`。**不要**设置 `ANTHROPIC_API_KEY`，因为当该变量存在时，SDK 会把请求格式改为 `x-api-key`，ARK 会拒绝。
- **模型别名把努力层级映射到真实模型**：`ANTHROPIC_MODEL`（主模型）、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`。例如，SDK 的便宜“haiku”层级可以映射到 `doubao-seed-2.0-lite`。
- **配置在生成时注入**：ws-server 读取配置，写入 worker 的环境变量，然后生成 worker。不需要运行时 RPC。
- **SDK 钉死在 0.2.112**：0.2.113+ 切换到原生二进制，与 ARK 传统 API 不兼容。依赖必须精确：`"0.2.112"`，不是 `^0.2.112` 或 `~0.2.112`。

## 反直觉结论

> **多模型路由不需要多个 SDK。一个共享协议吸收了适配器复杂度。**

这个免费适配器的代价是硬版本锁定。项目不写模型适配器，而是依赖 ARK 的协议翻译。这个选择只在 SDK 版本保持兼容时有效。版本锁定就是免费适配器的账单。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `ws-server.mjs` | ~L106–111 | 读取 `ANTHROPIC_*` 配置 |
| `ws-server.mjs` | ~L1058–1070 | 注入 worker 环境，包括 `ANTHROPIC_API_URL` 别名 |
| `ws-query-worker.mjs` | ~L23–26 | 读取环境并传给 `query()` |
| `package.json` | — | 精确 `@anthropic-ai/claude-agent-sdk: "0.2.112"` |

## 生产坑

- **ARK 场景下不要设置 `ANTHROPIC_API_KEY`**。SDK 会改用 `x-api-key` 认证，ARK 返回 401。只使用 `ANTHROPIC_AUTH_TOKEN`。
- **不要允许浮动版本**。`^0.2.112` 可能解析到 0.2.113+，破坏 ARK 兼容性。精确锁定并保护 lockfile。
- **非 Claude 模型的 token 统计不完整**。SDK 的 usage 字段是为 Anthropic 模型校准的。通过 ARK 路由的模型可能返回不完整 token 数。把 `costUsd` 当作估算，不是计费来源。
- **没有自动回退**。如果所选模型不可用，查询失败。高可用切换必须在 harness 之上构建。

## 相关 Kin 文档

- `ws-server.mjs` — 模型配置注入
- `ws-query-worker.mjs` — 环境读取与 `query()` 选项
- `CLAUDE.md` — SDK 版本与 ARK 规则
- `zh/12-session-persistence.md` — 用量统计注意事项

## 配图

1. `docs/blog/assets/img/14-ark-routing.svg` — Anthropic 请求路径穿过 ARK
2. `docs/blog/assets/img/14-version-lock.svg` — SDK 0.2.112 兼容窗口
