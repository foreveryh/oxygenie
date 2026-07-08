/**
 * Canvas Agent (M3-T1d, F9.5) — upload an image (or video) straight onto the canvas.
 *
 * POST /api/canvases/:canvasId/upload
 *
 * Binary multipart body — can't be a Server Function (same REST exemption as the
 * workspace files upload route this mirrors: src/routes/api/workspace/$sessionId.files.ts).
 * Falls to `uploads/` inside the canvas workspace. There is no chokidar-based ingestor
 * in this codebase (confirmed absent — M1's spec assumed one, M1's actual implementation
 * registers assets via explicit DB writes at every producer instead: the agent path via
 * /api/internal/canvas/tasks/*, direct-gen via generation-processor.ts, and uploads
 * here) — so this route registers the canvas_asset row itself rather than relying on a
 * watcher to pick the file up.
 */

import { createFileRoute } from '@tanstack/react-router';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '~/db/db-config';
import { canvasWorkspace, canvasAsset } from '~/db/schema';
import { requireUser } from '~/server/require-user';
import { getCanvasWorkspacePath } from '~/server/canvas/workspace-path';
import { validateRelativePath } from '~/server/security/validate-relative-path';
import { CHAT_ATTACH_MAX_BYTES, isAllowedType, tooLargeMessage, unsupportedTypeMessage } from '~/lib/upload-limits';
import { assignSlots, fitInSlot } from '~/server/canvas/slot-layout';

// Spec §5.5: "复用 upload-limits.ts 白名单 + 50MB" — CHAT_ATTACH_MAX_BYTES is that 50MB
// constant (DOC_UPLOAD_MAX_BYTES is 100MB and is for the document/RAG upload path, not this one).
const MAX_UPLOAD_BYTES = CHAT_ATTACH_MAX_BYTES;
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export const Route = createFileRoute('/api/canvases/$canvasId/upload')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const user = await requireUser(request);
        const { canvasId } = params;

        const [workspace] = await db
          .select({ ownerUserId: canvasWorkspace.ownerUserId })
          .from(canvasWorkspace)
          .where(eq(canvasWorkspace.id, canvasId));
        if (!workspace || workspace.ownerUserId !== user.id) {
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }

        const declaredLength = Number(request.headers.get('content-length') ?? 0);
        if (declaredLength && declaredLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
          return Response.json({ error: tooLargeMessage(MAX_UPLOAD_BYTES, 'chat') }, { status: 413 });
        }

        const formData = await request.formData();
        const file = formData.get('file');
        if (!(file instanceof File) || !file.name) {
          return Response.json({ error: 'Missing file upload' }, { status: 400 });
        }
        if (!validateRelativePath(file.name)) {
          return Response.json({ error: 'Invalid file name' }, { status: 400 });
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          return Response.json({ error: tooLargeMessage(MAX_UPLOAD_BYTES, 'chat') }, { status: 413 });
        }
        if (!isAllowedType(file.name, file.type)) {
          return Response.json({ error: unsupportedTypeMessage(file.name) }, { status: 415 });
        }

        const ext = path.extname(file.name).toLowerCase();
        const isVideo = VIDEO_EXTS.has(ext);
        const isImage = IMAGE_EXTS.has(ext);
        if (!isVideo && !isImage) {
          // Passed the general upload-limits allowlist (e.g. a text/doc type) but isn't
          // a canvas media type — F9.5 is image/video upload specifically.
          return Response.json({ error: '仅支持图片或视频文件' }, { status: 415 });
        }

        const id = randomUUID();
        const relPath = path.join('uploads', `${id}${ext}`);
        const workspacePath = getCanvasWorkspacePath(user.id, canvasId);
        const fullPath = path.join(workspacePath, relPath);
        const buffer = Buffer.from(await file.arrayBuffer());

        try {
          await mkdir(path.dirname(fullPath), { recursive: true });
          await writeFile(fullPath, buffer);
        } catch (error) {
          console.error('[canvas upload] write failed:', error);
          return Response.json({ error: 'Failed to save file' }, { status: 500 });
        }

        // Image: probe real dimensions via sharp (same tool the asset-serving route
        // already depends on for thumbnails). Video: no ffprobe wired in this codebase
        // yet — default to a 16:9 landscape box; the <video> element itself renders at
        // its true aspect regardless of the canvas node's box size (video-node.tsx),
        // so this only affects initial slot sizing, not playback correctness.
        let width = 1280;
        let height = 720;
        if (isImage) {
          try {
            const meta = await sharp(buffer).metadata();
            if (meta.width && meta.height) {
              width = meta.width;
              height = meta.height;
            }
          } catch (error) {
            console.error('[canvas upload] sharp probe failed, using fallback dims:', error);
          }
        }

        const existingAssets = await db
          .select({ posX: canvasAsset.posX, posY: canvasAsset.posY })
          .from(canvasAsset)
          .where(and(eq(canvasAsset.canvasId, canvasId), isNull(canvasAsset.deletedAt)));
        const [slot] = assignSlots(1, existingAssets);
        const size = fitInSlot(width, height);

        const [asset] = await db
          .insert(canvasAsset)
          .values({
            id,
            canvasId,
            type: isVideo ? 'video' : 'image',
            relPath,
            meta: { width, height, origin: 'upload' },
            posX: slot.posX,
            posY: slot.posY,
            width: size.width,
            height: size.height,
            status: 'ready',
          })
          .returning();

        return Response.json({ asset });
      },
    },
  },
});
