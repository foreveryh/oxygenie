/**
 * buildWorkerEnv — request-time provider/model routing for the agent worker (PR2).
 *
 * Plain JS (no .ts) so `ws-server.mjs` can import it directly (ws-server runs as a
 * separate `node` process and imports only .js from src/, no tsx loader).
 *
 * Given a model's connection metadata + the source env, returns a NEW env object
 * with the ANTHROPIC_* vars set to route the spawned Claude Agent SDK child to that
 * connection + model. The secret comes from the SEALED `meta.credentialEncrypted`
 * (v2 — opened here with KIN_SECRET_KEY, plaintext exists only in this process) or,
 * as fallback, from `sourceEnv[meta.tokenEnv]` (legacy env-name reference). Plaintext
 * tokens never travel in metadata/DB/UI.
 *
 * SDK 0.2.112 contract (see research/2026-06-multi-model-context-pack.md §C):
 *  - auth via env only (no query() apiKey/baseUrl option);
 *  - ANTHROPIC_AUTH_TOKEN (Bearer) PRECEDES ANTHROPIC_API_KEY (x-api-key) → set
 *    exactly one and DELETE the other to avoid ambiguity / double headers;
 *  - alias vars (DEFAULT_*_MODEL / SUBAGENT) only take effect on a gateway; set them
 *    per-connection so sub-agents/background calls stay on THIS account.
 *
 * @typedef {Object} ModelRouteMeta
 * @property {string} baseUrl
 * @property {'bearer'|'x-api-key'} authStyle
 * @property {string|null=} credentialEncrypted - sealed secret-box blob (v2, wins over tokenEnv)
 * @property {string|null=} tokenEnv - NAME of the env var holding the token (legacy/fallback)
 * @property {string} model        - gateway model string (e.g. "glm-5.1")
 * @property {Record<string,string>=} customHeaders
 * @property {string=} aliasOpus
 * @property {string=} aliasSonnet
 * @property {string=} aliasHaiku
 * @property {string=} aliasSubagent
 */

import { openSecret } from '../security/secret-box.js';

/**
 * @param {ModelRouteMeta} meta
 * @param {Record<string,string|undefined>} sourceEnv
 * @returns {Record<string,string|undefined>} a new env object
 */
export function buildWorkerEnv(meta, sourceEnv) {
  if (!meta || !meta.baseUrl || !meta.model || (!meta.tokenEnv && !meta.credentialEncrypted)) {
    throw new Error('buildWorkerEnv: incomplete model metadata (need baseUrl, model, and a credential or tokenEnv)');
  }
  let token = null;
  if (meta.credentialEncrypted) {
    // Sealed DB credential wins. openSecret throws a clear message on a missing or
    // rotated KIN_SECRET_KEY — surface it as-is (admin-actionable).
    token = openSecret(meta.credentialEncrypted, sourceEnv);
  } else {
    token = sourceEnv?.[meta.tokenEnv];
  }
  if (!token || !String(token).trim()) {
    throw new Error(
      meta.tokenEnv
        ? `buildWorkerEnv: token env "${meta.tokenEnv}" is not set on the server`
        : 'buildWorkerEnv: connection has no usable credential',
    );
  }

  const env = { ...sourceEnv };

  // Route. Only ANTHROPIC_BASE_URL is documented; set API_URL too so a stale value
  // from the parent env can't shadow it.
  env.ANTHROPIC_BASE_URL = meta.baseUrl;
  env.ANTHROPIC_API_URL = meta.baseUrl;

  // Mutually-exclusive auth.
  if (meta.authStyle === 'x-api-key') {
    env.ANTHROPIC_API_KEY = token;
    delete env.ANTHROPIC_AUTH_TOKEN;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = token;
    delete env.ANTHROPIC_API_KEY;
  }

  env.ANTHROPIC_MODEL = meta.model;

  // Aliases fall back to the selected model so sub-agents/background calls don't
  // cross accounts. (Gateway-only env vars; inert on direct api.anthropic.com.)
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = meta.aliasOpus || meta.model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = meta.aliasSonnet || meta.model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = meta.aliasHaiku || meta.model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = meta.aliasSubagent || meta.model;

  if (meta.customHeaders && Object.keys(meta.customHeaders).length > 0) {
    env.ANTHROPIC_CUSTOM_HEADERS = serializeCustomHeaders(meta.customHeaders);
  }

  return env;
}

