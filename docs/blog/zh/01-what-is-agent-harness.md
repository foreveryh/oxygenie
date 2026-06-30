---
title: "什么是 Agent Harness — 当 SDK 给了你 Loop 之后，仍需建造的 15 层"
slug: 01-what-is-agent-harness
date: 2026-06-07
keywords: [Agent Harness, Claude Agent SDK, 自托管 AI Agent, 单组织多用户]
---

# 什么是 Agent Harness — 当 SDK 给了你 Loop 之后，仍需建造的 15 层

关于 Kin 有一个常见误解：它是一个“自己写 Agent Loop 的框架”。事实并非如此。**核心循环——调用 LLM → 解析 `tool_use` → 执行工具 → 反馈 → 重复——已经由 Claude Agent SDK 的 `query()` 提供。** SDK 同时处理上下文压缩、token 统计和工具协议。

Kin 添加的是一个**运行时 harness**：一组围绕 SDK 调用的层级，把一次无状态、单进程、单用户的 demo 调用，变成自托管、单组织、多用户的工作台。本课解释这些层级是什么、为什么每一层都不可或缺，以及什么时候值得自己建造 harness 而不是使用托管服务。

## 从 `query()` 到产品之间的鸿沟

调用 `query({ prompt, options })` 足够写三行 demo。SDK 会决定调用哪个工具、解析工具结果、反馈回去并返回 `result`。但默认调用是**无状态、单进程、单用户**的。把它投入团队使用会产生七类缺失能力：

1. **持久化**：`query()` 不会替你保存历史。刷新浏览器，对话就没了。
2. **隔离**：`query()` 在同个 Node 进程里执行工具。一个用户的失控 Python 循环可以拖垮整台服务器。
3. **并发限制**：没有治理器，几个并发消息就能让 16 GB 主机 OOM。
4. **弹性**：WebSocket 断连后没有恢复机制。
5. **安全**：没有沙箱、路径守卫或 secret 剥离。`rm -rf` 和凭证泄露只差一个 prompt。
6. **可扩展性**：添加内部工具、Skills 或 MCP 服务器需要每次都改核心代码。
7. **运维**：没有用量追踪、没有审计、没有部署流水线，组织无法采用。

这些不是可以逐一修补的 bug。它们是必须在产品能扛住真实使用前就设计好的架构层级。

## Kin 的 15 层（SDK 在第 0 层）

Kin 可以画成一个栈。第 0 层是 SDK 的 `query()`；第 1–15 层是 Kin 提供的 harness。

```
15. CI/CD + 部署（多阶段 Docker、GHCR、Dokploy、Traefik）
14. 可观测 + 审计（PostHog、Sentry、audit_log）
13. 计费 + 配额（usage_record、基于 token 的 credits）
12. 真预览（per-session Docker + 子域代理 + JWT）
11. 会话 UI / Workbench（turn card、artifact、seq 排序）
10. 多模型路由（ARK 网关、模型别名、钉死 SDK 版本）
 9. 并发 + 回收（信号量、堆上限、idle reaper）
 8. 会话持久化（SDK transcript 为真相，DB 为索引）
 7. 单组织多用户隔离（per-session workspace + 路径守卫）
 6. Bash 沙箱（srt/Docker + prlimit + secret 剥离）
 5. 权限 + HITL（Ask/Act + canUseTool 审批）
 4. 工具 / Skills / MCP（preset + 自定义 MCP + 文件系统启用）
 3. ExecutionRuntime 抽象（本地进程 / Docker 后端）
 2. 流式协议（NDJSON + seq + 背压）
 1. Per-Message Worker（每个用户消息一个子进程）
─────────────────────────────────────
 0. Claude Agent SDK query()（循环、上下文、工具协议）
```

关键点是这些层级都是**承重依赖**。第 1–3 层（per-message worker、流式协议、执行运行时）是基础。没有它们，并发限制、沙箱和隔离无处附着。第 4–8 层（工具、权限、沙箱、隔离、持久化）处理安全与记忆。第 9–15 层（并发、多模型、UI、预览、计费、可观测、部署）处理规模化与运维就绪。

每一层存在都是因为某个用户预期需要它。刷新页面期望历史还在，就需要第 8 层。期望用户 A 的代码不能读取用户 B 的文件，就需要第 7 层。期望模型不能删除任意文件，就需要第 5、6 层。期望工具可部署、可审计，就需要第 13–15 层。

## 反直觉结论

> **当 SDK 提供了循环，困难的工作并没有消失，只是从中心转移到了边缘。**

你省掉了几百行的 loop 代码。但你仍然需要写围绕它的几千行。而且因为 loop 对所有使用同一 SDK 的人都是相同的，**差异化被迫进入 harness**：隔离、流式弹性、并发预算、沙箱、预览保真、可观测、部署人体工学。harness 才是产品；loop 只是一个共享依赖。

这也是为什么 Kin 有意把 Claude Agent SDK 钉死在 `0.2.112`，并通过 ARK 兼容网关使用它：它不在 loop 智能上竞争，而在让 SDK 在多用户、自托管环境中安全、可靠地运行上竞争。

## 什么时候应该自己造 harness

对大多数人来说，答案是**永远不**。使用托管 Agent 平台，或者把 `query()` 作为内部脚本跑。只有当**以下三点全部满足**时，才值得建造 harness：

1. **你必须自托管**：数据不能离开你的基础设施，或者你必须使用特定模型网关，或者合规要求代码和工作区留在你的机器上。
2. **你确实是多用户且执行繁重**：一个人偶尔问模型问题不需要隔离或并发限制。一个团队跑代码、写文件、启动服务才需要。
3. **它必须成为产品，而不是脚本**：计费、审计、一键部署、采购流程都重要。

Kin 的目标上下文同时满足这三点。其威胁模型是**半可信同事**，而不是匿名攻击者。因此代码执行这类强大能力被视为合法核心功能，并通过沙箱守护，而不是禁止。

## 相关 Kin 文档

- `docs/project/VISION.md` — 产品定位与威胁模型
- `docs/project/ROADMAP.md` — 当前阶段计划与已完成里程碑
- `docs/project/STATUS.md` — 项目实时状态与决策日志
- `CLAUDE.md` — 开发规则与栈约束

## 配图

1. `docs/blog/assets/img/01-stack-15layers.svg` — Kin 15 层栈，SDK 在第 0 层
2. `docs/blog/assets/img/01-naive-vs-harness.svg` — 原始 `query()` 与生产 harness 之间的差距
