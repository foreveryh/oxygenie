---
title: "计费与可观测性 — usage_record、为什么 costUsd 不是账单，以及三条可观测腿"
slug: 18-billing-and-observability
date: 2026-06-07
keywords: [billing, quota, usage_record, costUsd, PostHog, Sentry, audit log]
---

# 计费与可观测性 — `usage_record`、为什么 `costUsd` 不是账单，以及三条可观测腿

Kin 运行在固定价格的 ARK 套餐上，因此 SDK 的 `costUsd` 字段与真实支出没有直接关系。本课描述 Kin 如何设计为观测优先的计费系统、三条可观测腿是什么，以及为什么审计日志故意不 foreign-key 到用户表。

## 问题

多用户工作台共享一个 ARK 预算。如果不治理，一个用户的大运行可能消耗整月额度。在开启计费前必须回答两个问题：

1. **测量什么？** `costUsd` 在每个 `result` 事件中可用，但它从 Anthropic 公开价格估算，与实际 ARK 账单无关。
2. **何时执行？** 在了解典型使用分布前就设置配额，会导致要么过于宽松、要么过于严格的门。

此外，多用户系统需要回答安全问题：谁做了什么、何时、从哪。

## 为什么朴素方案失败

- **按 `costUsd` 计费**：这个数字与实际支付模型无关。它会误导用户并扭曲成本决策。
- **立即执行配额**：在测量真实使用前选择的配额阈值是猜测。它会制造挫败感而没有证据。
- **把 `audit_log.userId` foreign-key 到用户表**：用户删除时，审计记录要么被孤立，要么被级联删除。在安全调查中，被删除的用户正是最需要追踪的。

## 核心设计

> **计费观测优先：`usage_record` 是只读账本，token 是可信指标，配额只在转换率校准后执行。可观测性由三条独立腿组成：PostHog 行为、Sentry 错误、append-only `audit_log` 安全。**

- **只读账本**：`usage_record` 按模型每运行一行，记录 `inputTokens`、`outputTokens`、`costUsd`（仅参考）、`numTurns`、`isError`。它在任何收费或门生效前先运行一段时间，积累真实使用数据。
- **基于 token 的 credit 抽象**：内部计费单位是 credit。`1 credit = N tokens`，每个模型可配置。这使用户与网关和模型变化隔离。`costUsd` 从不进入收费路径。
- **计费表已就绪但尚未 gate**：`plans`、`subscriptions`、`credit_balances`、`credit_ledger`、`invoices` 已存在，Polar webhook 已接入。门逻辑尚未连接到生产运行流。
- **可观测三条腿**：
  - **PostHog**：行为事件，`sessionId` 截断到 8 位保护隐私。
  - **Sentry**：前后端错误。
  - **`audit_log`**：append-only 安全事件，含 `action`、`target`、`meta`、`ip`。`userId` 是普通列，不是外键，因此用户删除后审计记录仍保留。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/db/schema/usage-record.schema.ts` | ~L24–67 | 每模型用量行；`costUsd numeric(14,6)` 注释为“不用于计费” |
| `src/server/usage/build-usage-rows.ts` | ~L49–83 | SDK `result` → 每模型一行，`'unknown'` 兜底 |
| `src/db/schema/billing.schema.ts` | ~L52–101 | credit balances、ledger、invoices |
| `src/lib/observability/posthog-events.ts` | ~L7–99 | 带 session ID 截断的行为事件 |
| `src/db/schema/audit-log.schema.ts` | ~L17–46 | append-only 审计日志，userId 非 FK |

## 反直觉结论

> **计费系统首先要建的不是收费路径，而是观测路径。**

收费逻辑很小。困难部分是从 token 到 credit 的转换率。这个转换率必须从真实使用数据推导；不能猜测。在 SDK 成本估算与实际支付模型不匹配的部署中，可观测性是唯一诚实的计费基础。同样的独立性也体现在审计日志：不可变性比引用完整性更重要。

## 生产坑

- **不要把 `costUsd` 显示为真实账单**。它只是参考值。Schema 和 UI 必须保持这个区分。
- **目前没有配额 gate 生效**。系统记录使用但不按余额阻止运行。不要假设计费表在执行限制。
- **`audit_log` 无界增长**。它是 append-only。长期部署需要规划分区或归档。
- **`costUsd` 在 Drizzle 中是字符串**。直接求和前需要转换。

## 相关 Kin 文档

- `src/db/schema/usage-record.schema.ts` — 用量账本 schema
- `src/db/schema/billing.schema.ts` — 计费表
- `src/server/usage/build-usage-rows.ts` — 用量行构造
- `src/lib/observability/posthog-events.ts` — PostHog 事件
- `src/db/schema/audit-log.schema.ts` — 审计 schema
- `zh/12-session-persistence.md` — transcript 与用量注意事项
- `zh/14-multi-model-routing.md` — 非 Claude 模型的 token 统计

## 配图

1. `docs/blog/assets/img/17-billing-phases.svg` — 观测 → 校准 → 配额
2. `docs/blog/assets/img/17-observability.svg` — PostHog / Sentry / audit_log