/** ANTHROPIC_CUSTOM_HEADERS is a newline-separated list of `Name: Value`. */
export function serializeCustomHeaders(headers) {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/**
 * buildMediaGenEnv — request-time provider routing for canvas media-gen (Canvas
 * Agent, D6). Parallel to buildWorkerEnv but protocol-dispatched instead of
 * Anthropic-only: media-gen capabilities (image/video) aren't restricted to one wire
 * protocol the way 'chat' is. It injects a provider-neutral route consumed by the
 * media adapter registry. Unlike buildWorkerEnv, an unresolved model/credential is
 * NON-FATAL: returns sourceEnv unchanged so the
 * caller falls back to whatever raw env var (e.g. GEMINI_API_KEY) may already be set,
 * rather than failing the whole canvas session over a media-gen credential.
 *
 * `capability` ('image'|'video') is what makes the SAME connection swappable
 * independently per capability — an admin can point 'image' at one provider/model
 * and 'video' at a completely different one (own connection, own protocol) via
 * /admin/models, without any code change. Every provider gets the same
 * KIN_MEDIA_{IMAGE|VIDEO}_* route variables. Legacy GEMINI_* variables are also set
 * for existing standalone callers during the migration.
 *
 * @param {ModelRouteMeta|null|undefined} meta
 * @param {Record<string,string|undefined>} sourceEnv
 * @param {'image'|'video'} capability
 * @returns {Record<string,string|undefined>} a new env object (or sourceEnv itself if unresolved)
 */
export function buildMediaGenEnv(meta, sourceEnv, capability) {
  if (!meta || !meta.enabled || !meta.baseUrl || !meta.model) return sourceEnv;

  let token = null;
  try {
    token = meta.credentialEncrypted ? openSecret(meta.credentialEncrypted, sourceEnv) : sourceEnv?.[meta.tokenEnv];
  } catch (error) {
    console.error(`[buildMediaGenEnv] credential open failed for ${meta.id}:`, error instanceof Error ? error.message : error);
    return sourceEnv;
  }
  if (!token || !String(token).trim()) return sourceEnv;

  const env = { ...sourceEnv };
  const prefix = capability === 'video' ? 'KIN_MEDIA_VIDEO' : 'KIN_MEDIA_IMAGE';
  const inferredAdapter = meta.mediaAdapter ||
    (meta.protocol === 'gemini' ? (capability === 'video' ? 'google-veo' : 'google-imagen') : 'auto');

  env[`${prefix}_MODEL_ID`] = meta.id || meta.model;
  env[`${prefix}_ADAPTER`] = inferredAdapter;
  env[`${prefix}_PROTOCOL`] = meta.protocol || 'custom';
  env[`${prefix}_MODEL`] = meta.model;
  env[`${prefix}_BASE_URL`] = meta.baseUrl;
  env[`${prefix}_AUTH_STYLE`] = meta.authStyle || 'bearer';
  env[`${prefix}_API_KEY`] = token;
  env[`${prefix}_CONFIG`] = JSON.stringify(meta.mediaConfig || {});
  env[`${prefix}_HEADERS`] = JSON.stringify(meta.customHeaders || {});

  if (meta.protocol === 'gemini') {
    env.GEMINI_API_KEY = token;
    env.GEMINI_BASE_URL = meta.baseUrl;
    if (capability === 'video') {
      env.GEMINI_VIDEO_MODEL = meta.model;
    } else {
      env.GEMINI_IMAGE_MODEL = meta.model;
    }
  }
  return env;
}
