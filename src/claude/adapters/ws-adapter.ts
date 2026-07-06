/**
 * Claude Agent WebSocket Adapter
 *
 * Implements ChatModelAdapter for Assistant UI, using WebSocket instead of SSE
 * for more reliable real-time communication with Claude Agent SDK.
 *
 * Architecture:
 * - Persistent WebSocket connection to /ws/agent
 * - Automatic reconnection on disconnect
 * - Same event transformation as SSE adapter (SDK events -> Assistant UI format)
 */

import type { ChatModelAdapter, ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react';
import {
  notifyMessagesLoaded,
  useChatSessionStore,
  type SDKMessage as StorageSDKMessage,
  type ContentPart as StoreContentPart,
  type ThreadMessage as StoreThreadMessage,
  type PreviewState,
  type ApprovalRequest,
} from '~/lib/chat-session-store';
import type { SessionMetadata } from '~/components/claude-chat/session-info-panel';

// SDK Message Types (matching what WebSocket server sends)
type SDKContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean; isError?: boolean };

// MCP Server status from SDK system.init event
type McpServerStatus = {
  name: string;
  status: 'connected' | 'failed' | 'pending';
  error?: string;
  tool_count?: number;
};

// Local SDKMessage type for this adapter (content is always an array from streaming)
type SDKMessage = {
  type: 'system' | 'assistant' | 'user' | 'result' | 'error' | 'stream_event' | 'tool_progress' | 'text_delta' | 'text_complete';
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: {
    content: SDKContentBlock[];
  };
  result?: string;
  is_error?: boolean;
  error?: string;
  // Result event fields for usage/cost tracking
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    costUSD: number;
  }>;
  // System.init event fields for session metadata
  model?: string;
  skills?: string[];
  mcp_servers?: string[] | McpServerStatus[];
  agents?: string[];
  tools?: string[];
  slash_commands?: string[];
  cwd?: string;
  // Structured Outputs field (from outputFormat)
  structured_output?: unknown;
  // Stream event fields (from includePartialMessages)
  event?: StreamEvent;
  // Text event fields (Craft-aligned)
  text?: string;
  isIntermediate?: boolean;
  turnId?: string;
  parentToolUseId?: string | null;
  // Tool progress fields
  tool_use_id?: string;
  tool_name?: string;
  parent_tool_use_id?: string | null;
  elapsed_time_seconds?: number;
};

// Stream event types (from Anthropic SDK RawMessageStreamEvent)
type StreamEvent = {
  type: 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_start' | 'message_delta' | 'message_stop';
  index?: number;
  content_block?: {
    type: string;
    name?: string;
    id?: string;
  };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
  };
};

// WebSocket message types (matching ws-server.ts)
type InboundMessage =
  | { type: 'create_session'; projectId?: string; canvasId?: string }
  | { type: 'init_session'; sessionId: string }
  | { type: 'chat'; content: string; sessionId?: string; skillSlug?: string; permissionTier?: string; model?: string; kbIds?: string[] }
  | { type: 'resume'; sessionId: string }
  // Concurrent sessions: abort targets a specific session; unsubscribe stops the
  // server fanning a left-behind session's live frames to this connection.
  | { type: 'abort'; sessionId?: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'list_running' }
  | { type: 'start_preview'; sessionId?: string; mode?: 'static' | 'live'; force?: boolean }
  | { type: 'stop_preview'; sessionId?: string }
  | { type: 'share_preview'; previewId: string; sessionId?: string }
  | { type: 'approval_response'; toolUseID: string; decision: 'allow' | 'deny'; sessionId?: string }
  | { type: 'ping' }
  | { type: 'subscribe_canvas'; canvasId: string }
  | { type: 'unsubscribe_canvas'; canvasId: string };

// Concurrent sessions: stream frames now carry the workspace `sessionId` they
// belong to, so the adapter routes them to the right conversation (and drops
// frames for background sessions the user isn't viewing).
type OutboundMessage =
  | { type: 'session_init'; sessionId: string; sdkSessionId: string | null; userId?: string }
  | { type: 'session_metadata'; sessionId: string; metadata: SessionMetadata }
  | { type: 'message'; event: SDKMessage; seq?: number; sessionId?: string }
  | { type: 'messages_loaded'; messages: StorageSDKMessage[] }
  | { type: 'error'; code: string; message: string; retriable: boolean; sessionId?: string }
  | { type: 'done'; seq?: number; sessionId?: string }
  | { type: 'aborted'; sessionId?: string }
  | { type: 'queued'; position?: number; message?: string; sessionId?: string }
  | { type: 'running_sessions'; sessionIds: string[] }
  | { type: 'preview_state'; state: PreviewState; seq?: number }
  | {
      type: 'approval_request';
      toolUseID: string;
      toolName: string;
      title?: string | null;
      displayName?: string | null;
      description?: string | null;
      input?: Record<string, unknown>;
      seq?: number;
      sessionId?: string;
    }
  | { type: 'pong' }
  | { type: 'canvas_event'; canvasId: string; event: string; payload: unknown };

// Assistant UI Part Types
type TextPart = {
  readonly type: 'text';
  readonly text: string;
  readonly isIntermediate?: boolean;
  readonly isPending?: boolean;
  readonly turnId?: string;
  readonly parentToolUseId?: string | null;
};

type ReasoningPart = {
  readonly type: 'reasoning';
  readonly text: string;
};

// Tool execution status (Craft-aligned)
// - executing: tool is currently running
// - completed: tool finished successfully
// - error: tool failed
// - backgrounded: tool is running in background (Bash with shell_id or Task with agentId)
type ToolStatus = 'executing' | 'completed' | 'error' | 'backgrounded';

type ToolCallPart = {
  readonly type: 'tool-call';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly argsText: string;
  readonly toolStatus?: ToolStatus;
  readonly result?: unknown;
  readonly isError?: boolean;
  // Backgrounded task fields (Craft-aligned)
  readonly backgroundTaskId?: string;  // For Task tool with agentId
  readonly backgroundShellId?: string; // For Bash tool with shell_id
  readonly intent?: string;            // Description/intent of the background task
  readonly command?: string;           // Command for Bash background task
  readonly elapsedSeconds?: number;    // From tool_progress events
};

type ContentPart = TextPart | ReasoningPart | ToolCallPart;

type AttachmentDescriptor = {
  originalName?: string;
  filePath: string;
  mimeType?: string;
  fileSize?: number;
};

type AttachmentHint = {
  label: string;
  action: string;
};

type SkillSelection = {
  slug: string;
  name?: string;
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'avi', 'webm', 'mkv']);
const DOC_EXTS = new Set(['doc', 'docx', 'rtf', 'odt', 'wps']);
const SLIDE_EXTS = new Set(['ppt', 'pptx', 'key']);
const SHEET_EXTS = new Set(['xls', 'xlsx', 'csv', 'tsv']);
const TEXT_EXTS = new Set(['md', 'txt', 'log', 'yaml', 'yml', 'json', 'toml', 'ini']);

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function getAttachmentName(attachment: AttachmentDescriptor): string {
  if (attachment.originalName) return attachment.originalName;
  const normalized = normalizePath(attachment.filePath);
  return normalized.split('/').pop() || normalized;
}

