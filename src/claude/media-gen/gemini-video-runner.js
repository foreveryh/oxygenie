/**
 * Gemini Veo Video Runner (Canvas Agent, D6/M2-T6 — first real video provider)
 *
 * Plain JS — same reason as gemini-image-runner.js: ws-query-worker.mjs is a plain
 * `node` child process, no TS loader (see build-worker-env.js's header comment).
 *
 * Veo generation is asynchronous (Google's `predictLongRunning` long-running-operation
 * pattern), unlike Imagen's synchronous `predict` call — submit once, then poll an
 * opaque operation resource until `done`. The operation `name` returned by the submit
 * call is treated as fully opaque (never parsed/reconstructed) and just appended to
 * `{baseUrl}/v1beta/` for polling, per standard Google LRO client conventions — this
 * is deliberate: Google's docs don't pin down the exact internal path segments of
 * `name` precisely enough to hardcode an assumption about its shape.
 *
 * Credentials: GEMINI_API_KEY/GEMINI_BASE_URL/GEMINI_VIDEO_MODEL in process.env,
 * normally injected per-session by ws-server.mjs's buildMediaGenEnv (resolved from
 * model-registry-v2's 'video' capability default, /admin/models) — same
 * zero-admin-action fallback pattern as gemini-image-runner.js.
 *
 * Model/response-shape note: the exact field names in the completed-operation
 * response (`response.generateVideoResponse.generatedSamples[].video.uri`) are
 * Google's documented shape as of this writing but Veo is still a preview API — the
 * parser below checks a couple of plausible fallback shapes and throws a diagnosable
 * error (dumps the raw response) if none match, rather than silently misparsing.
 *
 * Live-verified 2026-07-06 (i2v): Google's own docs show the image field as
 * `image.inlineData` (the generateContent multimodal wrapper) — predictLongRunning
 * actually rejects that with a 400 and wants the classic Vertex-AI prediction shape
 * `image.bytesBase64Encoded` instead. Trust the live API over the docs here.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/veo
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'veo-3.1-generate-preview';

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 6 * 60 * 1000; // Veo generations commonly take 1-3min; generous ceiling

const SUPPORTED_ASPECTS = new Set(['16:9', '9:16']);
const SUPPORTED_DURATIONS = new Set([4, 6, 8]);
const SUPPORTED_RESOLUTIONS = new Set(['720p', '1080p']);

// Nominal (not probed) pixel sizes per aspect+resolution — same rationale as
// gemini-image-runner.js's ASPECT_DIMENSIONS: used only for slot-fit layout math
// (fitInSlot does a contain-fit, so exact values don't matter, only the ratio).
const RESOLUTION_HEIGHT = { '720p': 720, '1080p': 1080 };
function nominalDimensions(aspect, resolution) {
  const height = RESOLUTION_HEIGHT[resolution] || 720;
  return aspect === '9:16' ? { width: Math.round((height * 9) / 16), height } : { width: Math.round((height * 16) / 9), height };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitVeoJob({ prompt, imageBase64, imageMimeType, aspectRatio, durationSeconds, resolution, model, baseUrl, apiKey }) {
  const endpoint = `${baseUrl}/v1beta/models/${model}:predictLongRunning`;
  const instance = { prompt };
  if (imageBase64) {
    // Live-verified 2026-07-06: Google's own Veo 3.1 docs show `image.inlineData`
    // (the generateContent multimodal wrapper), but predictLongRunning actually
    // rejects it — 400 "`inlineData` isn't supported by this model" — and wants the
    // classic Vertex-AI prediction shape `bytesBase64Encoded` instead.
    instance.image = { bytesBase64Encoded: imageBase64, mimeType: imageMimeType || 'image/png' };
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        aspectRatio,
        // Live-verified 2026-07-06: the real API wants a number here, not a string —
        // some docs/summaries show it quoted (`"durationSeconds": "4|6|8"`), that's wrong.
        durationSeconds,
        resolution,
      },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Veo submit failed: ${response.status} ${response.statusText}\n${text}`);
  }
  const body = await response.json();
  if (!body.name) {
    throw new Error(`Veo submit response had no operation name: ${JSON.stringify(body)}`);
  }
  return body.name;
}

async function pollVeoJob({ operationName, baseUrl, apiKey }) {
  const endpoint = `${baseUrl}/v1beta/${operationName}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const response = await fetch(endpoint, { headers: { 'x-goog-api-key': apiKey } });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Veo poll failed: ${response.status} ${response.statusText}\n${text}`);
    }
    const op = await response.json();
    if (!op.done) continue;
    if (op.error) {
      throw new Error(`Veo generation failed: ${op.error.message || JSON.stringify(op.error)}`);
    }
    return op.response;
  }
  throw new Error(`Veo generation timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

/** Best-effort extraction across the couple of response shapes Google's docs show. */
function extractVideoUris(opResponse) {
  // Live-verified 2026-07-06: Veo's safety filter (celebrity likeness, RAI policy, etc.)
  // returns `done: true` with no error and no samples — just a filtered-count + reasons.
  // Surface this as a clear, actionable message instead of a generic "no samples" dump.
  const filteredReasons = opResponse?.generateVideoResponse?.raiMediaFilteredReasons;
  if (Array.isArray(filteredReasons) && filteredReasons.length > 0) {
    throw new Error(`Veo blocked this generation: ${filteredReasons.join(' ')}`);
  }
  const samples =
    opResponse?.generateVideoResponse?.generatedSamples ||
    opResponse?.videos ||
    opResponse?.predictions ||
    null;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(`Veo response had no recognizable video samples: ${JSON.stringify(opResponse)}`);
  }
  const uris = samples
    .map((s) => s?.video?.uri || s?.uri)
    .filter((uri) => typeof uri === 'string' && uri.length > 0);
  if (uris.length === 0) {
    throw new Error(`Veo response samples had no usable video uri: ${JSON.stringify(opResponse)}`);
  }
  return uris;
}

