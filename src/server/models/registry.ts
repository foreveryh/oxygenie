/**
 * Multi-model registry — DB-backed runtime source of truth (PR2).
 *
 * Server-only (imports the DB client). The web app + server fns use this; the
 * separate `ws-server.mjs` process does NOT import it — it fetches token-free model
 * metadata over HTTP and routes via build-worker-env.js (keeps secrets in-process).
 *
 * Seed-on-boot: OXY_MODELS_SEED (or a legacy ANTHROPIC_* fallback) is upserted with
 * onConflictDoNothing so admin edits in /admin/models are never clobbered. DB wins
 * thereafter. Secrets are never stored — only tokenEnv (the env-var NAME).
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '~/db/client';
import {
  modelConnection,
  modelDefinition,
  modelDefault,
  modelHealth,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelProtocol,
} from '~/db/schema/model.schema';
import { project } from '~/db/schema/project.schema';
import { sealSecret, openSecret, maskSecret } from '~/server/security/secret-box';
import { parseModelSeed, type AuthStyle, type ModelSeedConfig } from './model-config';

export { MODEL_CAPABILITIES, type ModelCapability, type ModelProtocol };

/**
 * Plaintext-free metadata the ws-server resolve endpoint returns for routing.
 * v2: carries the SEALED credential (ws-server opens it with its own
 * KIN_SECRET_KEY) and/or the legacy tokenEnv name — never a plaintext token.
 */
export type ModelRouteMeta = {
  id: string;
  model: string;
  connectionId: string;
  baseUrl: string;
  authStyle: AuthStyle;
  protocol: ModelProtocol;
  credentialEncrypted: string | null;
  tokenEnv: string | null;
  anthropicVersion: string;
  customHeaders: Record<string, string> | null;
  aliasOpus: string | null;
  aliasSonnet: string | null;
  aliasHaiku: string | null;
  aliasSubagent: string | null;
  enabled: boolean;
  health: 'healthy' | 'unhealthy' | 'unknown';
};

/** A selectable model for the composer picker (never includes secrets). */
export type SelectableModel = {
  id: string;
  label: string;
  connectionId: string;
  connectionLabel: string;
  tags: string[];
};

/**
 * If OXY_MODELS_SEED is unset, synthesize a single connection+model from the legacy
 * single-value ANTHROPIC_* env so existing deployments keep working (and get a
 * one-item menu) without any new config.
 */
function legacyFallbackSeed(): ModelSeedConfig | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const model = process.env.ANTHROPIC_MODEL;
  if (!baseUrl || !model) return null;
  // ARK uses ANTHROPIC_AUTH_TOKEN (Bearer); native uses ANTHROPIC_API_KEY.
  const authStyle: AuthStyle = process.env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'x-api-key';
  const tokenEnv = authStyle === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  const id = `default/${model}`;
  return {
    default: id,
    connections: [
      {
        id: 'default',
        label: 'Default',
        baseUrl,
        authStyle,
        tokenEnv,
        anthropicVersion: '2023-06-01',
      },
    ],
    models: [{ id, label: model, connection: 'default', model, tags: [], enabled: true, isDefault: true }],
  };
}

/**
 * Seed connections + models + health rows from env — v2 semantics: ONLY when the
 * connection table is EMPTY. Once anything exists, the DB/UI is the sole source of
 * truth and the seed never fights admin edits (kills the old "default won't flip /
 * deleted rows resurrect on restart" trap of per-row onConflictDoNothing).
 */
