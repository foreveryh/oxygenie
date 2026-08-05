/**
 * Canvas Agent (D5/M3) — shared generation_task orchestration.
 *
 * Factored out of the two internal HTTP routes (tasks.ts / tasks.$taskId.complete.ts,
 * called by ws-server.mjs on behalf of the agent path) so the M3 direct-gen bullmq
 * processor can call the SAME create/complete logic directly (it has real drizzle
 * access, unlike ws-server.mjs — see workspace-path.ts's header comment on why that
 * file stays plain JS) instead of duplicating the slot-reservation/asset-insert code
 * a third time. Both call sites keep their own HTTP-layer auth/ownership checks;
 * these functions assume the caller has already verified ownership.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { canvasAsset, generationTask, type GenerationTaskParams } from '~/db/schema';
import { assignSlots, slotOf, originOf, fitInSlot, type Pos } from '~/server/canvas/slot-layout';

export type CreateTaskInput = {
  canvasId: string;
  sessionId?: string | null;
  origin: 'agent' | 'direct';
  kind: 't2i' | 'i2i' | 't2v' | 'i2v' | 'v2v';
  params?: GenerationTaskParams;
  modelSlug?: string | null;
};

/** Reserve N slots for a new task (existing ready/generating assets + slots already
 * held by other running tasks) and insert the generation_task row as 'running'. */
export async function createGenerationTask(input: CreateTaskInput) {
  const count = Math.max(1, input.params?.count ?? 1);

  const existingAssets = await db
    .select({ posX: canvasAsset.posX, posY: canvasAsset.posY })
    .from(canvasAsset)
    .where(and(eq(canvasAsset.canvasId, input.canvasId), isNull(canvasAsset.deletedAt)));
  const runningTasks = await db
    .select({ reservedSlots: generationTask.reservedSlots })
    .from(generationTask)
    .where(and(eq(generationTask.canvasId, input.canvasId), eq(generationTask.status, 'running')));

  const reservedFromRunning: Pos[] = runningTasks.flatMap((t) => (t.reservedSlots || []).map((idx) => originOf(idx)));
  const occupied: Pos[] = [...existingAssets, ...reservedFromRunning];

  const slots = assignSlots(count, occupied);
  const reservedSlotIndices = slots.map((s) => slotOf(s));

  const [task] = await db
    .insert(generationTask)
    .values({
      canvasId: input.canvasId,
      sessionId: input.sessionId || null,
      origin: input.origin,
      kind: input.kind,
      modelSlug: input.modelSlug || null,
      params: input.params || {},
      reservedSlots: reservedSlotIndices,
      status: 'running',
    })
    .returning();

  return { task, reservedPositions: slots };
}

export type CompleteTaskFile = { id: string; relPath: string; width: number; height: number; durationSec?: number };
export type CompleteTaskInput =
  | { taskId: string; status: 'done'; files: CompleteTaskFile[]; assetOrigin: 'agent' | 'direct' | 'upload' }
  | { taskId: string; status: 'failed'; error: string };

/** Mark a task done (inserting its output assets, consuming reserved slots) or failed.
 * Idempotent against a task that's already terminal (done/failed) — a cancelled task
 * whose generation finishes anyway must not resurrect assets the user already dismissed. */
export async function completeGenerationTask(input: CompleteTaskInput) {
  const [task] = await db.select().from(generationTask).where(eq(generationTask.id, input.taskId));
  if (!task) return { task: null, assets: [] };
  if (task.status === 'done' || task.status === 'failed') return { task, assets: [] };

  if (input.status === 'failed') {
    await db
      .update(generationTask)
      .set({ status: 'failed', error: input.error, finishedAt: new Date() })
      .where(eq(generationTask.id, input.taskId));
    return { task: { ...task, status: 'failed' as const, error: input.error }, assets: [] };
  }

  const prompt = task.params?.prompt;
  const assetType = task.kind === 't2v' || task.kind === 'i2v' || task.kind === 'v2v' ? 'video' : 'image';
  const reservedSlots = task.reservedSlots || [];
  const createdAssets = [];
  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i];
    const slotIndex = reservedSlots[i];
    const origin = slotIndex !== undefined ? originOf(slotIndex) : originOf(0);
    const size = fitInSlot(file.width, file.height);
    const [asset] = await db
      .insert(canvasAsset)
      .values({
        id: file.id,
        canvasId: task.canvasId,
        type: assetType,
        relPath: file.relPath,
        meta: {
          width: file.width,
          height: file.height,
          prompt,
          model: task.modelSlug ?? undefined,
          origin: input.assetOrigin,
          ...(file.durationSec !== undefined ? { durationSec: file.durationSec } : {}),
        },
        posX: origin.posX,
        posY: origin.posY,
        width: size.width,
        height: size.height,
        status: 'ready',
        createdByTask: input.taskId,
      })
      .returning();
    createdAssets.push(asset);
  }

  await db.update(generationTask).set({ status: 'done', finishedAt: new Date() }).where(eq(generationTask.id, input.taskId));

  return { task: { ...task, status: 'done' as const }, assets: createdAssets };
}
