/**
 * Model health probe (PR3).
 *
 * Sends the SAME minimal request the SDK would (Anthropic Messages API at
 * `{baseUrl}/v1/messages`) to decide whether a model is actually usable
 * (reachable + authed + model-accepted). DB-free + dependency-injectable so it
 * unit-tests without a live DB or network. The DB write lives in the worker
 * processor (src/worker/processors/probeModels.ts).
 *
 * Status-code classification (see context pack §C / §G):
 *  200 → healthy · 429 → healthy (throttled but usable) · 401/403 → auth
 *  400/404 → model (gateways differ; ARK verified empirically) · 5xx → http_5xx
 *  abort → timeout · throw → network · missing token → auth
 */

export type ProbeHealth = 'healthy' | 'unhealthy';
export type ProbeError = 'auth' | 'model' | 'network' | 'timeout' | 'http_5xx' | `http_${number}` | null;
export type ProbeResult = { health: ProbeHealth; probeError: ProbeError; latencyMs: number };

export interface ProbeInput {
  baseUrl: string;
  authStyle: 'bearer' | 'x-api-key';
  /** v2: sealed DB credential — preferred over tokenEnv when present. */
  credentialEncrypted?: string | null;
  tokenEnv?: string | null;
  model: string;
  protocol?: 'anthropic' | 'openai-compat' | 'gemini' | 'custom';
  anthropicVersion?: string;
  customHeaders?: Record<string, string> | null;
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Map an HTTP status to a probe verdict. */
export function classifyProbeStatus(status: number, latencyMs: number): ProbeResult {
  if (status >= 200 && status < 300) return { health: 'healthy', probeError: null, latencyMs };
  if (status === 429) return { health: 'healthy', probeError: null, latencyMs }; // throttled but usable
  if (status === 401 || status === 403) return { health: 'unhealthy', probeError: 'auth', latencyMs };
  if (status === 400 || status === 404) return { health: 'unhealthy', probeError: 'model', latencyMs };
  if (status >= 500) return { health: 'unhealthy', probeError: 'http_5xx', latencyMs };
  return { health: 'unhealthy', probeError: `http_${status}`, latencyMs };
}

/**
 * Resolve the probe token: sealed DB credential first, env[tokenEnv] fallback.
 * Returns null when neither yields a usable value (classified as 'auth').
 */
async function resolveProbeToken(meta: ProbeInput, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (meta.credentialEncrypted) {
    try {
      const { openSecret } = await import('~/server/security/secret-box');
      return openSecret(meta.credentialEncrypted, env);
    } catch {
      return null; // missing/rotated KIN_SECRET_KEY → credential unusable
    }
  }
  if (meta.tokenEnv) {
    const v = env[meta.tokenEnv];
    if (v && String(v).trim()) return String(v);
  }
  return null;
}

/**
 * Protocol-aware probe dispatch (v2). Anthropic → real 1-token Messages call (the
 * exact request the SDK makes); openai-compat/gemini/custom → cheap authed model-list
 * (K6: generation providers are auth-checked, never asked to generate).
 */
export async function probeConnection(meta: ProbeInput, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const protocol = meta.protocol ?? 'anthropic';
  if (protocol === 'anthropic') return probeModelMeta(meta, opts);

  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const token = await resolveProbeToken(meta, env);
  if (!token) return { health: 'unhealthy', probeError: 'auth', latencyMs: 0 };

  const base = meta.baseUrl.replace(/\/+$/, '');
  let url: string;
  const headers: Record<string, string> = { ...meta.customHeaders };
  if (protocol === 'gemini') {
    // Gemini lists models with the key as a query param.
    url = `${base}/v1beta/models?key=${encodeURIComponent(token)}&pageSize=1`;
  } else {
    // openai-compat + custom: GET {base}/models with the configured auth style.
    url = `${base}/models`;
    if (meta.authStyle === 'x-api-key') headers['x-api-key'] = token;
    else headers['authorization'] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    const result = classifyProbeStatus(res.status, Date.now() - started);
    // A 404 on /models means the endpoint shape differs, not that the model is bad —
    // downgrade to healthy-unknown-shape? No: report as-is but reclassify 'model' →
    // generic http_404 so the UI doesn't claim "model rejected" for a list endpoint.
    if (result.probeError === 'model') return { ...result, probeError: `http_${res.status}` };
    return result;
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (error instanceof Error && error.name === 'AbortError') {
      return { health: 'unhealthy', probeError: 'timeout', latencyMs };
    }
    return { health: 'unhealthy', probeError: 'network', latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one model's connection (Anthropic Messages). Token never logged. */
export async function probeModelMeta(meta: ProbeInput, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;

  const token = await resolveProbeToken(meta, env);
  if (!token) {
    return { health: 'unhealthy', probeError: 'auth', latencyMs: 0 };
  }

  const url = `${meta.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': meta.anthropicVersion || '2023-06-01',
    ...meta.customHeaders,
  };
  if (meta.authStyle === 'x-api-key') headers['x-api-key'] = token;
  else headers['authorization'] = `Bearer ${token}`;

  const body = JSON.stringify({
    model: meta.model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
    return classifyProbeStatus(res.status, Date.now() - started);
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (error instanceof Error && error.name === 'AbortError') {
      return { health: 'unhealthy', probeError: 'timeout', latencyMs };
    }
    return { health: 'unhealthy', probeError: 'network', latencyMs };
  } finally {
    clearTimeout(timer);
  }
}
