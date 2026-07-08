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
import { generateImage } from '~/claude/media-gen/gemini-image-runner';
import { generateVideo } from '~/claude/media-gen/gemini-video-runner';
import path from 'node:path';

/** Run one direct-gen task end to end: load it, call the right Gemini adapter, record
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
      const result = await generateImage({
        prompt,
        count: params.count,
        aspect: params.aspect,
        outputDir,
      });
      await completeGenerationTask({ taskId, status: 'done', files: result.files, assetOrigin: 'direct' });
    } else if (task.kind === 't2v' || task.kind === 'i2v') {
      // inputAssetIds stores asset UUIDs (F9.3: "select one or more image nodes to
      // animate"), not filenames — resolve the reference asset's relPath before
      // building the on-disk path (mirrors the agent path's imageRelPath, which the
      // Agent already has because it can `ls`; direct-gen only has the asset id).
      let imagePath: string | undefined;
      const refAssetId = task.inputAssetIds?.[0];
      if (refAssetId) {
        const [refAsset] = await db.select({ relPath: canvasAsset.relPath }).from(canvasAsset).where(eq(canvasAsset.id, refAssetId));
        if (refAsset?.relPath) imagePath = path.join(outputDir, refAsset.relPath);
      }
      const result = await generateVideo({
        prompt,
        imagePath,
        aspect: params.aspect,
        durationSeconds: params.durationSec,
        resolution: params.resolution,
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
