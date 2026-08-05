/**
 * Provider catalog (registry v2) — the curated, in-repo list of known providers the
 * admin UI offers when adding a connection. Picking an entry pre-fills baseUrl /
 * protocol / auth style and suggests common models with capability tags, so a
 * non-technical admin only pastes an API key.
 *
 * Deliberately STATIC (kin CLAUDE.md: capabilities are a curated set, not an open
 * marketplace). `knownModels` are non-binding suggestions — model IDs drift with
 * provider releases; admins can edit them freely. Update this file with releases.
 *
 * IMPORTANT: only `protocol: 'anthropic'` entries can serve the 'chat' capability
 * (Agent runtime, SDK 0.2.112 + ARK constraint). The admin server fns enforce this;
 * entries below must not suggest 'chat' models on non-anthropic protocols.
 */

import type { ModelCapability, ModelMediaConfig, ModelProtocol } from '~/db/schema/model.schema';

export type CatalogModel = {
  model: string;
  label: string;
  capabilities: ModelCapability[];
  mediaAdapter?: string | null;
  mediaConfig?: ModelMediaConfig;
};

export type CatalogProvider = {
  slug: string;
  label: string;
  protocol: ModelProtocol;
  /** null → admin must fill in (custom entries). */
  baseUrl: string | null;
  authStyle: 'bearer' | 'x-api-key';
  /** Where to obtain a key — shown as a link in the UI. */
  keyUrl?: string;
  /** Short hint about key format / account requirements. */
  note?: string;
  knownModels: CatalogModel[];
};

