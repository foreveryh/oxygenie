import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Palette, Plus } from 'lucide-react';
import { Input } from '~/components/ui/input';
import { Button } from '~/components/ui/button';
import { CreateCanvasDialog } from '~/components/canvas/create-canvas-dialog';
import { useCanvasWorkspaces, type CanvasWorkspaceDTO } from '~/lib/hooks/use-canvas-workspaces';

export const Route = createFileRoute('/agents/canvas/')({
  component: CanvasIndex,
});

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const days = Math.floor(diff / 86400);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

/**
 * Canvas workspace landing (D5): card grid of the user's canvas workspaces. Unlike
 * Projects, this is single-owner — no member avatars, no sharing.
 */
function CanvasIndex() {
  const navigate = useNavigate();
  const { workspaces, isLoading, createWorkspace } = useCanvasWorkspaces();
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const filtered = workspaces.filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()));

  const handleCreate = async ({ name }: { name: string }) => {
    const workspace = await createWorkspace({ name });
    navigate({ to: '/agents/canvas/$canvasId', params: { canvasId: workspace.id } });
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 py-8">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-foreground">画布</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          新建画布
        </Button>
      </div>

      <div className="relative mb-6">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索画布…" />
      </div>

      {isLoading && workspaces.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">加载中…</p>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <Palette className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium text-foreground">还没有画布</p>
            <p className="mt-1 text-sm text-muted-foreground">新建一个画布，跟 Agent 一起生成图片/视频</p>
          </div>
          {!q && (
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              新建画布
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((workspace) => (
            <CanvasCard
              key={workspace.id}
              workspace={workspace}
              onOpen={() => navigate({ to: '/agents/canvas/$canvasId', params: { canvasId: workspace.id } })}
            />
          ))}
        </div>
      )}

      <CreateCanvasDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={handleCreate} />
    </div>
  );
}

function CanvasCard({ workspace, onOpen }: { workspace: CanvasWorkspaceDTO; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background p-4 text-left transition-colors hover:border-border hover:bg-accent/40"
    >
      <div className="flex items-center gap-2">
        <Palette className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{workspace.name}</span>
      </div>
      <div className="mt-auto flex items-center justify-end pt-1">
        <span className="text-xs text-muted-foreground">{timeAgo(workspace.createdAt)}</span>
      </div>
    </button>
  );
}
