'use client';

import { useEffect } from 'react';
import { onCanvasEvent, subscribeCanvas, unsubscribeCanvas } from '~/claude/adapters/ws-adapter';
import { useCanvasStore } from './canvas-store';
import type { CanvasAssetDTO } from '~/server/function/canvas.server';
import type { CanvasTask } from './canvas-store';

/**
 * Canvas Agent (D5) — subscribe to a canvas workspace's live event channel for the
 * lifetime of the component. Reconnect handling: the loader's initial snapshot is the
 * full-reload fallback (§6.3's "唯一真相源" note) — this hook only layers live deltas on
 * top, it never re-fetches on its own.
 */
export function useCanvasChannel(canvasId: string) {
  const upsertAsset = useCanvasStore((s) => s.upsertAsset);
  const upsertTask = useCanvasStore((s) => s.upsertTask);

  useEffect(() => {
    void subscribeCanvas(canvasId);
    const unsubscribe = onCanvasEvent((event, payload) => {
      switch (event) {
        case 'asset_created':
        case 'asset_updated':
          upsertAsset(payload as CanvasAssetDTO);
          break;
        case 'task_created':
          upsertTask(payload as CanvasTask);
          break;
        case 'task_updated': {
          const p = payload as { taskId: string; status: CanvasTask['status']; error?: string };
          upsertTask({ id: p.taskId, status: p.status, error: p.error });
          break;
        }
        default:
          break;
      }
    });
    return () => {
      unsubscribe();
      void unsubscribeCanvas(canvasId);
    };
  }, [canvasId, upsertAsset, upsertTask]);
}
