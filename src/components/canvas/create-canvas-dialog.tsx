'use client';

import { useState, useCallback, type KeyboardEvent } from 'react';
import { Palette } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '~/components/ui/dialog';
import { cn } from '~/lib/utils';

interface CreateCanvasDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string }) => void;
}

/** Create-canvas-workspace modal — mirrors create-project-dialog.tsx, just a name field. */
export function CreateCanvasDialog({ open, onOpenChange, onCreate }: CreateCanvasDialogProps) {
  const [name, setName] = useState('');
  const canSubmit = name.trim().length > 0;

  const submit = useCallback(() => {
    if (!canSubmit) return;
    onCreate({ name: name.trim() });
    setName('');
    onOpenChange(false);
  }, [canSubmit, name, onCreate, onOpenChange]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        submit();
      }
    },
    [submit]
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setName('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5 text-muted-foreground" />
            新建画布
          </DialogTitle>
          <DialogDescription>画布是一个独立的创作工作区，用来跟 Agent 一起生成和整理图片/视频。</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label htmlFor="canvas-name" className="text-sm font-medium text-foreground">
            名称
          </label>
          <input
            id="canvas-name"
            type="text"
            value={name}
            // biome-ignore lint/a11y/noAutofocus: modal name field is the primary action
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="例如：历史事件海报"
            className={cn(
              'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
          />
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className={cn(
              'rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            创建
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
