/**
 * Internal worker-vars endpoint (registry v2) — SEALED global variables for the
 * ws-server spawn path.
 *
 * GET /api/models/worker-vars → { v, vars: [{ key, valueEncrypted }] } for every
 * global_variable row with injectWorker=true. Values stay sealed across the process
 * boundary (same posture as resolve.$id); ws-server opens them with its own
 * KIN_SECRET_KEY right before spawning the agent worker. Cookie-authed.
 */

import { createFileRoute } from '@tanstack/react-router';
import { requireUser } from '~/server/require-user';
import { getWorkerVarsSealed } from '~/server/models/global-vars';
import { WORKER_VARS_CONTRACT_VERSION, workerVarsResponseSchema } from '~/server/models/resolve-contract';

export const Route = createFileRoute('/api/models/worker-vars')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await requireUser(request);
        const vars = await getWorkerVarsSealed();
        const body = workerVarsResponseSchema.parse({ v: WORKER_VARS_CONTRACT_VERSION, vars });
        return Response.json(body);
      },
    },
  },
});
