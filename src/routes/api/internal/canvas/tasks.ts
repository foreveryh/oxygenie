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
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { canvasWorkspace, canvasAsset, generationTask } from '~/db/schema';
import { requireUser } from '~/server/require-user';
import { assignSlots, slotOf, originOf, type Pos } from '~/server/canvas/slot-layout';

export const Route = createFileRoute('/api/internal/canvas/tasks')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await requireUser(request);
        const body = await request.json();
        const { canvasId, sessionId, kind, params } = body as {
          canvasId: string;
          sessionId?: string;
          kind: 't2i' | 'i2i' | 't2v' | 'i2v' | 'v2v';
          params?: { prompt?: string; count?: number; aspect?: string; resolution?: string; durationSec?: number };
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

        const count = Math.max(1, params?.count ?? 1);

        // Existing occupied positions: ready/generating assets + slots already reserved
        // by other running tasks (so two concurrent generations don't pick the same
        // spot). Not wrapped in a transaction/row lock — a v1-acceptable race (worst
        // case: two tasks land visually adjacent-but-overlapping; the spec's own
        // "reconcile, don't block" philosophy applies here too).
        const existingAssets = await db
          .select({ posX: canvasAsset.posX, posY: canvasAsset.posY })
          .from(canvasAsset)
          .where(and(eq(canvasAsset.canvasId, canvasId), isNull(canvasAsset.deletedAt)));
        const runningTasks = await db
          .select({ reservedSlots: generationTask.reservedSlots })
          .from(generationTask)
          .where(and(eq(generationTask.canvasId, canvasId), eq(generationTask.status, 'running')));

        const reservedFromRunning: Pos[] = runningTasks.flatMap((t) =>
          (t.reservedSlots || []).map((idx) => originOf(idx))
        );
        const occupied: Pos[] = [...existingAssets, ...reservedFromRunning];

        const slots = assignSlots(count, occupied);
        const reservedSlotIndices = slots.map((s) => slotOf(s));

        const [task] = await db
          .insert(generationTask)
          .values({
            canvasId,
            sessionId: sessionId || null,
            origin: 'agent',
            kind,
            params: params || {},
            reservedSlots: reservedSlotIndices,
            status: 'running',
          })
          .returning();

        return Response.json({ ...task, reservedPositions: slots });
      },
    },
  },
});
