import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { ImageIcon, Loader2 } from 'lucide-react';

export type PlaceholderNodeData = {
  prompt?: string;
  status: 'queued' | 'running' | 'failed';
  error?: string;
};

/**
 * Canvas placeholder node (PRD F6.0/F6.0d) — a reserved slot for an in-flight
 * generation. Shown from task_created until the matching asset_created replaces it.
 */
function PlaceholderNodeComponent({ data }: NodeProps & { data: PlaceholderNodeData }) {
  const isFailed = data.status === 'failed';
  return (
    <div
      style={{ width: 280, height: 280 }}
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/50 p-4 text-center"
    >
      {isFailed ? (
        <>
          <ImageIcon className="h-6 w-6 text-destructive" />
          <span className="text-xs text-destructive">生成失败{data.error ? `：${data.error}` : ''}</span>
        </>
      ) : (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="line-clamp-3 text-xs text-muted-foreground">
            {data.prompt || 'Generating…'}
          </span>
        </>
      )}
    </div>
  );
}

export const PlaceholderNode = memo(PlaceholderNodeComponent);
