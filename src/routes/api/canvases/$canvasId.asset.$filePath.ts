/**
 * Canvas Agent (D5) — asset file serving.
 *
 * GET /api/canvases/:canvasId/asset/:filePath
 *
 * Mirrors src/routes/api/workspace/$sessionId.file.$filePath.ts's raw-serve branch, but
 * resolves the SHARED canvas workspace path (not a per-session one). Path construction
 * duplicates ws-server.mjs's getCanvasWorkspace()/sanitizeId() exactly — that's where
 * the files actually get written, so this must match byte-for-byte or lookups 404.
 * Image-only in this slice (no video Range streaming — see spec's M2-T4, deferred).
 */

import { createFileRoute } from '@tanstack/react-router';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { canvasWorkspace } from '~/db/schema';
import { requireUser } from '~/server/require-user';
import { validateRelativePath } from '~/server/security/validate-relative-path';

function sanitizeId(id: string): string {
  return id.replace(/[/\\.]+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function resolveSessionsRoot(): string {
  const envRoot = process.env.CLAUDE_SESSIONS_ROOT;
  if (envRoot && envRoot.trim()) return path.resolve(envRoot.trim());
  const dockerPath = '/data/users';
  if (existsSync(dockerPath)) return dockerPath;
  return path.join(process.cwd(), 'user-data');
}

function getCanvasWorkspacePath(userId: string, canvasId: string): string {
  return path.join(resolveSessionsRoot(), sanitizeId(userId), 'canvases', sanitizeId(canvasId), 'workspace');
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream';
}

function resolveFilePathFromRequest(request: Request, canvasId: string, fallback: string): string {
  try {
    const url = new URL(request.url);
    const prefix = `/api/canvases/${canvasId}/asset/`;
    if (url.pathname.startsWith(prefix)) {
      const remainder = url.pathname.slice(prefix.length).replace(/^\/+/, '');
      if (remainder) {
        try {
          return decodeURIComponent(remainder);
        } catch {
          return remainder;
        }
      }
    }
  } catch {
    // fall through to route param
  }
  return fallback;
}

export const Route = createFileRoute('/api/canvases/$canvasId/asset/$filePath')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const user = await requireUser(request);
        const { canvasId, filePath: rawFilePath } = params;
        const filePath = resolveFilePathFromRequest(request, canvasId, rawFilePath);

        if (!validateRelativePath(filePath)) {
          return Response.json({ error: 'Invalid file path' }, { status: 400 });
        }

        const [workspace] = await db
          .select({ ownerUserId: canvasWorkspace.ownerUserId })
          .from(canvasWorkspace)
          .where(eq(canvasWorkspace.id, canvasId));
        if (!workspace || workspace.ownerUserId !== user.id) {
          return Response.json({ error: 'not found' }, { status: 404 });
        }

        const fullFilePath = path.join(getCanvasWorkspacePath(user.id, canvasId), filePath);

        try {
          const stats = await stat(fullFilePath);
          if (!stats.isFile()) {
            return Response.json({ error: 'Path is not a file' }, { status: 400 });
          }
          const buffer = await readFile(fullFilePath);
          return new Response(buffer, {
            headers: { 'content-type': getContentType(filePath), 'cache-control': 'private, max-age=3600' },
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return Response.json({ error: 'File not found' }, { status: 404 });
          }
          console.error('[Canvas Asset API] Error reading file:', error);
          return Response.json({ error: 'Failed to read file' }, { status: 500 });
        }
      },
    },
  },
});
