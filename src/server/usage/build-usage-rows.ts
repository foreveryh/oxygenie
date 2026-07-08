/**
 * Pure transform for P2-1 usage records — no DB/router imports, unit-testable.
 *
 * Maps the SDK `result` event's usage payload into one DB row PER MODEL (a run
 * may use several models, e.g. a main model + a sub-agent model). Falls back to a
 * single 'unknown' row built from top-level usage when modelUsage is absent/empty.
 */

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
};

export type UsageBody = {
  sessionId?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  } | null;
  numTurns?: number;
  totalCostUsd?: number;
  modelUsage?: Record<string, ModelUsage> | null;
  isError?: boolean;
  // T2: optional caller-provided runId so ws-server can correlate usage_record
  // with run_summary using the same key.
  runId?: string | null;
};

export type UsageRow = {
  userId: string;
  sessionId: string | null;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  costUsd: string;
  isError: boolean;
};

const toInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

const toCost = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(6) : '0';
};

export function buildUsageRows(userId: string, body: UsageBody, runId: string): UsageRow[] {
  const sessionId = body.sessionId ?? null;
  const numTurns = toInt(body.numTurns);
  const isError = body.isError === true;

  const modelEntries = Object.entries(body.modelUsage ?? {});

  if (modelEntries.length > 0) {
    return modelEntries.map(([model, mu]) => ({
      userId,
      sessionId,
      runId,
      model,
      inputTokens: toInt(mu?.inputTokens),
      outputTokens: toInt(mu?.outputTokens),
      numTurns,
      costUsd: toCost(mu?.costUSD),
      isError,
    }));
  }

  return [
    {
      userId,
      sessionId,
      runId,
      model: 'unknown',
      inputTokens: toInt(body.usage?.input_tokens),
      outputTokens: toInt(body.usage?.output_tokens),
      numTurns,
      costUsd: toCost(body.totalCostUsd),
      isError,
    },
  ];
}
