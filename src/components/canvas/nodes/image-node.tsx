'use client';

import { memo, useCallback } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { useServerFn } from '@tanstack/react-start';
import { useCanvasStore } from '../canvas-store';
import { updateAssetPos } from '~/server/function/canvas.server';

export type ImageNodeData = {
  canvasId: string;
  relPath: string;
  width: number;
  height: number;
  prompt?: string;
};

/**
 * Canvas image node (PRD F3.3). loading="lazy" — PRD §6 non-functional target (hundreds
 * of assets, 60fps pan/zoom) relies on the browser not decoding off-screen images eagerly.
 *
 * `selected` comes from xyflow's own NodeProps (node.selected) — the click-to-select
 * gesture is xyflow's, the ring here is just the visual reflection of it. Corner/edge
 * resize handles (PRD F3.4: "单击出现选择框（四角手柄...）") drive `data.width/height`
 * straight from canvasStore (same "optimistic local + debounced-ish persist" split as
 * onNodeDragStop in canvas-root.tsx) rather than xyflow's own node.width/height — keeps
 * canvasStore the single source of truth for both position and size.
 */
function ImageNodeComponent({ id, data, selected }: NodeProps & { data: ImageNodeData }) {
  // Perf (2026-07-06): request a thumbnail sized to the actual on-canvas box (2x for
  // retina), not the full Imagen/Gemini source (~1024px+, ~1-2MB) — decoding/compositing
  // full-res sources for a ~280px box is what made dragging janky. See asset route.
  const thumbWidth = Math.ceil(Math.max(data.width, data.height) * 2);
  const src = `/api/canvases/${data.canvasId}/asset/${data.relPath}?w=${thumbWidth}`;

  const asset = useCanvasStore((s) => s.assets[id]);
  const upsertAsset = useCanvasStore((s) => s.upsertAsset);
  const persistSize = useServerFn(updateAssetPos);

  const handleResize = useCallback(
    (_event: unknown, params: { x: number; y: number; width: number; height: number }) => {
      if (!asset) return;
      upsertAsset({ ...asset, posX: params.x, posY: params.y, width: params.width, height: params.height });
    },
    [asset, upsertAsset]
  );

  const handleResizeEnd = useCallback(
    (_event: unknown, params: { x: number; y: number; width: number; height: number }) => {
      handleResize(_event, params);
      void persistSize({ data: { assetId: id, posX: params.x, posY: params.y, width: params.width, height: params.height } });
    },
    [id, handleResize, persistSize]
  );

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={80}
        minHeight={80}
        keepAspectRatio
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
      />
      <div
        style={{ width: data.width, height: data.height }}
        className={`overflow-hidden rounded-lg border bg-muted shadow-sm ${
          selected ? 'border-primary ring-2 ring-primary' : 'border-border/60'
        }`}
        title={data.prompt}
      >
        <img
          src={src}
          alt={data.prompt || 'canvas asset'}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-contain"
        />
      </div>
    </>
  );
}

export const ImageNode = memo(ImageNodeComponent);
