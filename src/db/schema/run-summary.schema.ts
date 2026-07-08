/**
 * Run Summary Schema (T2)
 *
 * One row per run, written once at worker close. The authoritative online data
 * source for Eval Harness metrics and production telemetry. Eval and production
 * runs share this table; `evalTag` distinguishes eval/loadtest traffic.
 */

import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { generateId } from '~/utils/id-generator';
import { createdAt } from './_shared';

export const runSummary = pgTable(
  'run_summary',
  {
    id: text('id')
      .$defaultFn(() => generateId('runsum'))
      .primaryKey(),

    // Correlation key: matches usage_record.runId. Unique per run; upsert target.
    runId: text('run_id').notNull().unique(),

    // Workspace session id (our sdkSessionId). May be null for very early/silent runs.
    sessionId: text('session_id'),

    // Acting user. Deliberately NOT an FK — audit-style retention survives deletion.
    userId: text('user_id').notNull(),

    // Primary model for this run (first key in modelUsage, or init event model).
    model: text('model'),

    // Terminal outcome. One of: done | error | aborted | worker_crash.
    terminalState: text('terminal_state').notNull(),

    // Canonical error classification (T1). Null for successful done runs.
    errorType: text('error_type'),

    // Structured error context, filled by M3 LLM secondary attribution.
    errorDetail: jsonb('error_detail').$type<Record<string, unknown>>().default({}),

    // Timing (ms). See T5 for boundary definitions.
    ttftMs: integer('ttft_ms'),
    totalMs: integer('total_ms'),
    queuedMs: integer('queued_ms'),

    // Tool outcome aggregates. toolCallsByName is the per-tool denominator for
    // Eval Harness PRD §3.1 (tool call success rate by tool name); without it
    // toolErrorsByName alone has no rate to compute, only a raw error count.
    toolCallCount: integer('tool_call_count').notNull().default(0),
    toolErrorCount: integer('tool_error_count').notNull().default(0),
    toolCallsByName: jsonb('tool_calls_by_name').$type<Record<string, number>>().default({}),
    toolErrorsByName: jsonb('tool_errors_by_name').$type<Record<string, number>>().default({}),

    // HITL approval aggregates (T3).
    approvalRequestCount: integer('approval_request_count').notNull().default(0),
    approvalDenyCount: integer('approval_deny_count').notNull().default(0),

    // Run depth.
    numTurns: integer('num_turns').notNull().default(0),

    // Recovery pairing (T4).
    resumedFromRunId: text('resumed_from_run_id'),
    recoveredFromState: text('recovered_from_state'),

    // Eval/loadtest traffic isolation (T8). Production traffic is always null.
    evalTag: text('eval_tag'),

    createdAt: createdAt(),
  },
  (table) => ({
    sessionIdIdx: index('run_summary_session_id_idx').on(table.sessionId),
    userIdIdx: index('run_summary_user_id_idx').on(table.userId),
    createdAtIdx: index('run_summary_created_at_idx').on(table.createdAt),
    terminalStateIdx: index('run_summary_terminal_state_idx').on(table.terminalState),
    evalTagIdx: index('run_summary_eval_tag_idx').on(table.evalTag),
  }),
);
