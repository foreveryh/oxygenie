---
title: "Skills 系统 — 启用时复制、schema 生成与禁用否决"
slug: 08-skills-system
date: 2026-06-07
keywords: [Skills, SKILL.md, 启用时复制, schema 生成, 禁用否决]
---

# Skills 系统 — 启用时复制、schema 生成与禁用否决

Kin 中的 Skill 是一个 YAML-frontmatter Markdown 文件（`SKILL.md`），用于向对话注入 prompt 上下文。Skills 通过目录扫描被 SDK 发现。Kin 用三种机制管理它们：启用时复制、禁用否决列表、以及 Composer UI 的懒 schema 生成。本课解释每种机制为何存在及其带来的权衡。

## 问题

三类需求必须同时满足：

1. 用户必须能一键开关 Skills。
2. SDK 必须能在磁盘上找到已启用的 Skills，因为它使用 `settingSources: ['project']`。
3. 平台必须能够向用户推送精选 Skills 作为默认，同时尊重用户明确选择退出的决定。

需求 2 和 3 合在一起产生冲突：如果平台反复把精选 Skills 同步给每个用户，它会重新启用用户已禁用的 Skills。需要一种机制，让平台推送默认的同时，让用户永久否决特定 Skills。

## 为什么朴素方案失败

- **把 Skills 存数据库**：SDK 不读数据库。它扫描磁盘。把 Skills 存进 Postgres 需要运行时把它们物化回磁盘，这是浪费的间接层。
- **用符号链接代替复制**：符号链接会让所有用户共享同一源码。一个用户或 store 更新 Skill 会影响所有人。Skills 需要每用户隔离。
- **每次会话强制完整平台同步**：这会重新启用用户禁用的 Skills，造成 Skill 关闭后反复出现的混乱体验。

## 核心设计

> **启用时复制、禁用否决、懒 schema 生成。平台可以推送默认；用户可以否决单个 Skills；SDK 只看到文件系统真相。**

- **启用时复制**：`enableSkill()` 把 `src/skills-store/<slug>/` 复制到 `~/.claude/skills/<slug>/`。每个用户得到独立副本。重新启用时先删除旧副本再复制新副本，顺带更新到最新 store 版本。
- **禁用否决**：`disableSkill()` 删除目录并把 slug 写入 `~/.claude/.disabled-skills.json`。平台同步会跳过该文件中任何 slug。这让用户的“不”永久有效，同时允许平台推送新默认。
- **懒 schema 生成**：用户点击“生成表单”时，Kin 用 SDK Structured Outputs 单独调用，从 `SKILL.md` 中提取最多六个表单字段。结果写入 `.schema.json` 和 `.schema.meta.json` 旁支文件，并带 `needsReview` 标志。这在主对话路径之外完成，因此不会给每轮增加延迟。
- **运行时注入**：`loadSkillContext()` 读取 `SKILL.md` 并把内容追加到系统提示，让模型在当前回合获得特定能力。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/claude/skills/manager.ts` | ~L126–180 | `enableSkill` 和 `disableSkill`（复制、删除、否决列表） |
| `src/claude/skills/store-seeder.ts` | — | 把内置 Skills 种子化到 `SKILLS_STORE_DIR` |
| `src/claude/skills/schema-generator.ts` | — | LLM 提取表单字段到 `.schema.json` + `.schema.meta.json` |
| `src/claude/skills/github-installer.ts` | — | 从 GitHub ZIP 归档安装 Skills |
| `ws-query-worker.mjs` | ~L100–124 | `loadSkillContext()` 把 `SKILL.md` 注入系统提示 |

`enableSkill` 执行 删除旧副本 → 复制新副本 → 从否决列表移除。`disableSkill` 相反：删除副本 → 加入否决。否决列表是平台精选与用户自治之间的边界。

## 反直觉结论

> **平台默认与用户自治之间的冲突，通过否决列表而不是布尔开关来解决。**

布尔开关会迫使一个选择：“平台同步时，是否覆盖用户的开关？”否决列表完全避开这个问题。平台推送默认；用户只记录自己永远不要的。两个机制操作在不同集合上，因此不会互相覆盖。好的仲裁不是选出赢家，而是改变游戏规则让双方都能赢。

## 生产坑

- **启用时复制线性消耗磁盘**：100 个用户启用同一 Skill 就创建 100 个副本。这是每用户隔离的代价。计划优化为数据库保存源，懒加载到磁盘。
- **Schema 生成输出不稳定**：LLM 结构化输出会变化。Kin 用大量分支归一化多种变体。`needsReview` 标志是诚实承认生成的 schema 是机器产物，应由人工检查。
- **启用后的副本不会自动更新**：store 更新 Skill 后，已启用用户的副本保持冻结，直到他们重新启用。目前没有版本比较来通知用户有更新。

## 相关 Kin 文档

- `src/claude/skills/manager.ts` — 启用/禁用与否决逻辑
- `src/claude/skills/schema-generator.ts` — 表单 schema 生成
- `src/claude/skills/store-seeder.ts` — 内置 Skill 种子化
- `ws-query-worker.mjs` — `loadSkillContext()` 运行时注入
- `zh/07-mcp-capability-center.md` — MCP 的文件系统启用

## 配图

1. `docs/blog/assets/img/08-skill-enable.svg` — Skill 启用流：store → 复制 → `~/.claude/skills` → SDK 扫描
2. `docs/blog/assets/img/08-disabled-veto.svg` — 禁用否决与平台同步
