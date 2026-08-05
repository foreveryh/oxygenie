/**
 * Internal-API contract for model resolution (PR4 / arch finding A1; v2 registry).
 *
 * The shared, versioned shape exchanged across the ws-server ↔ web-app process
 * boundary. The web-app route validates its response against this schema; ws-server
 * (plain JS) consumes the same field set. Defining the contract once is the template
 * the project's other untyped internal `/api/*` endpoints should converge to.
 *
 * v2: adds `protocol` and the SEALED `credentialEncrypted` (secret-box format —
 * useless without the server-side KIN_SECRET_KEY; ws-server opens it just-in-time in
 * buildWorkerEnv). `tokenEnv` (env-var NAME) is now nullable. Plaintext tokens still
 * NEVER cross the wire.
 */

import { z } from 'zod';

export const RESOLVE_MODEL_CONTRACT_VERSION = 2;

export const resolveModelResponseSchema = z.object({
  v: z.literal(RESOLVE_MODEL_CONTRACT_VERSION),
  id: z.string(),
  model: z.string(),
  capabilities: z.array(z.enum(['chat', 'vision', 'image', 'video', 'embedding'])),
  connectionId: z.string(),
  baseUrl: z.string().url(),
  authStyle: z.enum(['bearer', 'x-api-key']),
  protocol: z.enum(['anthropic', 'openai-compat', 'gemini', 'custom']),
  mediaAdapter: z.string().nullable(),
  mediaConfig: z.record(z.string(), z.json()),
  credentialEncrypted: z.string().nullable(),
  tokenEnv: z.string().nullable(),
  anthropicVersion: z.string(),
  customHeaders: z.record(z.string(), z.string()).nullable(),
  aliasOpus: z.string().nullable(),
  aliasSonnet: z.string().nullable(),
  aliasHaiku: z.string().nullable(),
  aliasSubagent: z.string().nullable(),
  enabled: z.boolean(),
  health: z.enum(['healthy', 'unhealthy', 'unknown']),
});

export type ResolveModelResponse = z.infer<typeof resolveModelResponseSchema>;

/** Contract for /api/models/worker-vars — sealed global variables for worker spawn. */
export const WORKER_VARS_CONTRACT_VERSION = 1;

export const workerVarsResponseSchema = z.object({
  v: z.literal(WORKER_VARS_CONTRACT_VERSION),
  vars: z.array(z.object({ key: z.string(), valueEncrypted: z.string() })),
});

export type WorkerVarsResponse = z.infer<typeof workerVarsResponseSchema>;
