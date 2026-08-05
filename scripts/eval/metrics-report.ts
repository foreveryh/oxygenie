/**
 * Eval Harness M1 — online metrics report.
 *
 * Computes the six PRD metrics (docs/4. PRD/2026-07-07-Agent-Eval-Harness-PRD.md
 * §3) directly from run_summary (+ usage_record for cost, + audit_log for the
 * approval trail) over a trailing window. Read-only, no side effects.
 *
 * Two metrics are STRUCTURALLY INCOMPLETE until later PRs land — the script
 * reports them as `null` with a `pending` note rather than a misleading zero:
 *   - §3.2 soft-correction takeover tier      → needs M3's LLM message-pair classifier
 *   - §3.3 interruption recovery rate         → needs T4 (resumedFromRunId population, PR-2)
 * Cache-token cost breakdown (§3.4) is likewise pending T6.
 *
 * Usage (repo root):
 *   DATABASE_URL=... npx tsx scripts/eval/metrics-report.ts [--days=7] [--include-eval]
 *
 * --include-eval keeps eval/loadtest-tagged runs in the numbers (default: excluded,
 * per PRD D3 production/eval isolation — eval_tag IS NULL is the production filter).
 *
 * Writes eval-reports/metrics-<ISO date>.json + .md (gitignored) and also prints
 * the Markdown to stdout.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gte, isNull, isNotNull, sql } from 'drizzle-orm';
import { db } from '~/db/db-config';
import { runSummary } from '~/db/schema/run-summary.schema';
import { usageRecord } from '~/db/schema/usage-record.schema';

const args = process.argv.slice(2);
const days = Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] ?? '7');
const includeEval = args.includes('--include-eval');
const OUT_DIR = process.env.OUT_DIR || path.join('eval-reports');

function windowStart(daysBack: number): Date {
  const d = new Date();
  d.setTime(d.getTime() - daysBack * 86_400_000);
  return d;
}

/** eval_tag IS NULL unless --include-eval (PRD D3: production/eval isolation). */
function scopeFilter(since: Date) {
  const base = gte(runSummary.createdAt, since);
  return includeEval ? base : and(base, isNull(runSummary.evalTag));
}

function pct(n: number): string {
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : 'n/a';
}

/** Same scope as scopeFilter(), for raw sql`` templates (db.execute doesn't
 * serialize a bare Date the way drizzle's typed query builder does — pass an
 * ISO string instead). */
function rawScopeSql(since: Date) {
  const iso = since.toISOString();
  return includeEval
    ? sql`${runSummary.createdAt} >= ${iso}::timestamptz`
    : sql`${runSummary.createdAt} >= ${iso}::timestamptz and ${runSummary.evalTag} is null`;
}

// ── §3.1 Tool call success rate, by tool name (global microaverage) ────────
async function toolSuccessRate(since: Date) {
  const overall = await db
    .select({
      calls: sql<number>`coalesce(sum(${runSummary.toolCallCount}), 0)::int`,
      errors: sql<number>`coalesce(sum(${runSummary.toolErrorCount}), 0)::int`,
    })
    .from(runSummary)
    .where(scopeFilter(since));

  // jsonb_each_text unnests {toolName: count} across every row — drizzle has no
  // helper for this, so it's raw SQL wrapped in a CTE that also applies the same
  // window/eval-tag scope as everything else in this report.
  const scopeSql = rawScopeSql(since);

  const byTool = await db.execute<{ tool_name: string; calls: number; errors: number }>(sql`
    with calls as (
      select key as tool_name, sum(value::int) as calls
      from run_summary, jsonb_each_text(tool_calls_by_name)
      where ${scopeSql}
      group by key
    ), errors as (
      select key as tool_name, sum(value::int) as errors
      from run_summary, jsonb_each_text(tool_errors_by_name)
      where ${scopeSql}
      group by key
    )
    select coalesce(c.tool_name, e.tool_name) as tool_name,
           coalesce(c.calls, 0)::int as calls,
           coalesce(e.errors, 0)::int as errors
    from calls c
    full outer join errors e on c.tool_name = e.tool_name
    order by errors desc, calls desc
  `);

  const rows = byTool; // postgres.js RowList is array-like directly, no .rows wrapper
  return {
    overallSuccessRate: overall[0].calls > 0 ? 1 - overall[0].errors / overall[0].calls : null,
    overallCalls: overall[0].calls,
    overallErrors: overall[0].errors,
    byTool: rows.map((r) => ({
      tool: r.tool_name,
      calls: r.calls,
      errors: r.errors,
      successRate: r.calls > 0 ? 1 - r.errors / r.calls : null,
    })),
  };
}

