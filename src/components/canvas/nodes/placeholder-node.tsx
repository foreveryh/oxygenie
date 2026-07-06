import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { ImageIcon, Loader2, X } from 'lucide-react';
import { useCanvasStore } from '../canvas-store';

export type PlaceholderNodeData = {
  taskId: string;
  prompt?: string;
  status: 'queued' | 'running' | 'failed';
  error?: string;
};

/**
 * Canvas placeholder node (PRD F6.0/F6.0d) — a reserved slot for an in-flight
 * generation. Shown from task_created until the matching asset_created replaces it.
 * Failed placeholders are orphaned (no asset row was ever created for them) — dismiss
 * is a pure local store removal, no server call needed.
 */
function PlaceholderNodeComponent({ data }: NodeProps & { data: PlaceholderNodeData }) {
  const removeTask = useCanvasStore((s) => s.removeTask);
  const isFailed = data.status === 'failed';
  return (
    <div
      style={{ width: 280, height: 280 }}
      className="relative flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/50 p-4 text-center"
    >
      {isFailed ? (
        <>
          <button
            type="button"
            onClick={() => removeTask(data.taskId)}
            title="关闭"
            aria-label="关闭"
            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X width={12} height={12} />
          </button>
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
