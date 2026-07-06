#!/usr/bin/env node
/**
 * WebSocket Server for Claude Agent Chat
 *
 * This is a standalone WebSocket server that runs alongside the main Nitro server.
 * For production use with Docker, run this as a sidecar or use the combined startup script.
 *
 * Environment variables:
 * - WS_PORT: WebSocket server port (default: 3001)
 * - APP_URL: Main application URL for auth (default: http://localhost:5000)
 * - CLAUDE_SESSIONS_ROOT: Root directory for user sessions (default: /data/users)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, access, symlink, unlink, lstat, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Semaphore } from './src/server/concurrency/semaphore.js';
import { shouldReapIdle } from './src/server/concurrency/idle-reaper.js';
import { sessionRegistry } from './src/server/concurrency/session-registry.js';
import { resolveEffectivePermission } from './src/lib/permission-tier.js';
import { PreviewAuth } from './src/preview/auth.js';
import { PreviewRuntime } from './src/preview/runtime.js';
import { buildWorkerEnv, buildMediaGenEnv } from './src/server/models/build-worker-env.js';
import { openSecret } from './src/server/security/secret-box.js';
import { isSyntheticTranscriptEntry } from './src/server/history/transcript-filter.js';
import IORedis from 'ioredis';
import { Queue as BullmqQueue } from 'bullmq';

// Get directory of current module
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'ws-query-worker.mjs');

// Conversation search (FR2): enqueue an incremental message-index job to the BullMQ 'system'
// queue when a turn completes. MUST use the same connection/queue/prefix as src/worker/index.ts
// — the app container has to set BULLMQ_PREFIX to match the worker (compose), else jobs are
// invisible to it. Best-effort + fire-and-forget: indexing must never affect chat.
const messageIndexConnection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
const messageIndexQueue = new BullmqQueue(process.env.BULLMQ_QUEUE ?? 'system', {
  connection: messageIndexConnection,
  prefix: process.env.BULLMQ_PREFIX ?? 'constructa',
});
async function enqueueMessageIndex(userId, sdkSessionId) {
  if (!userId || !sdkSessionId) return;
  try {
    await messageIndexQueue.add(
      'index-session-messages',
      { userId, sdkSessionId },
      { removeOnComplete: true, removeOnFail: 50 },
    );
  } catch (err) {
    console.error('[WS Server] enqueue message-index failed (non-fatal):', err?.message || err);
  }
}

// Privacy: user messages contain prompts (PII). By default log only a safe summary
// (type + byte length), never raw content. Set DEBUG_WS_MESSAGES=true to see previews.
const DEBUG_WS_MESSAGES = process.env.DEBUG_WS_MESSAGES === 'true';
function summarizeMessage(msg) {
  const raw = typeof msg === 'string' ? msg : msg?.toString?.() ?? '';
  if (DEBUG_WS_MESSAGES) return raw.substring(0, 500);
  let type = 'unknown';
  try { type = JSON.parse(raw)?.type ?? 'unknown'; } catch { type = 'unparseable'; }
  return `<${raw.length} bytes, type=${type}>`;
}

// Configuration
const WS_PORT = parseInt(process.env.WS_PORT || '3001', 10);
const APP_URL = process.env.APP_URL || 'http://localhost:5000';

// S1 — single-host worker concurrency cap. Each active agent worker is a Node +
// Claude Agent SDK child (~150–300 MB). Cap how many run at once so a burst of
// concurrent chats queues instead of spawning unboundedly and OOM-ing the box.
// Default 8 (tuned for a 16 GB / 8-core VPS targeting ~50 concurrent sessions —
// most sessions are idle/awaiting the model, so a few parallel workers suffice).
const MAX_CONCURRENT_WORKERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_WORKERS || '8', 10) || 8,
);
const workerSemaphore = new Semaphore(MAX_CONCURRENT_WORKERS);
console.log(`[WS Server] Max concurrent workers: ${MAX_CONCURRENT_WORKERS}`);

// FR3 (concurrent sessions PRD 2026-06-15) — per-user concurrency cap. The
// global semaphore above is the HOST ceiling (shared by everyone); this is a
// fairness cap so a single user can't occupy all 8 slots. A user already running
// `PER_USER_MAX_WORKERS` sessions queues their next one (FIFO) behind their own
// running ones. Counted PER USER across all their connections (tabs) via one
// Semaphore per userId — the registry is the cross-connection truth. Silent init
// runs (quick metadata loads) are exempt. Acquire order is always user-then-global
// (no circular wait). userSemaphores grows by at most one small object per distinct
// user seen this process lifetime (negligible for a self-hosted single-org app).
const PER_USER_MAX_WORKERS = Math.max(
  1,
  parseInt(process.env.PER_USER_MAX_WORKERS || '3', 10) || 3,
);
const userSemaphores = new Map(); // userId → Semaphore(PER_USER_MAX_WORKERS)
function getUserSemaphore(userId) {
  let sem = userSemaphores.get(userId);
  if (!sem) {
    sem = new Semaphore(PER_USER_MAX_WORKERS);
    userSemaphores.set(userId, sem);
  }
  return sem;
}
console.log(`[WS Server] Max concurrent workers per user: ${PER_USER_MAX_WORKERS}`);

// S2 — per-worker V8 heap cap. S1 bounds *how many* workers run; S2 bounds *how
// much* each can grow, so one runaway worker (infinite loop / leak) can't eat the
// whole 16 GB host. Passed to node as --max-old-space-size (MB). Note this caps
// the V8 old-space heap only; process RSS typically runs ~20-30% higher. Default
// 1536 MB (8 parallel × 1.5 G heap stays well under 16 GB with system headroom).
// Set to 0 to disable the cap (use node's default heap sizing).
const rawWorkerMaxOldSpaceMb = parseInt(process.env.WORKER_MAX_OLD_SPACE_MB ?? '', 10);
const WORKER_MAX_OLD_SPACE_MB = Number.isFinite(rawWorkerMaxOldSpaceMb)
  ? Math.max(0, rawWorkerMaxOldSpaceMb)
  : 1536;
console.log(
  `[WS Server] Worker max old-space: ${WORKER_MAX_OLD_SPACE_MB ? WORKER_MAX_OLD_SPACE_MB + ' MB' : 'unbounded (node default)'}`,
);

/**
 * Resolve SESSIONS_ROOT with same logic as manager.ts getUserClaudeHome()
 * - If CLAUDE_SESSIONS_ROOT is set, use it
 * - Otherwise, check if /data/users exists (Docker production)
 * - Fall back to ./user-data (development)
 */
function resolveSessionsRoot() {
  const envRoot = process.env.CLAUDE_SESSIONS_ROOT;
  if (envRoot && envRoot.trim()) {
    // IMPORTANT: resolve to an ABSOLUTE path. A relative value (e.g. "./user-data")
    // would resolve differently for the ws-server (cwd = repo root) vs the worker
    // (cwd = per-session workspace), so the SDK would write the transcript under the
    // workspace while resume looks for it under the repo root → "Session file not
    // found" → conversation history fails to reload. Absolute = both agree.
    return path.resolve(envRoot.trim());
  }
  // Check for Docker production path
  const dockerPath = '/data/users';
  if (existsSync(dockerPath)) {
    return dockerPath;
  }
  // Development fallback
  return path.join(process.cwd(), 'user-data');
}

const SESSIONS_ROOT = resolveSessionsRoot();
// Normalize the env var to the resolved ABSOLUTE path so spawned workers (which
// inherit process.env) and the skills/mcp managers (which read CLAUDE_SESSIONS_ROOT)
// all resolve to the same location regardless of their cwd.
process.env.CLAUDE_SESSIONS_ROOT = SESSIONS_ROOT;
console.log('[WS Server] Sessions root:', SESSIONS_ROOT);

const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  model: process.env.ANTHROPIC_MODEL,
  cwd: process.cwd(),
};

const previewAuth = new PreviewAuth({
  secret: process.env.PREVIEW_AUTH_SECRET || process.env.BETTER_AUTH_SECRET,
  bootstrapTtlMs: Number(process.env.PREVIEW_BOOTSTRAP_TTL_MS) || undefined,
  cookieTtlMs: Number(process.env.PREVIEW_COOKIE_TTL_MS) || undefined,
  secureCookies: process.env.PREVIEW_COOKIE_SECURE
    ? process.env.PREVIEW_COOKIE_SECURE === '1'
    : process.env.NODE_ENV === 'production',
});
const previewRuntime = new PreviewRuntime({ auth: previewAuth });

const PERMISSION_MODES = new Set([
  'default',
  'plan',
  'dontAsk',
  'acceptEdits',
  'delegate',
  'bypassPermissions',
]);