// ── §3.2 Human takeover rate — three tiers, never merged into one number ───
async function takeoverRate(since: Date) {
  // Hard takeover: aborted run followed by another run in the SAME session
  // within 30 minutes. Self-join, entirely on run_summary (no message table).
  const scopeSql = rawScopeSql(since);

  const hard = await db.execute<{ aborted_total: number; followed: number }>(sql`
    with aborted as (
      select run_id, session_id, created_at
      from run_summary
      where terminal_state = 'aborted' and session_id is not null and ${scopeSql}
    )
    select
      count(*)::int as aborted_total,
      count(*) filter (
        where exists (
          select 1 from run_summary r2
          where r2.session_id = aborted.session_id
            and r2.created_at > aborted.created_at
            and r2.created_at <= aborted.created_at + interval '30 minutes'
        )
      )::int as followed
    from aborted
  `);
  const hardRow = hard[0]; // postgres.js RowList is array-like directly, no .rows wrapper

  const approvals = await db
    .select({
      requests: sql<number>`coalesce(sum(${runSummary.approvalRequestCount}), 0)::int`,
      denies: sql<number>`coalesce(sum(${runSummary.approvalDenyCount}), 0)::int`,
    })
    .from(runSummary)
    .where(scopeFilter(since));

  return {
    hardTakeover: {
      abortedRuns: hardRow?.aborted_total ?? 0,
      followedByNewRun: hardRow?.followed ?? 0,
      rate:
        hardRow && hardRow.aborted_total > 0 ? hardRow.followed / hardRow.aborted_total : null,
    },
    approvalDenial: {
      requests: approvals[0].requests,
      denies: approvals[0].denies,
      rate: approvals[0].requests > 0 ? approvals[0].denies / approvals[0].requests : null,
    },
    softCorrection: {
      rate: null,
      note: 'pending M3 — needs LLM classification of adjacent message pairs (not yet implemented)',
    },
  };
}

// ── §3.3 Interruption recovery rate (passive pairing via resumed_from_run_id) ─
async function recoveryRate(since: Date) {
  const attempts = await db
    .select({ id: runSummary.id, terminalState: runSummary.terminalState })
    .from(runSummary)
    .where(and(scopeFilter(since), isNotNull(runSummary.resumedFromRunId)));

  const total = attempts.length;
  const succeeded = attempts.filter((a) => a.terminalState === 'done').length;
  return {
    attempts: total,
    succeeded,
    rate: total > 0 ? succeeded / total : null,
    note:
      total === 0
        ? 'pending T4 (PR-2) — resumed_from_run_id is not yet populated by any shipped code, or no resume attempts occurred in this window'
        : undefined,
  };
}

// ── §3.4 Cost (token-only, USD list-price estimate; cache tokens pending T6) ─
async function costReport(since: Date) {
  const rows = await db
    .select({
      model: usageRecord.model,
      inputTokens: sql<number>`sum(${usageRecord.inputTokens})::bigint`,
      outputTokens: sql<number>`sum(${usageRecord.outputTokens})::bigint`,
      costUsd: sql<number>`sum(${usageRecord.costUsd})::numeric`,
      runs: sql<number>`count(distinct ${usageRecord.runId})::int`,
    })
    .from(usageRecord)
    .innerJoin(runSummary, eq(usageRecord.runId, runSummary.runId))
    .where(scopeFilter(since))
    .groupBy(usageRecord.model)
    .orderBy(sql`sum(${usageRecord.costUsd}) desc`);

  const totalCostUsd = rows.reduce((s, r) => s + Number(r.costUsd || 0), 0);
  const totalRuns = new Set(rows.map((r) => r.runs)).size > 0 ? Math.max(...rows.map((r) => r.runs), 0) : 0;

  return {
    caveat:
      'USD is the SDK\'s list-price estimate (Anthropic-equivalent pricing), NOT actual spend — internal relative comparison only. Media generation and third-party tool API costs are NOT included (v1 scope, see PRD §3.4).',
    cacheTokens: 'pending T6 — usage_record has no cache_read/cache_creation columns yet',
    totalCostUsd,
    byModel: rows.map((r) => ({
      model: r.model,
      runs: r.runs,
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      costUsd: Number(r.costUsd),
    })),
  };
}

// ── §3.6 Failure attribution — Pareto by error_type, tool, model ───────────
async function failureAttribution(since: Date) {
  const byErrorType = await db
    .select({
      errorType: runSummary.errorType,
      count: sql<number>`count(*)::int`,
    })
    .from(runSummary)
    .where(and(scopeFilter(since), isNotNull(runSummary.errorType)))
    .groupBy(runSummary.errorType)
    .orderBy(sql`count(*) desc`);

  const byModel = await db
    .select({
      model: runSummary.model,
      errorType: runSummary.errorType,
      count: sql<number>`count(*)::int`,
    })
    .from(runSummary)
    .where(and(scopeFilter(since), isNotNull(runSummary.errorType)))
    .groupBy(runSummary.model, runSummary.errorType)
    .orderBy(sql`count(*) desc`);

  const scopeSql = rawScopeSql(since);
  const toolErrorPareto = await db.execute<{ tool_name: string; errors: number }>(sql`
    select key as tool_name, sum(value::int)::int as errors
    from run_summary, jsonb_each_text(tool_errors_by_name)
    where ${scopeSql}
    group by key
    order by errors desc
  `);

  return {
    byErrorType,
    byModelAndErrorType: byModel,
    toolErrorPareto,
    secondaryAttributionNote:
      'pending M3 — LLM secondary attribution for unknown/task_failure error types is not yet implemented; error_type here is the T1 rule-based classification only',
  };
}

