'use client';

/**
 * useCanvasWorkspaces — server-backed canvas workspace list (Canvas Agent, D5).
 * Mirrors use-projects.ts's shape, but canvas_workspace is single-owner (no member
 * mutations — there's no addMember/removeMember equivalent).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import {
  listCanvasWorkspaces,
  createCanvasWorkspace as createCanvasWorkspaceFn,
  type CanvasWorkspaceDTO,
} from '~/server/function/canvas.server';

export type { CanvasWorkspaceDTO };

export const CANVAS_WORKSPACES_QUERY_KEY = ['canvas-workspaces', 'list'] as const;

export function useCanvasWorkspaces() {
  const qc = useQueryClient();
  const list = useServerFn(listCanvasWorkspaces);
  const create = useServerFn(createCanvasWorkspaceFn);

  const query = useQuery({
    queryKey: CANVAS_WORKSPACES_QUERY_KEY,
    queryFn: () => list(),
  });

  return {
    workspaces: (query.data ?? []) as CanvasWorkspaceDTO[],
    isLoading: query.isLoading,
    error: query.error,

    async createWorkspace(input: { name: string }): Promise<CanvasWorkspaceDTO> {
      const w = await create({ data: input });
      await qc.invalidateQueries({ queryKey: CANVAS_WORKSPACES_QUERY_KEY });
      return w;
    },
  };
}
