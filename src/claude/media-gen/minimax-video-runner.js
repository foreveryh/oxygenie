/**
 * MiniMax / Hailuo asynchronous video adapter.
 *
 * Official baseline: POST /v1/video_generation -> task_id, then
 * GET /v1/query/video_generation?task_id=... -> file_id, then
 * GET /v1/files/retrieve?file_id=... -> file.download_url.
 *
 * `route.baseUrl` is deliberately never fixed: it may be api.minimax.io or a
 * compatible relay. `route.config` can override endpoint paths and polling for
 * relays that preserve MiniMax's task semantics under another API prefix.
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
  submitPath: '/v1/video_generation',
  statusPath: '/v1/query/video_generation',
  filePath: '/v1/files/retrieve',
  pollIntervalMs: 5_000,
  timeoutMs: 6 * 60_000,
};

function configOf(route) {
  return { ...DEFAULTS, ...route.config };
}

function statusIsSuccess(status) {
  return ['success', 'completed', 'succeeded'].includes(String(status || '').toLowerCase());
}

function statusIsFailure(status) {
  return ['fail', 'failed', 'error', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

async function createTask({ route, input, config }) {
  const body = {
    model: route.model,
    prompt: input.prompt,
    ...(input.imagePath ? { first_frame_image: await imagePathToDataUrl(input.imagePath) } : {}),
    ...(input.lastImagePath ? { last_frame_image: await imagePathToDataUrl(input.lastImagePath) } : {}),
    ...(input.durationSeconds ? { duration: input.durationSeconds } : {}),
    // MiniMax documents resolution tokens as e.g. "1080P". Kin's common canvas
    // contract uses lowercase "1080p", so normalize only at this provider edge.
    ...(input.resolution ? { resolution: String(input.resolution).toUpperCase() } : {}),
    ...(config.requestOptions && typeof config.requestOptions === 'object' ? config.requestOptions : {}),
  };
  const response = await fetch(joinApiUrl(route.baseUrl, config.submitPath), {
    method: 'POST', headers: mediaHeaders(route), body: JSON.stringify(body),
  });
  const payload = await responseJson(response, 'MiniMax video submit');
  const taskId = getPath(payload, config.taskIdPath || 'task_id');
  if (!taskId) throw new Error(`MiniMax video submit response had no task_id: ${JSON.stringify(payload)}`);
  return taskId;
}

async function waitForTask({ route, taskId, config }) {
  const deadline = Date.now() + Number(config.timeoutMs || DEFAULTS.timeoutMs);
  while (Date.now() < deadline) {
    const url = new URL(joinApiUrl(route.baseUrl, config.statusPath));
    url.searchParams.set(config.taskIdQuery || 'task_id', taskId);
    const response = await fetch(url, { headers: mediaHeaders(route, false) });
    const payload = await responseJson(response, 'MiniMax video status');
    const status = getPath(payload, config.statusValuePath || 'status');
    if (statusIsSuccess(status)) return payload;
    if (statusIsFailure(status)) {
      const reason = getPath(payload, config.errorPath || 'base_resp.status_msg') || JSON.stringify(payload);
      throw new Error(`MiniMax video generation failed: ${reason}`);
    }
    await wait(Number(config.pollIntervalMs ?? DEFAULTS.pollIntervalMs));
  }
  throw new Error(`MiniMax video generation timed out after ${Math.round(Number(config.timeoutMs || DEFAULTS.timeoutMs) / 1000)}s`);
}

async function downloadUrl({ route, task, config }) {
  const direct = getPath(task, config.resultUrlPath || 'download_url');
  if (typeof direct === 'string' && direct) return direct;
  const fileId = getPath(task, config.fileIdPath || 'file_id');
  if (!fileId) throw new Error(`MiniMax completed task had no file_id: ${JSON.stringify(task)}`);
  const url = new URL(joinApiUrl(route.baseUrl, config.filePath));
  url.searchParams.set(config.fileIdQuery || 'file_id', fileId);
  const response = await fetch(url, { headers: mediaHeaders(route, false) });
  const payload = await responseJson(response, 'MiniMax video file retrieval');
  const result = getPath(payload, config.fileDownloadUrlPath || 'file.download_url');
  if (!result) throw new Error(`MiniMax file response had no download URL: ${JSON.stringify(payload)}`);
  return result;
}

export async function generateMiniMaxVideo({ route, input, outputDir }) {
  if (!input.prompt?.trim()) throw new Error('Prompt is required');
  const config = configOf(route);
  const taskId = await createTask({ route, input, config });
  const completed = await waitForTask({ route, taskId, config });
  const url = await downloadUrl({ route, task: completed, config });
  return saveVideoUrls({
    urls: [url], outputDir, route, aspect: input.aspect, resolution: input.resolution,
    durationSeconds: input.durationSeconds, downloadWithAuth: config.downloadWithAuth === true,
  });
}
