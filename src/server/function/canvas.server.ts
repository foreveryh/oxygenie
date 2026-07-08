/**
 * Canvas Agent Server Functions (D5 — independent top-level entity, not a Project)
 *
 * `canvas_workspace` is single-owner; every function here just checks
 * `ownerUserId === current user`, no member resolver needed (unlike projects/access.ts).
 */

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { db } from '~/db/db-config';
import { canvasWorkspace, canvasAsset, generationTask, type CanvasAssetMeta } from '~/db/schema';
import { auth } from '~/server/auth.server';
import { getCanvasWorkspacePath } from '~/server/canvas/workspace-path';
import { createGenerationTask } from '~/server/canvas/task-orchestration';
import { scheduleCanvasGeneration, removeCanvasGenerationJob } from '~/server/canvas/generation-queue';
import { processCanvasGenerationTask } from '~/server/canvas/generation-processor';
import { assertWithinDailyQuota, GenQuotaExceededError } from '~/server/canvas/quota';

/** D2: text nodes mirror to `notes/{assetId}.md` in the sandbox — this marker line lets
 * a future watcher (or the Agent itself) tell a canvas text note apart from an arbitrary
 * markdown file it wrote for its own purposes. */
const TEXT_NODE_MARKER = '<!-- kin-canvas-text -->';

function textNodeRelPath(assetId: string): string {
  return path.join('notes', `${assetId}.md`);
}