const BYPASS_USER_IDS = new Set(
  (process.env.CLAUDE_BYPASS_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

const ALLOW_BASH_IN_BYPASS = process.env.CLAUDE_ALLOW_BASH === 'true';

// Note: Thinking/reasoning is handled by SDK's claude_code preset automatically
// No need to explicitly pass maxThinkingTokens - SDK uses sensible defaults

function normalizePermissionMode(mode) {
  if (!mode) {
    return 'default';
  }
  if (PERMISSION_MODES.has(mode)) {
    return mode;
  }
  return 'default';
}

function resolvePermissionMode(userId, requestedMode = process.env.CLAUDE_PERMISSION_MODE) {
  const normalized = normalizePermissionMode(requestedMode);
  if (normalized === 'bypassPermissions') {
    if (userId && BYPASS_USER_IDS.has(userId)) {
      return 'bypassPermissions';
    }
    return 'default';
  }
  return normalized;
}

function resolveDisallowedTools(_permissionMode, _allowBash) {
  // Native Claude Code `Bash` is ALWAYS disallowed — it bypasses our sandbox (path
  // fence, resource limits, egress allowlist, env-stripping). Shell capability is
  // delivered only via the sandboxed mcp__bash__run wrapper, which the worker gates
  // on allowBash separately. permissionMode (Ask/Act) does NOT re-open native Bash.
  return ['Bash'];
}

/**
 * Fetch permission info from the API
 * Returns organization-based permission settings or falls back to environment variables
 */
async function fetchPermissionInfo(cookie) {
  try {
    const response = await fetch(`${APP_URL}/api/auth/permission-info`, {
      headers: { cookie },
    });

    if (!response.ok) {
      console.warn('[WS Server] Failed to fetch permission info:', response.status, response.statusText);
      return null;
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[WS Server] Error fetching permission info:', error);
    return null;
  }
}

// Handle uncaught errors with detailed logging and flush
process.on('uncaughtException', (err) => {
  console.error('==========================================');
  console.error('[WS Server] UNCAUGHT EXCEPTION DETECTED');
  console.error('[WS Server] Error:', err);
  console.error('[WS Server] Stack:', err.stack);
  console.error('[WS Server] Type:', err.constructor.name);
  console.error('==========================================');

  // Force flush console output
  if (process.stdout.write('')) {
    process.stdout.once('drain', () => {
      console.error('[WS Server] Console flushed, exiting with code 1');
      process.exit(1);
    });
  } else {
    // If buffer is full, wait a bit then exit
    setTimeout(() => {
      console.error('[WS Server] Force exit after exception');
      process.exit(1);
    }, 100);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('==========================================');
  console.error('[WS Server] UNHANDLED REJECTION DETECTED');
  console.error('[WS Server] Reason:', reason);
  console.error('[WS Server] Promise:', promise);
  if (reason instanceof Error) {
    console.error('[WS Server] Stack:', reason.stack);
  }
  console.error('==========================================');

  // Force flush console output
  if (process.stdout.write('')) {
    process.stdout.once('drain', () => {
      console.error('[WS Server] Console flushed, exiting with code 1');
      process.exit(1);
    });
  } else {
    setTimeout(() => {
      console.error('[WS Server] Force exit after rejection');
      process.exit(1);
    }, 100);
  }
});

// Track process exit
process.on('exit', (code) => {
  console.error('[WS Server] ========== PROCESS EXIT ==========');
  console.error('[WS Server] Exit code:', code);
  console.error('[WS Server] ===============================');
});

process.on('SIGTERM', () => {
  console.error('[WS Server] ========== RECEIVED SIGTERM ==========');
  console.error('[WS Server] Process will be terminated');
  console.error('[WS Server] ================================');
});

process.on('SIGINT', () => {
  console.error('[WS Server] ========== RECEIVED SIGINT ==========');
  console.error('[WS Server] Process will be interrupted');
  console.error('[WS Server] ===============================');
});

process.on('SIGHUP', () => {
  console.error('[WS Server] ========== RECEIVED SIGHUP ==========');
  console.error('[WS Server] Terminal disconnected signal');
  console.error('[WS Server] ===============================');
});

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// S3 — idle-connection reaper. The heartbeat above terminates *dead* sockets
// (no pong); this reaps *alive-but-idle* ones (tab left open, laptop asleep)
// that hold a connection slot without doing work. Only genuine business
// messages refresh activity (a keepalive ping must not, or a zombie tab that
// auto-pings would never time out); a connection with an active worker is never
// reaped (a long query can stream for minutes with no inbound message). Checked
// on the heartbeat cadence. Default 15 min; set to 0 to disable reaping.
const rawWsIdleTimeoutMs = parseInt(process.env.WS_IDLE_TIMEOUT_MS ?? '', 10);
const WS_IDLE_TIMEOUT_MS = Number.isFinite(rawWsIdleTimeoutMs)
  ? Math.max(0, rawWsIdleTimeoutMs)
  : 15 * 60 * 1000;
console.log(
  `[WS Server] WS idle timeout: ${WS_IDLE_TIMEOUT_MS ? Math.round(WS_IDLE_TIMEOUT_MS / 1000) + 's' : 'disabled'}`,
);

// Inbound message types that count as real user activity (refresh idle timer).
// Excludes the keepalive 'ping' control frame and any unknown/invalid type.
const BUSINESS_MESSAGE_TYPES = new Set([
  'create_session',
  'init_session',
  'chat',
  'resume',
  'abort',
  'start_preview',
  'stop_preview',
  'share_preview',
  'approval_response',
]);

// Track initialized directories
const initializedDirs = new Set();

// Map workspace sessionId to SDK sessionId for resume
// Structure: { workspaceSessionId: sdkSessionId }
const sessionMapping = new Map();

/**
 * Persist session to database via API
 * @param {string} cookie - User's auth cookie
 * @param {string} workspaceSessionId - Our workspace session ID (used as sdkSessionId in DB)
 * @param {string} realSdkSessionId - The actual SDK's session ID
 * @param {string} claudeHomePath - Path to CLAUDE_HOME
 * @param {string} [title] - Optional session title (extracted from first user message)
 * @param {{ projectId?: string, branchedFromSessionId?: string }} [lineage] - Branch
 *   lineage stamped on CREATE only (server validates membership/visibility). Omit for
 *   normal sessions; set when pre-creating a branch session D2.
 */
async function persistSession(cookie, workspaceSessionId, realSdkSessionId, claudeHomePath, title, lineage = null) {
  try {
    const response = await fetch(`${APP_URL}/api/agent-sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        sdkSessionId: workspaceSessionId,
        claudeHomePath,
        realSdkSessionId,
        // Use first user message as title (truncated to 50 chars)
        ...(title && { title }),
        ...(lineage?.projectId && { projectId: lineage.projectId }),
        ...(lineage?.branchedFromSessionId && { branchedFromSessionId: lineage.branchedFromSessionId }),
        ...(lineage?.canvasId && { canvasId: lineage.canvasId }),
      }),
    });

    if (!response.ok) {
      console.error('[WS Server] Failed to persist session:', response.status, await response.text());
      return null;
    }

    const result = await response.json();
    console.log(`[WS Server] Session persisted: ${result.id} (created: ${result.created})`);
    return result; // { id, created } — callers may check this (branch pre-create requires it)
  } catch (error) {
    console.error('[WS Server] Error persisting session:', error);
    return null;
  }
}

/**
 * P2-1/P2-3: Record per-run usage and (when metering is enabled) charge credits.
 *
 * Extracts token/turn/cost data from the SDK `result` event and posts it to
 * /api/usage. Fire-and-forget — usage logging must never block or break a run.
 *
 * P2-3: when metering is enabled server-side, the response reports whether the
 * run was charged; if the user is out of credits we forward a non-fatal warning
 * frame to the client (metering is OFF by default, so this is normally dormant).
 *
 * @param {object} ws - The client WebSocket (provides cookie + workspaceSessionId)
 * @param {object} event - The SDK `result` event
 */
async function recordUsage(ws, event, sessionId = ws.workspaceSessionId) {
  try {
    const response = await fetch(`${APP_URL}/api/usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: ws.cookie,
      },
      body: JSON.stringify({
        // Explicit session id (concurrent sessions): the caller passes THIS run's
        // output session, since ws.workspaceSessionId is connection-level and can
        // be clobbered by an interleaved run.
        sessionId: sessionId ?? null,
        usage: event.usage ?? null,
        numTurns: event.num_turns ?? 0,
        totalCostUsd: event.total_cost_usd ?? 0,
        modelUsage: event.modelUsage ?? null,
        // result is_error, or any non-success subtype, counts as an errored run
        isError: event.is_error === true || (event.subtype && event.subtype !== 'success'),
      }),
    });

    if (!response.ok) {
      console.error('[WS Server] Failed to record usage:', response.status, await response.text());
      return;
    }

    const result = await response.json();
    console.log(`[WS Server] Usage recorded: run ${result.runId} (${result.recorded} model rows)`);

    // P2-3: metering is gated server-side; warn the client when out of credits.
    if (result.metering?.enabled && result.metering.insufficient) {
      sendMessage(ws, {
        type: 'credit_warning',
        code: 'insufficient_credits',
        credits: result.metering.credits,
        message: 'You are out of credits — this run was not charged. Top up to continue.',
      });
    }
  } catch (error) {
    console.error('[WS Server] Error recording usage:', error);
  }
}

/**
 * P2 observability: record runtime performance samples for one finished run.
 *
 * Derived purely from the terminal SDK `result` event (no per-delta hot-path
 * change): total wall-clock generation time and output throughput. Fire-and-
 * forget via /api/perf — must never block or break a run. True runtime TTFT
 * (first-token latency) needs per-delta instrumentation and is deferred (P3);
 * the load-test harness already measures TTFT under a non-`runtime` scenario.
 *
 * @param {object} ws - The client WebSocket (provides cookie)
 * @param {object} event - The SDK `result` event
 * @param {string|null} sessionId - This run's output session id
 */
async function recordPerf(ws, event, sessionId) {
  try {
    const samples = [];
    const route = 'ws.generate';
    const primaryModel = event.modelUsage ? Object.keys(event.modelUsage)[0] ?? null : null;
    const totalMs = Number(event.duration_ms);
    const apiMs = Number(event.duration_api_ms);
    const outputTokens = Number(event?.usage?.output_tokens);
    const base = {
      route,
      sessionId: sessionId ?? null,
      model: primaryModel,
      scenario: 'runtime',
    };

    if (Number.isFinite(totalMs) && totalMs > 0) {
      samples.push({ ...base, metric: 'generation.total_ms', value: totalMs, unit: 'ms' });
      if (Number.isFinite(outputTokens) && outputTokens > 0) {
        samples.push({
          ...base,
          metric: 'generation.tokens_per_s',
          value: outputTokens / (totalMs / 1000),
          unit: 'tokens_per_s',
        });
      }
    }
    if (Number.isFinite(apiMs) && apiMs > 0) {
      samples.push({ ...base, metric: 'generation.api_ms', value: apiMs, unit: 'ms' });
    }
    if (samples.length === 0) return;

    const response = await fetch(`${APP_URL}/api/perf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: ws.cookie },
      body: JSON.stringify({ samples }),
    });
    if (!response.ok) {
      console.error('[WS Server] Failed to record perf:', response.status);
    }
  } catch (error) {
    console.error('[WS Server] Error recording perf:', error);
  }
}

/**
 * P2-2: Append a security-relevant audit event via /api/audit.
 *
 * Fire-and-forget — audit logging must never block or break the action it
 * records. The acting user is taken from the cookie server-side (not spoofable).
 *
 * @param {string} cookie - Auth cookie for the acting user
 * @param {string} action - Dotted action key, e.g. 'run.abort', 'run.bypass_mode'
 * @param {string|null} target - Optional subject (e.g. session id)
 * @param {Record<string, unknown>} [meta] - Structured context
 */
async function recordAuditEvent(cookie, action, target, meta = {}) {
  try {
    const response = await fetch(`${APP_URL}/api/audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie,
      },
      body: JSON.stringify({ action, target: target ?? null, meta }),
    });
    if (!response.ok) {
      console.error('[WS Server] Failed to record audit:', response.status, await response.text());
    }
  } catch (error) {
    console.error('[WS Server] Error recording audit:', error);
  }
}

/**
 * Load session data from database
 * Returns full session info including realSdkSessionId and claudeHomePath
 */
async function loadSessionFromDb(cookie, workspaceSessionId) {
  try {
    const response = await fetch(`${APP_URL}/api/agent-sessions/by-sdk-id/${workspaceSessionId}`, {
      headers: { cookie },
    });

    if (!response.ok) {
      console.log(`[WS Server] Session not found in DB: ${workspaceSessionId}`);
      return null;
    }

    const data = await response.json();
    console.log(`[WS Server] Loaded session from DB: realSdkSessionId=${data.realSdkSessionId}, claudeHomePath=${data.claudeHomePath}`);
    return data;
  } catch (error) {
    console.error('[WS Server] Error loading session from DB:', error);
    return null;
  }
}

/**
 * Load a session by its INTERNAL id (uuid). Used to resolve a branch's SOURCE session
 * (branchedFromSessionId) so a branch shares the source's workspace. The `$id` route gates
 * visibility (canAccessSession), so a non-member gets null. Returns the full row or null.
 */
async function loadSessionById(cookie, sessionId) {
  try {
    const response = await fetch(`${APP_URL}/api/agent-sessions/${sessionId}`, { headers: { cookie } });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error('[WS Server] Error loading session by id:', error);
    return null;
  }
}

/**
 * Locate session JSONL file across project directories
 * JSONL files are stored at: CLAUDE_HOME/.claude/projects/{project}/{sessionId}.jsonl
 */
async function locateSessionFile(claudeHome, sessionId) {
  // Resolve to absolute in case a legacy session stored a relative claude_home_path.
  const projectsRoot = path.join(path.resolve(claudeHome), '.claude', 'projects');

  try {
    await access(projectsRoot);
  } catch {
    console.log(`[WS Server] Projects root not found: ${projectsRoot}`);
    return null;
  }

  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    const projectDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectsRoot, e.name));

    for (const projectDir of projectDirs) {
      const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
      try {
        await access(sessionPath);
        return sessionPath;
      } catch {
        // Continue to next project directory
      }
    }
  } catch (error) {
    console.error('[WS Server] Error scanning project directories:', error);
  }

  return null;
}

/**
 * Parse JSONL content into SDK messages
 * Normalizes sessionId to session_id and filters invalid entries
 */
function parseJsonlContent(content) {
  if (!content) return [];

  const lines = content.split(/\r?\n/);
  const messages = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);

      const parsedType = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : '';

      // Skip summary type messages
      if (parsedType === 'summary') continue;

      // Skip SDK-synthetic / legacy eager-init turns that would render as
      // bogus user/assistant messages ("Continue from where you left off." +
      // "No response requested.", blank init prompts). Display-only filter.
      if (isSyntheticTranscriptEntry(parsed)) continue;

      // Normalize sessionId to session_id
      const normalized = { ...parsed };
      if ('sessionId' in normalized) {
        normalized.session_id = normalized.sessionId;
        delete normalized.sessionId;
      }

      messages.push(normalized);
    } catch {
      // Skip malformed JSON lines
      continue;
    }
  }

  return messages;
}

/**
 * Load messages for a session from JSONL file
 * @param {string} claudeHome - Path to CLAUDE_HOME for this user
 * @param {string} sessionId - SDK session ID to load messages for
 * @returns {Promise<Array>} Array of SDK messages
 */
async function loadMessages(claudeHome, sessionId) {
  if (!sessionId) {
    return [];
  }

  const filePath = await locateSessionFile(claudeHome, sessionId);
  if (!filePath) {
    console.log(`[WS Server] Session file not found for: ${sessionId}`);
    return [];
  }

  try {
    console.log(`[WS Server] Loading messages from: ${filePath}`);
    const content = await readFile(filePath, 'utf8');
    const messages = parseJsonlContent(content);
    console.log(`[WS Server] Loaded ${messages.length} messages for session: ${sessionId}`);
    return messages;
  } catch (error) {
    console.error(`[WS Server] Failed to read session file: ${filePath}`, error);
    return [];
  }
}

/**
 * Generate a unique session ID
 */
function generateSessionId() {
  return crypto.randomUUID();
}

function stripSkillMarker(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) return '';
  const lines = prompt.split(/\r?\n/);
  if (!lines.length) return prompt;
  const first = lines[0].trim();
  if (first.startsWith('[[skill:') && first.endsWith(']]')) {
    return lines.slice(1).join('\n').trim();
  }
  return prompt.trim();
}

/**
 * Sanitize userId/sessionId to prevent path traversal attacks
 */
