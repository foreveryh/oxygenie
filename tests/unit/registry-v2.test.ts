// @vitest-environment node
/**
 * Registry v2 unit tests — the DB-free pieces:
 *  - buildWorkerEnv with a sealed DB credential (and legacy tokenEnv fallback)
 *  - protocol-aware probe dispatch (openai-compat /models, gemini key-in-query)
 *  - global-variable key hygiene (env-style + reserved blocklist)
 *  - provider catalog integrity (unique slugs, valid URLs, chat⇒anthropic invariant)
 */

import { describe, it, expect } from 'vitest';
import { buildWorkerEnv } from '~/server/models/build-worker-env';
import { sealSecret } from '~/server/security/secret-box';
import { probeConnection } from '~/server/models/probe';
import { assertGlobalVarKeyAllowed } from '~/server/models/global-var-rules';
import { PROVIDER_CATALOG } from '~/server/models/provider-catalog';

const KEYED_ENV = { KIN_SECRET_KEY: 'unit-test-master-key' } as NodeJS.ProcessEnv;

const baseMeta = {
  baseUrl: 'https://gw.example.com/api',
  authStyle: 'bearer' as const,
  model: 'glm-5.1',
  anthropicVersion: '2023-06-01',
};

describe('buildWorkerEnv (v2 credential path)', () => {
  it('opens a sealed DB credential and routes with it', () => {
    const sealed = sealSecret('sk-from-db', KEYED_ENV);
    const env = buildWorkerEnv(
      { ...baseMeta, credentialEncrypted: sealed, tokenEnv: null },
      { ...KEYED_ENV, ANTHROPIC_API_KEY: 'stale' },
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-db');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe(baseMeta.baseUrl);
  });

  it('prefers the DB credential over tokenEnv when both exist', () => {
    const sealed = sealSecret('db-wins', KEYED_ENV);
    const env = buildWorkerEnv(
      { ...baseMeta, credentialEncrypted: sealed, tokenEnv: 'MY_TOKEN' },
      { ...KEYED_ENV, MY_TOKEN: 'env-loses' },
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('db-wins');
  });

  it('falls back to tokenEnv when no DB credential', () => {
    const env = buildWorkerEnv({ ...baseMeta, tokenEnv: 'MY_TOKEN' }, { MY_TOKEN: 'env-token' });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('env-token');
  });

  it('throws admin-actionable errors on missing credential / missing master key', () => {
    expect(() => buildWorkerEnv({ ...baseMeta, tokenEnv: null }, {})).toThrow(/credential or tokenEnv/);
    const sealed = sealSecret('x', KEYED_ENV);
    expect(() =>
      buildWorkerEnv({ ...baseMeta, credentialEncrypted: sealed, tokenEnv: null }, {}),
    ).toThrow(/KIN_SECRET_KEY/);
  });
});

describe('probeConnection (protocol dispatch)', () => {
  const okFetch = (capture: { url?: string; headers?: Record<string, string> }) =>
    (async (url: RequestInfo | URL, init?: RequestInit) => {
      capture.url = String(url);
      capture.headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

  it('openai-compat probes GET {base}/models with Bearer auth', async () => {
    const cap: { url?: string; headers?: Record<string, string> } = {};
    const result = await probeConnection(
      { ...baseMeta, protocol: 'openai-compat', tokenEnv: 'K' },
      { env: { K: 'tok' } as NodeJS.ProcessEnv, fetchImpl: okFetch(cap) },
    );
    expect(result.health).toBe('healthy');
    expect(cap.url).toBe('https://gw.example.com/api/models');
    expect(cap.headers?.authorization).toBe('Bearer tok');
  });

  it('gemini probes the v1beta model list with key in query', async () => {
    const cap: { url?: string } = {};
    const result = await probeConnection(
      { ...baseMeta, protocol: 'gemini', tokenEnv: 'K' },
      { env: { K: 'g-key' } as NodeJS.ProcessEnv, fetchImpl: okFetch(cap) },
    );
    expect(result.health).toBe('healthy');
    expect(cap.url).toContain('/v1beta/models?key=g-key');
  });

  it('uses a sealed credential when provided', async () => {
    const cap: { headers?: Record<string, string> } = {};
    const sealed = sealSecret('sealed-tok', KEYED_ENV);
    const result = await probeConnection(
      { ...baseMeta, protocol: 'openai-compat', credentialEncrypted: sealed },
      { env: KEYED_ENV, fetchImpl: okFetch(cap) },
    );
    expect(result.health).toBe('healthy');
    expect(cap.headers?.authorization).toBe('Bearer sealed-tok');
  });

  it('classifies 401 as auth failure', async () => {
    const fetch401 = (async () => new Response('', { status: 401 })) as typeof fetch;
    const result = await probeConnection(
      { ...baseMeta, protocol: 'openai-compat', tokenEnv: 'K' },
      { env: { K: 'bad' } as NodeJS.ProcessEnv, fetchImpl: fetch401 },
    );
    expect(result).toMatchObject({ health: 'unhealthy', probeError: 'auth' });
  });

  it('reports auth when neither credential nor tokenEnv resolves', async () => {
    const result = await probeConnection(
      { ...baseMeta, protocol: 'openai-compat' },
      { env: {} as NodeJS.ProcessEnv },
    );
    expect(result).toMatchObject({ health: 'unhealthy', probeError: 'auth' });
  });
});

describe('assertGlobalVarKeyAllowed', () => {
  it('accepts normal env-style keys', () => {
    for (const k of ['TAVILY_API_KEY', 'FIRECRAWL_KEY', 'MY_WEBHOOK_URL', 'X1']) {
      expect(() => assertGlobalVarKeyAllowed(k)).not.toThrow();
    }
  });

  it('rejects non-env-style names', () => {
    for (const k of ['lower_case', '1STARTS_WITH_DIGIT', 'HAS-DASH', 'HAS SPACE', '']) {
      expect(() => assertGlobalVarKeyAllowed(k)).toThrow();
    }
  });

  it('rejects reserved prefixes and exact system names', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_HOME', 'KIN_SECRET_KEY', 'DATABASE_URL', 'PATH', 'HOME', 'NODE_OPTIONS']) {
      expect(() => assertGlobalVarKeyAllowed(k)).toThrow(/保留|环境变量风格/);
    }
  });
});

describe('PROVIDER_CATALOG integrity', () => {
  it('has unique slugs and valid preset URLs', () => {
    const slugs = PROVIDER_CATALOG.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const p of PROVIDER_CATALOG) {
      if (p.baseUrl !== null) expect(() => new URL(p.baseUrl!)).not.toThrow();
    }
  });

  it('never suggests chat capability on a non-anthropic protocol (K3 invariant)', () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.protocol === 'anthropic') continue;
      for (const m of p.knownModels) {
        expect(m.capabilities, `${p.slug}/${m.model}`).not.toContain('chat');
      }
    }
  });
});
