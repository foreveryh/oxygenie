/**
 * Canvas Workspace Lookup (Canvas Agent, D5)
 *
 * GET /api/canvases/:canvasId - Get a canvas workspace's ownership info.
 *
 * Owner-only (canvas_workspace has no member table, unlike Project). Used by ws-server
 * to validate `subscribe_canvas` requests and by handleCreateSession's caller before
 * arming a new session against a canvasId — never trust a client-supplied canvasId
 * without checking ownerUserId === requesting user (same rationale as the projectId
 * membership check in /api/agent-sessions).
 */

import { createFileRoute } from '@tanstack/react-router';
import { eq, isNull, and } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { canvasWorkspace } from '~/db/schema';
import { requireUser } from '~/server/require-user';

export const Route = createFileRoute('/api/canvases/$canvasId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const user = await requireUser(request);
        const { canvasId } = params;

        const [ws] = await db
          .select()
          .from(canvasWorkspace)
          .where(and(eq(canvasWorkspace.id, canvasId), isNull(canvasWorkspace.deletedAt)));

        if (!ws || ws.ownerUserId !== user.id) {
          return Response.json({ error: 'not found' }, { status: 404 });
        }

        return Response.json(ws);
      },
    },
  },
});