function sanitizeId(id) {
  return id.replace(/[\/\\\.]+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Get user-specific CLAUDE_HOME path
 */
function getClaudeHome(userId) {
  const safeUserId = sanitizeId(userId);
  return path.join(SESSIONS_ROOT, safeUserId);
}

/**
 * Get session-specific workspace path
 * Structure: /data/users/{userId}/sessions/{sessionId}/workspace/
 */
function getSessionWorkspace(userId, sessionId) {
  const safeUserId = sanitizeId(userId);
  const safeSessionId = sanitizeId(sessionId);
  return path.join(SESSIONS_ROOT, safeUserId, 'sessions', safeSessionId, 'workspace');
}

/**
 * Get canvas-workspace-specific workspace path (Canvas Agent, D5). Unlike a per-session
 * workspace, ALL agent sessions opened against the same canvasId share this ONE directory
 * — that's how "Agent A generates an image, Agent B in a second session sees it via ls"
 * works. Structure: /data/users/{userId}/canvases/{canvasId}/workspace/
 */
function getCanvasWorkspace(userId, canvasId) {
  const safeUserId = sanitizeId(userId);
  const safeCanvasId = sanitizeId(canvasId);
  return path.join(SESSIONS_ROOT, safeUserId, 'canvases', safeCanvasId, 'workspace');
}

/**
 * Ensure directory exists
 */
async function ensureDirExists(dirPath) {
  if (initializedDirs.has(dirPath)) {
    return;
  }

  try {
    await mkdir(dirPath, { recursive: true });
    initializedDirs.add(dirPath);
    console.log(`[WS Server] Created directory: ${dirPath}`);
  } catch (error) {
    console.error(`[WS Server] Failed to create directory:`, error);
    throw error;
  }
}

/**
 * Ensure .claude symlink exists in workspace pointing to user's .claude directory
 * This allows SDK to find skills/settings in the user's directory while working in session workspace
 */
async function ensureClaudeSymlink(workspacePath, claudeHome) {
  const symlinkPath = path.join(workspacePath, '.claude');
  const targetPath = path.join(claudeHome, '.claude');

  try {
    // Check if symlink already exists
    const stats = await lstat(symlinkPath);

    if (stats.isSymbolicLink()) {
      // Symlink exists, verify it points to correct target
      console.log(`[WS Server] .claude symlink already exists in workspace`);
      return;
    } else {
      // Path exists but is not a symlink, remove it
      console.log(`[WS Server] .claude exists but is not a symlink, removing...`);
      await unlink(symlinkPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[WS Server] Error checking .claude symlink:`, error);
      throw error;
    }
    // ENOENT is expected if symlink doesn't exist yet
  }

  // Create the symlink
  try {
    await symlink(targetPath, symlinkPath, 'dir');
    console.log(`[WS Server] Created .claude symlink: ${symlinkPath} -> ${targetPath}`);
  } catch (error) {
    // Canvas workspaces (D5) are shared by multiple sessions from the moment they're
    // created, unlike a per-session workspace where this race is impossible: two
    // sessions can both lstat a brand-new shared workspace, both see ENOENT, and both
    // reach symlink() — the loser gets EEXIST. That's not a failure, just a concurrent
    // creator winning first; treat it as success.
    if (error.code === 'EEXIST') {
      console.log(`[WS Server] .claude symlink created concurrently by another session, continuing`);
      return;
    }
    console.error(`[WS Server] Failed to create .claude symlink:`, error);
    throw error;
  }
}

/**
 * Verify that skills are accessible through the .claude symlink
 * This health check ensures SDK can actually load skills from the workspace
 *
 * @param {string} workspacePath - Session workspace path
 * @param {string} claudeHome - User's CLAUDE_HOME directory
 */
async function verifySkillsAccess(workspacePath, claudeHome) {
  const symlinkPath = path.join(workspacePath, '.claude');
  const skillsPath = path.join(workspacePath, '.claude', 'skills');
  const targetSkillsPath = path.join(claudeHome, '.claude', 'skills');

  // Step 1: Check symlink status
  let symlinkStatus = 'unknown';
  let symlinkTarget = null;
  try {
    const stats = await lstat(symlinkPath);
    if (stats.isSymbolicLink()) {
      symlinkStatus = 'valid';
      // Read the actual target
      const { readlink } = await import('node:fs/promises');
      symlinkTarget = await readlink(symlinkPath);
    } else {
      symlinkStatus = 'not_symlink';
    }
  } catch (error) {
    symlinkStatus = error.code === 'ENOENT' ? 'missing' : `error:${error.code}`;
  }

  // Step 2: Check target directory exists
  let targetExists = false;
  try {
    await access(targetSkillsPath);
    targetExists = true;
  } catch {
    targetExists = false;
  }

  // Step 3: Try to access skills through the symlink
  try {
    await access(skillsPath);

    const skillDirs = await readdir(skillsPath, { withFileTypes: true });
    const skills = skillDirs.filter(entry => entry.isDirectory()).map(entry => entry.name);

    if (skills.length > 0) {
      console.log(`[WS Server] ✓ Skills accessible: ${skills.length} skills found [${skills.join(', ')}]`);
    } else {
      console.log(`[WS Server] ⚠ Skills directory accessible but empty`);
    }

    return true;
  } catch (error) {
    // Enhanced error logging with diagnostic info
    const diagnostic = {
      symlinkStatus,
      symlinkTarget,
      targetSkillsPath,
      targetExists,
      errorCode: error.code,
    };

    if (error.code === 'ENOENT') {
      if (!targetExists) {
        // This is expected if user never enabled any skills
        console.log(`[WS Server] ℹ Skills directory not found (user has no skills enabled)`);
        console.log(`[WS Server]   diagnostic: ${JSON.stringify(diagnostic)}`);
      } else {
        // Target exists but can't access through symlink - this is a problem
        console.warn(`[WS Server] ⚠ Skills directory not accessible through symlink`);
        console.warn(`[WS Server]   diagnostic: ${JSON.stringify(diagnostic)}`);
      }
    } else {
      console.error(`[WS Server] ✗ Skills access error: ${error.message}`);
      console.error(`[WS Server]   diagnostic: ${JSON.stringify(diagnostic)}`);
    }
    return false;
  }
}

/**
 * Authenticate request using session cookie
 */
async function authenticateRequest(request) {
  try {
    const cookie = request.headers.cookie || '';
    const response = await fetch(`${APP_URL}/api/auth/get-session`, {
      headers: { cookie },
    });

    if (!response.ok) return null;

    const data = await response.json();
    console.log('[WS Server] Auth response:', JSON.stringify({ userId: data?.user?.id, email: data?.user?.email }));
    if (!data?.user?.id) return null;

    return { id: data.user.id };
  } catch (error) {
    console.error('[WS Server] Auth error:', error);
    return null;
  }
}

/**
 * Send message to WebSocket
 */
function sendMessage(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
    return ws.bufferedAmount;
  }
  return 0;
}

/**
 * Fan a frame out to every connection currently SUBSCRIBED to a session, and tag
 * it with the session id so the client can route it to the right conversation
 * (concurrent sessions / background-continue). The tag is the workspace/output
 * session id — the same id the client adopts as `currentSessionId` from
 * session_init — so the adapter matches on it directly. A session's subscribers
 * are normally just the originating connection (identical to the old single-send
 * behaviour); after a switch-away/refresh it's whoever is viewing it now (or
 * nobody, if it's running purely in the background).
 * @returns {number} the max WS bufferedAmount across subscribers (for backpressure).
 */
function fanoutToSession(sessionId, msg) {
  const tagged = msg.sessionId === undefined ? { ...msg, sessionId } : msg;
  let buffered = 0;
  for (const sub of sessionRegistry.subscribers(sessionId)) {
    const b = sendMessage(sub, tagged);
    if (b > buffered) buffered = b;
  }
  return buffered;
}

// Canvas Agent (D5) — project-channel-per-canvas broadcast (simpler than
// sessionRegistry: a canvas viewer is subscribed regardless of whether a worker is
// currently running, since asset_created/task_updated events can originate from a
// DIFFERENT session in the same workspace, or from the ingestor watching the
// filesystem directly — there's no "live worker" gate here).
const canvasChannels = new Map(); // canvasId -> Set<ws>

function subscribeCanvas(canvasId, ws) {
  let subs = canvasChannels.get(canvasId);
  if (!subs) {
    subs = new Set();
    canvasChannels.set(canvasId, subs);
  }
  subs.add(ws);
}

function unsubscribeCanvas(canvasId, ws) {
  const subs = canvasChannels.get(canvasId);
  if (!subs) return;
  subs.delete(ws);
  if (subs.size === 0) canvasChannels.delete(canvasId);
}

function unsubscribeCanvasConnection(ws) {
  for (const [canvasId, subs] of canvasChannels.entries()) {
    subs.delete(ws);
    if (subs.size === 0) canvasChannels.delete(canvasId);
  }
}

/** Broadcast a canvas_event to every connection currently viewing this canvas workspace. */
function broadcastCanvas(canvasId, event, payload) {
  const subs = canvasChannels.get(canvasId);
  if (!subs || subs.size === 0) return;
  const msg = { type: 'canvas_event', canvasId, event, payload };
  for (const sub of subs) sendMessage(sub, msg);
}

/**
 * Verify the requesting user owns this canvas workspace before letting them subscribe —
 * never trust a client-supplied canvasId (same rationale as project membership checks).
 */
async function verifyCanvasOwnership(cookie, canvasId, userId) {
  try {
    const response = await fetch(`${APP_URL}/api/canvases/${canvasId}`, { headers: { cookie } });
    if (!response.ok) return false;
    const data = await response.json();
    return data.ownerUserId === userId;
  } catch (error) {
    console.error('[WS Server] Error verifying canvas ownership:', error);
    return false;
  }
}

function nextPreviewSeq(ws) {
  ws.__previewSeq = (ws.__previewSeq || 0) + 1;
  return ws.__previewSeq;
}

function sendPreviewState(ws, state) {
  return sendMessage(ws, {
    type: 'preview_state',
    state,
    seq: nextPreviewSeq(ws),
  });
}

function normalizeHost(headerValue) {
  if (!headerValue) return '';
  return String(headerValue).split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

async function handlePreviewHttp(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'preview.local'}`);
  const forwardedHost = normalizeHost(req.headers['x-forwarded-host']);
  const host = forwardedHost || normalizeHost(req.headers.host);

  if (req.method === 'GET' && url.pathname === '/__oxy/preview/auth') {
    try {
      const token = url.searchParams.get('t');
      const entry = previewAuth.consumeBootstrapToken(token, { host });
      previewRuntime.touchPreview(entry.previewId);
      const session = previewAuth.createCookieSession(entry);
      redirect(res, '/', { 'set-cookie': session.cookie });
    } catch (error) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : 'Unauthorized preview');
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/__oxy/preview/authorize') {
    // Public (user-shared) previews bypass the cookie gate entirely so anyone
    // with the link can open them. The forward-auth middleware still runs; we
    // just always answer "ok" for hosts the user explicitly marked public.
    const publicState = previewRuntime.getStateByHost(host);
    if (publicState?.public) {
      previewRuntime.touchPreview(publicState.previewId);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'x-oxygenie-preview-id': publicState.previewId,
        'x-oxygenie-preview-public': '1',
      });
      res.end('ok');
      return true;
    }
    const verified = previewAuth.verifyCookie(req.headers.cookie || '', { host });
    if (!verified) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized preview');
      return true;
    }
    previewRuntime.touchPreview(verified.entry.previewId);
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'x-oxygenie-preview-id': verified.entry.previewId,
      'x-oxygenie-session-id': verified.entry.sessionId,
    });
    res.end('ok');
    return true;
  }

  return false;
}

// C4 backpressure (consumer side): bytes queued on the WS socket above/below
// which we pause/resume reading the worker's stdout, so a fast agent stream +
// slow client can't grow the server's send buffer without bound.
const WS_BACKPRESSURE_HIGH = Number(process.env.WS_BACKPRESSURE_HIGH_BYTES) || 8 * 1024 * 1024;
const WS_BACKPRESSURE_LOW = Number(process.env.WS_BACKPRESSURE_LOW_BYTES) || 1 * 1024 * 1024;

/**
 * Create a new empty session without requiring a user message
 * This is called when user explicitly clicks "New Session" button
 *
 * Canvas Agent (D5): pass canvasId to bind this session to a canvas workspace instead
 * of (mutually exclusive with) a projectId — cwd resolves to the SHARED canvas
 * workspace directory so every session in that workspace sees the same files.
 */
async function handleCreateSession(ws, projectId, canvasId) {
  console.log(
    '[WS Server] Creating new empty session',
    projectId ? `(project ${projectId})` : canvasId ? `(canvas ${canvasId})` : ''
  );

  try {
    // Generate new workspace session ID
    const workspaceSessionId = generateSessionId();

    // Get user-specific CLAUDE_HOME
    const claudeHome = getClaudeHome(ws.userId);
    await ensureDirExists(claudeHome);

    // Sync user's skills based on global settings (conversation init)
    try {
      await syncUserSkills(claudeHome);
    } catch (syncError) {
      console.warn('[WS Server] Skills sync failed (continuing):', syncError.message);
    }

    // Get session workspace — canvas workspaces are SHARED across sessions, per-session
    // workspaces are not.
    const workspacePath = canvasId
      ? getCanvasWorkspace(ws.userId, canvasId)
      : getSessionWorkspace(ws.userId, workspaceSessionId);
    await ensureDirExists(workspacePath);

    // Create .claude symlink in workspace
    await ensureClaudeSymlink(workspacePath, claudeHome);

    // Verify skills are accessible
    await verifySkillsAccess(workspacePath, claudeHome);

    console.log(`[WS Server] Created empty session ${workspaceSessionId} for user ${ws.userId}`);
    console.log(`[WS Server]   CLAUDE_HOME: ${claudeHome}`);
    console.log(`[WS Server]   Workspace: ${workspacePath}`);

    // Store session ID for future chat messages
    ws.workspaceSessionId = workspaceSessionId;

    // Persist empty session to DB immediately so it appears in history list.
    // Title will be updated when first message is sent. When arming "new chat in
    // <project>"/"new chat in <canvas>", bind it at creation (race-free). If that bind
    // fails (e.g. caller isn't the owner → POST 403 → null), fall back to a loose
    // session so session creation never breaks on a stale/invalid arm.
    const lineage = projectId ? { projectId } : canvasId ? { canvasId } : null;
    const persisted = await persistSession(
      ws.cookie, workspaceSessionId, null, claudeHome, '未命名',
      lineage,
    );
    if (!persisted && lineage) {
      console.warn('[WS Server] Bound session persist failed; retrying as loose session');
      await persistSession(ws.cookie, workspaceSessionId, null, claudeHome, '未命名');
    }

    // Send session_init immediately (session is ready but empty)
    sendMessage(ws, {
      type: 'session_init',
      sessionId: workspaceSessionId,
      sdkSessionId: null,  // Will be set when first message is sent
      userId: ws.userId,
    });
  } catch (error) {
    console.error('[WS Server] Error creating session:', error);
    sendMessage(ws, {
      type: 'error',
      code: 'server_error',
      message: error instanceof Error ? error.message : String(error),
      retriable: true,
    });
  }
}

async function resolvePreviewWorkspace(ws, sessionId) {
  if (!sessionId) {
    throw new Error('Missing sessionId for preview');
  }

  if (ws.cookie) {
    const sessionData = await loadSessionFromDb(ws.cookie, sessionId);
    if (sessionData) {
      return getSessionWorkspace(ws.userId, sessionId);
    }
  }

  // Newly-created empty sessions are persisted immediately, but keep a narrow
  // fallback for the current socket while the DB/API write is settling.
  if (ws.workspaceSessionId === sessionId) {
    return getSessionWorkspace(ws.userId, sessionId);
  }

  throw new Error('Session not found or not accessible');
}

