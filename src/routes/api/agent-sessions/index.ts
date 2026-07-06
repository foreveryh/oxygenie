/**
 * Agent Sessions API
 *
 * GET /api/agent-sessions - List all sessions for current user
 * POST /api/agent-sessions - Create a new session (internal use by WS server)
 */

import { createFileRoute } from '@tanstack/react-router';
import { desc, eq, sql, and } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { agentSession, canvasWorkspace } from '~/db/schema';
import { requireUser } from '~/server/require-user';
import { accessibleProjectIds, visibleSessionsWhere, canAccessSession } from '~/server/projects/access';

export const Route = createFileRoute('/api/agent-sessions/')({
  validateSearch: (s) => ({
    page: Math.max(1, Number(s.page ?? 1)),
    limit: Math.max(1, Math.min(100, Number(s.limit ?? 20))),
  }),
  server: {
    handlers: {
      // GET /api/agent-sessions - List sessions
      GET: async ({ request }) => {
        const user = await requireUser(request);

        // Parse search params from URL (validateSearch doesn't run for direct API calls)
        const url = new URL(request.url);
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 20)));
        const offset = (page - 1) * limit;

        // Access via the single resolver, never a raw WHERE user_id: a user sees their
        // own loose (project-less) sessions plus every session in Projects they belong to.
        // `?scope=loose` restricts to loose chats only — the "最近" rail must not show
        // project sessions (those live inside their Project). visibleSessionsWhere(user, [])
        // is exactly the loose-own predicate.
        const scope = url.searchParams.get('scope');
        const accessibleIds = scope === 'loose' ? [] : await accessibleProjectIds(user.id);
        const visible = visibleSessionsWhere(user.id, accessibleIds);

        // Fetch sessions ordered by favorite first, then by updated_at
        const sessions = await db
          .select()
          .from(agentSession)
          .where(visible)
          .orderBy(
            desc(agentSession.favorite),
            desc(agentSession.updatedAt)
          )
          .limit(limit)
          .offset(offset);

        // Get total count for pagination
        const [countResult] = await db
          .select({ count: sql<number>`count(*)` })
          .from(agentSession)
          .where(visible);

        const total = Number(countResult?.count ?? 0);

        return Response.json({
          sessions,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      },

      // POST /api/agent-sessions - Create or update a session
      POST: async ({ request }) => {
        const user = await requireUser(request);

        const body = await request.json();
        const { sdkSessionId, claudeHomePath, title, realSdkSessionId, projectId, branchedFromSessionId, canvasId } = body as {
          sdkSessionId: string;
          claudeHomePath?: string;
          title?: string;
          realSdkSessionId?: string;
          projectId?: string;        // set on a branch create (lineage); membership-validated below
          branchedFromSessionId?: string;
          canvasId?: string;         // Canvas Agent (D5): single-owner workspace, ownership-validated below
        };

        if (!sdkSessionId) {
          return Response.json(
            { error: 'sdkSessionId is required' },
            { status: 400 }
          );
        }

        // Validate any lineage the client asks to stamp on a NEW session (branch create).
        // Never trust a client-supplied projectId/source — a non-member must not be able to
        // file a session into a project they can't access, or branch from a hidden session.
        let validProjectId: string | null = null;
        if (projectId) {
          const ids = await accessibleProjectIds(user.id);
          if (!ids.includes(projectId)) {
            return Response.json({ error: 'forbidden: not a member of that project' }, { status: 403 });
          }
          validProjectId = projectId;
        }
        let validBranchedFrom: string | null = null;
        if (branchedFromSessionId) {
          const [src] = await db
            .select({ userId: agentSession.userId, projectId: agentSession.projectId })
            .from(agentSession)
            .where(eq(agentSession.id, branchedFromSessionId));
          if (!src || !(await canAccessSession(user.id, src))) {
            return Response.json({ error: 'forbidden: cannot branch from that session' }, { status: 403 });
          }
          validBranchedFrom = branchedFromSessionId;
        }

        // Canvas workspace has no member table (single owner, D5) — validate ownership
        // directly rather than via accessibleProjectIds/canAccessSession.
        let validCanvasId: string | null = null;
        if (canvasId) {
          const [ws] = await db
            .select({ ownerUserId: canvasWorkspace.ownerUserId })
            .from(canvasWorkspace)
            .where(eq(canvasWorkspace.id, canvasId));
          if (!ws || ws.ownerUserId !== user.id) {
            return Response.json({ error: 'forbidden: not the owner of that canvas workspace' }, { status: 403 });
          }
          validCanvasId = canvasId;
        }

        // Check if session already exists
        const [existing] = await db
          .select({ id: agentSession.id })
          .from(agentSession)
          .where(
            and(
              eq(agentSession.userId, user.id),
              eq(agentSession.sdkSessionId, sdkSessionId)
            )
          );

        if (existing) {
          // Update existing session
          const updateData: Partial<{
            lastMessageAt: Date;
            updatedAt: Date;
            title: string;
            realSdkSessionId: string;
            claudeHomePath: string;
          }> = {
            lastMessageAt: new Date(),
            updatedAt: new Date(),
          };

          if (title) {
            updateData.title = title;
          }
          if (realSdkSessionId) {
            updateData.realSdkSessionId = realSdkSessionId;
          }
          if (claudeHomePath) {
            updateData.claudeHomePath = claudeHomePath;
          }

          await db
            .update(agentSession)
            .set(updateData)
            .where(eq(agentSession.id, existing.id));

          return Response.json({ id: existing.id, created: false });
        }

        // Create new session
        const [inserted] = await db
          .insert(agentSession)
          .values({
            userId: user.id,
            sdkSessionId,
            realSdkSessionId: realSdkSessionId || null,
            claudeHomePath: claudeHomePath || null,
            title: title || null,
            projectId: validProjectId,
            branchedFromSessionId: validBranchedFrom,
            canvasId: validCanvasId,
          })
          .returning({ id: agentSession.id });

        return Response.json({ id: inserted.id, created: true });
      },
    },
  },
});
