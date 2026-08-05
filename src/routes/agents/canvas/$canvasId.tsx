import { createFileRoute } from '@tanstack/react-router';
import { ClaudeChatController } from '~/components/claude-chat/claude-chat-controller';
import type { PermissionInfo } from '~/components/claude-chat/permission-badge';
import { getPermissionInfo } from '~/server/permissions.server';
import { ensureDefaultSkillsFn } from '~/server/function/skills.server';
import { getCanvasWorkspace, listCanvasAssets } from '~/server/function/canvas.server';
import { CanvasRoot } from '~/components/canvas/canvas-root';

/**
 * Canvas workspace page (D5): left chat panel (reuses ClaudeChatController, same as
 * project chats) + right infinite canvas. One ambient session per workspace in this
 * slice — no session list/switcher (showInternalSessionList=false), matching how a
 * "new chat in <project>" page works minus the project session history.
 */
export const Route = createFileRoute('/agents/canvas/$canvasId')({
  component: CanvasWorkspacePage,
  loader: async ({ params }) => {
    const [permissionInfo, workspace, assets] = await Promise.all([
      getPermissionInfo(),
      getCanvasWorkspace({ data: { canvasId: params.canvasId } }),
      listCanvasAssets({ data: { canvasId: params.canvasId } }),
      ensureDefaultSkillsFn().catch((error) => {
        console.warn('[Skills] ensureDefaultSkills failed (non-fatal):', error);
        return null;
      }),
    ]);
    return { permissionInfo: permissionInfo as PermissionInfo, workspace, assets };
  },
});

function CanvasWorkspacePage() {
  const { canvasId } = Route.useParams();
  const { permissionInfo, workspace, assets } = Route.useLoaderData();

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex w-[420px] shrink-0 flex-col border-r border-border/60">
        <div className="border-b border-border/60 px-4 py-3">
          <h1 className="truncate font-medium text-foreground">{workspace.name}</h1>
        </div>
        <div className="min-h-0 flex-1">
          <ClaudeChatController
            permissionInfo={permissionInfo}
            canvasId={canvasId}
            newChat
            showInternalSessionList={false}
          />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <CanvasRoot canvasId={canvasId} initialAssets={assets} />
      </div>
    </div>
  );
}
