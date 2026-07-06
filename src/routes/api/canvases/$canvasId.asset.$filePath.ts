/**
 * Canvas Agent (D5) — asset file serving.
 *
 * GET /api/canvases/:canvasId/asset/:filePath[?w=NNN]
 *
 * Mirrors src/routes/api/workspace/$sessionId.file.$filePath.ts's raw-serve branch, but
 * resolves the SHARED canvas workspace path (not a per-session one). Path construction
 * duplicates ws-server.mjs's getCanvasWorkspace()/sanitizeId() exactly — that's where
 * the files actually get written, so this must match byte-for-byte or lookups 404.
 * Image-only in this slice (no video Range streaming — see spec's M2-T4, deferred).
 *
 * `?w=` (perf fix, 2026-07-06): Gemini/Imagen outputs land at ~1024px+, several hundred
 * KB to ~2MB each — but canvas nodes display at ~280 CSS px (slot-fitted, see
 * slot-layout.ts). Decoding/compositing the FULL source for that tiny box is what made
 * dragging janky (measured: avg frame time went from ~8ms warm to 800ms+/max ~2000ms on
 * a fresh load with un-decoded images) — CSS scaling never reduces decode cost, only a
 * genuinely smaller source does. `w` resizes (fit:inside, no upscale) + re-encodes to
 * webp via sharp, cached same as the original. Ignored when `download=1` (always wants
 * the original bytes) or on non-raster extensions (gif thumbnails aren't worth the
 * complexity here).
 */

import { createFileRoute } from '@tanstack/react-router';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '~/db/db-config';
import { canvasWorkspace } from '~/db/schema';
import { requireUser } from '~/server/require-user';
import { validateRelativePath } from '~/server/security/validate-relative-path';
import { getCanvasWorkspacePath } from '~/server/canvas/workspace-path';

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const RESIZABLE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.webm']);
const MAX_THUMB_WIDTH = 1024; // guards against a client requesting an absurd/negative size

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream';
}

/** Parses a single-range `Range: bytes=START-END` header (the only form <video> sends). */
function parseRange(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  let start = startStr ? parseInt(startStr, 10) : 0;
  let end = endStr ? parseInt(endStr, 10) : fileSize - 1;
  if (!startStr && endStr) {
    // Suffix range: "bytes=-500" → last 500 bytes.
    start = Math.max(0, fileSize - parseInt(endStr, 10));
    end = fileSize - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= fileSize) return null;
  return { start, end };
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
        const searchParams = new URL(request.url).searchParams;
        const download = searchParams.get('download') === '1';
        const requestedWidth = Number(searchParams.get('w'));
        const thumbWidth =
          !download && RESIZABLE_EXTS.has(path.extname(filePath).toLowerCase()) && Number.isFinite(requestedWidth) && requestedWidth > 0
            ? Math.min(Math.round(requestedWidth), MAX_THUMB_WIDTH)
            : null;

        try {
          const stats = await stat(fullFilePath);
          if (!stats.isFile()) {
            return Response.json({ error: 'Path is not a file' }, { status: 400 });
          }

          const ext = path.extname(filePath).toLowerCase();
          if (VIDEO_EXTS.has(ext) && !download) {
            // Range support (M2-T4) — <video> seeking needs 206 partial responses; a
            // full readFile()-into-memory per request (fine for images) doesn't scale
            // to multi-MB/tens-of-MB video files, so this streams only the requested
            // byte window straight from disk.
            const contentType = getContentType(filePath);
            const rangeHeader = request.headers.get('range');
            const range = rangeHeader ? parseRange(rangeHeader, stats.size) : null;
            if (rangeHeader && !range) {
              return new Response(null, { status: 416, headers: { 'content-range': `bytes */${stats.size}` } });
            }
            const { start, end } = range ?? { start: 0, end: stats.size - 1 };
            const nodeStream = createReadStream(fullFilePath, { start, end });
            const headers = new Headers({
              'content-type': contentType,
              'accept-ranges': 'bytes',
              'content-length': String(end - start + 1),
              'cache-control': 'private, max-age=3600',
            });
            if (range) headers.set('content-range', `bytes ${start}-${end}/${stats.size}`);
            return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
              status: range ? 206 : 200,
              headers,
            });
          }

          let buffer = await readFile(fullFilePath);
          let contentType = getContentType(filePath);
          if (thumbWidth) {
            buffer = await sharp(buffer)
              .resize({ width: thumbWidth, withoutEnlargement: true })
              .webp({ quality: 82 })
              .toBuffer();
            contentType = 'image/webp';
          }
          const headers = new Headers({
            'content-type': contentType,
            'cache-control': 'private, max-age=3600',
          });
          if (download) {
            headers.set('content-disposition', `attachment; filename="${path.basename(filePath)}"`);
          }
          return new Response(buffer, { headers });
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
