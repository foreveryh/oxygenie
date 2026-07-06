'use client';

import { useCallback, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { NodeToolbar as XyNodeToolbar, Position } from '@xyflow/react';
import { Download, Loader2, Trash2 } from 'lucide-react';
import { useCanvasStore } from '../canvas-store';
import { deleteAssets } from '~/server/function/canvas.server';

/**
 * Canvas Agent (F4, v1 button set) — floating toolbar for the current selection.
 * Rendered ONCE at the canvas-root level (not per-node): xyflow's `nodeId` prop
 * accepts a string OR string[], positioning itself below the bounding box of ALL
 * listed nodes — so a single instance covers both single- and multi-select without
 * per-node toolbar instances. v1 scope only (impl spec §1): Animate/裁剪/放大/参数/
 * 分享/反馈/Group are P1/P2 or depend on unbuilt video generation — download + delete
 * only, matching the spec's own "v1 按钮集".
 */
export function CanvasNodeToolbar() {
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds);
  const assets = useCanvasStore((s) => s.assets);
  const setSelectedAssetIds = useCanvasStore((s) => s.setSelectedAssetIds);
  const removeAssetsLocally = useCanvasStore((s) => s.removeAssets);
  const deleteAssetsFn = useServerFn(deleteAssets);
  const [isDeleting, setIsDeleting] = useState(false);

  const selected = selectedAssetIds.map((id) => assets[id]).filter((a): a is NonNullable<typeof a> => Boolean(a));

  const handleDownload = useCallback(() => {
    for (const asset of selected) {
      if (!asset.relPath) continue;
      const a = document.createElement('a');
      a.href = `/api/canvases/${asset.canvasId}/asset/${asset.relPath}?download=1`;
      a.download = asset.relPath;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }, [selected]);

  const handleDelete = useCallback(async () => {
    if (selected.length === 0) return;
    setIsDeleting(true);
    try {
      await deleteAssetsFn({ data: { assetIds: selected.map((a) => a.id) } });
      removeAssetsLocally(selected.map((a) => a.id));
      setSelectedAssetIds([]);
    } catch (error) {
      console.error('[CanvasNodeToolbar] delete failed:', error);
    } finally {
      setIsDeleting(false);
    }
  }, [selected, deleteAssetsFn, removeAssetsLocally, setSelectedAssetIds]);

  if (selected.length === 0) return null;

  return (
    <XyNodeToolbar
      nodeId={selected.map((a) => a.id)}
      position={Position.Bottom}
      offset={12}
      className="flex items-center gap-1 rounded-lg border border-border/70 bg-popover p-1 shadow-md"
    >
      <button
        type="button"
        onClick={handleDownload}
        title="下载"
        aria-label="下载"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Download width={16} height={16} />
      </button>
      <button
        type="button"
        onClick={handleDelete}
        disabled={isDeleting}
        title="删除"
        aria-label="删除"
        className="flex h-8 w-8 items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
      >
        {isDeleting ? <Loader2 width={16} height={16} className="animate-spin" /> : <Trash2 width={16} height={16} />}
      </button>
    </XyNodeToolbar>
  );
}
