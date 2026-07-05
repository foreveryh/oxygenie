/**
 * Global variables service (registry v2) — admin-managed env-style variables/secrets
 * beyond model credentials (MCP / skills / external APIs). Values are ALWAYS stored
 * sealed; `injectWorker` rows are shipped (still sealed) to ws-server at spawn time
 * via /api/models/worker-vars and opened there just-in-time.
 *
 * Key hygiene: env-style names only, with a reserved-prefix blocklist so a variable
 * can never shadow model routing (ANTHROPIC_*), platform config (DATABASE_URL …) or
 * the master key itself. Enforced here (single choke point) — server fns just call in.
 */

import { eq } from 'drizzle-orm';
import { db } from '~/db/client';
import { globalVariable } from '~/db/schema/global-variable.schema';
import { sealSecret, openSecret, maskSecret } from '~/server/security/secret-box';
import { assertGlobalVarKeyAllowed } from './global-var-rules';

export { assertGlobalVarKeyAllowed };

export type GlobalVarRow = {
  key: string;
  /** Masked (`••••xxxx`) when isSecret, else the decrypted value. */
  display: string;
  isSecret: boolean;
  injectWorker: boolean;
  description: string | null;
  updatedAt: Date;
};

export async function listGlobalVars(): Promise<GlobalVarRow[]> {
  const rows = await db.select().from(globalVariable);
  return rows
    .map((r) => {
      let display: string;
      try {
        const plain = openSecret(r.valueEncrypted);
        display = r.isSecret ? maskSecret(plain) : plain;
      } catch {
        display = '••••????'; // sealed with a different/lost KIN_SECRET_KEY
      }
      return {
        key: r.key,
        display,
        isSecret: r.isSecret,
        injectWorker: r.injectWorker,
        description: r.description,
        updatedAt: r.updatedAt,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export async function upsertGlobalVar(input: {
  key: string;
  /** Plaintext value; undefined → keep the stored value (metadata-only update). */
  value?: string;
  isSecret?: boolean;
  injectWorker?: boolean;
  description?: string | null;
}): Promise<void> {
  assertGlobalVarKeyAllowed(input.key);
  const [existing] = await db
    .select({ key: globalVariable.key })
    .from(globalVariable)
    .where(eq(globalVariable.key, input.key))
    .limit(1);

  if (!existing) {
    if (!input.value) throw new Error('新变量必须提供值');
    await db.insert(globalVariable).values({
      key: input.key,
      valueEncrypted: sealSecret(input.value),
      isSecret: input.isSecret ?? true,
      injectWorker: input.injectWorker ?? true,
      description: input.description ?? null,
    });
    return;
  }

  const set: Partial<typeof globalVariable.$inferInsert> = { updatedAt: new Date() };
  if (input.value !== undefined && input.value !== '') set.valueEncrypted = sealSecret(input.value);
  if (input.isSecret !== undefined) set.isSecret = input.isSecret;
  if (input.injectWorker !== undefined) set.injectWorker = input.injectWorker;
  if (input.description !== undefined) set.description = input.description;
  await db.update(globalVariable).set(set).where(eq(globalVariable.key, input.key));
}

export async function deleteGlobalVar(key: string): Promise<void> {
  await db.delete(globalVariable).where(eq(globalVariable.key, key));
}

/** Sealed inject-worker rows for the ws-server spawn path (opened there, not here). */
export async function getWorkerVarsSealed(): Promise<Array<{ key: string; valueEncrypted: string }>> {
  const rows = await db
    .select({ key: globalVariable.key, valueEncrypted: globalVariable.valueEncrypted })
    .from(globalVariable)
    .where(eq(globalVariable.injectWorker, true));
  return rows;
}