async function writeTextNodeFile(userId: string, canvasId: string, assetId: string, content: string): Promise<void> {
  const relPath = textNodeRelPath(assetId);
  const fullPath = path.join(getCanvasWorkspacePath(userId, canvasId), relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${TEXT_NODE_MARKER}\n${content}`, 'utf8');
}

const requireUser = async () => {
  const { headers } = getRequest();
  const session = await auth.api.getSession({ headers });
  if (!session?.user) throw new Error('UNAUTHORIZED');
  return session.user;
};

export interface CanvasWorkspaceDTO {
  id: string;
  name: string;
  createdAt: string;
}

export interface CanvasAssetDTO {
  id: string;
  canvasId: string;
  type: 'image' | 'video' | 'text';
  relPath: string | null;
  meta: CanvasAssetMeta;
  posX: number;
  posY: number;
  width: number;
  height: number;
  status: 'placeholder' | 'generating' | 'ready';
  createdAt: string;
}

/** All non-deleted canvas workspaces owned by the current user, newest first. */
export const listCanvasWorkspaces = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CanvasWorkspaceDTO[]> => {
    const u = await requireUser();
    const rows = await db
      .select()
      .from(canvasWorkspace)
      .where(and(eq(canvasWorkspace.ownerUserId, u.id), isNull(canvasWorkspace.deletedAt)))
      .orderBy(desc(canvasWorkspace.createdAt));
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString() }));
  }
);

/** A single canvas workspace (owner-only; else NOT_FOUND — never leak existence to non-owners). */
export const getCanvasWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ canvasId: z.string().uuid() }))
  .handler(async ({ data }): Promise<CanvasWorkspaceDTO> => {
    const u = await requireUser();
    const [row] = await db
      .select()
      .from(canvasWorkspace)
      .where(and(eq(canvasWorkspace.id, data.canvasId), eq(canvasWorkspace.ownerUserId, u.id), isNull(canvasWorkspace.deletedAt)));
    if (!row) throw new Error('NOT_FOUND');
    return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
  });

/** Create a new canvas workspace (owner = current user). No member/sharing concept (D5). */
export const createCanvasWorkspace = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ name: z.string().min(1).max(100) }))
  .handler(async ({ data }): Promise<CanvasWorkspaceDTO> => {
    const u = await requireUser();
    const [row] = await db
      .insert(canvasWorkspace)
      .values({ ownerUserId: u.id, name: data.name })
      .returning();
    return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
  });

/** All non-deleted assets on a canvas workspace (owner-only). Full reload for the canvas loader / reconnect. */
export const listCanvasAssets = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ canvasId: z.string().uuid() }))
  .handler(async ({ data }): Promise<CanvasAssetDTO[]> => {
    const u = await requireUser();
    const [workspace] = await db
      .select({ ownerUserId: canvasWorkspace.ownerUserId })
      .from(canvasWorkspace)
      .where(eq(canvasWorkspace.id, data.canvasId));
    if (!workspace || workspace.ownerUserId !== u.id) throw new Error('FORBIDDEN');

    const rows = await db
      .select()
      .from(canvasAsset)
      .where(and(eq(canvasAsset.canvasId, data.canvasId), isNull(canvasAsset.deletedAt)))
      .orderBy(canvasAsset.createdAt);
    return rows.map((r) => ({
      id: r.id,
      canvasId: r.canvasId,
      type: r.type,
      relPath: r.relPath,
      meta: r.meta ?? {},
      posX: r.posX,
      posY: r.posY,
      width: r.width,
      height: r.height,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  });

/** Persist a dragged/resized asset's canvas position (frontend debounces this call). */
export const updateAssetPos = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      assetId: z.string().uuid(),
      posX: z.number(),
      posY: z.number(),
      width: z.number().optional(),
      height: z.number().optional(),
    })
  )
  .handler(async ({ data }): Promise<{ success: true }> => {
    const u = await requireUser();
    const [row] = await db
      .select({ canvasId: canvasAsset.canvasId })
      .from(canvasAsset)
      .where(eq(canvasAsset.id, data.assetId));
    if (!row) throw new Error('NOT_FOUND');
    const [workspace] = await db
      .select({ ownerUserId: canvasWorkspace.ownerUserId })
      .from(canvasWorkspace)
      .where(eq(canvasWorkspace.id, row.canvasId));
    if (!workspace || workspace.ownerUserId !== u.id) throw new Error('FORBIDDEN');

    await db
      .update(canvasAsset)
      .set({
        posX: data.posX,
        posY: data.posY,
        ...(data.width !== undefined && { width: data.width }),
        ...(data.height !== undefined && { height: data.height }),
      })
      .where(eq(canvasAsset.id, data.assetId));
    return { success: true };
  });

/**
 * Delete assets from the canvas (D1: soft-delete DB row + unlink sandbox file). Single
 * fn handles both the F4 single-select 🗑 and multi-select batch delete — the button set
 * is identical, only the count differs.
 */
export const deleteAssets = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ assetIds: z.array(z.string().uuid()).min(1) }))
  .handler(async ({ data }): Promise<{ success: true }> => {
    const u = await requireUser();

    const rows = await db
      .select({ id: canvasAsset.id, canvasId: canvasAsset.canvasId, relPath: canvasAsset.relPath })
      .from(canvasAsset)
      .where(and(inArray(canvasAsset.id, data.assetIds), isNull(canvasAsset.deletedAt)));
    if (rows.length === 0) return { success: true };

    // Reject the whole batch unless every asset belongs to a workspace this user owns —
    // simpler and safer than partial success across a mixed-ownership request.
    const canvasIds = [...new Set(rows.map((r) => r.canvasId))];
    const workspaces = await db
      .select({ id: canvasWorkspace.id, ownerUserId: canvasWorkspace.ownerUserId })
      .from(canvasWorkspace)
      .where(inArray(canvasWorkspace.id, canvasIds));
    const ownedIds = new Set(workspaces.filter((w) => w.ownerUserId === u.id).map((w) => w.id));
    if (!canvasIds.every((id) => ownedIds.has(id))) throw new Error('FORBIDDEN');

    await db
      .update(canvasAsset)
      .set({ deletedAt: new Date() })
      .where(inArray(canvasAsset.id, rows.map((r) => r.id)));

    // Best-effort unlink — a missing file (already gone, or an asset row with no
    // relPath) must not fail the delete; the DB soft-delete is the source of truth.
    await Promise.all(
      rows
        .filter((r) => r.relPath)
        .map((r) =>
          unlink(path.join(getCanvasWorkspacePath(u.id, r.canvasId), r.relPath as string)).catch(() => {})
        )
    );

    return { success: true };
  });

/**
 * F9.4: create a text node at a clicked canvas position (not slot-assigned like
 * generated media — the user picks where it lands). Mirrors to `notes/{id}.md` (D2) so
 * the Agent can `ls`/read it as a real sandbox file; the DB row (meta.text) is what the
 * canvas and the composer reference block actually render from.
 */
export const createTextNode = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      canvasId: z.string().uuid(),
      posX: z.number(),
      posY: z.number(),
      content: z.string().max(10_000).optional(),
    })
  )
  .handler(async ({ data }): Promise<CanvasAssetDTO> => {
    const u = await requireUser();
    const [workspace] = await db
      .select({ ownerUserId: canvasWorkspace.ownerUserId })
      .from(canvasWorkspace)
      .where(eq(canvasWorkspace.id, data.canvasId));
    if (!workspace || workspace.ownerUserId !== u.id) throw new Error('FORBIDDEN');

    const id = randomUUID();
    const content = data.content ?? '';
    const meta: CanvasAssetMeta = { text: { content, align: 'left', fontSize: 16 } };

    await writeTextNodeFile(u.id, data.canvasId, id, content);

    const [row] = await db
      .insert(canvasAsset)
      .values({
        id,
        canvasId: data.canvasId,
        type: 'text',
        relPath: textNodeRelPath(id),
        meta,
        posX: data.posX,
        posY: data.posY,
        width: 240,
        height: 120,
        status: 'ready',
      })
      .returning();

    return {
      id: row.id,
      canvasId: row.canvasId,
      type: row.type,
      relPath: row.relPath,
      meta: row.meta ?? {},
      posX: row.posX,
      posY: row.posY,
      width: row.width,
      height: row.height,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  });

/** Update a text node's content/formatting (debounced ~500ms on the frontend). Keeps the
 * mirrored `notes/{id}.md` file in sync (D2 — Agent-visible, always current). */
export const updateTextNode = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      assetId: z.string().uuid(),
      content: z.string().max(10_000),
      color: z.string().max(32).optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      fontSize: z.number().min(8).max(96).optional(),
    })
  )
  .handler(async ({ data }): Promise<{ success: true }> => {
    const u = await requireUser();
    const [row] = await db
      .select({ canvasId: canvasAsset.canvasId, type: canvasAsset.type, meta: canvasAsset.meta })
      .from(canvasAsset)
      .where(eq(canvasAsset.id, data.assetId));
    if (!row) throw new Error('NOT_FOUND');
    if (row.type !== 'text') throw new Error('NOT_A_TEXT_NODE');
    const [workspace] = await db
      .select({ ownerUserId: canvasWorkspace.ownerUserId })
      .from(canvasWorkspace)
      .where(eq(canvasWorkspace.id, row.canvasId));
    if (!workspace || workspace.ownerUserId !== u.id) throw new Error('FORBIDDEN');

    const prevText = row.meta?.text;
    const meta: CanvasAssetMeta = {
      ...row.meta,
      text: {
        content: data.content,
        color: data.color ?? prevText?.color,
        align: data.align ?? prevText?.align ?? 'left',
        fontSize: data.fontSize ?? prevText?.fontSize ?? 16,
      },
    };

    await writeTextNodeFile(u.id, row.canvasId, data.assetId, data.content);
    await db.update(canvasAsset).set({ meta }).where(eq(canvasAsset.id, data.assetId));

    return { success: true };
  });

export interface GenerationTaskDTO {
  id: string;
  canvasId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  kind: string;
  error: string | null;
}

/**
 * F9.2/9.3/9.5: direct-gen — the manual generation path (parallel to the Agent tool
 * path), queued via bullmq so a minutes-long video call never occupies the request
 * (impl spec §5.5). Returns immediately with a taskId; the client polls
 * getGenerationTask until it's done/failed (no cross-process push from the worker back
 * to ws-server's canvas WS channel — see generation-queue.ts's header comment).
 */
export const directGenerate = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      canvasId: z.string().uuid(),
      kind: z.enum(['t2i', 'i2i', 't2v', 'i2v']),
      prompt: z.string().min(1).max(2000),
      count: z.number().int().min(1).max(4).optional(),
      aspect: z.string().max(16).optional(),
      resolution: z.string().max(16).optional(),
      durationSec: z.number().min(1).max(60).optional(),
      inputAssetIds: z.array(z.string().uuid()).max(4).optional(),
    })
  )
  .handler(async ({ data }): Promise<{ taskId: string; reservedPositions: { posX: number; posY: number }[] }> => {
    const u = await requireUser();
    const [workspace] = await db
      .select({ ownerUserId: canvasWorkspace.ownerUserId })
      .from(canvasWorkspace)
      .where(eq(canvasWorkspace.id, data.canvasId));
    if (!workspace || workspace.ownerUserId !== u.id) throw new Error('FORBIDDEN');

    try {
      await assertWithinDailyQuota(u.id, data.kind);
    } catch (error) {
      if (error instanceof GenQuotaExceededError) throw new Error(error.message);
      throw error;
    }

    const { task, reservedPositions } = await createGenerationTask({
      canvasId: data.canvasId,
      origin: 'direct',
      kind: data.kind,
      params: {
        prompt: data.prompt,
        count: data.count,
        aspect: data.aspect,
        resolution: data.resolution,
        durationSec: data.durationSec,
      },
    });

    if (data.inputAssetIds?.length) {
      await db.update(generationTask).set({ inputAssetIds: data.inputAssetIds }).where(eq(generationTask.id, task.id));
    }

    await scheduleCanvasGeneration(task.id, processCanvasGenerationTask);

    // Returned so the client can immediately show a placeholder at the right spot
    // (reusing canvas-store's existing task-placeholder rendering, same as the agent
    // path's task_created WS event) instead of waiting for the first poll.
    return { taskId: task.id, reservedPositions };
  });

/** Poll target for direct-gen (and, incidentally, agent-origin tasks too — same table).
 * Returns the current task status; assets are included once status is 'done' so the
 * caller doesn't need a second round trip. */
export const getGenerationTask = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ taskId: z.string().uuid() }))
  .handler(async ({ data }): Promise<{ task: GenerationTaskDTO; assets: CanvasAssetDTO[] }> => {
    const u = await requireUser();
    const [task] = await db.select().from(generationTask).where(eq(generationTask.id, data.taskId));
    if (!task) throw new Error('NOT_FOUND');
    const [workspace] = await db
      .select({ ownerUserId: canvasWorkspace.ownerUserId })
      .from(canvasWorkspace)
      .where(eq(canvasWorkspace.id, task.canvasId));
    if (!workspace || workspace.ownerUserId !== u.id) throw new Error('FORBIDDEN');

    let assets: CanvasAssetDTO[] = [];
    if (task.status === 'done') {
      const rows = await db.select().from(canvasAsset).where(eq(canvasAsset.createdByTask, task.id));
      assets = rows.map((r) => ({
        id: r.id,
        canvasId: r.canvasId,
        type: r.type,
        relPath: r.relPath,
        meta: r.meta ?? {},
        posX: r.posX,
        posY: r.posY,
        width: r.width,
        height: r.height,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      }));
    }

    return {
      task: { id: task.id, canvasId: task.canvasId, status: task.status, kind: task.kind, error: task.error },
      assets,
    };
  });

/** Best-effort cancel: removes the bullmq job if still queued and marks the task
 * failed immediately so the UI stops waiting. A job already running can't be aborted
 * mid-flight (the Gemini adapters don't take an AbortSignal today) — its eventual
 * result is discarded by completeGenerationTask's terminal-state guard rather than
 * resurrecting assets the user already dismissed. */
export const cancelTask = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ taskId: z.string().uuid() }))
  .handler(async ({ data }): Promise<{ success: true }> => {
    const u = await requireUser();
    const [task] = await db.select().from(generationTask).where(eq(generationTask.id, data.taskId));
    if (!task) throw new Error('NOT_FOUND');
    const [workspace] = await db
      .select({ ownerUserId: canvasWorkspace.ownerUserId })
      .from(canvasWorkspace)
      .where(eq(canvasWorkspace.id, task.canvasId));
    if (!workspace || workspace.ownerUserId !== u.id) throw new Error('FORBIDDEN');

    if (task.status === 'queued' || task.status === 'running') {
      await removeCanvasGenerationJob(task.id);
      await db
        .update(generationTask)
        .set({ status: 'failed', error: 'cancelled by user', finishedAt: new Date() })
        .where(eq(generationTask.id, task.id));
    }

    return { success: true };
  });