async function handleStartPreview(ws, message) {
  const sessionId = message.sessionId || ws.workspaceSessionId;
  const mode = message.mode === 'live' ? 'live' : 'static';
  if (mode !== 'static') {
    sendPreviewState(ws, {
      sessionId,
      previewId: 'pending',
      mode,
      status: 'error',
      error: 'Live preview is best-effort and not enabled in v1. Use static preview.',
    });
    return;
  }

  try {
    const workspacePath = await resolvePreviewWorkspace(ws, sessionId);
    await previewRuntime.startStaticPreview({
      userId: ws.userId,
      sessionId,
      workspacePath,
      force: message.force === true,
      sendState: (state) => sendPreviewState(ws, state),
    });
  } catch (error) {
    sendPreviewState(ws, {
      sessionId,
      previewId: 'pending',
      mode,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleSharePreview(ws, message) {
  try {
    const previewId = message.previewId;
    if (!previewId) {
      sendMessage(ws, {
        type: 'error',
        code: 'invalid_message',
        message: 'Missing previewId for share_preview',
        retriable: false,
      });
      return;
    }
    const state = previewRuntime.sharePreview(previewId);
    if (!state) {
      sendMessage(ws, {
        type: 'error',
        code: 'preview_share_failed',
        message: 'Preview is not running. Start the preview before sharing.',
        retriable: true,
      });
      return;
    }
    sendPreviewState(ws, state);
  } catch (error) {
    sendMessage(ws, {
      type: 'error',
      code: 'preview_share_failed',
      message: error instanceof Error ? error.message : String(error),
      retriable: true,
    });
  }
}

async function handleStopPreview(ws, message) {
  try {
    const previewId = message.previewId;
    if (!previewId) {
      sendMessage(ws, {
        type: 'error',
        code: 'invalid_message',
        message: 'Missing previewId for stop_preview',
        retriable: false,
      });
      return;
    }
    const state = await previewRuntime.stopPreview(previewId);
    if (state) sendPreviewState(ws, state);
  } catch (error) {
    sendMessage(ws, {
      type: 'error',
      code: 'preview_stop_failed',
      message: error instanceof Error ? error.message : String(error),
      retriable: true,
    });
  }
}

/**
 * Handle chat message using child process for user and session isolation
 * Note: Thinking/reasoning is handled by SDK's claude_code preset automatically
 */
// ── Multi-model: resolve the selected model's connection metadata (token-free)
// from the web app, with a short-TTL cache so it stays off the per-message hot path
// (arch finding A4). Secrets never cross the wire — the endpoint returns only the
// tokenEnv NAME; the token value stays here in process.env. Contract:
// src/server/models/resolve-contract.ts.
const MODEL_RESOLVE_TTL_MS = Number(process.env.MODEL_RESOLVE_TTL_MS) || 60_000;
const modelResolveCache = new Map(); // modelId → { meta: object|null, expiresAt: number }

async function resolveModelForChat(cookie, modelId) {
  if (!modelId) return null;
  const cached = modelResolveCache.get(modelId);
  if (cached && cached.expiresAt > Date.now()) return cached.meta;
  try {
    const response = await fetch(`${APP_URL}/api/models/resolve/${encodeURIComponent(modelId)}`, {
      headers: { cookie: cookie || '' },
    });
    if (response.status === 404) {
      modelResolveCache.set(modelId, { meta: null, expiresAt: Date.now() + MODEL_RESOLVE_TTL_MS });
      return null;
    }
    if (!response.ok) {
      console.error(`[WS Server] model resolve failed (${response.status}) for ${modelId}`);
      return undefined; // transient — distinguish from a definitive 404 (null)
    }
    const meta = await response.json();
    modelResolveCache.set(modelId, { meta, expiresAt: Date.now() + MODEL_RESOLVE_TTL_MS });
    return meta;
  } catch (error) {
    console.error('[WS Server] model resolve error:', error);
    return undefined; // transient
  }
}

// Canvas Agent (D6): global default model for a media-gen capability (image/video),
// same cache/shape as resolveModelForChat but keyed by capability, not modelId — no
// per-project override (canvas has no projectId, D5). Non-fatal by design: a miss
// just means buildMediaGenEnv leaves the worker env untouched, so gemini-image-runner.js
// falls back to its own raw-env read (unlike chat, an unresolvable media-gen model
// must not abort session creation).
const mediaGenResolveCache = new Map(); // capability → { meta: object|null, expiresAt: number }

async function resolveMediaGenCredential(cookie, capability) {
  const cached = mediaGenResolveCache.get(capability);
  if (cached && cached.expiresAt > Date.now()) return cached.meta;
  try {
    const response = await fetch(`${APP_URL}/api/models/resolve-default/${encodeURIComponent(capability)}`, {
      headers: { cookie: cookie || '' },
    });
    if (!response.ok) {
      // 404 (no default configured) and any other failure both mean "nothing to
      // inject" — cache briefly either way so a missing config doesn't cost a fetch
      // on every canvas generate_image call.
      mediaGenResolveCache.set(capability, { meta: null, expiresAt: Date.now() + MODEL_RESOLVE_TTL_MS });
      return null;
    }
    const meta = await response.json();
    mediaGenResolveCache.set(capability, { meta, expiresAt: Date.now() + MODEL_RESOLVE_TTL_MS });
    return meta;
  } catch (error) {
    console.error('[WS Server] media-gen resolve error (non-fatal):', error);
    return null;
  }
}

// ── Registry v2: global variables for the worker env ─────────────────────────
// Fetched sealed from the app (/api/models/worker-vars), opened here with
// KIN_SECRET_KEY, short-TTL cached like the model-resolve path. Reserved prefixes
// are re-checked here (the admin write path already blocks them) so a variable can
// never shadow model routing or platform config even if the DB is edited directly.
const WORKER_VARS_TTL_MS = Number(process.env.WORKER_VARS_TTL_MS) || 60_000;
let workerVarsCache = null; // { vars: Array<{key, valueEncrypted}>, expiresAt: number }

const GLOBAL_VAR_BLOCKED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'KIN_', 'OXY_', 'DATABASE_', 'POSTGRES_', 'REDIS_', 'BETTER_AUTH', 'NODE_', 'WS_', 'APP_', 'EXEC_', 'BASH_RUNNER_'];
const GLOBAL_VAR_BLOCKED_EXACT = ['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'PORT'];

async function applyGlobalVars(cookie, workerEnv) {
  try {
    let cached = workerVarsCache;
    if (!cached || cached.expiresAt <= Date.now()) {
      const response = await fetch(`${APP_URL}/api/models/worker-vars`, {
        headers: { cookie: cookie || '' },
      });
      if (!response.ok) {
        console.error(`[WS Server] worker-vars fetch failed (${response.status}) — skipping global vars`);
        return;
      }
      const body = await response.json();
      cached = { vars: Array.isArray(body?.vars) ? body.vars : [], expiresAt: Date.now() + WORKER_VARS_TTL_MS };
      workerVarsCache = cached;
    }
    for (const { key, valueEncrypted } of cached.vars) {
      if (typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
      if (GLOBAL_VAR_BLOCKED_EXACT.includes(key) || GLOBAL_VAR_BLOCKED_PREFIXES.some((p) => key.startsWith(p))) {
        console.error(`[WS Server] global var "${key}" hits the reserved blocklist — ignored`);
        continue;
      }
      try {
        workerEnv[key] = openSecret(valueEncrypted);
      } catch (e) {
        console.error(`[WS Server] global var "${key}" cannot be opened (${e instanceof Error ? e.message : e}) — ignored`);
      }
    }
  } catch (error) {
    console.error('[WS Server] applyGlobalVars error (non-fatal):', error);
  }
}

async function handleChat(ws, prompt, resumeSessionId, options = {}) {
  const {
    silentInit = false,
    skillSlug = null,
    permissionTier = null,
    model: selectedModel = null,
    // Session KB scope (面板勾选): forwarded to the worker so kb_search restricts to it.
    kbIds = [],
    // Canvas Agent (D5): client-supplied fallback; existingSession.canvasId (DB, set by
    // handleCreateSession's persist) is the authoritative source once a session row exists.
    canvasId: canvasIdOption = null,
  } = options;
  // Concurrent sessions (PRD 2026-06-15, FR1): we NO LONGER kill a running worker
  // when a new chat starts. Other sessions keep running in the background and
  // write their results to the transcript. The only worker we may replace is one
  // for the SAME output session (a sequential re-run of one conversation) —
  // handled defensively right before spawn, once outputSessionId is known.

  console.log('[WS Server] handleChat called with prompt length:', prompt.length);
  console.log('[WS Server] resumeSessionId:', resumeSessionId || 'none');

  // S1 — permit-leak net. Armed once the concurrency permits are acquired and the
  // worker is registered, disarmed once the worker's close/error handlers take over
  // releasing them. If anything throws in between, the outer catch fires this to
  // free BOTH permits + kill/unregister the orphan (it closes over worker +
  // outputSessionId, which live inside the try).
  let releasePermitsOnError = null;

  try {
    // Get or generate workspace session ID
    const workspaceSessionId = resumeSessionId || generateSessionId();

    // Look up SDK session ID for resume (if this is a continuation)
    const sdkResumeId = resumeSessionId ? sessionMapping.get(resumeSessionId) : null;

    // Check if this is a resume of an existing session
    // For sessions created via create_session, we need to update title on first message
    let existingSession = null;
    if (resumeSessionId && ws.cookie) {
      existingSession = await loadSessionFromDb(ws.cookie, resumeSessionId);
    }

    // === Branch (续聊即分支, Projects P3) ===
    // A member replying to a session they DON'T own must not append to the owner's
    // transcript. Instead we FORK it (SDK forkSession) into a new session D2 owned by the
    // replier, in the same Project; the source D1 is untouched. Viewing a shared session
    // goes through the `resume` case (never handleChat), so this only fires on a real chat
    // turn. silentInit (init_session) is exempt — it loads, it doesn't add a user turn.
    const isBranch =
      !silentInit && existingSession && existingSession.userId && existingSession.userId !== ws.userId;
    // Cross-user isolation: a real chat turn on a session you don't own is redirected
    // to a fork with a FRESH id (isBranch), so it never touches the owner's session.
    // But init_session (silentInit) is NOT forked — it would operate on the requested
    // id directly. Legit viewing of someone else's (shared) session goes through
    // `resume`, never here, so a silent init on a non-owned session is illegitimate:
    // refuse it. Without this, a crafted init_session(victimId) would, via the
    // stale-replace + register below, SIGKILL/hijack the victim's running worker.
    if (silentInit && existingSession && existingSession.userId && existingSession.userId !== ws.userId) {
      console.warn(`[WS Server] Rejecting silent init on non-owned session ${resumeSessionId} (owner ${existingSession.userId})`);
      return;
    }
    // The OUTPUT session: a fresh id (D2) for a branch, else the resumed/new session itself.
    const outputSessionId = isBranch ? generateSessionId() : workspaceSessionId;
    // What the SDK resumes: for a branch, the SOURCE's real SDK session id (its transcript),
    // which the worker then forks (forkSession:true) → a NEW forked id comes back on the init
    // event and is persisted to D2. For a normal turn, the usual resume id.
    const effectiveResumeSdkId = isBranch
      ? existingSession.realSdkSessionId || sessionMapping.get(resumeSessionId) || sdkResumeId
      : sdkResumeId;
    if (isBranch) {
      console.log(
        `[WS Server] Branch: user ${ws.userId} forks session ${resumeSessionId} (owner ${existingSession.userId}) → new ${outputSessionId}`
      );
    }

    // P2 (Codex): a branch MUST have a resumable source SDK id, else the worker would skip
    // forkSession and silently create a fresh EMPTY session — losing D1's context entirely.
    // Fail clearly instead. (A source only has a real SDK id after its first message.)
    if (isBranch && !effectiveResumeSdkId) {
      console.error(`[WS Server] Branch aborted: source session ${resumeSessionId} has no resumable SDK id`);
      sendMessage(ws, {
        type: 'error',
        code: 'branch_source_not_ready',
        message: '源会话尚无可分支的内容，无法创建分支。',
        retriable: false,
      });
      return;
    }

    // Determine title: only set for first message of sessions without a meaningful title
    // - New sessions (no resumeSessionId): use prompt
    // - Resumed sessions with default/placeholder title: use prompt
    // - Resumed sessions with existing title: don't override
    const defaultTitles = ['未命名', '新会话', 'New Session', 'Untitled'];
    const hasPlaceholderTitle = existingSession && (
      !existingSession.title ||
      defaultTitles.includes(existingSession.title)
    );
    const cleanedPromptForTitle = stripSkillMarker(prompt);
    // A branch's title is "分支·<source title>" (one prefix, even branch-of-branch).
    const branchTitle = isBranch ? `分支·${(existingSession.title || '对话').replace(/^分支·/, '')}` : null;
    const sessionTitle = silentInit
      ? null
      : isBranch
        ? branchTitle
        : ((!resumeSessionId || hasPlaceholderTitle) ? cleanedPromptForTitle.slice(0, 50).trim() : null);

    if (hasPlaceholderTitle) {
      console.log(`[WS Server] Updating placeholder title to: "${sessionTitle}"`);
    }

    // Get user-specific CLAUDE_HOME (for SDK session storage)
    // Use existing session's claudeHome if available, otherwise generate new
    const claudeHome = existingSession?.claudeHomePath || getClaudeHome(ws.userId);
    await ensureDirExists(claudeHome);

    // Sync user's skills based on global settings (conversation init)
    // This ensures newly added global skills are available for this session
    try {
      await syncUserSkills(claudeHome);
    } catch (syncError) {
      console.warn('[WS Server] Skills sync failed (continuing):', syncError.message);
    }

    // Resolve the workspace this run operates in.
    //
    // Canvas Agent (D5) takes priority over the branch logic below: a canvas workspace
    // is single-owner (no member table, never shared/branched), so ALL its sessions
    // resolve to the SAME shared directory regardless of which session triggered this
    // turn. existingSession.canvasId (DB, set at create time) is authoritative;
    // canvasIdOption is a fallback for the rare case a session row doesn't exist yet
    // (shouldn't normally happen — handleCreateSession persists first).
    const effectiveCanvasId = existingSession?.canvasId || canvasIdOption || null;

    // Branches SHARE their source's workspace so the forked transcript's (absolute) file
    // paths still resolve (a copy would break them; same-uid storage makes the
    // cross-user read/write safe). Three cases (skipped entirely for canvas sessions):
    //   - creating a branch (isBranch): source = existingSession (D1)
    //   - continuing a branch (existingSession.branchedFromSessionId): load the source D1
    //   - normal: the requester's own session workspace
    let wsOwnerId = ws.userId;
    let wsSessionId = workspaceSessionId;
    if (!effectiveCanvasId && isBranch) {
      wsOwnerId = existingSession.userId;
      wsSessionId = existingSession.sdkSessionId;
    } else if (!effectiveCanvasId && existingSession?.branchedFromSessionId && ws.cookie) {
      const branchSource = await loadSessionById(ws.cookie, existingSession.branchedFromSessionId);
      if (branchSource) {
        wsOwnerId = branchSource.userId;
        wsSessionId = branchSource.sdkSessionId;
      }
    }
    const workspacePath = effectiveCanvasId
      ? getCanvasWorkspace(ws.userId, effectiveCanvasId)
      : getSessionWorkspace(wsOwnerId, wsSessionId);
    await ensureDirExists(workspacePath);

    // Create .claude symlink in workspace pointing to user's .claude directory
    // This allows SDK to find skills/settings while working in session workspace
    await ensureClaudeSymlink(workspacePath, claudeHome);

    // Verify skills are accessible through the symlink
    await verifySkillsAccess(workspacePath, claudeHome);

    // Branch: pre-create D2 with lineage (Project + branched-from + 分支· title) BEFORE the
    // worker runs, so the row exists with the replier's ownership; the init-event capture
    // below fills in its realSdkSessionId (the forked id the SDK returns).
    // P1 (Codex): the create must SUCCEED before forking — else the init capture would create
    // a lineage-less orphan D2 (loose / missing from the project). Abort the run on failure.
    if (isBranch) {
      const created = await persistSession(ws.cookie, outputSessionId, null, claudeHome, branchTitle, {
        projectId: existingSession.projectId,
        branchedFromSessionId: existingSession.id,
      });
      if (!created) {
        console.error(`[WS Server] Branch aborted: failed to pre-create D2 ${outputSessionId} with lineage`);
        sendMessage(ws, {
          type: 'error',
          code: 'branch_create_failed',
          message: '分支创建失败，请重试。',
          retriable: true,
        });
        return;
      }
    }

    console.log(`[WS Server] User ${ws.userId} Session ${workspaceSessionId}`);
    console.log(`[WS Server]   CLAUDE_HOME: ${claudeHome}`);
    console.log(`[WS Server]   Workspace: ${workspacePath}`);
    if (sdkResumeId) {
      console.log(`[WS Server]   SDK Resume ID: ${sdkResumeId}`);
    }

    // Build environment for worker process
    let workerEnv = { ...process.env };
    // Set both CLAUDE_HOME and HOME - SDK might use either
    workerEnv.CLAUDE_HOME = claudeHome;
    workerEnv.HOME = claudeHome;  // Override HOME so os.homedir() returns user dir
    workerEnv.WORKER_CWD = workspacePath;  // Per-Session workspace
    // Canvas Agent (D5): tells the worker to register mcp__media-gen__* (canvas
    // sessions only — regular chat sessions never see this tool).
    if (effectiveCanvasId) {
      workerEnv.CANVAS_ID = effectiveCanvasId;
      // D6: route media-gen to the admin-configured 'image'/'video' capability
      // defaults (model-registry-v2, /admin/models) instead of raw env vars. Each
      // capability resolves and injects independently — they can land on different
      // connections/providers, never assumed to be the same one (Veo/Gemini is the
      // first video provider, not necessarily the last). Non-fatal: no default
      // configured yet → workerEnv untouched → the runner falls back to its own
      // process.env read (today's behavior, preserved for zero-admin-action deploys).
      const imageMeta = await resolveMediaGenCredential(ws.cookie, 'image');
      workerEnv = buildMediaGenEnv(imageMeta, workerEnv, 'image');
      const videoMeta = await resolveMediaGenCredential(ws.cookie, 'video');
      workerEnv = buildMediaGenEnv(videoMeta, workerEnv, 'video');
    }

    // Registry v2: admin-managed global variables (sealed over the internal API,
    // opened here just-in-time). Applied BEFORE model routing so ANTHROPIC_* routing
    // below always wins; the write path additionally blocks reserved prefixes, and
    // applyGlobalVars re-checks as defense-in-depth. Failure is non-fatal (vars are
    // a convenience — a chat must not die because the app endpoint hiccuped).
    await applyGlobalVars(ws.cookie, workerEnv);
    if (config.apiKey) workerEnv.ANTHROPIC_API_KEY = config.apiKey;
    if (config.baseURL) {
      workerEnv.ANTHROPIC_BASE_URL = config.baseURL;
      workerEnv.ANTHROPIC_API_URL = config.baseURL;
    }
    if (config.model) workerEnv.ANTHROPIC_MODEL = config.model;
    workerEnv.ENABLE_TOOL_SEARCH = 'auto:10';  // Enable Tool Search when many MCP tools available

    // Multi-model: if the client selected a model, route THIS run to its connection.
    // Per owner decision #2, reject (don't silently fall back) on an unknown/disabled/
    // unhealthy/unresolvable selection. No selection → keep the deployment default above.
    if (selectedModel) {
      const meta = await resolveModelForChat(ws.cookie, selectedModel);
      if (meta === undefined) {
        sendMessage(ws, { type: 'error', code: 'model_resolve_failed', message: 'Could not resolve the selected model right now. Please retry.', retriable: true });
        return;
      }
      if (meta === null) {
        sendMessage(ws, { type: 'error', code: 'model_not_found', message: `Selected model "${selectedModel}" no longer exists. Pick another model.`, retriable: false });
        return;
      }
      if (!meta.enabled || meta.health !== 'healthy') {
        const why = !meta.enabled ? 'disabled' : meta.health;
        sendMessage(ws, { type: 'error', code: 'model_unavailable', message: `Selected model "${meta.id}" is currently ${why}. Pick another model.`, retriable: false });
        return;
      }
      try {
        // buildWorkerEnv returns a fresh env (copies workerEnv, sets ANTHROPIC_* and
        // DELETES the unused auth var) — reassign so the deletion takes effect.
        workerEnv = buildWorkerEnv(meta, workerEnv);
        console.log(`[WS Server] Routed run to model ${meta.id} (connection ${meta.connectionId})`);
      } catch (error) {
        sendMessage(ws, { type: 'error', code: 'model_config_error', message: error instanceof Error ? error.message : String(error), retriable: false });
        return;
      }
    }

    // Fetch permission info from API (includes organization settings)
    const permissionInfo = await fetchPermissionInfo(ws.cookie);

    // Use fetched permission info or fall back to environment variables
    let permissionMode, allowBash, organizationId, role, egressAllowedDomains;
    if (permissionInfo && permissionInfo.userId === ws.userId) {
      permissionMode = permissionInfo.permissionMode;
      allowBash = permissionInfo.allowBash;
      organizationId = permissionInfo.organizationId;
      role = permissionInfo.role;
      // Runtime egress posture from the admin-set capability config (DB → env → default).
      egressAllowedDomains = permissionInfo.egressAllowedDomains;
      console.log(`[WS Server] Using organization-based permissions: org=${organizationId}, role=${role}, mode=${permissionMode}, bash=${allowBash}, egress=${JSON.stringify(egressAllowedDomains)}`);
    } else {
      // Fallback to environment variables
      permissionMode = resolvePermissionMode(ws.userId);
      allowBash = permissionMode === 'bypassPermissions' && ALLOW_BASH_IN_BYPASS;
      organizationId = null;
      role = null;
      console.log(`[WS Server] Using environment-based permissions: mode=${permissionMode}, bash=${allowBash}`);
    }

    // Apply the client-requested interaction mode (Ask/Act). Security lives in the
    // sandbox — modes are an interruption preference. Falls back to DEFAULT_MODE
    // ('act') when absent/unrecognised. Single source: src/lib/permission-tier.js.
    // (`permissionTier` is the wire field name; it now carries 'ask' | 'act'.)
    const effective = resolveEffectivePermission({ requestedMode: permissionTier });
    permissionMode = effective.permissionMode; // ask → 'default' (HITL via canUseTool); act → 'acceptEdits'
    if (permissionTier) {
      console.log(`[WS Server] Interaction mode: ${effective.mode} → permissionMode=${permissionMode}`);
    }

    const disallowedTools = resolveDisallowedTools(permissionMode, allowBash);
    workerEnv.CLAUDE_PERMISSION_MODE = permissionMode;

    // Materialize the admin-set egress posture into the worker env so the sandbox
    // honors it. '' curated · 'off' deny-all · 'all' unfiltered · csv → exact list.
    // Only when permission-info supplied it (else inherit the container default).
    if (typeof egressAllowedDomains === 'string') {
      workerEnv.EXEC_SANDBOX_ALLOWED_DOMAINS = egressAllowedDomains;
    }

    // P2-2: audit runs that start with elevated (bypass) permissions — these
    // skip per-tool permission prompts, so they are security-relevant.
    if (permissionMode === 'bypassPermissions') {
      recordAuditEvent(ws.cookie, 'run.bypass_mode', outputSessionId, {
        allowBash,
        source: organizationId ? 'organization' : 'environment',
      });
    }

    // Track which session THIS connection is currently driving, so an abort /
    // approval_response that arrives WITHOUT an explicit sessionId (a pre-P2
    // client) still targets the right run. (A P2 client sends the sessionId.)
    ws.activeRunSessionId = outputSessionId;

    // Defensive same-session replace: if a worker is STILL alive for this exact
    // output session (a sequential re-run that raced its predecessor's close — the
    // UI normally blocks this by disabling the composer while a turn runs), retire
    // the stale one. This is the ONLY kill left, and it never touches a DIFFERENT
    // session. Done BEFORE acquiring permits so the stale worker's close frees its
    // permit (no self-deadlock if the user is exactly at their cap). __replaced makes
    // its close handler silent (no spurious 'aborted', no unregister of the new run).
    // Ownership guard (defense-in-depth): only retire a stale worker that is OURS.
    // outputSessionId is already own-or-fresh by construction (non-owned turns fork;
    // non-owned silent inits were rejected above), so this should always hold — but
    // never SIGKILL another user's worker even if that ever regresses.
    const staleWorker = sessionRegistry.getWorker(outputSessionId);
    if (staleWorker && sessionRegistry.ownerOf(outputSessionId) === ws.userId) {
      console.log(`[WS Server] Replacing stale same-session worker for ${outputSessionId}`);
      staleWorker.__replaced = true;
      staleWorker.__intentionalAbort = true;
      staleWorker.__terminalSent = true;
      try { staleWorker.kill(); } catch { /* ignore */ }
    }

    // FR3 — per-user concurrency cap, acquired BEFORE the global permit (always
    // user-then-global, so no circular wait). A user already at their cap queues
    // (FIFO) behind their own running sessions. Silent init runs are exempt (quick
    // metadata loads — blocking them behind 3 chats would make opening a session
    // hang). Released exactly once in worker 'close'/'error'.
    const userSem = silentInit ? null : getUserSemaphore(ws.userId);
    let userPermitReleased = false;
    const releaseUserPermit = () => {
      if (userSem && !userPermitReleased) {
        userPermitReleased = true;
        userSem.release();
        // S2 — evict an idle per-user semaphore so the map can't grow unboundedly
        // (one entry per distinct user, forever). Safe: a later request just creates
        // a fresh one (count 0 = correct, the user has nothing running). Guard on
        // identity so we never drop a semaphore another in-flight run is using.
        if (
          userSem.activeCount === 0 &&
          userSem.waitingCount === 0 &&
          userSemaphores.get(ws.userId) === userSem
        ) {
          userSemaphores.delete(ws.userId);
        }
      }
    };
    if (userSem) {
      if (userSem.activeCount >= userSem.max) {
        sendMessage(ws, {
          type: 'queued',
          position: userSem.waitingCount + 1,
          message: '你已有多个会话在运行，这个会话会在前面的完成后开始。',
          sessionId: outputSessionId,
        });
      }
      await userSem.acquire();
    }
    // S1 (inter-acquire NIT): the per-user permit is now held but the GLOBAL one
    // isn't yet, and the full leak net (which also frees the global permit + worker)
    // isn't armed until after spawn. Arm a partial net NOW so a throw between the two
    // acquires still frees the user permit. The full net overwrites this below; both
    // releases are idempotent, so the handoff can't double-release.
    releasePermitsOnError = releaseUserPermit;

    // S1 — acquire a GLOBAL worker permit before spawning. If all HOST slots are
    // busy, this awaits a free one (FIFO) instead of spawning unboundedly; tell the
    // client it's queued so the UI can show a waiting state. The window between
    // acquire() and spawn() below is synchronous (no await), so a held permit always
    // maps to a spawned worker; the permit is released exactly once in worker 'close'.
    if (workerSemaphore.activeCount >= workerSemaphore.max && !silentInit) {
      sendMessage(ws, {
        type: 'queued',
        position: workerSemaphore.waitingCount + 1,
        message: 'Server busy — your request is queued and will start shortly.',
        sessionId: outputSessionId,
      });
    }
    await workerSemaphore.acquire();

    // S1 — both permits are now held. Define their releases (flag-based) and ARM the
    // leak net BEFORE spawn, so a throw ANYWHERE in setup frees both permits and
    // cleans up. `worker` is a `let` assigned at spawn, so the net stays valid even
    // if a throw beats the spawn (it no-ops the worker cleanup while worker is null).
    // Disarmed once the worker's close/error handlers take over release.
    let worker = null;
    let workerPermitReleased = false;
    const releaseWorkerPermit = () => {
      if (!workerPermitReleased) {
        workerPermitReleased = true;
        workerSemaphore.release();
      }
    };
    releasePermitsOnError = () => {
      releaseWorkerPermit();
      releaseUserPermit();
      if (worker) {
        try { worker.kill(); } catch { /* already dead */ }
        sessionRegistry.unregister(outputSessionId);
      }
    };

    // Spawn worker process with user-specific CLAUDE_HOME.
    // S2 — cap this worker's V8 heap so a runaway one can't OOM the host.
    const nodeArgs = WORKER_MAX_OLD_SPACE_MB
      ? [`--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`, WORKER_PATH]
      : [WORKER_PATH];
    // Registry v2 defense-in-depth: the worker gets resolved plaintext ANTHROPIC_*
    // routing but never the master key — sealed DB credentials must stay openable
    // only by the app/ws-server processes. (Sandboxed bash already builds a minimal
    // env of its own, this guards the worker process itself.)
    delete workerEnv.KIN_SECRET_KEY;
    worker = spawn('node', nodeArgs, {
      env: workerEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Concurrent sessions: register the worker in the connection-INDEPENDENT
    // registry (keyed by the OUTPUT session) and subscribe THIS connection so it
    // receives the stream. This replaces the single `ws.workerProcess` slot — the
    // "one worker per connection" assumption we're removing. silentInit runs are
    // registered too (so abort/routing work uniformly) but flagged silent: excluded
    // from the per-user cap (FR3) and the running-sessions list (FR4).
    sessionRegistry.register({ sessionId: outputSessionId, userId: ws.userId, worker, silent: silentInit });
    sessionRegistry.subscribe(outputSessionId, ws, ws.userId);
    // Risk #10: track whether this run already delivered a terminal frame
    // (done/error/aborted). If the worker dies without one (e.g. a crash), the
    // close handler emits a terminal error so the client never hangs "running".
    worker.__terminalSent = false;
    worker.__intentionalAbort = false;

    // Send query request to worker
    // Pass sdkResumeId for SDK conversation resume
    const request = JSON.stringify({
      prompt,
      skillSlug,
      // For a branch: the SOURCE sdk id (the worker forks it first), the branch flag, and the
      // title to stamp on the fork. For a normal turn: just the resume id.
      sdkResumeId: effectiveResumeSdkId,
      forkSession: isBranch,
      branchTitle: isBranch ? branchTitle : null,
      permissionMode,
      disallowedTools,
      allowBash,  // Pass allowBash flag so worker can trust org-based bypass mode
      userId: ws.userId,
      // RAG R2 (final spec D6): the kb_search MCP tool calls back into the app
      // (/api/rag/search) with the user's own auth — via STDIN on purpose, never the
      // worker env, so agent-spawned Bash children can't read the cookie.
      cookie: ws.cookie,
      // Session KB scope (面板勾选, prd 阶段3): kb_search restricts to these KBs.
      kbIds,
      // Workspace session this turn writes to (= the client's currentSessionId after session_init;
      // for a branch it's the fork target D2). The worker stamps it onto each kb_search trace so
      // the right-side Retrieval tab can show "what THIS conversation searched".
      sessionId: outputSessionId ?? null,
    });
    // Newline-delimited + keep stdin OPEN so Ask-mode HITL can stream
    // approval_response lines to the worker mid-run. The worker exits on its own
    // (process.exit) when the run ends, closing the pipe.
    worker.stdin.write(request + '\n');

    // Track our OUTPUT session id for mapping/persistence/session_init. For a branch this is
    // D2 (the fork target), not the resumed source — so the init-event capture below maps +
    // persists the forked SDK id onto D2 and tells the client to switch to D2.
    ws.workspaceSessionId = outputSessionId;

    // Canvas Agent (D5): toolUseId -> generation_task id for THIS run, so the
    // media_gen_task_result frame (which only carries toolUseId) can find the task row
    // media_gen_task_started created. Scoped to this handleChat call's closure.
    const mediaGenTaskIds = new Map();

    // Read responses line by line
    const rl = createInterface({ input: worker.stdout });

    // C4 backpressure (consumer side): when the WS send buffer grows past HIGH,
    // pause reading the worker's stdout; resume once it drains below LOW (or the
    // socket closes). Pausing fills the OS pipe, which (via the worker's drain-await)
    // throttles the producer — so a fast stream + slow client can't grow memory.
    let bpTimer = null;
    const applyBackpressure = (buffered) => {
      if (bpTimer || buffered <= WS_BACKPRESSURE_HIGH) return;
      try { worker.stdout.pause(); } catch { /* ignore */ }
      bpTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount <= WS_BACKPRESSURE_LOW) {
          clearInterval(bpTimer);
          bpTimer = null;
          try { worker.stdout.resume(); } catch { /* ignore */ }
        }
      }, 50);
    };
    const clearBackpressure = () => {
      if (bpTimer) { clearInterval(bpTimer); bpTimer = null; }
    };

    // Handle readline errors (e.g., when worker is killed abruptly)
    rl.on('error', (error) => {
      console.log('[WS Server] Readline error (expected on abort):', error.message);
    });

    rl.on('close', () => {
      clearBackpressure();
      // Readline closed, worker output ended
    });

    rl.on('line', (line) => {
      try {
        // S4 — drop output from a worker that's no longer the live one for this
        // session: if a same-session replace happened (__replaced) or kill silently
        // failed and a new worker took the slot, a still-alive old worker's frames
        // would otherwise interleave with the new run's output (same outputSessionId
        // → same subscribers). The new worker's own frames pass (it IS current).
        if (worker.__replaced || sessionRegistry.getWorker(outputSessionId) !== worker) {
          return;
        }
        const msg = JSON.parse(line);

        if (msg.type === 'event') {
          const event = msg.event;
          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            // Branch safety (R1) — now a VESTIGIAL fallback. The real guarantee is in the
            // worker: it forks the source (forkSession) and resumes the FORK, so it never
            // resumes the source and `event.session_id` here is always the forked id (≠ source).
            // This check therefore can't normally fire; kept as a defensive backstop (kill +
            // error) in case the worker path ever regresses. (Earlier streaming approach wrote
            // the user turn before init, so kill-at-init was too late — that's why we moved the
            // fork into the worker; see ws-query-worker.mjs branch block.)
            if (isBranch && event.session_id === effectiveResumeSdkId) {
              console.error(
                `[WS Server] Branch fork returned the SOURCE id (${event.session_id}) — killing worker to avoid appending to D1`
              );
              worker.__intentionalAbort = true;
              worker.__terminalSent = true;
              try { worker.kill(); } catch { /* ignore */ }
              sendMessage(ws, { type: 'error', code: 'branch_fork_failed', message: '分支创建失败，请重试。', retriable: true });
              return;
            }
            // 发现 A / concurrent sessions: key everything off the LOCAL
            // outputSessionId, NOT ws.workspaceSessionId. The connection-level field
            // is shared mutable state that an interleaved run would clobber, which
            // would persist/map/index THIS run's events under the WRONG session.
            // Store mapping: outputSessionId -> real SDK session_id (for resume).
            sessionMapping.set(outputSessionId, event.session_id);
            console.log(`[WS Server] Session mapping: ${outputSessionId} -> ${event.session_id}`);

            // Persist session to database (use outputSessionId as the identifier)
            // Pass sessionTitle only for new sessions (extracted from first user message)
            persistSession(ws.cookie, outputSessionId, event.session_id, claudeHome, sessionTitle);

            if (silentInit) {
              fanoutToSession(outputSessionId, {
                type: 'session_metadata',
                sessionId: outputSessionId,
                metadata: {
                  session_id: event.session_id || outputSessionId,
                  user_id: ws.userId || '',
                  model: event.model || 'unknown',
                  skills: event.skills || [],
                  mcp_servers: event.mcp_servers || [],
                  agents: event.agents || [],
                  tools: event.tools || [],
                  slash_commands: event.slash_commands || [],
                  cwd: event.cwd || '',
                },
              });
            } else {
              // Tell the client our workspace sessionId (it adopts this as
              // currentSessionId and the routing key). `sdkSessionId` carries the
              // REAL SDK id (used for resume) — a distinct field, distinct meaning.
              fanoutToSession(outputSessionId, {
                type: 'session_init',
                sessionId: outputSessionId,
                sdkSessionId: event.session_id,
                userId: ws.userId,  // Include userId for Skills isolation
              });
            }
          }
          // P2-1: record per-run usage on the terminal `result` event. Fire-and-
          // forget; applies to silent runs too (they still consume tokens).
          if (event.type === 'result') {
            recordUsage(ws, event, outputSessionId);
            // P2 observability: record generation latency/throughput (fire-and-forget).
            recordPerf(ws, event, outputSessionId);
            // Conversation search increment (FR2): the turn's transcript is written by now —
            // re-index this session so the new messages become searchable within seconds.
            void enqueueMessageIndex(ws.userId, outputSessionId);
          }
          if (!silentInit) {
            // Forward the worker's monotonic seq so the client store can order/merge
            // live deltas deterministically (cowork redesign spec §3). Tagged with the
            // session id and fanned out to current subscribers (concurrent sessions).
            applyBackpressure(fanoutToSession(outputSessionId, { type: 'message', event, seq: msg.seq }));
          }
        } else if (msg.type === 'approval_request') {
          // Ask-mode HITL: relay the worker's tool-approval request to the client.
          if (!silentInit) {
            fanoutToSession(outputSessionId, {
              type: 'approval_request',
              toolUseID: msg.toolUseID,
              toolName: msg.toolName,
              title: msg.title ?? null,
              displayName: msg.displayName ?? null,
              description: msg.description ?? null,
              input: msg.input ?? {},
              seq: msg.seq,
            });
          }
        } else if (msg.type === 'media_gen_task_started') {
          // Canvas Agent (D5): worker saw a mcp__media-gen__* tool_use content block
          // (see ws-query-worker.mjs event loop) — create the generation_task row +
          // reserve canvas slots via the internal API (ws-server has no direct DB
          // access — see build-worker-env.js comment on why these files stay .js).
          if (effectiveCanvasId) {
            (async () => {
              try {
                const response = await fetch(`${APP_URL}/api/internal/canvas/tasks`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', cookie: ws.cookie },
                  body: JSON.stringify({
                    canvasId: effectiveCanvasId,
                    sessionId: outputSessionId,
                    kind: msg.kind || 't2i',
                    params: msg.input || {},
                  }),
                });
                if (!response.ok) {
                  console.error('[WS Server] media_gen_task_started: task create failed', response.status, await response.text());
                  return;
                }
                const task = await response.json();
                mediaGenTaskIds.set(msg.toolUseId, task.id);
                broadcastCanvas(effectiveCanvasId, 'task_created', task);
              } catch (error) {
                console.error('[WS Server] media_gen_task_started error:', error);
              }
            })();
          }
        } else if (msg.type === 'media_gen_task_result') {
          if (effectiveCanvasId) {
            (async () => {
              const taskId = mediaGenTaskIds.get(msg.toolUseId);
              if (!taskId) {
                console.error('[WS Server] media_gen_task_result: no matching task for toolUseId', msg.toolUseId);
                return;
              }
              mediaGenTaskIds.delete(msg.toolUseId);
              try {
                const response = await fetch(`${APP_URL}/api/internal/canvas/tasks/${taskId}/complete`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', cookie: ws.cookie },
                  body: JSON.stringify(
                    msg.isError
                      ? { status: 'failed', error: msg.error || 'generation failed' }
                      : { status: 'done', files: msg.files || [] }
                  ),
                });
                if (!response.ok) {
                  console.error('[WS Server] media_gen_task_result: task complete failed', response.status, await response.text());
                  return;
                }
                const result = await response.json();
                broadcastCanvas(effectiveCanvasId, 'task_updated', { taskId, status: msg.isError ? 'failed' : 'done', error: msg.error });
                for (const asset of result.assets || []) {
                  broadcastCanvas(effectiveCanvasId, 'asset_created', asset);
                }
              } catch (error) {
                console.error('[WS Server] media_gen_task_result error:', error);
              }
            })();
          }
        } else if (msg.type === 'done') {
          worker.__terminalSent = true;
          if (!silentInit) {
            fanoutToSession(outputSessionId, { type: 'done', seq: msg.seq });
          }
        } else if (msg.type === 'error') {
          worker.__terminalSent = true;
          fanoutToSession(outputSessionId, {
            type: 'error',
            code: 'worker_error',
            message: msg.message,
            retriable: true,
          });
        }
      } catch (parseError) {
        console.error('[WS Server] Worker output parse error:', parseError);
      }
    });

    // Handle stdout errors (e.g., when worker is killed)
    worker.stdout.on('error', (error) => {
      console.log('[WS Server] Worker stdout error (expected on abort):', error.message);
    });

    // Log worker stderr
    worker.stderr.on('data', (data) => {
      console.log(`[Worker ${ws.userId}]`, data.toString().trim());
    });

    worker.stderr.on('error', (error) => {
      console.log('[WS Server] Worker stderr error:', error.message);
    });

    // Handle worker exit
    worker.on('close', (code, signal) => {
      // S1/FR3: free the GLOBAL + PER-USER concurrency slots so a queued request
      // can start. Both idempotent.
      releaseWorkerPermit();
      releaseUserPermit();
      // A worker explicitly superseded by a same-session re-run (see the stale
      // replace before spawn). Its permits are freed above; everything else (the
      // terminal frame, the registry slot) belongs to the new worker. Stay silent —
      // timing-independent, so it doesn't matter whether the new worker has
      // registered yet.
      if (worker.__replaced) return;
      // Concurrent sessions: only the CURRENT registered worker for this session
      // owns its terminal frame + registry slot. Computed BEFORE the try so the
      // finally can rely on it (defence-in-depth alongside __replaced).
      const runtime = sessionRegistry.get(outputSessionId);
      const isCurrent = runtime != null && runtime.worker === worker;
      try {
        console.log('[WS Server] ========== WORKER CLOSE EVENT ==========');
        console.log('[WS Server] Worker PID:', worker.pid);
        console.log('[WS Server] Exit code:', code);
        console.log('[WS Server] Signal:', signal);
        console.log('[WS Server] User ID:', ws.userId, 'Session:', outputSessionId, 'isCurrent:', isCurrent);

        if (signal) {
          // Killed by signal (e.g., abort) - this is expected
          console.log(`[WS Server] Worker killed by signal ${signal} (expected)`);
        } else if (code !== 0 && code !== null) {
          console.error(`[WS Server] Worker exited with non-zero code ${code}`);
        } else {
          console.log('[WS Server] Worker exited normally');
        }

        if (isCurrent) {
          if (worker.__intentionalAbort && !silentInit) {
            // User abort: tell whoever is viewing this session that the run stopped
            // (fanned out → works across the originating tab AND any other viewer).
            // Mark acked so the abort handler's own close fallback (S3) doesn't
            // double-send.
            worker.__abortAcked = true;
            fanoutToSession(outputSessionId, { type: 'aborted', sessionId: outputSessionId });
          } else if (!worker.__terminalSent && !silentInit) {
            // Risk #10: ended WITHOUT a terminal frame and not an intentional abort →
            // the client would hang "running" forever. Emit a recovery error.
            console.error('[WS Server] Worker closed with no terminal frame; emitting recovery error');
            fanoutToSession(outputSessionId, {
              type: 'error',
              code: 'worker_exited',
              message: signal
                ? `The agent process was terminated (signal ${signal}) before completing.`
                : `The agent process exited unexpectedly (code ${code}) before completing.`,
              retriable: true,
              sessionId: outputSessionId,
            });
            worker.__terminalSent = true;
          }
        }
        console.log('[WS Server] ============================================');
      } catch (closeError) {
        console.error('[WS Server] ========== ERROR IN WORKER CLOSE HANDLER ==========');
        console.error('[WS Server] Close handler error:', closeError);
        console.error('[WS Server] Close handler stack:', closeError.stack);
        console.error('[WS Server] ==================================================');
      } finally {
        // Free the session slot (worker is gone — nothing left to stream). Only if
        // we're still the current worker, so a stale/replaced worker's close can't
        // unregister the live one. Runs even if the try threw, to avoid a leak.
        if (isCurrent) sessionRegistry.unregister(outputSessionId);
      }
    });

    worker.on('error', (error) => {
      // S1/FR3: on spawn failure 'close' may not fire — release both permits here
      // too (idempotent).
      releaseWorkerPermit();
      releaseUserPermit();
      const runtime = sessionRegistry.get(outputSessionId);
      const isCurrent = runtime != null && runtime.worker === worker;
      try {
        console.error('[WS Server] ========== WORKER ERROR EVENT ==========');
        console.error('[WS Server] Worker PID:', worker.pid);
        console.error('[WS Server] Error:', error);
        console.error('[WS Server] Error stack:', error.stack);
        console.error('[WS Server] Error type:', error.constructor.name);
        console.error('[WS Server] User ID:', ws.userId, 'Session:', outputSessionId);
        console.error('[WS Server] ===========================================');

        if (isCurrent) {
          fanoutToSession(outputSessionId, {
            type: 'error',
            code: 'worker_spawn_error',
            message: error.message,
            retriable: true,
            sessionId: outputSessionId,
          });
        }
      } catch (errorHandlerError) {
        console.error('[WS Server] ========== ERROR IN WORKER ERROR HANDLER ==========');
        console.error('[WS Server] Error handler error:', errorHandlerError);
        console.error('[WS Server] Error handler stack:', errorHandlerError.stack);
        console.error('[WS Server] =========================================================');
      } finally {
        // Spawn failed before 'close' could fire: free the slot here (if current).
        if (isCurrent) sessionRegistry.unregister(outputSessionId);
      }
    });

    // S1: close/error handlers now own permit release — disarm the leak net.
    releasePermitsOnError = null;

  } catch (error) {
    console.error('[WS Server] Chat error:', error);
    // S1: a throw during setup (after permits were acquired, before the worker's
    // handlers took over) would otherwise leak both permits + orphan the worker.
    if (releasePermitsOnError) {
      try { releasePermitsOnError(); } catch (cleanupErr) {
        console.error('[WS Server] Permit-net cleanup failed:', cleanupErr);
      }
      releasePermitsOnError = null;
    }
    sendMessage(ws, {
      type: 'error',
      code: 'server_error',
      message: error instanceof Error ? error.message : String(error),
      retriable: true,
    });
  }
}

/**
 * Handle incoming WebSocket message
 */
async function handleMessage(ws, msg) {
  try {
    console.log(`[WS Server] Received message from ${ws.userId}:`, summarizeMessage(msg));
    const message = JSON.parse(msg);
    console.log(`[WS Server] Parsed message type: ${message.type}`);

  // S3 — refresh idle timer only for genuine business messages (not keepalive
  // 'ping' or unknown types), so an abandoned tab that auto-pings still times out.
  if (BUSINESS_MESSAGE_TYPES.has(message.type)) {
    ws.lastActivityAt = Date.now();
  }

  switch (message.type) {
    case 'create_session':
      // Explicitly create a new empty session (without user message). Projects: an
      // optional projectId binds it to a Project at creation (race-free), used by
      // "new chat in <project>". Canvas Agent (D5): canvasId is the same idea for a
      // canvas workspace — mutually exclusive with projectId.
      await handleCreateSession(ws, message.projectId, message.canvasId);
      break;

    case 'init_session':
      if (!message.sessionId) {
        sendMessage(ws, {
          type: 'error',
          code: 'invalid_message',
          message: 'Missing sessionId for init_session',
          retriable: false,
        });
        return;
      }
      await handleChat(ws, ' ', message.sessionId, { silentInit: true, canvasId: message.canvasId });
      break;

    case 'chat':
      console.log(`[WS Server] Processing chat from ${ws.userId}, content length: ${message.content?.length || 0}`);
      if (!message.content) {
        sendMessage(ws, {
          type: 'error',
          code: 'invalid_message',
          message: 'Missing content',
          retriable: false,
        });
        return;
      }
      await handleChat(ws, message.content, message.sessionId, {
        skillSlug: message.skillSlug,
        permissionTier: message.permissionTier,
        model: message.model,
        kbIds: message.kbIds,
        canvasId: message.canvasId,
      });
      break;

    case 'resume':
      // Resume a previous session
      if (!message.sessionId) {
        sendMessage(ws, {
          type: 'error',
          code: 'invalid_message',
          message: 'Missing sessionId for resume',
          retriable: false,
        });
        return;
      }
      // Store the workspace session ID for future chats
      ws.workspaceSessionId = message.sessionId;
      // Concurrent sessions: viewing a session makes it the pre-P2 abort/approval
      // fallback target (those actions re-check ownership, so a non-owned id here is
      // inert). The LIVE-stream subscribe is deferred until AFTER the DB access gate
      // below (B1 — never attach to a stream before access is confirmed).
      ws.activeRunSessionId = message.sessionId;

      // Load session data from database (includes realSdkSessionId and claudeHomePath)
      let sessionData = null;
      let resumeSdkSessionId = sessionMapping.get(message.sessionId);

      if (ws.cookie) {
        sessionData = await loadSessionFromDb(ws.cookie, message.sessionId);
        if (sessionData) {
          if (sessionData.realSdkSessionId) {
            resumeSdkSessionId = sessionData.realSdkSessionId;
            // Cache it in memory for future use
            sessionMapping.set(message.sessionId, resumeSdkSessionId);
          }
        }
      }

      console.log(`[WS Server] Resuming session: ${message.sessionId} -> SDK: ${resumeSdkSessionId || 'not found'}`);

      // B1 (cross-user isolation): only NOW — after loadSessionFromDb confirmed this
      // user may access the session — attach to its live stream, and only if the
      // background run is owned by THIS user (the registry enforces ownership too).
      // A shared session whose run is owned by someone else is loadable but its live
      // stream stays private. No session row access → no subscribe at all.
      if (sessionData) {
        sessionRegistry.subscribe(message.sessionId, ws, ws.userId);
      }

      // Sync user's skills when resuming a session
      if (sessionData?.claudeHomePath) {
        try {
          await syncUserSkills(sessionData.claudeHomePath);
        } catch (syncError) {
          console.warn('[WS Server] Skills sync failed on resume (continuing):', syncError.message);
        }
      }

      // Send confirmation back to client
      sendMessage(ws, {
        type: 'session_init',
        sessionId: message.sessionId,
        sdkSessionId: resumeSdkSessionId || null,
        userId: ws.userId,  // Include userId for Skills isolation
      });

      // Load and send historical messages if we have session data
      if (resumeSdkSessionId && sessionData?.claudeHomePath) {
        const messages = await loadMessages(sessionData.claudeHomePath, resumeSdkSessionId);
        if (messages.length > 0) {
          console.log(`[WS Server] Sending ${messages.length} historical messages to client`);
          sendMessage(ws, {
            type: 'messages_loaded',
            messages,
          });
        }
      }
      break;

    case 'abort': {
      // Concurrent sessions: abort targets a SPECIFIC session. A P2 client sends
      // message.sessionId; a pre-P2 client sends none → fall back to the session
      // this connection is currently driving (ws.activeRunSessionId).
      const abortSessionId = message.sessionId || ws.activeRunSessionId || null;
      // B2 (cross-user isolation): only the run's OWNER may abort it. A non-owned
      // (or absent) session is treated as "nothing to abort for you" below — we ack
      // so the client clears its own state, but never SIGKILL another user's worker.
      const abortOwned = !!abortSessionId && sessionRegistry.ownerOf(abortSessionId) === ws.userId;
      const worker = abortOwned ? sessionRegistry.getWorker(abortSessionId) : null;
      console.log('[WS Server] ========== ABORT REQUEST ==========', {
        user: ws.userId,
        session: abortSessionId,
        owned: abortOwned,
        hasWorker: !!worker,
      });

      try {
        if (!worker) {
          // Nothing running for that session (or not yours) — ack so the client
          // clears its state, without touching anyone's worker.
          sendMessage(ws, { type: 'aborted', sessionId: abortSessionId });
          break;
        }

        // Cancellation is process-level: the agent loop runs in an isolated child
        // process, so SIGTERM (then SIGKILL after 2s) is the mechanism. Mark
        // intentional so the worker's close handler emits 'aborted' (fanned out to
        // all viewers) and suppresses the recovery error.
        worker.__intentionalAbort = true;
        worker.__terminalSent = true;

        // P2-2: audit the run abort (security-relevant lifecycle action).
        recordAuditEvent(ws.cookie, 'run.abort', abortSessionId, {
          workerPid: worker.pid ?? null,
        });

        try {
          worker.kill('SIGTERM');
          console.log('[WS Server] SIGTERM sent successfully');
        } catch (killError) {
          console.error('[WS Server] Error sending SIGTERM:', killError);
        }

        // Force-kill if it doesn't exit — but only if it's STILL the registered
        // worker for that session (never SIGKILL a replacement that took its place).
        const forceKillTimeout = setTimeout(() => {
          try {
            if (sessionRegistry.getWorker(abortSessionId) === worker) {
              console.log('[WS Server] Worker did not exit, force killing');
              worker.kill('SIGKILL');
            }
          } catch (forceKillError) {
            console.error('[WS Server] Error sending SIGKILL:', forceKillError);
          }
        }, 2000);
        // S3 — guarantee the requester gets 'aborted'. The shared close handler
        // emits it for the normal case (and sets __abortAcked). But if this worker
        // gets superseded by a same-session re-run before it closes (__replaced →
        // shared handler early-returns), that path is skipped — so ack here as a
        // fallback. Also clears the force-kill timer.
        worker.once('close', () => {
          clearTimeout(forceKillTimeout);
          if (!worker.__abortAcked) {
            worker.__abortAcked = true;
            sendMessage(ws, { type: 'aborted', sessionId: abortSessionId });
          }
        });
        console.log('[WS Server] ========== ABORT REQUEST SCHEDULED ==========');
      } catch (abortError) {
        console.error('[WS Server] Abort handler caught exception:', abortError);
        try {
          sendMessage(ws, {
            type: 'error',
            code: 'abort_failed',
            message: `Abort failed: ${abortError.message}`,
            retriable: false,
            sessionId: abortSessionId,
          });
        } catch (sendError) {
          console.error('[WS Server] Failed to send abort error to client:', sendError);
        }
      }
      break;
    }

    case 'start_preview':
      await handleStartPreview(ws, message);
      break;

    case 'stop_preview':
      await handleStopPreview(ws, message);
      break;

    case 'share_preview':
      await handleSharePreview(ws, message);
      break;

    case 'approval_response': {
      // Ask-mode HITL: forward the user's approve/reject to the worker's stdin
      // (newline-delimited). The worker resolves the pending canUseTool. Concurrent
      // sessions: target the worker by session id (explicit, or the connection's
      // current run) rather than a single per-connection worker.
      // B2 (cross-user isolation): only the run's OWNER may approve/deny its tools —
      // otherwise a user could auto-approve a dangerous tool (e.g. Bash) in someone
      // else's session (privilege escalation). Silently ignore non-owned requests.
      const approvalSessionId = message.sessionId || ws.activeRunSessionId;
      const ownsApproval = !!approvalSessionId && sessionRegistry.ownerOf(approvalSessionId) === ws.userId;
      const w = ownsApproval ? sessionRegistry.getWorker(approvalSessionId) : null;
      if (w && w.stdin && w.stdin.writable && message.toolUseID) {
        w.stdin.write(
          JSON.stringify({
            type: 'approval_response',
            toolUseID: message.toolUseID,
            decision: message.decision === 'allow' ? 'allow' : 'deny',
          }) + '\n',
        );
      }
      break;
    }

    case 'list_running':
      // FR4: server-authoritative running-state. Returns the user's currently
      // running (non-silent) session ids so the sidebar can show "running"
      // spinners that survive a refresh and span tabs. Deliberately NOT a
      // BUSINESS_MESSAGE_TYPE — a background poll must not reset the idle timer.
      sendMessage(ws, {
        type: 'running_sessions',
        sessionIds: sessionRegistry.listByUser(ws.userId),
      });
      break;

    case 'unsubscribe':
      // Concurrent sessions (P2): the client navigated away from a session — stop
      // fanning its live frames to this connection (backpressure relief). The worker
      // keeps running in the background; only this connection's view pointer drops.
      // No ownership check needed: a connection can only remove ITSELF from a set.
      if (message.sessionId) {
        sessionRegistry.unsubscribe(message.sessionId, ws);
      }
      break;

    case 'subscribe_canvas':
      // Canvas Agent (D5): join the broadcast channel for a canvas workspace's
      // asset/task events. Ownership-gated (canvas_workspace has no member table).
      if (!message.canvasId) {
        sendMessage(ws, { type: 'error', code: 'invalid_message', message: 'Missing canvasId for subscribe_canvas', retriable: false });
        return;
      }
      if (await verifyCanvasOwnership(ws.cookie, message.canvasId, ws.userId)) {
        subscribeCanvas(message.canvasId, ws);
      } else {
        sendMessage(ws, { type: 'error', code: 'forbidden', message: 'Not the owner of that canvas workspace', retriable: false });
      }
      break;

    case 'unsubscribe_canvas':
      if (message.canvasId) {
        unsubscribeCanvas(message.canvasId, ws);
      }
      break;

    case 'ping':
      sendMessage(ws, { type: 'pong' });
      break;

    default:
      sendMessage(ws, {
        type: 'error',
        code: 'unknown_message_type',
        message: `Unknown message type: ${message.type}`,
        retriable: false,
      });
  }
  } catch (handleMessageError) {
    console.error('[WS Server] ========== HANDLE MESSAGE ERROR ==========');
    console.error('[WS Server] Error handling message:', handleMessageError);
    console.error('[WS Server] Error stack:', handleMessageError.stack);
    console.error('[WS Server] Error type:', handleMessageError.constructor.name);
    console.error('[WS Server] Message preview:', summarizeMessage(msg));
    console.error('[WS Server] User ID:', ws.userId);
    console.error('[WS Server] ==================================================');

    // Try to send error message to client
    try {
      sendMessage(ws, {
        type: 'error',
        code: 'message_handler_error',
        message: `Failed to handle message: ${handleMessageError.message}`,
        retriable: false,
      });
    } catch (sendError) {
      console.error('[WS Server] Failed to send error to client:', sendError);
    }
  }
}

/**
 * Start WebSocket server for Claude Agent Chat
 * Can be called from Nitro plugin or run standalone
 */
export function startWebSocketServer(port = WS_PORT) {
  // Create HTTP server for WebSocket
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (await handlePreviewHttp(req, res)) {
        return;
      }
    } catch (error) {
      console.error('[WS Server] Preview HTTP handler failed:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Preview endpoint failed');
      return;
    }

    // Health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('WebSocket connection required');
  });

