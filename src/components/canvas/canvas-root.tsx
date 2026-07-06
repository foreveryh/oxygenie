'use client';

import { useEffect, useMemo } from 'react';
import { ReactFlow, Background, Controls, BackgroundVariant, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCanvasStore } from './canvas-store';
import { useCanvasChannel } from './use-canvas-channel';
import { ImageNode, type ImageNodeData } from './nodes/image-node';
import { PlaceholderNode, type PlaceholderNodeData } from './nodes/placeholder-node';
import type { CanvasAssetDTO } from '~/server/function/canvas.server';

const nodeTypes = { image: ImageNode, placeholder: PlaceholderNode };

interface CanvasRootProps {
  canvasId: string;
  initialAssets: CanvasAssetDTO[];
}

/**
 * Canvas Agent (D5) — ReactFlow assembly. Image-only in this slice (video/text/
 * placeholder-with-parameter-bar/selection/toolbar all deferred — see spec's reduced
 * M1 scope for the historical-events demo).
 */
export function CanvasRoot({ canvasId, initialAssets }: CanvasRootProps) {
  const setInitialAssets = useCanvasStore((s) => s.setInitialAssets);
  const assets = useCanvasStore((s) => s.assets);
  const tasks = useCanvasStore((s) => s.tasks);

  useEffect(() => {
    setInitialAssets(initialAssets);
  }, [initialAssets, setInitialAssets]);

  useCanvasChannel(canvasId);

  const nodes: Node[] = useMemo(() => {
    const assetNodes: Node[] = Object.values(assets)
      .filter((a): a is typeof a & { relPath: string } => a.type === 'image' && !!a.relPath)
      .map((a) => ({
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
        draggable: false,
        selectable: false,
      }));

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
          prompt: t.params?.prompt,
          status: t.status === 'queued' ? 'queued' : t.status === 'failed' ? 'failed' : 'running',
          error: t.error,
        } satisfies PlaceholderNodeData,
        draggable: false,
        selectable: false,
      }));

    return [...assetNodes, ...placeholderNodes];
  }, [assets, tasks, canvasId]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onlyRenderVisibleElements
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
