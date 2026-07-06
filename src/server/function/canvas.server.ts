/**
 * Canvas Agent Server Functions (D5 — independent top-level entity, not a Project)
 *
 * `canvas_workspace` is single-owner; every function here just checks
 * `ownerUserId === current user`, no member resolver needed (unlike projects/access.ts).
 */

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '~/db/db-config';
import { canvasWorkspace, canvasAsset, type CanvasAssetMeta } from '~/db/schema';
import { auth } from '~/server/auth.server';

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
