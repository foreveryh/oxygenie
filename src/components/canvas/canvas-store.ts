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

export interface PendingComposerCommand {
  assetIds: string[];
  text: string;
}

interface CanvasState {
  assets: Record<string, CanvasAssetDTO>;
  tasks: Record<string, CanvasTask>;
  // F10.1/§6.3: selection lives here as the single source of truth — xyflow's own
  // node.selected is a projection of this (set via onSelectionChange), not the other
  // way around. Full chip sync (F10.2) is a later addition; this is the foundation.
  selectedAssetIds: string[];
  // F5.1/F4.x (Animate button, in-place mini composer): CanvasRoot/node-toolbar.tsx
  // live OUTSIDE the AssistantRuntimeProvider tree (siblings of ClaudeChatController
  // under the canvas route, not descendants — see $canvasId.tsx), so they can't call
  // assistant-ui hooks directly to trigger a send. This is a one-shot command bus:
  // node-toolbar.tsx sets it, chat-composer.tsx's effect consumes+clears it and does
  // the actual stage-refs+setText+send, same side-channel spirit as
  // stagePendingCanvasRefs.
  pendingComposerCommand: PendingComposerCommand | null;
  setInitialAssets: (assets: CanvasAssetDTO[]) => void;
  upsertAsset: (asset: CanvasAssetDTO) => void;
  removeAssets: (assetIds: string[]) => void;
  upsertTask: (task: CanvasTask) => void;
  removeTask: (taskId: string) => void;
  setSelectedAssetIds: (ids: string[]) => void;
  setPendingComposerCommand: (command: PendingComposerCommand | null) => void;
}

/**
 * Canvas Agent (D5) store — single source of truth for what's on the canvas. Populated
 * by the loader's initial snapshot + live canvas_event frames (use-canvas-channel.ts).
 */
export const useCanvasStore = create<CanvasState>((set) => ({
  assets: {},
  tasks: {},
  selectedAssetIds: [],
  pendingComposerCommand: null,
  setInitialAssets: (assets) =>
    set({ assets: Object.fromEntries(assets.map((a) => [a.id, a])) }),
  upsertAsset: (asset) =>
    set((s) => ({ assets: { ...s.assets, [asset.id]: asset } })),
  removeAssets: (assetIds) =>
    set((s) => {
      const ids = new Set(assetIds);
      const assets = Object.fromEntries(Object.entries(s.assets).filter(([id]) => !ids.has(id)));
      return { assets, selectedAssetIds: s.selectedAssetIds.filter((id) => !ids.has(id)) };
    }),
  upsertTask: (task) =>
    set((s) => ({ tasks: { ...s.tasks, [task.id]: { ...s.tasks[task.id], ...task } } })),
  removeTask: (taskId) =>
    set((s) => {
      const { [taskId]: _removed, ...rest } = s.tasks;
      return { tasks: rest };
    }),
  setSelectedAssetIds: (ids) => set({ selectedAssetIds: ids }),
  setPendingComposerCommand: (command) => set({ pendingComposerCommand: command }),
}));
