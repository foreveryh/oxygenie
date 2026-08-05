/**
 * Multi-model schema (registry v2 — unified model + capability registry).
 *
 * DB = runtime source of truth for which models/connections exist and are enabled;
 * seeded ONLY when the connection table is empty (v2 semantics — the UI is the source
 * of truth thereafter) and editable by admins in `/admin/models`.
 *
 * Credentials (v2): a connection's secret is EITHER
 *   - `credentialEncrypted` — AES-256-GCM sealed via KIN_SECRET_KEY (admin pastes the
 *     key in the UI; see src/server/security/secret-box.js), OR
 *   - `tokenEnv` — legacy NAME of the env var holding the token (.env deployments).
 * Resolution order: DB credential first, env fallback. Plaintext never leaves the
 * server processes (UI gets a mask; the internal resolve endpoint ships the sealed
 * blob which ws-server opens with its own KIN_SECRET_KEY).
 *
 * Capabilities (v2): a model declares what it can do — 'chat' (Agent runtime,
 * anthropic-protocol connections only), 'vision', 'image', 'video', 'embedding'.
 * Defaults are per-capability slots in `model_default`, overridable per project.
 *
 * See docs/project/prd/2026-06-multi-model-switching-prd.md (rev.3, v1) and the
 * coordination-repo PRD 2026-07-05-模型注册表v2与全局变量-PRD.md (v2).
 */

import { pgTable, text, integer, boolean, jsonb, pgEnum, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, updatedAt, timestamptz } from './_shared';
import { project } from './project.schema';

// How the connection authenticates to its Anthropic-compatible gateway.
// bearer  → ANTHROPIC_AUTH_TOKEN (Authorization: Bearer) — ARK / gateways
// x-api-key → ANTHROPIC_API_KEY (x-api-key header) — native Anthropic
export const modelAuthStyleEnum = pgEnum('model_auth_style', ['bearer', 'x-api-key']);

// Probe result. unknown = never probed / probe in flight.
// NOTE: the enum's Postgres name MUST differ from the `model_health` table name —
// `CREATE TABLE model_health` auto-creates a type of the same name, which would
// collide with the enum (Postgres error 42710). Hence `model_health_status`.
export const modelHealthEnum = pgEnum('model_health_status', ['healthy', 'unhealthy', 'unknown']);

// Wire protocol of a connection. 'anthropic' is the ONLY protocol usable for the
// Agent runtime ('chat' capability) — SDK 0.2.112 + ARK constraint (kin CLAUDE.md §3).
// The rest serve vision / image / video / embedding via direct REST.
export const modelProtocolEnum = pgEnum('model_protocol', [
  'anthropic',
  'openai-compat',
  'gemini',
  'custom',
]);

