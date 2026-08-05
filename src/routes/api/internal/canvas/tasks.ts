/**
 * Canvas Agent (D5) — generation_task creation + slot reservation.
 *
 * POST /api/internal/canvas/tasks
 *
 * Called by ws-server.mjs when the worker emits a `media_gen_task_started` frame (it
 * has no direct DB access — see build-worker-env.js's "plain JS" comment — so this
 * TS/drizzle-capable route does the write on its behalf, authenticated with the
 * requesting user's cookie).
 */

import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { canvasWorkspace, type GenerationTaskParams } from '~/db/schema';
import { requireUser } from '~/server/require-user';
import { createGenerationTask } from '~/server/canvas/task-orchestration';

export const Route = createFileRoute('/api/internal/canvas/tasks')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await requireUser(request);
        const body = await request.json();
        const { canvasId, sessionId, kind, modelSlug, params } = body as {
          canvasId: string;
          sessionId?: string;
          kind: 't2i' | 'i2i' | 't2v' | 'i2v' | 'v2v';
          modelSlug?: string | null;
          params?: GenerationTaskParams;
        };

        if (!canvasId || !kind) {
          return Response.json({ error: 'canvasId and kind are required' }, { status: 400 });
        }

        const [workspace] = await db
          .select({ ownerUserId: canvasWorkspace.ownerUserId })
          .from(canvasWorkspace)
          .where(eq(canvasWorkspace.id, canvasId));
        if (!workspace || workspace.ownerUserId !== user.id) {
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }

        // Slot reservation is not wrapped in a transaction/row lock — a v1-acceptable
        // race (worst case: two tasks land visually adjacent-but-overlapping; the
        // spec's own "reconcile, don't block" philosophy applies here too).
        const { task, reservedPositions } = await createGenerationTask({
          canvasId,
          sessionId,
          origin: 'agent',
          kind,
          modelSlug,
          params,
        });

        return Response.json({ ...task, reservedPositions });
      },
    },
  },
});
