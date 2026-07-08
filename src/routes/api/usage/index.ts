/**
 * Usage API (P2-1 observation + P2-3 metering)
 *
 * POST /api/usage - Record per-run token/turn/cost usage (internal use by WS server)
 * and, when metering is enabled, charge the corresponding credits.
 *
 * The WS server forwards the SDK `result` event's usage data here after each run.
 * One run may use multiple models (modelUsage); we insert one row per model, all
 * sharing a generated runId.
 *
 * Metering (P2-3) is OFF by default and gated behind BILLING_METERING_ENABLED.
 * The conversion rate is an uncalibrated placeholder until real P2-1 data + owner
 * sign-off — see src/config/credit-rates.ts and
 * docs/project/research/2026-05-billing-design.md.
 */

import { createFileRoute } from '@tanstack/react-router';
import { randomUUID } from 'node:crypto';
import { db } from '~/db/db-config';
import { usageRecord } from '~/db/schema';
import { requireUser } from '~/server/require-user';
import { buildUsageRows, type UsageBody } from '~/server/usage/build-usage-rows';
import { creditsForModelUsage, isMeteringEnabled } from '~/config/credit-rates';
import { spendCredits, InsufficientCreditsError } from '~/server/credits';

type Metering =
  | { enabled: false }
  | { enabled: true; credits: number; charged: boolean; insufficient?: boolean };

export const Route = createFileRoute('/api/usage/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await requireUser(request);

        const body = (await request.json()) as UsageBody;
        const runId = body.runId ?? `run_${randomUUID()}`;
        const rows = buildUsageRows(user.id, body, runId);

        await db.insert(usageRecord).values(rows);

        // P2-3: charge credits for this run when metering is enabled. Recording
        // always happens above; charging is additive and flag-gated.
        let metering: Metering = { enabled: false };
        if (isMeteringEnabled()) {
          const fallbackTokens =
            (Number(body.usage?.input_tokens) || 0) + (Number(body.usage?.output_tokens) || 0);
          const credits = creditsForModelUsage(body.modelUsage, fallbackTokens);
          try {
            await spendCredits(user.id, credits, { runId, kind: 'run_usage' });
            metering = { enabled: true, credits, charged: true };
          } catch (error) {
            if (error instanceof InsufficientCreditsError) {
              metering = { enabled: true, credits, charged: false, insufficient: true };
            } else {
              throw error;
            }
          }
        }

        return Response.json({ recorded: rows.length, runId, metering });
      },
    },
  },
});