// What a model can do. 'chat' = Agent conversation runtime; the others are direct
// REST capabilities consumed by OCR (vision), canvas/generation (image, video) and
// RAG (embedding).
export const MODEL_CAPABILITIES = ['chat', 'vision', 'image', 'video', 'embedding'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
export type ModelMediaConfigValue =
  | string
  | number
  | boolean
  | null
  | ModelMediaConfigValue[]
  | { [key: string]: ModelMediaConfigValue };
export type ModelMediaConfig = Record<string, ModelMediaConfigValue>;

// ── model_connection ─ an Anthropic-compatible endpoint + one credential (an account)
export const modelConnection = pgTable('model_connection', {
  // Stable key, e.g. "ark-coding" (used as FK target; not user-facing).
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  // Anthropic-compatible base URL WITHOUT the /v1 suffix, e.g.
  // https://ark.cn-beijing.volces.com/api/coding . Probe + worker append /v1/messages
  // (the SDK reads ANTHROPIC_BASE_URL = this value).
  baseUrl: text('base_url').notNull(),
  authStyle: modelAuthStyleEnum('auth_style').notNull().default('bearer'),
  protocol: modelProtocolEnum('protocol').notNull().default('anthropic'),
  // v2: sealed credential (secret-box format) pasted in the admin UI. Preferred over
  // tokenEnv when set. Never returned to clients in plaintext.
  credentialEncrypted: text('credential_encrypted'),
  // Legacy/fallback: NAME of the env var holding the secret (e.g. "ARK_AUTH_TOKEN").
  // Nullable in v2 — UI-created connections may carry only credentialEncrypted.
  tokenEnv: text('token_env'),
  anthropicVersion: text('anthropic_version').notNull().default('2023-06-01'),
  // Optional extra headers for gateway routing → ANTHROPIC_CUSTOM_HEADERS.
  customHeaders: jsonb('custom_headers').$type<Record<string, string> | null>(),
  // Per-connection alias/sub-agent models (gateway-only env vars). Null → fall back to
  // the connection's selected model so sub-agents/background calls stay on this account.
  aliasOpus: text('alias_opus'),
  aliasSonnet: text('alias_sonnet'),
  aliasHaiku: text('alias_haiku'),
  aliasSubagent: text('alias_subagent'),
  sort: integer('sort').default(0).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── model_definition ─ a selectable model belonging to a connection ──────────────
export const modelDefinition = pgTable('model_definition', {
  // Global unique id sent over the wire / shown in the picker, e.g. "ark/glm-5.1".
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => modelConnection.id, { onDelete: 'cascade' }),
  // The model string the gateway expects, e.g. "glm-5.1".
  model: text('model').notNull(),
  // v2: what this model can do (see MODEL_CAPABILITIES). Legacy rows default to chat.
  capabilities: jsonb('capabilities').$type<ModelCapability[]>().default(['chat']).notNull(),
  // Provider-specific media execution driver. Kept separate from connection.protocol:
  // one Gemini connection can host both Imagen and Veo, whose REST/LRO shapes differ.
  // Null means legacy inference (gemini image→google-imagen, video→google-veo).
  mediaAdapter: text('media_adapter'),
  // Adapter-owned defaults/feature flags. The canvas contract stays stable while a
  // new provider can consume additional options without adding schema columns.
  mediaConfig: jsonb('media_config').$type<ModelMediaConfig>().default({}).notNull(),
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  sort: integer('sort').default(0).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── model_health ─ produced by the 6h backend probe; read by the board + the menu ─
export const modelHealth = pgTable('model_health', {
  modelId: text('model_id')
    .primaryKey()
    .references(() => modelDefinition.id, { onDelete: 'cascade' }),
  health: modelHealthEnum('health').notNull().default('unknown'),
  lastProbeAt: timestamptz('last_probe_at'),
  // Failure classification: network | auth | model | timeout | http_4xx | http_5xx
  probeError: text('probe_error'),
  latencyMs: integer('latency_ms'),
});

// ── model_default ─ per-capability default slots, overridable per project (v2) ──
// One row per (capability, global) + one per (capability, project). Resolution:
// project row → global row → legacy isDefault (chat only) → first enabled with the
// capability. Partial unique indexes because Postgres treats NULLs as distinct.
export const modelDefault = pgTable(
  'model_default',
  {
    capability: text('capability').$type<ModelCapability>().notNull(),
    // NULL → the global slot. Cascades away with the project.
    projectId: uuid('project_id').references(() => project.id, { onDelete: 'cascade' }),
    modelId: text('model_id')
      .notNull()
      .references(() => modelDefinition.id, { onDelete: 'cascade' }),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('model_default_global_uq')
      .on(t.capability)
      .where(sql`${t.projectId} IS NULL`),
    uniqueIndex('model_default_project_uq')
      .on(t.capability, t.projectId)
      .where(sql`${t.projectId} IS NOT NULL`),
  ],
);

export type ModelConnection = typeof modelConnection.$inferSelect;
export type NewModelConnection = typeof modelConnection.$inferInsert;
export type ModelDefinition = typeof modelDefinition.$inferSelect;
export type NewModelDefinition = typeof modelDefinition.$inferInsert;
export type ModelHealthRow = typeof modelHealth.$inferSelect;
export type NewModelHealthRow = typeof modelHealth.$inferInsert;
export type ModelDefaultRow = typeof modelDefault.$inferSelect;
export type ModelProtocol = (typeof modelProtocolEnum.enumValues)[number];