export async function seedModelsFromEnv(): Promise<{ connections: number; models: number } | null> {
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(modelConnection);
  if ((existing?.n ?? 0) > 0) {
    console.log('[Models] DB already has connections — seed skipped (DB is source of truth).');
    return null;
  }

  const seed = parseModelSeed() ?? legacyFallbackSeed();
  if (!seed) {
    console.log('[Models] No OXY_MODELS_SEED and no legacy ANTHROPIC_* — skipping seed.');
    return null;
  }

  for (const c of seed.connections) {
    await db
      .insert(modelConnection)
      .values({
        id: c.id,
        label: c.label,
        baseUrl: c.baseUrl,
        authStyle: c.authStyle,
        tokenEnv: c.tokenEnv,
        anthropicVersion: c.anthropicVersion,
        customHeaders: c.customHeaders ?? null,
        aliasOpus: c.aliasOpus ?? null,
        aliasSonnet: c.aliasSonnet ?? null,
        aliasHaiku: c.aliasHaiku ?? null,
        aliasSubagent: c.aliasSubagent ?? null,
      })
      .onConflictDoNothing();
  }

  for (const m of seed.models) {
    await db
      .insert(modelDefinition)
      .values({
        id: m.id,
        label: m.label,
        connectionId: m.connection,
        model: m.model,
        tags: m.tags,
        enabled: m.enabled,
        isDefault: m.isDefault || seed.default === m.id,
      })
      .onConflictDoNothing();
    // Seed an 'unknown' health row so the model shows as "checking…" until first probe.
    await db.insert(modelHealth).values({ modelId: m.id, health: 'unknown' }).onConflictDoNothing();
  }

  console.log(`[Models] Seed: ${seed.connections.length} connections, ${seed.models.length} models (idempotent).`);
  return { connections: seed.connections.length, models: seed.models.length };
}

/**
 * Models the user may pick in the composer right now: enabled && healthy && has the
 * 'chat' capability on an anthropic-protocol connection (Agent runtime constraint).
 * No secrets.
 */
export async function getSelectableModels(): Promise<SelectableModel[]> {
  const rows = await db
    .select({
      id: modelDefinition.id,
      label: modelDefinition.label,
      connectionId: modelConnection.id,
      connectionLabel: modelConnection.label,
      tags: modelDefinition.tags,
      capabilities: modelDefinition.capabilities,
      protocol: modelConnection.protocol,
      connSort: modelConnection.sort,
      defSort: modelDefinition.sort,
    })
    .from(modelDefinition)
    .innerJoin(modelConnection, eq(modelDefinition.connectionId, modelConnection.id))
    .innerJoin(modelHealth, eq(modelHealth.modelId, modelDefinition.id))
    .where(and(eq(modelDefinition.enabled, true), eq(modelHealth.health, 'healthy')));

  return rows
    .filter((r) => r.capabilities.includes('chat') && r.protocol === 'anthropic')
    .sort((a, b) => a.connSort - b.connSort || a.defSort - b.defSort)
    .map(({ connSort: _c, defSort: _d, capabilities: _cap, protocol: _p, ...m }) => m);
}

/** Token-free metadata for the ws-server resolve endpoint. Null if unknown id. */
export async function resolveModelMeta(id: string): Promise<ModelRouteMeta | null> {
  const [row] = await db
    .select({
      id: modelDefinition.id,
      model: modelDefinition.model,
      enabled: modelDefinition.enabled,
      connectionId: modelConnection.id,
      baseUrl: modelConnection.baseUrl,
      authStyle: modelConnection.authStyle,
      protocol: modelConnection.protocol,
      credentialEncrypted: modelConnection.credentialEncrypted,
      tokenEnv: modelConnection.tokenEnv,
      anthropicVersion: modelConnection.anthropicVersion,
      customHeaders: modelConnection.customHeaders,
      aliasOpus: modelConnection.aliasOpus,
      aliasSonnet: modelConnection.aliasSonnet,
      aliasHaiku: modelConnection.aliasHaiku,
      aliasSubagent: modelConnection.aliasSubagent,
      health: modelHealth.health,
    })
    .from(modelDefinition)
    .innerJoin(modelConnection, eq(modelDefinition.connectionId, modelConnection.id))
    .leftJoin(modelHealth, eq(modelHealth.modelId, modelDefinition.id))
    .where(eq(modelDefinition.id, id))
    .limit(1);
  if (!row) return null;
  return { ...row, health: row.health ?? 'unknown' };
}

/**
 * Default CHAT model id (composer). v2: slot-aware — project override → global slot
 * → legacy isDefault → first selectable. Only healthy selectable models win.
 */
