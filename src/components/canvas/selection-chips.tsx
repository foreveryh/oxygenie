'use client';

import { X } from 'lucide-react';
import { useCanvasStore } from './canvas-store';

/**
 * Canvas Agent (D5/F10.2) — selected-asset chips, mounted above the composer (canvas
 * mode only). Reads canvasStore directly (self-contained, no prop threading needed —
 * every asset already carries its own canvasId, see CanvasAssetDTO). The chip's ✕
 * writes back into canvasStore.selectedAssetIds, which canvas-root.tsx's nodes useMemo
 * reads to derive `node.selected` — removing here deselects the xyflow node too
 * (single source of truth, impl spec §6.3's "唯一真相源纪律").
 */
export function SelectionChips() {
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds);
  const assets = useCanvasStore((s) => s.assets);
  const setSelectedAssetIds = useCanvasStore((s) => s.setSelectedAssetIds);

  const selected = selectedAssetIds.map((id) => assets[id]).filter((a) => a && a.type === 'image');
  if (selected.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {selected.map((asset) => (
        <div
          key={asset.id}
          className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border/70 bg-muted"
          title={asset.meta?.prompt}
        >
          {asset.relPath && (
            <img
              // Perf: chip box is h-14 w-14 (56px) — 2x retina thumbnail, not the full
              // Imagen/Gemini source (see image-node.tsx's same fix for why).
              src={`/api/canvases/${asset.canvasId}/asset/${asset.relPath}?w=112`}
              alt={asset.meta?.prompt || 'selected asset'}
              className="h-full w-full object-cover"
            />
          )}
          <button
            type="button"
            onClick={() => setSelectedAssetIds(selectedAssetIds.filter((id) => id !== asset.id))}
            aria-label="取消选中"
            className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
          >
            <X width={10} height={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