async function downloadVideo(uri, apiKey) {
  const response = await fetch(uri, { headers: { 'x-goog-api-key': apiKey } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Veo video download failed: ${response.status} ${response.statusText}\n${text}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Generate a video with Gemini Veo (t2v, or i2v when `imagePath` is given).
 *
 * @param {Object} options
 * @param {string} options.prompt
 * @param {string} [options.imagePath] - absolute path to an existing image file (i2v reference frame)
 * @param {string} [options.aspect='16:9'] - '16:9' | '9:16'
 * @param {number} [options.durationSeconds=8] - 4 | 6 | 8
 * @param {string} [options.resolution='720p'] - '720p' | '1080p'
 * @param {string} options.outputDir - absolute path; file written here as {uuid}.mp4
 * @param {string} [options.model] - explicit override; else env GEMINI_VIDEO_MODEL; else DEFAULT_MODEL
 * @returns {Promise<{ files: Array<{ id: string, relPath: string, width: number, height: number, durationSec: number }> }>}
 */
export async function generateVideo({
  prompt,
  imagePath,
  aspect = '16:9',
  durationSeconds = 8,
  resolution = '720p',
  outputDir,
  model,
}) {
  const resolvedModel = model || process.env.GEMINI_VIDEO_MODEL || DEFAULT_MODEL;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Prompt is required');
  }
  const aspectRatio = SUPPORTED_ASPECTS.has(aspect) ? aspect : '16:9';
  const duration = SUPPORTED_DURATIONS.has(durationSeconds) ? durationSeconds : 8;
  const resolvedResolution = SUPPORTED_RESOLUTIONS.has(resolution) ? resolution : '720p';
  const baseUrl = process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL;

  let imageBase64;
  let imageMimeType;
  if (imagePath) {
    const buffer = await fs.readFile(imagePath);
    imageBase64 = buffer.toString('base64');
    imageMimeType = path.extname(imagePath).toLowerCase() === '.jpg' || path.extname(imagePath).toLowerCase() === '.jpeg'
      ? 'image/jpeg'
      : 'image/png';
  }

  const operationName = await submitVeoJob({
    prompt,
    imageBase64,
    imageMimeType,
    aspectRatio,
    durationSeconds: duration,
    resolution: resolvedResolution,
    model: resolvedModel,
    baseUrl,
    apiKey,
  });
  const opResponse = await pollVeoJob({ operationName, baseUrl, apiKey });
  const uris = extractVideoUris(opResponse);

  await fs.mkdir(outputDir, { recursive: true });
  const dims = nominalDimensions(aspectRatio, resolvedResolution);

  const files = [];
  for (const uri of uris) {
    const buffer = await downloadVideo(uri, apiKey);
    const id = crypto.randomUUID();
    const relPath = `${id}.mp4`;
    await fs.writeFile(path.join(outputDir, relPath), buffer);
    files.push({ id, relPath, width: dims.width, height: dims.height, durationSec: duration });
  }

  return { files };
}
