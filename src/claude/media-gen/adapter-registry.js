/**
 * Media generation adapter registry.
 *
 * Canvas and Agent code call `generateMedia` with one stable input/output contract.
 * Provider-specific URL paths, auth headers, async polling, response parsing and
 * downloads live behind an adapter. Adding a new provider therefore means adding
 * one adapter module and registering it here; canvas orchestration does not change.
 *
 * This file is plain JS because ws-query-worker.mjs runs directly in Node without a
 * TypeScript loader. Keep every module it imports plain JS for the same reason.
 */

import { generateImage as generateGoogleImage } from './gemini-image-runner.js';
import { generateVideo as generateGoogleVideo } from './gemini-video-runner.js';
import { generateMiniMaxVideo } from './minimax-video-runner.js';
import { generateMiniMaxH3Video } from './minimax-h3-video-runner.js';
import { generateSeedanceVideo } from './seedance-video-runner.js';
import { generateGrokVideo } from './grok-video-runner.js';

/** @typedef {'image'|'video'} MediaCapability */

/**
 * @typedef {Object} ResolvedMediaRoute
 * @property {string} id
 * @property {string} adapter
 * @property {string} model
 * @property {string} baseUrl
 * @property {'bearer'|'x-api-key'} authStyle
 * @property {string} apiKey
 * @property {Record<string, string>} [customHeaders]
 * @property {Record<string, unknown>} [config]
 */

/** @type {Map<string, {id: string, capabilities: MediaCapability[], generate: Function}>} */
const adapters = new Map();

export function registerMediaAdapter(adapter) {
  if (!adapter?.id || typeof adapter.generate !== 'function') {
    throw new Error('Invalid media adapter: expected { id, capabilities, generate }');
  }
  if (adapters.has(adapter.id)) {
    throw new Error(`Media adapter already registered: ${adapter.id}`);
  }
  adapters.set(adapter.id, adapter);
  return adapter;
}

export function getMediaAdapter(id) {
  const adapter = adapters.get(id);
  if (!adapter) {
    const installed = [...adapters.keys()].sort().join(', ') || '(none)';
    throw new Error(`Media adapter "${id}" is not installed. Installed adapters: ${installed}`);
  }
  return adapter;
}

export function listMediaAdapters() {
  return [...adapters.values()].map(({ id, capabilities }) => ({ id, capabilities: [...capabilities] }));
}

/** Legacy inference keeps existing Gemini rows working after the schema migration. */
export function inferMediaAdapter(route, capability) {
  if (route?.adapter && route.adapter !== 'auto') return route.adapter;
  if (route?.protocol === 'gemini') return capability === 'image' ? 'google-imagen' : 'google-veo';
  throw new Error(
    `Model "${route?.id || route?.model || 'unknown'}" has no media adapter configured for ${capability}. ` +
    'Set mediaAdapter in Admin · Models after installing the provider adapter.',
  );
}

/**
 * Execute one media generation using a provider-neutral contract.
 * Adapters may internally use a synchronous endpoint or submit/poll/download an
 * asynchronous provider task; callers always receive normalized local files.
 */
export async function generateMedia({ capability, route, input, outputDir }) {
  if (!route?.apiKey) throw new Error(`No credential resolved for media model "${route?.id || 'unknown'}"`);
  const adapterId = inferMediaAdapter(route, capability);
  const adapter = getMediaAdapter(adapterId);
  if (!adapter.capabilities.includes(capability)) {
    throw new Error(`Media adapter "${adapterId}" does not support ${capability}`);
  }
  return adapter.generate({ route: { ...route, adapter: adapterId }, input, outputDir });
}

/**
 * Reconstruct the typed route injected by ws-server for an Agent child process.
 * A separate prefix per capability prevents image/video defaults from clobbering
 * each other when they use different providers or credentials.
 */
export function mediaRouteFromEnv(capability, env = process.env) {
  const prefix = capability === 'image' ? 'KIN_MEDIA_IMAGE' : 'KIN_MEDIA_VIDEO';
  const apiKey = env[`${prefix}_API_KEY`];
  const model = env[`${prefix}_MODEL`];
  const baseUrl = env[`${prefix}_BASE_URL`];
  if (!apiKey || !model || !baseUrl) {
    if (!env.GEMINI_API_KEY) return null;
    return {
      id: capability === 'image' ? 'legacy/imagen' : 'legacy/veo',
      adapter: capability === 'image' ? 'google-imagen' : 'google-veo',
      protocol: 'gemini',
      model: capability === 'image'
        ? (env.GEMINI_IMAGE_MODEL || 'imagen-4.0-generate-001')
        : (env.GEMINI_VIDEO_MODEL || 'veo-3.1-generate-preview'),
      baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
      authStyle: 'x-api-key',
      apiKey: env.GEMINI_API_KEY,
      config: {},
      customHeaders: {},
    };
  }

  let config = {};
  let customHeaders = {};
  try {
    if (env[`${prefix}_CONFIG`]) config = JSON.parse(env[`${prefix}_CONFIG`]);
    if (env[`${prefix}_HEADERS`]) customHeaders = JSON.parse(env[`${prefix}_HEADERS`]);
  } catch (error) {
    throw new Error(`Invalid ${prefix} JSON configuration: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    id: env[`${prefix}_MODEL_ID`] || model,
    adapter: env[`${prefix}_ADAPTER`] || 'auto',
    protocol: env[`${prefix}_PROTOCOL`] || 'custom',
    model,
    baseUrl,
    authStyle: env[`${prefix}_AUTH_STYLE`] || 'bearer',
    apiKey,
    config,
    customHeaders,
  };
}

registerMediaAdapter({
  id: 'google-imagen',
  capabilities: ['image'],
  generate: ({ route, input, outputDir }) => generateGoogleImage({
    prompt: input.prompt,
    count: input.count,
    aspect: input.aspect,
    outputDir,
    model: route.model,
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    customHeaders: route.customHeaders,
    providerConfig: route.config,
  }),
});

registerMediaAdapter({
  id: 'google-veo',
  capabilities: ['video'],
  generate: ({ route, input, outputDir }) => generateGoogleVideo({
    prompt: input.prompt,
    imagePath: input.imagePath,
    aspect: input.aspect,
    durationSeconds: input.durationSeconds,
    resolution: input.resolution,
    outputDir,
    model: route.model,
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    customHeaders: route.customHeaders,
    providerConfig: route.config,
  }),
});

registerMediaAdapter({
  id: 'minimax-video',
  capabilities: ['video'],
  generate: ({ route, input, outputDir }) => generateMiniMaxVideo({ route, input, outputDir }),
});

registerMediaAdapter({
  id: 'minimax-h3-video',
  capabilities: ['video'],
  generate: ({ route, input, outputDir }) => generateMiniMaxH3Video({ route, input, outputDir }),
});

registerMediaAdapter({
  id: 'seedance-video',
  capabilities: ['video'],
  generate: ({ route, input, outputDir }) => generateSeedanceVideo({ route, input, outputDir }),
});

registerMediaAdapter({
  id: 'grok-imagine-video',
  capabilities: ['video'],
  generate: ({ route, input, outputDir }) => generateGrokVideo({ route, input, outputDir }),
});
