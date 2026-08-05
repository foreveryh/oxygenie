// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  generateMedia,
  inferMediaAdapter,
  listMediaAdapters,
  mediaRouteFromEnv,
  registerMediaAdapter,
} from '../../src/claude/media-gen/adapter-registry.js';

describe('media adapter registry', () => {
  it('ships the existing Google implementations as adapters', () => {
    expect(listMediaAdapters()).toEqual(expect.arrayContaining([
      { id: 'google-imagen', capabilities: ['image'] },
      { id: 'google-veo', capabilities: ['video'] },
      { id: 'minimax-video', capabilities: ['video'] },
      { id: 'minimax-h3-video', capabilities: ['video'] },
      { id: 'seedance-video', capabilities: ['video'] },
      { id: 'grok-imagine-video', capabilities: ['video'] },
    ]));
  });

  it('infers adapters for legacy Gemini rows only', () => {
    expect(inferMediaAdapter({ protocol: 'gemini' }, 'image')).toBe('google-imagen');
    expect(inferMediaAdapter({ protocol: 'gemini' }, 'video')).toBe('google-veo');
    expect(() => inferMediaAdapter({ id: 'future/model', protocol: 'custom' }, 'video')).toThrow(/no media adapter configured/);
  });

  it('dispatches a future provider through the stable contract', async () => {
    registerMediaAdapter({
      id: 'unit-test-provider',
      capabilities: ['image'],
      generate: async ({ route, input, outputDir }) => ({
        files: [{ id: 'asset', relPath: `${route.model}-${input.prompt}.png`, width: 1, height: 1 }],
        outputDir,
      }),
    });
    const result = await generateMedia({
      capability: 'image',
      route: {
        id: 'future/image',
        adapter: 'unit-test-provider',
        model: 'image-next',
        baseUrl: 'https://example.com',
        authStyle: 'bearer',
        apiKey: 'secret',
      },
      input: { prompt: 'hello' },
      outputDir: '/tmp/output',
    });
    expect(result.files[0].relPath).toBe('image-next-hello.png');
  });

  it('reconstructs independent image/video routes from worker env', () => {
    const route = mediaRouteFromEnv('video', {
      KIN_MEDIA_VIDEO_MODEL_ID: 'minimax/hailuo',
      KIN_MEDIA_VIDEO_ADAPTER: 'minimax-video',
      KIN_MEDIA_VIDEO_PROTOCOL: 'custom',
      KIN_MEDIA_VIDEO_MODEL: 'hailuo-next',
      KIN_MEDIA_VIDEO_BASE_URL: 'https://api.example.com',
      KIN_MEDIA_VIDEO_AUTH_STYLE: 'bearer',
      KIN_MEDIA_VIDEO_API_KEY: 'secret',
      KIN_MEDIA_VIDEO_CONFIG: '{"pollIntervalMs":10000}',
    });
    expect(route).toMatchObject({
      id: 'minimax/hailuo',
      adapter: 'minimax-video',
      model: 'hailuo-next',
      config: { pollIntervalMs: 10000 },
    });
  });
});
