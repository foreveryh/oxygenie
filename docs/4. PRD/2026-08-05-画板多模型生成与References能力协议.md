# 画板多模型生成与 References 能力协议 PRD

状态：实施基线
日期：2026-08-05
适用范围：Kin 画板直接生成、Canvas Agent 媒体生成、模型管理

## 1. 背景

Kin 画板本质上是一个可自由组织的素材库。用户在画板上选中图片、视频或音频后，这些素材进入本次操作的 References；生成组件负责把 References、提示词和参数组织成一次模型请求。

现有实现已经具备模型级媒体 Adapter、可替换 Base URL、模型选择以及时长/分辨率基础约束，但 References 仍被简化为 `inputAssetIds`：视频生成仅取前两张图片，并固定解释成首帧和尾帧。它不能表达多参考图、参考视频、参考音频、视频编辑等模型能力，也无法表达“首尾帧与参考素材互斥”以及“1080P 只允许某些时长”等条件约束。

后续重点覆盖四个模型族：

- Seedance；
- MiniMax / 海螺；
- Google Gemini / Veo；
- xAI Grok Imagine。

模型提供方可能是官方，也可能是中转站。产品不能把 provider 名称、固定 Base URL 或某家请求字段写进画板组件。

## 2. 产品目标

1. 用户在所有模型下使用一致流程：选素材、选模型、确认素材用途、选参数、生成。
2. 简单模型保持简单；只有素材用途存在歧义时才要求用户选择模式。
3. 当前模型不支持的素材、时长、分辨率或组合在请求前可见，不以供应商报错作为正常交互。
4. 新模型接入只需增加 Adapter 和模型能力声明，不修改画板业务组件。
5. 官方与中转站共用同一模型能力协议；连接配置允许替换 Base URL、路径、鉴权和响应字段。
6. 浏览器、服务端任务创建、队列执行三层使用同一能力规则，避免陈旧客户端绕过限制产生计费请求。

## 3. 非目标

- 不建设通用视频时间线或剪辑器；
- 不自动保证任意中转站与官方协议完全兼容；中转站偏差仍由 Adapter 配置承担；
- 不在画板节点上永久标记“这张图永远是首帧”；用途属于一次生成请求；
- 不把四个模型族写成系统白名单，未来第五种模型仍可注册；
- 不在能力未知时猜测模型限制。未知项不显示、不发送，由供应商默认值处理。

## 4. 核心概念

### 4.1 模型族、连接与模型部署

- 模型族：Seedance、MiniMax、Gemini/Veo、Grok Imagine 等产品/API 家族；
- 连接：官方 API、中转站或私有代理，持有 Base URL、凭据、鉴权方式和自定义 Header；
- 模型部署：具体可调用的模型 ID，持有 Adapter 和能力声明。

同一个模型部署可切换连接；同一连接可挂载能力不同的多个模型。

### 4.2 References

References 是当前画板选中素材在一次生成请求中的快照。每项包含：

```ts
type GenerationReference = {
  assetId: string
  modality: 'image' | 'video' | 'audio'
  role:
    | 'first_frame'
    | 'last_frame'
    | 'reference_image'
    | 'reference_video'
    | 'reference_audio'
    | 'edit_source'
  order: number
  durationSec?: number
}
```

`modality` 由服务端根据画板资产决定，客户端不能伪造；`role` 由当前生成模式决定；`order` 保留画板选择顺序，可用于首尾帧与多参考素材排序。

### 4.3 生成模式

生成模式是 provider 中立的用户意图：

- `text_to_video`：纯文本生成；
- `first_last_frame`：首帧必选，尾帧可选；
- `reference`：参考图、视频、音频的任意受支持组合；
- `video_edit`：以一个视频为编辑源；
- 后续可增加 `video_extend` 等稳定语义。

互斥关系优先由模式边界表达。例如 H3 的首尾帧模式与参考素材模式天然互斥，不需要 UI 编写 MiniMax 特判。

## 5. 模型能力协议

模型在 `mediaConfig.capabilities.video` 中声明：

