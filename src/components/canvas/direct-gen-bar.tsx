'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { ArrowUp, X } from 'lucide-react';
import { useCanvasStore } from './canvas-store';
import { directGenerate, getGenerationTask, getMediaGenerationCapabilities } from '~/server/function/canvas.server';
import { isMediaParameterCombinationAllowed, modeSupportsMediaTypes } from '~/claude/media-gen/media-capabilities';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60_000; // video generation is minute-scale; give it real headroom

interface DirectGenBarProps {
  canvasId: string;
}

type GenerationCapabilities = {
  aspects: string[];
  count?: number[];
  durationSeconds?: number[];
  resolutions?: string[];
  firstFrame?: boolean;
  lastFrame?: boolean;
  aspectFromFirstFrame?: boolean;
  modes?: GenerationMode[];
  parameterCombinations?: Array<{
    mode?: string;
    resolution?: string;
    aspects?: string[];
    durationSeconds?: number[];
  }>;
};

type MediaType = 'image' | 'video' | 'audio';
type ReferenceRole = 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio' | 'edit_source';
type GenerationInputSlot = { role: ReferenceRole; accepts: MediaType[]; min: number; max: number };
type GenerationMode = { id: string; label: string; inputs: GenerationInputSlot[]; aspectBehavior?: 'select' | 'input' | 'adaptive'; minInputs?: number };

type GenerationModel = { id: string; label: string; adapter: string; capabilities: GenerationCapabilities };

function assignReferences(
  mode: GenerationMode | undefined,
  selected: Array<{ id: string; type: MediaType }>,
): Array<{ assetId: string; role: ReferenceRole }> {
  if (!mode) return [];
  const used = new Map<ReferenceRole, number>();
  return selected.flatMap((asset) => {
    const slot = mode.inputs.find((candidate) => candidate.accepts.includes(asset.type) && (used.get(candidate.role) || 0) < candidate.max);
    if (!slot) return [];
    used.set(slot.role, (used.get(slot.role) || 0) + 1);
    return [{ assetId: asset.id, role: slot.role }];
  });
}

function modelsSupporting(
  models: GenerationModel[],
  field: 'aspects' | 'count' | 'durationSeconds' | 'resolutions',
  value: string | number,
): string[] {
  return models
    .filter((model) => (model.capabilities[field] || []).includes(value as never))
    .map((model) => model.label);
}

