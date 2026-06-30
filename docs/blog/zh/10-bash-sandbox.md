---
title: "Bash 沙箱 — srt FAIL-CLOSED、prlimit 与无条件 secret 剥离"
slug: 10-bash-sandbox
date: 2026-06-07
keywords: [Bash 沙箱, srt, bubblewrap, prlimit, secret 剥离, FAIL-CLOSED]
---

# Bash 沙箱 — srt FAIL-CLOSED、prlimit 与无条件 secret 剥离

Bash 是 agent 工具集中最强大也最危险的一个。Kin 不使用 SDK 的原生 Bash。相反，它把每条命令包裹在三层中：srt 文件系统隔离、`prlimit` 资源硬上限、以及 `buildSafeEnv()` secret 剥离。主导规则是 **FAIL-CLOSED**：如果沙箱没准备好，Bash 就被拒绝，绝不降级到裸主机执行。

## 问题

Bash 执行由用户通过模型下发的任意 shell 命令。威胁包括：

1. **未授权读写**：触碰 `/etc`、`/root`、其他用户的会话目录。
2. **资源耗尽**：fork 炸弹、内存炸弹、填满磁盘的写入。
3. **Secret 外泄**：把 `ANTHROPIC_AUTH_TOKEN` 或其他环境 key 打印到网络。
4. **静默沙箱失效**：沙箱配置错误，但 Bash 仍在无保护运行。

## 为什么朴素方案失败

- **命令黑名单**：攻击者可以写无数种变体的 `rm -rf /`。你无法枚举危险命令空间；必须拒绝对目标的访问。
- **优雅降级到裸主机**：这是最危险的便利。一次沙箱初始化失败就会静默移除所有保护。

## 核心设计

> **四层叠加：FAIL-CLOSED 门、srt 文件系统围栏、prlimit 资源硬上限、无条件 secret 剥离。**

- **FAIL-CLOSED**：`runBash()` 在任何命令前调用 `ensureSandbox()`。如果 srt 或 Docker 都没有激活，执行被拒绝。没有裸主机回退。
- **srt 文件系统围栏**：基于 bubblewrap，srt 默认拒绝对 `/` 的读访问，然后只把当前会话工作区、`/usr` 和其他必要路径加入白名单。写只允许到工作区和 `/tmp`。命令一开始就无法看到敏感主机文件。
- **prlimit 硬上限**：Linux 内核对内存（2 GB）、进程数（512）、单文件大小（2 GB）的限制。它们在超时生效前阻止 fork 炸弹和内存炸弹。
- **Secret 剥离**：`buildSafeEnv()` 在每条命令上运行，无论沙箱状态如何。它只白名单执行所需的环境变量（PATH、HOME、LANG、PYTHON* 等），并剥离 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 等 secrets。

安全数字：Bash 超时 300 秒，输出上限 512 KB，磁盘 2 GB，prlimit 2 GB / 512 进程 / 2 GB 文件。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/claude/bash/runner.js` | ~L179–197 | FAIL-CLOSED：沙箱未就绪则拒绝 |
| `src/claude/bash/runner.js` | ~L120–127 | prlimit：2 GB 内存 / 512 进程 / 2 GB 文件 |
| `src/claude/bash/runner.js` | ~L135–145, ~L219–227 | 执行前后磁盘测量 + 越界警告 |
| `src/claude/execution/sandbox.js` | ~L43–49 | `buildSafeEnv()` 白名单 secret 剥离 |
| `src/claude/execution/sandbox.js` | ~L86–115 | `ensureSandbox()` 门与文件系统策略 |

## 反直觉结论

> **沙箱最重要部分是其失效时的默认行为。在 Kin 中，沙箱失效导致拒绝，而不是回退。**

这是 deliberate 的价值排序。系统接受偶尔不可用，以换取永不执行无保护命令。secret 剥离层独立于沙箱，因此即使沙箱被绕过，命令也没有 key 可偷。

## 生产坑

- **命令验证是第二道防线，不是第一道**。srt 的文件系统围栏才是真正的边界。不要因为存在启发式检查就放松沙箱。
- **Mac 上 srt 可能阻塞合法 Python 路径**。Mac 本地开发请使用 `EXEC_RUNTIME=docker`。srt 是 Linux 生产路径。
- **prlimit 是 Linux-only**。非 Linux 主机上缺少硬资源上限。生产必须跑在 Linux 上。

## 相关 Kin 文档

- `src/claude/bash/runner.js` — Bash 执行与限制
- `src/claude/execution/sandbox.js` — `ensureSandbox()` 与 `buildSafeEnv()`
- `src/claude/execution/local-process-backend.js` — Linux srt 进程后端
- `zh/05-execution-runtime.md` — ExecutionRuntime 抽象与 FAIL-CLOSED
- `zh/11-single-org-multi-user-isolation.md` — 沙箱层之上的工作区隔离

## 配图

1. `docs/blog/assets/img/10-bash-three-gates.svg` — Bash 三道门：srt / prlimit / secret 剥离
2. `docs/blog/assets/img/10-fail-closed.svg` — FAIL-CLOSED 决策树
