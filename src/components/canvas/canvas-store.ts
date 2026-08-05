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

/** F9.1 pointer-group mode. 'text' is one-shot: canvas-toolbar.tsx arms it, the next
 * pane click creates a text node and canvas-root.tsx flips the mode back to 'select'.
 * 'image'/'video' stay armed (not one-shot) while direct-gen-bar.tsx's floating
 * parameter bar is open — F9.2/9.3 — until the user submits or hits ✕. */
export type CanvasTool = 'select' | 'hand' | 'text' | 'image' | 'video';

interface CanvasState {
  assets: Record<string, CanvasAssetDTO>;
  tasks: Record<string, CanvasTask>;
  activeTool: CanvasTool;
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
  // M3-T2: which video asset (if any) has its Trim panel open — set by node-toolbar's
  // Trim button, read by video-node.tsx to conditionally mount trim-panel.tsx as its
  // own child (impl spec §6.2: "面板本体挂在视频节点下方，xyflow 自定义节点的子元素").
  trimOpenAssetId: string | null;
  setActiveTool: (tool: CanvasTool) => void;
  setInitialAssets: (assets: CanvasAssetDTO[]) => void;
  upsertAsset: (asset: CanvasAssetDTO) => void;
  removeAssets: (assetIds: string[]) => void;
  upsertTask: (task: CanvasTask) => void;
  removeTask: (taskId: string) => void;
  setSelectedAssetIds: (ids: string[]) => void;
  setPendingComposerCommand: (command: PendingComposerCommand | null) => void;
  setTrimOpenAssetId: (assetId: string | null) => void;
}

/**
 * Canvas Agent (D5) store — single source of truth for what's on the canvas. Populated
 * by the loader's initial snapshot + live canvas_event frames (use-canvas-channel.ts).
 */
export const useCanvasStore = create<CanvasState>((set) => ({
  assets: {},
  tasks: {},
  activeTool: 'select',
  selectedAssetIds: [],
  pendingComposerCommand: null,
  trimOpenAssetId: null,
  setActiveTool: (tool) => set({ activeTool: tool }),
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
  setTrimOpenAssetId: (assetId) => set({ trimOpenAssetId: assetId }),
}));