export async function getDefaultModelId(projectId?: string | null): Promise<string | null> {
  const selectable = await getSelectableModels();
  if (selectable.length === 0) return null;
  const selectableIds = new Set(selectable.map((m) => m.id));

  const slotId = await getDefaultModelFor('chat', projectId ?? null);
  if (slotId && selectableIds.has(slotId)) return slotId;

  const [def] = await db
    .select({ id: modelDefinition.id })
    .from(modelDefinition)
    .innerJoin(modelHealth, eq(modelHealth.modelId, modelDefinition.id))
    .where(and(eq(modelDefinition.isDefault, true), eq(modelHealth.health, 'healthy')))
    .limit(1);
  if (def && selectableIds.has(def.id)) return def.id;
  return selectable[0].id;
}

// ── Capability default slots (v2) ─────────────────────────────────────────────

/**
 * Raw slot lookup: project override → global slot → legacy isDefault (chat only)
 * → first ENABLED model with the capability. Does NOT apply health gating (callers
 * that need it, like the composer default, layer it on top) — generation/vision
 * capabilities are auth-probed only, so "unknown" health must not block them.
 */
export async function getDefaultModelFor(
  capability: ModelCapability,
  projectId?: string | null,
): Promise<string | null> {
  if (projectId) {
    const [row] = await db
      .select({ modelId: modelDefault.modelId })
      .from(modelDefault)
      .where(and(eq(modelDefault.capability, capability), eq(modelDefault.projectId, projectId)))
      .limit(1);
    if (row) return row.modelId;
  }

  const [globalRow] = await db
    .select({ modelId: modelDefault.modelId })
    .from(modelDefault)
    .where(and(eq(modelDefault.capability, capability), isNull(modelDefault.projectId)))
    .limit(1);
  if (globalRow) return globalRow.modelId;

  if (capability === 'chat') {
    const [legacy] = await db
      .select({ id: modelDefinition.id })
      .from(modelDefinition)
      .where(and(eq(modelDefinition.isDefault, true), eq(modelDefinition.enabled, true)))
      .limit(1);
    if (legacy) return legacy.id;
  }

  const enabled = await db
    .select({ id: modelDefinition.id, capabilities: modelDefinition.capabilities, sort: modelDefinition.sort })
    .from(modelDefinition)
    .where(eq(modelDefinition.enabled, true));
  const first = enabled
    .filter((m) => m.capabilities.includes(capability))
    .sort((a, b) => a.sort - b.sort)[0];
  return first?.id ?? null;
}

/**
 * Set (or clear with modelId=null) a default slot. Global chat slot also syncs the
 * legacy isDefault flag so pre-v2 readers keep agreeing with the slot table.
 */
export async function setDefaultModelFor(
  capability: ModelCapability,
  modelId: string | null,
  projectId?: string | null,
): Promise<void> {
  const scope = projectId
    ? and(eq(modelDefault.capability, capability), eq(modelDefault.projectId, projectId))
    : and(eq(modelDefault.capability, capability), isNull(modelDefault.projectId));

  if (!modelId) {
    await db.delete(modelDefault).where(scope);
    return;
  }

  const [model] = await db
    .select({ id: modelDefinition.id, capabilities: modelDefinition.capabilities, protocol: modelConnection.protocol })
    .from(modelDefinition)
    .innerJoin(modelConnection, eq(modelDefinition.connectionId, modelConnection.id))
    .where(eq(modelDefinition.id, modelId))
    .limit(1);
  if (!model) throw new Error(`Unknown model "${modelId}"`);
  if (!model.capabilities.includes(capability)) {
    throw new Error(`Model "${modelId}" does not declare the "${capability}" capability`);
  }
  // Hard constraint: the Agent runtime only speaks the Anthropic protocol.
  if (capability === 'chat' && model.protocol !== 'anthropic') {
    throw new Error('对话（Agent）默认模型必须来自 Anthropic 兼容协议的连接');
  }

  await db.delete(modelDefault).where(scope);
  await db.insert(modelDefault).values({ capability, projectId: projectId ?? null, modelId });

  if (capability === 'chat' && !projectId) {
    await db.update(modelDefinition).set({ isDefault: false }).where(eq(modelDefinition.isDefault, true));
    await db.update(modelDefinition).set({ isDefault: true }).where(eq(modelDefinition.id, modelId));
  }
}

