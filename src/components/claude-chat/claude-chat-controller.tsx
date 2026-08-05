/**
 * Claude-Style Agent Chat Page
 *
 * A Claude.ai-inspired UI for the Claude Agent SDK.
 * Based on https://www.assistant-ui.com/examples/claude
 */

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useAssistantApi,
  useExternalStoreRuntime,
  useThread,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import * as Avatar from '@radix-ui/react-avatar';
import { LetterAvatar } from '~/components/ui/letter-avatar';
import {
  ClipboardIcon,
} from '@radix-ui/react-icons';
import { AuthLoading, RedirectToSignIn, SignedIn } from '@daveyplate/better-auth-ui';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useIntlayer } from 'react-intlayer';
import { useServerFn } from '@tanstack/react-start';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ThumbsDown, ThumbsUp, Layers, Paperclip, Plus, MessageSquare, Loader2, RotateCcw } from 'lucide-react';
import { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo, memo, type FC, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { StreamingMarkdown } from '~/components/claude-chat/streaming-markdown';
import { AssistantTurnCard } from '~/components/claude-chat/assistant-turn-card';
import { SessionList, useInvalidateSessions } from '~/components/claude-chat/session-list';
import { type SessionMetadata } from '~/components/claude-chat/session-info-panel';
import { ArtifactsPanel } from '~/components/claude-chat/artifacts-panel';
import { ArtifactButton } from '~/components/claude-chat/artifact-button';
import { InlineImagePreview } from '~/components/claude-chat/inline-image-preview';
import { InlineStatus, type AgentStatusType } from '~/components/claude-chat/claude-status';
import { MultiDiffPreviewOverlay, CodePreviewOverlay, type FileChange } from '~/components/claude-chat/overlay';
import { ImagePreviewOverlay } from '~/components/claude-chat/overlay/image-preview-overlay';
import { type PermissionInfo } from '~/components/claude-chat/permission-badge';
import { ChatComposerWithRef, type ChatComposerRef } from '~/components/claude-chat/chat-composer';
import { A2ComposerPanel } from '~/components/claude-chat/a2composer-panel';
import { SelectionChips } from '~/components/canvas/selection-chips';
import { ApprovalPrompt } from '~/components/claude-chat/approval-prompt';
import { WorkbenchDock, useWorkbenchAutoOpen } from '~/components/claude-chat/workbench-panel';
import { SkillChip } from '~/components/claude-chat/skill-chip';
import { cn, toLocalizedString } from '~/lib/utils';
import { parseSkillMarker } from '~/lib/skills/skill-marker';
import { useArtifactDetection } from '~/lib/hooks/use-artifact-detection';
import { usePreviewAutoRebuild } from '~/lib/hooks/use-preview-auto-rebuild';
import { useBeforeUnloadProtection, useReconnectionRecovery, useSessionSummaryOnLeave, fireSessionSummaryIfNeeded } from '~/lib/hooks/use-session-protection';
import { useArtifactsStore, type Artifact, type ArtifactImageFile } from '~/lib/stores/artifacts-store';
import { fetchArtifactRegistry, readWorkspaceFile, readWorkspaceBinaryFile, getMimeType } from '~/lib/artifacts/artifact-registry';
import { isImageFilePath } from '~/lib/artifacts/image-utils';
import { useMessageAttachments, type PendingAttachment } from '~/lib/utils/message-attachments';
import type { MessageAttachment } from '~/db/schema/message-attachment.schema';
// Use WebSocket adapter for more reliable real-time communication
import {
  runChat,
  cancelActiveRun,
  regenerateAssistantMessage,
  detachActiveRun,
  unsubscribeSession,
  getSessionId,
  resumeSession,
  newSession,
  createSession,
  initSession,
  onSessionInit,
  checkIsQueryRunning,
  notifyUserAbort,
} from '~/claude/adapters';
import {
  useChatSessionStore,
  onMessagesLoaded,
  type SDKMessage,
  type ThreadMessage,
  type TextContentPart,
  type ContentPart,
} from '~/lib/chat-session-store';
import { disableUserSkillsFn } from '~/server/function/skills.server';
import { assignSessionToProject } from '~/server/function/projects.server';
import { useSessionBranchInfo } from '~/lib/hooks/use-session-branch-info';
import { BranchReplyBanner, BranchedFromDivider } from '~/components/claude-chat/branch-indicators';
import {
  trackClaudeAgentSessionCreated,
  trackClaudeAgentSessionSwitched,
  trackClaudeChatViewChanged,
} from '~/lib/observability/posthog-events';

const MIN_ARTIFACT_SPLIT = 1 / 3;
const MAX_ARTIFACT_SPLIT = 2 / 3;

function genMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Map a store ThreadMessage to assistant-ui's ThreadMessageLike for the
 * externalStore runtime. We render the visible list ourselves from the store,
 * but the runtime still needs the converted messages for composer/scroll/empty
 * state. Custom part fields (toolStatus, isIntermediate, …) survive conversion
 * (fromThreadMessageLike spreads tool-call parts and returns text/reasoning as-is).
 */
function convertStoreMessage(message: ThreadMessage): ThreadMessageLike {
  // assistant-ui only accepts `status` on assistant messages — passing it on a
  // user/system message throws "status is only supported for assistant messages".
  return {
    role: message.role,
    content: message.content as unknown as ThreadMessageLike['content'],
    id: message.id,
    createdAt: message.createdAt,
    ...(message.role === 'assistant' && message.status
      ? { status: message.status as unknown as ThreadMessageLike['status'] }
      : {}),
  } as ThreadMessageLike;
}

/** Extract the typed text from an externalStore AppendMessage's content parts. */
function extractAppendText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

const clampSplitRatio = (value: number) =>
  Math.min(MAX_ARTIFACT_SPLIT, Math.max(MIN_ARTIFACT_SPLIT, value));

const useArtifactSplitRatio = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState(0.5);
  const [isResizing, setIsResizing] = useState(false);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  useEffect(() => {
    if (!isResizing || typeof window === 'undefined') return;

    const handleMove = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0) return;
      const nextRatio = (event.clientX - rect.left) / rect.width;
      setRatio(clampSplitRatio(nextRatio));
    };

    const handleUp = () => {
      setIsResizing(false);
    };

    const body = document.body;
    const prevUserSelect = body.style.userSelect;
    const prevCursor = body.style.cursor;
    body.style.userSelect = 'none';
    body.style.cursor = 'col-resize';

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      body.style.userSelect = prevUserSelect;
      body.style.cursor = prevCursor;
    };
  }, [isResizing]);

  return {
    containerRef,
    ratio,
    isResizing,
    startResize,
  };
};

// Context for sharing file/URL click handlers across message components
type FileHandlersContextType = {
  onFileClick: (path: string) => void; // For workspace files (artifact preview)
  onSessionFileClick: (path: string) => void; // P12: For session root files (SessionFilesPanel)
  onUrlClick: (url: string) => void;
};

const FileHandlersContext = createContext<FileHandlersContextType>({
  onFileClick: () => {},
  onSessionFileClick: () => {},
  onUrlClick: () => {},
});

const useFileHandlers = () => useContext(FileHandlersContext);

export interface ClaudeChatControllerProps {
  permissionInfo: PermissionInfo;
  /** Session to load on mount (sdkSessionId), from the URL. Null = use store / new. (Phase 1 hybrid bootstrap, P1d.) */
  urlSessionId?: string | null;
  /** Project context when this chat lives inside a Project (URL-driven). */
  projectId?: string | null;
  /** Canvas workspace context (Canvas Agent, D5 — mutually exclusive with projectId). */
  canvasId?: string | null;
  /** Render the controller's own SessionList rail. False when an outer rail is present (e.g. ProjectsRail). */
  showInternalSessionList?: boolean;
  /** New-chat landing (no urlSessionId yet): show a blank composer WITHOUT creating a
   *  session. The session is created lazily on the first send (the first real message
   *  doubles as the init turn), then onSessionInit mirrors the URL to /agents/c/$id
   *  (solo) or the project chat URL. (Phase 2 P1.5, lazy-create.) */
  newChat?: boolean;
}

/**
 * Chat surface controller — owns the session lifecycle (URL bootstrap / onSessionInit /
 * performSessionSwitch / reconnection / artifacts) and the chat UI. Reused by solo chat
 * routes (/agents/c*) and project chat routes (/agents/projects/$id/c*).
 * See docs/project/research/2026-06-09-projects-chat-nav-unification-plan.md (Phase 1, R2.5).
 */
