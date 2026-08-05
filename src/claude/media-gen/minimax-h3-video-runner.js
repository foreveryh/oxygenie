/**
 * MiniMax-H3 V2 video adapter.
 *
 * H3 is not compatible with the legacy MiniMax /v1 payload: it uses a multimodal
 * content array and V2 task endpoints. Base URL and endpoint paths remain route
 * configuration so official API and compatible gateways use the same adapter.
 */

import {
  mediaPathToDataUrl,
  joinApiUrl,
  mediaHeaders,
  responseJson,
  saveVideoUrls,
  wait,
} from './video-adapter-utils.js';
import { stat } from 'node:fs/promises';

const DEFAULTS = {
  submitPath: '/v2/video_generation',
  statusPathTemplate: '/v2/query/video_generation/{taskId}',
  pollIntervalMs: 5_000,
  timeoutMs: 10 * 60_000,
};

function configOf(route) { return { ...DEFAULTS, ...route.config }; }

function statusIsFailure(status) {
  return ['failed', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

async function submitTask({ route, input, config }) {
  const references = Array.isArray(input.references)
    ? [...input.references].sort((a, b) => (a.order || 0) - (b.order || 0))
    : [
        ...(input.imagePath ? [{ path: input.imagePath, mediaType: 'image', role: 'first_frame', order: 0 }] : []),
        ...(input.lastImagePath ? [{ path: input.lastImagePath, mediaType: 'image', role: 'last_frame', order: 1 }] : []),
      ];
  const totalBytes = (await Promise.all(references.map(async (reference) => (await stat(reference.path)).size)))
    .reduce((sum, size) => sum + size, 0);
  // Base64 expands bytes by ~4/3. Keep the encoded media under the provider's 64 MB
  // JSON body ceiling with room for prompt/metadata. Large sources need a relay that
  // stages provider-accessible URLs instead of inlining local canvas files.
  if (totalBytes > 47 * 1024 * 1024) {
    throw new Error('MiniMax-H3 local reference media exceeds the safe 47 MB inline request limit');
  }

  const hasFrame = references.some((reference) => reference.role === 'first_frame' || reference.role === 'last_frame');
  const hasReference = references.some((reference) => String(reference.role).startsWith('reference_'));
  const content = [{ type: 'text', text: input.prompt }];
  for (const reference of references) {
    const field = reference.mediaType === 'video' ? 'video_url' : reference.mediaType === 'audio' ? 'audio_url' : 'image_url';
    content.push({ type: field, [field]: await mediaPathToDataUrl(reference.path), role: reference.role });
  }
  const response = await fetch(joinApiUrl(route.baseUrl, config.submitPath), {
    method: 'POST',
    headers: mediaHeaders(route),
    body: JSON.stringify({
      model: route.model,
      content,
      resolution: String(input.resolution || '768p').toUpperCase(),
      duration: input.durationSeconds,
      // H3 requires a concrete ratio for T2V, while the API specifies adaptive for
      // any first/last-frame I2V request (and ignores concrete values there).
      ratio: hasFrame ? 'adaptive' : hasReference ? (input.aspect || 'adaptive') : (input.aspect || '16:9'),
      ...(config.requestOptions && typeof config.requestOptions === 'object' ? config.requestOptions : {}),
    }),
  });
  const payload = await responseJson(response, 'MiniMax-H3 submit');
  if (!payload.task_id) throw new Error(`MiniMax-H3 submit response had no task_id: ${JSON.stringify(payload)}`);
  return payload.task_id;
}

async function waitForTask({ route, taskId, config }) {
  const deadline = Date.now() + Number(config.timeoutMs || DEFAULTS.timeoutMs);
  while (Date.now() < deadline) {
    const endpoint = String(config.statusPathTemplate).replace('{taskId}', encodeURIComponent(taskId));
    const response = await fetch(joinApiUrl(route.baseUrl, endpoint), { headers: mediaHeaders(route, false) });
    const payload = await responseJson(response, 'MiniMax-H3 status');
    const status = String(payload?.task?.status || '').toLowerCase();
    if (status === 'succeeded') return payload.task;
    if (statusIsFailure(status)) throw new Error(`MiniMax-H3 generation failed: ${payload?.task?.error?.message || JSON.stringify(payload.task)}`);
    await wait(Number(config.pollIntervalMs ?? DEFAULTS.pollIntervalMs));
  }
  throw new Error(`MiniMax-H3 generation timed out after ${Math.round(Number(config.timeoutMs || DEFAULTS.timeoutMs) / 1000)}s`);
}

export async function generateMiniMaxH3Video({ route, input, outputDir }) {
  if (!input.prompt?.trim()) throw new Error('Prompt is required');
  const config = configOf(route);
  const taskId = await submitTask({ route, input, config });
  const task = await waitForTask({ route, taskId, config });
  if (!task?.content?.url) throw new Error(`MiniMax-H3 completed task had no content.url: ${JSON.stringify(task)}`);
  return saveVideoUrls({
    urls: [task.content.url], outputDir, route, aspect: task.ratio === 'adaptive' ? input.aspect : task.ratio || input.aspect,
    resolution: String(task.resolution || input.resolution || '768p').toLowerCase(), durationSeconds: task.duration || input.durationSeconds,
    downloadWithAuth: config.downloadWithAuth === true,
  });
}
