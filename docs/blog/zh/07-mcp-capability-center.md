---
title: "MCP 能力中心 — 内置 MCP、每用户文件系统启用、凭据与覆写"
slug: 07-mcp-capability-center
date: 2026-06-07
keywords: [MCP, Model Context Protocol, 每用户启用, 凭据, 覆写]
---

# MCP 能力中心 — 内置 MCP、每用户文件系统启用、凭据与覆写

MCP 服务器让外部工具接入 agent。Kin 自带一组精选 MCP，并允许每个用户自行决定启用哪些。本课解释为什么启用状态存在每用户文件系统 JSON 里而不是数据库中，凭据和工具覆写如何管理，以及连接生命周期为何交给 SDK。

## 问题

在多用户工作台上，不是每个用户都需要同样的 MCP。一个用户需要搜索和视觉，另一个只需要 Python 和图片生成。每个用户可能有自己的 API key。高级用户可能希望只允许某个 MCP 的部分工具。需要管理三类状态：

1. **启用**：哪些 MCP 对该用户激活。
2. **凭据**：每个 MCP 使用哪些 API key 或 token。
3. **覆写**：允许 MCP 中的哪些工具。

第四个问题是 MCP 连接的运行时生命周期：谁负责连接、重连和状态报告？

## 为什么朴素方案失败

- **把启用状态存数据库**：SDK 不读 Postgres。它通过扫描磁盘上的 `settingSources` 来发现 MCP 配置。即使启用状态在数据库里，运行时仍要把它物化回磁盘，数据库变成无意义的中间层。
- **自己写 MCP 连接管理器**：SDK 0.2.112 已经提供 `toggleMcpServer`、`reconnectMcpServer` 和 `mcpServerStatus`。重新实现这些会复制 SDK 内部状态并引入漂移。
- **把凭据、启用和覆写合在一个文件**：为一个小改动重写整个文件会产生并发风险，并且把安全要求不同的数据混在一起。

## 核心设计

> **每用户文件系统 JSON 存状态，SDK 管连接。三个文件：`enabled.json`、`credentials.json`、`overrides.json`。**

- `~/.claude/mcp/enabled.json` — 已启用 MCP 列表。
- `~/.claude/mcp/credentials.json` — API key 等凭据，使用 `${VAR}` 模板替换。
- `~/.claude/mcp/overrides.json` — 每个 MCP 可选的 `allowedTools` 过滤。

内置 MCP 位于 `src/mcp-store/`，包括 glm-image、python、markitdown-mcp 和几个智谱服务（搜索、视觉、reader、zread）。它们是团队精选工具箱，不是公开市场。

Kin 负责配置。SDK 负责连接、重连和状态报告。`system.init` 事件报告每个 MCP 的连接状态和工具数量，UI 用它来渲染能力中心。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/claude/mcp/manager.js` | ~L45–55 | `getUserClaudeHome()` 解析用户的 `.claude` 根目录 |
| `src/claude/mcp/manager.js` | 读/写 | `enabled.json` 增删改查 |
| `src/claude/mcp/manager.js` | ~L85–194 | `getMcpCredentials`、`setMcpCredentials`、允许工具覆写 |
| `src/mcp-store/*` | 7 个目录 | 内置 MCP 源 |

管理器把已启用 MCP 翻译成 SDK 消费的 `mcpServers` 数组。从那时起，SDK 拥有连接。

## 反直觉结论

> **“哪些 MCP 已启用”是用户偏好，不是关系数据，所以它属于文件系统。**

SDK 是消费者，它按目录扫描读取。把偏好放进数据库只会增加从 SQL 到磁盘的翻译层。判断标准是**谁读取数据**，而不是数据多重要。这个原则同样适用于 Skill 启用。

## 生产坑

- **MCP 不会预热**：连接发生在会话启动时。启用很多 MCP 的用户可能经历首条消息延迟，尤其是某个 MCP 端点慢或不可达时。
- **凭据目前明文存在磁盘上**：`credentials.json` 包含明文 API key。在半可信同事威胁模型中，这是真实暴露。计划迁移为数据库加密存储凭据，文件系统只保留启用偏好。
- **工具覆写在 SDK 0.2.112 中不是运行时强制**：`allowedTools` 字段只在较新 SDK 版本中生效。Kin 钉死在 0.2.112，覆写主要是 UI 层声明。内置 MCP 由团队精选，覆写不是针对不可信 MCP 的安全边界。

## 相关 Kin 文档

- `src/claude/mcp/manager.js` — MCP 配置与启用
- `src/mcp-store/` — 内置 MCP 源
- `zh/06-tool-system.md` — 自定义 MCP 工具与 SDK 预设
- `zh/08-skills-system.md` — Skills 的文件系统启用

## 配图

1. `docs/blog/assets/img/07-mcp-center.svg` — MCP 能力中心：7 个内置 + 每用户文件系统启用 + SDK 管理连接
