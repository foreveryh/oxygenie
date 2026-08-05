'use client';

import { memo } from 'react';
import { Music2 } from 'lucide-react';
import type { NodeProps } from '@xyflow/react';

export type AudioNodeData = {
  canvasId: string;
  relPath: string;
  width: number;
  height: number;
  durationSec?: number;
};

function AudioNodeComponent({ data, selected }: NodeProps & { data: AudioNodeData }) {
  const src = `/api/canvases/${data.canvasId}/asset/${data.relPath}`;
  return (
    <div
      style={{ width: data.width, height: data.height }}
      className={`flex flex-col justify-center gap-3 rounded-lg border bg-popover px-5 shadow-sm ${
        selected ? 'border-primary ring-2 ring-primary' : 'border-border/60'
      }`}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Music2 width={18} height={18} />
        <span>音频参考{data.durationSec ? ` · ${data.durationSec.toFixed(1)}s` : ''}</span>
      </div>
      <audio src={src} controls preload="metadata" className="w-full" />
    </div>
  );
}

export const AudioNode = memo(AudioNodeComponent);
