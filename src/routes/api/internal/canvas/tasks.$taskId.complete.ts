/**
 * Canvas Agent (D5) — mark a generation_task done/failed and register its output
 * assets (consuming the slots reserved at task creation).
 *
 * POST /api/internal/canvas/tasks/:taskId/complete
 *
 * `files[].id` is the UUID the adapter already used as the filename stem (e.g.
 * `{uuid}.png`) — asset.id = filename, no separate id generation here (PRD §7:
 * mention-token/canvas-node/sandbox-file all share the same UUID). Width/height come
 * from the adapter's known generation params (requested aspect ratio), not server-side
 * file probing — see task notes on why `sharp` isn't wired up for this slice.
 *
 * `type` is derived from the task's `kind` (t2i/i2i → image; t2v/i2v/v2v → video), set
 * once at task-creation time (tasks.ts) — the completion payload never has to repeat it.
 */

import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { canvasWorkspace, generationTask } from '~/db/schema';
import { requireUser } from '~/server/require-user';
import { completeGenerationTask } from '~/server/canvas/task-orchestration';

export const Route = createFileRoute('/api/internal/canvas/tasks/$taskId/complete')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const user = await requireUser(request);
        const { taskId } = params;
        const body = await request.json();
        const { status, files, error } = body as {
          status: 'done' | 'failed';
          files?: Array<{ id: string; relPath: string; width: number; height: number; durationSec?: number }>;
          error?: string;
        };

        const [task] = await db.select().from(generationTask).where(eq(generationTask.id, taskId));
        if (!task) return Response.json({ error: 'task not found' }, { status: 404 });

        const [workspace] = await db
          .select({ ownerUserId: canvasWorkspace.ownerUserId })
          .from(canvasWorkspace)
          .where(eq(canvasWorkspace.id, task.canvasId));
        if (!workspace || workspace.ownerUserId !== user.id) {
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }

        const result =
          status === 'failed'
            ? await completeGenerationTask({ taskId, status: 'failed', error: error || 'generation failed' })
            : await completeGenerationTask({ taskId, status: 'done', files: files || [], assetOrigin: 'agent' });

        return Response.json(result);
      },
    },
  },
});
