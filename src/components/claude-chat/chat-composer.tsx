/**
 * ChatComposer Component
 *
 * Extracted from route.tsx for better modularity and future A2Composer integration.
 * Uses Assistant-UI's ComposerPrimitive + useComposer for state management.
 *
 * ## v0.1 Scope
 * - Component extraction only (no composer-form yet)
 * - Template insertion via exposed ref methods
 * - All existing logic preserved
 *
 * ## External Control Interface
 * ```tsx
 * const composerRef = useRef<ChatComposerRef>(null);
 *
 * // Insert text at cursor or append
 * composerRef.current?.setText("Hello world");
 *
 * // Programmatically send
 * composerRef.current?.send();
 * ```
 *
 * @see src/components/claude-chat/claude-chat-controller.tsx for controller integration
 */

import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useAssistantApi,
  useAssistantState,
  useThread,
} from '@assistant-ui/react';
import {
  Cross2Icon,
  InfoCircledIcon,
  ReloadIcon,
} from '@radix-ui/react-icons';
import { FolderOpen, FolderTree, Plus, ArrowUpIcon, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState, useRef, useImperativeHandle } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent, FormEvent, MutableRefObject } from 'react';
import { ContextBadges } from './context-badges';
import { SkillChip } from './skill-chip';
import { KnowledgeBasePanel } from './knowledge-base-panel';
import { useWorkbenchUI } from '~/lib/stores/workbench-ui-store';
import { type SessionMetadata } from './session-info-panel';
import { type PermissionInfo } from './permission-badge';
import { PermissionTierSelector } from './permission-tier-selector';
import { ModelPicker } from './model-picker';
import { ToolbarStatus, type AgentStatusType } from './claude-status';
import { McpStatusIndicator } from './mcp-status-indicator';
import { useIntlayer } from 'react-intlayer';
import { cn, toLocalizedString } from '~/lib/utils';
import { useMessageAttachments, type PendingAttachment } from '~/lib/utils/message-attachments';
import { useWorkspaceUploads, type UploadItem } from '~/lib/hooks/use-workspace-uploads';
import { formatBytes } from '~/lib/upload-limits';
import { useChatSessionStore } from '~/lib/chat-session-store';
import { useDraftAutoSave } from '~/lib/hooks/use-session-protection';
import { buildSkillMarker, injectSkillMarker } from '~/lib/skills/skill-marker';
import { stagePendingAttachments, stagePendingCanvasRefs, type CanvasRefDescriptor } from '~/claude/adapters';
import { trackClaudeAgentQuerySent } from '~/lib/observability/posthog-events';
import { useCanvasStore } from '~/components/canvas/canvas-store';

/**
 * Props for ChatComposer component
 */
export interface ChatComposerProps {
  /** Session permission info */
  permissionInfo: PermissionInfo;
  /** Current session ID (null = no active session) */
  currentSessionId: string | null;
  /** Lazily create the session (new-chat landing creates nothing until needed). Lets the
   *  upload/KB/files buttons work BEFORE the first message: click → create → proceed. */
  ensureSession?: () => Promise<void>;
  /** Session metadata (for context badges display) */
  sessionMetadata: SessionMetadata | null;
  /** Hide Skills trigger (when A2Composer is expanded) */
  hideSkillsTrigger?: boolean;
  /** Notify parent when Skills panel open state changes */
  onSkillsOpenChange?: (open: boolean) => void;
  /** Workspace panel visibility state */
  showWorkspace: boolean;
  /** Workspace panel visibility setter */
  setShowWorkspace: (value: boolean) => void;
  /** Session files panel visibility state */
  showSessionFiles: boolean;
  /** Session files panel visibility setter */
  setShowSessionFiles: (value: boolean) => void;
  /** Session info panel visibility state */
  showSessionInfo: boolean;
  /** Session info panel visibility setter */
  setShowSessionInfo: (value: boolean) => void;
  /** Handler for session file clicks (opens preview overlay) */
  onSessionFileClick?: (path: string) => void;
  /** Handler for aborting the current query */
  onAbort?: () => void;
  /** Notify parent of composer text changes */
  onTextChange?: (text: string) => void;
  /** Called when user sends a message */
  onSend?: () => void;
  /** Selected skill for explicit use (hint → composer placeholder when armed) */
  selectedSkill?: { slug: string; name?: string; hint?: string } | null;
  /** Clear selected skill */
  onClearSelectedSkill?: () => void;
  /** Select a skill from composer UI */
  onSkillSelect?: (skill: { slug: string; name: string }) => void;
  /** Called after a sent message's attachments are persisted (so the thread can
   *  refresh and show the file chip live, not only after a session switch). */
  onAttachmentsPersisted?: () => void;
  /** Canvas Agent (D5): narrow sidebar, not a full-width page. Drives:
   *  - translucent/backdrop-blur background instead of solid `bg-card` (same
   *    `bg-card/NN backdrop-blur-sm` convention as a2composer-panel.tsx's bucket bar
   *    and this file's own attachment-remove button);
   *  - hides Workspace/Session-Files/Session-Info buttons: the latter two dispatch to
   *    WorkbenchDock tabs, and WorkbenchDock isn't mounted in canvas mode (see
   *    claude-chat-controller.tsx's `!canvasMode && <WorkbenchDock/>`) — showing them
   *    would be dead clicks. Also just frees up width: at ~380px the full button row
   *    (model picker + 3 panel toggles + permission tier + mcp status + send) doesn't
   *    fit and visibly overflows past the composer's rounded border. */
  canvasMode?: boolean;
}

