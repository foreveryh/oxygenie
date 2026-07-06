'use client';

import { memo, useCallback } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { useServerFn } from '@tanstack/react-start';
import { useCanvasStore } from '../canvas-store';
import { updateAssetPos } from '~/server/function/canvas.server';

export type VideoNodeData = {
  canvasId: string;
  relPath: string;
  width: number;
  height: number;
  prompt?: string;
  durationSec?: number;
};

/**
 * Canvas video node (M2-T6). Mirrors image-node.tsx's shape/sizing, but native
 * <video controls> instead of <img> — the asset route's Range support (M2-T4) is
 * what makes seeking work. No poster/thumbnail frame extraction in this slice (would
 * need an ffmpeg frame-grab at ingest time — perf.md's later concern, not needed to
 * prove the generation pipeline); `preload="metadata"` keeps off-screen videos from
 * eagerly downloading bytes (same spirit as image-node.tsx's loading="lazy").
 *
 * Click-to-select bug fix: a bare `<video controls>` filling the whole node consumes
 * every click for its own play/pause toggle (native UA control shadow-DOM stops the
 * event before xyflow's own node-select listener ever sees it) — the node was
 * literally unselectable by clicking, which meant the F4 toolbar could never appear
 * for a video asset. Standard fix: a transparent overlay sits on top and captures the
 * first click (selects the node, doesn't touch the video), then gets out of the way
 * (`pointer-events-none`) once selected so a second click reaches the real controls —
 * same "click once to select the embed, click again to interact" pattern used by
 * any canvas/whiteboard tool that embeds native media.
 *
 * Resize handles: same canvasStore-driven approach as image-node.tsx — see its comment.
 */
function VideoNodeComponent({ id, data, selected }: NodeProps & { data: VideoNodeData }) {
  const src = `/api/canvases/${data.canvasId}/asset/${data.relPath}`;

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
        className={`relative overflow-hidden rounded-lg border bg-muted shadow-sm ${
          selected ? 'border-primary ring-2 ring-primary' : 'border-border/60'
        }`}
        title={data.prompt}
      >
        <video
          src={src}
          controls
          preload="metadata"
          draggable={false}
          className="h-full w-full object-contain"
        />
        {!selected && <div className="absolute inset-0" />}
      </div>
    </>
  );
}

export const VideoNode = memo(VideoNodeComponent);
