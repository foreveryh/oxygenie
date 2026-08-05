'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  BackgroundVariant,
  type Node,
  type OnSelectionChangeFunc,
  type OnNodeDrag,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useServerFn } from '@tanstack/react-start';
import { useCanvasStore } from './canvas-store';
import { useCanvasChannel } from './use-canvas-channel';
import { ImageNode, type ImageNodeData } from './nodes/image-node';
import { VideoNode, type VideoNodeData } from './nodes/video-node';
import { AudioNode, type AudioNodeData } from './nodes/audio-node';
import { TextNode, type TextNodeData } from './nodes/text-node';
import { PlaceholderNode, type PlaceholderNodeData } from './nodes/placeholder-node';
import { CanvasNodeToolbar } from './nodes/node-toolbar';
import { CanvasToolbar } from './canvas-toolbar';
import { DirectGenBar } from './direct-gen-bar';
import { updateAssetPos, createTextNode, type CanvasAssetDTO } from '~/server/function/canvas.server';

const nodeTypes = { image: ImageNode, video: VideoNode, audio: AudioNode, text: TextNode, placeholder: PlaceholderNode };
const DRAGGABLE_ASSET_TYPES = new Set(['image', 'video', 'audio', 'text']);
const POS_DEBOUNCE_MS = 300; // impl spec §5.6/§6.4: debounce position persistence

interface CanvasRootProps {
  canvasId: string;
  initialAssets: CanvasAssetDTO[];
}

/**
 * Canvas Agent (D5/M2/M3) — ReactFlow assembly. Image, video, and text nodes; the
 * placeholder-with-parameter-bar (direct-gen mode) lives in direct-gen-bar.tsx (M3-T1).
 */
