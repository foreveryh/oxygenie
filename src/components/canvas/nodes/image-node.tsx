import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';

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
 * gesture is xyflow's, the ring here is just the visual reflection of it (PRD F3.4:
 * "单击出现选择框（四角手柄...）"; corner-handle resize is separate, not built yet).
 */
function ImageNodeComponent({ data, selected }: NodeProps & { data: ImageNodeData }) {
  const src = `/api/canvases/${data.canvasId}/asset/${data.relPath}`;
  return (
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
  );
}

export const ImageNode = memo(ImageNodeComponent);
