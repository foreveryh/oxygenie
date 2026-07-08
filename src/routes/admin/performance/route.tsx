/**
 * Admin · Performance (P2)
 *
 * Runtime latency/throughput trends from perf_sample (+ rag_search_trace).
 * Range switches re-run the server fns. Metrics never include conversation content.
 * Runtime TTFT + queue wait landed with Eval Harness PR-1 (T5) — see the TTFT/Queue
 * cards below. The TTFT column under Baseline runs is a SEPARATE metric fed by the
 * load-test harness (non-runtime scenario), not this one.
 */

import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  getPerfOverview,
  getPerfTrends,
  getSlowestSamples,
  getBaselineRuns,
} from '~/server/perf.server';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Button } from '~/components/ui/button';

const RANGES = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
] as const;

function ms(v: number): string {
  if (!v) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

export const Route = createFileRoute('/admin/performance')({
  loader: async () => {
    const [overview, trends, slowest, baselines] = await Promise.all([
      getPerfOverview({ data: { hours: 24 } }),
      getPerfTrends({ data: { hours: 24, metric: 'generation.total_ms' } }),
      getSlowestSamples({ data: { limit: 15, metric: 'generation.total_ms' } }),
      getBaselineRuns(),
    ]);
    return { overview, trends, slowest, baselines };
  },
  component: AdminPerformancePage,
});

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[13px] text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-medium tabular-nums">{value}</p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function AdminPerformancePage() {
  const initial = Route.useLoaderData();
  const [data, setData] = React.useState(initial);
  const [hours, setHours] = React.useState(24);
  const [loading, setLoading] = React.useState(false);

  const fetchOverview = useServerFn(getPerfOverview);
  const fetchTrends = useServerFn(getPerfTrends);
  const fetchSlowest = useServerFn(getSlowestSamples);
  const fetchBaselines = useServerFn(getBaselineRuns);

  const switchRange = async (nextHours: number) => {
    if (nextHours === hours || loading) return;
    setLoading(true);
    try {
      const [overview, trends, slowest, baselines] = await Promise.all([
        fetchOverview({ data: { hours: nextHours } }),
        fetchTrends({ data: { hours: nextHours, metric: 'generation.total_ms' } }),
        fetchSlowest({ data: { limit: 15, metric: 'generation.total_ms' } }),
        fetchBaselines(),
      ]);
      setData({ overview, trends, slowest, baselines });
      setHours(nextHours);
    } finally {
      setLoading(false);
    }
  };

  const { overview, trends, slowest, baselines } = data;
  const maxBucket = Math.max(1, ...trends.buckets.map((b) => b.p95));
  const empty = overview.generation.count === 0;

  return (
    <div className="p-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Performance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Generation latency and throughput over the selected window. Samples are recorded from
            the terminal result event — no conversation content.
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.hours}
              size="sm"
              variant={r.hours === hours ? 'default' : 'outline'}
              disabled={loading}
              onClick={() => switchRange(r.hours)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {empty ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No runtime samples in this window yet. Generation metrics appear after the next runs;
            load-test baselines (below) populate as harness runs are recorded.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Gen p95" value={ms(overview.generation.p95)} hint={`p50 ${ms(overview.generation.p50)}`} />
        <MetricCard
          label="Tokens/s avg"
          value={overview.tokensPerSecond.avg ? overview.tokensPerSecond.avg.toFixed(1) : '—'}
          hint={`${overview.tokensPerSecond.count} runs`}
        />
        <MetricCard label="API p95" value={ms(overview.apiMs.p95)} />
        <MetricCard label="RAG search p95" value={ms(overview.rag.p95)} hint={`${overview.rag.count} searches`} />
        <MetricCard label="TTFT p95" value={ms(overview.ttftMs.p95)} hint={`p50 ${ms(overview.ttftMs.p50)}`} />
        <MetricCard label="Queue wait p95" value={ms(overview.queuedMs.p95)} hint={`p50 ${ms(overview.queuedMs.p50)}`} />
      </div>

      <Card className="mt-6">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Generation p95 — hourly</CardTitle>
        </CardHeader>
        <CardContent>
          {trends.buckets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No samples in this window.</p>
          ) : (
            <div className="flex h-32 items-end gap-1">
              {trends.buckets.map((b) => (
                <div
                  key={b.bucket}
                  className="group flex flex-1 flex-col items-center justify-end"
                  title={`${b.bucket}: p95 ${ms(b.p95)} · p50 ${ms(b.p50)} · ${b.count} samples`}
                >
                  <div
                    className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
                    style={{ height: `${Math.max(2, (b.p95 / maxBucket) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Slowest recent generations</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slowest.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                      No data
                    </TableCell>
                  </TableRow>
                ) : (
                  slowest.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(s.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">{s.model ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{ms(s.value)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Baseline runs (load tests)</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scenario</TableHead>
                  <TableHead className="text-right">Samples</TableHead>
                  <TableHead className="text-right">TTFT p95</TableHead>
                  <TableHead className="text-right">Gen p95</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {baselines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                      No baseline runs recorded
                    </TableCell>
                  </TableRow>
                ) : (
                  baselines.map((b) => (
                    <TableRow key={`${b.scenario}-${b.runId ?? 'na'}`}>
                      <TableCell className="text-xs font-medium">{b.scenario}</TableCell>
                      <TableCell className="text-right tabular-nums">{b.samples}</TableCell>
                      <TableCell className="text-right tabular-nums">{ms(b.ttftP95)}</TableCell>
                      <TableCell className="text-right tabular-nums">{ms(b.genP95)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
