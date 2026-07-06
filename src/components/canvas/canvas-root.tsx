'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  BackgroundVariant,
  type Node,
  type OnSelectionChangeFunc,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useServerFn } from '@tanstack/react-start';
import { useCanvasStore } from './canvas-store';
import { useCanvasChannel } from './use-canvas-channel';
import { ImageNode, type ImageNodeData } from './nodes/image-node';
import { VideoNode, type VideoNodeData } from './nodes/video-node';
import { PlaceholderNode, type PlaceholderNodeData } from './nodes/placeholder-node';
import { CanvasNodeToolbar } from './nodes/node-toolbar';
import { updateAssetPos, type CanvasAssetDTO } from '~/server/function/canvas.server';

const nodeTypes = { image: ImageNode, video: VideoNode, placeholder: PlaceholderNode };
const DRAGGABLE_ASSET_TYPES = new Set(['image', 'video']);
const POS_DEBOUNCE_MS = 300; // impl spec §5.6/§6.4: debounce position persistence

interface CanvasRootProps {
  canvasId: string;
  initialAssets: CanvasAssetDTO[];
}

/**
 * Canvas Agent (D5/M2) — ReactFlow assembly. Image + video nodes; text nodes and
 * placeholder-with-parameter-bar are still deferred (M4 polish).
 */
export function CanvasRoot({ canvasId, initialAssets }: CanvasRootProps) {
  const setInitialAssets = useCanvasStore((s) => s.setInitialAssets);
  const assets = useCanvasStore((s) => s.assets);
  const tasks = useCanvasStore((s) => s.tasks);
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds);
  const upsertAsset = useCanvasStore((s) => s.upsertAsset);
  const setSelectedAssetIds = useCanvasStore((s) => s.setSelectedAssetIds);
  const persistPos = useServerFn(updateAssetPos);

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

  const nodes: Node[] = useMemo(() => {
    const assetNodes: Node[] = Object.values(assets)
      .filter((a): a is typeof a & { relPath: string } => DRAGGABLE_ASSET_TYPES.has(a.type) && !!a.relPath)
      .map((a) =>
        a.type === 'video'
          ? {
              id: a.id,
              type: 'video',
              position: { x: a.posX, y: a.posY },
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
          : {
              id: a.id,
              type: 'image',
              position: { x: a.posX, y: a.posY },
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
  }, [assets, tasks, canvasId, selectedAssetIds]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={onSelectionChange}
        onlyRenderVisibleElements
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
        <CanvasNodeToolbar />
      </ReactFlow>
    </div>
  );
}