// Create WebSocket server
const wss = new WebSocketServer({ server: httpServer, path: '/ws/agent' });

wss.on('connection', async (ws, request) => {
  // Queue messages until auth completes (fixes race condition)
  const messageQueue = [];
  let isAuthenticated = false;

  // Set up message listener IMMEDIATELY to capture early messages
  ws.on('message', async (data) => {
    if (!isAuthenticated) {
      // Queue message until auth completes
      console.log('[WS Server] Queuing message (auth pending)');
      messageQueue.push(data);
      return;
    }

    try {
      await handleMessage(ws, data.toString());
    } catch (error) {
      console.error('[WS Server] Message error:', error);
      sendMessage(ws, {
        type: 'error',
        code: 'invalid_message',
        message: error instanceof Error ? error.message : 'Invalid message',
        retriable: false,
      });
    }
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    console.log(`[WS Server] Client disconnected: ${ws.userId || 'unknown'}`);
    // Concurrent sessions (FR1): do NOT kill the user's workers when their socket
    // closes — they keep running in the BACKGROUND and write to the transcript, so
    // the user sees the result when they come back (another tab, or a reconnect).
    // Just drop this connection from every session it was viewing; each worker is
    // reclaimed on its own completion / abort / idle safeguard.
    sessionRegistry.unsubscribeConnection(ws);
    unsubscribeCanvasConnection(ws);
  });

  ws.on('error', (error) => {
    console.error(`[WS Server] Error for ${ws.userId || 'unknown'}:`, error);
  });

  // Authenticate
  const user = await authenticateRequest(request);
  if (!user) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.userId = user.id;
  ws.cookie = request.headers.cookie || '';  // Store cookie for API calls
  ws.isAlive = true;
  ws.lastActivityAt = Date.now();  // S3 — seed idle timer at connect (post-auth)
  isAuthenticated = true;
  console.log(`[WS Server] Client connected: ${ws.userId}`);

  // Process any queued messages
  if (messageQueue.length > 0) {
    console.log(`[WS Server] Processing ${messageQueue.length} queued message(s)`);
    for (const data of messageQueue) {
      try {
        await handleMessage(ws, data.toString());
      } catch (error) {
        console.error('[WS Server] Message error:', error);
        sendMessage(ws, {
          type: 'error',
          code: 'invalid_message',
          message: error instanceof Error ? error.message : 'Invalid message',
          retriable: false,
        });
      }
    }
  }
});