export function ClaudeChatController({
  permissionInfo,
  urlSessionId = null,
  projectId: urlProjectId = null,
  canvasId = null,
  showInternalSessionList = true,
  newChat = false,
}: ClaudeChatControllerProps) {
  // Canvas Agent (D5): canvasId is only ever passed by the canvas route, so it doubles
  // as the "this is the narrow canvas sidebar, not a full-width chat page" signal —
  // no separate prop needed. Drives: hide WorkbenchDock (no room, not relevant),
  // hide the skill quick-suggestion pills (A2ComposerPanel), translucent composer.
  const canvasMode = !!canvasId;

  // Get i18n content - must be at top level before any returns
  const content = useIntlayer('claude-chat');

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const navigate = useNavigate();
  // Synchronous mirror of the active session id (Codex Q-C). Written BEFORE navigate in
  // onSessionInit so the URL bootstrap never re-switches a freshly-initialized / streaming
  // session, regardless of React-state/store/navigate timing.
  const currentSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);
  // Auto-open the workbench to Progress/Sub-agents when they appear (always-mounted
  // here — the workbench panel itself only mounts when open).
  useWorkbenchAutoOpen();
  // Key to force re-mount of chat surface when session changes
  const [chatKey, setChatKey] = useState(0);
  // Session list expand/collapse state
  const [sessionListExpanded, setSessionListExpanded] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('sessionListExpanded');
      return saved ? JSON.parse(saved) : false;
    }
    return false;
  });
  // Track if a session is being created (loading state)
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  // BUG-009: 当落地页就有 urlSessionId（点对话/外链/刷新），首屏要立刻进入 loading 占位，
  // 不能让 ThreadPrimitive.Empty 在 bootstrap effect 跑前抢先露脸（New Chat 空态白屏闪）。
  const [isInitializingSession, setIsInitializingSession] = useState(() => Boolean(urlSessionId));

  // Query to check if user has any historical sessions
  const { data: sessionsData, isLoading: sessionsLoading } = useQuery<{
    sessions: Array<{ id: string; sdkSessionId: string }>;
  }>({
    queryKey: ['agent-sessions', 'summary'],
    queryFn: async () => {
      const res = await fetch('/api/agent-sessions?limit=1');
      if (!res.ok) {
        throw new Error('Failed to fetch sessions');
      }
      return res.json();
    },
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  const hasAnySessions = (sessionsData?.sessions?.length ?? 0) > 0;
  const isSessionsEmpty = !sessionsLoading && !hasAnySessions;

  // Save session list expanded state
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('sessionListExpanded', JSON.stringify(sessionListExpanded));
    }
  }, [sessionListExpanded]);

  const { loadHistoricalMessages, clearMessages, setSessionId, temporarySkills, clearTemporarySkills } = useChatSessionStore();
  const disableUserSkills = useServerFn(disableUserSkillsFn);
  const invalidateSessions = useInvalidateSessions();
  // Projects P1: bind a freshly-created session to the Project armed by "new chat in <project>".
  const assignToProject = useServerFn(assignSessionToProject);
  const projectQueryClient = useQueryClient();

  // Artifacts state - controls layout behavior
  const activeArtifactId = useArtifactsStore((state) => state.activeArtifactId);
  const setActiveArtifact = useArtifactsStore((state) => state.setActiveArtifact);
  const {
    containerRef: artifactSplitRef,
    ratio: artifactSplitRatio,
    isResizing: isArtifactSplitResizing,
    startResize: handleArtifactSplitResize,
  } = useArtifactSplitRatio();

  // BUG-009: settle timer for session switch loading state. Tracked in a ref so a
  // rapid second switch can cancel the prior timer (otherwise the old timer fires
  // mid-new-switch and clears the spinner before the new history arrives).
  const switchSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armSwitchSettleTimer = useCallback(() => {
    if (switchSettleTimerRef.current) clearTimeout(switchSettleTimerRef.current);
    switchSettleTimerRef.current = setTimeout(() => {
      switchSettleTimerRef.current = null;
      setIsInitializingSession(false);
    }, 3000);
  }, []);
  const clearSwitchSettleTimer = useCallback(() => {
    if (switchSettleTimerRef.current) {
      clearTimeout(switchSettleTimerRef.current);
      switchSettleTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => clearSwitchSettleTimer(), [clearSwitchSettleTimer]);

  // Listen for messages loaded events from WebSocket
  // Note: We do NOT increment chatKey here because that would cause
  // the component to remount, which triggers abort on any running query
  useEffect(() => {
    const unsubscribe = onMessagesLoaded((messages: SDKMessage[]) => {
      console.log('[Route] Received messages_loaded callback with', messages.length, 'messages');
      loadHistoricalMessages(messages);
      // BUG-009: 历史灌回 store 后再关掉切换 loading，避免 messages_loaded 抵达前 spinner
      // 提前消失露出 New Chat 空态。createSession 路径自己管理 init 标志，关一下也无副作用。
      if (switchSettleTimerRef.current) {
        clearTimeout(switchSettleTimerRef.current);
        switchSettleTimerRef.current = null;
      }
      setIsInitializingSession(false);
      // Historical messages are stored in zustand and rendered separately,
      // no need to remount the component
    });

    return unsubscribe;
  }, [loadHistoricalMessages]);

  // Sync with adapter's session ID on mount, and re-hydrate history.
  // The adapter keeps the session id across SPA navigation (module-level), but the
  // assistant-ui thread is ephemeral and resets when this route remounts (e.g. after
  // navigating to the Capability Center and back). So on mount, if a session was
  // already active, resume it to reload the conversation — otherwise the user returns
  // to an empty page even though the session is still "selected".
  useEffect(() => {
    // URL deep-link wins (Phase 1 hybrid bootstrap): when a session is addressed via the URL,
    // the bootstrap effect below loads it — skip this store-based mount resume to avoid a
    // double load (Codex landmine #1). Phase 2: a new-chat landing (newChat) also skips it,
    // so the store's last session isn't resumed while the arm creates a fresh one.
    if (urlSessionId || newChat) return;
    // Arriving from "new chat in <project>": don't resume the previous session — the
    // arm effect below creates a fresh session and binds it to the armed Project.
    if (useChatSessionStore.getState().pendingProjectId) return;
    const sessionId = getSessionId();
    if (sessionId) {
      setCurrentSessionId(sessionId);
      setSessionId(sessionId);
      if (!checkIsQueryRunning()) {
        // BUG-009: 同样要避开 clearMessages → messages_loaded 之间的白屏闪 New Chat。
        // onMessagesLoaded 监听器会在历史抵达后关掉这个标志；空历史会话 server 不发
        // messages_loaded，靠这个 settleTimer 兜底关 spinner。
        setIsInitializingSession(true);
        clearMessages();
        armSwitchSettleTimer();
        resumeSession(sessionId).catch((error) => {
          console.error('[Route] Failed to resume restored session on mount:', error);
          clearSwitchSettleTimer();
          setIsInitializingSession(false);
        });
      }
    }
    // Run once on mount; setSessionId/clearMessages are stable store actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSessionId, clearMessages]);

  // Listen for session init events to keep route state in sync with adapter
  useEffect(() => {
    const unsubscribe = onSessionInit((sessionId: string) => {
      console.log('[Route] Session initialized, updating state:', sessionId);
      // Codex Q-C: write the synchronous ref BEFORE navigate, so the URL bootstrap effect's
      // already-current guard sees this session and never re-switches (clearing) a
      // freshly-initialized / streaming session (landmine #2).
      currentSessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);
      setSessionId(sessionId);
      // Invalidate sessions list to refresh titles (especially for new sessions)
      invalidateSessions();
      // Projects C#2 (Codex Q2): also refresh project session lists so a freshly-branched
      // D2 (or a new project chat) appears in its project's Chats tab without a manual reload.
      projectQueryClient.invalidateQueries({ queryKey: ['project-sessions'] });
      // Mirror the active session into the URL (deep-linkable, Phase 2 = URL is the truth).
      // In a project → project-chat URL; solo → /agents/c/$id. `replace` so it doesn't spam history.
      // Canvas (D5): stays on /agents/canvas/$canvasId — no per-session sub-route in this
      // slice (one ambient session per workspace), so skip navigation entirely rather than
      // falling through to the solo /agents/c/$id branch (which would navigate AWAY from
      // the canvas page).
      if (canvasId) {
        // no-op: session tracked in store, URL doesn't need to change
      } else if (urlProjectId) {
        navigate({
          to: '/agents/projects/$projectId/c/$sessionId',
          params: { projectId: urlProjectId, sessionId },
          replace: true,
        });
      } else {
        navigate({ to: '/agents/c/$sessionId', params: { sessionId }, replace: true });
      }
    });
    return unsubscribe;
  }, [setSessionId, invalidateSessions, projectQueryClient, navigate, urlProjectId, canvasId]);

  // Handle WebSocket reconnection - resume current session if any
  useReconnectionRecovery(useCallback(() => {
    const sessionToResume = currentSessionId;
    if (sessionToResume) {
      console.log('[Route] WebSocket reconnected, resuming session:', sessionToResume);
      // Clear messages and reload from server
      clearMessages();
      resumeSession(sessionToResume).catch((error) => {
        console.error('[Route] Failed to resume session after reconnection:', error);
      });
    } else {
      console.log('[Route] WebSocket reconnected, no active session to resume');
    }
  }, [currentSessionId, clearMessages]));

  // Hydrate artifacts from registry when session changes
  useEffect(() => {
    if (!currentSessionId) {
      return;
    }

    useArtifactsStore.getState().clearAll();

    let isCancelled = false;
    const run = async () => {
      try {
        await hydrateArtifactsFromRegistry(currentSessionId);
      } catch (error) {
        if (!isCancelled) {
          console.error('[Route] Failed to hydrate artifacts:', error);
        }
      }
    };

    run();

    return () => {
      isCancelled = true;
    };
  }, [currentSessionId]);

  // Perform the actual session switch (after confirmation or if no query running)
  const performSessionSwitch = useCallback(async (sdkSessionId: string | null, isNewSession: boolean) => {
    // Concurrent sessions (FR1): leaving a running session must NOT kill its backend
    // worker — it continues in the background and we reconnect on switch-back (FR5).
    // Detach the local run (stop driving its stream; the worker lives on) and stop
    // the server fanning its frames to us. Replaces the old abort()-on-switch.
    const leavingSessionId = getSessionId();
    detachActiveRun();
    if (leavingSessionId && leavingSessionId !== sdkSessionId) {
      unsubscribeSession(leavingSessionId);
    }
    fireSessionSummaryIfNeeded();
    if (temporarySkills.length > 0) {
      try {
        await disableUserSkills({ data: { skillNames: temporarySkills } });
      } catch (error) {
        console.warn('[Route] Failed to disable temporary skills:', error);
      }
      clearTemporarySkills();
    }
    if (isNewSession) {
      console.log('[Route] Creating new session explicitly');
      setIsCreatingSession(true);
      setIsInitializingSession(true);
      setCurrentSessionId(null);
      setSessionId(null);
      clearMessages();
      try {
        // Capture the armed Project BEFORE the async create so a remount/unmount-clear
        // can't lose it mid-flight, and pass it into create_session so ws-server binds
        // the session to the Project at creation time (race-free).
        // Project chat page: the URL's project wins so a "new chat" here is bound to THIS
        // project at creation (Codex) — avoids a loose session whose URL is later mirrored to a
        // project path (fake binding). Loose "new chat in <project>" still uses the arm.
        const armedProjectId = urlProjectId ?? useChatSessionStore.getState().pendingProjectId;
        const newSessionId = await createSession(armedProjectId ?? undefined, canvasId ?? undefined);
        console.log('[Route] New session created:', newSessionId);
        setCurrentSessionId(newSessionId);
        setSessionId(newSessionId);
        setChatKey((k) => k + 1);
        await initSession(newSessionId);
        trackClaudeAgentSessionCreated({ sessionId: newSessionId });

        // Fallback bind (idempotent): ensures the link even if the create-time bind was
        // skipped; a failure degrades gracefully to a loose chat.
        if (armedProjectId) {
          try {
            await assignToProject({ data: { sdkSessionId: newSessionId, projectId: armedProjectId } });
            projectQueryClient.invalidateQueries({ queryKey: ['project-sessions', armedProjectId] });
          } catch (bindError) {
            console.warn('[Route] Failed to bind new session to project:', bindError);
          } finally {
            useChatSessionStore.getState().setPendingProjectId(undefined);
          }
        }
      } catch (error) {
        console.error('[Route] Failed to create session:', error);
      } finally {
        setIsCreatingSession(false);
        setIsInitializingSession(false);
      }
    } else if (sdkSessionId) {
      console.log('[Route] Selecting session:', sdkSessionId);
      // BUG-009 白屏闪根治：切到已有会话时，clearMessages → resumeSession(异步等服务器
      // messages_loaded) 之间 ~1s 空窗，hasHistoricalMessages=false 会命中 ThreadPrimitive.Empty
      // 露出和 New Chat 一样的空态，让用户误以为对话被清空了。改用 isInitializingSession 占位
      // (loading spinner)，等 messages_loaded 把历史灌回 store 后再关掉。Empty 分支同时被该
      // 标志关掉（见 ClaudeChatSurface viewport 渲染条件）。
      setIsInitializingSession(true);
      setCurrentSessionId(sdkSessionId);
      setSessionId(sdkSessionId);
      clearMessages();
      setChatKey((k) => k + 1);
      // 兜底：空历史会话 server 不会发 messages_loaded（见 ws-server.mjs:2085 length>0 分支），
      // 仅靠监听器关 spinner 会卡死。3s 后强制关，用户看到的是真正的空会话/空状态而不是死转。
      armSwitchSettleTimer();
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await resumeSession(sdkSessionId);
        trackClaudeAgentSessionSwitched({ sessionId: sdkSessionId, isResume: true });
      } catch (error) {
        console.error('[Route] Failed to resume session:', error);
        clearSwitchSettleTimer();
        setIsInitializingSession(false);
      }
      // 不在这里 finally 关 spinner —— 让 onMessagesLoaded 或 settleTimer 来负责，
      // 否则 send 一返回就关，反而把 ~1s 空窗暴露出来回到 BUG-009 原态。
    }
  }, [setSessionId, clearMessages, temporarySkills, clearTemporarySkills, disableUserSkills, assignToProject, projectQueryClient, urlProjectId, armSwitchSettleTimer, clearSwitchSettleTimer]);

  const handleSelectSession = useCallback(async (sdkSessionId: string) => {
    // Check both route state and adapter state for current session
    // This prevents abort during active query when user clicks on current session
    const adapterSessionId = getSessionId();
    const isSameSession = sdkSessionId === currentSessionId || sdkSessionId === adapterSessionId;
    if (isSameSession) {
      const hasMessages = useChatSessionStore.getState().messages.length > 0;
      if (!hasMessages) {
        console.log('[Route] Session active but empty, forcing resume:', sdkSessionId);
        await performSessionSwitch(sdkSessionId, false);
      } else {
        console.log('[Route] Session already active, skipping:', sdkSessionId);
        // BUG-009: 已经是当前会话且历史已在 store —— 立刻清掉首屏预先开启的 init 占位，
        // 否则用户重复点同一会话或 URL bootstrap 命中早已加载的会话时 spinner 会卡住。
        setIsInitializingSession(false);
      }
      return;
    }

    // Concurrent sessions: switch directly even if a query is running. The old
    // session keeps running in the background (performSessionSwitch detaches the
    // local run without killing the worker); no interrupt dialog.
    await performSessionSwitch(sdkSessionId, false);
  }, [currentSessionId, performSessionSwitch]);

  const handleNewSession = useCallback(() => {
    // Lazy newChat landing with no session yet: this IS already a blank new chat — an
    // explicit "new chat" click must not eagerly create the very session lazy-create avoids.
    if (newChat && !currentSessionIdRef.current && !getSessionId()) {
      console.log('[Route] Already on a blank new chat, skipping create');
      return;
    }
    // Concurrent sessions: open a new chat directly even while a query runs; the
    // running session continues in the background (no interrupt dialog).
    performSessionSwitch(null, true);
  }, [performSessionSwitch, newChat]);

  // Hybrid URL bootstrap (Phase 1, Codex Q2/Q-C): when a session is addressed via the URL,
  // load it ONCE. Reuses handleSelectSession (honors a running query → confirmation, and skips
  // if already active). The ref/store guard means an onSessionInit→navigate (e.g. a fresh branch
  // D2) is recognized as already-current and never re-switched/cleared. Client-only; the SSR
  // loader never resumes (landmine #5).
  useEffect(() => {
    if (typeof window === 'undefined' || !urlSessionId) return;
    if (urlSessionId === currentSessionIdRef.current || urlSessionId === getSessionId()) {
      // Session already loaded (e.g. onSessionInit→navigate from a fresh branch / new send):
      // we pre-armed isInitializingSession on mount to suppress the New Chat empty flash, but
      // there's no work to do here so clear it now (handleSelectSession won't run).
      setIsInitializingSession(false);
      return;
    }
    void handleSelectSession(urlSessionId);
    // One-time URL gate keyed on urlSessionId; handleSelectSession is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSessionId]);

  // Phase 2 P1.5 (lazy-create): a new-chat landing shows a blank composer WITHOUT creating
  // a session — no DB row, no init model call on login/Header/marketing-CTA landings. The
  // session is created on the first send (ensureSessionForSend below). On mount we only
  // reset leftover chat state: the previous session survives SPA navigation in the
  // module-level adapter + store, and without this reset the first send would land in it.
  const newChatResetRef = useRef(false);
  useEffect(() => {
    if (!newChat || newChatResetRef.current) return;
    newChatResetRef.current = true;
    // Concurrent sessions: a previous turn still streaming when we land on a blank
    // new chat no longer interrupts it — detach the local run (the worker continues
    // in the background, FR1) and stop its fan-out, then reset to the blank composer.
    const leavingSessionId = getSessionId();
    detachActiveRun();
    if (leavingSessionId) unsubscribeSession(leavingSessionId);
    fireSessionSummaryIfNeeded();
    const { temporarySkills: leftoverTempSkills } = useChatSessionStore.getState();
    if (leftoverTempSkills.length > 0) {
      disableUserSkills({ data: { skillNames: leftoverTempSkills } }).catch((error) => {
        console.warn('[Route] Failed to disable temporary skills:', error);
      });
      clearTemporarySkills();
    }
    newSession();
    setCurrentSessionId(null);
    setSessionId(null);
    clearMessages();
    // pendingProjectId stays armed: the first send's create consumes it, and the unmount
    // cleanup below clears it if the user leaves without sending.
    // Run once per mount; store actions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newChat]);

  // Lazy-create (Phase 2 P1.5): create the session at FIRST SEND on a new-chat landing.
  // The first real message doubles as the init turn — ws-server's `chat` and `init_session`
  // share handleChat, and a real run emits system.init → sessionMetadata — so no separate
  // 1-char init call. create_session{projectId} binds the Project at creation (race-free);
  // onSessionInit (above) then mirrors the URL. The route remount that navigate triggers is
  // safe mid-stream: the run loop, session id and message store all live at module level.
  const pendingLazyCreateRef = useRef<Promise<string> | null>(null);
  const ensureSessionForSend = useCallback(async () => {
    if (!newChat) return;
    if (currentSessionIdRef.current || getSessionId()) return;
    if (!pendingLazyCreateRef.current) {
      const creating = (async () => {
        // Capture the armed Project BEFORE the async create so a remount/unmount-clear
        // can't lose it mid-flight. The URL's project wins; loose arm is the fallback.
        const armedProjectId = urlProjectId ?? useChatSessionStore.getState().pendingProjectId;
        const newSessionId = await createSession(armedProjectId ?? undefined, canvasId ?? undefined);
        trackClaudeAgentSessionCreated({ sessionId: newSessionId });
        // Fallback bind (idempotent), same as the eager path: ensures the link even if the
        // create-time bind was skipped; a failure degrades gracefully to a loose chat.
        if (armedProjectId) {
          try {
            await assignToProject({ data: { sdkSessionId: newSessionId, projectId: armedProjectId } });
            projectQueryClient.invalidateQueries({ queryKey: ['project-sessions', armedProjectId] });
          } catch (bindError) {
            console.warn('[Route] Failed to bind new session to project:', bindError);
          } finally {
            useChatSessionStore.getState().setPendingProjectId(undefined);
          }
        }
        return newSessionId;
      })();
      pendingLazyCreateRef.current = creating;
      // Clear once settled: success short-circuits via getSessionId() on the next send,
      // failure stays retriable. Swallow here only — callers still see the rejection.
      creating.catch(() => {}).finally(() => {
        if (pendingLazyCreateRef.current === creating) pendingLazyCreateRef.current = null;
      });
    }
    await pendingLazyCreateRef.current;
  }, [newChat, urlProjectId, assignToProject, projectQueryClient]);

  // Clear an un-consumed arm on unmount so a stale pendingProjectId can't hijack the
  // next chat open (e.g. armed "new chat in X" then navigated away mid-create).
  useEffect(() => {
    return () => {
      const store = useChatSessionStore.getState();
      if (store.pendingProjectId) store.setPendingProjectId(undefined);
    };
  }, []);

  // (Concurrent sessions: the interrupt/cancel session-switch dialog is gone —
  // switching no longer stops the running session, so there's nothing to confirm.)

  const isDev = process.env.NODE_ENV !== 'production';

  // Empty state: no sessions at all, show big "Start New Session" button.
  // A lazy new-chat landing skips it — the blank composer IS the start-a-chat surface.
  if (isSessionsEmpty && !currentSessionId && !newChat) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <MessageSquare className="h-8 w-8 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h1 className="font-serif text-2xl font-semibold tracking-tight text-foreground">
              {content.emptyState.title}
            </h1>
            <p className="text-muted-foreground max-w-md">
              {content.emptyState.subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={handleNewSession}
            disabled={isCreatingSession}
            className="flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-primary-foreground font-medium transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreatingSession ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>{content.buttons.loading}</span>
              </>
            ) : (
              <>
                <Plus className="h-5 w-5" />
                <span>{content.emptyState.startChat}</span>
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // Dev mode: skip client-side auth check
  if (isDev) {
    const chatPanel = (
      <>
        <ClaudeChatSurface
          key={chatKey}
          permissionInfo={permissionInfo}
          hasSession={!!currentSessionId || newChat}
          isInitializingSession={isInitializingSession}
          onStartSession={handleNewSession}
          isCreatingSession={isCreatingSession}
          hideScrollbars={Boolean(activeArtifactId)}
          newChat={newChat}
          ensureSession={ensureSessionForSend}
          canvasMode={canvasMode}
        />
      </>
    );

    return (
      <div className="h-full">
        <div className={cn('flex h-full', activeArtifactId && 'group')} ref={artifactSplitRef}>
          {/* Session List — hidden when an outer rail (ProjectsRail) is present. */}
          {!activeArtifactId && showInternalSessionList && (
            <SessionList
              currentSessionId={currentSessionId}
              onSelectSession={handleSelectSession}
              onNewSession={handleNewSession}
              isExpanded={sessionListExpanded}
              onToggleExpanded={() => setSessionListExpanded(!sessionListExpanded)}
            />
          )}

          {/* Chat Surface - always mounted, width changes based on artifact state.
              min-w-0 + overflow-hidden: without them a flex child's min-content size
              (e.g. the composer's max-w-3xl) can force this wider than the space
              actually available — invisible on a full-width page, but bleeds into
              a narrow sidebar (canvas mode) since nothing was there to clip it. */}
          <div
            className="h-full shrink-0 relative min-w-0 overflow-hidden"
            style={{ flexBasis: 0, flexGrow: activeArtifactId ? artifactSplitRatio : 1 }}
          >
            {chatPanel}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={handleArtifactSplitResize}
            className={cn(
              'relative z-10 w-2 shrink-0 cursor-col-resize touch-none transition-opacity',
              activeArtifactId
                ? isArtifactSplitResizing
                  ? 'opacity-100 pointer-events-auto'
                  : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
                : 'opacity-0 pointer-events-none'
            )}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
          </div>
          {activeArtifactId ? (
            <div
              className="h-full shrink-0 overflow-hidden border-l"
              style={{ flexBasis: 0, flexGrow: 1 - artifactSplitRatio, maxWidth: 'none' }}
            >
              <ArtifactsPanel
                artifactId={activeArtifactId}
                onClose={() => setActiveArtifact(null)}
              />
            </div>
          ) : !canvasMode ? (
            <WorkbenchDock currentSessionId={currentSessionId} />
          ) : null}
        </div>

      </div>
    );
  }

  // Production: use full auth flow
  return (
    <div className="h-full">
      <AuthLoading>
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {content.auth.checkingSession}
        </div>
      </AuthLoading>

      <RedirectToSignIn />

      <SignedIn>
        {/* Empty state: no sessions at all, show big "Start New Session" button.
            A lazy new-chat landing skips it — the blank composer IS the start surface. */}
        {isSessionsEmpty && !currentSessionId && !newChat ? (
          <EmptyStateContent
            isCreatingSession={isCreatingSession}
            onNewSession={handleNewSession}
          />
        ) : (
          <>
            <MainContent
              activeArtifactId={activeArtifactId}
              artifactSplitRef={artifactSplitRef}
              artifactSplitRatio={artifactSplitRatio}
              isArtifactSplitResizing={isArtifactSplitResizing}
              onArtifactSplitResize={handleArtifactSplitResize}
              hasAnySessions={hasAnySessions}
              sessionListExpanded={sessionListExpanded}
              currentSessionId={currentSessionId}
              setActiveArtifact={setActiveArtifact}
              setSessionListExpanded={setSessionListExpanded}
              handleSelectSession={handleSelectSession}
              handleNewSession={handleNewSession}
              chatKey={chatKey}
              permissionInfo={permissionInfo}
              isInitializingSession={isInitializingSession}
              isCreatingSession={isCreatingSession}
              showInternalSessionList={showInternalSessionList}
              newChat={newChat}
              ensureSession={ensureSessionForSend}
              canvasMode={canvasMode}
            />
          </>
        )}
      </SignedIn>
    </div>
  );
}

/**
 * Empty State Content Component
 * Reusable empty state for when no sessions exist
 */
const EmptyStateContent: FC<{
  isCreatingSession: boolean;
  onNewSession: () => void;
}> = ({ isCreatingSession, onNewSession }) => {
  const content = useIntlayer('claude-chat');
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-foreground">
            {content.emptyState.title}
          </h1>
          <p className="text-muted-foreground max-w-md">
            {content.emptyState.subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={onNewSession}
          disabled={isCreatingSession}
          className="flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-primary-foreground font-medium transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isCreatingSession ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>{content.buttons.loading}</span>
            </>
          ) : (
            <>
              <Plus className="h-5 w-5" />
              <span>{content.emptyState.startChat}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};

/**
 * Main Content Component
 * Reusable main content area with session list, chat surface, and artifacts panel
 */
const MainContent: FC<{
  activeArtifactId: string | null;
  artifactSplitRef: MutableRefObject<HTMLDivElement | null>;
  artifactSplitRatio: number;
  isArtifactSplitResizing: boolean;
  onArtifactSplitResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  hasAnySessions: boolean;
  sessionListExpanded: boolean;
  currentSessionId: string | null;
  setActiveArtifact: (id: string | null) => void;
  setSessionListExpanded: (value: boolean) => void;
  handleSelectSession: (sdkSessionId: string) => void;
  handleNewSession: () => void;
  chatKey: number;
  permissionInfo: PermissionInfo;
  isInitializingSession: boolean;
  isCreatingSession: boolean;
  showInternalSessionList: boolean;
  newChat: boolean;
  ensureSession: () => Promise<void>;
  canvasMode: boolean;
}> = ({
  activeArtifactId,
  artifactSplitRef,
  artifactSplitRatio,
  isArtifactSplitResizing,
  onArtifactSplitResize,
  hasAnySessions,
  sessionListExpanded,
  currentSessionId,
  setActiveArtifact,
  setSessionListExpanded,
  handleSelectSession,
  handleNewSession,
  chatKey,
  permissionInfo,
  isInitializingSession,
  isCreatingSession,
  showInternalSessionList,
  newChat,
  ensureSession,
  canvasMode,
}) => {
  const content = useIntlayer('claude-chat');
  const chatPanel = (
    <>
      <ClaudeChatSurface
        key={chatKey}
        permissionInfo={permissionInfo}
        hasSession={true}
        isInitializingSession={isInitializingSession}
        onStartSession={handleNewSession}
        isCreatingSession={isCreatingSession}
        hideScrollbars={Boolean(activeArtifactId)}
        newChat={newChat}
        ensureSession={ensureSession}
        canvasMode={canvasMode}
      />
    </>
  );

  return (
    <>
      <div className={cn('flex h-full', activeArtifactId && 'group')} ref={artifactSplitRef}>
        {/* Session List — hidden when an outer rail (ProjectsRail) is present. */}
        {!activeArtifactId && showInternalSessionList && (
          <SessionList
            currentSessionId={currentSessionId}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            isExpanded={sessionListExpanded}
            onToggleExpanded={() => setSessionListExpanded(!sessionListExpanded)}
          />
        )}

        {/* Chat Surface - always mounted, width changes based on artifact state.
            min-w-0 + overflow-hidden: see the isDev branch's identical comment above —
            without them, a flex child's min-content size can force this wider than
            the space actually available (invisible full-width, bleeds in a sidebar). */}
        <div
          className="h-full shrink-0 relative min-w-0 overflow-hidden"
          style={{ flexBasis: 0, flexGrow: activeArtifactId ? artifactSplitRatio : 1 }}
        >
          {chatPanel}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onArtifactSplitResize}
          className={cn(
            'relative z-10 w-2 shrink-0 cursor-col-resize touch-none transition-opacity',
            activeArtifactId
              ? isArtifactSplitResizing
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
              : 'opacity-0 pointer-events-none'
          )}
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
        </div>
        {activeArtifactId ? (
          <div
            className="h-full shrink-0 overflow-hidden border-l"
            style={{ flexBasis: 0, flexGrow: 1 - artifactSplitRatio, maxWidth: 'none' }}
          >
            <ArtifactsPanel
              artifactId={activeArtifactId}
              onClose={() => setActiveArtifact(null)}
            />
          </div>
        ) : !canvasMode ? (
          <WorkbenchDock currentSessionId={currentSessionId} />
        ) : null}
      </div>
    </>
  );
};

async function hydrateArtifactsFromRegistry(sessionId: string) {
  const registry = await fetchArtifactRegistry(sessionId);
  if (registry.length === 0) {
    return;
  }

  const {
    createArtifact,
    updateArtifact,
    getArtifactByFilePath,
  } = useArtifactsStore.getState();

  const imageEntries = registry.filter((entry) => entry.type === 'image');
  const otherEntries = registry.filter((entry) => entry.type !== 'image');

  if (imageEntries.length > 0) {
    const grouped = new Map<string, typeof imageEntries>();

    for (const entry of imageEntries) {
      const key = entry.toolCallId
        ? `tool:${entry.toolCallId}`
        : entry.messageId
          ? `msg:${entry.messageId}`
          : `file:${entry.filePath}`;
      const existing = grouped.get(key) ?? [];
      existing.push(entry);
      grouped.set(key, existing);
    }

    for (const groupEntries of grouped.values()) {
      const imageFiles = (await Promise.all(
        groupEntries.map(async (entry) => {
          const mimeType = getMimeType(entry.filePath);
          const content = await readWorkspaceBinaryFile(sessionId, entry.filePath, mimeType);
          if (!content) return null;
          return { filePath: entry.filePath, content, mimeType };
        })
      ))
        .filter(Boolean) as Array<{ filePath: string; content: string; mimeType?: string }>;

      if (imageFiles.length === 0) {
        continue;
      }

      const primary = imageFiles[0];
      const existing = getArtifactByFilePath(sessionId, primary.filePath);
      const fileName = groupEntries[0]?.fileName || primary.filePath.split('/').pop() || primary.filePath;
      const lineageData = {
        toolCallId: groupEntries[0]?.toolCallId,
        toolName: groupEntries[0]?.toolName,
      };

      if (existing) {
        updateArtifact(existing.id, {
          content: primary.content,
          type: 'image',
          title: groupEntries[0]?.title,
          description: groupEntries[0]?.description,
          fileName,
          messageId: groupEntries[0]?.messageId,
          sourceFilePath: primary.filePath,
          sessionId,
          isTemporary: false,
          mimeType: primary.mimeType,
          imageFiles,
          ...lineageData,
        });
      } else {
        createArtifact({
          sessionId,
          sourceFilePath: primary.filePath,
          messageId: groupEntries[0]?.messageId,
          type: 'image',
          title: groupEntries[0]?.title,
          description: groupEntries[0]?.description,
          fileName,
          content: primary.content,
          isTemporary: false,
          mimeType: primary.mimeType,
          imageFiles,
          ...lineageData,
        });
      }
    }
  }

  for (const entry of otherEntries) {
    // P15 fix: Use binary reading for images to avoid corruption
    let content: string | null = null;
    let mimeType: string | undefined;

    if (entry.type === 'image') {
      mimeType = getMimeType(entry.filePath);
      content = await readWorkspaceBinaryFile(sessionId, entry.filePath, mimeType);
    } else {
      content = await readWorkspaceFile(sessionId, entry.filePath);
    }

    if (!content) {
      continue;
    }

    const existing = getArtifactByFilePath(sessionId, entry.filePath);
    const fileName = entry.fileName || entry.filePath.split('/').pop() || entry.filePath;

    // P14: Include lineage info from registry
    const lineageData = {
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
    };

    if (existing) {
      updateArtifact(existing.id, {
        content,
        type: entry.type,
        title: entry.title,
        description: entry.description,
        fileName,
        messageId: entry.messageId,
        sourceFilePath: entry.filePath,
        sessionId,
        isTemporary: false,
        mimeType, // P15: Include mimeType for images
        ...lineageData, // P14: Restore lineage
      });
    } else {
      createArtifact({
        sessionId,
        sourceFilePath: entry.filePath,
        messageId: entry.messageId,
        type: entry.type,
        title: entry.title,
        description: entry.description,
        fileName,
        content,
        isTemporary: false,
        mimeType, // P15: Include mimeType for images
        ...lineageData, // P14: Restore lineage
      });
    }
  }
}

function ClaudeChatSurface({
  permissionInfo,
  hasSession,
  isInitializingSession,
  onStartSession,
  isCreatingSession,
  hideScrollbars = false,
  newChat = false,
  ensureSession,
  canvasMode = false,
}: {
  permissionInfo: PermissionInfo;
  hasSession: boolean;
  isInitializingSession: boolean;
  onStartSession?: () => void;
  isCreatingSession?: boolean;
  hideScrollbars?: boolean;
  /** Lazy new-chat landing: composer is live before any session exists. */
  newChat?: boolean;
  /** Lazy-create hook: called before running a send so the first message creates the session. */
  ensureSession?: () => Promise<void>;
  /** Canvas Agent (D5): narrow sidebar next to the canvas, not a full-width page —
   *  hides the skill quick-suggestion pills (not relevant) and gives the composer a
   *  translucent/floating-over-canvas treatment instead of a hard opaque block. */
  canvasMode?: boolean;
}) {
  const content = useIntlayer('claude-chat');

  // Single ordered message source: the zustand store. The externalStore runtime
  // reads it for composer/scroll/empty/running state; the visible list is rendered
  // directly from `messages` below (see Cowork redesign spec §2 — one source feeds
  // both the left thread and the right Workbench).
  const messages = useChatSessionStore((state) => state.messages);
  const isThreadRunning = useChatSessionStore((state) => state.isRunning);
  const hasHistoricalMessages = messages.length > 0;

  // Conversation-search deep link (?m=<messageUuid>): after the transcript loads
  // (messages_loaded → the target id appears in `messages`), scroll to its DOM anchor and
  // briefly highlight it. NOT on mount — resume is async, the list is empty until the
  // messages_loaded callback returns. Re-runs only when the target or the message set changes.
  const deepLinkSearch = useSearch({ strict: false }) as { m?: string };
  const targetMessageId = deepLinkSearch?.m ?? null;
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const scrolledForTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!targetMessageId) {
      scrolledForTargetRef.current = null;
      return;
    }
    if (scrolledForTargetRef.current === targetMessageId) return;
    if (!messages.some((m) => m.id === targetMessageId)) return; // wait for messages_loaded
    scrolledForTargetRef.current = targetMessageId;
    const el = typeof document !== 'undefined' ? document.getElementById(`msg-${targetMessageId}`) : null;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightedMessageId(targetMessageId);
    const timer = setTimeout(() => setHighlightedMessageId(null), 2200);
    return () => clearTimeout(timer);
  }, [targetMessageId, messages]);

  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages,
    isRunning: isThreadRunning,
    convertMessage: convertStoreMessage,
    onNew: async (message) => {
      const text = extractAppendText(message.content as readonly { type: string; text?: string }[]);
      if (!text.trim()) return;
      // Add the user message to the single store source, then stream the agent
      // turn into it (runChat creates + grows the assistant message).
      useChatSessionStore.getState().addMessage({
        id: genMessageId(),
        role: 'user',
        content: [{ type: 'text', text }],
        createdAt: new Date(),
        status: { type: 'complete' },
      });
      // Lazy-create (Phase 2 P1.5): on a new-chat landing no session exists yet — create
      // it now so this first message rides the normal run path (and doubles as init).
      // The store message above survives the create + URL-mirror remount (global store).
      if (ensureSession) {
        try {
          await ensureSession();
        } catch (error) {
          console.error('[Route] Failed to create session for first send:', error);
          useChatSessionStore.getState().addMessage({
            id: genMessageId(),
            role: 'assistant',
            content: [],
            createdAt: new Date(),
            status: { type: 'incomplete', reason: 'error' },
          });
          return;
        }
      }
      await runChat(text, { runConfig: message.runConfig });
    },
    onCancel: async () => {
      cancelActiveRun();
    },
  });

  // Session info panel state
  const [showSessionInfo, setShowSessionInfo] = useState(false);
  const sessionMetadata = useChatSessionStore((state) => state.sessionMetadata);

  // Workspace panel state (session-level, persists across messages)
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [showSessionFiles, setShowSessionFiles] = useState(false);
  const currentSessionId = useChatSessionStore((state) => state.currentSessionId);
  // Projects C#2: branch-on-reply affordances. isViewingNonOwned → "reply will branch"
  // banner; branchedFrom → "从 <源> 建立的分支" indicator. permissionInfo.userId = me.
  const branchInfo = useSessionBranchInfo(currentSessionId, permissionInfo.userId ?? null);
  const pendingArmedSkill = useChatSessionStore((state) => state.pendingArmedSkill);
  const setPendingArmedSkill = useChatSessionStore((state) => state.setPendingArmedSkill);
  const { loadSessionAttachments } = useMessageAttachments();
  const [attachmentsByMessage, setAttachmentsByMessage] = useState<Map<string, MessageAttachment[]>>(
    new Map()
  );

  // When a turn finishes that edited app source, auto force-rebuild the running
  // preview (build mode has no HMR). No-op unless a preview is currently ready.
  usePreviewAutoRebuild();

  // Global file preview state
  const [filePreview, setFilePreview] = useState<{
    isOpen: boolean;
    content: string;
    filePath: string;
    error?: string;
    isLoading: boolean;
  }>({ isOpen: false, content: '', filePath: '', isLoading: false });
  const [imagePreview, setImagePreview] = useState<{
    isOpen: boolean;
    isLoading: boolean;
    title?: string;
    error?: string;
    images: ArtifactImageFile[];
  }>({ isOpen: false, isLoading: false, images: [] });

  useEffect(() => {
    let isCancelled = false;

    if (!currentSessionId) {
      setAttachmentsByMessage(new Map());
      return;
    }

    loadSessionAttachments(currentSessionId).then((result) => {
      if (!isCancelled) {
        setAttachmentsByMessage(result);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [currentSessionId, loadSessionAttachments]);

  // Refresh the attachment map after the composer persists a new message's
  // attachments — otherwise the file chip only appears after a session switch.
  const reloadAttachments = useCallback(() => {
    if (!currentSessionId) return;
    loadSessionAttachments(currentSessionId).then(setAttachmentsByMessage);
  }, [currentSessionId, loadSessionAttachments]);

  const openWorkspaceImagePreview = useCallback(async (paths: string[], title?: string) => {
    if (!currentSessionId) {
      setImagePreview({
        isOpen: true,
        isLoading: false,
        images: [],
        title,
        error: content.errors.noSession,
      });
      return;
    }

    setFilePreview((prev) => ({ ...prev, isOpen: false }));
    setImagePreview({
      isOpen: true,
      isLoading: true,
      images: [],
      title,
    });

    try {
      const images = (await Promise.all(
        paths.map(async (path) => {
          const mimeType = getMimeType(path);
          const content = await readWorkspaceBinaryFile(currentSessionId, path, mimeType);
          if (!content) return null;
          return { filePath: path, content, mimeType };
        })
      ))
        .filter(Boolean) as ArtifactImageFile[];

      setImagePreview({
        isOpen: true,
        isLoading: false,
        images,
        title,
        error: images.length === 0
          ? toLocalizedString(content.errors.fileNotFound).replace('{path}', paths[0] || '')
          : undefined,
      });
    } catch (error) {
      setImagePreview({
        isOpen: true,
        isLoading: false,
        images: [],
        title,
        error: error instanceof Error ? error.message : content.errors.readFailed,
      });
    }
  }, [content, currentSessionId]);

  const openSessionImagePreview = useCallback(async (path: string, title?: string) => {
    if (!currentSessionId) {
      setImagePreview({
        isOpen: true,
        isLoading: false,
        images: [],
        title,
        error: content.errors.noSession,
      });
      return;
    }

    setFilePreview((prev) => ({ ...prev, isOpen: false }));
    setImagePreview({
      isOpen: true,
      isLoading: true,
      images: [],
      title,
    });

    try {
      const encodedPath = path.split('/').map((s) => encodeURIComponent(s)).join('/');
      const response = await fetch(`/api/session/${currentSessionId}/file/${encodedPath}`);
      if (!response.ok) {
        throw new Error(`Failed to read file: ${response.statusText}`);
      }
      const data = await response.json();
      const contentValue = typeof data.content === 'string' ? data.content : '';
      const mimeType = typeof data.mimeType === 'string' ? data.mimeType : getMimeType(path);

      if (!contentValue) {
        setImagePreview({
          isOpen: true,
          isLoading: false,
          images: [],
          title,
          error: toLocalizedString(content.errors.fileNotFound).replace('{path}', path),
        });
        return;
      }

      setImagePreview({
        isOpen: true,
        isLoading: false,
        images: [{ filePath: path, content: contentValue, mimeType }],
        title,
      });
    } catch (error) {
      setImagePreview({
        isOpen: true,
        isLoading: false,
        images: [],
        title,
        error: error instanceof Error ? error.message : content.errors.readFailed,
      });
    }
  }, [content, currentSessionId]);

  // Handler for file path clicks - fetches file content and opens overlay
  const handleFileClick = useCallback(async (path: string) => {
    if (!currentSessionId) {
      console.warn('[Route] No session ID, cannot read file:', path);
      setFilePreview({
        isOpen: true,
        content: '',
        filePath: path,
        error: content.errors.noSession,
        isLoading: false,
      });
      return;
    }

    if (isImageFilePath(path)) {
      await openWorkspaceImagePreview([path], path.split('/').pop() || path);
      return;
    }

    // Show loading state
    setFilePreview({
      isOpen: true,
      content: '',
      filePath: path,
      isLoading: true,
    });

    try {
      console.log('[Route] Reading workspace file:', path);
      const fileContent = await readWorkspaceFile(currentSessionId, path);
      if (fileContent === null) {
        setFilePreview({
          isOpen: true,
          content: '',
          filePath: path,
          error: toLocalizedString(content.errors.fileNotFound).replace('{path}', path),
          isLoading: false,
        });
      } else {
        setFilePreview({
          isOpen: true,
          content: fileContent,
          filePath: path,
          isLoading: false,
        });
      }
    } catch (error) {
      console.error('[Route] Failed to read file:', path, error);
      setFilePreview({
        isOpen: true,
        content: '',
        filePath: path,
        error: error instanceof Error ? error.message : content.errors.readFailed,
        isLoading: false,
      });
    }
  }, [currentSessionId, content, openWorkspaceImagePreview]);

  // Handler for session file clicks - uses session API (for files in session root, not just workspace/)
  // P12 fix: Session files panel uses this for browsing entire session directory
  const handleSessionFileClick = useCallback(async (path: string) => {
    if (!currentSessionId) {
      console.warn('[Route] No session ID, cannot read file:', path);
      setFilePreview({
        isOpen: true,
        content: '',
        filePath: path,
        error: content.errors.noSession,
        isLoading: false,
      });
      return;
    }

    if (isImageFilePath(path)) {
      await openSessionImagePreview(path, path.split('/').pop() || path);
      return;
    }

    // Show loading state
    setFilePreview({
      isOpen: true,
      content: '',
      filePath: path,
      isLoading: true,
    });

    try {
      console.log('[Route] Reading session file:', path);
      // Use session API - handles both text and binary files correctly
      const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
      const response = await fetch(`/api/session/${currentSessionId}/file/${encodedPath}`);
      if (!response.ok) {
        throw new Error(`Failed to read file: ${response.statusText}`);
      }
      const data = await response.json();
      const contentValue = typeof data.content === 'string' ? data.content : '';
      setFilePreview({
        isOpen: true,
        content: contentValue,
        filePath: path,
        isLoading: false,
      });
    } catch (error) {
      console.error('[Route] Failed to read session file:', path, error);
      setFilePreview({
        isOpen: true,
        content: '',
        filePath: path,
        error: error instanceof Error ? error.message : content.errors.readFailed,
        isLoading: false,
      });
    }
  }, [currentSessionId, content, openSessionImagePreview]);

  // Handler for URL clicks
  const handleUrlClick = useCallback((url: string) => {
    console.log('[Route] URL clicked:', url);
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  // Session protection: warn before closing page during active query
  useBeforeUnloadProtection();
  // PostHog: 离开页面时上报 session 汇总
  useSessionSummaryOnLeave();

  // Esc interrupt state
  const [escPressedOnce, setEscPressedOnce] = useState(false);
  const escTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerRef = useRef<ChatComposerRef | null>(null);
  const [composerText, setComposerText] = useState('');
  const [isA2ComposerOpen, setIsA2ComposerOpen] = useState(false);
  const [isSkillsPanelOpen, setIsSkillsPanelOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<{ slug: string; name?: string; hint?: string } | null>(null);

  // A2ComposerPanel reset handler
  const [a2ComposerKey, setA2ComposerKey] = useState(0);
  const handleA2ComposerReset = useCallback(() => {
    // Force remount to reset state
    setA2ComposerKey((k) => k + 1);
  }, []);

  const handleSetComposerText = useCallback((text: string) => {
    composerRef.current?.setText(text);
    composerRef.current?.focus();
  }, []);

  // Arm the skill stashed by A2Composer's "open new chat & load" once the freshly-
  // created session is ready (the just-enabled skill is now loaded + active). On a lazy
  // new-chat landing there's no session yet — arm immediately: the skill marker travels
  // with the first send, and that send's create syncs the just-enabled skill server-side.
  useEffect(() => {
    if ((currentSessionId || newChat) && !isInitializingSession && pendingArmedSkill) {
      setSelectedSkill(pendingArmedSkill);
      setPendingArmedSkill(undefined);
    }
  }, [currentSessionId, newChat, isInitializingSession, pendingArmedSkill, setPendingArmedSkill]);

  const handleSelectSkill = useCallback((skill: { slug: string; name?: string; hint?: string }) => {
    setSelectedSkill(skill);
  }, []);

  const handleClearSelectedSkill = useCallback(() => {
    setSelectedSkill(null);
  }, []);

  // Handle message send - reset A2ComposerPanel
  const handleComposerSend = useCallback(() => {
    // Reset panel to minimized state after send
    handleA2ComposerReset();
  }, [handleA2ComposerReset]);

  const handleA2ComposerOpenChange = useCallback((open: boolean) => {
    setIsA2ComposerOpen(open);
    if (open) {
      setIsSkillsPanelOpen(false);
    }
  }, []);

  const handleSkillsOpenChange = useCallback((open: boolean) => {
    setIsSkillsPanelOpen(open);
  }, []);

  // PostHog: 主视图变化埋点
  const viewRef = useRef<string>('chat');
  useEffect(() => {
    const view = showWorkspace
      ? 'workspace'
      : showSessionFiles
        ? 'documents'
        : showSessionInfo
          ? 'session_info'
          : isSkillsPanelOpen
            ? 'skills'
            : 'chat';
    if (view !== viewRef.current) {
      trackClaudeChatViewChanged({
        view,
        previousView: viewRef.current,
        sessionId: currentSessionId ?? undefined,
      });
      viewRef.current = view;
    }
  }, [showWorkspace, showSessionFiles, showSessionInfo, isSkillsPanelOpen, currentSessionId]);

  useEffect(() => {
    setSelectedSkill(null);
  }, [currentSessionId]);


  return (
    <FileHandlersContext.Provider value={{ onFileClick: handleFileClick, onSessionFileClick: handleSessionFileClick, onUrlClick: handleUrlClick }}>
      <div className="flex h-full flex-col">
        <AssistantRuntimeProvider runtime={runtime}>
          <EscapeInterruptHandler
            escPressedOnce={escPressedOnce}
            setEscPressedOnce={setEscPressedOnce}
            escTimeoutRef={escTimeoutRef}
          />
          <ThreadPrimitive.Root
            className={cn(
              'flex h-full flex-col items-stretch p-4 pt-16 font-sans',
              canvasMode ? 'bg-background/90 backdrop-blur-sm' : 'bg-background'
            )}
          >
            <ThreadPrimitive.Viewport
              className={cn(
                'flex-1 min-h-0 overflow-y-auto',
                hideScrollbars && 'scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none]'
              )}
            >
              {/* Show empty state only when no historical messages and not initializing */}
              {!hasHistoricalMessages && !isInitializingSession && (
                <ThreadPrimitive.Empty>
                  <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                    <div className="font-serif text-4xl font-semibold tracking-tight text-foreground">
                      {content.emptyState.title}
                    </div>
                    <p className="max-w-md text-muted-foreground">
                      {content.emptyState.subtitle}
                    </p>
                    {!hasSession && onStartSession && (
                      <button
                        type="button"
                        onClick={onStartSession}
                        disabled={isCreatingSession}
                        className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isCreatingSession ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span>{content.buttons.loading}</span>
                          </>
                        ) : (
                          <>
                            <Plus className="h-4 w-4" />
                            <span>{content.emptyState.startChat}</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </ThreadPrimitive.Empty>
              )}

              {isInitializingSession && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-base font-medium text-foreground">{content.status.initializing}</div>
                    <div className="text-xs text-muted-foreground">{content.status.pleaseWait}</div>
                  </div>
                </div>
              )}

              {/* Projects C#2: a branched session shows "从 <源> 建立的分支" before its
                  thread. v1 places it at the top; precise fork-point placement (图2) needs
                  forkedFrom plumbed through the message pipeline (open Codex item). */}
              {branchInfo.branchedFrom && (
                <BranchedFromDivider sourceTitle={branchInfo.branchedFrom.title} className="mb-2" />
              )}

              {/* Single source: render the whole thread (historical + live) from
                  the store via one renderer. The streaming turn updates in place
                  as runChat() patches its message; no separate runtime message list. */}
              {messages.map((msg, msgIndex) => {
                // Per-message author avatars only matter when a thread has more than one
                // human (a branch, or you viewing someone else's session). For your own
                // solo chat, keep the plain "U" (authorName stays null).
                const showAuthors = !!branchInfo.sourceOwner || branchInfo.isViewingNonOwned;
                const author = showAuthors && msg.role === 'user'
                  ? (msg.isInherited ? branchInfo.sourceOwner : branchInfo.owner)
                  : null;
                return (
                  <div
                    key={msg.id}
                    id={`msg-${msg.id}`}
                    data-message-id={msg.id}
                    className={
                      highlightedMessageId === msg.id
                        ? 'rounded-xl bg-primary/5 transition-colors duration-700'
                        : 'transition-colors duration-700'
                    }
                  >
                    <HistoricalMessage
                      message={msg}
                      attachments={attachmentsByMessage.get(msg.id)}
                      sessionId={currentSessionId}
                      authorName={author?.name ?? null}
                      authorImage={author?.image ?? null}
                      isLast={msgIndex === messages.length - 1}
                    />
                  </div>
                );
              })}

              <div aria-hidden="true" className="h-4" />
            </ThreadPrimitive.Viewport>

            {/* Only show Composer when session exists */}
            {hasSession && !isInitializingSession && (
              <>
                {/* Ask-mode HITL: tool-approval prompts above the composer */}
                <ApprovalPrompt />
                {/* Canvas mode (D5): skill quick-suggestion pills aren't relevant to a
                    canvas workflow (image/video generation, not code skills) — skip. */}
                {!canvasMode && (
                  <div className={`mb-3 ${isSkillsPanelOpen ? 'hidden' : ''}`}>
                    <A2ComposerPanel
                      key={a2ComposerKey}
                      composerText={composerText}
                      onSetComposerText={handleSetComposerText}
                      onReset={handleA2ComposerReset}
                      onOpenChange={handleA2ComposerOpenChange}
                      onSkillSelect={handleSelectSkill}
                      onOpenNewConversation={onStartSession}
                    />
                  </div>
                )}

                {/* Projects C#2 (图1): viewing a session you don't own → replying branches. */}
                {branchInfo.isViewingNonOwned && <BranchReplyBanner className="mb-2" />}

                {/* Canvas Agent (D5/F10.2): selected-asset chips, self-contained (reads
                    canvasStore directly — see selection-chips.tsx). */}
                {canvasMode && <SelectionChips />}

                <ChatComposerWithRef
                  composerRef={composerRef}
                  permissionInfo={permissionInfo}
                  currentSessionId={currentSessionId}
                  ensureSession={ensureSession}
                  showWorkspace={showWorkspace}
                  setShowWorkspace={setShowWorkspace}
                  showSessionFiles={showSessionFiles}
                  setShowSessionFiles={setShowSessionFiles}
                  showSessionInfo={showSessionInfo}
                  setShowSessionInfo={setShowSessionInfo}
                  sessionMetadata={sessionMetadata}
                  onSessionFileClick={handleSessionFileClick}
                  onAbort={notifyUserAbort}
                  onTextChange={setComposerText}
                  onSend={handleComposerSend}
                  hideSkillsTrigger={isA2ComposerOpen}
                  onSkillsOpenChange={handleSkillsOpenChange}
                  selectedSkill={selectedSkill}
                  onClearSelectedSkill={handleClearSelectedSkill}
                  onSkillSelect={handleSelectSkill}
                  onAttachmentsPersisted={reloadAttachments}
                  canvasMode={canvasMode}
                />
              </>
            )}
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>

        {/* Global file preview overlay */}
        <CodePreviewOverlay
          isOpen={filePreview.isOpen}
          onClose={() => setFilePreview(prev => ({ ...prev, isOpen: false }))}
          content={filePreview.isLoading ? content.buttons.loading : filePreview.content}
          filePath={filePreview.filePath}
          error={filePreview.error}
        />
        <ImagePreviewOverlay
          isOpen={imagePreview.isOpen}
          onClose={() => setImagePreview(prev => ({ ...prev, isOpen: false }))}
          images={imagePreview.images}
          isLoading={imagePreview.isLoading}
          error={imagePreview.error}
          title={imagePreview.title}
        />

        {/* Esc interrupt overlay */}
        {escPressedOnce && (
          <div className="fixed inset-x-0 top-4 z-50 flex justify-center pointer-events-none animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="rounded-lg bg-card px-4 py-2 text-sm text-white shadow-lg">
              {content.status.escInterrupt}
            </div>
          </div>
        )}
      </div>
    </FileHandlersContext.Provider>
  );
}

/**
 * Escape Interrupt Handler
 * Handles Esc key press for two-step interrupt confirmation
 * Must be used inside AssistantRuntimeProvider
 */
const EscapeInterruptHandler: FC<{
  escPressedOnce: boolean;
  setEscPressedOnce: (value: boolean) => void;
  escTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
}> = ({ escPressedOnce, setEscPressedOnce, escTimeoutRef }) => {
  const isRunning = useThread((state) => state.isRunning);
  const api = useAssistantApi();

  useEffect(() => {
    if (!isRunning) {
      // Reset state when not running
      setEscPressedOnce(false);
      if (escTimeoutRef.current) {
        clearTimeout(escTimeoutRef.current);
        escTimeoutRef.current = null;
      }
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore repeated key events and already prevented events
      if (event.repeat || event.defaultPrevented) return;

      // Only handle Escape key
      if (event.key !== 'Escape') return;

      // Prevent default behavior
      event.preventDefault();

      if (escPressedOnce) {
        // Second Esc press - actually cancel
        console.log('[EscapeInterrupt] Second Esc pressed, cancelling...');
        setEscPressedOnce(false);
        if (escTimeoutRef.current) {
          clearTimeout(escTimeoutRef.current);
          escTimeoutRef.current = null;
        }
        notifyUserAbort();
        api.composer().cancel();
      } else {
        // First Esc press - show hint
        console.log('[EscapeInterrupt] First Esc pressed, showing hint...');
        setEscPressedOnce(true);

        // Auto-dismiss after 2 seconds
        if (escTimeoutRef.current) {
          clearTimeout(escTimeoutRef.current);
        }
        escTimeoutRef.current = setTimeout(() => {
          setEscPressedOnce(false);
          escTimeoutRef.current = null;
        }, 2000);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isRunning, escPressedOnce, setEscPressedOnce, escTimeoutRef, api]);

  return null;
};

const getInlineImageFiles = (artifact: Artifact | null | undefined): ArtifactImageFile[] => {
  if (!artifact || artifact.type !== 'image') return [];
  if (artifact.imageFiles && artifact.imageFiles.length > 0) return artifact.imageFiles;
  if (!artifact.content) return [];
  const filePath = artifact.sourceFilePath || artifact.fileName || 'image';
  return [{ filePath, content: artifact.content, mimeType: artifact.mimeType }];
};


// File handlers are now provided via FileHandlersContext from ClaudeChatSurface

/**
 * Extract file changes from message content for multi-diff overlay
 */
function extractFileChanges(content: ContentPart[], messageId: string): FileChange[] {
  const changes: FileChange[] = [];
  let changeIndex = 0;

  for (const part of content) {
    if (part.type !== 'tool-call') continue;

    const toolName = part.toolName?.toLowerCase() ?? '';
    const args = part.args as Record<string, unknown> | undefined;

    if (toolName === 'edit' && args?.old_string !== undefined && args?.new_string !== undefined) {
      changes.push({
        id: `${messageId}-${changeIndex++}`,
        filePath: String(args.file_path ?? 'unknown'),
        toolType: 'Edit',
        original: String(args.old_string),
        modified: String(args.new_string),
        error: part.isError ? String(part.result ?? 'Error') : undefined,
      });
    } else if (toolName === 'write' && args?.content !== undefined) {
      changes.push({
        id: `${messageId}-${changeIndex++}`,
        filePath: String(args.file_path ?? 'unknown'),
        toolType: 'Write',
        original: '',
        modified: String(args.content),
        error: part.isError ? String(part.result ?? 'Error') : undefined,
      });
    }
  }

  return changes;
}

function getMessageTextContent(parts?: ContentPart[]): string {
  if (!parts || parts.length === 0) return '';
  return parts
    .filter((part): part is TextContentPart =>
      part.type === 'text' && Boolean(part.text) && !part.isIntermediate && !part.isPending
    )
    .map((part) => part.text)
    .join('\n');
}

const IMAGE_ATTACHMENT_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;

function encodeWorkspacePath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildWorkspaceRawUrl(sessionId: string, filePath: string): string {
  return `/api/workspace/${sessionId}/file/${encodeWorkspacePath(filePath)}?raw=1`;
}

function isImageAttachment(attachment: MessageAttachment): boolean {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return IMAGE_ATTACHMENT_EXTENSIONS.test(attachment.filePath);
}

function isTextAttachment(attachment: MessageAttachment): boolean {
  if (!attachment.mimeType) return false;
  return (
    attachment.mimeType.startsWith('text/') ||
    attachment.mimeType === 'application/json' ||
    attachment.mimeType === 'application/xml'
  );
}

const HistoricalAttachmentStrip: FC<{
  attachments: MessageAttachment[];
  sessionId: string;
  onFileClick: (path: string) => void;
}> = ({ attachments, sessionId, onFileClick }) => {
  if (attachments.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const isImage = isImageAttachment(attachment);
        const rawUrl = buildWorkspaceRawUrl(sessionId, attachment.filePath);
        const displayName = attachment.originalName || attachment.filePath;
        const handleClick = () => {
          if (isImage) {
            window.open(rawUrl, '_blank', 'noopener,noreferrer');
            return;
          }
          if (isTextAttachment(attachment)) {
            onFileClick(attachment.filePath);
            return;
          }
          window.open(rawUrl, '_blank', 'noopener,noreferrer');
        };

        if (isImage) {
          return (
            <button
              key={attachment.id}
              type="button"
              onClick={handleClick}
              className="overflow-hidden rounded-lg border bg-card shadow-sm transition hover:shadow-md"
              title={displayName}
            >
              <img
                src={rawUrl}
                alt={displayName}
                className="h-16 w-16 object-cover"
              />
            </button>
          );
        }

        return (
          <button
            key={attachment.id}
            type="button"
            onClick={handleClick}
            className="flex items-center gap-2 rounded-lg border bg-card/70 px-2.5 py-1 text-xs text-foreground shadow-sm transition hover:bg-card"
            title={displayName}
          >
            <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="max-w-[16rem] truncate">{displayName}</span>
          </button>
        );
      })}
    </div>
  );
};

/**
 * Live "thinking / using tool" indicator for the in-flight turn. Subscribes to
 * the frequently-changing agentStatus/currentToolName so ONLY this leaf re-renders
 * on each status tick — keeping the memoized turn rows from re-rendering.
 */
const LiveTurnIndicator: FC = () => {
  const agentStatus = useChatSessionStore((state) => state.agentStatus);
  const currentToolName = useChatSessionStore((state) => state.currentToolName);
  return <InlineStatus status={agentStatus as AgentStatusType} toolName={currentToolName} />;
};

/**
 * Turn renderer — the single source of truth for BOTH historical and live turns
 * (Cowork redesign spec §4). Reads the store ThreadMessage directly (all custom
 * part fields preserved) and feeds AssistantTurnCard, which streams + collapses
 * on done via `status`. Memoized so a live turn's per-chunk updates don't
 * re-render already-completed turns.
 */
const HistoricalMessageImpl: FC<{
  message: ThreadMessage;
  attachments?: MessageAttachment[];
  sessionId: string | null;
  /** Author of this user turn (name + avatar). In a 续聊即分支 thread, inherited turns
   *  carry the source owner, the rest carry the current owner — so A's and B's messages
   *  show distinct avatars. Null → fall back to the generic "U". */
  authorName?: string | null;
  authorImage?: string | null;
  /** Is this the last message in the thread? Gates the BUG-010 resume affordance. */
  isLast?: boolean;
}> = ({ message, attachments, sessionId, authorName, authorImage, isLast }) => {
  // Get i18n content
  const content = useIntlayer('claude-chat');

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const messageAttachments = attachments ?? [];
  const showAttachments = Boolean(sessionId && messageAttachments.length > 0);

  // Get file handlers from context
  const { onFileClick, onUrlClick } = useFileHandlers();

  // State for multi-diff overlay
  const [showMultiDiff, setShowMultiDiff] = useState(false);

  // Get text content for user messages
  const textContent = message.content
    .filter((p): p is TextContentPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const parsedSkill = useMemo(() => parseSkillMarker(textContent), [textContent]);

  // Artifact detection for assistant messages - pass full content array to support both text and tool-call detection
  const artifact = useArtifactDetection(message.id, isAssistant ? message.content : undefined);
  const setActiveArtifact = useArtifactsStore((state) => state.setActiveArtifact);
  const inlineImageFiles = useMemo(() => getInlineImageFiles(artifact), [artifact]);

  // Extract file changes for multi-diff overlay (only for assistant messages)
  const fileChanges = useMemo(() => {
    if (!isAssistant) return [];
    return extractFileChanges(message.content, message.id);
  }, [isAssistant, message.content, message.id]);

  // Filter to only successful changes for multi-diff display
  const successfulChanges = useMemo(() => fileChanges.filter(c => !c.error), [fileChanges]);
  const hasMultipleFileChanges = successfulChanges.length > 1;
  const finalText = useMemo(
    () => getMessageTextContent(message.content as ContentPart[]),
    [message.content]
  );
  const hasFinalResponse = Boolean(finalText?.trim());

  // Live turn: while the agent is streaming this message, show the thinking/tool
  // indicator until the first content part arrives (AssistantTurnCard takes over
  // once there are activities or response text).
  const isRunning = message.status?.type === 'running';
  const hasContent = message.content.length > 0;
  // BUG-010: this assistant turn was paused (or errored) and is the tail of the
  // thread → offer a one-click resume that re-runs the original prompt.
  const canResume = isAssistant && !!isLast && message.status?.type === 'incomplete';

  if (isUser) {
    // User message
    return (
      <div className="group relative mx-auto mt-1 mb-1 block w-full max-w-3xl">
        <div className="group/user wrap-break-word relative inline-flex max-w-[75ch] flex-col gap-2 rounded-xl bg-muted py-2.5 pr-6 pl-2.5 text-foreground transition-all">
          <div className="relative flex flex-row items-center gap-2">
            <div className="shrink-0 transition-all duration-300" title={authorName ?? undefined}>
              {authorName ? (
                // Per-message author (续聊即分支): inherited turns show the source owner,
                // the rest show the current owner — colored per name so A ≠ B at a glance.
                <LetterAvatar
                  name={authorName}
                  iconUrl={authorImage ?? undefined}
                  size="sm"
                  className="!size-7 !rounded-full"
                />
              ) : (
                <Avatar.Root className="flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full bg-primary font-bold text-[12px] text-primary-foreground">
                  <Avatar.AvatarFallback>U</Avatar.AvatarFallback>
                </Avatar.Root>
              )}
            </div>
            <div className="flex-1">
              <div className="relative grid grid-cols-1 gap-2 py-0.5">
                {showAttachments && sessionId && (
                  <HistoricalAttachmentStrip
                    attachments={messageAttachments}
                    sessionId={sessionId}
                    onFileClick={onFileClick}
                  />
                )}
                {parsedSkill.marker && (
                  <div className="flex flex-wrap items-center gap-2">
                    <SkillChip label={parsedSkill.marker.name ?? parsedSkill.marker.slug} />
                  </div>
                )}
                <div className="wrap-break-word whitespace-normal">
                  <StreamingMarkdown
                    content={parsedSkill.strippedText}
                    isStreaming={false}
                    mode="minimal"
                    onUrlClick={onUrlClick}
                    onFileClick={onFileClick}
                  />
                </div>
              </div>
            </div>
          </div>
          {/* ActionBar for user messages - copy only (no edit/reload for historical) */}
          <div className="pointer-events-none absolute right-2 bottom-0">
            <div className="pointer-events-auto min-w-max translate-x-1 translate-y-4 rounded-lg border bg-card/80 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition group-hover/user:translate-x-0.5 group-hover/user:opacity-100">
              <div className="flex items-center text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(parsedSkill.strippedText)}
                    className="flex h-8 w-8 items-center justify-center rounded-md transition duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] hover:bg-accent active:scale-95"
                    aria-label={toLocalizedString(content.message.copy)}
                  >
                    <ClipboardIcon width={20} height={20} />
                  </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isAssistant) {
    // Assistant message - rendered directly from the store (single source);
    // `status` drives AssistantTurnCard's live streaming + collapse-on-done.
    return (
      <div className="group relative mx-auto mt-1 mb-1 block w-full max-w-3xl">
        <div className={cn('relative font-sans', hasFinalResponse ? 'mb-12' : 'mb-4')}>
          <div className="relative leading-[1.65rem]">
            <div className="grid grid-cols-1 gap-2.5">
              <div className="wrap-break-word whitespace-normal pr-8 pl-2 text-foreground">
                {isRunning && !hasContent && (
                  <div className="mb-3">
                    <LiveTurnIndicator />
                  </div>
                )}
                <AssistantTurnCard
                  status={message.status}
                  content={message.content as ContentPart[]}
                  onUrlClick={onUrlClick}
                  onFileClick={onFileClick}
                />

                {inlineImageFiles.length > 0 && (
                  <InlineImagePreview
                    images={inlineImageFiles}
                    title={artifact?.fileName || artifact?.title}
                  />
                )}

                {/* Artifact Button — one deliverable card per turn, with the real file
                    name / title. Gated on !isRunning so the "打开成果物 / 运行预览" card only
                    appears once the WHOLE turn is done — not mid-build (a half-written
                    multi-file app would preview broken + waste a build). Live writes still
                    show in the turn-card's activity stream during the turn. */}
                {artifact && artifact.type !== 'image' && !isRunning && (
                  <div className="mt-3">
                    <ArtifactButton
                      type={artifact.type}
                      title={artifact.title}
                      fileName={artifact.fileName}
                      filePath={artifact.sourceFilePath}
                      isTemporary={artifact.isTemporary}
                      onClick={() => setActiveArtifact(artifact.id)}
                    />
                  </div>
                )}

                {/* Multi-diff aggregation button */}
                {hasMultipleFileChanges && (
                  <button
                    type="button"
                    onClick={() => setShowMultiDiff(true)}
                    className="mt-3 flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/70 dark:border-border dark:bg-muted dark:text-muted-foreground dark:hover:bg-muted/70"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    <span>{toLocalizedString(content.actions.viewFileChanges).replace('{count}', String(successfulChanges.length))}</span>
                  </button>
                )}

                {/* BUG-010 暂停后续跑: re-run the paused/failed turn from the original
                    prompt — no manual copy-paste. */}
                {canResume && (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void regenerateAssistantMessage(message.id)}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>重新生成</span>
                    </button>
                    <span className="text-xs text-muted-foreground">已暂停 · 点此基于原消息继续</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* ActionBar - copy/feedback only */}
          {hasFinalResponse && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0">
              <div className="pointer-events-auto flex w-full translate-y-full flex-col items-end px-2 pt-2 transition">
                <div className="relative flex items-center text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => {
                      const allText = message.content
                        .filter((p): p is TextContentPart => p.type === 'text')
                        .map((p) => p.text)
                        .join('\n');
                      navigator.clipboard.writeText(allText);
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-md transition duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] hover:bg-transparent active:scale-95"
                    aria-label={toLocalizedString(content.message.copy)}
                  >
                    <ClipboardIcon width={20} height={20} />
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md transition duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] hover:bg-transparent active:scale-95"
                    aria-label={toLocalizedString(content.actions.helpful)}
                  >
                    <ThumbsUp width={16} height={16} />
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md transition duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] hover:bg-transparent active:scale-95"
                    aria-label={toLocalizedString(content.actions.notHelpful)}
                  >
                    <ThumbsDown width={16} height={16} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Multi-diff overlay */}
        <MultiDiffPreviewOverlay
          isOpen={showMultiDiff}
          onClose={() => setShowMultiDiff(false)}
          changes={successfulChanges}
        />
      </div>
    );
  }

  return null;
};

const HistoricalMessage = memo(HistoricalMessageImpl);
