# Kin 课程索引

> 一套自包含的 Kin 工程拆解课程。Kin 是一个基于 Claude Agent SDK 的自托管、单组织、多用户 Agent harness。每节课相互独立，可按任意顺序阅读。
>
> **范围**：课程 01–20 覆盖当前已实现系统。课程 D1–D6 覆盖设计工作，其中部分已落地。
>
> **代码快照**：Kin `main` 分支，2026-06-30。行号会随代码演进漂移；请以引用的文件路径为准。

---

## 一句话定位

**Kin** 是一个基于 **Claude Agent SDK 0.2.112**（为兼容 ARK 多模型网关而精确锁定）和 **TanStack Start** 的自托管、团队级自主 Claude-agent 工作台。它用 Projects、Skills、MCPs、Artifacts、Python/Bash 执行、真预览、单组织多用户隔离等能力，取代通用托管聊天机器人。目标是一台 16 GB / 8 核主机服务约 50 个并发会话。

---

## 已实现系统（课程 01–20）

| 主题 | Slug | 标题 | 一句话 |
|---|---|---|---|
| **定位** | `01-what-is-agent-harness` | 什么是 Agent Harness | 当 SDK 给了你 Loop 之后，仍需建造的 15 层 |
| **定位** | `02-kin-stack-overview` | Kin 技术栈概览 | 四个进程、钉死的 SDK、ARK 网关与 TanStack Start |
| **执行** | `03-per-message-worker-model` | Per-Message Worker 模型 | 为什么每个消息都生成一个全新子进程 |
| **执行** | `04-streaming-protocol` | 流式协议 | NDJSON 帧、seq 编号与背压 |
| **执行** | `05-execution-runtime` | 执行运行时 | 本地进程与 per-session Docker 后端，FAIL-CLOSED |
| **工具** | `06-tool-system` | 工具系统 | SDK 预设 `claude_code` 与自定义 MCP 工具 |
| **工具** | `07-mcp-capability-center` | MCP 能力中心 | 内置 MCP、每用户文件系统启用、凭据与覆写 |
| **工具** | `08-skills-system` | Skills 系统 | 启用时复制、schema 生成与禁用否决 |
| **安全** | `09-ask-act-hitl` | Ask/Act 与 HITL | `canUseTool`、`approval_request` 与 stdin 往返 |
| **安全** | `10-bash-sandbox` | Bash 沙箱 | srt FAIL-CLOSED、`prlimit` 与无条件 secret 剥离 |
| **安全** | `11-single-org-multi-user-isolation` | 单组织多用户隔离 | per-session workspace 与路径守卫 |
| **会话** | `12-session-persistence` | 会话持久化 | SDK transcript 为真相，DB 为索引 |
| **会话** | `13-single-host-concurrency` | 单机并发 | 信号量(max 8)、worker 堆上限与 idle reaper |
| **会话** | `14-multi-model-routing` | 多模型路由 | ARK 网关、模型别名与 SDK 0.2.112 锁定 |
| **预览** | `15-real-preview` | 真预览 | 在 per-session Docker 中运行 AI 生成的多文件 App |
| **预览** | `16-artifacts-and-workbench` | Artifact 检测与 Workbench | 启发式检测、seq 排序与 Workbench 面板 |
| **协作** | `17-projects-and-branch-on-reply` | Project 与 branch-on-reply | 共享会话、access resolver 与 fork 语义 |
| **运维** | `18-billing-and-observability` | 计费与可观测性 | `usage_record`、为什么 `costUsd` 不是账单，以及三条可观测腿 |
| **运维** | `19-dokploy-deploy` | Dokploy 部署 | 多阶段 Docker、GHCR、Traefik 子域与 Cloudflare Origin CA |
| **反思** | `20-retrospective` | 回顾 | 胜利、债务与 SDK 耦合 |

---

## 设计工作（课程 D1–D6）

| 课程 | 标题 | 状态 | 一句话 |
|---|---|---|---|
| `d1-advanced-rag` | 高级 / Agentic RAG | 已完整落地 | 离线嵌入、混合搜索与 agent 驱动的检索工具 |
| `d2-long-term-memory` | 长期记忆 | 仅设计 | 两层记忆、LLM 驱动更新与系统提示注入 |
| `d3-context-engineering` | 上下文工程 | 仅设计 | 渐进压缩、磁盘卸载与上下文预算 |
| `d4-evaluation` | 评估 | 部分落地 | 黄金集、检索/生成指标与回归门 |
| `d5-guardrails` | 护栏 | 部分落地 | 输出过滤、PII 与 RAG 提示注入面 |
| `d6-agent-tracing` | Agent / RAG 追踪 | 部分落地 | seq 事件流 span 与每次检索 trace |

---

## 按主题查找

