'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { useServerFn } from '@tanstack/react-start';
import { useCanvasStore } from '../canvas-store';
import { updateAssetPos, updateTextNode } from '~/server/function/canvas.server';

export type TextNodeData = {
  canvasId: string;
  content: string;
  color?: string;
  align?: 'left' | 'center' | 'right';
  fontSize?: number;
  width: number;
  height: number;
  /** Set by canvas-toolbar.tsx right after creation so the node opens straight into
   * edit mode instead of requiring a second double-click (PRD F9.4: "点击 T 按钮 →
   * 画布点击落一个文本节点...直接输入"). Consumed once, then cleared locally. */
  autoEdit?: boolean;
};

const SAVE_DEBOUNCE_MS = 500;

/**
 * Canvas text node (D2/F9.4). Double-click (or `autoEdit` right after creation) enters
 * edit mode; blur/Escape commits. Content is the single field that matters for F9.4's
 * "referenceable by the Agent" requirement — color/align/fontSize are display-only.
 */
function TextNodeComponent({ id, data, selected }: NodeProps & { data: TextNodeData }) {
  const asset = useCanvasStore((s) => s.assets[id]);
  const upsertAsset = useCanvasStore((s) => s.upsertAsset);
  const persistSize = useServerFn(updateAssetPos);
  const persistText = useServerFn(updateTextNode);

  const [isEditing, setIsEditing] = useState(Boolean(data.autoEdit));
  const [draft, setDraft] = useState(data.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (isEditing) textareaRef.current?.focus();
  }, [isEditing]);

  // If a broadcasted asset_updated event lands (another tab edited this note) while
  // we're not mid-edit here, pick up the new content instead of showing stale text.
  useEffect(() => {
    if (!isEditing) setDraft(data.content);
  }, [data.content, isEditing]);

  const scheduleSave = useCallback(
    (content: string) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persistText({
          data: { assetId: id, content, color: data.color, align: data.align, fontSize: data.fontSize },
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [id, persistText, data.color, data.align, data.fontSize]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const content = e.target.value;
      setDraft(content);
      if (asset) upsertAsset({ ...asset, meta: { ...asset.meta, text: { ...asset.meta?.text, content } } });
      scheduleSave(content);
    },
    [asset, upsertAsset, scheduleSave]
  );

  const commitAndExit = useCallback(() => {
    setIsEditing(false);
    clearTimeout(saveTimer.current);
    void persistText({
      data: { assetId: id, content: draft, color: data.color, align: data.align, fontSize: data.fontSize },
    });
  }, [id, draft, persistText, data.color, data.align, data.fontSize]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        commitAndExit();
      }
    },
    [commitAndExit]
  );

  const handleResizeEnd = useCallback(
    (_event: unknown, params: { x: number; y: number; width: number; height: number }) => {
      if (!asset) return;
      upsertAsset({ ...asset, posX: params.x, posY: params.y, width: params.width, height: params.height });
      void persistSize({ data: { assetId: id, posX: params.x, posY: params.y, width: params.width, height: params.height } });
    },
    [id, asset, upsertAsset, persistSize]
  );

  const align = data.align ?? 'left';
  const fontSize = data.fontSize ?? 16;

  return (
    <>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={60} onResizeEnd={handleResizeEnd} />
      <div
        style={{ width: data.width, height: data.height, color: data.color }}
        className={`nodrag nowheel overflow-hidden rounded-lg border bg-background p-3 shadow-sm ${
          selected ? 'border-primary ring-2 ring-primary' : 'border-border/60'
        }`}
        onDoubleClick={() => setIsEditing(true)}
      >
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={handleChange}
            onBlur={commitAndExit}
            onKeyDown={handleKeyDown}
            placeholder="Type here…"
            style={{ fontSize, textAlign: align }}
            className="h-full w-full resize-none border-none bg-transparent outline-none placeholder:text-muted-foreground"
          />
        ) : (
          <div
            style={{ fontSize, textAlign: align }}
            className="h-full w-full overflow-hidden whitespace-pre-wrap break-words text-foreground"
          >
            {draft || <span className="text-muted-foreground">Type here…</span>}
          </div>
        )}
      </div>
    </>
  );
}

export const TextNode = memo(TextNodeComponent);