```json
{
  "aspects": ["16:9", "9:16"],
  "durationSeconds": [5, 10, 15],
  "resolutions": ["720p", "1080p"],
  "modes": [
    { "id": "text_to_video", "label": "文生视频", "inputs": [] },
    {
      "id": "first_last_frame",
      "label": "首尾帧",
      "aspectBehavior": "input",
      "inputs": [
        { "role": "first_frame", "accepts": ["image"], "min": 1, "max": 1 },
        { "role": "last_frame", "accepts": ["image"], "min": 0, "max": 1 }
      ]
    }
  ],
  "parameterCombinations": [
    { "resolution": "720p", "durationSeconds": [5, 10, 15] },
    { "resolution": "1080p", "durationSeconds": [5, 10] }
  ]
}
```

输入槽可额外声明：

- 数量上下限；
- 单文件体积；
- 单段最短/最长时长；
- 同类型素材总时长；
- 支持的文件格式；
- `aspectBehavior`：`select`、`input` 或 `adaptive`。

能力属于具体模型部署而不是 provider。Adapter 提供安全基线，管理员可通过模型配置覆盖，以适配中转站的真实能力。

### 5.1 向后兼容

旧配置中的 `firstFrame`、`lastFrame`、`aspectFromFirstFrame` 继续读取，并被规范化为对应模式。新代码只消费规范化后的 `modes`。旧任务中的 `inputAssetIds` 继续按第一张首帧、第二张尾帧执行。

## 6. 交互设计

### 6.1 一致流程

1. 用户在画板选中素材；
2. 打开图片或视频生成组件；
3. References 区展示当前选中素材；
4. 选择模型；
5. 系统根据素材类型计算可用模式；
6. 只有存在多个合理模式时显示“素材用途”；
7. 参数区根据模型和模式动态更新；
8. 不兼容项在提交前明确提示。

### 6.2 模式自动推断

- 无素材：自动使用 `text_to_video`；
- 一个图片且模型只支持首帧：自动使用首帧模式；
- 多种素材且模型只支持参考模式：自动使用参考模式；
- 一个图片在 H3 中既可作首帧又可作参考图：显示 `素材用途：[首尾帧] [参考素材]`；
- 首尾帧模式按选择顺序分配首帧和尾帧；后续允许拖动交换；
- 参考模式按素材类型自动分配 `reference_image/video/audio`，无需逐项下拉。

### 6.3 模型切换

切换模型后保留画板选择和用户意图，并立即重新校验：

- 新模型仍支持该模式：保留模式；
- 新模型不支持该模式但存在唯一兼容模式：切换到兼容模式并显示说明；
- 没有兼容模式：素材继续留在 References，但标记“不受当前模型支持”，禁止提交；
- 不允许静默丢弃素材。

### 6.4 参数呈现

参数使用所有启用模型的选项并集。当前模型不支持的值置灰，并显示可使用该值的模型，例如 `30 秒（需 Seedance 2.5）`。

条件组合也必须即时生效。例如选择 1080P 后，当前模型只允许 6 秒，则 10 秒置灰并说明“当前模型在 1080P 下仅支持 6 秒”。

模式若决定画幅，则隐藏或禁用画幅选择：首尾帧模式通常由输入图决定；参考模式是否允许指定画幅由模型声明。

## 7. H3 首个完整实现

H3 作为复杂能力验收模型，支持：

- 文生视频；
- 首帧、尾帧、首尾帧；
- 最多 9 张参考图；
- 最多 3 个参考视频，单段 2–15 秒、总计不超过 15 秒；
- 最多 3 个参考音频，单段 2–15 秒、总计不超过 15 秒；
- 首尾帧与参考素材互斥；
- 768P、2K，4–15 秒；
- 文生视频必须指定具体比例；首尾帧使用 adaptive；参考模式允许 adaptive 或具体比例。

本地素材通过 data URL 发送时还需受 64 MB 请求体约束。超过安全阈值时在 Kin 侧拒绝，并提示使用供应商可访问的 URL/文件上传能力；不得发送必然失败或过大的请求。

依据：[MiniMax-H3 V2 创建任务](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)。

## 8. 四个模型族验收矩阵

