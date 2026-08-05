/**
 * Canvas Agent (M3-T1) — direct-gen task processor.
 *
 * Shared by the inline fallback (called synchronously from directGenerate when there's
 * no Redis) and the bullmq worker (src/worker/index.ts's canvas-gen Worker). Unlike the
 * agent path (ws-query-worker.mjs, a plain-JS child process with no drizzle access —
 * see workspace-path.ts's header comment), both callers of this module run inside the
 * TanStack app/worker's own Node process and can hit the DB directly: no HTTP round
 * trip to /api/internal/canvas/tasks needed here, just the shared orchestration
 * functions.
 */

import { eq } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { generationTask, canvasWorkspace, canvasAsset } from '~/db/schema';
import { getCanvasWorkspacePath } from '~/server/canvas/workspace-path';
import { completeGenerationTask } from '~/server/canvas/task-orchestration';
import { generateMedia } from '~/claude/media-gen/adapter-registry';
import { validateMediaInput } from '~/claude/media-gen/media-capabilities';
import { resolveMediaRoute } from '~/server/models/media-route';
import path from 'node:path';
import { stat } from 'node:fs/promises';

/** Run one direct-gen task end to end: load it, resolve the frozen media route, call
 * its installed adapter, and record
 * the result. Never throws — failures are recorded on the task row (completeGenerationTask
 * with status 'failed'), matching the agent path's error-handling contract so the client
 * sees the same shape regardless of which path produced the task. */
export async function processCanvasGenerationTask(taskId: string): Promise<void> {
  const [task] = await db.select().from(generationTask).where(eq(generationTask.id, taskId));
  if (!task) {
    console.error('[canvas-gen-processor] task not found:', taskId);
    return;
  }
  // Cancelled while queued (removeCanvasGenerationJob couldn't reach an already-dequeued
  // inline run) — completeGenerationTask's own terminal-state guard would also catch
  // this, but skip the (costly, billable) generation call entirely when we can.
  if (task.status !== 'running') return;

  const [workspace] = await db
    .select({ ownerUserId: canvasWorkspace.ownerUserId })
    .from(canvasWorkspace)
    .where(eq(canvasWorkspace.id, task.canvasId));
  if (!workspace) {
    await completeGenerationTask({ taskId, status: 'failed', error: 'canvas workspace not found' });
    return;
  }

  const outputDir = path.join(getCanvasWorkspacePath(workspace.ownerUserId, task.canvasId));
  const params = task.params || {};
  const prompt = params.prompt || '';

  try {
    if (task.kind === 't2i' || task.kind === 'i2i') {
      const route = await resolveMediaRoute('image', task.modelSlug);
      const input = { prompt, count: params.count, aspect: params.aspect };
      validateMediaInput({ capability: 'image', route, input });
      const result = await generateMedia({
        capability: 'image',
        route,
        input,
        outputDir,
      });
      await completeGenerationTask({ taskId, status: 'done', files: result.files, assetOrigin: 'direct' });
    } else if (task.kind === 't2v' || task.kind === 'i2v' || task.kind === 'v2v') {
      // New tasks freeze semantic roles in params.references. Legacy tasks only have
      // inputAssetIds and retain their original first-image/last-image interpretation.
      const taskReferences = params.references?.length
        ? params.references
        : (task.inputAssetIds || []).slice(0, 2).map((assetId, order) => ({
            assetId,
            mediaType: 'image' as const,
            role: order === 0 ? 'first_frame' as const : 'last_frame' as const,
            order,
          }));
      const references = await Promise.all(taskReferences.map(async (reference) => {
        const [asset] = await db
          .select({ canvasId: canvasAsset.canvasId, type: canvasAsset.type, relPath: canvasAsset.relPath, meta: canvasAsset.meta })
          .from(canvasAsset)
          .where(eq(canvasAsset.id, reference.assetId));
        if (!asset || asset.canvasId !== task.canvasId || !asset.relPath) {
          throw new Error(`Reference asset ${reference.assetId} is missing from this canvas`);
        }
        if (asset.type !== reference.mediaType) {
          throw new Error(`Reference asset ${reference.assetId} changed media type`);
        }
        const fullPath = path.join(outputDir, asset.relPath);
        const fileStat = await stat(fullPath);
        return {
          ...reference,
          path: fullPath,
          sizeBytes: fileStat.size,
          ...(asset.meta?.durationSec !== undefined ? { durationSec: asset.meta.durationSec } : {}),
        };
      }));
      const imagePath = references.find((reference) => reference.role === 'first_frame')?.path;
      const lastImagePath = references.find((reference) => reference.role === 'last_frame')?.path;
      const route = await resolveMediaRoute('video', task.modelSlug);
      const input = {
        prompt,
        mode: params.mode,
        references,
        imagePath,
        lastImagePath,
        aspect: params.aspect,
        durationSeconds: params.durationSec,
        resolution: params.resolution,
      };
      validateMediaInput({ capability: 'video', route, input });
      const result = await generateMedia({
        capability: 'video',
        route,
        input,
        outputDir,
      });
      await completeGenerationTask({ taskId, status: 'done', files: result.files, assetOrigin: 'direct' });
    } else {
      await completeGenerationTask({ taskId, status: 'failed', error: `unsupported kind for direct-gen: ${task.kind}` });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[canvas-gen-processor] generation failed:', taskId, message);
    await completeGenerationTask({ taskId, status: 'failed', error: message });
  }
}