/**
 * Imperative handle interface for external control
 * Used by parent components (e.g., A2Composer template insertion)
 */
export interface ChatComposerRef {
  /** Set composer text content (replaces existing text) */
  setText: (text: string) => void;
  /** Programmatically trigger message send */
  send: () => void;
  /** Focus the composer input */
  focus: () => void;
}

/**
 * ChatComposer Component
 *
 * Main input interface for Claude Agent Chat.
 * Handles message composition, file uploads, and panel toggles.
 */
export function ChatComposer({
  permissionInfo,
  currentSessionId,
  ensureSession,
  sessionMetadata,
  showWorkspace,
  setShowWorkspace,
  showSessionFiles,
  setShowSessionFiles,
  showSessionInfo,
  setShowSessionInfo,
  onSessionFileClick,
  onAbort,
  onTextChange,
  onSend,
  hideSkillsTrigger,
  onSkillsOpenChange,
  selectedSkill,
  onClearSelectedSkill,
  onSkillSelect,
  onAttachmentsPersisted,
  canvasMode = false,
}: ChatComposerProps) {
  const content = useIntlayer('claude-chat');
  const api = useAssistantApi();
  // The composer's file/info icons now open the right-side workbench to a tab
  // (会话文件→Files, info→Context), instead of separate popovers — one place, the
  // workbench owns it. Shared store because the workbench is a far-apart sibling here.
  const openWorkbenchTab = useWorkbenchUI((s) => s.openTab);
  // Canvas Agent (D5/F10): always call the hook (rules of hooks), but only ACT on it
  // when canvasMode — canvasStore is a global singleton, so on a non-canvas page this
  // could carry stale state from a prior canvas visit if we didn't gate on canvasMode
  // explicitly at every use site below.
  const canvasSelectedAssetIds = useCanvasStore((s) => s.selectedAssetIds);
  const canvasAssets = useCanvasStore((s) => s.assets);
  const setCanvasSelectedAssetIds = useCanvasStore((s) => s.setSelectedAssetIds);
  const pendingComposerCommand = useCanvasStore((s) => s.pendingComposerCommand);
  const setPendingComposerCommand = useCanvasStore((s) => s.setPendingComposerCommand);
  const composerText = useAssistantState(({ composer }) => composer.text);
  const composerRunConfig = useAssistantState(({ composer }) => composer.runConfig);
  const composerIsEditing = useAssistantState(({ composer }) => composer.isEditing);
  const isRunning = useThread((state) => state.isRunning);

  // F5.1/F4.x (Animate button, in-place mini composer): consume a cross-tree command
  // from node-toolbar.tsx (see canvas-store.ts's pendingComposerCommand doc). Builds
  // canvas refs directly from the command's assetIds — deliberately does NOT go
  // through canvasSelectedAssetIds/handleSend's own staging block, since that reads
  // reactive state that may not have settled yet if a caller just also changed the
  // selection in the same tick (a plain useEffect firing post-commit sidesteps that
  // race entirely, at the cost of a small duplication of the refs-building logic).
  useEffect(() => {
    if (!canvasMode || !pendingComposerCommand) return;
    if (isRunning) return; // re-fires once isRunning flips back to false — command stays staged
    const { assetIds, text } = pendingComposerCommand;
    const refs: CanvasRefDescriptor[] = assetIds
      .map((id) => canvasAssets[id])
      .filter((a): a is NonNullable<typeof a> => Boolean(a) && (a.type === 'image' || a.type === 'video' || a.type === 'audio' || a.type === 'text') && !!a.relPath)
      .map((a) => ({
        relPath: a.relPath as string,
        type: a.type as 'image' | 'video' | 'audio' | 'text',
        width: a.width,
        height: a.height,
        ...((a.type === 'video' || a.type === 'audio') && a.meta?.durationSec !== undefined ? { durationSec: a.meta.durationSec } : {}),
        ...(a.type === 'text' ? { content: a.meta?.text?.content ?? '' } : {}),
      }));
    stagePendingCanvasRefs(refs.length > 0 ? refs : null);
    setCanvasSelectedAssetIds([]);
    setPendingComposerCommand(null);
    api.composer().setText(text);
    onSend?.();
    queueMicrotask(() => api.composer().send());
  }, [canvasMode, pendingComposerCommand, isRunning, canvasAssets, api, setCanvasSelectedAssetIds, setPendingComposerCommand, onSend]);

  // Persist attachments against the SAME message list the thread renders from
  // (the chat-session store, whose user-message id is minted in route `onNew`).
  // The assistant-ui runtime thread (`useThread`) mints a *different* id, so
  // keying off it would store attachments under an id the renderer never looks
  // up — the file chip would never appear.
  const storeMessages = useChatSessionStore((state) => state.messages);

  // Upload manager: real progress, per-file cancel, client size-gate, and
  // background-parse status polling (PRD §3.3). Replaces the old fetch-and-block
  // upload that locked the composer (BUG-002/005/006). Destructured so effect/
  // callback deps reference the STABLE functions, not the fresh object per render.
  const {
    items: uploadItems,
    addFiles: addUploadFiles,
    dismiss: dismissUpload,
    clear: clearUploads,
    hasPending: hasPendingUploads,
    readyAttachments,
  } = useWorkspaceUploads(currentSessionId);
  // Composer-level notice (session-create failure, no-valid-file paste/drop) —
  // per-file errors live on the upload items themselves.
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { persistAttachments } = useMessageAttachments();
  const pendingAttachmentsRef = useRef<PendingAttachment[] | null>(null);
  const lastPersistedMessageIdRef = useRef<string | null>(null);

  // Get agent status from store for ToolbarStatus
  const agentStatus = useChatSessionStore((state) => state.agentStatus);
  const currentToolName = useChatSessionStore((state) => state.currentToolName);
  const queueCount = useChatSessionStore((state) => state.queueCount);
  const selectedTier = useChatSessionStore((state) => state.selectedTier);
  const setSelectedTier = useChatSessionStore((state) => state.setSelectedTier);
  const displayStatus: AgentStatusType = isRunning ? (agentStatus as AgentStatusType) : 'idle';

  // Draft auto-save: persist unsent input to localStorage
  const { saveDraft, clearDraft } = useDraftAutoSave(
    useCallback(() => composerText, [composerText]),
    useCallback((text: string) => api.composer().setText(text), [api])
  );

  // Save draft whenever text changes
  useEffect(() => {
    saveDraft(composerText);
  }, [composerText, saveDraft]);

  useEffect(() => {
    onTextChange?.(composerText);
  }, [composerText, onTextChange]);

  // Clear draft when query starts (message sent successfully)
  const prevIsRunning = useRef(isRunning);
  useEffect(() => {
    if (isRunning && !prevIsRunning.current) {
      clearDraft();
    }
    prevIsRunning.current = isRunning;
  }, [isRunning, clearDraft]);

  useEffect(() => {
    setUploadError(null);
  }, [currentSessionId]);

  useEffect(() => {
    pendingAttachmentsRef.current = null;
    lastPersistedMessageIdRef.current = null;
  }, [currentSessionId]);

  useEffect(() => {
    if (!currentSessionId) return;
    const pending = pendingAttachmentsRef.current;
    if (!pending || pending.length === 0) return;

    const lastUserMessage = [...storeMessages].reverse().find((msg) => msg.role === 'user');
    if (!lastUserMessage || lastUserMessage.id === lastPersistedMessageIdRef.current) return;

    persistAttachments(currentSessionId, lastUserMessage.id, pending).then(() => {
      lastPersistedMessageIdRef.current = lastUserMessage.id;
      pendingAttachmentsRef.current = null;
      clearUploads();
      setUploadError(null);
      onAttachmentsPersisted?.();
    });
  }, [currentSessionId, storeMessages, persistAttachments, onAttachmentsPersisted, clearUploads]);

  const handleClearInput = useCallback(async () => {
    clearUploads();
    setUploadError(null);
    await api.composer().reset();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [api, clearUploads]);

  const handleExampleSelect = useCallback((prompt: string) => {
    if (!prompt) return;
    api.composer().setText(prompt);
    const composerRoot = document.querySelector('[data-composer-root] [contenteditable=\"true\"]') as HTMLElement;
    if (composerRoot) {
      composerRoot.focus();
      return;
    }
    const input = document.querySelector('[contenteditable=\"true\"]') as HTMLElement;
    input?.focus();
  }, [api]);

  // Lazy-create the session on first workspace-needing action (upload/KB/files buttons):
  // new-chat landings create nothing until needed, but a user clicking upload has clear
  // intent — create the session right there instead of disabling the buttons.
  const [ensuringSession, setEnsuringSession] = useState(false);
  const withSession = useCallback(
    async (action: () => void) => {
      if (!currentSessionId && ensureSession) {
        setEnsuringSession(true);
        try {
          await ensureSession();
        } catch (err) {
          console.error('[Composer] lazy session create failed:', err);
          setUploadError('创建会话失败，请重试。');
          return;
        } finally {
          setEnsuringSession(false);
        }
      }
      action();
    },
    [currentSessionId, ensureSession],
  );

  const handleUploadClick = useCallback(() => {
    void withSession(() => {
      setUploadError(null);
      fileInputRef.current?.click();
    });
  }, [withSession]);

  // Add image files to the assistant-ui attachment strip (thumbnails). Docs show
  // their status chip instead. Best-effort — never blocks the real upload.
  const addThumbnails = useCallback((files: File[]) => {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        void api.composer().addAttachment(file).catch(() => {});
      }
    }
  }, [api]);

  // Single entry point for picker / drag-drop / paste. Uploads start immediately
  // when a session exists; otherwise we lazily create one and flush a queued set
  // once it's ready (drop/paste on a brand-new chat shouldn't be dropped).
  const pendingFilesRef = useRef<File[] | null>(null);
  const handleAddFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setUploadError(null);
    if (currentSessionId) {
      addUploadFiles(files);
      addThumbnails(files);
      return;
    }
    pendingFilesRef.current = [...(pendingFilesRef.current ?? []), ...files];
    void withSession(() => {});
  }, [currentSessionId, addUploadFiles, addThumbnails, withSession]);

  // Flush files queued before the session existed (drop/paste on a new chat).
  useEffect(() => {
    if (currentSessionId && pendingFilesRef.current?.length) {
      const queued = pendingFilesRef.current;
      pendingFilesRef.current = null;
      addUploadFiles(queued);
      addThumbnails(queued);
    }
  }, [currentSessionId, addUploadFiles, addThumbnails]);

  const handleFilesSelected = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      handleAddFiles(Array.from(files));
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [handleAddFiles]);

  // BUG-001 拖拽上传: accept any dropped files via the same pipeline.
  const handleDragOver = useCallback((event: DragEvent) => {
    if (event.dataTransfer?.types?.includes('Files')) {
      event.preventDefault();
      setIsDragging(true);
    }
  }, []);
  const handleDragLeave = useCallback((event: DragEvent) => {
    // Only leave when the pointer exits the composer (not when entering a child).
    if (event.currentTarget === event.target) setIsDragging(false);
  }, []);
  const handleDrop = useCallback((event: DragEvent) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    setIsDragging(false);
    handleAddFiles(Array.from(event.dataTransfer.files));
  }, [handleAddFiles]);

  // BUG-003 剪贴板图片粘贴: pull image files out of the clipboard (no intermediate
  // save) and upload them. Non-image paste falls through to normal text paste.
  const handlePaste = useCallback((event: ClipboardEvent) => {
    const imageFiles: File[] = [];
    for (const item of Array.from(event.clipboardData?.items ?? [])) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault();
      handleAddFiles(imageFiles);
    }
  }, [handleAddFiles]);

  const composerHasText = composerText.trim().length > 0;
  // Gate send on no PENDING uploads (uploading/parsing) — NOT a global "isUploading"
  // lock (BUG-005). The input stays editable throughout; each pending chip is
  // cancellable, so a stuck/slow upload never traps the user: cancel → send.
  const canSend = composerIsEditing && composerHasText && !isRunning && !hasPendingUploads;

  const handleSend = useCallback((event?: FormEvent) => {
    if (event) {
      event.preventDefault();
    }
    if (!composerHasText) {
      setUploadError('请先输入内容再发送。');
      return;
    }
    if (!canSend || isRunning) return;
    // Only ready/scanned attachments (have a usable agentPath); pending uploads are
    // gated out by canSend, errored ones are excluded by the hook.
    const pendingAttachments = readyAttachments;
    pendingAttachmentsRef.current = pendingAttachments.length > 0 ? pendingAttachments : null;
    const baseRunConfig = composerRunConfig ?? {};
    const baseCustom = (baseRunConfig.custom ?? {}) as Record<string, unknown>;
    const { attachments: _ignoredAttachments, skill: _ignoredSkill, ...restCustom } = baseCustom;
    const skillMarker = selectedSkill?.slug
      ? buildSkillMarker(selectedSkill.slug, selectedSkill.name)
      : null;
    const nextRunConfig = {
      ...baseRunConfig,
      custom: {
        ...restCustom,
        attachments: pendingAttachments,
        ...(selectedSkill?.slug ? { skill: { slug: selectedSkill.slug, name: selectedSkill.name } } : {}),
      },
    };
    api.composer().setRunConfig(nextRunConfig);
    const sendNow = () => {
      trackClaudeAgentQuerySent({
        queryLength: composerText.trim().length,
        hasAttachments: pendingAttachments.length > 0,
        attachmentCount: pendingAttachments.length,
        skillSlug: selectedSkill?.slug ?? undefined,
        skillName: selectedSkill?.name ?? undefined,
        sessionId: currentSessionId ?? undefined,
      });
      // Notify parent before sending (for auto-collapse A2ComposerPanel)
      onSend?.();
      // 返工1: stage attachments on the RELIABLE side-channel right before send.
      // The assistant-ui runConfig path below (setRunConfig) is kept belt-and-
      // suspenders, but runChat reads this stage as the authoritative source — so
      // the 【附件信息】 block reliably reaches the worker prompt even though the
      // post-send reset strips runConfig.custom.attachments.
      if (pendingAttachments.length > 0) {
        console.log('[Composer] staging', pendingAttachments.length, 'attachment(s) for send:', pendingAttachments.map((a) => a.filePath));
      }
      stagePendingAttachments(pendingAttachments);
      // Canvas Agent (D5/F10.2): same side-channel, gated on canvasMode so a stale
      // selection from a prior canvas visit never leaks into a non-canvas send.
      if (canvasMode && canvasSelectedAssetIds.length > 0) {
        const refs: CanvasRefDescriptor[] = canvasSelectedAssetIds
          .map((id) => canvasAssets[id])
          .filter((a): a is NonNullable<typeof a> => Boolean(a) && (a.type === 'image' || a.type === 'video' || a.type === 'audio' || a.type === 'text') && !!a.relPath)
          .map((a) => ({
            relPath: a.relPath as string,
            type: a.type as 'image' | 'video' | 'audio' | 'text',
            width: a.width,
            height: a.height,
            ...((a.type === 'video' || a.type === 'audio') && a.meta?.durationSec !== undefined ? { durationSec: a.meta.durationSec } : {}),
            ...(a.type === 'text' ? { content: a.meta?.text?.content ?? '' } : {}),
          }));
        stagePendingCanvasRefs(refs);
        // 发送后清空选中 (impl spec §6.3, matches the reference product's behavior).
        setCanvasSelectedAssetIds([]);
      } else {
        stagePendingCanvasRefs(null);
      }
      api.composer().send();
      if (Object.prototype.hasOwnProperty.call(baseCustom, 'attachments') || Object.prototype.hasOwnProperty.call(baseCustom, 'skill')) {
        api.composer().setRunConfig({
          ...baseRunConfig,
          custom: restCustom,
        });
      } else {
        api.composer().setRunConfig(baseRunConfig);
      }
    };

    if (skillMarker) {
      const nextText = injectSkillMarker(composerText, skillMarker);
      if (nextText !== composerText) {
        api.composer().setText(nextText);
        queueMicrotask(sendNow);
        return;
      }
    }

    sendNow();
  }, [api, canSend, composerHasText, isRunning, readyAttachments, currentSessionId, onSend, composerRunConfig, composerText, selectedSkill, canvasMode, canvasSelectedAssetIds, canvasAssets, setCanvasSelectedAssetIds]);

  return (
    <ComposerPrimitive.Root
      data-composer-root="true"
      data-dragging={isDragging || undefined}
      className={cn(
        'relative z-30 shrink-0 mx-auto flex w-full max-w-3xl flex-col overflow-visible rounded-2xl border border-border/70 p-0.5 shadow-md transition-shadow duration-200 focus-within:shadow-lg hover:shadow-lg data-[dragging]:border-primary data-[dragging]:ring-2 data-[dragging]:ring-primary/40',
        canvasMode ? 'bg-card/90 backdrop-blur-sm' : 'bg-card'
      )}
      onSubmit={handleSend}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {/* BUG-001 拖拽: drop-anywhere overlay hint */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-2xl bg-primary/5 text-sm font-medium text-primary">
          松开以上传文件
        </div>
      )}
      <div className="m-3.5 flex flex-col gap-3.5">
        {/* Context badges - show active Skills and MCP sources */}
        {!isRunning && sessionMetadata && (
          <ContextBadges
            sessionMetadata={sessionMetadata}
            onExampleSelect={handleExampleSelect}
            onSkillsOpenChange={onSkillsOpenChange}
            hideSkillsTrigger={hideSkillsTrigger}
            onSkillSelect={onSkillSelect}
          />
        )}
        {selectedSkill?.slug && (
          <div className="flex flex-wrap items-center gap-2">
            <SkillChip
              label={selectedSkill.name ?? selectedSkill.slug}
              onRemove={onClearSelectedSkill}
              className="bg-foreground/90 text-background"
            />
          </div>
        )}
        <div className="relative z-10">
          <div className="wrap-break-word max-h-96 w-full overflow-y-auto">
            <ComposerPrimitive.Input
              placeholder={
                selectedSkill?.hint || toLocalizedString(content.chatInput.placeholderGreeting)
              }
              className="block min-h-6 w-full resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <div className="flex w-full items-center gap-2">
          <div className="relative flex min-w-0 flex-1 shrink items-center gap-2">
            <button
              type="button"
              onClick={handleUploadClick}
              className="flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-lg border bg-transparent px-1.5 text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="上传文件"
              disabled={ensuringSession}
              title="上传文件到工作区（支持多选 / 拖拽 / 粘贴图片）"
            >
              <Plus width={16} height={16} />
            </button>
            <button
              type="button"
              onClick={handleClearInput}
              className="flex h-8 min-w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-transparent px-1.5 text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-[0.98]"
              aria-label="清空输入"
              title="清空输入"
            >
              <ReloadIcon width={16} height={16} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={handleFilesSelected}
            />
          </div>
          <div className="flex items-center gap-2">
            {/* Model picker (multi-model) - only show when not running */}
            {!isRunning && <ModelPicker />}

            {/* Workspace Toggle Button - only show when not running. Hidden in canvas
                mode: not core to an image-gen workflow, and frees width (see canvasMode
                doc comment on ChatComposerProps). */}
            {!isRunning && !canvasMode && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => void withSession(() => setShowWorkspace(!showWorkspace))}
                  className="flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-lg border bg-transparent px-1.5 text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="切换工作空间"
                  title="知识库 / 工作区"
                  disabled={ensuringSession}
                >
                  <FolderOpen width={16} height={16} />
                </button>

                {/* Workspace Panel */}
                {showWorkspace && currentSessionId && (
                  <div className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-lg border border-border bg-popover p-4 shadow-lg dark:border-border dark:bg-popover">
                    {/* Header */}
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-semibold text-foreground text-sm dark:text-foreground">
                        📚 Knowledge Base
                      </h3>
                      <button
                        onClick={() => setShowWorkspace(false)}
                        className="rounded p-1 text-muted-foreground transition hover:bg-muted dark:text-muted-foreground dark:hover:bg-muted"
                        aria-label="关闭"
                      >
                        <Cross2Icon width={14} height={14} />
                      </button>
                    </div>

                    <div className="space-y-3 text-xs">
                      <KnowledgeBasePanel sessionId={currentSessionId} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Session Files Button - only show when not running. Hidden in canvas mode:
                it opens a WorkbenchDock tab, and WorkbenchDock isn't mounted there (see
                claude-chat-controller.tsx) — showing this button would be a dead click. */}
            {!isRunning && !canvasMode && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => void withSession(() => openWorkbenchTab('files'))}
                  className="flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-lg border bg-transparent px-1.5 text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="会话文件（右侧工作台 Files）"
                  title="会话文件 · 开/关右侧工作台（Files）"
                  disabled={ensuringSession}
                >
                  <FolderTree width={16} height={16} />
                </button>
              </div>
            )}

            {/* Session Info → opens the workbench Context tab (model · capabilities ·
                tokens) — same content as the old popover, now unified + always clickable
                (gated only on having a session, not on sessionMetadata being loaded).
                Hidden in canvas mode for the same reason as Session Files above. */}
            {!isRunning && !canvasMode && (
              <button
                type="button"
                onClick={() => void withSession(() => openWorkbenchTab('context'))}
                className="flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-lg border bg-transparent px-1.5 text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="会话信息（右侧工作台 Context）"
                title="会话信息 · 开/关右侧工作台（Context）"
                disabled={ensuringSession}
              >
                <InfoCircledIcon width={16} height={16} />
              </button>
            )}

            {/* Permission Tier Selector - only show when not running */}
            {!isRunning && (
              <PermissionTierSelector
                selectedTier={selectedTier}
                onSelect={setSelectedTier}
              />
            )}

            {/* ToolbarStatus - show when running */}
            {isRunning && (
              <ToolbarStatus
                status={displayStatus}
                toolName={currentToolName}
                queueCount={queueCount}
                onAbort={() => {
                  onAbort?.();
                  api.composer().cancel();
                }}
              />
            )}

            {/* MCP Status Indicator */}
            <McpStatusIndicator className="ml-2" />

            {/* Send button */}
            <button
              type="submit"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary bg-[linear-gradient(180deg,color-mix(in_oklab,var(--primary),white_9%),color-mix(in_oklab,var(--primary),black_10%))] text-primary-foreground shadow-sm transition-all hover:brightness-105 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
              title={isRunning ? '正在生成，先停止或等待' : '发送消息'}
              aria-label="发送消息"
              disabled={!canSend}
            >
              <ArrowUpIcon width={16} height={16} />
            </button>
          </div>
        </div>
      </div>
      <ComposerAttachmentsSection
        items={uploadItems}
        uploadError={uploadError}
        onDismiss={dismissUpload}
      />
    </ComposerPrimitive.Root>
  );
}

