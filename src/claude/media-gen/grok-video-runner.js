/** xAI Grok Imagine asynchronous video adapter (official API + compatible relays). */

import {
  getPath,
  joinApiUrl,
  mediaHeaders,
  mediaPathToDataUrl,
  responseJson,
  saveVideoUrls,
  wait,
} from './video-adapter-utils.js';

const DEFAULTS = {
  submitPath: '/v1/videos/generations',
  statusPathTemplate: '/v1/videos/{taskId}',
  taskIdPath: 'request_id',
  statusPath: 'status',
  resultUrlPath: 'video.url',
  pollIntervalMs: 5_000,
  timeoutMs: 10 * 60_000,
};

function configOf(route) { return { ...DEFAULTS, ...route.config }; }

async function submitTask({ route, input, config }) {
  const references = Array.isArray(input.references) ? input.references : [];
  const firstFrame = references.find((reference) => reference.role === 'first_frame');
  const referenceImages = references.filter((reference) => reference.role === 'reference_image');
  const body = {
    model: route.model,
    prompt: input.prompt,
    ...(input.durationSeconds ? { duration: input.durationSeconds } : {}),
    ...(input.aspect ? { aspect_ratio: input.aspect } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(firstFrame ? { image: { url: await mediaPathToDataUrl(firstFrame.path) } } : {}),
    ...(referenceImages.length ? {
      reference_images: await Promise.all(referenceImages.map(async (reference) => ({ url: await mediaPathToDataUrl(reference.path) }))),
    } : {}),
    ...(config.requestOptions && typeof config.requestOptions === 'object' ? config.requestOptions : {}),
  };
  const response = await fetch(joinApiUrl(route.baseUrl, config.submitPath), {
    method: 'POST', headers: mediaHeaders(route), body: JSON.stringify(body),
  });
  const payload = await responseJson(response, 'Grok Imagine video submit');
  const taskId = getPath(payload, config.taskIdPath);
  if (!taskId) throw new Error(`Grok Imagine submit response had no request ID at ${config.taskIdPath}: ${JSON.stringify(payload)}`);
  return taskId;
}

async function waitForTask({ route, taskId, config }) {
  const deadline = Date.now() + Number(config.timeoutMs || DEFAULTS.timeoutMs);
  while (Date.now() < deadline) {
    const endpoint = String(config.statusPathTemplate).replace('{taskId}', encodeURIComponent(taskId));
    const response = await fetch(joinApiUrl(route.baseUrl, endpoint), { headers: mediaHeaders(route, false) });
    const payload = await responseJson(response, 'Grok Imagine video status');
    const status = String(getPath(payload, config.statusPath) || '').toLowerCase();
    if (status === 'done' || status === 'succeeded' || status === 'completed') return payload;
    if (status === 'failed' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
      throw new Error(`Grok Imagine video generation ${status}: ${JSON.stringify(payload.error || payload)}`);
    }
    await wait(Number(config.pollIntervalMs ?? DEFAULTS.pollIntervalMs));
  }
  throw new Error(`Grok Imagine generation timed out after ${Math.round(Number(config.timeoutMs || DEFAULTS.timeoutMs) / 1000)}s`);
}

export async function generateGrokVideo({ route, input, outputDir }) {
  if (!input.prompt?.trim()) throw new Error('Prompt is required');
  const config = configOf(route);
  const taskId = await submitTask({ route, input, config });
  const completed = await waitForTask({ route, taskId, config });
  const url = getPath(completed, config.resultUrlPath);
  return saveVideoUrls({
    urls: url ? [url] : [], outputDir, route, aspect: input.aspect, resolution: input.resolution,
    durationSeconds: completed?.video?.duration || input.durationSeconds,
    downloadWithAuth: config.downloadWithAuth === true,
  });
}
