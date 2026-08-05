# 画板多模型 References 实施计划

[完成待回收]

## 目标

按《画板多模型生成与 References 能力协议 PRD》实现 provider 中立的生成模式、References 角色和参数组合，并以 MiniMax H3 完整参考素材请求作为首个复杂验收。

## 依赖

- 已有媒体 Adapter Registry 与模型级 `mediaConfig`；
- 已有画板选择状态与 `inputAssetIds` 任务链路；
- MiniMax H3 V2 官方创建/查询接口。

## 实施顺序

1. 扩展 `media-capabilities.js`，保持旧配置兼容；
2. 扩展任务参数和直接生成接口，冻结模式及 References；
3. 改造任务处理器，将画板资产解析成规范媒体输入；
4. 改造 DirectGenBar，实现模式推断与统一交互；
5. 扩展 H3 Adapter 支持参考图/视频/音频；
6. 补充音频画板资产的最小上传、展示和选择能力；
7. 增加能力与 Adapter 测试，执行 typecheck/build/test/diff-check。

## 文件所有权

本轮由 Codex 单线实施，不并行修改同一文件。

## 验收

以 PRD §12 的 12 项标准为准。完成后将本文件标记为 `[完成待回收]`，并记录实际验证结果。

## 实施结果

- 已完成 provider 中立的模式、输入槽、References 角色和条件参数组合协议，并兼容旧能力字段；
- 已完成 DirectGenBar 的能力驱动交互，不包含 Seedance、MiniMax、Gemini 或 Grok 的 provider 分支；
- 已完成任务快照、服务端权威校验、执行前复验和 Adapter 转换链路；
- 已完成 MiniMax H3 图片、视频、音频参考素材及首尾帧互斥实现；
- 已完成 Grok Imagine 官方异步视频 Adapter，并支持 Base URL、路径、Header 和字段路径覆盖；
- 已补齐画板音频上传、展示、选择及 References 传递；
- 已同步 Agent `generate_video` 工具使用相同模式和角色协议。

## 验证结果

- `oxlint`：相关文件 0 warning、0 error；
- 媒体能力与 Adapter 单测：3 个文件、15 项测试全部通过；
- 全量单测：284 项已收集测试通过；另有 2 个既有测试文件在收集阶段因未配置 `DATABASE_URL` 失败；
- `pnpm build`：通过；
- `git diff --check`：通过；
- 全量 TypeScript 检查仍受仓库既有错误阻塞；过滤本轮相关文件后，未发现本轮新增类型错误，唯一命中为 `chat-composer.tsx` 中既有的 `removeAttachment` 问题。