/**
 * Composer Attachments Section (PRD §3.3)
 * Renders each upload as a chip with live progress + a cancel/remove button.
 * States: uploading(%) → parsing → ready | scanned | error.
 */
interface ComposerAttachmentsSectionProps {
  items: UploadItem[];
  uploadError: string | null;
  onDismiss: (id: string) => void;
}

function ComposerAttachmentsSection({ items, uploadError, onDismiss }: ComposerAttachmentsSectionProps) {
  const hasUploads = items.length > 0;
  const hasContent = hasUploads || uploadError;

  if (!hasContent) return null;

  return (
    <div className="relative z-40 overflow-visible rounded-b-2xl">
      <div className="overflow-x-auto overflow-y-visible rounded-b-2xl border border-t bg-muted px-3.5 py-2">
        <div className="relative z-50 flex flex-wrap items-center gap-3" data-attachments="true">
          <ComposerPrimitive.Attachments components={{ Attachment: ClaudeAttachment }} />
          {hasUploads && (
            <div className="flex flex-wrap items-center gap-2">
              {items.map((item) => (
                <UploadChip key={item.id} item={item} onDismiss={() => onDismiss(item.id)} />
              ))}
            </div>
          )}
        </div>
        {uploadError && (
          <div className="mt-2 text-xs">
            <span className="text-destructive">{uploadError}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Single upload chip: name + state, a thin progress bar while uploading, and a
 * cancel (pending) / remove (done) button so the user is never trapped (BUG-005).
 */
function UploadChip({ item, onDismiss }: { item: UploadItem; onDismiss: () => void }) {
  const isError = item.status === 'error';
  const isPending = item.status === 'uploading' || item.status === 'parsing';
  const hasNotice = !!item.notice && !isError;

  const statusLabel =
    item.status === 'uploading'
      ? `上传中 ${item.progress}%`
      : item.status === 'parsing'
        ? '解析中…'
        : item.status === 'scanned'
          ? '扫描件'
          : isError
            ? '失败'
            : formatBytes(item.fileSize);

  return (
    <span
      className={`group/chip relative flex max-w-[18rem] items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
        isError
          ? 'border-destructive/60 text-destructive'
          : hasNotice
            ? 'border-amber-500/60 text-amber-600 dark:text-amber-400'
            : 'border-border bg-card text-foreground'
      }`}
      title={item.error || item.notice || item.name}
    >
      {item.status === 'uploading' || item.status === 'parsing' ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : null}
      <span className="truncate font-medium">{item.name}</span>
      <span className="shrink-0 text-[10px] opacity-70">· {statusLabel}</span>
      {/* Live progress bar during upload */}
      {item.status === 'uploading' && (
        <span className="absolute inset-x-1 bottom-0 h-0.5 overflow-hidden rounded-full bg-muted-foreground/20">
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${Math.max(item.progress, 3)}%` }}
          />
        </span>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        aria-label={isPending ? '取消上传' : '移除'}
        title={isPending ? '取消上传' : '移除'}
      >
        <Cross2Icon width={12} height={12} />
      </button>
    </span>
  );
}

/**
 * Attachment Thumbnail Component
 */
function ClaudeAttachment() {
  const content = useIntlayer('claude-chat');
  return (
    <AttachmentPrimitive.Root className="group/thumbnail relative">
      <div
        className="can-focus-within overflow-hidden rounded-lg border shadow-sm hover:shadow-md"
        style={{
          width: '120px',
          height: '120px',
          minWidth: '120px',
          minHeight: '120px',
        }}
      >
        <button
          type="button"
          className="relative flex h-full w-full items-center justify-center bg-card text-muted-foreground"
        >
          <AttachmentPrimitive.unstable_Thumb className="text-xs" />
        </button>
      </div>
      <AttachmentPrimitive.Remove
        className="-left-2 -top-2 absolute flex h-5 w-5 items-center justify-center rounded-full border bg-card/90 text-muted-foreground opacity-0 backdrop-blur-sm transition-all hover:bg-card hover:text-foreground group-focus-within/thumbnail:opacity-100 group-hover/thumbnail:opacity-100"
        aria-label={toLocalizedString(content.composer.removeAttachment)}
      >
        <Cross2Icon width={12} height={12} />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

/**
 * Forward ref version with imperative handle for external control
 * Use this when parent component needs to control the composer
 */
interface ChatComposerWithRefProps extends ChatComposerProps {
  composerRef: MutableRefObject<ChatComposerRef | null>;
}

export function ChatComposerWithRef({ composerRef, onSend, ...props }: ChatComposerWithRefProps) {
  const api = useAssistantApi();

  // Expose control methods to parent via ref
  useImperativeHandle(composerRef, () => ({
    setText: (text: string) => {
      api.composer().setText(text);
    },
    send: () => {
      api.composer().send();
    },
    focus: () => {
      // Focus the composer input element
      // Use more specific selector to target the composer's contenteditable
      const composerRoot = document.querySelector('[data-composer-root] [contenteditable="true"]') as HTMLElement;
      if (composerRoot) {
        composerRoot.focus();
        return;
      }
      // Fallback to generic selector
      const input = document.querySelector('[contenteditable="true"]') as HTMLElement;
      input?.focus();
    },
  }), [api]);

  return <ChatComposer {...props} onSend={onSend} />;
}
