---
title: "回顾 — 从 AI SDK starter 到自托管 agent 平台：胜利、债务与耦合"
slug: 20-retrospective
date: 2026-06-07
keywords: [retrospective, 架构反思, Claude Agent SDK, 技术债务, Kin]
---

# 回顾 — 从 AI SDK starter 到自托管 agent 平台：胜利、债务与耦合

Kin 从官方 AI SDK starter 起步，成长为自托管、单组织、多用户的 agent 工作台。本回顾审视哪些决策被证明正确，哪些变成了债务，以及哪些是能力与 SDK 耦合之间的权衡。

## Kin 建造了什么

核心命题是：**不要自己写 agent loop；把所有工程精力放在 SDK 周围的层**。Claude Agent SDK 的 `query()` 处理 LLM loop、上下文压缩和 token 统计。Kin 的工作是围绕它的 15 层：执行、工具扩展、沙箱、权限、隔离、持久化、并发、多模型路由、artifact 预览、计费、部署。

这些层没有一个是可选的。每个都被具体产品需求所迫：多用户风险的隔离、刷新后的持久化、16 GB 主机上的并发限制、任意代码执行的沙箱、真实 VPS 上的部署。

## 四个正确决策

1. **包裹 SDK，不重写 loop**。省掉的不仅是代码；还能跟随 SDK 在工具、上下文管理和 token 统计上的改进。
2. **per-message 子进程作为隔离原语**。进程边界一次性提供隔离、可中断性和状态清洁。它们让并发预算变得简单。
3. **ExecutionRuntime 抽象 + FAIL-CLOSED**。单一接口带“不安全则拒绝”契约，防止最危险的失效模式：静默回退到无保护执行。
4. **观测优先计费**。`usage_record` 在成为计费来源之前是只读账本。配额在从真实数据校准 token 到 credit 的转换率之前不会执行。

## 五笔债务

1. **会话 UI 缺少 seq 排序**。worker 协议已经带 `seq`，但前端 store 尚未按它合并渲染。这导致偶尔队列停滞和 resume 后的消息重影。
2. **Structured outputs 因 SDK stop-hook 污染而关闭**。回退是启发式 + manifest 检测。局部脆弱但全局安全。
3. **per-message worker 和 per-session preview 是两个运行时**。agent 是每消息无状态的；preview 是每会话持久的。两者共享同一 workspace 但有不同生命周期。这是剩余最大的架构张力。
4. **Skills copy-on-enable 随用户线性增长**。100 个用户启用同一 skill 就创建 100 个副本。计划修复为数据库 catalog + 懒文件系统物化。
5. **Resume 曾因 `claudeHomePath` 存为相对路径而中断**。worker 和 ws-server 运行在不同工作目录。相对路径是跨进程 bug。现在强制使用绝对路径。

## 两个已成为耦合的权衡

1. **为多模型路由把 SDK 锁定到 0.2.112**。这通过单一协议廉价获得多个模型，但牺牲了版本自由。0.2.113+ 使用与 ARK 网关不兼容的原生二进制。未来应急路径是迁移到原生 Anthropic + 原生二进制。
2. **SDK transcript 作为真相**。这是起点最便宜的方案，因为 SDK 已经在写 transcript。但它让 resume 脆弱——transcript 缺失时 UI 没有回退。计划是让数据库成为真相，transcript 作为缓存。

两个权衡共享一个模式：**它们把基础交给上游 SDK 以换取早期速度**。团队小时这是有效选择，但必须被跟踪并有意识地偿还。

## 三个小团队权衡

- **单机 Compose 而不是 Kubernetes**。Kubernetes 对目标规模过度工程。
- **Idle reaper 默认关闭**。小团队几个空闲容器可以接受；回收复杂度可以延后。
- **计费记录但不 gate**。在校准前 built gate 是注意力浪费。

## 已知下一步

- 统一 per-message 和 per-session 运行时。
- 给前端 store 增加 seq 排序和去重。
- 翻转持久化：数据库拥有消息真相，transcript 作为缓存。
- 转换率校准后连接配额 gate。
- 把 Skills copy-on-enable 替换为数据库 catalog + 懒加载。
- 规划离开 0.2.112 锁定路径。

## 反直觉结论

> **包裹官方 SDK 省掉了内核，但制造了耦合。Kin 最好的决策和最大的债务是同一枚硬币的两面。**

建立在第三方 SDK 上的系统的成熟度，不在于是否使用 SDK，而在于是否清楚自己把控制权交给了 SDK，并有计划把它收回。Kin 把 loop、模型版本、transcript 格式交给了 SDK，但跟踪了每一次交出，并为每一次都准备了应急方案。这是诚实的工程姿态：使用 SDK，知道代价，并保持出口标记清晰。

## 相关 Kin 文档

- `docs/project/VISION.md` — 产品定位与威胁模型
- `docs/project/ROADMAP.md` — 当前阶段计划
- `docs/project/STATUS.md` — 实时状态与决策日志
- `zh/01-what-is-agent-harness.md` — 15 层栈
- `zh/17-projects-and-branch-on-reply.md` — 协作与 branch-on-reply

## 配图

1. `docs/blog/assets/img/19-tradeoff-matrix.svg` — 胜利 vs 债务
2. `docs/blog/assets/img/19-sdk-coupling-map.svg` — SDK 耦合点与逃生路线
