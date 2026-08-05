/** Server-only media route resolution for canvas jobs. */

import { getDefaultModelFor, resolveModelMeta, type ModelCapability } from './registry';
import { openSecret } from '~/server/security/secret-box';
import type { ModelMediaConfig } from '~/db/schema/model.schema';

export type ResolvedMediaRoute = {
  id: string;
  adapter: string;
  protocol: string;
  model: string;
  baseUrl: string;
  authStyle: 'bearer' | 'x-api-key';
  apiKey: string;
  customHeaders: Record<string, string>;
  config: ModelMediaConfig;
};

export async function resolveMediaRoute(
  capability: Extract<ModelCapability, 'image' | 'video'>,
  requestedModelId?: string | null,
): Promise<ResolvedMediaRoute> {
  const modelId = requestedModelId || await getDefaultModelFor(capability, null);
  if (!modelId || modelId === `legacy/${capability === 'image' ? 'imagen' : 'veo'}`) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error(`No default ${capability} model is configured`);
    return {
      id: capability === 'image' ? 'legacy/imagen' : 'legacy/veo',
      adapter: capability === 'image' ? 'google-imagen' : 'google-veo',
      protocol: 'gemini',
      model: capability === 'image'
        ? process.env.GEMINI_IMAGE_MODEL || 'imagen-4.0-generate-001'
        : process.env.GEMINI_VIDEO_MODEL || 'veo-3.1-generate-preview',
      baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
      authStyle: 'x-api-key',
      apiKey,
      customHeaders: {},
      config: {},
    };
  }

  const meta = await resolveModelMeta(modelId);
  if (!meta) throw new Error(`Media model "${modelId}" no longer exists`);
  if (!meta.enabled) throw new Error(`Media model "${modelId}" is disabled`);
  if (!meta.capabilities.includes(capability)) {
    throw new Error(`Model "${modelId}" does not declare the "${capability}" capability`);
  }

  const apiKey = meta.credentialEncrypted
    ? openSecret(meta.credentialEncrypted)
    : meta.tokenEnv
      ? process.env[meta.tokenEnv]
      : undefined;
  if (!apiKey?.trim()) {
    throw new Error(`No credential is configured for media model "${modelId}"`);
  }

  return {
    id: meta.id,
    adapter: meta.mediaAdapter || 'auto',
    protocol: meta.protocol,
    model: meta.model,
    baseUrl: meta.baseUrl,
    authStyle: meta.authStyle,
    apiKey,
    customHeaders: meta.customHeaders ?? {},
    config: meta.mediaConfig ?? {},
  };
}
