/**
 * Canvas Agent (M3-T1) — daily generation quota check (impl spec §7).
 *
 * Deliberately NOT folded into system-settings.server.ts's CapabilityConfig (that
 * module resolves ONE org-wide posture per request; these three keys are simpler
 * scalars with no per-key validation ceremony needed) — same system_setting KV table
 * and DB→env→default precedence, scoped down to just what canvas needs. The admin UI
 * toggle for `generation.creditCheck` is M4 (F7.5 wording verification); this module
 * only needs the read path to exist for that toggle to do anything once it lands.
 */

import { and, eq, gte, inArray } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { systemSetting, generationTask, canvasWorkspace } from '~/db/schema';

export const CANVAS_QUOTA_KEYS = {
  dailyImageLimit: 'canvas.dailyImageLimit',
  dailyVideoLimit: 'canvas.dailyVideoLimit',
  creditCheck: 'generation.creditCheck',
} as const;

const DEFAULTS = {
  dailyImageLimit: 200,
  dailyVideoLimit: 20,
  creditCheck: false,
} as const;

const IMAGE_KINDS = ['t2i', 'i2i'] as const;
const VIDEO_KINDS = ['t2v', 'i2v', 'v2v'] as const;

async function readSetting(key: string): Promise<unknown> {
  try {
    const [row] = await db.select({ value: systemSetting.value }).from(systemSetting).where(eq(systemSetting.key, key));
    return row?.value;
  } catch {
    return undefined; // table missing (pre-migration) or DB hiccup → caller's default wins
  }
}

/** Is the quota gate even active? Off by default (v1: limit-check plumbing ships ahead
 * of enforcement, per spec §7 — flip via system_setting once the admin toggle lands). */
export async function isCreditCheckEnabled(): Promise<boolean> {
  const raw = await readSetting(CANVAS_QUOTA_KEYS.creditCheck);
  return typeof raw === 'boolean' ? raw : DEFAULTS.creditCheck;
}

function readLimit(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export class GenQuotaExceededError extends Error {
  constructor(public readonly kind: 'image' | 'video', public readonly limit: number) {
    super(`Daily ${kind} generation limit (${limit}) reached`);
  }
}

/** Count of this user's generation_task rows (any origin — agent + direct share one
 * limit, per spec §7: "同一用户开多个画布工作区不能绕过限额") of the given kind class,
 * created since UTC midnight. Counted via canvasWorkspace ownership (generation_task
 * has no direct userId column; direct-origin rows have a null sessionId). */
async function countTodayTasks(userId: string, isVideo: boolean, since: Date): Promise<number> {
  const kinds = isVideo ? VIDEO_KINDS : IMAGE_KINDS;
  const rows = await db
    .select({ id: generationTask.id })
    .from(generationTask)
    .innerJoin(canvasWorkspace, eq(canvasWorkspace.id, generationTask.canvasId))
    .where(
      and(
        eq(canvasWorkspace.ownerUserId, userId),
        gte(generationTask.createdAt, since),
        inArray(generationTask.kind, kinds)
      )
    );
  return rows.length;
}

/** Throws GenQuotaExceededError if the user is over today's limit for this kind.
 * No-op (never throws) when generation.creditCheck is off — the default posture. */
export async function assertWithinDailyQuota(userId: string, kind: 't2i' | 'i2i' | 't2v' | 'i2v' | 'v2v'): Promise<void> {
  if (!(await isCreditCheckEnabled())) return;

  const isVideo = kind === 't2v' || kind === 'i2v' || kind === 'v2v';
  const limitKey = isVideo ? CANVAS_QUOTA_KEYS.dailyVideoLimit : CANVAS_QUOTA_KEYS.dailyImageLimit;
  const fallback = isVideo ? DEFAULTS.dailyVideoLimit : DEFAULTS.dailyImageLimit;
  const limit = readLimit(await readSetting(limitKey), fallback);
  if (limit === 0) return; // 0 = unlimited

  const midnightUtc = new Date();
  midnightUtc.setUTCHours(0, 0, 0, 0);

  const count = await countTodayTasks(userId, isVideo, midnightUtc);
  if (count >= limit) throw new GenQuotaExceededError(isVideo ? 'video' : 'image', limit);
}
