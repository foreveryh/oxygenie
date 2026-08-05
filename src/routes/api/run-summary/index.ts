/**
 * Run Summary API (T2)
 *
 * POST /api/run-summary — idempotently upsert one run summary row per run.
 * Internal use by the WS server (authenticated via cookie). The runId is the
 * caller-provided correlation key matching usage_record.runId.
 */

import { createFileRoute } from '@tanstack/react-router';
import { db } from '~/db/db-config';
import { runSummary } from '~/db/schema';
import { requireUser } from '~/server/require-user';
import { isErrorType } from '~/shared/error-taxonomy';

export type RunSummaryBody = {
  runId: string;
  sessionId?: string | null;
  model?: string | null;
  terminalState: 'done' | 'error' | 'aborted' | 'worker_crash';
  errorType?: string | null;
  errorDetail?: Record<string, unknown> | null;
  ttftMs?: number | null;
  totalMs?: number | null;
  queuedMs?: number | null;
  toolCallCount?: number;
  toolErrorCount?: number;
  toolCallsByName?: Record<string, number> | null;
  toolErrorsByName?: Record<string, number> | null;
  approvalRequestCount?: number;
  approvalDenyCount?: number;
  numTurns?: number;
  resumedFromRunId?: string | null;
  recoveredFromState?: string | null;
  evalTag?: string | null;
};

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function sanitizeErrorType(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return isErrorType(value) ? value : 'unknown';
}

export const Route = createFileRoute('/api/run-summary/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await requireUser(request);
        const body = (await request.json()) as RunSummaryBody;

        if (!body.runId || typeof body.runId !== 'string') {
          return Response.json({ error: 'runId is required' }, { status: 400 });
        }
        if (
          !body.terminalState ||
          !['done', 'error', 'aborted', 'worker_crash'].includes(body.terminalState)
        ) {
          return Response.json({ error: 'terminalState is required' }, { status: 400 });
        }

        const runId = body.runId;
        const values = {
          runId,
          userId: user.id,
          sessionId: body.sessionId ?? null,
          model: body.model ?? null,
          terminalState: body.terminalState,
          errorType: sanitizeErrorType(body.errorType),
          errorDetail: body.errorDetail && typeof body.errorDetail === 'object' ? body.errorDetail : {},
          ttftMs: body.ttftMs == null ? null : toInt(body.ttftMs),
          totalMs: body.totalMs == null ? null : toInt(body.totalMs),
          queuedMs: body.queuedMs == null ? null : toInt(body.queuedMs),
          toolCallCount: toInt(body.toolCallCount),
          toolErrorCount: toInt(body.toolErrorCount),
          toolCallsByName: body.toolCallsByName && typeof body.toolCallsByName === 'object' ? body.toolCallsByName : {},
          toolErrorsByName: body.toolErrorsByName && typeof body.toolErrorsByName === 'object' ? body.toolErrorsByName : {},
          approvalRequestCount: toInt(body.approvalRequestCount),
          approvalDenyCount: toInt(body.approvalDenyCount),
          numTurns: toInt(body.numTurns),
          resumedFromRunId: body.resumedFromRunId ?? null,
          recoveredFromState: body.recoveredFromState ?? null,
          evalTag: body.evalTag ?? null,
        };

        await db
          .insert(runSummary)
          .values(values)
          .onConflictDoUpdate({
            target: runSummary.runId,
            set: {
              ...values,
              // Preserve the original created_at on conflict; everything else overwrites.
              createdAt: undefined,
            },
          });

        return Response.json({ ok: true, runId });
      },
    },
  },
});
