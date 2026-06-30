---
title: "单组织多用户隔离 — per-session workspace 与路径守卫"
slug: 11-single-org-multi-user-isolation
date: 2026-06-07
keywords: [workspace, 路径守卫, 单组织, 多用户, 隔离, 跨用户]
---

# 单组织多用户隔离 — per-session workspace 与路径守卫

沙箱阻止命令到达系统目录，但它不能阻止用户 A 访问用户 B 的会话目录。Kin 增加了第二层隔离：每个会话有自己的 workspace，每次文件工具调用在到达沙箱前都要经过逻辑边界检查。本课解释为什么逻辑检查必须跑在物理沙箱之前。

## 问题

Kin 是面向单组织的自托管工作台。许多用户共享同一台机器和同一个 `/data/users` 目录树。沙箱处理“用户 vs 主机”，但留下“用户 vs 用户”未解决。目标是防止一个用户的文件工具读取或写入另一个用户的会话目录，即使是误操作。

Kin 的威胁模型是半可信同事，不是匿名攻击者。隔离不需要阻止每一个高级利用，但必须防止跨用户错误，并提供清晰的纵深防御。

## 为什么朴素方案失败

- **只依赖沙箱**：沙箱是硬边界，但它是最后一道防线。如果沙箱配置被误放宽，或工具绕过沙箱，跨用户访问就会溜过去。纵深防御需要更早的检查。
- **为每个路径建全局权限注册表**：中央注册表把每个工具调用变成对共享服务的查询。这增加延迟和单一状态点。决策应该是路径和当前用户根目录的纯函数。

## 核心设计

> **两层：物理 per-session workspace，以及跑在沙箱前的逻辑路径守卫。路径守卫是无外部查询的前缀检查。**

- **Per-session workspace**：`/data/users/{userId}/sessions/{sessionId}/workspace/`。`{userId}` 段分隔用户；`{sessionId}` 段给 SDK 每个对话一个稳定工作目录。会话 workspace 和 transcript 目录都位于这棵树之下。
- **系统前缀黑名单**：`createPathSecurity()` 定义阻塞前缀，如 `/etc`、`/proc`、`/sys`、`/root`、`/var`、`/bin`、`/usr`、`/sbin`、`/boot`、`/lib`。任何文件工具瞄准这些前缀，在逻辑层执行前就被拒绝。
- **跨用户硬拒绝**：`path-security.js` 中的关键检查：如果解析后的路径在 `sessionsRoot` 下但不在当前用户 `userRoot` 下，就硬拒绝。这个检查在 `canUseTool` 中运行，在沙箱看到命令之前。
- **符号链接解析**：边界检查前用 `realpath` 解析路径。工作区内的符号链接指向另一个用户目录时，按真实目标而不是链接路径判断。

```
文件工具调用（Read/Write/Edit/Glob）
        │
        ▼  ① 逻辑层：canUseTool（路径安全）
   realpath 解析符号链接
        │
        ├─ 匹配阻塞前缀（/etc /proc /root …）→ 拒绝
        ├─ 在 sessionsRoot 下但不在当前 userRoot 下 → 硬拒绝（跨用户）
        └─ 在当前 userRoot / workspace 内 → 允许
        │
        ▼  ② 物理层：srt 文件系统围栏（沙箱）
```

两层角色不同。逻辑层早、便宜、可解释。物理层晚、硬、操作系统强制。单独任何一层都不够。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/claude/path-security.js` | ~L1–331 | `createPathSecurity()` 与 `canUseTool` 验证 |
| `src/claude/path-security.js` | ~L8–19 | 系统前缀黑名单 |
| `src/claude/path-security.js` | ~L267–331 | 各文件工具的工作区/用户边界检查 |
| `src/claude/path-security.js` | ~L289–295 | 沙箱前跨用户硬拒绝 |
| `ws-server.mjs` | ~L591–595 | `getSessionWorkspace()` 解析 per-session 目录 |

## 反直觉结论

> **沙箱是硬边界，但隔离也必须在请求到达沙箱前阻止它。**

逻辑层不替代沙箱；它防御沙箱配置缺口并提供清晰拒绝理由。路径守卫是纯前缀比较，无数据库查询，因此每次工具调用 O(1) 时间。这是捕捉跨用户错误的正确位置：早、便宜、明确。

## 生产坑

- **写范围是整个 userRoot，不只是当前会话 workspace**。这是故意的。用户可能想访问更早会话中写的文件。策略放宽了同用户面，但跨用户访问仍被硬拒绝阻塞。
- **符号链接解析有 TOCTOU 窗口**。`realpath` 在验证时解析链接；工具实际读写前目标可能变化。在半可信模型中窗口很窄、风险很低，但这是已知限制。
- **会话根路径必须是绝对路径**。如果 `CLAUDE_SESSIONS_ROOT` 是相对路径，worker 和 ws-server 因工作目录不同而解析不同。这会破坏边界检查和 transcript resume。修复方案是在数据库中存绝对路径。

## 相关 Kin 文档

- `src/claude/path-security.js` — 边界检查实现
- `ws-server.mjs` — 会话 workspace 解析
- `zh/10-bash-sandbox.md` — 沙箱层
- `zh/12-session-persistence.md` — transcript 路径与 resume

## 配图

1. `docs/blog/assets/img/11-two-layer-isolation.svg` — 两层隔离：per-session workspace + 路径守卫
2. `docs/blog/assets/img/11-cross-tenant.svg` — 跨用户拒绝逻辑
