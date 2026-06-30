---
title: "Artifact 检测与 Workbench"
slug: 16-artifacts-and-workbench
date: 2026-06-07
keywords: [artifact, workbench, structured outputs, seq, session UI, turn card]
---

# Artifact 检测与 Workbench

真预览环境就位后，前端必须回答两个问题：它如何知道某轮对话产生了 artifact，以及如何把产生的事件流呈现给用户。本课解释 artifact 检测、会话 UI 的排序问题，以及 Workbench 的当前状态。

## 问题

UI 层有四件事必须正确发生：

1. **识别交付物**：在模型一轮中写或编辑的所有文件里，哪些构成可交付 artifact，哪些只是附带输出？
2. **每轮收敛为一张卡**：一个多文件 app 是一个交付物，不是四个独立文件。UI 不应该每个 `Write` 调用一张卡。
3. **维护有序时间线**：历史消息和实时事件来自不同来源，可能乱序到达。它们必须合并成一条无重复的时间线。
4. **填充 Workbench**：右侧面板显示 progress、sub-agents、files 和 context。每个面板都需要真实数据源。

## 为什么朴素方案失败

- **每个 `Write` 一张卡**：一个 Vite 项目生成 `package.json`、`src/main.tsx`、`src/App.tsx`、`index.html`。每张文件一张卡会产生一堵令人困惑的相似卡墙。
- **SDK structured outputs 做 artifact 声明**：`outputFormat` 可以让模型结构化声明 artifact，但 SDK 的 stop-hook 会把 `You MUST call the StructuredOutput tool` 泄漏到对话上下文，污染模型行为。结构化输出有用，但不能作为唯一真相源。
- **按到达时间排序**：WebSocket 帧和恢复后的消息可能交错。没有共同排序键，时间线会损坏。
- **从工具名中抓取 Workbench 数据**：progress 从 `TodoWrite` 推断，sub-agents 从 `Task` 推断。这很脆弱，滞后于实际状态。

## 核心设计

> **启发式 artifact 检测 + 基于 `seq` 的事件排序 + 每轮卡片折叠 + 用真实数据源填充 Workbench。**

- **启发式检测**：`use-artifact-detection.ts` 扫描工具结果中的文件路径，按扩展名映射到 artifact 类型（HTML、SVG、Markdown、React、JSON、CSV、图片）。这是稳定的基线。
- **结构化输出作为增强**：如果启用，`ENABLE_STRUCTURED_OUTPUTS` 可以改善 artifact 检测，但永远不是唯一真相源。stop-hook 污染使它不能单独依赖。
- **Seq 排序**：每个事件从 worker 带单调递增的 `seq`。前端按 `seq` 合并事件，而不是按到达时间。这给历史消息和实时事件一个共同排序键。
- **Turn card 折叠**：一轮渲染为一张卡，包含文本响应、可选预览卡和步骤与变更文件的可折叠摘要。
- **Workbench 真实数据**：Files 通过 server function 从真实工作区文件系统读取。Context 从使用元数据（模型、token、skills、MCPs）构建。Progress 和 sub-agents 仍从工具事件推导，但现在与 UI 其余部分对齐。

## 关键实现点

| 文件 | 行号 | 机制 |
|---|---|---|
| `src/lib/hooks/use-artifact-detection.ts` | ~L49–75 / L97–121 / L243–256 | 扩展名映射 / 提取 artifact / 构建卡片 |
| `src/lib/artifacts/artifact-registry.ts` | ~L43–50 / L52,59 | 内容哈希、`MAX_VERSIONS=10`，当前 `ENABLE_VERSION_RECORDING=false` |
| `src/lib/chat-session-store.ts` | ~L401–538 | `mergeMessagesIntoThread` + tool_result 回填 |
| `src/claude/adapters/ws-adapter.ts` | ~L524–531 | `messages_loaded` 处理 |
| `src/components/claude-chat/workbench-panel.tsx` | 多处 | Workbench 面板 |

## 状态：大部分已交付，seq 排序仍是主要结构债务

Artifact 检测和 Workbench 硬ening 已交付。Workbench 现在读取真实工作区文件，把 `info` 整合进 Context，自动打开正确标签，支持可折叠侧栏，并使用统一的 session-file 按钮控制右侧面板。

剩余的结构债务是前端事件 store **对 `seq` 排序和去重的使用**。虽然 worker 协议已经给每帧带 `seq`，但前端 store 尚未按 `seq` 合并渲染。这是偶尔 resume 后队列停滞和消息重影的根因。修复它是已知、有界的任务。

## 反直觉结论

> **当结构化 SDK 功能把内部指令泄漏到对话中时，回退到启发式是更干净的工程选择。**

启发式检测局部脆弱——漏掉的扩展名只需加一行——但它不改变模型上下文。被污染的上下文是全局且不可见的。权衡倾向于控制而非优雅。同样原则适用于每个被消费的 SDK 功能：信任核心 loop，但验证暴露内部的功能。

## 生产坑

- **启发式检测可能把解释性代码块误当交付物**。模型可能在文本答案中包含示例片段。没有结构化 manifest，检测器可能为它建卡。启发式 + manifest 是稳定基线；结构化输出是可选的精度提升。
- **`messages_loaded` 在 adapter 和事件队列中都被处理**。如果 `queue.switch()` 漏掉该事件类型，resume 后队列会停滞。这是会话 UI 中最活跃的结构坑。
- **`ENABLE_VERSION_RECORDING=false`**。Artifact 版本记录已实现但当前禁用，因此“10 版本”限制未生效。

## 相关 Kin 文档

- `src/lib/hooks/use-artifact-detection.ts` — 启发式检测
- `src/lib/artifacts/artifact-registry.ts` — artifact registry 与版本策略
- `src/lib/chat-session-store.ts` — 消息合并与线程状态
- `src/claude/adapters/ws-adapter.ts` — adapter 与消息加载
- `zh/04-streaming-protocol.md` — worker 协议中的 seq 编号
- `zh/15-real-preview.md` — manifest 与真预览管线

## 配图

1. `docs/blog/assets/img/16-artifact-detection.svg` — 工具结果 → 扩展名映射 → artifact 卡
2. `docs/blog/assets/img/16-seq-ordering.svg` — 会话 UI 排序问题与基于 seq 的合并
