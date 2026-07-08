'use client';

import { useCallback, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { NodeToolbar as XyNodeToolbar, Position } from '@xyflow/react';
import { AlignCenter, AlignLeft, AlignRight, ArrowUp, Download, Info, Loader2, Maximize2, Play, Scissors, Trash2, X } from 'lucide-react';
import { useCanvasStore } from '../canvas-store';
import { deleteAssets, updateTextNode } from '~/server/function/canvas.server';

const FONT_SIZES = [12, 14, 16, 20, 24, 32, 48];

/**
 * Canvas Agent (F4) — floating toolbar for the current selection, plus the F4.x
 * in-place mini composer. Button set follows the reference product 1:1 for what we
 * actually built (▶ Animate [image] / ✂ Trim [video, M3-T2] / ⤢ Full Screen / ≡ Info /
 * ⬇ Download / 🗑 Delete) —
 * deliberately NOT included: 裁剪 Crop (needs real image-editing infra, none exists),
 * ⬆ Share and 👍/👎 (P2, no backend, low value for an internal tool). Multi-select
 * still gets download+delete only (F10.3's Group/复制 are v2, see spec's "不做/后置").
 */
export function CanvasNodeToolbar() {
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds);
  const assets = useCanvasStore((s) => s.assets);
  const setSelectedAssetIds = useCanvasStore((s) => s.setSelectedAssetIds);
  const removeAssetsLocally = useCanvasStore((s) => s.removeAssets);
  const setPendingComposerCommand = useCanvasStore((s) => s.setPendingComposerCommand);
  const deleteAssetsFn = useServerFn(deleteAssets);
  const [isDeleting, setIsDeleting] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [inlineText, setInlineText] = useState('');

  const selected = selectedAssetIds.map((id) => assets[id]).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const single = selected.length === 1 ? selected[0] : null;

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

  // F5.1: one-click image-to-video, matching the reference product's "Animate = a
  // shortcut for referencing this image + sending 'Animate this'" (impl spec's own
  // node-toolbar.tsx comment, never actually wired up until now). Backend already
  // supports it (generate_video's imageRelPath) — this button was the missing link.
  const handleAnimate = useCallback(() => {
    if (!single || single.type !== 'image') return;
    setPendingComposerCommand({ assetIds: [single.id], text: 'Animate this' });
  }, [single, setPendingComposerCommand]);

  // M3-T2: toggles trim-panel.tsx open/closed for the selected video (rendered as
  // the video node's own child, not here — see video-node.tsx).
  const trimOpenAssetId = useCanvasStore((s) => s.trimOpenAssetId);
  const setTrimOpenAssetId = useCanvasStore((s) => s.setTrimOpenAssetId);
  const handleToggleTrim = useCallback(() => {
    if (!single || single.type !== 'video') return;
    setTrimOpenAssetId(trimOpenAssetId === single.id ? null : single.id);
  }, [single, trimOpenAssetId, setTrimOpenAssetId]);

  // F4.x in-place mini composer: same command bus as Animate, free-typed text.
  const handleInlineSend = useCallback(() => {
    if (!single || !inlineText.trim()) return;
    setPendingComposerCommand({ assetIds: [single.id], text: inlineText.trim() });
    setInlineText('');
  }, [single, inlineText, setPendingComposerCommand]);

  // F9.4: text node format toolbar (颜色/对齐/字号/删除) — a different button set from
  // the media toolbar below; Animate/Full Screen/Info don't apply to a text note.
  const updateTextNodeFn = useServerFn(updateTextNode);
  const upsertAssetLocally = useCanvasStore((s) => s.upsertAsset);
  const handleTextFormat = useCallback(
    (patch: { color?: string; align?: 'left' | 'center' | 'right'; fontSize?: number }) => {
      if (!single || single.type !== 'text') return;
      const prevText = single.meta?.text;
      const nextText = { content: prevText?.content ?? '', ...prevText, ...patch };
      upsertAssetLocally({ ...single, meta: { ...single.meta, text: nextText } });
      void updateTextNodeFn({ data: { assetId: single.id, content: nextText.content, ...patch } });
    },
    [single, updateTextNodeFn, upsertAssetLocally]
  );

  if (selected.length === 0) return null;

  const fullscreenAsset = single;
  const isTextSingle = single?.type === 'text';

  if (isTextSingle) {
    const align = single.meta?.text?.align ?? 'left';
    const fontSize = single.meta?.text?.fontSize ?? 16;
    return (
      <XyNodeToolbar
        nodeId={single.id}
        position={Position.Bottom}
        offset={12}
        className="flex items-center gap-1 rounded-lg border border-border/70 bg-popover p-1.5 shadow-md"
      >
        <input
          type="color"
          value={single.meta?.text?.color ?? '#000000'}
          onChange={(e) => handleTextFormat({ color: e.target.value })}
          title="颜色"
          aria-label="颜色"
          className="h-8 w-8 cursor-pointer rounded-md border border-border/60 bg-transparent p-0.5"
        />
        <div className="mx-0.5 h-5 w-px bg-border" />
        {([
          ['left', AlignLeft, '左对齐'],
          ['center', AlignCenter, '居中'],
          ['right', AlignRight, '右对齐'],
        ] as const).map(([value, Icon, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => handleTextFormat({ align: value })}
            title={label}
            aria-label={label}
            className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground ${align === value ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
          >
            <Icon width={16} height={16} />
          </button>
        ))}
        <select
          value={fontSize}
          onChange={(e) => handleTextFormat({ fontSize: Number(e.target.value) })}
          title="字号"
          aria-label="字号"
          className="h-8 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
        >
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
        <div className="mx-0.5 h-5 w-px bg-border" />
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

  return (
    <>
      <XyNodeToolbar
        nodeId={selected.map((a) => a.id)}
        position={Position.Bottom}
        offset={12}
        className="flex flex-col gap-2 rounded-lg border border-border/70 bg-popover p-1.5 shadow-md"
      >
        <div className="flex items-center gap-1">
          {single && single.type === 'image' && (
            <button
              type="button"
              onClick={handleAnimate}
              title="Animate（生成视频）"
              aria-label="Animate"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Play width={16} height={16} />
            </button>
          )}
          {single && single.type === 'video' && (
            <button
              type="button"
              onClick={handleToggleTrim}
              title="Trim"
              aria-label="Trim"
              aria-pressed={trimOpenAssetId === single.id}
              className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground ${trimOpenAssetId === single.id ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
            >
              <Scissors width={16} height={16} />
            </button>
          )}
          {single && (
            <button
              type="button"
              onClick={() => setFullscreenOpen(true)}
              title="Full Screen"
              aria-label="Full Screen"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Maximize2 width={16} height={16} />
            </button>
          )}
          {single && (
            <button
              type="button"
              onClick={() => setInfoOpen((v) => !v)}
              title="生成参数"
              aria-label="生成参数"
              className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground ${infoOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
            >
              <Info width={16} height={16} />
            </button>
          )}
          <div className="mx-0.5 h-5 w-px bg-border" />
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
        </div>

        {infoOpen && single && (
          <div className="w-64 space-y-1 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
            {single.meta?.prompt && <p className="line-clamp-4"><span className="font-medium text-foreground">Prompt: </span>{single.meta.prompt}</p>}
            {single.meta?.model && <p><span className="font-medium text-foreground">Model: </span>{single.meta.model}</p>}
            <p><span className="font-medium text-foreground">尺寸: </span>{Math.round(single.width)}×{Math.round(single.height)}{single.type === 'video' && single.meta?.durationSec ? ` · ${single.meta.durationSec}s` : ''}</p>
          </div>
        )}

        {single && (
          <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1">
            <input
              value={inlineText}
              onChange={(e) => setInlineText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleInlineSend();
                }
              }}
              placeholder="Type to imagine…"
              className="w-56 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              type="button"
              onClick={handleInlineSend}
              disabled={!inlineText.trim()}
              aria-label="发送"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
            >
              <ArrowUp width={12} height={12} />
            </button>
          </div>
        )}
      </XyNodeToolbar>

      {fullscreenOpen && fullscreenAsset && fullscreenAsset.relPath && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 p-8"
          onClick={() => setFullscreenOpen(false)}
        >
          <button
            type="button"
            onClick={() => setFullscreenOpen(false)}
            aria-label="关闭"
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          >
            <X width={18} height={18} />
          </button>
          {fullscreenAsset.type === 'video' ? (
            <video
              src={`/api/canvases/${fullscreenAsset.canvasId}/asset/${fullscreenAsset.relPath}`}
              controls
              autoPlay
              className="max-h-full max-w-full"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            // Full-res original — no ?w= thumbnail param, this is the one place we want it.
            <img
              src={`/api/canvases/${fullscreenAsset.canvasId}/asset/${fullscreenAsset.relPath}`}
              alt={fullscreenAsset.meta?.prompt || 'canvas asset'}
              className="max-h-full max-w-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </>
  );
}