function getFileExtension(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function formatFileSize(bytes?: number): string | null {
  if (!bytes || Number.isNaN(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function classifyAttachment(attachment: AttachmentDescriptor): AttachmentHint {
  const name = getAttachmentName(attachment);
  const ext = getFileExtension(name);
  const mime = attachment.mimeType?.toLowerCase() ?? '';

  const isImage = mime.startsWith('image/') || IMAGE_EXTS.has(ext);
  if (isImage) {
    return {
      label: '图片',
      action: '使用可用的视觉/图像理解或 OCR 工具',
    };
  }

  const isVideo = mime.startsWith('video/') || VIDEO_EXTS.has(ext);
  if (isVideo) {
    return {
      label: '视频',
      action: '使用可用的视频理解工具',
    };
  }

  const isPdf = mime === 'application/pdf' || ext === 'pdf';
  if (isPdf) {
    return {
      label: 'PDF',
      action: '使用文档解析/转 Markdown 工具；若为扫描件再用 OCR 工具',
    };
  }

  const isSlides = SLIDE_EXTS.has(ext)
    || mime.includes('presentation')
    || mime.includes('powerpoint');
  if (isSlides) {
    return {
      label: 'PPT',
      action: '使用幻灯片解析工具逐页提取/转 Markdown',
    };
  }

  const isSheet = SHEET_EXTS.has(ext)
    || mime.includes('spreadsheet')
    || mime.includes('excel')
    || mime === 'text/csv';
  if (isSheet) {
    return {
      label: '表格',
      action: '使用表格解析工具读取为表格/转 Markdown',
    };
  }

  const isDoc = DOC_EXTS.has(ext) || mime.includes('word') || mime.includes('document');
  if (isDoc) {
    return {
      label: '文档',
      action: '使用文档解析/转 Markdown 工具',
    };
  }

  const isText = mime.startsWith('text/') || TEXT_EXTS.has(ext);
  if (isText) {
    return {
      label: '文本',
      action: '直接读取或使用文本处理工具',
    };
  }

  return {
    label: '文件',
    action: '尝试使用可用的文件解析工具',
  };
}

/** Canvas Agent (D5/F10) — a selected canvas asset, referenced in the outgoing prompt. */
export type CanvasRefDescriptor = {
  relPath: string;
  type: 'image' | 'video';
  width?: number;
  height?: number;
  durationSec?: number;
};

function extractRunConfigCanvasRefs(runConfig?: ChatModelRunOptions['runConfig']): CanvasRefDescriptor[] {
  const custom = runConfig?.custom;
  if (!custom || typeof custom !== 'object') return [];
  const raw = (custom as { canvasRefs?: unknown }).canvasRefs;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const candidate = item as Partial<CanvasRefDescriptor>;
      if (typeof candidate.relPath !== 'string' || !candidate.relPath.trim()) return null;
      if (candidate.type !== 'image' && candidate.type !== 'video') return null;
      // Omit (not just `undefined`-set) keys so the inferred literal type actually
      // matches CanvasRefDescriptor's optional fields for the type predicate below.
      return {
        relPath: candidate.relPath,
        type: candidate.type,
        ...(typeof candidate.width === 'number' ? { width: candidate.width } : {}),
        ...(typeof candidate.height === 'number' ? { height: candidate.height } : {}),
        ...(typeof candidate.durationSec === 'number' ? { durationSec: candidate.durationSec } : {}),
      };
    })
    .filter((item): item is CanvasRefDescriptor => Boolean(item));
}

/**
 * 【画布引用】block (impl spec §6.3) — lists the canvas assets selected when the
 * message was sent, so the Agent knows what "these"/"this image" refers to without
 * having to `ls` the workspace and guess. Same shape/placement as 【附件信息】.
 */
function buildCanvasRefsBlock(refs: CanvasRefDescriptor[]): string {
  if (refs.length === 0) return '';
  const lines: string[] = ['【画布引用】'];
  refs.forEach((ref, index) => {
    const dims = ref.type === 'image'
      ? (ref.width && ref.height ? ` ${ref.width}x${ref.height}` : '')
      : [
          ref.durationSec !== undefined ? ` ${ref.durationSec.toFixed(1)}s` : '',
          ref.width && ref.height ? ` ${ref.width}x${ref.height}` : '',
        ].join('');
    lines.push(`${index + 1}. ${ref.relPath} (${ref.type}${dims})`);
  });
  return lines.join('\n');
}

function extractRunConfigAttachments(runConfig?: ChatModelRunOptions['runConfig']): AttachmentDescriptor[] {
  const custom = runConfig?.custom;
  if (!custom || typeof custom !== 'object') return [];
  const raw = (custom as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const candidate = item as Partial<AttachmentDescriptor>;
      if (typeof candidate.filePath !== 'string' || !candidate.filePath.trim()) return null;
      // Omit (not just `undefined`-set) keys — same reasoning as extractRunConfigCanvasRefs.
      return {
        ...(typeof candidate.originalName === 'string' ? { originalName: candidate.originalName } : {}),
        filePath: candidate.filePath,
        ...(typeof candidate.mimeType === 'string' ? { mimeType: candidate.mimeType } : {}),
        ...(typeof candidate.fileSize === 'number' ? { fileSize: candidate.fileSize } : {}),
      };
    })
    .filter((item): item is AttachmentDescriptor => Boolean(item));
}

function extractRunConfigSkill(runConfig?: ChatModelRunOptions['runConfig']): SkillSelection | null {
  const custom = runConfig?.custom;
  if (!custom || typeof custom !== 'object') return null;
  const raw = (custom as { skill?: unknown; skillSlug?: unknown }).skill;
  if (raw && typeof raw === 'object') {
    const candidate = raw as Partial<SkillSelection>;
    if (typeof candidate.slug === 'string' && candidate.slug.trim()) {
      return { slug: candidate.slug.trim(), name: typeof candidate.name === 'string' ? candidate.name : undefined };
    }
  }
  const slug = (custom as { skillSlug?: unknown }).skillSlug;
  if (typeof slug === 'string' && slug.trim()) {
    return { slug: slug.trim() };
  }
  return null;
}

function buildAttachmentsBlock(attachments: AttachmentDescriptor[]): string {
  if (attachments.length === 0) return '';

  const lines: string[] = ['【附件信息】'];
  attachments.forEach((attachment, index) => {
    const name = getAttachmentName(attachment);
    const hint = classifyAttachment(attachment);
    const size = formatFileSize(attachment.fileSize);
    lines.push(`${index + 1}) name: ${name}`);
    lines.push(`   path: ${attachment.filePath} (workspace-relative)`);
    if (attachment.mimeType) lines.push(`   mime: ${attachment.mimeType}`);
    if (size) lines.push(`   size: ${size}`);
    lines.push(`   type: ${hint.label}`);
    lines.push(`   use: ${hint.action}`);
  });
  lines.push('说明：不要扫描 workspace；直接使用以上 path。若解析失败，说明缺少依赖或工具。');
  return lines.join('\n');
}

// WebSocket connection state
let ws: WebSocket | null = null;
// Concurrent sessions (FR4): poll the server's running set so the sidebar stays
// accurate across tabs (another tab starting a run doesn't push to us) and refresh.
// Reactive lifecycle frames keep it prompt between polls; this is the safety net.
let runningSessionsPoll: ReturnType<typeof setInterval> | null = null;
const RUNNING_SESSIONS_POLL_MS = 8000;
let currentSessionId: string | undefined;
let currentUserId: string | undefined;  // Current user ID for Skills isolation
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1000;

// Track if a query is currently running (set when run starts, cleared on completion)
let isQueryRunning = false;

// AbortController for the run currently being driven by runChat(); onCancel/Esc
// aborts it to break the stream loop immediately (in addition to the WS abort).
let activeRunAbort: AbortController | null = null;

// 返工1 (attachment delivery): the composer used to ship attachments through the
// assistant-ui composer runConfig (setRunConfig → send → reset). That round-trip
// dropped them — the synchronous post-send reset stripped `custom.attachments`
// before assistant-ui committed them into the AppendMessage, so the worker prompt
// arrived with NO 【附件信息】 block (server log: "content length: 7"). We now stage
// attachments in this module-level slot right before send(); runChat() consumes it
// (override-once) so delivery no longer depends on the fragile runConfig timing.
let stagedAttachments: AttachmentDescriptor[] | null = null;

/**
 * Stage the attachments for the NEXT runChat() (called by the composer immediately
 * before api.composer().send()). Consumed + cleared by the next runChat().
 */
export function stagePendingAttachments(attachments: AttachmentDescriptor[] | null | undefined): void {
  stagedAttachments = attachments && attachments.length > 0 ? attachments : null;
}

// Canvas Agent (D5/F10) — same side-channel pattern as stagedAttachments above (proven
// necessary by 返工1's lesson: the assistant-ui runConfig round-trip alone drops custom
// data before send commits). selection-chips.tsx calls stagePendingCanvasRefs() right
// before send with whatever's currently selected in canvasStore.
let stagedCanvasRefs: CanvasRefDescriptor[] | null = null;

export function stagePendingCanvasRefs(refs: CanvasRefDescriptor[] | null | undefined): void {
  stagedCanvasRefs = refs && refs.length > 0 ? refs : null;
}

// Local id generator for the assistant message runChat() grows in the store.
function genMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Track queued + active runs to guard session switches and serialize streams
let pendingRuns = 0;

// Serialize runs to avoid overlapping streams (Craft queues + interrupts)
let runQueue = Promise.resolve();
const enqueueRunGate = () => {
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = runQueue;
  runQueue = next;
  return { previous, release: release! };
};

let queueEpoch = 0;

/**
 * Sync queue count to store for UI display
 * Called whenever pendingRuns changes
 */
function syncQueueCount(): void {
  // queueCount = pendingRuns - 1 (current running) when running, or pendingRuns when not
  // If pendingRuns >= 1, at least one is "processing", the rest are "queued"
  const queueCount = Math.max(0, pendingRuns - 1);
  useChatSessionStore.getState().setQueueCount(queueCount);
}

export function notifyUserAbort(): void {
  queueEpoch += 1;
  // Reset queue count since all queued runs will be cancelled
  pendingRuns = 0;
  syncQueueCount();
}

// Message queue for handling responses
type MessageHandler = (msg: OutboundMessage) => void;
let messageHandler: MessageHandler | null = null;

// Session init callback for notifying route when session changes
let sessionInitCallback: ((sessionId: string) => void) | null = null;

export function onSessionInit(callback: (sessionId: string) => void): () => void {
  sessionInitCallback = callback;
  return () => {
    sessionInitCallback = null;
  };
}

function notifySessionInit(sessionId: string): void {
  if (sessionInitCallback) {
    sessionInitCallback(sessionId);
  }
}

// Canvas Agent (D5): single-callback registration, same pattern as onSessionInit — only
// one canvas page is ever mounted at a time in a tab, so no pub/sub list needed.
let canvasEventCallback: ((event: string, payload: unknown) => void) | null = null;

export function onCanvasEvent(callback: (event: string, payload: unknown) => void): () => void {
  canvasEventCallback = callback;
  return () => {
    canvasEventCallback = null;
  };
}

export async function subscribeCanvas(canvasId: string): Promise<void> {
  await send({ type: 'subscribe_canvas', canvasId });
}

export async function unsubscribeCanvas(canvasId: string): Promise<void> {
  await send({ type: 'unsubscribe_canvas', canvasId });
}

export function getSessionId(): string | undefined {
  return currentSessionId;
}

export function setSessionId(id: string | undefined): void {
  currentSessionId = id;
}

export function clearSession(): void {
  currentSessionId = undefined;
}

/**
 * Check if a query is currently running
 * Uses multiple indicators for reliability:
 * - pendingRuns count (queued + active)
 * - isQueryRunning flag (set at start of run())
 * - messageHandler existence (set during active message processing)
 */
export function checkIsQueryRunning(): boolean {
  const running = pendingRuns > 0 || isQueryRunning || messageHandler !== null;
  console.log('[WS Adapter] checkIsQueryRunning:', running, { pendingRuns, isQueryRunning, hasMessageHandler: messageHandler !== null });
  return running;
}

/**
 * Get WebSocket URL
 * In development, connects to the same host on /ws/agent
 * In production, can be configured via VITE_WS_URL environment variable
 */
function getWebSocketUrl(): string {
  // Check for explicit WebSocket URL (e.g., for sidecar deployment)
  const configuredUrl = (import.meta.env?.VITE_WS_URL as string | undefined);
  if (configuredUrl) {
    return configuredUrl;
  }

  // Default: same host, /ws/agent path
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/agent`;
}

/**
 * Get or create WebSocket connection
 */
function getWebSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve(ws);
      return;
    }

    if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.addEventListener('open', () => resolve(ws!), { once: true });
      ws.addEventListener('error', reject, { once: true });
      return;
    }

    // Create new connection
    const url = getWebSocketUrl();

    console.log('[WS Adapter] Connecting to', url);
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[WS Adapter] Connected');
      reconnectAttempts = 0;
      // FR4: get the running set immediately (correct right after refresh/reconnect),
      // then keep a light poll going as the cross-tab safety net.
      requestRunningSessions();
      if (!runningSessionsPoll) {
        runningSessionsPoll = setInterval(requestRunningSessions, RUNNING_SESSIONS_POLL_MS);
      }
      resolve(ws!);
    };

    ws.onerror = (event) => {
      console.error('[WS Adapter] Connection error:', event);
      reject(new Error('WebSocket connection failed'));
    };

    ws.onclose = (event) => {
      console.log('[WS Adapter] Disconnected:', event.code, event.reason);
      ws = null;

      // Dispatch disconnection event for session protection
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('ws-disconnected'));
      }

      // Auto-reconnect if not intentionally closed
      if (event.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`[WS Adapter] Reconnecting (attempt ${reconnectAttempts})...`);
        setTimeout(() => {
          getWebSocket()
            .then(() => {
              // Dispatch reconnection event for session protection
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('ws-reconnected'));
              }
            })
            .catch(() => {});
        }, RECONNECT_DELAY_MS * reconnectAttempts);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as OutboundMessage;

        // Handle session init
        if (msg.type === 'session_init') {
          currentSessionId = msg.sessionId;
          if (msg.userId) {
            currentUserId = msg.userId;
            console.log('[WS Adapter] Session initialized:', msg.sessionId, 'User:', msg.userId);
          } else {
            console.log('[WS Adapter] Session initialized:', msg.sessionId);
          }
          // Notify route about session change so it can update its state
          notifySessionInit(msg.sessionId);
        }

        // Handle messages loaded (historical messages for resume). Single-path:
        // hydrate the store via the route's onMessagesLoaded subscription, then
        // stop — the run-loop message queue has no branch for it, so the old
        // forward below was a dead path (cowork redesign spec §3).
        if (msg.type === 'messages_loaded') {
          console.log('[WS Adapter] Received', msg.messages.length, 'historical messages');
          notifyMessagesLoaded(msg.messages);
          return;
        }

        // Preview state is session-level and arrives asynchronously (outside a
        // chat run), so handle it on the persistent socket rather than via the
        // per-run messageHandler (which is only set during runChat()).
        if (msg.type === 'preview_state') {
          useChatSessionStore.getState().setPreviewState(msg.state);
          return;
        }

        // Concurrent sessions (FR4): server-authoritative running set. Replace the
        // store's set so the sidebar shows "running" spinners that survive refresh
        // and span tabs. Persistent socket (outside any run).
        if (msg.type === 'running_sessions') {
          useChatSessionStore.getState().setRunningSessionIds(msg.sessionIds);
          return;
        }

        // Canvas Agent (D5): asset/task events for the canvas the user is viewing.
        // Persistent socket, outside any chat run — a canvas image can land from a
        // DIFFERENT session in the same workspace.
        if (msg.type === 'canvas_event') {
          if (canvasEventCallback) canvasEventCallback(msg.event, msg.payload);
          return;
        }

        // Ask-mode HITL: a tool-approval request arrives mid-run. Only prompt for
        // the session the user is VIEWING — a background session's approval must not
        // pop over the foreground conversation (concurrent sessions).
        if (msg.type === 'approval_request') {
          if (msg.sessionId && msg.sessionId !== currentSessionId) return;
          useChatSessionStore.getState().addPendingApproval({
            toolUseID: msg.toolUseID,
            toolName: msg.toolName,
            title: msg.title ?? null,
            displayName: msg.displayName ?? null,
            description: msg.description ?? null,
            input: msg.input ?? {},
          } as ApprovalRequest);
          return;
        }

        // Concurrent sessions — per-session routing for the streaming lifecycle
        // frames. Each carries the workspace sessionId it belongs to (P1). We render
        // only the foreground session; background sessions update the running set but
        // are not drawn live (MVP / Owner decision). Terminal frames still route so
        // the foreground refresh (FR5) and the sidebar both react.
        if (msg.type === 'message' || msg.type === 'done' || msg.type === 'aborted' || msg.type === 'error') {
          const frameSessionId = msg.sessionId;
          const isForCurrent = !frameSessionId || frameSessionId === currentSessionId;
          const store = useChatSessionStore.getState();

          // Running-state reactivity: a live `message` proves the session is running;
          // a terminal frame ends it. Keeps the sidebar prompt between list_running
          // polls (which remain the cross-tab/cross-refresh source of truth).
          if (frameSessionId) {
            if (msg.type === 'message') store.addRunningSession(frameSessionId);
            else store.removeRunningSession(frameSessionId); // done / aborted / error
          }

          // FR5 (Option 2 — snapshot + completion refresh): the session we're VIEWING
          // finished while we weren't the one locally driving it (we switched back to
          // a background run, or another tab/agent finished it) → reload its transcript
          // so the final output shows. An active local run (isQueryRunning) owns its
          // own completion via the run loop below, so skip then.
          if (isForCurrent && (msg.type === 'done' || msg.type === 'aborted') && !isQueryRunning && currentSessionId) {
            console.log('[WS Adapter] Foreground background-run finished → refreshing transcript:', currentSessionId);
            void resumeSession(currentSessionId);
            return;
          }

          // Background session (not viewed): lifecycle recorded above; nothing to draw.
          if (!isForCurrent) return;

          // Foreground frame → the active run's handler (renders message/done/error).
          if (messageHandler) messageHandler(msg);
          return;
        }

        // Everything else (session_metadata, queued, pong, …) → forward as before.
        // session_metadata's own consumers (createSession/initSession temp handlers)
        // self-filter by sessionId, so no routing needed here.
        if (messageHandler) {
          messageHandler(msg);
        }
      } catch (error) {
        console.error('[WS Adapter] Message parse error:', error);
      }
    };
  });
}

/**
 * Send message via WebSocket
 */
async function send(message: InboundMessage): Promise<void> {
  const socket = await getWebSocket();
  socket.send(JSON.stringify(message));
}

/**
 * Start / stop the Phase C preview for a session (sent over the same /ws/agent
 * socket). Defaults to the adapter's current session. The backend responds
 * asynchronously via `preview_state` events (handled on the persistent socket).
 */
export async function startPreview(
  sessionId?: string,
  mode: 'static' | 'live' = 'static',
  opts?: { force?: boolean },
): Promise<void> {
  // `force: true` rebuilds an already-running preview in place (re-install + re-build
  // + restart serve) instead of reusing the cached "ready" instance — preview is build
  // mode (static serve, no HMR), so code edits only show after a rebuild.
  await send({
    type: 'start_preview',
    sessionId: sessionId ?? currentSessionId,
    mode,
    ...(opts?.force ? { force: true } : {}),
  });
}

export async function stopPreview(sessionId?: string): Promise<void> {
  await send({ type: 'stop_preview', sessionId: sessionId ?? currentSessionId });
}

/**
 * Mark a running preview as public (Option A share toggle). The backend drops
 * the forward-auth gate for this preview and pins it alive, then replies with an
 * updated `preview_state` (public:true, shareUrl). The bare share link then
 * works for anyone who opens it (on a publicly-resolvable domain).
 */
export async function sharePreview(previewId: string, sessionId?: string): Promise<void> {
  await send({ type: 'share_preview', previewId, sessionId: sessionId ?? currentSessionId });
}

/**
 * Ask-mode HITL: send the user's approve/reject for a pending tool call back to
 * the worker (via ws-server → worker stdin), and clear it from the store.
 */
export async function respondApproval(toolUseID: string, decision: 'allow' | 'deny'): Promise<void> {
  useChatSessionStore.getState().resolvePendingApproval(toolUseID);
  await send({ type: 'approval_response', toolUseID, decision });
}

/**
 * Abort the current operation on the SERVER (kills the worker for the session
 * we're driving). Concurrent sessions: target the current session explicitly so
 * we never stop someone else's / another session's run (the server also re-checks
 * ownership). The local stream loop is stopped separately by the AbortController.
 */
export async function abort(): Promise<void> {
  console.log('[WS Adapter] ⚠️ ABORT CALLED - Stack trace:', new Error().stack);
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('[WS Adapter] Sending abort message to server for', currentSessionId);
    ws.send(JSON.stringify({ type: 'abort', sessionId: currentSessionId }));
  } else {
    console.log('[WS Adapter] WebSocket not open, cannot send abort');
  }
}

/**
 * Concurrent sessions (FR1): detach the in-flight LOCAL run without stopping the
 * backend worker. Used when switching away from / opening a new chat over a running
 * session — the old session keeps running in the background; we just stop driving
 * its stream locally so a new session can take over the single foreground view.
 * (Contrast cancelActiveRun(), the Stop button, which DOES kill the worker.)
 */
export function detachActiveRun(): void {
  notifyUserAbort();
  // Break the local generator loop (abortHandler no longer sends a WS abort), so
  // the run gate releases and messageHandler clears — but the worker lives on.
  activeRunAbort?.abort();
}

/**
 * Concurrent sessions: tell the server to stop fanning a session's live frames to
 * this connection (we've navigated away from it). The worker keeps running; we just
 * unsubscribe. The server reclaims nothing here — it's pure backpressure relief.
 */
export function unsubscribeSession(sessionId: string | undefined): void {
  if (!sessionId) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'unsubscribe', sessionId }));
  }
}

/**
 * Concurrent sessions (FR4): ask the server which of THIS user's sessions are
 * running, so the sidebar can show "running" indicators that survive refresh and
 * span tabs. Reply arrives as a `running_sessions` frame (handled on the socket).
 */
export function requestRunningSessions(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'list_running' }));
  }
}

/**
 * Resume a previous session
 * Sends resume message to server and updates current session ID
 */
export async function resumeSession(sessionId: string): Promise<void> {
  console.log('[WS Adapter] Resuming session:', sessionId);
  currentSessionId = sessionId;
  await send({ type: 'resume', sessionId });
}

/**
 * Create a new empty session explicitly
 * Sends create_session message to server, which creates session without user message
 * Returns a promise that resolves when session_init is received
 */
export async function createSession(projectId?: string, canvasId?: string): Promise<string> {
  console.log(
    '[WS Adapter] Creating new session explicitly',
    projectId ? `(project ${projectId})` : canvasId ? `(canvas ${canvasId})` : ''
  );
  return new Promise((resolve, reject) => {
    // Set up one-time listener for session_init
    const onInit = (msg: OutboundMessage) => {
      if (msg.type === 'session_init') {
        cleanup();
        resolve(msg.sessionId);
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message));
      }
    };

    // Temporary handler for this session creation
    const originalHandler = messageHandler;
    messageHandler = (msg: OutboundMessage) => {
      // Forward to original handler
      if (originalHandler) originalHandler(msg);
      // Also check for our session_init
      onInit(msg);
    };

    const cleanup = () => {
      messageHandler = originalHandler;
    };

    // Send create_session message. Projects: an optional projectId binds the fresh
    // session to a Project at creation time (race-free), used by "new chat in <project>".
    // Canvas Agent (D5): canvasId is the same idea for a canvas workspace — mutually
    // exclusive with projectId.
    send({ type: 'create_session', ...(projectId ? { projectId } : {}), ...(canvasId ? { canvasId } : {}) })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

/**
 * Initialize a session to fetch system metadata before showing composer
 * Sends init_session message and resolves when session_metadata is received
 */
export async function initSession(sessionId: string): Promise<SessionMetadata> {
  console.log('[WS Adapter] Initializing session metadata:', sessionId);
  return new Promise((resolve, reject) => {
    const onInit = (msg: OutboundMessage) => {
      if (msg.type === 'session_metadata' && msg.sessionId === sessionId) {
        cleanup();
        useChatSessionStore.getState().setSessionMetadata(msg.metadata);
        resolve(msg.metadata);
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message));
      }
    };

    const originalHandler = messageHandler;
    messageHandler = (msg: OutboundMessage) => {
      if (originalHandler) originalHandler(msg);
      onInit(msg);
    };

    const cleanup = () => {
      messageHandler = originalHandler;
    };

    send({ type: 'init_session', sessionId })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

/**
 * Start a new session
 * Clears the current session ID so next message creates a new session
 */
export function newSession(): void {
  console.log('[WS Adapter] Starting new session');
  currentSessionId = undefined;
}

/**
 * Close WebSocket connection
 */
export function disconnect(): void {
  if (runningSessionsPoll) {
    clearInterval(runningSessionsPoll);
    runningSessionsPoll = null;
  }
  if (ws) {
    ws.close(1000, 'User disconnect');
    ws = null;
  }
}

/**
 * Claude Agent WebSocket stream generator.
 *
 * Internal: kept as a ChatModelAdapter-shaped async generator (queueing, abort,
 * event→ContentPart transformation, streaming throttle all unchanged), but it is
 * no longer fed to a LocalRuntime. Instead `runChat()` below drives it and writes
 * each yielded chunk into the single message store (externalStore mode).
 */
const ClaudeAgentWSAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal, runConfig }: ChatModelRunOptions) {
    console.log('[WS Adapter] run() called with', messages.length, 'messages');

    pendingRuns += 1;
    syncQueueCount(); // Update UI queue count
    const runEpoch = queueEpoch;
    const { previous, release } = enqueueRunGate();

    await previous;

    try {
      if (abortSignal?.aborted || runEpoch !== queueEpoch) {
        yield {
          content: [{ type: 'text', text: '' }] as ChatModelRunResult['content'],
          status: { type: 'incomplete', reason: 'cancelled' },
        } satisfies ChatModelRunResult;
        return;
      }

      // Mark query as running and sync to store (sets agentStatus to 'thinking')
      isQueryRunning = true;
      useChatSessionStore.getState().setIsRunning(true);

      // 1. Extract the latest user message
      const lastMessage = messages.at(-1);
      if (!lastMessage || lastMessage.role !== 'user') {
        throw new Error('No user message to process');
      }

      const textParts = lastMessage.content.filter(
        (part): part is { type: 'text'; text: string } => part.type === 'text'
      );
      const prompt = textParts.map((p) => p.text).join('\n');
      const attachments = extractRunConfigAttachments(runConfig);
      const selectedSkill = extractRunConfigSkill(runConfig);
      const attachmentsBlock = buildAttachmentsBlock(attachments);
      const canvasRefs = extractRunConfigCanvasRefs(runConfig);
      const canvasRefsBlock = buildCanvasRefsBlock(canvasRefs);
      const fullPrompt = [prompt, attachmentsBlock, canvasRefsBlock].filter(Boolean).join('\n\n');
      // 返工1 instrumentation: confirm the 【附件信息】/【画布引用】 blocks actually enter the
      // prompt. A's bug evidence was server-side "content length: 7" (body only); after the
      // fix this should show attachments/canvasRefs > 0 and fullPrompt much longer than raw.
      console.log(
        `[WS Adapter] run: attachments=${attachments.length} canvasRefs=${canvasRefs.length} promptLen=${prompt.length} fullPromptLen=${fullPrompt.length}`,
      );

      if (!prompt.trim()) {
        throw new Error('Empty prompt');
      }

      // 2. Create message queue for async iteration
      const messageQueue: OutboundMessage[] = [];
      let resolveNext: (() => void) | null = null;
      let isComplete = false;
      let error: Error | null = null;
      let isAborted = false;

      // 3. Set up abort handler.
      // Local-only stop: break THIS run's stream loop. The WS abort (kill the
      // backend worker) is the explicit caller's job now — cancelActiveRun() (Stop
      // button) sends it; detachActiveRun() (session switch) does NOT, so the session
      // keeps running in the background (concurrent sessions, FR1).
      const abortHandler = () => {
        isAborted = true;
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      };
      abortSignal?.addEventListener('abort', abortHandler);

      messageHandler = (msg: OutboundMessage) => {
        messageQueue.push(msg);
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      };

      // Note: thinkingMode is no longer sent to server - SDK's claude_code preset handles this automatically
      // The showThinking toggle in UI only controls whether to display received reasoning content

      // 4. Send chat message
      try {
        console.log('[WS Adapter] Sending chat message:', { type: 'chat', content: fullPrompt.substring(0, 50), sessionId: currentSessionId });
        console.log('[WS Adapter] Full prompt length:', fullPrompt.length);
        await send({
          type: 'chat',
          content: fullPrompt,
          sessionId: currentSessionId,
          skillSlug: selectedSkill?.slug,
          // PR-B: client-preferred permission tier (server clamps to org ceiling).
          permissionTier: useChatSessionStore.getState().selectedTier,
          // Multi-model: per-conversation selected model id (server validates +
          // rejects on unknown/disabled/unhealthy; undefined → server default).
          model: useChatSessionStore.getState().selectedModelId,
          // Session KB scope (面板勾选, prd 阶段3): kb_search restricts to these KBs.
          kbIds: useChatSessionStore.getState().selectedKbIds,
        });
        console.log('[WS Adapter] ✅ Message sent successfully');
      } catch (connectError) {
        console.error('[WS Adapter] ❌ Failed to send message:', connectError);
        throw new Error('Failed to connect to WebSocket server');
      }

      // 5. Process messages
      const content: ContentPart[] = [];
      const toolCalls = new Map<string, ToolCallPart>();

      // Track accumulated text length for proper streaming
      let accumulatedTextLength = 0;
      let hasTextEvents = false;

      // Streaming throttle: buffer text updates to reduce render frequency
      const STREAMING_THROTTLE_MS = 100;
      let lastTextYieldTime = 0;
      let pendingTextYield = false;
      let pendingErrorStatus: ChatModelRunResult['status'] | null = null;

      const markPendingToolsAsError = (message: string): boolean => {
        let updated = false;

        for (let i = 0; i < content.length; i++) {
          const part = content[i];
          if (part.type === 'tool-call' && part.result === undefined) {
            const updatedPart: ToolCallPart = {
              ...part,
              result: message,
              isError: true,
              toolStatus: 'error', // Craft-aligned: fail-safe convergence
            };
            content[i] = updatedPart;
            toolCalls.set(part.toolCallId, updatedPart);
            updated = true;
          }
        }

        return updated;
      };

      const findPendingTextIndex = (): number => {
        for (let i = content.length - 1; i >= 0; i--) {
          const part = content[i];
          if (part.type === 'text' && part.isPending) {
            return i;
          }
        }
        return -1;
      };

      const ensurePendingTextPart = (turnId?: string, parentToolUseId?: string | null): number => {
        const existingIndex = findPendingTextIndex();
        if (existingIndex !== -1) return existingIndex;

        content.push({
          type: 'text',
          text: '',
          isPending: true,
          ...(turnId && { turnId }),
          ...(parentToolUseId !== undefined && { parentToolUseId }),
        });
        return content.length - 1;
      };

      try {
      while (!isComplete && !error) {
        if (isAborted) {
          break;
        }
        // Wait for next message
        if (messageQueue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }

        if (isAborted) {
          break;
        }
        const msg = messageQueue.shift();
        if (!msg) continue;

        console.log('[WS Adapter] Processing message type:', msg.type);

        switch (msg.type) {
          case 'session_init':
            currentSessionId = msg.sessionId;
            break;

          case 'message':
            const event = msg.event;

            switch (event.type) {
              case 'system':
                // Save session metadata from system.init event
                if (event.subtype === 'init') {
                  const metadata: SessionMetadata = {
                    session_id: event.session_id || currentSessionId || '',
                    user_id: currentUserId || '',  // Use current user ID for Skills isolation
                    model: event.model || 'unknown',
                    skills: event.skills || [],
                    mcp_servers: event.mcp_servers || [],
                    agents: event.agents || [],
                    tools: event.tools || [],
                    slash_commands: event.slash_commands || [],
                    cwd: event.cwd || '',
                  };
                  useChatSessionStore.getState().setSessionMetadata(metadata);
                  console.log('[WS Adapter] Saved session metadata:', metadata);
                }
                // Note: We don't update currentSessionId here because we use
                // our workspaceSessionId (from session_init), not the SDK's session_id
                break;

              case 'text_delta': {
                hasTextEvents = true;
                const deltaText = event.text || '';
                if (!deltaText) break;

                const idx = ensurePendingTextPart(event.turnId, event.parentToolUseId ?? null);
                const existing = content[idx] as TextPart;
                content[idx] = {
                  ...existing,
                  text: (existing.text || '') + deltaText,
                  isPending: true,
                  ...(event.turnId && { turnId: event.turnId }),
                  ...(event.parentToolUseId !== undefined && { parentToolUseId: event.parentToolUseId }),
                };

                // Update agent status to streaming when text is coming in
                useChatSessionStore.getState().setAgentStatus('streaming');

                // Throttled yield for text streaming
                const now = Date.now();
                if (now - lastTextYieldTime >= STREAMING_THROTTLE_MS) {
                  pendingTextYield = false;
                  lastTextYieldTime = now;
                  yield {
                    content: [...content] as ChatModelRunResult['content'],
                    status: { type: 'running' },
                  } satisfies ChatModelRunResult;
                } else {
                  pendingTextYield = true;
                }
                break;
              }

              case 'text_complete': {
                hasTextEvents = true;
                const completedText = event.text || '';
                const isIntermediate = Boolean(event.isIntermediate);
                const idx = findPendingTextIndex();

                if (idx === -1) {
                  // No pending part - create a completed segment
                  content.push({
                    type: 'text',
                    text: completedText,
                    isIntermediate,
                    isPending: false,
                    ...(event.turnId && { turnId: event.turnId }),
                    ...(event.parentToolUseId !== undefined && { parentToolUseId: event.parentToolUseId }),
                  });
                } else {
                  const existing = content[idx] as TextPart;
                  content[idx] = {
                    ...existing,
                    text: completedText || existing.text,
                    isIntermediate,
                    isPending: false,
                    ...(event.turnId && { turnId: event.turnId }),
                    ...(event.parentToolUseId !== undefined && { parentToolUseId: event.parentToolUseId }),
                  };
                }

                pendingTextYield = false;
                lastTextYieldTime = Date.now();
                yield {
                  content: [...content] as ChatModelRunResult['content'],
                  status: { type: 'running' },
                } satisfies ChatModelRunResult;
                break;
              }

              case 'assistant':
                if (event.message?.content) {
                  // Track what types of content changed
                  let hasTextChange = false;
                  let hasNonTextChange = false;

                  for (const block of event.message.content) {
                    switch (block.type) {
                      case 'text':
                        if (hasTextEvents) {
                          break;
                        }
                        if (block.text) {
                          // Check if this is new text content
                          const newTextLength = block.text.length;
                          if (newTextLength > accumulatedTextLength) {
                            // We have new text to add
                            accumulatedTextLength = newTextLength;
                            hasTextChange = true;
                          }

                          // Update agent status to streaming when text is coming in
                          useChatSessionStore.getState().setAgentStatus('streaming');

                          // Always update the text part with the full accumulated text
                          let existingText = content.find(
                            (p): p is TextPart => p.type === 'text'
                          );
                          if (existingText) {
                            const index = content.indexOf(existingText);
                            content[index] = { type: 'text', text: block.text };
                          } else {
                            content.push({ type: 'text', text: block.text });
                          }
                        }
                        break;

                      case 'thinking':
                        if (block.thinking) {
                          content.push({
                            type: 'reasoning',
                            text: block.thinking,
                          });
                          hasNonTextChange = true;
                          // Update agent status to reasoning
                          useChatSessionStore.getState().setAgentStatus('reasoning');
                        }
                        break;

                      case 'tool_use':
                        if (block.id && block.name) {
                          // Update agent status to toolUse and set current tool name
                          useChatSessionStore.getState().setAgentStatus('toolUse');
                          useChatSessionStore.getState().setCurrentToolName(block.name);
                          // Ensure args is always a plain object (never array or primitive)
                          let safeArgs: Record<string, unknown>;
                          const inputType = block.input == null ? 'null' : Array.isArray(block.input) ? 'array' : typeof block.input;
                          console.log(`[WS Adapter] tool_use: ${block.name}, input type: ${inputType}`, block.input);

                          if (block.input == null) {
                            safeArgs = {};
                          } else if (Array.isArray(block.input)) {
                            // If input is an array, wrap it in an object
                            safeArgs = { items: block.input };
                            console.warn('[WS Adapter] Wrapped array input for tool:', block.name);
                          } else if (typeof block.input === 'object') {
                            safeArgs = block.input as Record<string, unknown>;
                          } else {
                            // If input is a primitive, wrap it
                            safeArgs = { value: block.input };
                            console.warn('[WS Adapter] Wrapped primitive input for tool:', block.name);
                          }

                          const toolPart: ToolCallPart = {
                            type: 'tool-call',
                            toolCallId: block.id,
                            toolName: block.name,
                            args: safeArgs,
                            argsText: JSON.stringify(block.input ?? {}),
                            toolStatus: 'executing', // Craft-aligned: mark as executing on creation
                          };

                          console.log('[WS Adapter] Created toolPart:', { type: toolPart.type, toolName: toolPart.toolName, argsType: typeof toolPart.args, argsIsArray: Array.isArray(toolPart.args) });

                          toolCalls.set(block.id, toolPart);
                          content.push(toolPart);
                          hasNonTextChange = true;
                        }
                        break;
                    }
                  }

                  // Throttled yield logic:
                  // - Non-text changes (tool calls, thinking) always yield immediately
                  // - Text-only changes are throttled to reduce render frequency
                  const now = Date.now();

                  if (hasNonTextChange) {
                    // Important event: yield immediately and flush any pending text
                    pendingTextYield = false;
                    lastTextYieldTime = now;
                    yield {
                      content: [...content] as ChatModelRunResult['content'],
                      status: { type: 'running' },
                    } satisfies ChatModelRunResult;
                  } else if (hasTextChange) {
                    // Text-only change: check throttle
                    const timeSinceLastYield = now - lastTextYieldTime;

                    if (timeSinceLastYield >= STREAMING_THROTTLE_MS) {
                      // Enough time has passed, yield now
                      pendingTextYield = false;
                      lastTextYieldTime = now;
                      yield {
                        content: [...content] as ChatModelRunResult['content'],
                        status: { type: 'running' },
                      } satisfies ChatModelRunResult;
                    } else {
                      // Mark as pending, will be flushed later
                      pendingTextYield = true;
                    }
                  }
                }
                break;

              case 'user':
                if (event.message?.content) {
                  for (const block of event.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                      const toolPart = toolCalls.get(block.tool_use_id);
                      if (toolPart) {
                        // Clear current tool name after result is received
                        useChatSessionStore.getState().setCurrentToolName(null);
                        useChatSessionStore.getState().setAgentStatus('thinking');

                        // Normalize block.content to a safe string format
                        // block.content can be: string | array | object
                        let resultContent: string;
                        if (typeof block.content === 'string') {
                          resultContent = block.content;
                        } else if (Array.isArray(block.content)) {
                          // Extract text from content blocks
                          resultContent = block.content
                            .map((item: any) => {
                              if (typeof item === 'string') return item;
                              if (item?.type === 'text') return item.text || '';
                              return JSON.stringify(item);
                            })
                            .join('\n');
                        } else {
                          // Object or other type - stringify it
                          resultContent = JSON.stringify(block.content, null, 2);
                        }

                        const isError = Boolean(block.is_error ?? (block as { isError?: boolean }).isError);

                        // Detect backgrounded status from tool_result (Craft-aligned)
                        // Reference: craft-agent.ts:2864-2903
                        let toolStatus: ToolStatus = isError ? 'error' : 'completed';
                        let backgroundTaskId: string | undefined;
                        let backgroundShellId: string | undefined;
                        let intent: string | undefined;
                        let command: string | undefined;

                        if (!isError && resultContent) {
                          const toolName = toolPart.toolName.toLowerCase();

                          // Task tool: detect agentId in result
                          if (toolName === 'task') {
                            const agentIdMatch = resultContent.match(/agentId:\s*([a-zA-Z0-9_-]+)/);
                            if (agentIdMatch && agentIdMatch[1]) {
                              toolStatus = 'backgrounded';
                              backgroundTaskId = agentIdMatch[1];
                              // Extract intent from args if available
                              const args = toolPart.args;
                              if (typeof args.description === 'string') {
                                intent = args.description;
                              } else if (typeof args._intent === 'string') {
                                intent = args._intent;
                              }
                              console.log(`[WS Adapter] Task backgrounded: taskId=${backgroundTaskId}, intent=${intent}`);
                            }
                          }

                          // Bash tool: detect shell_id or backgroundTaskId in result
                          if (toolName === 'bash') {
                            const shellIdMatch = resultContent.match(/shell_id:\s*([a-zA-Z0-9_-]+)/)
                              || resultContent.match(/"backgroundTaskId":\s*"([a-zA-Z0-9_-]+)"/);
                            if (shellIdMatch && shellIdMatch[1]) {
                              toolStatus = 'backgrounded';
                              backgroundShellId = shellIdMatch[1];
                              // Extract command and intent from args
                              const args = toolPart.args;
                              if (typeof args.command === 'string') {
                                command = args.command;
                              }
                              if (typeof args.description === 'string') {
                                intent = args.description;
                              } else if (typeof args._intent === 'string') {
                                intent = args._intent;
                              }
                              console.log(`[WS Adapter] Bash backgrounded: shellId=${backgroundShellId}, command=${command}`);
                            }
                          }
                        }

                        const updatedPart: ToolCallPart = {
                          ...toolPart,
                          result: resultContent,
                          isError,
                          toolStatus,
                          ...(backgroundTaskId && { backgroundTaskId }),
                          ...(backgroundShellId && { backgroundShellId }),
                          ...(intent && { intent }),
                          ...(command && { command }),
                        };
                        toolCalls.set(block.tool_use_id, updatedPart);

                        const index = content.findIndex(
                          (p) =>
                            p.type === 'tool-call' &&
                            p.toolCallId === block.tool_use_id
                        );
                        if (index !== -1) {
                          content[index] = updatedPart;
                        }
                      }
                    }
                  }

                  yield {
                    content: [...content] as ChatModelRunResult['content'],
                    status: { type: 'running' },
                  } satisfies ChatModelRunResult;
                }
                break;

              case 'tool_progress': {
                // SDK tool progress events (top-level)
                // Reference: craft-agent.ts:2924-2946
                const progress = event as {
                  tool_use_id?: string;
                  tool_name?: string;
                  parent_tool_use_id?: string | null;
                  elapsed_time_seconds?: number;
                };

                if (progress.elapsed_time_seconds !== undefined) {
                  // Use parent_tool_use_id if this is a child tool, so progress updates the parent Task
                  const targetToolId = progress.parent_tool_use_id || progress.tool_use_id;
                  if (targetToolId) {
                    const toolPart = toolCalls.get(targetToolId);
                    if (toolPart) {
                      const updatedPart: ToolCallPart = {
                        ...toolPart,
                        elapsedSeconds: progress.elapsed_time_seconds,
                      };
                      toolCalls.set(targetToolId, updatedPart);

                      const index = content.findIndex(
                        (p) => p.type === 'tool-call' && p.toolCallId === targetToolId
                      );
                      if (index !== -1) {
                        content[index] = updatedPart;
                      }

                      console.log(`[WS Adapter] tool_progress: tool=${progress.tool_name}, elapsed=${progress.elapsed_time_seconds}s`);

                      yield {
                        content: [...content] as ChatModelRunResult['content'],
                        status: { type: 'running' },
                      } satisfies ChatModelRunResult;
                    }
                  }
                }
                break;
              }

              case 'result':
                // Extract and save usage data if available
                if (event.usage || event.total_cost_usd) {
                  const usageData = {
                    usage: event.usage,
                    total_cost_usd: event.total_cost_usd,
                    num_turns: event.num_turns,
                    duration_ms: event.duration_ms,
                    modelUsage: event.modelUsage,
                  };
                  useChatSessionStore.getState().setUsageData(usageData);
                  console.log('[WS Adapter] Saved usage data:', usageData);
                }

                // Extract and save structured output if available
                if (event.structured_output) {
                  useChatSessionStore.getState().setLastStructuredOutput(event.structured_output);
                  console.log('[WS Adapter] Saved structured output:', event.structured_output);
                }

                if (event.is_error || event.subtype?.startsWith('error')) {
                  if (markPendingToolsAsError('Error occurred')) {
                    pendingErrorStatus = { type: 'incomplete', reason: 'error' };
                  }
                  error = new Error(event.result || 'Agent execution failed');
                }
                // Treat the result event as the end of the run in case "done" is missing.
                isComplete = true;
                break;

              case 'error':
                error = new Error(event.error || 'Unknown error');
                if (markPendingToolsAsError('Error occurred')) {
                  pendingErrorStatus = { type: 'incomplete', reason: 'error' };
                }
                break;

              case 'stream_event':
                // Handle streaming partial messages (enabled via includePartialMessages: true)
                // event.event contains the raw Anthropic stream event
                if (event.event) {
                  const streamEvent = event.event;

                  switch (streamEvent.type) {
                    case 'content_block_start':
                      // A new content block is starting
                      if (streamEvent.content_block?.type === 'thinking') {
                        useChatSessionStore.getState().setAgentStatus('reasoning');
                      } else if (streamEvent.content_block?.type === 'tool_use') {
                        useChatSessionStore.getState().setAgentStatus('toolUse');
                        useChatSessionStore.getState().setCurrentToolName(streamEvent.content_block.name || 'tool');
                      } else if (streamEvent.content_block?.type === 'text') {
                        useChatSessionStore.getState().setAgentStatus('streaming');
                      }
                      break;

                    case 'content_block_delta':
                      // Incremental content update
                      if (streamEvent.delta?.type === 'text_delta' && streamEvent.delta.text) {
                        if (hasTextEvents) {
                          break;
                        }
                        // Accumulate text delta
                        let existingText = content.find(
                          (p): p is TextPart => p.type === 'text'
                        );
                        if (existingText) {
                          const index = content.indexOf(existingText);
                          content[index] = { type: 'text', text: existingText.text + streamEvent.delta.text };
                        } else {
                          content.push({ type: 'text', text: streamEvent.delta.text });
                        }

                        // Throttled yield for text streaming
                        const now = Date.now();
                        if (now - lastTextYieldTime >= STREAMING_THROTTLE_MS) {
                          lastTextYieldTime = now;
                          yield {
                            content: [...content] as ChatModelRunResult['content'],
                            status: { type: 'running' },
                          } satisfies ChatModelRunResult;
                        } else {
                          pendingTextYield = true;
                        }
                      } else if (streamEvent.delta?.type === 'thinking_delta' && streamEvent.delta.thinking) {
                        // Accumulate thinking delta
                        let existingReasoning = content.find(
                          (p): p is ReasoningPart => p.type === 'reasoning'
                        );
                        if (existingReasoning) {
                          const index = content.indexOf(existingReasoning);
                          content[index] = { type: 'reasoning', text: existingReasoning.text + streamEvent.delta.thinking };
                        } else {
                          content.push({ type: 'reasoning', text: streamEvent.delta.thinking });
                        }

                        // Yield immediately for reasoning updates
                        yield {
                          content: [...content] as ChatModelRunResult['content'],
                          status: { type: 'running' },
                        } satisfies ChatModelRunResult;
                      }
                      break;

                    case 'content_block_stop':
                      // Content block finished - flush any pending content
                      if (pendingTextYield) {
                        pendingTextYield = false;
                        yield {
                          content: [...content] as ChatModelRunResult['content'],
                          status: { type: 'running' },
                        } satisfies ChatModelRunResult;
                      }
                      break;

                    case 'message_start':
                      // Message starting
                      useChatSessionStore.getState().setAgentStatus('thinking');
                      break;

                    case 'message_delta':
                      // Message state change (e.g., stop_reason)
                      break;

                    case 'message_stop':
                      // Message complete
                      break;

                  }
                }
                break;
            }
            break;

          case 'error':
            console.error('[WS Adapter] ❌ Received error message:', msg.message);
            error = new Error(msg.message || 'Unknown error');
            break;

          case 'done':
            console.log('[WS Adapter] ✅ Received done message');
            isComplete = true;
            break;

          case 'aborted':
            console.log('[WS Adapter] ⛔ Received aborted message');
            markPendingToolsAsError('Interrupted');
            isAborted = true;
            isComplete = true;
            break;
        }
      }

      // Flush any pending text content before completion
      if (pendingTextYield && content.length > 0) {
        yield {
          content: [...content] as ChatModelRunResult['content'],
          status: { type: 'running' },
        } satisfies ChatModelRunResult;
      }

      if (error && pendingErrorStatus && content.length > 0) {
        yield {
          content: [...content] as ChatModelRunResult['content'],
          status: pendingErrorStatus,
        } satisfies ChatModelRunResult;
      }

      if (error) {
        throw error;
      }
      } finally {
        abortSignal?.removeEventListener('abort', abortHandler);
        messageHandler = null;
        isQueryRunning = false;
        // Sync to store - this also resets agentStatus to 'idle' and currentToolName to null
        useChatSessionStore.getState().setIsRunning(false);
      }

      if (isAborted) {
        // Include any content that was already generated before the abort
        yield {
          content: (content.length > 0 ? content : [{ type: 'text', text: '' }]) as ChatModelRunResult['content'],
          status: { type: 'incomplete', reason: 'cancelled' },
        } satisfies ChatModelRunResult;
        return;
      }

      // 6. Yield final result
      yield {
        content: (content.length > 0 ? content : [{ type: 'text', text: '' }]) as ChatModelRunResult['content'],
        status: { type: 'complete', reason: 'stop' },
      } satisfies ChatModelRunResult;
    } finally {
      pendingRuns = Math.max(0, pendingRuns - 1);
      syncQueueCount(); // Update UI queue count
      release();
    }
  },
};

/**
 * Drive one agent turn and stream it into the single message store.
 *
 * The user message is expected to already be in the store (added by the route's
 * externalStore `onNew`). This creates the assistant message up-front (status
 * `running`) and patches it in place on every yielded chunk, so the left thread
 * AND the right Workbench (both read `chat-session-store.messages`) update live.
 */
export async function runChat(
  prompt: string,
  options: { runConfig?: ChatModelRunOptions['runConfig'] } = {}
): Promise<void> {
  const assistantId = genMessageId();
  const store = useChatSessionStore.getState();

  // Assistant placeholder so the turn is visible (spinner) before the first token.
  store.addMessage({
    id: assistantId,
    role: 'assistant',
    content: [],
    createdAt: new Date(),
    status: { type: 'running' },
  });

  const abortController = new AbortController();
  activeRunAbort = abortController;

  // 返工1: consume any attachments the composer staged right before send (the
  // reliable path — see stagePendingAttachments). They OVERRIDE whatever the
  // assistant-ui runConfig carried (which the post-send reset may have emptied).
  // Consume-once so a later regenerate/run doesn't re-attach stale files.
  let effectiveRunConfig = options.runConfig;
  if (stagedAttachments && stagedAttachments.length > 0) {
    const baseCustom = (effectiveRunConfig?.custom ?? {}) as Record<string, unknown>;
    effectiveRunConfig = {
      ...(effectiveRunConfig ?? {}),
      custom: { ...baseCustom, attachments: stagedAttachments },
    } as ChatModelRunOptions['runConfig'];
    console.log('[WS Adapter] runChat: using', stagedAttachments.length, 'staged attachment(s)');
  }
  stagedAttachments = null;

  // Canvas Agent (D5/F10): same override-once pattern as attachments above.
  if (stagedCanvasRefs && stagedCanvasRefs.length > 0) {
    const baseCustom = (effectiveRunConfig?.custom ?? {}) as Record<string, unknown>;
    effectiveRunConfig = {
      ...(effectiveRunConfig ?? {}),
      custom: { ...baseCustom, canvasRefs: stagedCanvasRefs },
    } as ChatModelRunOptions['runConfig'];
    console.log('[WS Adapter] runChat: using', stagedCanvasRefs.length, 'staged canvas ref(s)');
  }
  stagedCanvasRefs = null;

  // Synthetic single-message input: the generator only reads the last user
  // message's text for the prompt (SDK keeps conversation context server-side).
  const runOptions = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
    ],
    abortSignal: abortController.signal,
    runConfig: effectiveRunConfig,
  } as unknown as ChatModelRunOptions;

  // run() is typed as Promise | AsyncGenerator (ChatModelAdapter union); our
  // implementation is always the generator.
  const stream = ClaudeAgentWSAdapter.run(runOptions) as AsyncGenerator<ChatModelRunResult>;

  try {
    for await (const chunk of stream) {
      useChatSessionStore.getState().updateMessageById(assistantId, {
        content: chunk.content as unknown as StoreContentPart[],
        status: chunk.status as StoreThreadMessage['status'],
      });
    }
  } catch (error) {
    console.error('[WS Adapter] runChat error:', error);
    useChatSessionStore.getState().updateMessageById(assistantId, {
      status: { type: 'incomplete', reason: 'error' },
    });
  } finally {
    if (activeRunAbort === abortController) {
      activeRunAbort = null;
    }
  }
}

/**
 * Cancel the in-flight turn: abort the local stream loop (immediate) and tell the
 * server to stop the worker. Wired to the composer Stop button / Esc.
 */
export function cancelActiveRun(): void {
  notifyUserAbort();
  activeRunAbort?.abort();
  abort();
}

/**
 * BUG-010 暂停后续跑/重发: re-run the turn that produced `assistantMessageId`
 * (typically one the user paused → status incomplete/cancelled, or one that
 * errored). Finds the nearest preceding USER message, drops the incomplete
 * assistant placeholder, and re-drives runChat with the SAME prompt — so the
 * user never has to copy the original text and resend it by hand. The SDK's
 * server-side conversation context (incl. any prior attachments) continues via
 * resume, so the plain prompt is enough.
 */
export async function regenerateAssistantMessage(assistantMessageId: string): Promise<void> {
  if (isQueryRunning) return; // don't stack a re-run on top of a live turn
  const store = useChatSessionStore.getState();
  const msgs = store.messages;
  const idx = msgs.findIndex((m) => m.id === assistantMessageId);
  if (idx < 0) return;

  let userText = '';
  for (let i = idx - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      userText = (msgs[i].content as StoreContentPart[])
        .filter((p): p is Extract<StoreContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      break;
    }
  }
  if (!userText.trim()) return;

  store.removeMessageById(assistantMessageId);
  await runChat(userText);
}

export default ClaudeAgentWSAdapter;
