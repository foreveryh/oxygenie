// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  RESOLVE_MODEL_CONTRACT_VERSION,
  resolveModelResponseSchema,
} from '../../src/server/models/resolve-contract';

const sample = {
  v: RESOLVE_MODEL_CONTRACT_VERSION,
  id: 'ark/glm-5.1',
  model: 'glm-5.1',
  connectionId: 'ark-coding',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
  authStyle: 'bearer' as const,
  protocol: 'anthropic' as const,
  credentialEncrypted: null,
  tokenEnv: 'ARK_AUTH_TOKEN',
  anthropicVersion: '2023-06-01',
  customHeaders: null,
  aliasOpus: null,
  aliasSonnet: null,
  aliasHaiku: 'doubao-seed-2.0-lite',
  aliasSubagent: null,
  enabled: true,
  health: 'healthy' as const,
};

describe('resolveModelResponseSchema', () => {
  it('validates a well-formed resolve response', () => {
    expect(() => resolveModelResponseSchema.parse(sample)).not.toThrow();
  });

  it('rejects a wrong/missing contract version', () => {
    expect(() => resolveModelResponseSchema.parse({ ...sample, v: 999 })).toThrow();
    const { v: _v, ...noV } = sample;
    expect(() => resolveModelResponseSchema.parse(noV)).toThrow();
  });

  it('rejects a bad baseUrl / unknown authStyle / unknown health', () => {
    expect(() => resolveModelResponseSchema.parse({ ...sample, baseUrl: 'nope' })).toThrow();
    expect(() => resolveModelResponseSchema.parse({ ...sample, authStyle: 'oauth' })).toThrow();
    expect(() => resolveModelResponseSchema.parse({ ...sample, health: 'great' })).toThrow();
  });

  it('never surfaces a token value (parsed output strips unknown keys)', () => {
    const parsed = resolveModelResponseSchema.parse({ ...sample, token: 'SECRET' } as Record<string, unknown>);
    expect('token' in parsed).toBe(false);
    expect(parsed.tokenEnv).toBe('ARK_AUTH_TOKEN'); // only the NAME is carried
  });

  it('v2: accepts a sealed credential + null tokenEnv (UI-created connection)', () => {
    const parsed = resolveModelResponseSchema.parse({
      ...sample,
      credentialEncrypted: 'v1.aaaa.bbbb.cccc',
      tokenEnv: null,
      protocol: 'openai-compat',
    });
    expect(parsed.credentialEncrypted).toBe('v1.aaaa.bbbb.cccc');
    expect(parsed.tokenEnv).toBeNull();
  });
});
