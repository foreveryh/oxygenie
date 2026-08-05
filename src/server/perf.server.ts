/**
 * Performance & health server functions (P2).
 *
 * Read-only over perf_sample (+ rag_search_trace for the RAG leg). All admin-gated.
 * Metrics never include conversation content. Trends are computed on the fly with
 * Postgres percentile_cont over the raw window; the hourly rollup table backs
 * longer ranges once the aggregate job has run.
 */

import { createServerFn } from '@tanstack/react-start';
import { db } from '~/db/db-config';
import { perfSample, ragSearchTrace } from '~/db/schema';
import { and, desc, eq, gte, ne, sql } from 'drizzle-orm';
import { requireSystemAdmin } from '~/server/admin.server';

const SCENARIO_RUNTIME = 'runtime';

function windowStart(hours: number): Date {
  const d = new Date();
  d.setTime(d.getTime() - hours * 3600_000);
  return d;
}

/** Metric summary cards over the trailing window. */
export const getPerfOverview = createServerFn({ method: 'GET' })
  .inputValidator((val) => {
    const hours = Number((val as { hours?: unknown } | undefined)?.hours ?? 24);
    return { hours: Number.isFinite(hours) ? Math.min(168, Math.max(1, Math.trunc(hours))) : 24 };
  })
  .handler(async ({ data }) => {
    await requireSystemAdmin();
    const since = windowStart(data.hours);

    const metricStats = (metric: string) =>
      db
        .select({
          count: sql<number>`count(*)::int`,
          p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${perfSample.value}), 0)::float8`,
          p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${perfSample.value}), 0)::float8`,
          avg: sql<number>`coalesce(avg(${perfSample.value}), 0)::float8`,
          max: sql<number>`coalesce(max(${perfSample.value}), 0)::float8`,
        })
        .from(perfSample)
        .where(
          and(
            eq(perfSample.metric, metric),
            eq(perfSample.scenario, SCENARIO_RUNTIME),
            gte(perfSample.createdAt, since),
          ),
        );

    const [genTotal, tokensPerS, apiMs, ttftMs, queuedMs, ragRows] = await Promise.all([
      metricStats('generation.total_ms'),
      metricStats('generation.tokens_per_s'),
      metricStats('generation.api_ms'),
      // T5 (Eval Harness PR-1): true runtime TTFT, split from queue wait — see
      // ws-server.mjs recordRunSummary's t0/t1/t2 boundary comment for the definitions.
      metricStats('generation.ttft_ms'),
      metricStats('generation.queued_ms'),
      db
        .select({
          count: sql<number>`count(*)::int`,
          p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${ragSearchTrace.latencyMs}), 0)::float8`,
          p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${ragSearchTrace.latencyMs}), 0)::float8`,
        })
        .from(ragSearchTrace)
        .where(gte(ragSearchTrace.createdAt, since)),
    ]);

    return {
      hours: data.hours,
      generation: genTotal[0] ?? { count: 0, p50: 0, p95: 0, avg: 0, max: 0 },
      tokensPerSecond: tokensPerS[0] ?? { count: 0, p50: 0, p95: 0, avg: 0, max: 0 },
      apiMs: apiMs[0] ?? { count: 0, p50: 0, p95: 0, avg: 0, max: 0 },
      ttftMs: ttftMs[0] ?? { count: 0, p50: 0, p95: 0, avg: 0, max: 0 },
      queuedMs: queuedMs[0] ?? { count: 0, p50: 0, p95: 0, avg: 0, max: 0 },
      rag: ragRows[0] ?? { count: 0, p50: 0, p95: 0 },
    };
  });

/** Hourly trend buckets for one metric over the window (computed from raw). */
export const getPerfTrends = createServerFn({ method: 'GET' })
  .inputValidator((val) => {
    const v = (val ?? {}) as Record<string, unknown>;
    const hours = Number(v.hours ?? 24);
    const metric = typeof v.metric === 'string' && v.metric ? v.metric : 'generation.total_ms';
    return {
      hours: Number.isFinite(hours) ? Math.min(168, Math.max(1, Math.trunc(hours))) : 24,
      metric,
    };
  })
  .handler(async ({ data }) => {
    await requireSystemAdmin();
    const since = windowStart(data.hours);

    const buckets = await db
      .select({
        bucket: sql<string>`to_char(date_trunc('hour', ${perfSample.createdAt}), 'YYYY-MM-DD"T"HH24:00')`,
        count: sql<number>`count(*)::int`,
        p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${perfSample.value}), 0)::float8`,
        p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${perfSample.value}), 0)::float8`,
      })
      .from(perfSample)
      .where(
        and(
          eq(perfSample.metric, data.metric),
          eq(perfSample.scenario, SCENARIO_RUNTIME),
          gte(perfSample.createdAt, since),
        ),
      )
      .groupBy(sql`date_trunc('hour', ${perfSample.createdAt})`)
      .orderBy(sql`date_trunc('hour', ${perfSample.createdAt})`);

    return { metric: data.metric, hours: data.hours, buckets };
  });