export type DefaultSlotRow = {
  capability: ModelCapability;
  projectId: string | null;
  projectName: string | null;
  modelId: string;
  modelLabel: string;
};

/** All default slots (global + per-project) with display labels, for the admin UI. */
export async function listDefaultSlots(): Promise<DefaultSlotRow[]> {
  const rows = await db
    .select({
      capability: modelDefault.capability,
      projectId: modelDefault.projectId,
      projectName: project.name,
      modelId: modelDefault.modelId,
      modelLabel: modelDefinition.label,
    })
    .from(modelDefault)
    .innerJoin(modelDefinition, eq(modelDefault.modelId, modelDefinition.id))
    .leftJoin(project, eq(modelDefault.projectId, project.id));
  return rows.map((r) => ({ ...r, projectName: r.projectName ?? null }));
}

// ── Admin board (PR6) ─────────────────────────────────────────────────────────

/** Where a connection's credential resolves from (never the value itself). */
export type CredentialSource = 'db' | 'env' | 'none';

/** A model row for the admin board: full state incl. disabled/unhealthy. No token. */
export type AdminModelRow = {
  id: string;
  label: string;
  model: string;
  capabilities: ModelCapability[];
  tags: string[];
  enabled: boolean;
  isDefault: boolean;
  connectionId: string;
  connectionLabel: string;
  baseUrl: string;
  authStyle: AuthStyle;
  protocol: ModelProtocol;
  tokenEnv: string | null;
  credentialSource: CredentialSource;
  health: 'healthy' | 'unhealthy' | 'unknown';
  lastProbeAt: Date | null;
  probeError: string | null;
  latencyMs: number | null;
};

/** Classify a connection's credential source: DB blob wins, env name second. */
export function classifyCredentialSource(row: {
  credentialEncrypted: string | null;
  tokenEnv: string | null;
}): CredentialSource {
  if (row.credentialEncrypted) return 'db';
  if (row.tokenEnv && process.env[row.tokenEnv]) return 'env';
  return 'none';
}

/** A connection row for the admin board (v2) — includes credential status + mask. */
export type AdminConnectionRow = {
  id: string;
  label: string;
  baseUrl: string;
  authStyle: AuthStyle;
  protocol: ModelProtocol;
  tokenEnv: string | null;
  credentialSource: CredentialSource;
  /** `••••xxxx` when a DB credential is stored (null otherwise). */
  credentialMask: string | null;
  aliasHaiku: string | null;
  sort: number;
};

/** All connections (even model-less ones — fresh catalog adds) for the admin board. */
export async function listConnectionsAdmin(): Promise<AdminConnectionRow[]> {
  const rows = await db.select().from(modelConnection);
  return rows
    .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
    .map((c) => {
      let credentialMask: string | null = null;
      if (c.credentialEncrypted) {
        try {
          credentialMask = maskSecret(openSecret(c.credentialEncrypted));
        } catch {
          credentialMask = '••••????';
        }
      }
      return {
        id: c.id,
        label: c.label,
        baseUrl: c.baseUrl,
        authStyle: c.authStyle,
        protocol: c.protocol,
        tokenEnv: c.tokenEnv,
        credentialSource: classifyCredentialSource(c),
        credentialMask,
        aliasHaiku: c.aliasHaiku,
        sort: c.sort,
      };
    });
}

