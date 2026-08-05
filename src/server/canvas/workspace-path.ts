/**
 * Canvas Agent (D5) — shared workspace path resolution for the TS/app side.
 *
 * Duplicates ws-server.mjs's getCanvasWorkspace()/sanitizeId() exactly (that JS file
 * can't import this — plain node process, no TS loader, see build-worker-env.js's
 * header comment) — this must match byte-for-byte or file lookups 404. Factored out
 * here so the TS side (asset-serving route, deleteAssets) has exactly one copy instead
 * of growing a third inline duplicate.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

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

export function getCanvasWorkspacePath(userId: string, canvasId: string): string {
  return path.join(resolveSessionsRoot(), sanitizeId(userId), 'canvases', sanitizeId(canvasId), 'workspace');
}