async function overview(since: Date) {
  const rows = await db
    .select({
      terminalState: runSummary.terminalState,
      count: sql<number>`count(*)::int`,
    })
    .from(runSummary)
    .where(scopeFilter(since))
    .groupBy(runSummary.terminalState);
  const total = rows.reduce((s, r) => s + r.count, 0);
  return { totalRuns: total, byTerminalState: rows };
}

function toMarkdown(windowLabel: string, report: any): string {
  const lines: string[] = [];
  lines.push(`# Eval Harness metrics report — trailing ${windowLabel}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}  ·  Scope: ${includeEval ? 'ALL traffic (--include-eval)' : 'production only (eval_tag IS NULL)'}`);
  lines.push('');
  lines.push('## Overview');
  lines.push(`Total runs: **${report.overview.totalRuns}**`);
  for (const r of report.overview.byTerminalState) {
    lines.push(`- ${r.terminalState}: ${r.count}`);
  }
  lines.push('');
  lines.push('## §3.1 Tool call success rate');
  lines.push(`Overall: **${pct(report.toolSuccess.overallSuccessRate)}** (${report.toolSuccess.overallCalls - report.toolSuccess.overallErrors}/${report.toolSuccess.overallCalls} calls succeeded)`);
  if (report.toolSuccess.byTool.length) {
    lines.push('');
    lines.push('| Tool | Calls | Errors | Success rate |');
    lines.push('|---|---|---|---|');
    for (const t of report.toolSuccess.byTool) {
      lines.push(`| ${t.tool} | ${t.calls} | ${t.errors} | ${pct(t.successRate)} |`);
    }
  }
  lines.push('');
  lines.push('## §3.2 Human takeover rate (三档)');
  const h = report.takeover.hardTakeover;
  lines.push(`- **硬接管**: ${pct(h.rate)} (${h.followedByNewRun}/${h.abortedRuns} aborted runs followed by a new run within 30min)`);
  const a = report.takeover.approvalDenial;
  lines.push(`- **审批拒绝率**: ${pct(a.rate)} (${a.denies}/${a.requests})`);
  lines.push(`- **软纠偏**: n/a — ${report.takeover.softCorrection.note}`);
  lines.push('');
  lines.push('## §3.3 Interruption recovery rate');
  const rec = report.recovery;
  lines.push(`${pct(rec.rate)} (${rec.succeeded}/${rec.attempts} resume attempts succeeded)${rec.note ? `  \n> ${rec.note}` : ''}`);
  lines.push('');
  lines.push('## §3.4 Cost (token-only, USD list-price estimate)');
  lines.push(`> ${report.cost.caveat}`);
  lines.push(`> cache tokens: ${report.cost.cacheTokens}`);
  lines.push(`Total: **$${report.cost.totalCostUsd.toFixed(4)}**`);
  if (report.cost.byModel.length) {
    lines.push('');
    lines.push('| Model | Runs | Input tok | Output tok | Cost USD |');
    lines.push('|---|---|---|---|---|');
    for (const m of report.cost.byModel) {
      lines.push(`| ${m.model} | ${m.runs} | ${m.inputTokens} | ${m.outputTokens} | $${m.costUsd.toFixed(4)} |`);
    }
  }
  lines.push('');
  lines.push('## §3.6 Failure attribution (Pareto)');
  lines.push('');
  lines.push('By error type:');
  for (const e of report.failures.byErrorType) lines.push(`- ${e.errorType}: ${e.count}`);
  if (report.failures.toolErrorPareto.length) {
    lines.push('');
    lines.push('By tool (error volume):');
    for (const t of report.failures.toolErrorPareto) lines.push(`- ${t.tool_name}: ${t.errors}`);
  }
  lines.push('');
  lines.push(`> ${report.failures.secondaryAttributionNote}`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const since = windowStart(days);
  const windowLabel = `${days}d`;

  const [ov, toolSuccess, takeover, recovery, cost, failures] = await Promise.all([
    overview(since),
    toolSuccessRate(since),
    takeoverRate(since),
    recoveryRate(since),
    costReport(since),
    failureAttribution(since),
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    includeEval,
    overview: ov,
    toolSuccess,
    takeover,
    recovery,
    cost,
    failures,
  };

  const md = toMarkdown(windowLabel, report);
  console.log(md);

  await mkdir(OUT_DIR, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  await writeFile(path.join(OUT_DIR, `metrics-${stamp}.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(OUT_DIR, `metrics-${stamp}.md`), md);
  console.log(`\n(written to ${OUT_DIR}/metrics-${stamp}.{json,md})`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ metrics-report failed:', err);
  process.exit(1);
});