/** All models (incl. disabled/unhealthy) for the admin board. Token-free. */
export async function listModelsAdmin(): Promise<AdminModelRow[]> {
  const rows = await db
    .select({
      id: modelDefinition.id,
      label: modelDefinition.label,
      model: modelDefinition.model,
      capabilities: modelDefinition.capabilities,
      tags: modelDefinition.tags,
      enabled: modelDefinition.enabled,
      isDefault: modelDefinition.isDefault,
      defSort: modelDefinition.sort,
      connectionId: modelConnection.id,
      connectionLabel: modelConnection.label,
      connSort: modelConnection.sort,
      baseUrl: modelConnection.baseUrl,
      authStyle: modelConnection.authStyle,
      protocol: modelConnection.protocol,
      credentialEncrypted: modelConnection.credentialEncrypted,
      tokenEnv: modelConnection.tokenEnv,
      health: modelHealth.health,
      lastProbeAt: modelHealth.lastProbeAt,
      probeError: modelHealth.probeError,
      latencyMs: modelHealth.latencyMs,
    })
    .from(modelDefinition)
    .innerJoin(modelConnection, eq(modelDefinition.connectionId, modelConnection.id))
    .leftJoin(modelHealth, eq(modelHealth.modelId, modelDefinition.id));

  return rows
    .sort((a, b) => a.connSort - b.connSort || a.defSort - b.defSort)
    .map(({ connSort: _c, defSort: _d, credentialEncrypted, ...r }) => ({
      ...r,
      credentialSource: classifyCredentialSource({ credentialEncrypted, tokenEnv: r.tokenEnv }),
      health: r.health ?? 'unknown',
    }));
}

/** Toggle a model's enabled flag. */
export async function setModelEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(modelDefinition).set({ enabled }).where(eq(modelDefinition.id, id));
}

/** Make `id` the single default model (clears the previous default). */
export async function setDefaultModelById(id: string): Promise<void> {
  await db.update(modelDefinition).set({ isDefault: false }).where(eq(modelDefinition.isDefault, true));
  await db.update(modelDefinition).set({ isDefault: true }).where(eq(modelDefinition.id, id));
}

// ── Admin CRUD (PR6b) ─────────────────────────────────────────────────────────
// Definitions live in the DB; secrets stay in env (tokenEnv NAME only). Adding a
// connection here records its tokenEnv; the value must exist in the server env.

export type ConnectionInput = {
  id: string;
  label: string;
  baseUrl: string;
  authStyle: AuthStyle;
  protocol?: ModelProtocol;
  /** Legacy env-var NAME. Optional in v2 (UI connections use credential instead). */
  tokenEnv?: string | null;
  anthropicVersion?: string;
  aliasOpus?: string | null;
  aliasSonnet?: string | null;
  aliasHaiku?: string | null;
  aliasSubagent?: string | null;
};

export type ModelInput = {
  id: string;
  label: string;
  connectionId: string;
  model: string;
  capabilities?: ModelCapability[];
  tags?: string[];
  enabled?: boolean;
};

/** Create or update a connection (upsert by id). Credential is set separately. */
export async function upsertConnection(c: ConnectionInput): Promise<void> {
  const values = {
    id: c.id,
    label: c.label,
    baseUrl: c.baseUrl,
    authStyle: c.authStyle,
    protocol: c.protocol ?? ('anthropic' as ModelProtocol),
    tokenEnv: c.tokenEnv ?? null,
    anthropicVersion: c.anthropicVersion || '2023-06-01',
    aliasOpus: c.aliasOpus ?? null,
    aliasSonnet: c.aliasSonnet ?? null,
    aliasHaiku: c.aliasHaiku ?? null,
    aliasSubagent: c.aliasSubagent ?? null,
  };
  // NOTE: credentialEncrypted deliberately absent — upserts must never wipe a stored
  // credential; use setConnectionCredential for that.
  await db
    .insert(modelConnection)
    .values(values)
    .onConflictDoUpdate({ target: modelConnection.id, set: { ...values, updatedAt: new Date() } });
}

/**
 * Store (plaintext → sealed) or clear (null) a connection's credential.
 * The plaintext exists only inside this call.
 */
export async function setConnectionCredential(id: string, plaintext: string | null): Promise<void> {
  const [conn] = await db
    .select({ id: modelConnection.id })
    .from(modelConnection)
    .where(eq(modelConnection.id, id))
    .limit(1);
  if (!conn) throw new Error(`Unknown connection "${id}"`);
  const credentialEncrypted = plaintext === null ? null : sealSecret(plaintext);
  await db
    .update(modelConnection)
    .set({ credentialEncrypted, updatedAt: new Date() })
    .where(eq(modelConnection.id, id));
}