// Heartbeat (+ S3 idle reaping)
const heartbeat = setInterval(() => {
  const now = Date.now();
  previewAuth.reapExpired();
  wss.clients.forEach((ws) => {
    // S3 — close alive-but-idle connections before the liveness ping. Guards
    // (active worker / never-stamped / disabled) live in shouldReapIdle().
    if (
      shouldReapIdle({
        now,
        lastActivityAt: ws.lastActivityAt,
        // Concurrent sessions: "active" = this connection is subscribed to at least
        // one running session (streaming live output). A run it started but
        // navigated away from is now owned by the registry, not ws.workerProcess.
        hasActiveWorker: sessionRegistry.hasActiveForConnection(ws),
        idleTimeoutMs: WS_IDLE_TIMEOUT_MS,
      })
    ) {
      const idleS = Math.round((now - ws.lastActivityAt) / 1000);
      console.log(`[WS Server] Reaping idle connection: ${ws.userId || 'unknown'} (idle ${idleS}s)`);
      // Send a business frame first so the client can distinguish an idle
      // disconnect (auto-reconnect / inform user) from a real error — some
      // browsers don't surface the close reason. Then close gracefully; worker
      // cleanup (if any) happens in ws.on('close'). The heartbeat terminate()
      // below is the backstop if the peer never completes the close handshake.
      try {
        sendMessage(ws, {
          type: 'idle_timeout',
          message: 'Disconnected due to inactivity. Reconnect to continue.',
        });
      } catch { /* socket may already be closing; close() still applies */ }
      ws.close(4002, 'idle timeout');
      return;  // don't also ping a socket we're closing
    }

    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
  previewRuntime.reapIdlePreviews((state) => {
    wss.clients.forEach((ws) => {
      if (ws.workspaceSessionId === state.sessionId) {
        sendPreviewState(ws, state);
      }
    });
  }).catch((error) => {
    console.error('[WS Server] Preview idle reap failed:', error);
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeat);
});

  // Start server
  httpServer.listen(port, () => {
    console.log(`[WS Server] WebSocket server running on port ${port}`);
    console.log(`[WS Server] Authenticating against ${APP_URL}`);
    console.log(`[WS Server] Sessions root: ${SESSIONS_ROOT}`);
  });

  return { httpServer, wss };
}

// ============================================================================
// Skills Store Seeder (inline implementation for .mjs compatibility)
// ============================================================================

/**
 * Seed Skills Store from built-in skills directory
 *
 * Strategy: "Non-destructive seed by default"
 * - Syncs built-in skills to store directory if missing
 * - Skips existing skills to preserve runtime-generated files (e.g. schema)
 * - Optional overwrite via SKILLS_STORE_SEED_MODE=overwrite
 *
 * Only runs in production when SKILLS_STORE_DIR is set.
 */
export async function seedSkillsStore() {
  const storeDir = process.env.SKILLS_STORE_DIR;
  const seedMode = (process.env.SKILLS_STORE_SEED_MODE || 'skip').toLowerCase();
  const shouldOverwrite = seedMode === 'overwrite';

  // Only seed in production (when SKILLS_STORE_DIR is set)
  if (!storeDir) {
    console.log('[Skills] Development mode, skipping seed');
    return;
  }

  const builtInDir = path.join(process.cwd(), 'src', 'skills-store');

  // Check if built-in directory exists
  try {
    await access(builtInDir);
  } catch {
    console.warn('[Skills] Built-in skills directory not found:', builtInDir);
    return;
  }

  // Ensure store directory exists
  await mkdir(storeDir, { recursive: true });

  // Get list of built-in skills
  const builtInEntries = await readdir(builtInDir, { withFileTypes: true });
  const builtInSkills = builtInEntries.filter(e => e.isDirectory() && !e.name.startsWith('.'));

  if (builtInSkills.length === 0) {
    console.log('[Skills] No built-in skills found, skipping seed');
    return;
  }

  console.log('[Skills] Syncing built-in skills to store...');
  console.log(`[Skills]   Source: ${builtInDir}`);
  console.log(`[Skills]   Target: ${storeDir}`);
  console.log(`[Skills]   Skills to sync: ${builtInSkills.length}`);

  let synced = 0;
  let skipped = 0;
  let overwritten = 0;

  for (const skill of builtInSkills) {
    const sourcePath = path.join(builtInDir, skill.name);
    const targetPath = path.join(storeDir, skill.name);

    try {
      // Check if target exists
      let targetExists = false;
      try {
        await access(targetPath);
        targetExists = true;
      } catch {
        // Target doesn't exist, will be created
      }

      // Default: skip existing skills to preserve runtime-generated files (e.g. schema)
      if (targetExists && !shouldOverwrite) {
        console.log(`[Skills]   → Skipped (exists): ${skill.name}`);
        skipped++;
        continue;
      }

      // Overwrite mode: preserve schema files if present
      const preservedFiles = new Map();
      if (targetExists && shouldOverwrite) {
        for (const filename of ['.schema.json', '.schema.meta.json']) {
          const filePath = path.join(targetPath, filename);
          try {
            const content = await readFile(filePath, 'utf-8');
            preservedFiles.set(filename, content);
          } catch {
            // Ignore missing/invalid schema files
          }
        }

        await rm(targetPath, { recursive: true, force: true });
      }

      await cp(sourcePath, targetPath, { recursive: true });
      synced++;

      if (targetExists && shouldOverwrite) {
        for (const [filename, content] of preservedFiles.entries()) {
          try {
            await writeFile(path.join(targetPath, filename), content, 'utf-8');
          } catch (restoreError) {
            console.warn(`[Skills]   ! Failed to restore ${filename} for ${skill.name}:`, restoreError.message);
          }
        }
        overwritten++;
        console.log(`[Skills]   ✓ Updated: ${skill.name}`);
      } else if (!targetExists) {
        console.log(`[Skills]   ✓ Added: ${skill.name}`);
      }
    } catch (err) {
      console.error(`[Skills]   ✗ Failed: ${skill.name}`, err.message);
      skipped++;
    }
  }

  console.log(`[Skills] Sync complete: ${synced} synced, ${overwritten} updated, ${skipped} skipped/failed`);
}

// ============================================================================
// User Skills Sync (inline implementation for .mjs compatibility)
// ============================================================================

const USER_DISABLED_SKILLS_FILENAME = '.disabled-skills.json';
const GLOBAL_SKILLS_FILENAME = '.global-skills.json';

/**
 * Get Skills Store directory
 */
function getSkillsStoreDir() {
  const envDir = process.env.SKILLS_STORE_DIR;
  if (envDir) return envDir;

  // Check if /data/skills-store exists (production)
  const dataDir = '/data/skills-store';
  if (existsSync(dataDir)) return dataDir;

  // Fallback to source directory (development)
  return path.join(process.cwd(), 'src', 'skills-store');
}

/**
 * Read global skills list
 */
async function readGlobalSkills() {
  const storeDir = getSkillsStoreDir();
  const filePath = path.join(storeDir, GLOBAL_SKILLS_FILENAME);

  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.skills)) return [];
    return parsed.skills.map(s => s.replace(/[^A-Za-z0-9-_]/g, '_'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    console.warn('[Skills] Failed to read global skills file:', error);
    return [];
  }
}

/**
 * Read user's disabled skills list
 */
async function readUserDisabledSkills(claudeHome) {
  const filePath = path.join(claudeHome, '.claude', USER_DISABLED_SKILLS_FILENAME);

  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.skills)) return [];
    return parsed.skills.map(s => s.replace(/[^A-Za-z0-9-_]/g, '_'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    console.warn('[Skills] Failed to read user disabled skills file:', error);
    return [];
  }
}

