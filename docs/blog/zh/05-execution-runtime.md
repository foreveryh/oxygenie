---
title: "执行运行时 — 本地进程与 per-session Docker 后端，FAIL-CLOSED"
slug: 05-execution-runtime
date: 2026-06-07
keywords: [ExecutionRuntime, 沙箱, srt, bubblewrap, Docker, FAIL-CLOSED, secret 剥离]
---

# 执行运行时 — 本地进程与 per-session Docker 后端，FAIL-CLOSED

工具可能执行任意命令：Python 脚本、shell 命令、构建步骤。这些命令必须在沙箱中运行。但“沙箱”在 Linux 生产主机和 Mac 开发者笔记本上意味着不同东西。Kin 用 `ExecutionRuntime` 接口和两个可互换后端解决这个问题：一个被 `srt` 包裹的本地进程后端，和一个 per-session Docker 后端。本课解释这个接口，以及最重要的不变量：**FAIL-CLOSED**。

## 问题

三种环境需要被安全支持：

1. **Linux 生产**：`srt`（基于 bubblewrap）可用于轻量级命名空间 + seccomp 隔离。
2. **Mac 开发**：bubblewrap 是 Linux-only，所以 `srt` 无法在本地运行。
3. **更强隔离需求**：需要完整 per-session 容器，拥有独立文件系统和网络命名空间。

两个问题必须一起回答：上层（worker、工具系统）如何避免关心哪个后端在激活；以及当沙箱没准备好时系统做什么。

## 为什么朴素方案失败

- **到处硬编码 `spawn('python', ...)` 或 `spawn('bash', ...)`**：执行逻辑会被焊死在某个后端上。切换到 Docker 需要修改每个调用点。更糟的是，在 Mac 上 `srt` 不可用时，这种方案会静默退回到裸主机运行。
- **优雅降级到裸主机**：沙箱初始化失败时退回到无保护执行。这听起来对用户友好，但在沙箱语境下意味着“当安全机制失效时，假装它不存在”。一次失败的 `srt` 初始化或 Docker daemon 卡顿就会移除所有防御，并且悄无声息。

真正的问题不是用哪种隔离技术。而是**当该技术不可用时默认行为是什么**。

## 核心设计

> **单一 `ExecutionRuntime` 接口，两个可互换后端；工厂按环境变量选择后端；接口契约要求 FAIL-CLOSED — 如果沙箱没准备好，执行被拒绝；secrets 被无条件剥离。**

```
              getExecutionRuntime()
                       │
       ┌───────────────┴────────────────┐
LocalProcessBackend              DockerBackend
(Linux 上 srt)                   (EXEC_RUNTIME=docker)
       │                                  │
       └────── buildSafeEnv() 剥离 secrets ──────┘
       └────── FAIL-CLOSED: 沙箱未就绪 → 拒绝
```

四条规则：

1. **工厂选择后端**：`EXEC_RUNTIME=docker` 返回 DockerBackend；否则返回 LocalProcessBackend。上层无论激活哪个后端都调用相同方法。
2. **Linux 默认启用 srt，Mac/Windows 禁用**：`isEnabled()` 如实报告平台现实。Mac 开发者需要运行 Bash 时必须显式设置 `EXEC_RUNTIME=docker`。
3. **FAIL-CLOSED**：`ensureSandbox()` 只在 `srt` 激活或后端是 Docker 时才通过。否则抛出并拒绝执行。没有裸主机回退。
4. **secrets 无条件剥离**：`buildSafeEnv()` 为每个工具子进程构建基于白名单的环境。无论沙箱是否激活它都会运行。即使沙箱配置错误，子进程也看不到 `ANTHROPIC_API_KEY` 等 secrets。

FAIL-CLOSED 有效是因为抽象是单一接口。如果执行逻辑分散在代码库中，“不安全时拒绝”就得在每个调用点重复，一个漏掉的调用点就会成为漏洞。单一接口让 `ensureSandbox()` 成为不可绕过的检查点。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/claude/execution/index.js` | 全文 | 按 `EXEC_RUNTIME` 选择后端的工厂 |
| `src/claude/execution/local-process-backend.js` | ~139 | 子进程执行 + Linux 上 `srt` 包裹 |
| `src/claude/execution/docker-backend.js` | ~175 | per-session Docker 容器后端 |
| `src/claude/execution/sandbox.js` | ~43–49 | `buildSafeEnv()` 基于白名单的 secret 剥离 |
| `src/claude/execution/sandbox.js` | ~86–115 | `ensureSandbox()` 一次性初始化与 FAIL-CLOSED 门 |
| `src/claude/execution/sandbox.js` | ~51–62 | `isEnabled()` 平台检查 |

`ensureSandbox()` 是物理门。`buildSafeEnv()` 是第二道防线。后端文件是细节实现，不知道调用者是跑 Python 还是 Bash。

## 反直觉结论

> **沙箱设计中最重要部分不是“如何隔离”，而是“当隔离不可用时做什么”。在大多数系统中优雅降级是美德；在沙箱中它是漏洞。**

Kin 的价值排序是刻意的：安全高于可用。一次拒绝执行可以接受；一次无保护执行不可接受。抽象让这种价值排序结构性地可执行，因为每条执行路径都经过同一道门。

## 生产坑

- **Mac 上除非设置 `EXEC_RUNTIME=docker`，否则 Bash 被拒绝。** 这是 FAIL-CLOSED 按设计工作。开发者第一次碰到时可能觉得是 bug。它不是。移除检查会制造裸主机执行洞。
- **环境白名单是默认拒绝**：任何工具合法需要的新环境变量都必须加入 `buildSafeEnv()`。缺失的变量会被静默剥离，导致工具行为混乱，且没有任何“变量已移除”日志。
- **Docker 后端是 opt-in**：Linux 上默认是带 `srt` 的 LocalProcessBackend。在没确认 Docker daemon、镜像和 per-session 容器生命周期都配置好的情况下切换到 Docker，可能得到一个声称就绪但实际未隔离的后端。

这三个坑都是默认拒绝哲学的代价。在一个执行任意模型生成命令的系统中，这个代价值得付。

## 相关 Kin 文档

- `src/claude/execution/index.js` — 后端工厂
- `src/claude/execution/sandbox.js` — `ensureSandbox()`、`buildSafeEnv()`、`isEnabled()`
- `src/claude/execution/local-process-backend.js` — Linux `srt` 进程后端
- `src/claude/execution/docker-backend.js` — per-session Docker 后端
- `10-bash-sandbox.md` — Bash 专用沙箱规则与运行时加固
- `11-single-org-multi-user-isolation.md` — 沙箱层之上的工作区隔离

## 配图

1. `docs/blog/assets/img/05-execution-runtime.svg` — ExecutionRuntime 接口 + 双后端
2. `docs/blog/assets/img/05-fail-closed.svg` — FAIL-CLOSED 决策树
