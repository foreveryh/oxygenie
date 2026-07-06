import { create } from 'zustand';
import type { CanvasAssetDTO } from '~/server/function/canvas.server';

export interface CanvasTask {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  reservedPositions?: Array<{ posX: number; posY: number }>;
  params?: { prompt?: string; count?: number; aspect?: string };
  kind?: string;
  error?: string;
}

interface CanvasState {
  assets: Record<string, CanvasAssetDTO>;
  tasks: Record<string, CanvasTask>;
  // F10.1/§6.3: selection lives here as the single source of truth — xyflow's own
  // node.selected is a projection of this (set via onSelectionChange), not the other
  // way around. Full chip sync (F10.2) is a later addition; this is the foundation.
  selectedAssetIds: string[];
  setInitialAssets: (assets: CanvasAssetDTO[]) => void;
  upsertAsset: (asset: CanvasAssetDTO) => void;
  upsertTask: (task: CanvasTask) => void;
  removeTask: (taskId: string) => void;
  setSelectedAssetIds: (ids: string[]) => void;
}

/**
 * Canvas Agent (D5) store — single source of truth for what's on the canvas. Populated
 * by the loader's initial snapshot + live canvas_event frames (use-canvas-channel.ts).
 */
export const useCanvasStore = create<CanvasState>((set) => ({
  assets: {},
  tasks: {},
  selectedAssetIds: [],
  setInitialAssets: (assets) =>
    set({ assets: Object.fromEntries(assets.map((a) => [a.id, a])) }),
  upsertAsset: (asset) =>
    set((s) => ({ assets: { ...s.assets, [asset.id]: asset } })),
  upsertTask: (task) =>
    set((s) => ({ tasks: { ...s.tasks, [task.id]: { ...s.tasks[task.id], ...task } } })),
  removeTask: (taskId) =>
    set((s) => {
      const { [taskId]: _removed, ...rest } = s.tasks;
      return { tasks: rest };
    }),
  setSelectedAssetIds: (ids) => set({ selectedAssetIds: ids }),
}));
