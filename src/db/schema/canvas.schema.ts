/**
 * Canvas Schema (Canvas Agent — D5: independent top-level entity, NOT a Project)
 *
 * `canvas_workspace` is a single-owner creative workspace (no member table — unlike
 * `project`, which is a multi-member collaboration container). Each workspace has one
 * shared sandbox directory; any agent session opened against it shares that sandbox
 * (agent_session.canvasId, see migration). Visibility is owner-only: no `canAccessSession`
 * changes needed (projectId==null already means owner-only), but `visibleSessionsWhere`
 * in src/server/projects/access.ts must exclude canvasId sessions from the personal/loose
 * chat listing (see access.ts comment).
 */

import { pgTable, text, uuid, real, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { user } from './auth.schema';
import { createdAt } from './_shared';

export const canvasWorkspace = pgTable('canvas_workspace', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: createdAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  ownerIdx: index('idx_canvas_workspace_owner').on(table.ownerUserId),
}));

export type CanvasAssetMeta = {
  width?: number;
  height?: number;
  durationSec?: number;
  prompt?: string;
  model?: string;
  origin?: 'agent' | 'direct' | 'upload';
  text?: { content: string; color?: string; align?: 'left' | 'center' | 'right'; fontSize?: number };
};

export const canvasAsset = pgTable('canvas_asset', {
  // = media filename (UUID). Text nodes mirror the same id as notes/{id}.md (v2, not in this slice).
  id: uuid('id').primaryKey(),
  canvasId: uuid('canvas_id')
    .notNull()
    .references(() => canvasWorkspace.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['image', 'video', 'text'] }).notNull(),
  relPath: text('rel_path'),
  meta: jsonb('meta').$type<CanvasAssetMeta>().default({}),
  posX: real('pos_x').notNull(),
  posY: real('pos_y').notNull(),
  width: real('width').notNull(),
  height: real('height').notNull(),
  groupId: uuid('group_id'),
  sourceAssetIds: uuid('source_asset_ids').array().default([]),
  status: text('status', { enum: ['placeholder', 'generating', 'ready'] }).notNull().default('ready'),
  createdByTask: uuid('created_by_task'),
  createdAt: createdAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  canvasIdx: index('idx_canvas_asset_canvas').on(table.canvasId),
}));

export type GenerationTaskParams = {
  prompt?: string;
  count?: number;
  aspect?: string;
  resolution?: string;
  durationSec?: number;
};

export const generationTask = pgTable('generation_task', {
  id: uuid('id').primaryKey().defaultRandom(),
  canvasId: uuid('canvas_id')
    .notNull()
    .references(() => canvasWorkspace.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'), // direct-generation tasks (v2) have no session; null for now (agent-only in this slice)
  origin: text('origin', { enum: ['agent', 'direct'] }).notNull(),
  kind: text('kind', { enum: ['t2i', 'i2i', 't2v', 'i2v', 'v2v'] }).notNull(),
  modelSlug: text('model_slug'),
  params: jsonb('params').$type<GenerationTaskParams>().default({}),
  inputAssetIds: uuid('input_asset_ids').array().default([]),
  reservedSlots: integer('reserved_slots').array().default([]),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull().default('queued'),
  error: text('error'),
  createdAt: createdAt(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => ({
  canvasIdx: index('idx_generation_task_canvas').on(table.canvasId),
}));

export type CanvasWorkspace = typeof canvasWorkspace.$inferSelect;
export type NewCanvasWorkspace = typeof canvasWorkspace.$inferInsert;
export type CanvasAsset = typeof canvasAsset.$inferSelect;
export type NewCanvasAsset = typeof canvasAsset.$inferInsert;
export type GenerationTask = typeof generationTask.$inferSelect;
export type NewGenerationTask = typeof generationTask.$inferInsert;
