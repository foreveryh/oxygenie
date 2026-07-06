/**
 * Projects access resolver — the SINGLE source of truth for "who can see / do what".
 *
 * PRD 2026-06-projects-collaboration §4: never scatter `WHERE user_id` across the
 * codebase. Every list/visibility/permission check for Projects + their sessions
 * routes through here. When RAG R0 lands, `accessibleKbIds` joins this module (docs/KB
 * scope) — the call sites won't change, only this resolver grows.
 *
 * Model A (container = permission): membership in `project_member` grants access to ALL
 * of a Project's contents. A session with `projectId = null` is personal/loose (the
 * "最近" area) and visible only to its own `userId`.
 */

import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { project, projectMember, type ProjectRole } from '~/db/schema/project.schema';
import { agentSession } from '~/db/schema/agent-session.schema';
import { documents } from '~/db/schema/document.schema';
import { knowledgeBases } from '~/db/schema/knowledge-base.schema';
import {
  isSessionVisible,
  isSessionMutable,
  isResourceVisible,
  type SessionAccessRow,
  type ResourceAccessRow,
} from './access-logic';

/** Project ids the user is a member of (owned Projects always include an owner membership row). */
export async function accessibleProjectIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ projectId: projectMember.projectId })
    .from(projectMember)
    .where(eq(projectMember.userId, userId));
  const ids = new Set(rows.map((r) => r.projectId));
  // Belt-and-suspenders (audit D6): an owner always retains access even if a future
  // code path inserted a `project` without the paired `project_member` row.
  const owned = await db.select({ id: project.id }).from(project).where(eq(project.ownerUserId, userId));
  for (const o of owned) ids.add(o.id);
  return [...ids];
}

/** The user's role in a Project, or null if they're not a member. */
export async function getMembership(userId: string, projectId: string): Promise<ProjectRole | null> {
  const [row] = await db
    .select({ role: projectMember.role })
    .from(projectMember)
    .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/** Throw FORBIDDEN unless the user is a member of the Project. Returns their role. */
export async function assertProjectMember(userId: string, projectId: string): Promise<ProjectRole> {
  const role = await getMembership(userId, projectId);
  if (!role) throw new Error('FORBIDDEN');
  return role;
}

/** Throw FORBIDDEN unless the user owns the Project (member-mgmt / rename / delete). */
export async function assertProjectOwner(userId: string, projectId: string): Promise<void> {
  const role = await getMembership(userId, projectId);
  if (role !== 'owner') throw new Error('FORBIDDEN');
}

/**
 * SQL predicate for "sessions this user may see": own personal/loose sessions, OR any
 * session in a Project they belong to. Push isolation INTO the query — never post-filter.
 *
 * Canvas Agent (D5): a canvas session also has `projectId = null` (it's never inside a
 * Project), so it satisfies the "personal" branch too. `isNull(canvasId)` excludes it —
 * without this, canvas sessions would leak into the "最近" loose-chat rail. Canvas
 * workspace pages query their own sessions separately (by canvasId), not through here.
 */
export function visibleSessionsWhere(userId: string, accessibleIds: string[]): SQL | undefined {
  const personal = and(
    isNull(agentSession.projectId),
    isNull(agentSession.canvasId),
    eq(agentSession.userId, userId)
  );
  if (accessibleIds.length === 0) return personal;
  return or(personal, inArray(agentSession.projectId, accessibleIds));
}

// Pure decisions live in ./access-logic (DB-free, unit-tested); re-exported + DB-wrapped here.
export type { SessionAccessRow, ResourceAccessRow };
export const canMutateSession = isSessionMutable;

/**
 * READ visibility for a single session: own loose session, OR a session in a Project the
 * user belongs to. Load the row first, then authorize — never keep a raw `WHERE user_id`
 * (that hides shared sessions).
 */
export async function canAccessSession(userId: string, s: SessionAccessRow): Promise<boolean> {
  if (s.projectId == null) return s.userId === userId;
  return isSessionVisible(userId, s, new Set(await accessibleProjectIds(userId)));
}

// ─── RAG R0: documents / knowledge bases (final spec D2) ─────────────────────────────
// Same primitive as sessions: `projectId` nullable; visibility = personal-owner OR
// project-member. Both kb_search retrieval legs and every doc/KB list MUST go through
// these predicates — isolation lives in the SQL, never in a post-filter.

/**
 * SQL predicate for "documents this user may see": own personal docs, OR any document in
 * a Project they belong to.
 */
export function visibleDocumentsWhere(userId: string, accessibleIds: string[]): SQL | undefined {
  const personal = and(isNull(documents.projectId), eq(documents.userId, userId));
  if (accessibleIds.length === 0) return personal;
  return or(personal, inArray(documents.projectId, accessibleIds));
}

/** SQL predicate for "knowledge bases this user may see" (shape mirrors documents). */
export function visibleKbWhere(userId: string, accessibleIds: string[]): SQL | undefined {
  const personal = and(isNull(knowledgeBases.projectId), eq(knowledgeBases.userId, userId));
  if (accessibleIds.length === 0) return personal;
  return or(personal, inArray(knowledgeBases.projectId, accessibleIds));
}

/**
 * KB ids the user may search/list: personal KBs ∪ KBs of Projects they belong to.
 * (The resolver slot reserved by this module's header comment since Projects P1.)
 */
export async function accessibleKbIds(userId: string): Promise<string[]> {
  const projectIds = await accessibleProjectIds(userId);
  const rows = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(visibleKbWhere(userId, projectIds));
  return rows.map((r) => r.id);
}

/** READ visibility for a single document row (load first, then authorize). */
export async function canAccessDocument(
  userId: string,
  d: ResourceAccessRow,
): Promise<boolean> {
  if (d.projectId == null) return d.userId === userId;
  return isResourceVisible(userId, d, new Set(await accessibleProjectIds(userId)));
}
