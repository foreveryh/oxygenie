/**
 * Multi-model admin server functions (PR6).
 *
 * Admin-only board controls: list all models (incl. disabled/unhealthy) with health,
 * toggle enabled, set the default, and enqueue a re-probe. Connection/model CRUD
 * forms are a fast-follow (PR6b); definitions bootstrap from OXY_MODELS_SEED. All
 * fns require system admin; none return a token value.
 */

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { auth } from '~/server/auth.server';
import {
  listModelsAdmin,
  listConnectionsAdmin,
  setModelEnabled,
  setDefaultModelById,
  setDefaultModelFor,
  listDefaultSlots,
  setConnectionCredential,
  testConnection,
  upsertConnection,
  deleteConnection,
  upsertModel,
  deleteModel,
  MODEL_CAPABILITIES,
  type AdminModelRow,
  type AdminConnectionRow,
  type DefaultSlotRow,
} from '~/server/models/registry';
import { PROVIDER_CATALOG, type CatalogProvider } from '~/server/models/provider-catalog';
import { hasSecretKey } from '~/server/security/secret-box';
import { AUTH_STYLES } from '~/server/models/model-config';
import { systemQueue } from '~/jobs/queues';

const requireAdmin = async () => {
  const { headers } = getRequest();
  const session = await auth.api.getSession({ headers });
  if (!session?.user) throw new Error('UNAUTHORIZED');
  const { db } = await import('~/db/db-config');
  const { user: userTable } = await import('~/db/schema');
  const { eq } = await import('drizzle-orm');
  const userData = await db.query.user.findFirst({
    where: eq(userTable.id, session.user.id),
    columns: { systemRole: true },
  });
  if (userData?.systemRole !== 'admin') throw new Error('FORBIDDEN: Admin access required');
  return session.user;
};

export const listModelsAdminFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminModelRow[]> => {
    await requireAdmin();
    return listModelsAdmin();
  },
);

export const setModelEnabledFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string().min(1), enabled: z.boolean() }))
  .handler(async ({ data }) => {
    await requireAdmin();
    await setModelEnabled(data.id, data.enabled);
    return { ok: true };
  });

export const setDefaultModelFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    await requireAdmin();
    await setDefaultModelById(data.id);
    return { ok: true };
  });

/** Enqueue a health re-probe (one model when modelId given, else the full sweep). */
export const reprobeModelsFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ modelId: z.string().optional() }))
  .handler(async ({ data }) => {
    await requireAdmin();
    await systemQueue.add('probe-models', data.modelId ? { modelId: data.modelId } : {});
    return { ok: true };
  });

// ── CRUD (PR6b) ───────────────────────────────────────────────────────────────

const idRe = /^[a-zA-Z0-9._/-]+$/;

const PROTOCOLS = ['anthropic', 'openai-compat', 'gemini', 'custom'] as const;

const connectionInputSchema = z.object({
  id: z.string().min(1).regex(idRe),
  label: z.string().min(1),
  baseUrl: z.string().url(),
  authStyle: z.enum(AUTH_STYLES),
  protocol: z.enum(PROTOCOLS).optional(),
  // v2: optional — UI-created connections carry a DB credential instead.
  tokenEnv: z.string().nullish(),
  anthropicVersion: z.string().optional(),
  aliasOpus: z.string().nullish(),
  aliasSonnet: z.string().nullish(),
  aliasHaiku: z.string().nullish(),
  aliasSubagent: z.string().nullish(),
});

const modelInputSchema = z.object({
  id: z.string().min(1).regex(idRe),
  label: z.string().min(1),
  connectionId: z.string().min(1),
  model: z.string().min(1),
  capabilities: z.array(z.enum(MODEL_CAPABILITIES)).optional(),
  mediaAdapter: z.string().min(1).nullish(),
  mediaConfig: z.record(z.string(), z.json()).optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export const upsertConnectionFn = createServerFn({ method: 'POST' })
  .inputValidator(connectionInputSchema)
  .handler(async ({ data }) => {
    await requireAdmin();
    await upsertConnection({ ...data, aliasOpus: data.aliasOpus ?? null, aliasSonnet: data.aliasSonnet ?? null, aliasHaiku: data.aliasHaiku ?? null, aliasSubagent: data.aliasSubagent ?? null });
    return { ok: true };
  });

export const deleteConnectionFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    await requireAdmin();
    await deleteConnection(data.id);
    return { ok: true };
  });

export const upsertModelFn = createServerFn({ method: 'POST' })
  .inputValidator(modelInputSchema)
  .handler(async ({ data }) => {
    await requireAdmin();
    await upsertModel(data);
    return { ok: true };
  });

export const deleteModelFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    await requireAdmin();
    await deleteModel(data.id);
    return { ok: true };
  });

// ── Registry v2 ───────────────────────────────────────────────────────────────

/** Connections (even model-less), credential status, catalog, defaults — one loader. */
export const listRegistryAdminFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{
    connections: AdminConnectionRow[];
    models: AdminModelRow[];
    defaults: DefaultSlotRow[];
    catalog: CatalogProvider[];
    secretKeyConfigured: boolean;
  }> => {
    await requireAdmin();
    const [connections, models, defaults] = await Promise.all([
      listConnectionsAdmin(),
      listModelsAdmin(),
      listDefaultSlots(),
    ]);
    return { connections, models, defaults, catalog: PROVIDER_CATALOG, secretKeyConfigured: hasSecretKey() };
  },
);

/** Store (or clear with credential=null) a connection's API key. Plaintext dies here. */
export const setConnectionCredentialFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string().min(1), credential: z.string().min(1).nullable() }))
  .handler(async ({ data }) => {
    await requireAdmin();
    await setConnectionCredential(data.id, data.credential);
    return { ok: true };
  });

/** Immediate connection test (admin "测试连接" button). */
export const testConnectionFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ connectionId: z.string().min(1), modelId: z.string().optional() }))
  .handler(async ({ data }) => {
    await requireAdmin();
    return testConnection(data.connectionId, data.modelId ?? null);
  });

/** Set/clear a per-capability default slot (global when projectId omitted). */
export const setDefaultSlotFn = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      capability: z.enum(MODEL_CAPABILITIES),
      modelId: z.string().min(1).nullable(),
      projectId: z.string().uuid().nullish(),
    }),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    await setDefaultModelFor(data.capability, data.modelId, data.projectId ?? null);
    return { ok: true };
  });

/** Projects for the per-project override picker (admin sees all). */
export const listProjectsAdminFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdmin();
  const { db } = await import('~/db/db-config');
  const { project } = await import('~/db/schema');
  const rows = await db.select({ id: project.id, name: project.name }).from(project);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
});
