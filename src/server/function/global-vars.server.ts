/**
 * Global variables admin server functions (registry v2).
 *
 * Admin-only CRUD over `global_variable` — env-style variables/secrets managed in
 * the UI instead of `.env` (K1 posture: sealed at rest, masked in transit to the
 * client, decrypted only server-side). Key hygiene (env-style names + reserved
 * blocklist) lives in the service (assertGlobalVarKeyAllowed).
 */

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { auth } from '~/server/auth.server';
import {
  listGlobalVars,
  upsertGlobalVar,
  deleteGlobalVar,
  type GlobalVarRow,
} from '~/server/models/global-vars';
import { hasSecretKey } from '~/server/security/secret-box';

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

export const listGlobalVarsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ vars: GlobalVarRow[]; secretKeyConfigured: boolean }> => {
    await requireAdmin();
    return { vars: await listGlobalVars(), secretKeyConfigured: hasSecretKey() };
  },
);

export const upsertGlobalVarFn = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      key: z.string().min(1).max(128),
      value: z.string().max(32_768).optional(),
      isSecret: z.boolean().optional(),
      injectWorker: z.boolean().optional(),
      description: z.string().max(500).nullish(),
    }),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    await upsertGlobalVar({ ...data, description: data.description ?? undefined });
    return { ok: true };
  });

export const deleteGlobalVarFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ key: z.string().min(1) }))
  .handler(async ({ data }) => {
    await requireAdmin();
    await deleteGlobalVar(data.key);
    return { ok: true };
  });
