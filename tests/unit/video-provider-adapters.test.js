// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateMiniMaxVideo } from '../../src/claude/media-gen/minimax-video-runner.js';
import { generateSeedanceVideo } from '../../src/claude/media-gen/seedance-video-runner.js';
import { generateMiniMaxH3Video } from '../../src/claude/media-gen/minimax-h3-video-runner.js';
import { generateGrokVideo } from '../../src/claude/media-gen/grok-video-runner.js';

const route = (adapter, config = {}) => ({
  id: adapter,
  adapter,
  model: adapter === 'minimax-video' ? 'MiniMax-Hailuo-2.3' : 'seedance-2.0',
  baseUrl: 'https://relay.example/api/',
  authStyle: 'bearer',
  apiKey: 'test-key',
  customHeaders: { 'X-Relay': 'tenant-a' },
  config: { pollIntervalMs: 0, ...config },
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('MiniMax / Hailuo video adapter', () => {
  it('uses configured base URL through submit, poll, file lookup, and signed download', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'kin-minimax-'));
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return json({ task_id: 'task-1' });
      if (calls.length === 2) return json({ status: 'Success', file_id: 'file-1' });
      if (calls.length === 3) return json({ file: { download_url: 'https://cdn.example/video.mp4' } });
      return new Response(new Uint8Array([1, 2, 3]));
    }));

    try {
      const result = await generateMiniMaxVideo({
        route: route('minimax-video'),
        input: { prompt: 'a fox runs', aspect: '16:9', durationSeconds: 6, resolution: '720p' },
        outputDir,
      });
      expect(calls.map((call) => call.url)).toEqual([
        'https://relay.example/api/v1/video_generation',
        'https://relay.example/api/v1/query/video_generation?task_id=task-1',
        'https://relay.example/api/v1/files/retrieve?file_id=file-1',
        'https://cdn.example/video.mp4',
      ]);
      expect(JSON.parse(calls[0].init.body)).toMatchObject({ model: 'MiniMax-Hailuo-2.3', prompt: 'a fox runs', duration: 6 });
      expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer test-key', 'X-Relay': 'tenant-a' });
      expect(await readFile(path.join(outputDir, result.files[0].relPath))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe('Seedance 2 video adapter', () => {
  it('supports a relay-specific path and response shape from media config', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'kin-seedance-'));
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return json({ data: { id: 'job/1' } });
      if (calls.length === 2) return json({ data: { state: 'SUCCEEDED', videos: [{ uri: 'https://cdn.example/seedance.mp4' }] } });
      return new Response(new Uint8Array([4, 5, 6]));
    }));

    try {
      const result = await generateSeedanceVideo({
        route: route('seedance-video', {
          submitPath: '/gateway/generate',
          statusPathTemplate: '/gateway/jobs/{taskId}',
          taskIdPath: 'data.id',
          statusPath: 'data.state',
          resultUrlsPath: 'data.videos',
          successStatuses: ['SUCCEEDED'],
        }),
        input: { prompt: 'a paper boat on water', aspect: '9:16', durationSeconds: 8, resolution: '1080p' },
        outputDir,
      });
      expect(calls.map((call) => call.url)).toEqual([
        'https://relay.example/api/gateway/generate',
        'https://relay.example/api/gateway/jobs/job%2F1',
        'https://cdn.example/seedance.mp4',
      ]);
      expect(JSON.parse(calls[0].init.body)).toMatchObject({
        model: 'seedance-2.0',
        input: { prompt: 'a paper boat on water', generation_type: 'text-to-video', aspect_ratio: '9:16' },
      });
      expect(result.files[0]).toMatchObject({ width: 608, height: 1080, durationSec: 8 });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe('MiniMax-H3 V2 video adapter', () => {
  it('uses V2 multimodal submit and task-content polling rather than the legacy V1 endpoints', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'kin-h3-'));
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return json({ task_id: 'h3-task' });
      if (calls.length === 2) return json({ task: { status: 'succeeded', content: { url: 'https://cdn.example/h3.mp4' }, ratio: '16:9', resolution: '2K', duration: 5 } });
      return new Response(new Uint8Array([7, 8, 9]));
    }));
    try {
      const result = await generateMiniMaxH3Video({
        route: { ...route('minimax-h3-video'), model: 'MiniMax-H3' },
        input: { prompt: 'a lighthouse in a storm', aspect: '16:9', durationSeconds: 5, resolution: '2k' },
        outputDir,
      });
      expect(calls.map((call) => call.url)).toEqual([
        'https://relay.example/api/v2/video_generation',
        'https://relay.example/api/v2/query/video_generation/h3-task',
        'https://cdn.example/h3.mp4',
      ]);
      expect(JSON.parse(calls[0].init.body)).toMatchObject({
        model: 'MiniMax-H3', resolution: '2K', duration: 5, ratio: '16:9',
        content: [{ type: 'text', text: 'a lighthouse in a storm' }],
      });
      expect(result.files[0]).toMatchObject({ width: 2560, height: 1440, durationSec: 5 });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('serializes mixed reference image, video and audio roles into V2 content', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'kin-h3-refs-'));
    const imagePath = path.join(outputDir, 'ref.png');
    const videoPath = path.join(outputDir, 'ref.mp4');
    const audioPath = path.join(outputDir, 'ref.mp3');
    await Promise.all([
      writeFile(imagePath, new Uint8Array([1])),
      writeFile(videoPath, new Uint8Array([2])),
      writeFile(audioPath, new Uint8Array([3])),
    ]);
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return json({ task_id: 'h3-ref-task' });
      if (calls.length === 2) return json({ task: { status: 'succeeded', content: { url: 'https://cdn.example/h3-ref.mp4' }, ratio: '9:16', resolution: '768P', duration: 8 } });
      return new Response(new Uint8Array([9]));
    }));
    try {
      await generateMiniMaxH3Video({
        route: { ...route('minimax-h3-video'), model: 'MiniMax-H3' },
        input: {
          prompt: 'keep the character and rhythm', mode: 'reference', aspect: '9:16', durationSeconds: 8, resolution: '768p',
          references: [
            { path: imagePath, mediaType: 'image', role: 'reference_image', order: 0 },
            { path: videoPath, mediaType: 'video', role: 'reference_video', order: 1 },
            { path: audioPath, mediaType: 'audio', role: 'reference_audio', order: 2 },
          ],
        },
        outputDir,
      });
      const body = JSON.parse(calls[0].init.body);
      expect(body.ratio).toBe('9:16');
      expect(body.content.map(({ type, role }) => ({ type, role }))).toEqual([
        { type: 'text', role: undefined },
        { type: 'image_url', role: 'reference_image' },
        { type: 'video_url', role: 'reference_video' },
        { type: 'audio_url', role: 'reference_audio' },
      ]);
      expect(body.content[2].video_url).toMatch(/^data:video\/mp4;base64,/);
      expect(body.content[3].audio_url).toMatch(/^data:audio\/mpeg;base64,/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe('Grok Imagine video adapter', () => {
  it('supports relay base URLs and multi-reference image requests', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'kin-grok-'));
    const first = path.join(outputDir, 'one.png');
    const second = path.join(outputDir, 'two.jpg');
    await Promise.all([writeFile(first, new Uint8Array([1])), writeFile(second, new Uint8Array([2]))]);
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return json({ request_id: 'grok/request' });
      if (calls.length === 2) return json({ status: 'done', video: { url: 'https://cdn.example/grok.mp4', duration: 12 } });
      return new Response(new Uint8Array([4, 2]));
    }));
    try {
      const result = await generateGrokVideo({
        route: { ...route('grok-imagine-video'), model: 'grok-imagine-video-1.5' },
        input: {
          prompt: 'same characters in a new scene', mode: 'reference', aspect: '16:9', durationSeconds: 12, resolution: '720p',
          references: [
            { path: first, mediaType: 'image', role: 'reference_image', order: 0 },
            { path: second, mediaType: 'image', role: 'reference_image', order: 1 },
          ],
        },
        outputDir,
      });
      expect(calls.map((call) => call.url)).toEqual([
        'https://relay.example/api/v1/videos/generations',
        'https://relay.example/api/v1/videos/grok%2Frequest',
        'https://cdn.example/grok.mp4',
      ]);
      const body = JSON.parse(calls[0].init.body);
      expect(body).toMatchObject({ model: 'grok-imagine-video-1.5', duration: 12, aspect_ratio: '16:9', resolution: '720p' });
      expect(body.reference_images).toHaveLength(2);
      expect(body.reference_images[0].url).toMatch(/^data:image\/png;base64,/);
      expect(result.files[0].durationSec).toBe(12);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
