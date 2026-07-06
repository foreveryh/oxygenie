/**
 * Agent Session Schema
 *
 * Stores metadata for Claude Agent SDK sessions.
 * The actual conversation content is stored in JSONL files managed by the SDK.
 * This table provides:
 * - User-to-session mapping for access control
 * - Session titles and favorites for UI
 * - Quick lookup without scanning filesystem
 */

import { pgTable, text, boolean, timestamp, uuid, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { user } from './auth.schema';
import { project } from './project.schema';
import { canvasWorkspace } from './canvas.schema';
import { createdAt, updatedAt } from './_shared';

export const agentSession = pgTable('agent_session', {
  // Primary key - our internal ID
  id: uuid('id').primaryKey().defaultRandom(),

  // User association - foreign key to user table
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),

  // Project association (Projects P1). null = personal / loose chat (the "最近" area);
  // a non-null projectId means the session belongs to that Project and is visible to
  // all its members (access resolved via canSeeSession, never a raw WHERE user_id).
  projectId: uuid('project_id').references(() => project.id, { onDelete: 'set null' }),

  // Canvas workspace association (Canvas Agent D5). Mutually exclusive with projectId —
  // a canvas session is never inside a (multi-member) Project. null = not a canvas
  // session. Non-null means cwd resolves to the SHARED canvas workspace directory
  // (getCanvasWorkspace), not a per-session directory — see ws-server.mjs. Visibility is
  // owner-only (canvas_workspace has no member table); visibleSessionsWhere() in
  // src/server/projects/access.ts must exclude non-null canvasId from the personal/loose
  // listing so canvas sessions don't leak into the "最近" rail.
  canvasId: uuid('canvas_id').references(() => canvasWorkspace.id, { onDelete: 'cascade' }),

  // Branch lineage (Projects P3 — 续聊即分支): when a non-owner replies to a shared
  // session, we forkSession() the SDK transcript into a NEW session for them and set this
  // to the source session's id. Self-FK; if the source is deleted, this falls back to null.
  branchedFromSessionId: uuid('branched_from_session_id').references(
    (): AnyPgColumn => agentSession.id,
    { onDelete: 'set null' }
  ),

  // SDK session ID (our workspace session ID, used for directory paths)
  sdkSessionId: text('sdk_session_id').notNull(),

  // Real SDK session ID (the actual session ID from Claude Agent SDK for resume)
  realSdkSessionId: text('real_sdk_session_id'),

  // Session title (extracted from first user message or AI-generated)
  title: text('title'),

  // CLAUDE_HOME path for this user (to locate JSONL files)
  claudeHomePath: text('claude_home_path').notNull(),

  // Favorite flag for pinning sessions
  favorite: boolean('favorite').default(false).notNull(),

  // Last message timestamp (for sorting by activity)
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),

  // Standard timestamps
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => ({
  // Index for user session queries
  userIdx: index('idx_agent_session_user').on(table.userId),

  // Index for project session queries (list a Project's shared sessions)
  projectIdx: index('idx_agent_session_project').on(table.projectId),

  // Index for canvas workspace session queries
  canvasIdx: index('idx_agent_session_canvas').on(table.canvasId),

  // Index for sorting by update time
  updatedIdx: index('idx_agent_session_updated').on(table.updatedAt),

  // Unique constraint: same user cannot have duplicate SDK session IDs
  uniqueUserSession: uniqueIndex('idx_agent_session_user_sdk').on(table.userId, table.sdkSessionId),
}));

// Type exports for use in application code
export type AgentSession = typeof agentSession.$inferSelect;
export type NewAgentSession = typeof agentSession.$inferInsert;
