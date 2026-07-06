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
 */
function ImageNodeComponent({ data }: NodeProps & { data: ImageNodeData }) {
  const src = `/api/canvases/${data.canvasId}/asset/${data.relPath}`;
  return (
    <div
      style={{ width: data.width, height: data.height }}
      className="overflow-hidden rounded-lg border border-border/60 bg-muted shadow-sm"
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