export function CanvasRoot({ canvasId, initialAssets }: CanvasRootProps) {
  const setInitialAssets = useCanvasStore((s) => s.setInitialAssets);
  const assets = useCanvasStore((s) => s.assets);
  const tasks = useCanvasStore((s) => s.tasks);
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds);
  const upsertAsset = useCanvasStore((s) => s.upsertAsset);
  const setSelectedAssetIds = useCanvasStore((s) => s.setSelectedAssetIds);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const persistPos = useServerFn(updateAssetPos);
  const createTextNodeFn = useServerFn(createTextNode);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  // F9.4: id of the text node this component itself just created, so ITS first mount
  // (only) opens straight into edit mode — cleared shortly after so a later remount
  // (onlyRenderVisibleElements unmounts off-screen nodes) doesn't reopen it.
  const [justCreatedTextId, setJustCreatedTextId] = useState<string | null>(null);

  useEffect(() => {
    setInitialAssets(initialAssets);
  }, [initialAssets, setInitialAssets]);

  useCanvasChannel(canvasId);

  // Debounced per-asset position persistence (impl spec §5.6/§6.4: "拖动位置提交防抖").
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const schedulePosPersist = useCallback(
    (assetId: string, posX: number, posY: number) => {
      clearTimeout(debounceTimers.current[assetId]);
      debounceTimers.current[assetId] = setTimeout(() => {
        void persistPos({ data: { assetId, posX, posY } });
      }, POS_DEBOUNCE_MS);
    },
    [persistPos]
  );

  // F3.4/F10.1: drag moves the asset; optimistic local update so it doesn't snap back
  // while the debounced persist is in flight, then the server write catches up.
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, node) => {
      if (!node.type || !DRAGGABLE_ASSET_TYPES.has(node.type)) return;
      const asset = assets[node.id];
      if (!asset) return;
      upsertAsset({ ...asset, posX: node.position.x, posY: node.position.y });
      schedulePosPersist(node.id, node.position.x, node.position.y);
    },
    [assets, upsertAsset, schedulePosPersist]
  );

  // F10.1/§6.3: canvasStore.selectedAssetIds is the single source of truth; xyflow's
  // click-to-select gesture writes into it here, image-node.tsx's `selected` prop reads
  // back out of it via the node's `selected` field below.
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes }) => {
      setSelectedAssetIds(
        selectedNodes.filter((n) => n.type && DRAGGABLE_ASSET_TYPES.has(n.type)).map((n) => n.id)
      );
    },
    [setSelectedAssetIds]
  );

  // F9.4: with the Text tool armed, clicking empty canvas drops a text node at that
  // point (screen → flow coords via the ReactFlow instance) and switches back to
  // Select so the tool doesn't stay "sticky" (matches the reference product).
  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (activeTool !== 'text' || !rfInstance.current) return;
      const pos = rfInstance.current.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setActiveTool('select');
      void createTextNodeFn({ data: { canvasId, posX: pos.x, posY: pos.y, content: '' } }).then((asset) => {
        upsertAsset(asset);
        setJustCreatedTextId(asset.id);
        setTimeout(() => setJustCreatedTextId(null), 150);
      });
    },
    [activeTool, canvasId, createTextNodeFn, upsertAsset, setActiveTool]
  );

  const nodes: Node[] = useMemo(() => {
    const assetNodes: Node[] = Object.values(assets)
      .filter((a): a is typeof a & { relPath: string } => DRAGGABLE_ASSET_TYPES.has(a.type) && !!a.relPath)
      .map((a) =>
        a.type === 'audio'
          ? {
              id: a.id,
              type: 'audio',
              position: { x: a.posX, y: a.posY },
              width: a.width,
              height: a.height,
              data: {
                canvasId,
                relPath: a.relPath,
                width: a.width,
                height: a.height,
                durationSec: a.meta?.durationSec,
              } satisfies AudioNodeData,
              draggable: true,
              selectable: true,
              selected: selectedAssetIds.includes(a.id),
            }
          : a.type === 'video'
          ? {
              id: a.id,
              type: 'video',
              position: { x: a.posX, y: a.posY },
              // Top-level width/height (not just inside data): xyflow's fitView/getNodesBounds
              // only has real dimensions for a node once it's been DOM-mounted and measured
              // (node.measured) — for a node that's still off-screen under onlyRenderVisibleElements
              // virtualization, it falls back to these top-level fields. Without them, fitView at
              // large asset counts (500-asset stress test) silently excludes every never-yet-mounted
              // node from its bounds calculation instead of fitting the whole canvas.
              width: a.width,
              height: a.height,
              data: {
                canvasId,
                relPath: a.relPath,
                width: a.width,
                height: a.height,
                prompt: a.meta?.prompt,
                durationSec: a.meta?.durationSec,
              } satisfies VideoNodeData,
              draggable: true,
              selectable: true,
              selected: selectedAssetIds.includes(a.id),
            }
          : a.type === 'text'
          ? {
              id: a.id,
              type: 'text',
              position: { x: a.posX, y: a.posY },
              width: a.width,
              height: a.height,
              data: {
                canvasId,
                content: a.meta?.text?.content ?? '',
                color: a.meta?.text?.color,
                align: a.meta?.text?.align,
                fontSize: a.meta?.text?.fontSize,
                width: a.width,
                height: a.height,
                autoEdit: a.id === justCreatedTextId,
              } satisfies TextNodeData,
              draggable: true,
              selectable: true,
              selected: selectedAssetIds.includes(a.id),
            }
          : {
              id: a.id,
              type: 'image',
              position: { x: a.posX, y: a.posY },
              width: a.width,
              height: a.height,
              data: {
                canvasId,
                relPath: a.relPath,
                width: a.width,
                height: a.height,
                prompt: a.meta?.prompt,
              } satisfies ImageNodeData,
              draggable: true,
              selectable: true,
              selected: selectedAssetIds.includes(a.id),
            }
      );

    // One placeholder per in-flight task at its first reserved slot (simplification:
    // this demo's generate_image calls are single-image, so 1 box per task is
    // representative — see canvas-root.tsx comment in the task history for why a
    // full per-slot reconciliation wasn't built for this slice).
    const placeholderNodes: Node[] = Object.values(tasks)
      .filter((t) => t.status === 'running' || t.status === 'queued' || t.status === 'failed')
      .filter((t) => t.reservedPositions?.length)
      .map((t) => ({
        id: `task-${t.id}`,
        type: 'placeholder',
        position: { x: t.reservedPositions![0].posX, y: t.reservedPositions![0].posY },
        data: {
          taskId: t.id,
          prompt: t.params?.prompt,
          status: t.status === 'queued' ? 'queued' : t.status === 'failed' ? 'failed' : 'running',
          error: t.error,
          kind: t.kind,
        } satisfies PlaceholderNodeData,
        draggable: false,
        selectable: false,
      }));

    return [...assetNodes, ...placeholderNodes];
  }, [assets, tasks, canvasId, selectedAssetIds, justCreatedTextId]);

  // F9.1: Hand mode pans on drag (xyflow default) and disables box-selection; Select
  // mode does the reverse (drag-on-empty-space box-selects, matching spec §6.2's
  // "selectionOnDrag"). Text mode reuses Select's canvas interaction — its own click
  // handling is via onPaneClick above, not a drag gesture.
  const isHand = activeTool === 'hand';

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={onSelectionChange}
        onPaneClick={onPaneClick}
        onInit={(instance) => { rfInstance.current = instance; }}
        panOnDrag={isHand}
        selectionOnDrag={!isHand}
        multiSelectionKeyCode="Shift"
        onlyRenderVisibleElements
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
        <CanvasNodeToolbar />
      </ReactFlow>
      <div className="pointer-events-none absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2">
        <DirectGenBar canvasId={canvasId} />
        <CanvasToolbar canvasId={canvasId} />
      </div>
    </div>
  );
}
