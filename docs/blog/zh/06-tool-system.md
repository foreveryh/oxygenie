---
title: "工具系统 — SDK 预设 claude_code 与自定义 MCP 工具"
slug: 06-tool-system
date: 2026-06-07
keywords: [claude_code preset, createSdkMcpServer, MCP, Python 工具, Bash 工具]
---

# 工具系统 — SDK 预设 `claude_code` 与自定义 MCP 工具

Kin 的工具分两类。第一类是 SDK 内置的 `claude_code` 预设（Read、Write、Edit、Grep、Glob 等）。第二类是通过 `createSdkMcpServer` 注册的自定义工具：Python、GLM-Image 和 Bash。本课解释分工逻辑：哪些工具留给 SDK，哪些由 Kin 包裹，以及为什么 Bash 特别要包裹而不是直接用。

## 问题

一个可用的 agent 需要读取、写入、编辑、搜索、运行代码、生成图片、执行 shell 命令。但在自托管多用户环境中，不同工具的风险画像不同：

- **Read/Write/Edit/Grep**：危险主要在于可能跨越工作区边界。执行本身不需要特殊处理。
- **Bash/Python**：危险在于执行任意代码。必须在执行瞬间拦截，把命令放进沙箱、剥离 secret、施加资源限制。

问题不是是否使用 SDK 工具，而是哪些工具可以原样交给 SDK，哪些需要自定义 wrapper 把执行路由到 `ExecutionRuntime`。

## 为什么朴素方案失败

- **使用 SDK 预设并包含原生 Bash**：SDK 的原生 Bash 在 agent loop 内没有任何钩子地运行命令。无法把命令路由到 `ExecutionRuntime`，没有 `buildSafeEnv()` 剥离 secret，也没有 `prlimit` 限制资源。这会把最危险的能力交给不受控的执行器。
- **禁用 Bash 让模型用 Python `subprocess`**：模型仍会跑 shell 命令，但路径更不透明、更难 gate 和审计。这是隐藏危险而不是移除危险。
- **自己重写每个工具**：Read、Edit、Grep 等预设工具已经包含边界检查并遵循 SDK 的工具调用格式。重写它们是重复劳动，还会制造与 SDK schema 不匹配的风险。

正确分界线是：Kin 是否需要在**执行瞬间**介入。

## 核心设计

> **不需要执行拦截的工具用 SDK 预设；必须路由到 `ExecutionRuntime` 的工具用自定义 MCP。原生 Bash 始终禁用；Bash 只能通过自定义 `mcp__bash__run` 工具使用，且受沙箱就绪状态限制。**

```javascript
// ws-query-worker.mjs
const pythonMcp = createSdkMcpServer({ name: 'python', tools: [ pythonTool ] })
const glmImage  = createSdkMcpServer({ name: 'glm-image', tools: [ glmImageTool ] })
const bashMcp   = sandboxReady ? createSdkMcpServer({ name: 'bash', tools: [ bashTool ] }) : null

query({
  options: {
    tools: { type: 'preset', preset: 'claude_code' },
    mcpServers: [pythonMcp, glmImage, ...(bashMcp ? [bashMcp] : []), ...userMcp]
  }
})
```

要点：

- **预设工具留在 SDK**：它们免费、由 Anthropic 维护，已包含工作区感知验证。它们在 Kin 中的安全由 `path-security.js` 和 `canUseTool` 再加一层。
- **自定义执行工具路由到 `ExecutionRuntime`**：Python、Bash、图片生成都通过运行时抽象执行，因此获得沙箱、secret 剥离和资源限制。
- **Bash 是条件注册的**：如果沙箱未就绪（`sandboxReady` 为 false），Bash 完全不暴露给模型。没有回退到原生 Bash。
- **所有工具过同一道前闸**：无论来源，每个工具调用都经 `canUseTool` 和路径安全层检查。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `ws-query-worker.mjs` | ~L383–629 | 注册 Python / GLM-Image / Bash MCP 并合并用户 MCP |
| `src/claude/python/runner.js` | ~187 | 通过 `ExecutionRuntime` 执行 Python + 工作区快照 |
| `src/claude/bash/runner.js` | ~241 | Bash 验证 + `prlimit` + FAIL-CLOSED |
| `src/claude/path-security.js` | ~L267–331 | 文件工具的工作区/用户边界检查 |

执行类工具有硬编码的安全护栏，属于它们安全契约的一部分：Python 10 秒超时、Bash 300 秒超时、输出上限 512 KB、Python 代码大小上限 200 KB、工作区快照超过 2000 文件截断。这些数字是策略，不是调参。它们定义了失控命令在被停止前最多能消耗多少。

## 反直觉结论

> **“用 SDK”和“自己造”之间的边界不是功能完整性，而是你是否需要在执行前有一个拦截点。**

Bash 需要拦截点，所以即使 SDK 提供了原生 Bash，Kin 也要包裹它。Read/Edit/Grep 不需要拦截点，所以 Kin 用 SDK 预设。原则是：不要重写 SDK 已经做得好的东西，但 SDK 没暴露所需钩子时要自己包一层。

## 生产坑

- **沙箱失败时 Bash 会静默消失**。如果 `sandboxReady` 为 false，Bash MCP 不会被注册。对话继续，但模型没有 Bash 工具。这是故意的，但可能被误认为是模型 bug。生产日志中监控 `sandboxReady`。
- **Python 输出超过 512 KB 是 SIGKILL，不是截断**。超出上限时进程被杀死而非截断。模型看到死进程可能重试同一段代码。这保护了管道，但需要明确提示模型分页输出。
- **工作区快照在超过 2000 文件时禁用**。如果工作区超过 2000 文件（例如没有忽略 `node_modules`），执行后 diff 反馈被关闭。模型可能不知道它改了哪些文件，导致重复或错误操作。工作区卫生是正确性要求，不是偏好。

## 相关 Kin 文档

- `ws-query-worker.mjs` — MCP 与预设注册
- `src/claude/python/runner.js` — Python 执行与快照
- `src/claude/bash/runner.js` — Bash 执行与硬限制
- `src/claude/path-security.js` — 路径边界检查
- `zh/05-execution-runtime.md` — `ExecutionRuntime` 抽象与 FAIL-CLOSED
- `zh/10-bash-sandbox.md` — Bash 专用加固

## 配图

1. `docs/blog/assets/img/06-tool-split.svg` — 预设工具与自定义 MCP 工具的分工