/**
 * Get user's currently enabled skills (from directory)
 */
async function getUserEnabledSkills(claudeHome) {
  const skillsDir = path.join(claudeHome, '.claude', 'skills');

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Check if a file/directory exists
 */
async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync user's skills based on global settings and user preferences
 *
 * Logic:
 * - Target skills = (global enabled) ∪ (user enabled) - (user disabled)
 * - Add: skills in target but not in current user directory
 * - Remove: skills in current user directory but not in target
 *
 * @param {string} claudeHome - User's CLAUDE_HOME directory
 * @returns {Promise<{added: string[], removed: string[], unchanged: string[]}>}
 */
async function syncUserSkills(claudeHome) {
  console.log(`[Skills] Syncing skills for CLAUDE_HOME: ${claudeHome}`);

  // 1. Read all lists
  const globalEnabled = await readGlobalSkills();
  const userDisabled = await readUserDisabledSkills(claudeHome);
  const currentUserSkills = await getUserEnabledSkills(claudeHome);

  // 2. Calculate target skills
  // Target = (global enabled - user disabled) ∪ (current user skills - user disabled)
  const disabledSet = new Set(userDisabled);

  // Skills that should be enabled = global enabled (minus disabled) + currently enabled (minus disabled)
  const targetSet = new Set();

  // Add global skills (unless user disabled them)
  for (const skill of globalEnabled) {
    if (!disabledSet.has(skill)) {
      targetSet.add(skill);
    }
  }

  // Keep user-enabled skills that are not disabled
  for (const skill of currentUserSkills) {
    if (!disabledSet.has(skill)) {
      targetSet.add(skill);
    }
  }

  // 3. Calculate diff
  const currentSet = new Set(currentUserSkills);
  const toAdd = Array.from(targetSet).filter(s => !currentSet.has(s));
  const toRemove = Array.from(currentSet).filter(s => !targetSet.has(s));
  // For global skills that already exist, we should update them (overwrite strategy)
  const toUpdate = globalEnabled.filter(s => currentSet.has(s) && !disabledSet.has(s));
  const unchanged = Array.from(currentSet).filter(s => targetSet.has(s) && !globalEnabled.includes(s));

  console.log(`[Skills] Sync plan:`, {
    globalEnabled: globalEnabled.length,
    userDisabled: userDisabled.length,
    current: currentUserSkills.length,
    target: targetSet.size,
    toAdd: toAdd.length,
    toUpdate: toUpdate.length,
    toRemove: toRemove.length,
  });

  const storeDir = getSkillsStoreDir();

  // 4. Add new skills
  const added = [];
  for (const skillName of toAdd) {
    try {
      const sourceDir = path.join(storeDir, skillName);
      const targetDir = path.join(claudeHome, '.claude', 'skills', skillName);

      if (!await fileExists(sourceDir)) {
        console.warn(`[Skills] Skill not found in store, skipping: ${skillName}`);
        continue;
      }

      await mkdir(path.dirname(targetDir), { recursive: true });
      await cp(sourceDir, targetDir, { recursive: true });
      added.push(skillName);
      console.log(`[Skills]   ✓ Added: ${skillName}`);
    } catch (error) {
      console.error(`[Skills]   ✗ Failed to add: ${skillName}`, error);
    }
  }

  // 4.5 Update existing global skills (overwrite with latest version)
  const updated = [];
  for (const skillName of toUpdate) {
    try {
      const sourceDir = path.join(storeDir, skillName);
      const targetDir = path.join(claudeHome, '.claude', 'skills', skillName);

      if (!await fileExists(sourceDir)) {
        console.warn(`[Skills] Skill not found in store, skipping update: ${skillName}`);
        continue;
      }

      // Remove old version and copy fresh
      await rm(targetDir, { recursive: true, force: true });
      await cp(sourceDir, targetDir, { recursive: true });
      updated.push(skillName);
      console.log(`[Skills]   ✓ Updated: ${skillName}`);
    } catch (error) {
      console.error(`[Skills]   ✗ Failed to update: ${skillName}`, error);
    }
  }

  // 5. Remove skills
  const removed = [];
  for (const skillName of toRemove) {
    try {
      const targetDir = path.join(claudeHome, '.claude', 'skills', skillName);
      await rm(targetDir, { recursive: true, force: true });
      removed.push(skillName);
      console.log(`[Skills]   ✓ Removed: ${skillName}`);
    } catch (error) {
      console.error(`[Skills]   ✗ Failed to remove: ${skillName}`, error);
    }
  }

  console.log(`[Skills] Sync complete: ${added.length} added, ${updated.length} updated, ${removed.length} removed, ${unchanged.length} unchanged`);

  return { added, updated, removed, unchanged };
}

// Run as standalone script when executed directly
if (import.meta.url.startsWith('file:')) {
  const modulePath = fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    console.log('[WS Server] Starting standalone WebSocket server...');
    // Seed Skills Store before starting server (production only)
    seedSkillsStore()
      .then(() => {
        startWebSocketServer();
      })
      .catch((err) => {
        console.error('[Skills] Seed error:', err);
        // Continue starting server even if seed fails
        startWebSocketServer();
      });
  }
}