/** Masked credential preview for the admin UI (`••••xxxx`), or null when none in DB. */
export async function getConnectionCredentialMask(id: string): Promise<string | null> {
  const [conn] = await db
    .select({ credentialEncrypted: modelConnection.credentialEncrypted })
    .from(modelConnection)
    .where(eq(modelConnection.id, id))
    .limit(1);
  if (!conn?.credentialEncrypted) return null;
  try {
    return maskSecret(openSecret(conn.credentialEncrypted));
  } catch {
    return '••••????'; // sealed with a different/lost KIN_SECRET_KEY
  }
}

/** Delete a connection (cascades to its models + health rows). */
export async function deleteConnection(id: string): Promise<void> {
  await db.delete(modelConnection).where(eq(modelConnection.id, id));
}

/** Create or update a model (upsert by id). Verifies the connection exists. */
export async function upsertModel(m: ModelInput): Promise<void> {
  const [conn] = await db
    .select({ id: modelConnection.id })
    .from(modelConnection)
    .where(eq(modelConnection.id, m.connectionId))
    .limit(1);
  if (!conn) throw new Error(`Unknown connection "${m.connectionId}"`);
  const values = {
    id: m.id,
    label: m.label,
    connectionId: m.connectionId,
    model: m.model,
    capabilities: m.capabilities?.length ? m.capabilities : (['chat'] as ModelCapability[]),
    tags: m.tags ?? [],
    enabled: m.enabled ?? true,
  };
  await db
    .insert(modelDefinition)
    .values(values)
    .onConflictDoUpdate({ target: modelDefinition.id, set: { ...values, updatedAt: new Date() } });
  await db.insert(modelHealth).values({ modelId: m.id, health: 'unknown' }).onConflictDoNothing();
}

/** Delete a model (cascades to its health row). */
export async function deleteModel(id: string): Promise<void> {
  await db.delete(modelDefinition).where(eq(modelDefinition.id, id));
}

// ── Test connection (v2, K6) ──────────────────────────────────────────────────

/**
 * Immediate connection test for the admin UI. Anthropic protocol needs a model
 * string (real 1-token Messages call): uses `modelId`'s model, else the
 * connection's first model, else aliasHaiku. Other protocols do an authed
 * model-list check and need no model.
 */
export async function testConnection(
  connectionId: string,
  modelId?: string | null,
): Promise<{ health: 'healthy' | 'unhealthy'; probeError: string | null; latencyMs: number }> {
  const [conn] = await db
    .select()
    .from(modelConnection)
    .where(eq(modelConnection.id, connectionId))
    .limit(1);
  if (!conn) throw new Error(`Unknown connection "${connectionId}"`);

  let modelString = '';
  if (conn.protocol === 'anthropic') {
    if (modelId) {
      const [m] = await db
        .select({ model: modelDefinition.model })
        .from(modelDefinition)
        .where(eq(modelDefinition.id, modelId))
        .limit(1);
      modelString = m?.model ?? '';
    }
    if (!modelString) {
      const [first] = await db
        .select({ model: modelDefinition.model })
        .from(modelDefinition)
        .where(eq(modelDefinition.connectionId, connectionId))
        .limit(1);
      modelString = first?.model ?? conn.aliasHaiku ?? '';
    }
    if (!modelString) {
      throw new Error('该连接还没有模型可用于测试——先添加一个模型（或填写 aliasHaiku）再测试');
    }
  }

  const { probeConnection } = await import('./probe');
  return probeConnection({
    baseUrl: conn.baseUrl,
    authStyle: conn.authStyle,
    protocol: conn.protocol,
    credentialEncrypted: conn.credentialEncrypted,
    tokenEnv: conn.tokenEnv,
    model: modelString,
    anthropicVersion: conn.anthropicVersion,
    customHeaders: conn.customHeaders,
  });
}
