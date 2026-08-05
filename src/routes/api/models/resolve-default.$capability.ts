/**
 * Internal capability-default resolve endpoint (registry v2) — plaintext-free
 * metadata for the ws-server media-gen routing path.
 *
 * GET /api/models/resolve-default/:capability → the GLOBAL default model's connection
 * metadata for that capability (image/video/vision/embedding), same shape as
 * /api/models/resolve/:id (resolve.$id.ts) so ws-server can reuse one decrypt path
 * (build-worker-env.js) for both. Canvas has no projectId (D5: independent of
 * Project), so this only resolves the global slot — no per-project override.
 * Cookie-authed like the other internal endpoints.
 */

import { createFileRoute } from '@tanstack/react-router';
import { requireUser } from '~/server/require-user';
import { getDefaultModelFor, resolveModelMeta } from '~/server/models/registry';
import { MODEL_CAPABILITIES, type ModelCapability } from '~/db/schema/model.schema';
import {
  RESOLVE_MODEL_CONTRACT_VERSION,
  resolveModelResponseSchema,
} from '~/server/models/resolve-contract';

export const Route = createFileRoute('/api/models/resolve-default/$capability')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        await requireUser(request); // any authenticated org user; metadata is non-secret
        if (!(MODEL_CAPABILITIES as readonly string[]).includes(params.capability)) {
          return Response.json({ error: 'Unknown capability' }, { status: 400 });
        }
        const modelId = await getDefaultModelFor(params.capability as ModelCapability, null);
        if (!modelId) {
          return Response.json({ error: 'No default model configured' }, { status: 404 });
        }
        const meta = await resolveModelMeta(modelId);
        if (!meta) {
          return Response.json({ error: 'Model not found' }, { status: 404 });
        }
        const body = resolveModelResponseSchema.parse({ v: RESOLVE_MODEL_CONTRACT_VERSION, ...meta });
        return Response.json(body);
      },
    },
  },
});