| 模型族 | 连接可替换 | 能力声明 | 当前实施重点 |
|---|---|---|---|
| Seedance | Base URL、路径、状态/结果字段 | 模式、时长、分辨率、比例 | 保持现有网关兼容，接入通用模式 |
| MiniMax | V1/V2 分 Adapter，连接可替换 | Hailuo 与 H3 分模型声明 | H3 完整 References；旧 Hailuo 不回归 |
| Gemini/Veo | Base URL、Key/Header | 按具体 Veo 版本声明 | 现有文生/图生视频接入通用模式 |
| Grok Imagine | Base URL、路径可配置 | 文生、单首帧、最多 7 张参考图；模式级分辨率约束 | 官方异步 API Adapter 已接入 |

矩阵只表示架构覆盖，不表示所有模型拥有同样能力。每个部署以其官方文档和中转站实测配置为准。

Grok Imagine 1.5 的公开参考音频能力使用受限的预设 `voice_id`，不接受用户上传音频片段。因此画板音频不会作为 Grok 参考音频发送；未来若开放可枚举的声音选择，应以模型参数描述符呈现，而不是伪装成画板资产槽。

依据：[xAI 视频生成](https://docs.x.ai/developers/model-capabilities/video/generation)、[xAI 图生视频](https://docs.x.ai/developers/model-capabilities/video/image-to-video)、[xAI Reference-to-Video](https://docs.x.ai/developers/model-capabilities/video/reference-to-video)。

## 9. 服务端与 Adapter 责任

浏览器负责即时反馈；服务端是权威校验源：

1. 校验资产归属当前画板；
2. 从数据库确定素材类型和元数据；
3. 校验模式、角色、数量、文件大小、已知时长和参数组合；
4. 冻结模型 ID、模式、References 角色和参数到任务；
5. Worker 执行前再次校验；
6. Adapter 将规范输入翻译成供应商字段。

Adapter 不访问数据库，不判断 UI 状态，只接收已经解析为本地路径或远程 URL的规范 References。

## 10. 错误与降级

- 模型能力未知：只开放明确声明的模式和参数；
- 中转站拒绝官方支持字段：保留供应商错误，但提示检查模型 Media config；
- 素材文件丢失：任务在调用供应商前失败；
- 素材数量或类型超限：浏览器与服务端给出相同语义的错误；
- 元数据未知：可验证的规则先验证，供应商仍是编码、帧率等深层约束的最终防线；
- 切换模型后参数失效：自动选择第一个有效默认值，并在界面上显示能力变化。

## 11. 数据与安全

- References 只保存画板资产 ID、角色和顺序，不保存客户端绝对路径；
- Worker 根据已验证的资产记录解析工作区路径；
- 不向浏览器暴露 API Key、自定义鉴权 Header 或连接密钥；
- Base URL 和响应路径配置只能由模型管理权限修改；
- 本地媒体转 data URL 前校验扩展名与文件大小，防止任意文件被发送给第三方。

## 12. 验收标准

1. H3 选择一张图时可在“首尾帧”和“参考素材”之间选择；
2. H3 首尾帧模式最多使用两张图片，角色顺序明确；
3. H3 参考模式可组合选中的图片、视频和音频，并生成正确 `content[]`；
4. H3 首尾帧与参考角色不会出现在同一次请求；
5. 超过各槽数量、体积或已知时长限制时，不调用供应商；
6. 切换到不支持当前 References 的模型时不静默丢弃，且不能提交；
7. 30 秒等跨模型选项按当前模型置灰并标注支持模型；
8. 条件参数组合在客户端和服务端均被拒绝；
9. 现有 Veo、Seedance、MiniMax V1 文生/首帧生成测试继续通过；
10. 新增模型无需修改 `direct-gen-bar.tsx` 的 provider 分支；
11. Base URL、路径和自定义 Header 继续可由连接/模型配置覆盖；
12. 构建、类型检查、媒体能力与 Adapter 单元测试通过。

## 13. 实施拆分

1. 能力协议：规范化 `modes`、输入槽和参数组合，兼容旧布尔字段；
2. 任务快照：保存模式和带角色 References；
3. 通用 UI：模式推断、歧义选择、禁用原因、参数联动；
4. 画板素材：References 支持图片、视频，并补齐音频资产上传与展示；
5. H3 Adapter：多参考图/视频/音频序列化和输入保护；
6. Agent 工具：后续复用同一规范 References，不另建供应商专用工具；
7. 测试与文档：能力、任务、Adapter、构建与回归。
