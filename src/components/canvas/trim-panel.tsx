'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { X, ArrowUp } from 'lucide-react';
import { useFilmstrip } from './use-filmstrip';
import { useCanvasStore } from './canvas-store';

interface TrimPanelProps {
  assetId: string;
  canvasId: string;
  relPath: string;
  width: number; // matches the video node's current box width, so the strip lines up
}

const STRIP_HEIGHT = 40;
const HANDLE_WIDTH = 8;

/**
 * Canvas Agent (M3-T2, impl spec §5.4) — trim range picker. Client-side filmstrip
 * (use-filmstrip.ts) + two drag handles over it. Submitting does NOT call ffmpeg from
 * the UI at all — it sends a structured chat message (`Trim from {t0}s to {t1}s.` +
 * the video's own reference block, via the SAME pendingComposerCommand bus node-
 * toolbar.tsx's Animate button already uses) and the Agent runs ffmpeg itself. This
 * mirrors the reference product's observed behavior exactly: "UI 圈参数 → 结构化消息 →
 * Agent 工具执行".
 */
export function TrimPanel({ assetId, canvasId, relPath, width }: TrimPanelProps) {
  const setTrimOpenAssetId = useCanvasStore((s) => s.setTrimOpenAssetId);
  const setPendingComposerCommand = useCanvasStore((s) => s.setPendingComposerCommand);

  const src = useMemo(() => `/api/canvases/${canvasId}/asset/${relPath}`, [canvasId, relPath]);
  const { frames, duration, loading, error } = useFilmstrip(src);

  const [t0, setT0] = useState(0);
  const [t1, setT1] = useState<number | null>(null); // null until duration is known
  const effectiveT1 = t1 ?? duration;

  const stripRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'start' | 'end' | null>(null);

  const clamp = useCallback((v: number) => Math.min(duration, Math.max(0, v)), [duration]);

  const xToTime = useCallback(
    (clientX: number) => {
      const strip = stripRef.current;
      if (!strip) return 0;
      const rect = strip.getBoundingClientRect();
      const fraction = (clientX - rect.left) / rect.width;
      return clamp(fraction * duration);
    },
    [duration, clamp]
  );

  const onPointerDown = useCallback((handle: 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = handle;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current || !duration) return;
      const t = xToTime(e.clientX);
      if (draggingRef.current === 'start') {
        setT0(Math.min(t, effectiveT1 - 0.1));
      } else {
        setT1(Math.max(t, t0 + 0.1));
      }
    },
    [duration, xToTime, effectiveT1, t0]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const handleClose = useCallback(() => setTrimOpenAssetId(null), [setTrimOpenAssetId]);

  const handleSubmit = useCallback(() => {
    if (!duration) return;
    const text = `Trim from ${t0.toFixed(1)}s to ${effectiveT1.toFixed(1)}s.`;
    setPendingComposerCommand({ assetIds: [assetId], text });
    setTrimOpenAssetId(null);
  }, [duration, t0, effectiveT1, assetId, setPendingComposerCommand, setTrimOpenAssetId]);

  const startPct = duration ? (t0 / duration) * 100 : 0;
  const endPct = duration ? (effectiveT1 / duration) * 100 : 100;

  return (
    <div
      className="nodrag nowheel mt-2 flex flex-col gap-1.5 rounded-lg border border-border/70 bg-popover p-2 shadow-md"
      style={{ width }}
      onClick={(e) => e.stopPropagation()}
    >
      {loading && <div className="py-2 text-center text-xs text-muted-foreground">加载帧预览…</div>}
      {error && <div className="py-2 text-center text-xs text-destructive">{error}</div>}
      {!loading && !error && frames.length > 0 && (
        <>
          <div
            ref={stripRef}
            className="relative h-10 select-none overflow-hidden rounded-md"
            style={{ height: STRIP_HEIGHT }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <div className="flex h-full w-full">
              {frames.map((frame, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={frame} alt="" className="h-full flex-1 object-cover" draggable={false} />
              ))}
            </div>
            {/* Dimmed regions outside the selected range */}
            <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/50" style={{ width: `${startPct}%` }} />
            <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/50" style={{ width: `${100 - endPct}%` }} />
            {/* Drag handles */}
            <div
              onPointerDown={onPointerDown('start')}
              className="absolute inset-y-0 cursor-ew-resize bg-primary"
              style={{ left: `calc(${startPct}% - ${HANDLE_WIDTH / 2}px)`, width: HANDLE_WIDTH }}
            />
            <div
              onPointerDown={onPointerDown('end')}
              className="absolute inset-y-0 cursor-ew-resize bg-primary"
              style={{ left: `calc(${endPct}% - ${HANDLE_WIDTH / 2}px)`, width: HANDLE_WIDTH }}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs tabular-nums text-muted-foreground">
              {t0.toFixed(1)}s → {effectiveT1.toFixed(1)}s ({(effectiveT1 - t0).toFixed(1)}s)
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleClose}
                aria-label="关闭"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X width={12} height={12} />
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                aria-label="提交"
                className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground"
              >
                <ArrowUp width={12} height={12} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