function unionOptions<T extends string | number>(
  models: GenerationModel[],
  field: 'aspects' | 'count' | 'durationSeconds' | 'resolutions',
): T[] {
  return [...new Set(models.flatMap((model) => (model.capabilities[field] || []) as T[]))];
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
  const getCapabilitiesFn = useServerFn(getMediaGenerationCapabilities);

  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [aspect, setAspect] = useState<string>('1:1');
  const [resolution, setResolution] = useState<string>('720p');
  const [durationSec, setDurationSec] = useState<number>(6);
  const [generationCapabilities, setGenerationCapabilities] = useState<GenerationCapabilities | null>(null);
  const [generationModels, setGenerationModels] = useState<GenerationModel[]>([]);
  const [modelId, setModelId] = useState('');
  const [modeId, setModeId] = useState('text_to_video');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilityNotice, setCapabilityNotice] = useState<string | null>(null);
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const isVideoMode = activeTool === 'video';
  const isOpen = activeTool === 'image' || activeTool === 'video';

  const selectedMediaAssets = isVideoMode
    ? selectedAssetIds
        .map((id) => assets[id])
        .filter((asset): asset is NonNullable<typeof asset> & { type: MediaType } =>
          Boolean(asset) && (asset.type === 'image' || asset.type === 'video' || asset.type === 'audio'))
    : [];
  const selectedMediaTypes = selectedMediaAssets.map((asset) => asset.type);
  const compatibleModes = (generationCapabilities?.modes || []).filter((mode) => modeSupportsMediaTypes(mode, selectedMediaTypes));
  const selectedMode = compatibleModes.find((mode) => mode.id === modeId);
  const requestReferences = assignReferences(selectedMode, selectedMediaAssets);
  const hasIncompatibleReferences = isVideoMode && selectedMediaAssets.length > 0 && compatibleModes.length === 0;
  const aspectIsDerivedFromFrame = isVideoMode && selectedMode?.aspectBehavior === 'input';
  const referenceSignature = selectedMediaAssets.map((asset) => `${asset.id}:${asset.type}`).join('|');
  const parameterCombinationIsValid = !generationCapabilities || !isVideoMode || isMediaParameterCombinationAllowed(
    generationCapabilities,
    { mode: selectedMode?.id, resolution, durationSeconds: durationSec, aspect },
  );

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setGenerationCapabilities(null);
    void getCapabilitiesFn({ data: { capability: isVideoMode ? 'video' : 'image' } })
      .then(({ defaultModelId, models }) => {
        if (cancelled) return;
        const available = models as GenerationModel[];
        const selected = available.find((model) => model.id === defaultModelId) || available[0];
        if (!selected) throw new Error(`没有可用的${isVideoMode ? '视频' : '图片'}模型`);
        setGenerationModels(available);
        setModelId(selected.id);
        const caps = selected.capabilities;
        setGenerationCapabilities(caps);
        setAspect((previous) => caps.aspects.includes(previous) ? previous : (caps.aspects[0] || ''));
        if (caps.count?.length) setCount((previous) => caps.count?.includes(previous) ? previous : caps.count![0]);
        if (caps.durationSeconds?.length) setDurationSec((previous) => caps.durationSeconds?.includes(previous) ? previous : caps.durationSeconds![0]);
        if (caps.resolutions?.length) setResolution((previous) => caps.resolutions?.includes(previous) ? previous : caps.resolutions![0]);
      })
      .catch((err) => {
        if (!cancelled) {
          setGenerationModels([]);
          setModelId('');
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => { cancelled = true; };
  }, [isOpen, isVideoMode, getCapabilitiesFn]);

  useEffect(() => {
    if (!isVideoMode || !generationCapabilities) return;
    const candidates = (generationCapabilities.modes || []).filter((mode) => modeSupportsMediaTypes(mode, selectedMediaTypes));
    if (candidates.some((mode) => mode.id === modeId)) return;
    const nextMode = selectedMediaTypes.length === 0
      ? candidates.find((mode) => mode.id === 'text_to_video')
      : candidates.find((mode) => mode.id !== 'text_to_video');
    setModeId(nextMode?.id || '');
  }, [isVideoMode, generationCapabilities, referenceSignature, modeId]);

  useEffect(() => {
    if (!isVideoMode || !generationCapabilities || parameterCombinationIsValid) return;
    for (const nextResolution of generationCapabilities.resolutions || [resolution]) {
      for (const nextDuration of generationCapabilities.durationSeconds || [durationSec]) {
        if (isMediaParameterCombinationAllowed(generationCapabilities, {
          mode: selectedMode?.id,
          resolution: nextResolution,
          durationSeconds: nextDuration,
          aspect,
        })) {
          setResolution(nextResolution);
          setDurationSec(nextDuration);
          setCapabilityNotice(`已按“${selectedMode?.label || '当前模式'}”调整为 ${nextResolution} / ${nextDuration}s`);
          return;
        }
      }
    }
  }, [isVideoMode, generationCapabilities, selectedMode?.id, selectedMode?.label, resolution, durationSec, aspect, parameterCombinationIsValid]);

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
    if (!prompt.trim() || submitting || !generationCapabilities) return;
    if (hasIncompatibleReferences || (isVideoMode && !selectedMode)) {
      setError('当前模型无法使用已选择的 References，请移除不兼容素材或切换模型');
      return;
    }
    if (!parameterCombinationIsValid) {
      setError('当前模型不支持所选参数组合');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const kind = isVideoMode
        ? requestReferences.some((reference) => selectedMediaAssets.find((asset) => asset.id === reference.assetId)?.type === 'video')
          ? 'v2v'
          : requestReferences.some((reference) => selectedMediaAssets.find((asset) => asset.id === reference.assetId)?.type === 'image')
            ? 'i2v'
            : 't2v'
        : 't2i';
      const result = await directGenerateFn({
        data: {
          canvasId,
          kind,
          modelId,
          prompt: prompt.trim(),
          ...(isVideoMode
            ? {
                ...(!aspectIsDerivedFromFrame && aspect ? { aspect } : {}),
                ...(generationCapabilities.resolutions?.length ? { resolution } : {}),
                ...(generationCapabilities.durationSeconds?.length ? { durationSec } : {}),
                mode: selectedMode?.id as 'text_to_video' | 'first_last_frame' | 'reference' | 'video_edit',
                references: requestReferences,
              }
            : { ...(aspect ? { aspect } : {}), ...(generationCapabilities.count?.length ? { count } : {}) }),
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
    selectedMediaAssets,
    selectedMode,
    requestReferences,
    hasIncompatibleReferences,
    parameterCombinationIsValid,
    aspectIsDerivedFromFrame,
    directGenerateFn,
    canvasId,
    aspect,
    resolution,
    durationSec,
    count,
    modelId,
    generationCapabilities,
    upsertTask,
    pollTask,
    setActiveTool,
  ]);

  if (!isOpen) return null;

  const countOptions = unionOptions<number>(generationModels, 'count');
  const aspectOptions = unionOptions<string>(generationModels, 'aspects');
  const resolutionOptions = unionOptions<string>(generationModels, 'resolutions');
  const durationOptions = unionOptions<number>(generationModels, 'durationSeconds').sort((a, b) => a - b);
  const compatibleReferenceModels = selectedMediaTypes.length
    ? generationModels
        .filter((model) => (model.capabilities.modes || []).some((mode) => modeSupportsMediaTypes(mode, selectedMediaTypes)))
        .map((model) => model.label)
    : [];

  return (
    <div className="pointer-events-auto flex w-[420px] flex-col gap-2 rounded-lg border border-border/70 bg-popover p-3 shadow-md">
      {isVideoMode && (
        <div className="rounded-md bg-muted/70 px-2 py-1.5 text-xs text-muted-foreground">
          {!generationCapabilities
            ? '正在读取当前模型支持的参数…'
            : hasIncompatibleReferences
              ? `当前模型无法使用所选 References${compatibleReferenceModels.length ? `；可切换至 ${compatibleReferenceModels.join(' / ')}` : ''}`
              : selectedMediaAssets.length > 0
                ? `References：${selectedMediaAssets.length} 个素材 · 用途：${selectedMode?.label || '请选择'}`
                : '未选择素材，将使用文生视频模式'}
        </div>
      )}
      {error && <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</div>}
      {capabilityNotice && <div className="rounded-md bg-muted/70 px-2 py-1.5 text-xs text-muted-foreground">{capabilityNotice}</div>}
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
        {generationModels.length > 0 && (
          <select
            value={modelId}
            onChange={(event) => {
              const selected = generationModels.find((model) => model.id === event.target.value);
              if (!selected) return;
              setModelId(selected.id);
              setCapabilityNotice(null);
              setGenerationCapabilities(selected.capabilities);
              setAspect(selected.capabilities.aspects[0] || aspectOptions[0] || '');
              setCount(selected.capabilities.count?.[0] || countOptions[0] || 1);
              setResolution(selected.capabilities.resolutions?.[0] || resolutionOptions[0] || '');
              setDurationSec(selected.capabilities.durationSeconds?.[0] || durationOptions[0] || 1);
            }}
            aria-label="生成模型"
            className="h-7 max-w-40 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
          >
            {generationModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        )}
        {isVideoMode && selectedMediaAssets.length > 0 && compatibleModes.length > 1 && (
          <select
            value={modeId}
            onChange={(event) => { setCapabilityNotice(null); setModeId(event.target.value); }}
            aria-label="素材用途"
            className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
          >
            {compatibleModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
          </select>
        )}
        {!isVideoMode && generationCapabilities && countOptions.length > 0 && (
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            aria-label="张数"
            className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
          >
            {countOptions.map((n) => {
              const supported = generationCapabilities.count?.includes(n);
              const required = modelsSupporting(generationModels, 'count', n);
              return <option key={n} value={n} disabled={!supported}>{n} 张{!supported ? `（需 ${required.join(' / ')}）` : ''}</option>;
            })}
          </select>
        )}
        {generationCapabilities && aspectOptions.length > 0 && !aspectIsDerivedFromFrame ? <select
          value={aspect}
          onChange={(e) => setAspect(e.target.value)}
          aria-label="比例"
          className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
        >
          {aspectOptions.map((a) => {
            const supported = generationCapabilities.aspects.includes(a);
            const required = modelsSupporting(generationModels, 'aspects', a);
            return <option key={a} value={a} disabled={!supported}>{a}{!supported ? `（需 ${required.join(' / ')}）` : ''}</option>;
          })}
        </select> : null}
        {isVideoMode && (
          <>
            {generationCapabilities && resolutionOptions.length > 0 ? <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              aria-label="分辨率"
              className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
            >
              {resolutionOptions.map((r) => {
                const supported = generationCapabilities.resolutions?.includes(r)
                  && isMediaParameterCombinationAllowed(generationCapabilities, {
                    mode: selectedMode?.id, resolution: r, durationSeconds: durationSec, aspect,
                  });
                const required = modelsSupporting(generationModels, 'resolutions', r);
                return <option key={r} value={r} disabled={!supported}>{r}{!supported ? `（需 ${required.join(' / ')}）` : ''}</option>;
              })}
            </select> : null}
            {generationCapabilities && durationOptions.length > 0 ? <select
              value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))}
              aria-label="时长"
              className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground"
            >
              {durationOptions.map((d) => {
                const supported = generationCapabilities.durationSeconds?.includes(d)
                  && isMediaParameterCombinationAllowed(generationCapabilities, {
                    mode: selectedMode?.id, resolution, durationSeconds: d, aspect,
                  });
                const required = modelsSupporting(generationModels, 'durationSeconds', d);
                return <option key={d} value={d} disabled={!supported}>{d}s{!supported ? `（需 ${required.join(' / ')}）` : ''}</option>;
              })}
            </select> : null}
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
          disabled={!prompt.trim() || submitting || !generationCapabilities || hasIncompatibleReferences || !parameterCombinationIsValid || (isVideoMode && !selectedMode)}
          aria-label="提交"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
        >
          <ArrowUp width={14} height={14} />
        </button>
      </div>
    </div>
  );
}
