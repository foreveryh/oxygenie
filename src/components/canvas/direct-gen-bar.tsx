'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { ArrowUp, X } from 'lucide-react';
import { useCanvasStore } from './canvas-store';
import { directGenerate, getGenerationTask } from '~/server/function/canvas.server';

const IMAGE_ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
const VIDEO_ASPECTS = ['16:9', '9:16'] as const;
const VIDEO_DURATIONS = [4, 6, 8] as const;
const VIDEO_RESOLUTIONS = ['720p', '1080p'] as const;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60_000; // video generation is minute-scale; give it real headroom

interface DirectGenBarProps {
  canvasId: string;
}

/**
 * Canvas Agent (F9.2/9.3) — floating parameter bar for image/video direct-gen mode.
 * Rendered by canvas-root.tsx whenever canvasStore.activeTool is 'image' or 'video'
 * (armed by canvas-toolbar.tsx). Submits via directGenerate, then polls
 * getGenerationTask until done/failed (no cross-process WS push for the direct path —
 * see generation-queue.ts's header comment).
 */
export function DirectGenBar({ canvasId }: DirectGenBarProps) {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds);
  const assets = useCanvasStore((s) => s.assets);
  const upsertTask = useCanvasStore((s) => s.upsertTask);
  const upsertAsset = useCanvasStore((s) => s.upsertAsset);

  const directGenerateFn = useServerFn(directGenerate);
  const getGenerationTaskFn = useServerFn(getGenerationTask);

  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [aspect, setAspect] = useState<string>('1:1');
  const [resolution, setResolution] = useState<string>('720p');
  const [durationSec, setDurationSec] = useState<number>(6);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const isVideoMode = activeTool === 'video';
  const isOpen = activeTool === 'image' || activeTool === 'video';

  // F9.3: video mode's reference images — image nodes selected on the canvas (i2v);
  // none selected → plain text-to-video.
  const referenceImageIds = selectedAssetIds.filter((id) => assets[id]?.type === 'image');

  useEffect(() => {
    // Reset aspect default when switching modes (video's default is landscape, image's
    // is square — different valid-value sets per VIDEO_ASPECTS/IMAGE_ASPECTS).
    setAspect(isVideoMode ? '16:9' : '1:1');
  }, [isVideoMode]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(pollTimers.current)) clearInterval(timer);
    };
  }, []);

  const pollTask = useCallback(
    (taskId: string) => {
      const startedAt = Date.now();
      const timer = setInterval(async () => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          clearInterval(timer);
          delete pollTimers.current[taskId];
          upsertTask({ id: taskId, status: 'failed', error: 'Timed out waiting for generation' });
          return;
        }
        try {
          const result = await getGenerationTaskFn({ data: { taskId } });
          if (result.task.status === 'done') {
            clearInterval(timer);
            delete pollTimers.current[taskId];
            for (const asset of result.assets) upsertAsset(asset);
            useCanvasStore.getState().removeTask(taskId);
          } else if (result.task.status === 'failed') {
            clearInterval(timer);
            delete pollTimers.current[taskId];
            upsertTask({ id: taskId, status: 'failed', error: result.task.error || 'Generation failed' });
          }
          // 'queued'/'running' → keep polling, nothing to update (placeholder already shown).
        } catch (err) {
          console.error('[DirectGenBar] poll failed:', err);
          // Transient error — keep polling until POLL_TIMEOUT_MS gives up.
        }
      }, POLL_INTERVAL_MS);
      pollTimers.current[taskId] = timer;
    },
    [getGenerationTaskFn, upsertTask, upsertAsset]
  );

  const handleCancel = useCallback(() => {
    setActiveTool('select');
    setPrompt('');
    setError(null);
  }, [setActiveTool]);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const kind = isVideoMode ? (referenceImageIds.length > 0 ? 'i2v' : 't2v') : 't2i';
      const result = await directGenerateFn({
        data: {
          canvasId,
          kind,
          prompt: prompt.trim(),
          ...(isVideoMode
            ? { aspect, resolution, durationSec, inputAssetIds: referenceImageIds.slice(0, 1) }
            : { aspect, count }),
        },
      });
      upsertTask({
        id: result.taskId,
        status: 'running',
        reservedPositions: result.reservedPositions,
        kind,
        params: { prompt: prompt.trim(), count, aspect },
      });
      pollTask(result.taskId);
      setPrompt('');
      setActiveTool('select');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    prompt,
    submitting,
    isVideoMode,
    referenceImageIds,
    directGenerateFn,
    canvasId,
    aspect,
    resolution,
    durationSec,
    count,
    upsertTask,
    pollTask,
    setActiveTool,
  ]);

  if (!isOpen) return null;

  return (
    <div className="pointer-events-auto flex w-[420px] flex-col gap-2 rounded-lg border border-border/70 bg-popover p-3 shadow-md">
      {isVideoMode && (
        <div className="rounded-md bg-muted/70 px-2 py-1.5 text-xs text-muted-foreground">
          {referenceImageIds.length > 0
            ? `已选中 ${referenceImageIds.length} 张图片作为首帧参考`
            : 'Select one or more image nodes to animate — 不选则纯文生视频'}
        </div>
      )}
      {error && <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</div>}
      <div className="flex items-end gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={isVideoMode ? 'Describe a video to generate…' : 'Describe an image to generate…'}
          rows={2}
          className="flex-1 resize-none rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!isVideoMode && (
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            aria-label="张数"
            className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>{n} 张</option>
            ))}
          </select>
        )}
        <select
          value={aspect}
          onChange={(e) => setAspect(e.target.value)}
          aria-label="比例"
          className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
        >
          {(isVideoMode ? VIDEO_ASPECTS : IMAGE_ASPECTS).map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        {isVideoMode && (
          <>
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              aria-label="分辨率"
              className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
            >
              {VIDEO_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <select
              value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))}
              aria-label="时长"
              className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
            >
              {VIDEO_DURATIONS.map((d) => (
                <option key={d} value={d}>{d}s</option>
              ))}
            </select>
          </>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleCancel}
          aria-label="取消"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X width={14} height={14} />
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!prompt.trim() || submitting}
          aria-label="提交"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
        >
          <ArrowUp width={14} height={14} />
        </button>
      </div>
    </div>
  );
}
