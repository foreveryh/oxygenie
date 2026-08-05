/**
 * Gemini Imagen Runner (Canvas Agent, D6 — first real generation provider)
 *
 * Mirrors src/claude/glm-image/runner.js's shape (plain JS: ws-query-worker.mjs is a
 * plain `node` child process, no TS loader — see build-worker-env.js's header comment
 * for why every file it imports must be .js).
 *
 * Credentials: GEMINI_API_KEY/GEMINI_BASE_URL/GEMINI_IMAGE_MODEL in process.env. These
 * are normally injected per-session by ws-server.mjs's buildMediaGenEnv (resolved from
 * model-registry-v2's 'image' capability default, /admin/models) — this file stays
 * ignorant of that and just reads env, so it also works standalone from a raw
 * .env GEMINI_API_KEY when no registry default is configured (zero-admin-action
 * fallback). Docs: https://ai.google.dev/gemini-api/docs/imagen
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'imagen-4.0-generate-001';

// Nominal (not probed) pixel sizes per supported aspect ratio — used only for
// aspect-correct canvas layout (fitInSlot does a contain-fit, so exact pixel values
// don't matter, only the ratio). Real dimensions aren't probed in this slice (no
// `sharp` dependency yet — see spec's M1 risk registry note).
const ASPECT_DIMENSIONS = {
  '1:1': { width: 1024, height: 1024 },
  '3:4': { width: 768, height: 1024 },
  '4:3': { width: 1024, height: 768 },
  '9:16': { width: 576, height: 1024 },
  '16:9': { width: 1024, height: 576 },
};

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

async function callImagen({ prompt, count, aspectRatio, model, baseUrl, apiKey, customHeaders = {}, providerConfig = {} }) {
  const endpoint = `${baseUrl}/v1beta/models/${model}:predict`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      ...customHeaders,
    },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { ...providerConfig, sampleCount: count, aspectRatio },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Imagen API request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  const result = await response.json();
  if (!result.predictions || result.predictions.length === 0) {
    throw new Error('No predictions returned from Imagen API');
  }
  return result.predictions;
}

/**
 * Generate image(s) with Gemini Imagen.
 *
 * @param {Object} options
 * @param {string} options.prompt
 * @param {number} [options.count=1] - 1-4
 * @param {string} [options.aspect='1:1'] - one of ASPECT_DIMENSIONS keys
 * @param {string} options.outputDir - absolute path; files written here as {uuid}.{ext}
 * @param {string} [options.model] - explicit override; else env GEMINI_IMAGE_MODEL; else DEFAULT_MODEL
 * @returns {Promise<{ files: Array<{ id: string, relPath: string, width: number, height: number }> }>}
 */
export async function generateImage({
  prompt,
  count = 1,
  aspect = '1:1',
  outputDir,
  model,
  baseUrl: baseUrlOverride,
  apiKey: apiKeyOverride,
  customHeaders,
  providerConfig,
}) {
  const resolvedModel = model || process.env.GEMINI_IMAGE_MODEL || DEFAULT_MODEL;
  const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Prompt is required');
  }
  const aspectRatio = ASPECT_DIMENSIONS[aspect] ? aspect : '1:1';
  const dims = ASPECT_DIMENSIONS[aspectRatio];
  const sampleCount = Math.min(4, Math.max(1, count));
  const baseUrl = baseUrlOverride || process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL;

  const predictions = await callImagen({
    prompt,
    count: sampleCount,
    aspectRatio,
    model: resolvedModel,
    baseUrl,
    apiKey,
    customHeaders,
    providerConfig,
  });

  await fs.mkdir(outputDir, { recursive: true });

  const files = [];
  for (const prediction of predictions) {
    if (!prediction.bytesBase64Encoded) {
      // Content-filtered or otherwise empty prediction — skip, don't fail the whole batch.
      console.error('[gemini-image] Prediction had no image bytes (filtered?), skipping:', prediction.raiFilteredReason || 'unknown reason');
      continue;
    }
    const ext = MIME_EXT[prediction.mimeType] || '.png';
    const id = crypto.randomUUID();
    const relPath = `${id}${ext}`;
    const buffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
    await fs.writeFile(path.join(outputDir, relPath), buffer);
    files.push({ id, relPath, width: dims.width, height: dims.height });
  }

  if (files.length === 0) {
    throw new Error('All predictions were filtered — no images produced');
  }

  return { files };
}
