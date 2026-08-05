// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  isMediaParameterCombinationAllowed,
  modeSupportsMediaTypes,
  resolveMediaCapabilities,
  validateMediaInput,
} from '../../src/claude/media-gen/media-capabilities.js';

const route = (adapter, config = {}) => ({ id: `test/${adapter}`, adapter, config });

describe('media capability contract', () => {
  it('uses a model manifest over the adapter baseline', () => {
    const caps = resolveMediaCapabilities(route('seedance-video', {
      capabilities: { video: { durationSeconds: [15], resolutions: ['1080p'], firstFrame: true } },
    }), 'video');
    expect(caps).toMatchObject({ durationSeconds: [15], resolutions: ['1080p'], firstFrame: true, lastFrame: false });
  });

  it('lets a model deliberately hide a baseline control and omits its value from requests', () => {
    const caps = resolveMediaCapabilities(route('minimax-video', {
      capabilities: { video: { durationSeconds: [] } },
    }), 'video');
    expect(caps.durationSeconds).toEqual([]);
  });

  it('rejects unsupported video options before the provider is called', () => {
    const model = route('minimax-video');
    expect(() => validateMediaInput({ capability: 'video', route: model, input: { prompt: 'x', durationSeconds: 30 } }))
      .toThrow(/does not support 30s/);
    expect(() => validateMediaInput({ capability: 'video', route: model, input: { prompt: 'x', resolution: '720p' } }))
      .toThrow(/does not support video resolution/);
    expect(() => validateMediaInput({ capability: 'video', route: model, input: { prompt: 'x', lastImagePath: '/tmp/end.png' } }))
      .toThrow(/does not support a last-frame/);
  });

  it('allows a model that explicitly declares a last-frame capability', () => {
    const model = route('minimax-video', { capabilities: { video: { lastFrame: true } } });
    expect(() => validateMediaInput({
      capability: 'video', route: model,
      input: { prompt: 'x', imagePath: '/tmp/first.png', lastImagePath: '/tmp/last.png', durationSeconds: 6, resolution: '1080p' },
    })).not.toThrow();
  });

  it('normalizes H3 into mutually exclusive first/last and reference modes', () => {
    const model = route('minimax-h3-video');
    const caps = resolveMediaCapabilities(model, 'video');
    expect(caps.modes.map((mode) => mode.id)).toEqual(['text_to_video', 'first_last_frame', 'reference']);
    expect(modeSupportsMediaTypes(caps.modes[1], ['image'])).toBe(true);
    expect(modeSupportsMediaTypes(caps.modes[2], ['image', 'video', 'audio'])).toBe(true);
    expect(() => validateMediaInput({
      capability: 'video', route: model,
      input: {
        prompt: 'x', mode: 'first_last_frame', durationSeconds: 5, resolution: '2k',
        references: [{ mediaType: 'image', role: 'reference_image' }],
      },
    })).toThrow(/does not accept role reference_image/);
  });

  it('validates reference durations and conditional parameter combinations', () => {
    const h3 = route('minimax-h3-video');
    expect(() => validateMediaInput({
      capability: 'video', route: h3,
      input: {
        prompt: 'x', mode: 'reference', durationSeconds: 5, resolution: '768p',
        references: [
          { mediaType: 'video', role: 'reference_video', durationSec: 10 },
          { mediaType: 'video', role: 'reference_video', durationSec: 8 },
        ],
      },
    })).toThrow(/total duration must be at most 15s/);

    const caps = resolveMediaCapabilities(route('seedance-video', {
      capabilities: { video: {
        durationSeconds: [6, 10], resolutions: ['768p', '1080p'],
        parameterCombinations: [
          { resolution: '768p', durationSeconds: [6, 10] },
          { resolution: '1080p', durationSeconds: [6] },
        ],
      } },
    }), 'video');
    expect(isMediaParameterCombinationAllowed(caps, { resolution: '1080p', durationSeconds: 10 })).toBe(false);
    expect(isMediaParameterCombinationAllowed(caps, { resolution: '1080p', durationSeconds: 6 })).toBe(true);

    const grok = resolveMediaCapabilities(route('grok-imagine-video'), 'video');
    expect(isMediaParameterCombinationAllowed(grok, { mode: 'reference', resolution: '1080p', durationSeconds: 10 })).toBe(false);
    expect(isMediaParameterCombinationAllowed(grok, { mode: 'first_last_frame', resolution: '1080p', durationSeconds: 10 })).toBe(true);
  });
});
