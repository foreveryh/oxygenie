'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MousePointer2, Hand, Type, ImageIcon, VideoIcon, Upload, Loader2 } from 'lucide-react';
import { useCanvasStore, type CanvasTool } from './canvas-store';

function ToolButton({
  tool,
  activeTool,
  onSelect,
  label,
  shortcut,
  Icon,
}: {
  tool: CanvasTool;
  activeTool: CanvasTool;
  onSelect: (tool: CanvasTool) => void;
  label: string;
  shortcut?: string;
  Icon: typeof MousePointer2;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(tool)}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={activeTool === tool}
      className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
        activeTool === tool ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      <Icon width={17} height={17} />
    </button>
  );
}

interface CanvasToolbarProps {
  canvasId: string;
}

/**
 * Canvas Agent (F9.1) — bottom mode-switcher toolbar. Select/Hand/Text arm a canvas
 * interaction mode; Image/Video arm direct-gen-bar.tsx's floating parameter bar
 * (F9.2/9.3); Upload (F9.5) is a direct action (file picker → POST), not a mode.
 *
 * ToolButton is a module-level component (NOT defined inline via useCallback — an
 * earlier version did that, which gives every activeTool change a new function
 * identity and makes React treat it as a different component type, remounting the
 * whole button subtree on every click and dropping the click that caused it).
 */
export function CanvasToolbar({ canvasId }: CanvasToolbarProps) {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const upsertAsset = useCanvasStore((s) => s.upsertAsset);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        setActiveTool('select');
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setActiveTool('hand');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setActiveTool]);

  const handleUploadClick = useCallback(() => {
    setUploadError(null);
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-selecting the same file next time
      if (!file) return;
      setUploading(true);
      setUploadError(null);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(`/api/canvases/${canvasId}/upload`, { method: 'POST', body: formData });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `Upload failed (${response.status})`);
        }
        const { asset } = await response.json();
        upsertAsset(asset);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [canvasId, upsertAsset]
  );

  return (
    <div className="flex flex-col items-center gap-1.5">
      {uploadError && (
        <div className="pointer-events-auto rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{uploadError}</div>
      )}
      <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border/70 bg-popover p-1.5 shadow-md">
        <ToolButton tool="select" activeTool={activeTool} onSelect={setActiveTool} label="Select" shortcut="⌘S" Icon={MousePointer2} />
        <ToolButton tool="hand" activeTool={activeTool} onSelect={setActiveTool} label="Hand Tool" shortcut="⌘P" Icon={Hand} />
        <div className="mx-0.5 h-5 w-px bg-border" />
        <ToolButton tool="text" activeTool={activeTool} onSelect={setActiveTool} label="Text" Icon={Type} />
        <ToolButton tool="image" activeTool={activeTool} onSelect={setActiveTool} label="Generate Image" Icon={ImageIcon} />
        <ToolButton tool="video" activeTool={activeTool} onSelect={setActiveTool} label="Generate Video" Icon={VideoIcon} />
        <div className="mx-0.5 h-5 w-px bg-border" />
        <button
          type="button"
          onClick={handleUploadClick}
          disabled={uploading}
          title="Upload"
          aria-label="Upload"
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {uploading ? <Loader2 width={17} height={17} className="animate-spin" /> : <Upload width={17} height={17} />}
        </button>
        <input ref={fileInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleFileSelected} />
      </div>
    </div>
  );
}
