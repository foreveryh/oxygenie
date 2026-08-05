/**
 * Canvas Agent (M3-T1) — direct-gen job scheduling.
 *
 * Own BullMQ queue (mirrors src/server/rag/queue.ts's rationale exactly): an older
 * deployed worker image that doesn't know this queue leaves its jobs alone instead of
 * swallowing them via the 'system' default branch. Same inline-mode fallback for local
 * dev (scripts/local-* run no separate worker process, and no REDIS_URL locally).
 *
 * No cross-process live push exists from the worker back to ws-server's canvas
 * WebSocket channel (they're separate processes with no pub/sub bridge) — the client
 * (direct-gen-bar.tsx) polls getGenerationTask() while a direct task is in flight
 * instead. This matches the spec's own "全量真相可由 loader 重建" fallback philosophy;
 * see PRD M1 write-up for the fuller reasoning.
 */

export const CANVAS_GEN_QUEUE = 'canvas-generation';
export const CANVAS_GEN_JOB = 'canvas-generate';

export type CanvasGenJobData = { taskId: string };

let queuePromise: Promise<import('bullmq').Queue> | null = null;

async function getQueue() {
  if (!queuePromise) {
    queuePromise = (async () => {
      const [{ Queue }, { default: IORedis }] = await Promise.all([import('bullmq'), import('ioredis')]);
      const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      // Must match src/worker/index.ts's canvas-gen Worker prefix — see rag/queue.ts's
      // same comment for the "docs stuck pending" failure mode when these diverge.
      const prefix = process.env.BULLMQ_PREFIX ?? 'oxygenie';
      return new Queue(CANVAS_GEN_QUEUE, { connection, prefix });
    })();
  }
  return queuePromise;
}

function inlineMode(): boolean {
  if (process.env.CANVAS_GEN_INLINE === 'true') return true;
  return !process.env.REDIS_URL;
}

/** Schedule (or inline-run) a direct-gen task. Never throws — the caller has already
 * created the generation_task row and returned a taskId to the client; a scheduling
 * failure here surfaces via that task never leaving 'running', not by breaking the
 * directGenerate request. `runInline` is injected by the caller (server fn) rather than
 * imported directly, so this module has no dependency on the media-gen runners. */
export async function scheduleCanvasGeneration(
  taskId: string,
  runInline: (taskId: string) => Promise<void>
): Promise<'queued' | 'inline' | 'error'> {
  try {
    if (inlineMode()) {
      void runInline(taskId).catch((err) => console.error('[canvas-gen-queue] inline run failed:', taskId, err));
      return 'inline';
    }
    const queue = await getQueue();
    await queue.add(CANVAS_GEN_JOB, { taskId } satisfies CanvasGenJobData, { jobId: `${CANVAS_GEN_JOB}-${taskId}` });
    return 'queued';
  } catch (err) {
    console.error('[canvas-gen-queue] schedule failed:', taskId, err);
    return 'error';
  }
}

/** Best-effort removal of a still-queued job (cancelTask). No-op (not an error) if the
 * job already started running or already finished — bullmq can't cleanly abort a job
 * mid-flight, and completeGenerationTask's terminal-state guard handles a late result
 * landing after the task row was already marked failed by the cancel. */
export async function removeCanvasGenerationJob(taskId: string): Promise<void> {
  if (inlineMode()) return; // inline jobs run synchronously in-process; nothing to remove
  try {
    const queue = await getQueue();
    const job = await queue.getJob(`${CANVAS_GEN_JOB}-${taskId}`);
    if (job) {
      const state = await job.getState();
      if (state === 'waiting' || state === 'delayed') await job.remove();
    }
  } catch (err) {
    console.error('[canvas-gen-queue] remove failed:', taskId, err);
  }
}