| 如果你想理解…… | 相关课程 |
|---|---|
| agent loop 如何运行而不被重写 | `01-what-is-agent-harness`、`03-per-message-worker-model`、`02-kin-stack-overview` |
| 为什么每个消息生成新进程 | `03-per-message-worker-model`、`13-single-host-concurrency` |
| 事件如何流式到达浏览器 | `04-streaming-protocol`、`16-artifacts-and-workbench` |
| 任意代码如何被沙箱化 | `05-execution-runtime`、`10-bash-sandbox`、`11-single-org-multi-user-isolation` |
| 工具与 MCP 如何扩展 | `06-tool-system`、`07-mcp-capability-center`、`08-skills-system` |
| Ask/Act 与人工审批如何工作 | `09-ask-act-hitl`、`10-bash-sandbox` |
| 会话如何持久化与恢复 | `12-session-persistence`、`03-per-message-worker-model` |
| 多模型路由如何工作 | `14-multi-model-routing`、`02-kin-stack-overview`、`18-billing-and-observability` |
| AI 生成的 App 如何被预览 | `15-real-preview`、`16-artifacts-and-workbench`、`05-execution-runtime` |
| 如何部署并保持运行 | `19-dokploy-deploy`、`13-single-host-concurrency`、`18-billing-and-observability` |
| Project 如何共享会话与 branch-on-reply | `17-projects-and-branch-on-reply`、`11-single-org-multi-user-isolation` |
| 系统如何被评估与护栏 | `d1-advanced-rag`、`d4-evaluation`、`d5-guardrails`、`d6-agent-tracing` |
| 长期债务在哪里 | `20-retrospective`、`d2-long-term-memory`、`d3-context-engineering` |

---

## 关键词索引

| 主题 | 关键词 | 课程 |
|---|---|---|
| 核心执行 | per-message worker、`child_process` spawn、Claude Agent SDK 0.2.112、NDJSON、seq、背压 | `03`、`04`、`05` |
| 工具与扩展 | SDK 预设 `claude_code`、`createSdkMcpServer`、MCP `enabled.json`、Skills 启用时复制、schema 生成器 | `06`、`07`、`08` |
| 安全与隔离 | permission-tier ask/act、`canUseTool`、srt / bubblewrap、`prlimit`、`buildSafeEnv`、path-security、跨用户守卫 | `09`、`10`、`11` |
| 会话与并发 | transcript-as-truth、`agent_session`、`usage_record`、`audit_log`、信号量、idle-reaper、ARK 网关 | `12`、`13`、`14` |
| 预览与 Artifacts | 真预览、per-session Docker、Traefik 子域、JWT 引导、artifact 检测、structured outputs 关闭、Workbench seq | `15`、`16` |
| 协作 | Projects、`project_member`、branch-on-reply、`branchedFromSessionId`、`forkSession`、单一 access resolver | `17` |
| 运维 | 基于 token 的 credit、`costUsd` 不扣费、Polar webhook、PostHog、Sentry、多阶段 Dockerfile、GHCR、Cloudflare Origin CA、Dokploy | `18`、`19` |

---

## 英文版本

| 课程 | 英文版本 |
|---|---|
| 全部 01–20 与 D1–D6 | `en/` 目录下均有对应文件 |
| 重点打磨版 | `en/03-per-message-worker-model.md`、`en/15-real-preview.md`（较早发布的旗舰篇） |

---

## 与手写 Loop 模板的对比

Kin 的原始结构受到一些手写 Agent Loop 的 harness 文章影响。Kin 刻意走了不同路径：

| 维度 | 手写 Loop 模板 | Kin |
|---|---|---|
| Agent Loop | 自写异步生成器 | 包裹 Claude Agent SDK `query()` |
| 执行形态 | 常驻引擎进程 | 每个消息一个子进程 |
| 沙箱 | 每用户持久 Docker | srt / bubblewrap / Docker `ExecutionRuntime` 抽象 |
| 多模型 | 硬编码多个 provider | ARK Anthropic-compatible 网关，SDK 锁定 0.2.112 |
| 持久化 | 数据库为真相 | SDK transcript 为真相，DB 为索引 |
| 预览 | iframe 覆盖 | 真正的 per-session Docker 预览 + Traefik 子域 |
| 栈 | Next.js + 自定义引擎 | TanStack Start + `ws-server` + `ws-query-worker` |

本系列价值在于：为基于官方 SDK 构建产品、而不是从头写 loop 的团队，拆解工程问题如何从“loop 正确性”转移到隔离、持久化、并发、协作与部署。

---

## 说明

- 每节课自包含。交叉引用只在概念自然需要落地时指向文件或其他课程；没有“下一篇”或“上一篇”依赖。
- 行号引用精确到快照日期，会随代码演进轻微漂移。请以文件路径为主要真相源。
- 配图规划在 `assets/img/` 下，按课程 slug 命名。
- 当前项目状态与路线图见 `docs/project/STATUS.md` 和 `docs/project/ROADMAP.md`。

---

> **最后更新**：2026-06-30。本索引与 `docs/project/STATUS.md` 一起维护。