/** Recent slowest runtime generation samples (metadata only — no content). */
export const getSlowestSamples = createServerFn({ method: 'GET' })
  .inputValidator((val) => {
    const v = (val ?? {}) as Record<string, unknown>;
    const limit = Number(v.limit ?? 20);
    const metric = typeof v.metric === 'string' && v.metric ? v.metric : 'generation.total_ms';
    return { limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 20, metric };
  })
  .handler(async ({ data }) => {
    await requireSystemAdmin();
    const rows = await db
      .select({
        id: perfSample.id,
        metric: perfSample.metric,
        value: perfSample.value,
        unit: perfSample.unit,
        route: perfSample.route,
        model: perfSample.model,
        sessionId: perfSample.sessionId,
        createdAt: perfSample.createdAt,
      })
      .from(perfSample)
      .where(and(eq(perfSample.metric, data.metric), eq(perfSample.scenario, SCENARIO_RUNTIME)))
      .orderBy(desc(perfSample.value))
      .limit(data.limit);
    return rows.map((r) => ({ ...r, value: Number(r.value) }));
  });

/** Load-test baseline runs (scenario != 'runtime'), grouped by run. */
export const getBaselineRuns = createServerFn({ method: 'GET' })
  .handler(async () => {
    await requireSystemAdmin();
    const rows = await db
      .select({
        scenario: perfSample.scenario,
        runId: perfSample.runId,
        samples: sql<number>`count(*)::int`,
        ttftP95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${perfSample.value}) filter (where ${perfSample.metric} = 'generation.ttft_ms'), 0)::float8`,
        genP95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${perfSample.value}) filter (where ${perfSample.metric} = 'generation.total_ms'), 0)::float8`,
        startedAt: sql<string>`min(${perfSample.createdAt})`,
      })
      .from(perfSample)
      .where(ne(perfSample.scenario, SCENARIO_RUNTIME))
      .groupBy(perfSample.scenario, perfSample.runId)
      .orderBy(desc(sql`min(${perfSample.createdAt})`))
      .limit(50);
    return rows;
  });

/** Probe with a hard timeout; resolves to a status string, never throws. */
async function probeHttp(url: string, timeoutMs = 1500): Promise<'healthy' | 'down'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok ? 'healthy' : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

type HealthState = 'healthy' | 'down' | 'unknown';

/** Live service-health snapshot. DB/redis/meili/parser are really probed. */
export const getSystemHealth = createServerFn({ method: 'GET' })
  .handler(async () => {
    await requireSystemAdmin();

    const probeDb = async (): Promise<HealthState> => {
      try {
        await db.execute(sql`select 1`);
        return 'healthy';
      } catch {
        return 'down';
      }
    };

    const probeRedis = async (): Promise<HealthState> => {
      if (!process.env.REDIS_URL) return 'unknown';
      let client: { ping: () => Promise<unknown>; quit: () => Promise<unknown> } | null = null;
      try {
        const { default: IORedis } = await import('ioredis');
        client = new IORedis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          connectTimeout: 1500,
          lazyConnect: true,
        }) as unknown as { ping: () => Promise<unknown>; quit: () => Promise<unknown> };
        await client.ping();
        return 'healthy';
      } catch {
        return 'down';
      } finally {
        try {
          await client?.quit();
        } catch {
          /* ignore */
        }
      }
    };

    const meiliHost = process.env.MEILI_HOST;
    const parserUrl = process.env.PARSER_SIDECAR_URL;

    const [dbState, redisState, meiliState, parserState, registry] = await Promise.all([
      probeDb(),
      probeRedis(),
      meiliHost ? probeHttp(`${meiliHost.replace(/\/$/, '')}/health`) : Promise.resolve<HealthState>('unknown'),
      parserUrl ? probeHttp(`${parserUrl.replace(/\/$/, '')}/health`) : Promise.resolve<HealthState>('unknown'),
      import('~/server/concurrency/session-registry.js'),
    ]);

    const snapshot =
      typeof registry.sessionRegistry?.snapshot === 'function'
        ? registry.sessionRegistry.snapshot()
        : { activeWorkers: 0, totalWorkers: 0 };

    return {
      checkedAt: new Date().toISOString(),
      services: {
        app: 'healthy' as HealthState,
        db: dbState,
        worker: (snapshot.totalWorkers > 0 ? 'healthy' : 'unknown') as HealthState,
        redis: redisState,
        meili: meiliState,
        parser: parserState,
        minio: 'unknown' as HealthState,
      },
      workers: { active: snapshot.activeWorkers, total: snapshot.totalWorkers },
    };
  });
