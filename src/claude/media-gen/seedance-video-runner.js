/**
 * Seedance 2 asynchronous video adapter.
 *
 * Seedance is sold through multiple gateways. This adapter uses the common
 * submit/poll contract and makes its paths and response paths model-level config,
 * so an official endpoint and a relay can use the same Kin model entry by changing
 * only baseUrl/config -- no application code or redeploy needed.
 */

import {
  getPath,
  imagePathToDataUrl,
  joinApiUrl,
  mediaHeaders,
  responseJson,
  saveVideoUrls,
  wait,
} from './video-adapter-utils.js';

const DEFAULTS = {
  submitPath: '/v1/videos/generations',
  statusPathTemplate: '/v1/tasks/{taskId}',
  taskIdPath: 'taskId',
  statusPath: 'status',
  resultUrlsPath: 'data.results',
  pollIntervalMs: 5_000,
  timeoutMs: 8 * 60_000,
};

function configOf(route) { return { ...DEFAULTS, ...route.config }; }
function normalizedSet(values, fallback) {
  return new Set((Array.isArray(values) ? values : fallback).map((value) => String(value).toLowerCase()));
}

async function createTask({ route, input, config }) {
  const generationType = input.imagePath ? 'image-to-video' : 'text-to-video';
  const body = {
    model: route.model,
    input: {
      prompt: input.prompt,
      generation_type: generationType,
      ...(input.imagePath ? { image_urls: [await imagePathToDataUrl(input.imagePath)] } : {}),
      ...(input.aspect ? { aspect_ratio: input.aspect } : {}),
      ...(input.durationSeconds ? { duration: input.durationSeconds } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(config.inputOptions && typeof config.inputOptions === 'object' ? config.inputOptions : {}),
    },
    ...(config.requestOptions && typeof config.requestOptions === 'object' ? config.requestOptions : {}),
  };
  const response = await fetch(joinApiUrl(route.baseUrl, config.submitPath), {
    method: 'POST', headers: mediaHeaders(route), body: JSON.stringify(body),
  });
  const payload = await responseJson(response, 'Seedance video submit');
  const taskId = getPath(payload, config.taskIdPath);
  if (!taskId) throw new Error(`Seedance submit response had no task ID at ${config.taskIdPath}: ${JSON.stringify(payload)}`);
  return taskId;
}

async function waitForTask({ route, taskId, config }) {
  const deadline = Date.now() + Number(config.timeoutMs || DEFAULTS.timeoutMs);
  const success = normalizedSet(config.successStatuses, ['completed', 'success', 'succeeded']);
  const failed = normalizedSet(config.failureStatuses, ['failed', 'fail', 'error', 'cancelled', 'canceled']);
  while (Date.now() < deadline) {
    const endpoint = String(config.statusPathTemplate).replace('{taskId}', encodeURIComponent(taskId));
    const response = await fetch(joinApiUrl(route.baseUrl, endpoint), { headers: mediaHeaders(route, false) });
    const payload = await responseJson(response, 'Seedance video status');
    const status = String(getPath(payload, config.statusPath) || '').toLowerCase();
    if (success.has(status)) return payload;
    if (failed.has(status)) {
      const reason = getPath(payload, config.errorPath || 'error.message') || JSON.stringify(payload);
      throw new Error(`Seedance video generation failed: ${reason}`);
    }
    await wait(Number(config.pollIntervalMs ?? DEFAULTS.pollIntervalMs));
  }
  throw new Error(`Seedance video generation timed out after ${Math.round(Number(config.timeoutMs || DEFAULTS.timeoutMs) / 1000)}s`);
}

export async function generateSeedanceVideo({ route, input, outputDir }) {
  if (!input.prompt?.trim()) throw new Error('Prompt is required');
  const config = configOf(route);
  const taskId = await createTask({ route, input, config });
  const completed = await waitForTask({ route, taskId, config });
  const result = getPath(completed, config.resultUrlsPath);
  const urls = Array.isArray(result)
    ? result.map((item) => typeof item === 'string' ? item : item?.url || item?.uri).filter(Boolean)
    : [typeof result === 'string' ? result : result?.url || result?.uri].filter(Boolean);
  return saveVideoUrls({
    urls, outputDir, route, aspect: input.aspect, resolution: input.resolution,
    durationSeconds: input.durationSeconds, downloadWithAuth: config.downloadWithAuth === true,
  });
}