export const PROVIDER_CATALOG: CatalogProvider[] = [
  {
    slug: 'ark',
    label: '火山方舟 ARK（Anthropic 兼容 · 可作对话模型）',
    protocol: 'anthropic',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    authStyle: 'bearer',
    keyUrl: 'https://console.volcengine.com/ark',
    note: 'kin 默认对话网关。模型串按方舟控制台的接入点/模型 ID 填写。',
    knownModels: [],
  },
  {
    slug: 'anthropic',
    label: 'Anthropic 官方（可作对话模型）',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    authStyle: 'x-api-key',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    knownModels: [
      { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', capabilities: ['chat', 'vision'] },
      { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', capabilities: ['chat', 'vision'] },
    ],
  },
  {
    slug: 'deepseek',
    label: 'DeepSeek（Anthropic 兼容 · 可作对话模型）',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authStyle: 'bearer',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    knownModels: [{ model: 'deepseek-chat', label: 'DeepSeek Chat', capabilities: ['chat'] }],
  },
  {
    slug: 'zhipu-anthropic',
    label: '智谱 AI（Anthropic 兼容 · 可作对话模型）',
    protocol: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    authStyle: 'bearer',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    knownModels: [],
  },
  {
    slug: 'zhipu-open',
    label: '智谱 AI 开放平台（生图/生视频/识图/向量）',
    protocol: 'openai-compat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    authStyle: 'bearer',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '与「智谱 Anthropic 兼容」可用同一个 key、分开建连接。',
    knownModels: [
      { model: 'glm-image', label: 'GLM-Image（生图）', capabilities: ['image'] },
      { model: 'cogvideox-3', label: 'CogVideoX（生视频）', capabilities: ['video'] },
      { model: 'glm-4v-plus', label: 'GLM-4V Plus（识图）', capabilities: ['vision'] },
      { model: 'embedding-3', label: 'Embedding-3（向量）', capabilities: ['embedding'] },
    ],
  },
  {
    slug: 'openai',
    label: 'OpenAI（生图/识图/向量 · 不可作对话模型）',
    protocol: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    authStyle: 'bearer',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'OpenAI 协议无法驱动 kin 的 Agent 对话运行时，仅用于生成/识别类能力。',
    knownModels: [
      { model: 'gpt-image-1', label: 'GPT Image 1（生图）', capabilities: ['image'] },
      { model: 'dall-e-3', label: 'DALL·E 3（生图）', capabilities: ['image'] },
      { model: 'gpt-4o', label: 'GPT-4o（识图）', capabilities: ['vision'] },
      { model: 'text-embedding-3-small', label: 'Text Embedding 3 Small（向量）', capabilities: ['embedding'] },
    ],
  },
  {
    slug: 'gemini',
    label: 'Google Gemini（生图/生视频/识图/向量 · 不可作对话模型）',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    authStyle: 'bearer',
    keyUrl: 'https://aistudio.google.com/apikey',
    knownModels: [
      { model: 'imagen-3.0-generate-002', label: 'Imagen 3（生图）', capabilities: ['image'], mediaAdapter: 'google-imagen' },
      { model: 'veo-3.0-generate-preview', label: 'Veo 3（生视频）', capabilities: ['video'], mediaAdapter: 'google-veo' },
      { model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash（识图）', capabilities: ['vision'] },
      { model: 'text-embedding-004', label: 'Text Embedding 004（向量）', capabilities: ['embedding'] },
    ],
  },
  {
    slug: 'minimax',
    label: 'MiniMax（海螺视频）',
    protocol: 'custom',
    baseUrl: 'https://api.minimax.io',
    authStyle: 'bearer',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    note: '使用 MiniMax 异步视频 API。若使用中转站，直接改 Base URL；路径、轮询和附加参数可在模型的 Media config JSON 中覆盖。',
    knownModels: [
      { model: 'MiniMax-Hailuo-2.3', label: 'Hailuo 2.3（生视频）', capabilities: ['video'], mediaAdapter: 'minimax-video' },
      { model: 'MiniMax-Hailuo-2.3-Fast', label: 'Hailuo 2.3 Fast（生视频）', capabilities: ['video'], mediaAdapter: 'minimax-video' },
      {
        model: 'MiniMax-H3', label: 'MiniMax H3（V2 · 2K / 4–15 秒）', capabilities: ['video'], mediaAdapter: 'minimax-h3-video',
        mediaConfig: { capabilities: { video: { aspects: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], durationSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['768p', '2k'], firstFrame: true, lastFrame: true, aspectFromFirstFrame: true } } },
      },
      {
        model: 'MiniMax-Hailuo-02', label: 'Hailuo 02（首尾帧生视频）', capabilities: ['video'], mediaAdapter: 'minimax-video',
        mediaConfig: { capabilities: { video: { aspects: ['16:9', '9:16'], durationSeconds: [6, 10], resolutions: ['1080p'], firstFrame: true, lastFrame: true } } },
      },
    ],
  },
  {
    slug: 'seedance',
    label: 'Seedance 2（视频 · 官方/中转站）',
    protocol: 'custom',
    baseUrl: null,
    authStyle: 'bearer',
    note: 'Seedance 的售卖网关不止一种，故不预置可能失效的官方地址。填服务商 Base URL；默认兼容 /v1/videos/generations + /v1/tasks/{taskId}，其他路径/响应字段在 Media config JSON 覆盖。',
    knownModels: [
      {
        model: 'seedance-2.0', label: 'Seedance 2.0（4–15 秒）', capabilities: ['video'], mediaAdapter: 'seedance-video',
        mediaConfig: { capabilities: { video: { aspects: ['16:9', '9:16'], durationSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['480p', '720p', '1080p'], firstFrame: true, lastFrame: false } } },
      },
      {
        model: 'seedance-2.5', label: 'Seedance 2.5（最长 30 秒）', capabilities: ['video'], mediaAdapter: 'seedance-video',
        mediaConfig: { capabilities: { video: { aspects: ['16:9', '9:16'], durationSeconds: [5, 10, 15, 30], resolutions: ['720p', '1080p'], firstFrame: true, lastFrame: false } } },
      },
    ],
  },
  {
    slug: 'xai-imagine',
    label: 'xAI Grok Imagine（视频 · 官方/中转站）',
    protocol: 'custom',
    baseUrl: 'https://api.x.ai',
    authStyle: 'bearer',
    keyUrl: 'https://console.x.ai',
    note: '默认使用 xAI /v1/videos/generations + /v1/videos/{requestId}；中转站可替换 Base URL，并通过 Media config 覆盖路径和响应字段。',
    knownModels: [
      {
        model: 'grok-imagine-video-1.5', label: 'Grok Imagine Video 1.5（1–15 秒）', capabilities: ['video'], mediaAdapter: 'grok-imagine-video',
        mediaConfig: { capabilities: { video: { aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'], durationSeconds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['480p', '720p', '1080p'], firstFrame: true, lastFrame: false } } },
      },
    ],
  },
  {
    slug: 'openrouter',
    label: 'OpenRouter（聚合网关 · 不可作对话模型）',
    protocol: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    authStyle: 'bearer',
    keyUrl: 'https://openrouter.ai/settings/keys',
    knownModels: [],
  },
  {
    slug: 'ollama',
    label: 'Ollama（本地 · 识图/向量）',
    protocol: 'openai-compat',
    baseUrl: 'http://localhost:11434/v1',
    authStyle: 'bearer',
    note: '本地部署无需真实 key（填任意占位串即可）。容器内访问宿主机用 http://host.docker.internal:11434/v1。',
    knownModels: [],
  },
  {
    slug: 'custom-anthropic',
    label: '自定义（Anthropic 兼容 · 可作对话模型）',
    protocol: 'anthropic',
    baseUrl: null,
    authStyle: 'bearer',
    knownModels: [],
  },
  {
    slug: 'custom-openai',
    label: '自定义（OpenAI 兼容）',
    protocol: 'openai-compat',
    baseUrl: null,
    authStyle: 'bearer',
    knownModels: [],
  },
  {
    slug: 'custom-media',
    label: '自定义媒体服务（由 Media Adapter 驱动）',
    protocol: 'custom',
    baseUrl: null,
    authStyle: 'bearer',
    note: '先安装对应 media adapter，再添加模型并填写 adapter ID；端点路径和异步任务协议由 adapter 处理。',
    knownModels: [],
  },
];

export function getCatalogProvider(slug: string): CatalogProvider | undefined {
  return PROVIDER_CATALOG.find((p) => p.slug === slug);
}
