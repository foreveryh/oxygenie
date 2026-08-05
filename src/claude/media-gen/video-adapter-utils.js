/** Shared helpers for asynchronous video-generation adapters (plain Node ESM). */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function joinApiUrl(baseUrl, endpoint) {
  if (!baseUrl) throw new Error('A media provider base URL is required');
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${baseUrl.replace(/\/$/, '')}/${String(endpoint || '').replace(/^\//, '')}`;
}

export function mediaHeaders(route, contentType = true) {
  const headers = { ...(contentType ? { 'Content-Type': 'application/json' } : {}), ...route.customHeaders };
  if (route.authStyle === 'x-api-key') headers['x-api-key'] = route.apiKey;
  else headers.Authorization = `Bearer ${route.apiKey}`;
  return headers;
}

export async function responseJson(response, label) {
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON: ${raw.slice(0, 1000)}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${response.statusText}\n${raw.slice(0, 2000)}`);
  }
  return body;
}

export function getPath(value, dottedPath) {
  if (!dottedPath) return value;
  return dottedPath.split('.').filter(Boolean).reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)];
    return current[key];
  }, value);
}

const MIME_BY_EXTENSION = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

export async function mediaPathToDataUrl(mediaPath) {
  const extension = path.extname(mediaPath).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) throw new Error(`Unsupported reference media extension: ${extension || '(none)'}`);
  const buffer = await fs.readFile(mediaPath);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

export async function imagePathToDataUrl(imagePath) {
  return mediaPathToDataUrl(imagePath);
}

export function nominalVideoDimensions(aspect = '16:9', resolution = '720p') {
  const height = resolution === '2k' ? 1440 : resolution === '1080p' ? 1080 : resolution === '768p' ? 768 : 720;
  return aspect === '9:16'
    ? { width: Math.round((height * 9) / 16), height }
    : { width: Math.round((height * 16) / 9), height };
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function saveVideoUrls({ urls, outputDir, route, durationSeconds, aspect, resolution, downloadWithAuth = false }) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('Video generation completed without a downloadable video URL');
  await fs.mkdir(outputDir, { recursive: true });
  const dimensions = nominalVideoDimensions(aspect, resolution);
  const files = [];
  for (const url of urls) {
    if (typeof url !== 'string' || !url) continue;
    const response = await fetch(url, {
      headers: downloadWithAuth ? mediaHeaders(route, false) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Video download failed: ${response.status} ${response.statusText}\n${text.slice(0, 1000)}`);
    }
    const id = crypto.randomUUID();
    const relPath = `${id}.mp4`;
    await fs.writeFile(path.join(outputDir, relPath), Buffer.from(await response.arrayBuffer()));
    files.push({ id, relPath, ...dimensions, durationSec: durationSeconds || 8 });
  }
  if (files.length === 0) throw new Error('Video generation completed without a usable download URL');
  return { files };
}
