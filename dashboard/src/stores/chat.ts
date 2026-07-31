import { create } from 'zustand';
import { Modal } from 'antd';
import type { ChatMessage, ChatStreamEvent, ChatAttachment } from '../gateway/types';
import { GatewayRequestError } from '../gateway/client';
import { useGatewayStore } from './gateway';
import { useLibraryStore } from './library';
import { useTasksStore } from './tasks';
import { useToolStreamStore } from './tool-stream';
import { useTaskFlowStore } from './task-flow';
import { useSessionsStore } from './sessions';
import { useCronStore } from './cron';
import { useMonitorStore } from './monitor';
import { useUiStore } from './ui';
import { useJobsStore } from './jobs';
import { useConfigStore } from './config';
import { resolveVisionSupport } from '../utils/vision-capability';
import { syncSystemPromptAppendToGateway } from '../utils/sync-system-prompt-append';
import { CHAT_IMAGE_DIR, appendReferenceBlock, dedupePaths, isImagePath } from '../utils/file-reference';
import { buildAutoLongTaskPrompt, detectLongTaskIntent, shouldPromoteLongTaskWithoutConfirmation } from '../utils/long-task';
import i18n from '../i18n';
import { sanitizeUserMessage, CRON_REMINDER_RE } from '../utils/sanitize-message';
import { classifyRunFailure, type RunFailureInfo } from '../utils/run-failure';
import { sanitizeAssistantMessage } from '../utils/sanitize-assistant-message';
import { parseSlashCommand, executeSlashCommand } from '../utils/slash-commands';
import {
  detectStagedWritingIntent,
  extractStagedWritingSourcePaths,
  isExplicitStagedWritingRestart,
} from '../utils/staged-writing-detect';
import { isStagedWritingJobForSession } from '../utils/staged-writing-run';
import { useStagedWritingStore } from './staged-writing';
import { selectSessionRunView, useSessionRunsStore } from './session-runs';
import type { SessionRunRowLike } from '../utils/session-run-reconciler';

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const EXECUTION_BINDINGS_PREFIX = 'rc-execution-bindings:';
const MAX_EXECUTION_BINDINGS = 500;
const PENDING_SEND_ACK_PREFIX = 'rc-pending-send-ack:';

import { normalizeSessionKey, toGatewaySessionKey } from '../utils/session-key';

interface ExecutionBinding {
  timestamp: number;
  textHash: string;
  rawTextHash?: string;
  runId: string;
}

function hashMessageText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function executionBindingStorageKey(sessionKey: string): string {
  return `${EXECUTION_BINDINGS_PREFIX}${normalizeSessionKey(sessionKey)}`;
}

function readExecutionBindings(sessionKey: string): ExecutionBinding[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(executionBindingStorageKey(sessionKey)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ExecutionBinding => (
      item
      && typeof item.timestamp === 'number'
      && typeof item.textHash === 'string'
      && (item.rawTextHash === undefined || typeof item.rawTextHash === 'string')
      && typeof item.runId === 'string'
    ));
  } catch {
    return [];
  }
}

function rememberExecutionBinding(sessionKey: string, message: ChatMessage, runId: string): void {
  if (typeof localStorage === 'undefined' || message.role !== 'assistant') return;
  const timestamp = message.timestamp ?? Date.now();
  const binding: ExecutionBinding = {
    timestamp,
    textHash: hashMessageText(extractText(message)),
    rawTextHash: hashMessageText(extractRawText(message)),
    runId,
  };
  const bindings = readExecutionBindings(sessionKey)
    .filter((item) => item.runId !== runId);
  bindings.push(binding);
  try {
    localStorage.setItem(
      executionBindingStorageKey(sessionKey),
      JSON.stringify(bindings.slice(-MAX_EXECUTION_BINDINGS)),
    );
  } catch {
    // History binding is an enhancement; quota/privacy modes must not break chat.
  }
}

function restoreExecutionBindings(sessionKey: string, messages: ChatMessage[]): ChatMessage[] {
  const bindings = readExecutionBindings(sessionKey);
  if (bindings.length === 0) return messages;
  const available = new Set(bindings.map((_, index) => index));

  return messages.map((message) => {
    if (message.role !== 'assistant' || message.executionRunId) return message;
    const timestamp = message.timestamp ?? 0;
    const textHash = hashMessageText(extractText(message));
    const rawTextHash = hashMessageText(extractRawText(message));
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    bindings.forEach((binding, index) => {
      const hashMatches = binding.textHash === textHash
        || binding.textHash === rawTextHash
        || binding.rawTextHash === textHash
        || binding.rawTextHash === rawTextHash;
      if (!available.has(index) || !hashMatches) return;
      const distance = Math.abs(binding.timestamp - timestamp);
      // Exact content is the primary identity. Timestamp only disambiguates
      // duplicate replies; a hard 5s cutoff broke refresh when gateway and
      // transcript timestamps represented different points in the same turn.
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });
    if (bestIndex < 0) return message;
    available.delete(bestIndex);
    return { ...message, executionRunId: bindings[bestIndex].runId };
  });
}

/**
 * Debounce timer for gap-triggered history reloads.
 * Module-level to avoid polluting Zustand store serialization.
 */
let _gapDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const GAP_DEBOUNCE_MS = 500;
const historyGenerationBySession = new Map<string, number>();

/**
 * Stale-streaming watchdog.
 * Periodically checks if no chat delta has arrived within STALE_STREAM_TIMEOUT_MS.
 * Requests an authoritative Session reconciliation when the stream appears
 * quiet. Inactivity itself is never a terminal fact.
 *
 * Tracks _lastDeltaAt only to decide when another read-only Session comparison
 * is useful. A quiet stream is not evidence of a dead run.
 *
 * Backup: the tick watchdog (client.ts) detects dead connections at the transport
 * layer and forces reconnect. This watchdog only asks the OC Session authority
 * whether the run is still active; it cannot clear chat/tool state or report a
 * failure.
 */
let _staleStreamWatchdog: ReturnType<typeof setInterval> | null = null;
const STALE_STREAM_TIMEOUT_MS = 360_000;
const STALE_WATCHDOG_CHECK_MS = 15_000;

type AgentFailureData = {
  phase?: string;
  error?: string;
  reason?: string;
  code?: string;
  provider?: string;
  model?: string;
  suggestion?: string;
  capability?: string;
};

function formatRunFailureForUser(raw: string): string {
  // Classification (auth/network/timeout/rate_limit/…) lives in utils/run-failure.
  return classifyRunFailure(raw).message;
}

function formatStructuredRunFailureForUser(data: AgentFailureData): string {
  const base = formatRunFailureForUser(String(data.reason ?? data.error ?? ''));
  const details: string[] = [];
  if (data.provider || data.model) {
    details.push([data.provider, data.model].filter(Boolean).join('/'));
  }
  if (data.code) details.push(data.code);

  const lines = [base];
  if (details.length > 0) lines.push(`${i18n.t('chat.failureDetails')}${details.join(' · ')}`);
  if (data.suggestion?.trim()) lines.push(`${i18n.t('chat.failureSuggestion')}${data.suggestion.trim()}`);
  return lines.join('\n');
}

/**
 * Ask the user whether a heuristically-detected long request should be promoted
 * to a tracked background job (which spawns an OpenClaw subagent instead of
 * answering inline). Resolves false on cancel/dismiss, so the default is the
 * non-surprising "answer in this turn".
 */
function confirmHeuristicLongTask(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: i18n.t('chat.longTask.confirmTitle'),
      content: i18n.t('chat.longTask.confirmBody', { title }),
      okText: i18n.t('chat.longTask.confirmOk'),
      cancelText: i18n.t('chat.longTask.confirmCancel'),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function detectRunEndedWithoutReply(messages: ChatMessage[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return last.role === 'user';
}

function clearActiveRunState(): Pick<
  ChatState,
  'sending' | 'streaming' | 'compacting' | 'streamText' | 'runId' | '_streamStartedAt' | '_lastDeltaAt' | '_reconnectedAt'
> {
  return {
    // `sending` is part of active-run state: it gates the composer
    // (disabled={!isConnected || sending}). A run that fails fast can emit its
    // error/final event before chat.send's ack flips sending→false, so any
    // run-ending reset must clear it too — otherwise the input stays disabled.
    sending: false,
    streaming: false,
    compacting: false,
    streamText: null,
    runId: null,
    _streamStartedAt: null,
    _lastDeltaAt: null,
    _reconnectedAt: null,
  };
}

function stopStaleStreamWatchdog() {
  if (_staleStreamWatchdog) {
    clearInterval(_staleStreamWatchdog);
    _staleStreamWatchdog = null;
  }
}

function startStaleStreamWatchdog(get: () => ChatState) {
  stopStaleStreamWatchdog();
  _staleStreamWatchdog = setInterval(() => {
    const s = get();
    if (!s.streaming) {
      stopStaleStreamWatchdog();
      return;
    }
    const lastActivity = s._lastDeltaAt ?? s._streamStartedAt;
    if (!lastActivity) return;

    const gap = Date.now() - lastActivity;
    if (gap > STALE_STREAM_TIMEOUT_MS) {
      stopStaleStreamWatchdog();
      console.info(
        `[Chat] No chat delta for ${Math.round(gap / 1000)}s — reconciling OC Session state`,
      );
      void useSessionRunsStore.getState().requestReconcile(s.sessionKey, 'stale-watchdog');
    }
  }, STALE_WATCHDOG_CHECK_MS);
}

/**
 * SessionStorage persistence for pending user messages.
 * Survives browser refresh (F5) within the same tab so optimistic messages
 * don't vanish when the gateway has queued them in-memory (collect mode).
 */
const PENDING_MSGS_STORAGE_KEY = 'rc-pending-user-msgs';
/** Dashboard-only messages (staged writing, etc.) — not in gateway transcript. */
const LOCAL_MSGS_STORAGE_KEY = 'rc-local-chat-msgs-v2';
const LEGACY_LOCAL_MSGS_STORAGE_KEY = 'rc-local-chat-msgs';
const PENDING_EXPIRY_MS = 3 * 60 * 1000; // 3 min auto-expiry

function savePendingMsgs(msgs: ChatMessage[]): void {
  try {
    if (msgs.length === 0) {
      sessionStorage.removeItem(PENDING_MSGS_STORAGE_KEY);
    } else {
      sessionStorage.setItem(PENDING_MSGS_STORAGE_KEY, JSON.stringify(msgs));
    }
  } catch { /* storage full — non-fatal */ }
}

function loadPendingMsgs(): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(PENDING_MSGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    // Filter out expired entries
    const now = Date.now();
    return parsed.filter((m) => m.timestamp && (now - m.timestamp) < PENDING_EXPIRY_MS);
  } catch { return []; }
}

function saveLocalMsgs(sessionKey: string, msgs: ChatMessage[]): void {
  try {
    const raw = localStorage.getItem(LOCAL_MSGS_STORAGE_KEY);
    const bySession = raw ? JSON.parse(raw) as Record<string, ChatMessage[]> : {};
    const normalizedKey = normalizeSessionKey(sessionKey) || 'main';
    if (msgs.length === 0) delete bySession[normalizedKey];
    else bySession[normalizedKey] = msgs;
    if (Object.keys(bySession).length === 0) localStorage.removeItem(LOCAL_MSGS_STORAGE_KEY);
    else localStorage.setItem(LOCAL_MSGS_STORAGE_KEY, JSON.stringify(bySession));
  } catch { /* non-fatal */ }
}

function loadLocalMsgs(sessionKey: string): ChatMessage[] {
  try {
    const normalizedKey = normalizeSessionKey(sessionKey) || 'main';
    const raw = localStorage.getItem(LOCAL_MSGS_STORAGE_KEY);
    let messages = raw
      ? (JSON.parse(raw) as Record<string, ChatMessage[]>)[normalizedKey] ?? []
      : [];

    // One-time migration for dashboard versions that stored one global list per tab.
    if (messages.length === 0) {
      const legacyRaw = sessionStorage.getItem(LEGACY_LOCAL_MSGS_STORAGE_KEY);
      if (legacyRaw) {
        messages = JSON.parse(legacyRaw) as ChatMessage[];
        sessionStorage.removeItem(LEGACY_LOCAL_MSGS_STORAGE_KEY);
        saveLocalMsgs(normalizedKey, messages);
      }
    }

    return messages.filter((message) => {
      if (message.role !== 'assistant') return true;
      const text = message.text?.trim() ?? '';
      return !/^\*\*(?:分步写作|Staged writing)\*\*\s*·/i.test(text);
    });
  } catch {
    return [];
  }
}

function localMessageExists(transcript: ChatMessage[], msg: ChatMessage): boolean {
  const text = msg.text?.trim() ?? '';
  const ts = msg.timestamp ?? 0;
  return transcript.some((m) =>
    m.role === msg.role
    && (m.text?.trim() ?? '') === text
    && Math.abs((m.timestamp ?? 0) - ts) < 5000,
  );
}

function mergeLocalMessages(transcript: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  if (local.length === 0) return transcript;
  const merged = [...transcript];
  for (const msg of local) {
    if (localMessageExists(merged, msg)) continue;
    const ts = msg.timestamp ?? 0;
    const insertIdx = merged.findIndex((m) => (m.timestamp ?? 0) > ts);
    if (insertIdx === -1) merged.push(msg);
    else merged.splice(insertIdx, 0, msg);
  }
  return merged;
}

function isSilentReply(text: string | undefined): boolean {
  return text !== undefined && SILENT_REPLY_PATTERN.test(text);
}

/** Roles that should be displayed in the chat UI (includes 'system' for slash command results). */
const VISIBLE_ROLES = new Set(['user', 'assistant', 'system']);

function isCronReminderInjection(text: string): boolean {
  return CRON_REMINDER_RE.test(text);
}

// stripInjectedContext replaced by unified sanitizeUserMessage() in utils/sanitize-message.ts

function isVisibleRole(role: string): boolean {
  return VISIBLE_ROLES.has(role);
}

/**
 * Channel B: Extract notifications from card-type JSON blocks in assistant messages.
 *
 * Markdown code blocks with card language tags (```progress_card, ```monitor_digest, etc.)
 * contain structured data that should also generate notifications.
 */
const CARD_NOTIFICATION_RE = /```(progress_card|monitor_digest|approval_card)\s*\n([\s\S]*?)```/g;

function extractCardNotifications(text: string): void {
  const { addNotification } = useUiStore.getState();
  let match: RegExpExecArray | null;

  while ((match = CARD_NOTIFICATION_RE.exec(text)) !== null) {
    const cardType = match[1];
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(match[2]);
    } catch {
      continue;
    }

    switch (cardType) {
      case 'progress_card': {
        const highlights = data.highlights as string[] | undefined;
        if (highlights && highlights.length > 0) {
          addNotification({
            type: 'heartbeat',
            title: `Heartbeat: ${data.period ?? 'check'}`,
            body: highlights.slice(0, 3).join('; '),
            dedupKey: `heartbeat:${data.period ?? 'check'}`,
          });
        }
        break;
      }
      case 'monitor_digest': {
        const mTotal = data.total_found as number | undefined;
        if (mTotal && mTotal > 0) {
          addNotification({
            type: 'system',
            title: `Monitor: ${data.monitor_name ?? 'scan'} — ${mTotal} result(s)`,
            body: String(data.target ?? ''),
            dedupKey: `monitor:${data.monitor_name}:${data.target}`,
          });
        }
        break;
      }
      case 'approval_card': {
        addNotification({
          type: 'error', // approval = critical, reuse highest-priority type
          title: `Approval needed: ${data.action ?? 'action'}`,
          body: String(data.context ?? ''),
          dedupKey: `approval:${data.approval_id ?? Date.now()}`,
        });
        break;
      }
    }
  }
  // Reset lastIndex for global regex reuse
  CARD_NOTIFICATION_RE.lastIndex = 0;
}

/**
 * Extract raw text from a ChatMessage, then sanitize for assistant messages.
 * Source: openclaw/ui/src/ui/chat/message-extract.ts:18-26 (extractText)
 * Source: openclaw/ui/src/ui/chat/message-extract.ts:85-109 (extractRawText — only joins type:'text' blocks)
 */
function extractRawText(msg: ChatMessage): string {
  // Get raw text — only from type:'text' blocks (NOT type:'thinking')
  // This matches OpenClaw's extractRawText (message-extract.ts:92-100)
  if (msg.text) {
    return msg.text.trim();
  }
  if (typeof msg.content === 'string') {
    return msg.content.trim();
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('')
      .trim();
  }
  return '';
}

function extractText(msg: ChatMessage): string {
  const raw = extractRawText(msg);

  // For assistant messages, apply unified sanitization pipeline.
  // Strips all internal scaffolding: thinking tags, final tags, memory tags, model tokens.
  // Source: sanitize-assistant-message.ts (centralized pipeline)
  if (msg.role === 'assistant') {
    return sanitizeAssistantMessage(raw);
  }

  return raw;
}

function buildStagedWritingContext(messages: ChatMessage[]): string {
  const lines = messages
    .slice(-12)
    .map((message) => {
      const text = extractText(message).trim();
      if (!text) return '';
      const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '系统';
      return `${role}：${text}`;
    })
    .filter(Boolean);
  return lines.join('\n\n').slice(-12_000);
}

/** Snapshot of the last user send — used to restore the input after abort. */
export interface ChatInputRestore {
  text: string;
  attachments: ChatAttachment[];
  references: string[];
}

interface LastSentDraft extends ChatInputRestore {
  runId: string;
}

interface PendingSendAck {
  sessionKey: string;
  runId: string;
  runtimeConnId: string | null;
  createdAt: number;
  params: {
    message: string;
    sessionKey: string;
    idempotencyKey: string;
    deliver: false;
    attachments?: Array<{
      type: string;
      mimeType: string;
      fileName: string;
      content: string;
      wsPath?: string;
    }>;
  };
}

function pendingSendAckStorageKey(sessionKey: string): string {
  return `${PENDING_SEND_ACK_PREFIX}${normalizeSessionKey(sessionKey)}`;
}

function loadPendingSendAck(sessionKey: string): PendingSendAck | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingSendAckStorageKey(sessionKey)) ?? 'null');
    if (
      !value
      || typeof value !== 'object'
      || typeof value.runId !== 'string'
      || typeof value.sessionKey !== 'string'
      || !value.params
      || typeof value.params.message !== 'string'
      || typeof value.params.idempotencyKey !== 'string'
    ) return null;
    return value as PendingSendAck;
  } catch {
    return null;
  }
}

function persistPendingSendAck(value: PendingSendAck | null): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (value) {
      sessionStorage.setItem(pendingSendAckStorageKey(value.sessionKey), JSON.stringify(value));
    } else {
      // The caller clears the currently selected session's key explicitly.
    }
  } catch {
    // Large image payloads can exceed sessionStorage. The in-memory copy still
    // preserves this runtime's exact request, and no automatic replay is allowed.
  }
}

function clearPersistedPendingSendAck(sessionKey: string): void {
  try {
    sessionStorage.removeItem(pendingSendAckStorageKey(sessionKey));
  } catch {
    // unavailable/privacy mode
  }
}

function cloneAttachments(attachments?: ChatAttachment[]): ChatAttachment[] {
  return attachments?.map((a) => ({ ...a })) ?? [];
}

function removeLastUserMessageForDraft(messages: ChatMessage[], draftText: string): ChatMessage[] {
  const trimmed = draftText.trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const t = m.text ?? '';
    if (t === draftText || t.trim() === trimmed) {
      return [...messages.slice(0, i), ...messages.slice(i + 1)];
    }
  }
  return messages;
}

/** Drop user turns the user aborted — gateway transcript still keeps them until compaction. */
function filterAbortedUserMessagesFromTranscript(
  messages: ChatMessage[],
  suppressCounts: Record<string, number>,
): { messages: ChatMessage[]; suppressCounts: Record<string, number> } {
  const next = { ...suppressCounts };
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user') {
      out.push(m);
      continue;
    }
    const key = (m.text ?? '').trim();
    if (key && (next[key] ?? 0) > 0) {
      next[key] -= 1;
      continue;
    }
    out.push(m);
  }
  return { messages: out, suppressCounts: next };
}

function bumpAbortedUserSuppress(
  counts: Record<string, number>,
  draftText: string,
): Record<string, number> {
  const key = draftText.trim();
  if (!key) return counts;
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

function pruneAbortedUserSuppress(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(counts)) {
    if (n > 0) out[key] = n;
  }
  return out;
}

/** Build store patch to restore input and drop the aborted run's optimistic user message. */
function buildAbortInputRestorePatch(
  state: Pick<ChatState, 'messages' | '_pendingUserMsgs' | '_lastSentDraft' | 'inputRestoreSeq' | '_abortedUserSuppressCounts'>,
  activeRunId?: string | null,
): Partial<ChatState> | null {
  const draft = state._lastSentDraft;
  if (!draft) return null;
  if (activeRunId && draft.runId !== activeRunId) return null;

  const trimmed = draft.text.trim();
  return {
    messages: removeLastUserMessageForDraft(state.messages, draft.text),
    _pendingUserMsgs: state._pendingUserMsgs.filter(
      (m) => m.text !== draft.text && m.text?.trim() !== trimmed,
    ),
    inputRestore: {
      text: draft.text,
      attachments: draft.attachments,
      references: [...draft.references],
    },
    inputRestoreSeq: state.inputRestoreSeq + 1,
    _lastSentDraft: null,
    _abortedUserSuppressCounts: bumpAbortedUserSuppress(state._abortedUserSuppressCounts, draft.text),
  };
}

interface ChatState {
  messages: ChatMessage[];
  sending: boolean;
  streaming: boolean;
  /** True while gateway embedded_run is compacting context (agent stream: compaction). */
  compacting: boolean;
  streamText: string | null;
  runId: string | null;
  sessionKey: string;
  lastError: string | null;
  /** Structured diagnosis for the current lastError (kind / suggestion /
   *  retryable / raw provider text). Always set and cleared TOGETHER with
   *  lastError — a stale meta must never gate the Retry button. */
  lastErrorMeta: RunFailureInfo | null;
  /** True after a non-user abort (gateway timeout / system stop) — gates the
   *  "continue" affordance (inline button + top banner). Cleared on the next
   *  send/continue or when the error is dismissed. */
  canContinue: boolean;
  tokensIn: number;
  tokensOut: number;
  /** Set when a seq gap is detected during streaming — cleared after deferred reload. */
  _pendingGapReload: boolean;
  /** Set to the active runId when the USER clicks stop. Lets the 'aborted' handler
   *  tell a user-initiated abort (silent) apart from a timeout/system abort (offer
   *  continue). Consumed and reset to null when the matching 'aborted' arrives. */
  _userAbortedRunId: string | null;
  /** Agent lifecycle errors can be followed by a delayed chat:error for the
   *  same run. Remember the lifecycle-terminal run so the duplicate frame
   *  cannot overwrite a partial-output "continue" recovery with "resend". */
  _lastAgentFailureRunId: string | null;
  /**
   * Optimistic user messages added to messages[] before the gateway persists them
   * to the session transcript. When the gateway queues messages behind an active
   * run (collect mode), the transcript won't contain them. loadHistory() uses
   * this array to preserve ALL pending messages across transcript reloads.
   * Cleared when: matching final event arrives (all resolved), or session switches.
   * Auto-expires after 3 minutes to prevent stale messages from sticking.
   */
  _pendingUserMsgs: ChatMessage[];
  /** Local-only chat lines (staged-writing progress, etc.) — survive loadHistory(). */
  _localOnlyMsgs: ChatMessage[];
  /**
   * Timestamp when streaming started (RPC ACK received). Used to prevent
   * false-positive queue-drain detection from quick heartbeat/cron finals.
   */
  _streamStartedAt: number | null;
  /** Timestamp of last received chat delta. Used only to schedule an additional
   *  authoritative Session comparison after a quiet interval. */
  _lastDeltaAt: number | null;
  /** Timestamp of the most recent WS reconnect while a run was in-flight.
   *  Preserved as a transport observation; cleared on the next run event. */
  _reconnectedAt: number | null;
  /** Last user send for the active run — cleared on final or after abort restore. */
  _lastSentDraft: LastSentDraft | null;
  /** Exact chat.send generation whose RPC outcome is transport-uncertain.
   * Persisted per session across F5; it is evidence for reconciliation only and
   * is never replayed automatically. */
  _pendingSendAck: PendingSendAck | null;
  /** Per-text suppress counts — aborted sends stay out after loadHistory(). */
  _abortedUserSuppressCounts: Record<string, number>;
  /** Set on abort; MessageInput consumes and clears via clearInputRestore(). */
  inputRestore: ChatInputRestore | null;
  /** Bumped on each restore so MessageInput re-applies even if text is unchanged. */
  inputRestoreSeq: number;

  send: (text: string, attachments?: ChatAttachment[], options?: { displayText?: string; references?: string[] }) => Promise<void>;
  /** Append a message that never goes to gateway — kept across loadHistory(). */
  appendLocalMessage: (message: ChatMessage) => void;
  abort: () => void;
  clearInputRestore: () => void;
  loadHistory: () => Promise<void>;
  loadSessionUsage: () => Promise<void>;
  handleChatEvent: (event: ChatStreamEvent) => void;
  /** Agent event stream: lifecycle/error failures surfaced without chat.final body */
  handleAgentFailureEvent: (payload: unknown) => void;
  /** Agent event stream: { stream: "compaction", data: { phase: "start" | "end" } } */
  handleCompactionAgentEvent: (payload: unknown) => void;
  /** Called by gateway onGap — debounced reload when idle, deferred when streaming. */
  onGapDetected: () => void;
  setSessionKey: (key: string) => void;
  clearError: () => void;
  /** Resend the last draft after a retryable failure — new run, new
   *  idempotencyKey. No-op while a run is active or without a saved draft. */
  retry: () => void;
  /** Resume after a timeout/system abort — sends a continuation instruction and
   *  clears canContinue. No-op if a run is already active. */
  continueRun: () => void;
  updateTokens: (input: number, output: number) => void;
}

// Restore pending messages from sessionStorage on module load (survives F5).
const _restoredPendingMsgs = loadPendingMsgs();
const _restoredLocalMsgs = loadLocalMsgs('main');
const _restoredPendingSendAck = loadPendingSendAck('main');

export const useChatStore = create<ChatState>()((set, get) => ({
  // Initialize messages with restored pending so they're visible immediately
  // after F5, before WS reconnects and loadHistory() runs.
  messages: mergeLocalMessages(_restoredPendingMsgs, _restoredLocalMsgs),
  sending: false,
  streaming: false,
  compacting: false,
  streamText: null,
  runId: _restoredPendingSendAck?.runId ?? null,
  sessionKey: 'main',
  lastError: null,
  lastErrorMeta: null,
  canContinue: false,
  tokensIn: 0,
  tokensOut: 0,
  _pendingGapReload: false,
  _userAbortedRunId: null,
  _lastAgentFailureRunId: null,
  _pendingUserMsgs: _restoredPendingMsgs,
  _localOnlyMsgs: _restoredLocalMsgs,
  _streamStartedAt: null, _lastDeltaAt: null, _reconnectedAt: null,
  _lastSentDraft: null,
  _pendingSendAck: _restoredPendingSendAck,
  inputRestore: null,
  inputRestoreSeq: 0,
  _abortedUserSuppressCounts: {},

  clearInputRestore: () => set({ inputRestore: null }),

  onGapDetected: () => {
    if (!get().streaming && !get().sending) {
      // Idle & not mid-send: debounced reload — batches multiple rapid gaps into one RPC.
      // The `sending` guard prevents reloads during the chat.send RPC await window,
      // where the optimistic user message isn't in the transcript yet (gateway queues
      // it in-memory in collect mode, NOT on disk).
      if (_gapDebounceTimer) clearTimeout(_gapDebounceTimer);
      _gapDebounceTimer = setTimeout(() => {
        _gapDebounceTimer = null;
        get().loadHistory();
      }, GAP_DEBOUNCE_MS);
    } else {
      // Streaming or mid-send: defer reload to avoid wiping streamText / optimistic
      // messages. The pending flag is consumed when streaming ends (final/aborted/error).
      set({ _pendingGapReload: true });
    }
  },

  send: async (text: string, attachments?: ChatAttachment[], options?: { displayText?: string; references?: string[] }) => {
    const client = useGatewayStore.getState().client;
    if (!client || !client.isConnected) {
      set({ lastError: i18n.t('chat.notConnected'), lastErrorMeta: null });
      return;
    }

    // Empty message guard — matches OpenClaw sendChatMessage (chat.ts:160-164):
    //   const msg = message.trim();
    //   const hasAttachments = attachments && attachments.length > 0;
    //   if (!msg && !hasAttachments) { return null; }
    const trimmed = text.trim();
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    const hasReferences = (options?.references?.length ?? 0) > 0;
    if (!trimmed && !hasAttachments && !hasReferences) {
      return;
    }

    // ── Slash command interception ──
    // Intercept executeLocal commands client-side (like OC native UI does)
    // instead of sending them as chat messages to the agent.
    // Source: openclaw/ui/src/ui/app-chat.ts:212-236
    const parsed = parseSlashCommand(trimmed);
    if (parsed?.command.executeLocal) {
      try {
        if (parsed.command.name === 'clear') {
          // Align with gateway sessions.reset cleanup (embedded runs, queues).
          get().abort();
        }
        const result = await executeSlashCommand(
          client, get().sessionKey, parsed.command.name, parsed.args,
        );

        // Handle side effects BEFORE injecting the system message, so that
        // refresh-action commands (e.g. /compact) don't lose the result.
        // loadHistory() replaces messages[] — we must inject the system
        // message AFTER it runs, not before.
        switch (result.action) {
          case 'refresh':
            await get().loadHistory();
            get().loadSessionUsage();
            break;
          case 'stop':
            get().abort();
            break;
          case 'new-session':
            useSessionsStore.getState().createSession();
            break;
          case 'clear': {
            const sk = get().sessionKey;
            const next = result.nextSessionKey ?? sk;
            if (normalizeSessionKey(next) !== normalizeSessionKey(sk)) {
              // switchSession already calls loadHistory + loadSessionUsage
              useSessionsStore.getState().switchSession(next);
            } else {
              get().setSessionKey(sk);
              // Same session — must reload explicitly since switchSession won't fire
              await get().loadHistory();
              await get().loadSessionUsage();
            }
            break;
          }
          case 'clear-local-fallback':
            stopStaleStreamWatchdog();
            set({
              messages: [],
              streaming: false,
              streamText: null,
              runId: null,
              sending: false,
              lastError: null,
              lastErrorMeta: null,
              _pendingGapReload: false,
              _pendingUserMsgs: [],
              _streamStartedAt: null,
              _lastDeltaAt: null,
              _reconnectedAt: null,
            });
            break;
        }

        // Display command input as user message + result as system message
        // (appended after side effects so they survive loadHistory refresh)
        if (result.content) {
          const userMsg: ChatMessage = { role: 'user', text: trimmed, timestamp: Date.now() };
          const sysMsg: ChatMessage = { role: 'system', text: result.content, timestamp: Date.now() };
          set((s) => ({ messages: [...s.messages, userMsg, sysMsg] }));
        }
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : i18n.t('chat.commandFailed'), lastErrorMeta: null });
      }
      return; // Don't send to agent
    }

    const displayText = options?.displayText?.trim() || text;
    const refPaths = dedupePaths(options?.references ?? []);
    const fileRefPaths = refPaths.filter((p) => !isImagePath(p));

    // Built-in staged writing: full-paper requests run as Dashboard-orchestrated cron steps
    // (file-based completion) instead of one long chat agent run.
    if (!hasAttachments) {
      const writingIntent = detectStagedWritingIntent(trimmed);
      if (writingIntent) {
        const staged = useStagedWritingStore.getState();
        const currentSessionKey = get().sessionKey;
        const sameSessionJob = isStagedWritingJobForSession(staged.job, currentSessionKey)
          ? staged.job
          : null;
        const shouldBypassCompletedWritingJob =
          writingIntent.mode === 'start'
          && sameSessionJob?.status === 'completed'
          && !isExplicitStagedWritingRestart(trimmed);

        if (shouldBypassCompletedWritingJob) {
          // A completed staged-writing job remains in the UI so users can open
          // generated files. Do not let that completed workflow hijack later
          // ordinary prompts unless the user explicitly asks to restart it.
        } else {
          const userMessage: ChatMessage = {
            role: 'user',
            text: displayText,
            timestamp: Date.now(),
          };
          get().appendLocalMessage(userMessage);
          set({ lastError: null, lastErrorMeta: null });

          if (staged.job && !isStagedWritingJobForSession(staged.job, currentSessionKey)) {
            if (writingIntent.mode === 'scan' || writingIntent.mode === 'resume') {
              set({ lastError: i18n.t('stagedWriting.chatWrongSession'), lastErrorMeta: null });
              return;
            }
            if (staged.job.status === 'running') {
              set({ lastError: i18n.t('stagedWriting.chatRunningOtherSession'), lastErrorMeta: null });
              return;
            }
          }

          if (writingIntent.mode === 'scan') {
            if (!staged.job) {
              set({ lastError: i18n.t('stagedWriting.chatNoJob'), lastErrorMeta: null });
              return;
            }
            await staged.syncStageFiles();
            return;
          }

          if (writingIntent.mode === 'resume') {
            if (!staged.job) {
              set({ lastError: i18n.t('stagedWriting.chatNoJob'), lastErrorMeta: null });
              return;
            }
            if (staged.job.status === 'running') {
              set({ lastError: i18n.t('stagedWriting.chatAlreadyRunning'), lastErrorMeta: null });
              return;
            }
            const ok = await staged.resumeJob();
            if (!ok) {
              const afterJob = useStagedWritingStore.getState().job;
              set({ lastError: afterJob?.lastError ?? i18n.t('stagedWriting.chatNoJob'), lastErrorMeta: null });
            }
            return;
          }

          if (staged.job?.status === 'running') {
            set({ lastError: i18n.t('stagedWriting.chatAlreadyRunning'), lastErrorMeta: null });
            return;
          }

          const contextText = buildStagedWritingContext(get().messages);
          const contextualSourcePaths = extractStagedWritingSourcePaths(contextText);
          const ok = await staged.startJobFromChat({
            sessionKey: currentSessionKey,
            topic: writingIntent.topic,
            slug: writingIntent.slug,
            sourcePaths: [...new Set([...writingIntent.sourcePaths, ...contextualSourcePaths])],
            venue: writingIntent.venue,
            contextText,
          });
          if (!ok) {
            const job = useStagedWritingStore.getState().job;
            set({ lastError: job?.lastError ?? i18n.t('chat.sendFailed'), lastErrorMeta: null });
          }
          return;
        }
      }
    }

    let outboundText = text;
    if (!hasAttachments) {
      const longTask = detectLongTaskIntent(trimmed, {
        references: fileRefPaths,
        hasAttachments,
      });
      // Explicit "后台/长任务/子会话" requests are promoted silently — the user
      // asked for it. Heuristic-only matches are the false-positive-prone case,
      // so confirm before changing behaviour from "answer now" to "spawn a
      // background subagent". Declining falls through to a normal inline turn.
      const promoteSilently = shouldPromoteLongTaskWithoutConfirmation(longTask);
      const promote = longTask.shouldAutoTrack
        && (promoteSilently || await confirmHeuristicLongTask(longTask.title));
      if (promote) {
        try {
          const submitted = await client.request<{ job: { id: string; title: string } }>('rc.longTask.submit', {
            message: trimmed,
            display_title: longTask.title,
            session_key: get().sessionKey,
            references: fileRefPaths,
            detection: {
              score: longTask.score,
              reasons: longTask.reasons,
            },
          });
          outboundText = buildAutoLongTaskPrompt({
            jobId: submitted.job.id,
            title: submitted.job.title,
            originalMessage: text,
            references: fileRefPaths,
          });
          useUiStore.getState().setRightPanelTab('jobs');
          void useJobsStore.getState().loadJobs();
        } catch (err) {
          console.warn('[Chat] Long task auto-submit failed:', err);
          set({ lastError: err instanceof Error ? err.message : i18n.t('chat.sendFailed'), lastErrorMeta: null });
          return;
        }
      }
    }

    // Match OC pattern: generate runId locally and set BEFORE the RPC call.
    // OC uses the idempotencyKey as chatRunId (chat.ts:194-195) so delta events
    // can match immediately, with no timing gap between RPC send and response.
    // Source: openclaw/ui/src/ui/controllers/chat.ts:192-196
    const localRunId = crypto.randomUUID();
    const sendSessionKey = get().sessionKey;
    clearPersistedPendingSendAck(sendSessionKey);

    // Non-image references render as chips in the user bubble (images already
    // show as thumbnails). Persisted on the optimistic message; reconstructed
    // from the injected reference block after a history reload (MessageBubble).
    // Build user message — include content blocks for display when attachments present
    const userMessage: ChatMessage = {
      role: 'user',
      text: displayText,
      content: attachments?.length
        ? [
            ...(displayText ? [{ type: 'text' as const, text: displayText }] : []),
            ...attachments.map((att) => ({
              type: 'image' as const,
              source: { type: 'base64', media_type: att.mimeType, data: att.dataUrl },
            })),
          ]
        : undefined,
      references: fileRefPaths.length > 0 ? fileRefPaths : undefined,
      timestamp: Date.now(),
      idempotencyKey: `${localRunId}:user`,
    };

    set((s) => ({
      messages: [...s.messages, userMessage],
      sending: true,
      lastError: null,
      lastErrorMeta: null,
      canContinue: false,
      _userAbortedRunId: null,
      _lastAgentFailureRunId: null,
      streamText: null,
      runId: localRunId,
      _pendingUserMsgs: [...s._pendingUserMsgs, userMessage],
      _lastSentDraft: {
        text: displayText,
        attachments: cloneAttachments(attachments),
        references: [...refPaths],
        runId: localRunId,
      },
      inputRestore: null,
      _pendingSendAck: null,
    }));
    useSessionRunsStore.getState().setLocalRunId(sendSessionKey, localRunId);
    useSessionRunsStore.getState().setCommand(sendSessionKey, 'submitting');
    useSessionRunsStore.getState().observeActivity({
      sessionKey: sendSessionKey,
      runId: localRunId,
      kind: 'submitting',
      label: 'submitting',
      observedAt: Date.now(),
      source: 'local-ack',
    });
    useTaskFlowStore.getState().startRun(localRunId, get().sessionKey, {
      userTimestamp: userMessage.timestamp,
      userText: displayText,
      idempotencyKey: userMessage.idempotencyKey,
    });

    try {
      // Convert attachments to RPC format
      const rpcAttachments = attachments?.map((att, idx) => {
        const match = /^data:[^;]+;base64,(.+)$/.exec(att.dataUrl);
        const content = match ? match[1] : att.dataUrl;
        const ext = att.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
        return {
          type: 'image',
          mimeType: att.mimeType,
          fileName: `image-${idx + 1}.${ext}`,
          content,
          // Already-in-workspace images (workspace drag / external ingest) carry
          // their path so we skip re-saving a duplicate copy.
          wsPath: att.wsPath,
        };
      });

      // -----------------------------------------------------------------
      // Unified image handling:
      //
      // OpenClaw does NOT persist image data in chat.history (it strips
      // base64 from content blocks on purpose). So chat images disappear
      // after refresh. Additionally, text-only primary models cause
      // detectAndLoadPromptImages to silently DROP all chat attachments.
      //
      // Solution: ALWAYS save images to workspace for persistence +
      // agent access. Then:
      //   - Vision primary: also send as attachments (inline to model)
      //   - Text-only primary: only send file paths (agent uses /image tool)
      //
      // Workspace paths are embedded as [rc-image:sources/chat/images/xxx.png] markers
      // in the message text, which MessageBubble can detect and render
      // after history reload.
      // -----------------------------------------------------------------
      let finalMessage = outboundText;
      let finalAttachments = rpcAttachments;
      // F5/§13.5: the send pipeline must use the SAME session-aware resolver as
      // the CameraDetail hint — not primaryModelSupportsVision() (config primary
      // only). Under a session /model override to a text-only model, the config
      // primary can still be vision-capable, so the old check inlined images the
      // model cannot read and the promised /image degradation never fired.
      // Fail-open: only a confirmed `false` routes to the /image degradation
      // path; `true` and `'unknown'` keep the inline behavior.
      const visionCapable = resolveVisionSupport().supportsImage !== false;

      // No hard block on images: even without an inline-vision model, the image
      // is saved to the workspace and its path is handed to the agent, which may
      // still read it via tools (/image, OCR, code). The composer shows a soft
      // hint instead — never an interrupting block.

      if (rpcAttachments?.length) {
        const savedPaths: string[] = [];
        for (const att of rpcAttachments) {
          // Reuse the existing workspace path when the image is already there
          // (dragged from the workspace / ingested from an external drop).
          if (att.wsPath) {
            savedPaths.push(att.wsPath);
            continue;
          }
          const ts = Date.now();
          const safeName = att.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const wsPath = `${CHAT_IMAGE_DIR}/${ts}-${safeName}`;
          try {
            await client.request('rc.ws.saveImage', {
              path: wsPath,
              base64: att.content,
            });
            savedPaths.push(wsPath);
          } catch (err) {
            console.warn('[Chat] Failed to save image to workspace:', err);
          }
        }

        if (savedPaths.length > 0) {
          // Embed markers for MessageBubble to render after history reload
          const markers = savedPaths.map((p) => `[rc-image:${p}]`).join(' ');

          if (!visionCapable) {
            // Text-only primary: agent needs file paths for /image tool.
            // Paths are relative to workspace root (NOT prefixed with "workspace/")
            // because the /image tool already resolves relative to workspace.
            const pathList = savedPaths.join(', ');
            finalMessage = text
              + `\n\n${markers}`
              + `\n[User attached ${savedPaths.length} image(s): ${pathList}]`;
            finalAttachments = undefined; // would be dropped by gateway anyway
            console.log('[Chat] Text-only primary — images routed to workspace for /image tool');
          } else {
            // Vision primary: send attachments inline + markers for persistence
            finalMessage = text + (savedPaths.length ? `\n\n${markers}` : '');
            console.log('[Chat] Vision primary — images sent inline + saved to workspace');
          }
        }
      }

      // Inject file references (workspace drag / `@` mention / external ingest)
      // as a structured block so the workspace-scoped agent gets workspace-relative
      // paths it can read via workspace_read — no prompt-body pollution.
      if (fileRefPaths.length > 0) {
        finalMessage = appendReferenceBlock(finalMessage, fileRefPaths);
      }

      void syncSystemPromptAppendToGateway(useConfigStore.getState().systemPromptAppend);

      const rpcParams: PendingSendAck['params'] = {
        message: finalMessage,
        sessionKey: sendSessionKey,
        idempotencyKey: localRunId,
        deliver: false, // Don't deliver response to external channels (Telegram/Discord etc.)
        ...(finalAttachments?.length ? { attachments: finalAttachments } : {}),
      };
      const pendingAck: PendingSendAck = {
        sessionKey: sendSessionKey,
        runId: localRunId,
        runtimeConnId: useGatewayStore.getState().connId ?? null,
        createdAt: Date.now(),
        params: rpcParams,
      };
      persistPendingSendAck(pendingAck);
      set({ _pendingSendAck: pendingAck });

      const rawAck = await client.request<unknown>('chat.send', rpcParams);
      const ackRecord = rawAck && typeof rawAck === 'object'
        ? rawAck as Record<string, unknown>
        : {};
      const ackRunId = typeof ackRecord.runId === 'string' && ackRecord.runId.trim()
        ? ackRecord.runId.trim()
        : localRunId;
      const ackStatus = ackRecord.status === 'in_flight' || ackRecord.status === 'ok'
        ? ackRecord.status
        : 'started';
      clearPersistedPendingSendAck(sendSessionKey);
      if (normalizeSessionKey(get().sessionKey) === normalizeSessionKey(sendSessionKey)) {
        set({ _pendingSendAck: null });
      }

      if (ackStatus === 'ok') {
        stopStaleStreamWatchdog();
        if (normalizeSessionKey(get().sessionKey) === normalizeSessionKey(sendSessionKey)) {
          set({ ...clearActiveRunState(), _pendingSendAck: null });
        }
        useTaskFlowStore.getState().endRun(localRunId, 'done');
        useSessionRunsStore.getState().clearTransient(sendSessionKey, localRunId);
        if (normalizeSessionKey(get().sessionKey) === normalizeSessionKey(sendSessionKey)) {
          await get().loadHistory();
        }
      } else {
        if (normalizeSessionKey(get().sessionKey) === normalizeSessionKey(sendSessionKey)) {
          set({
            sending: false,
            streaming: true,
            runId: ackRunId,
            _streamStartedAt: Date.now(),
            _lastDeltaAt: null,
          });
        }
        const runs = useSessionRunsStore.getState();
        runs.setLocalRunId(sendSessionKey, ackRunId);
        runs.setCommand(sendSessionKey, 'idle');
        runs.observeActivity({
          sessionKey: sendSessionKey,
          runId: ackRunId,
          kind: 'processing',
          label: 'processing',
          observedAt: Date.now(),
          source: 'local-ack',
        });
        void runs.requestReconcile(sendSessionKey, 'chat.send-ack');
        if (normalizeSessionKey(get().sessionKey) === normalizeSessionKey(sendSessionKey)) {
          startStaleStreamWatchdog(get);
        }
      }
    } catch (err) {
      stopStaleStreamWatchdog();
      if (err instanceof GatewayRequestError) {
        const restore = buildAbortInputRestorePatch(get(), localRunId);
        clearPersistedPendingSendAck(sendSessionKey);
        if (normalizeSessionKey(get().sessionKey) === normalizeSessionKey(sendSessionKey)) {
          set({
            ...clearActiveRunState(),
            ...(restore ?? {}),
            _pendingSendAck: null,
            lastError: err.message,
            lastErrorMeta: classifyRunFailure(err.message),
          });
        }
        useTaskFlowStore.getState().endRun(localRunId, 'error');
        useSessionRunsStore.getState().clearTransient(sendSessionKey, localRunId);
      } else {
        // A timeout/socket close after transmission cannot prove rejection. Keep
        // the exact idempotency generation, reconcile read-only, and never replay.
        const pendingAck: PendingSendAck = get()._pendingSendAck ?? {
          sessionKey: sendSessionKey,
          runId: localRunId,
          runtimeConnId: useGatewayStore.getState().connId ?? null,
          createdAt: Date.now(),
          params: {
            message: outboundText,
            sessionKey: sendSessionKey,
            idempotencyKey: localRunId,
            deliver: false,
          },
        };
        persistPendingSendAck(pendingAck);
        if (normalizeSessionKey(get().sessionKey) === normalizeSessionKey(sendSessionKey)) {
          set({
            sending: false,
            streaming: false,
            compacting: false,
            streamText: null,
            runId: localRunId,
            _streamStartedAt: null,
            _lastDeltaAt: null,
            lastError: null,
            lastErrorMeta: null,
            _pendingSendAck: pendingAck,
          });
        }
        useTaskFlowStore.getState().endRun(localRunId, 'clear');
        const runs = useSessionRunsStore.getState();
        runs.setLocalRunId(sendSessionKey, localRunId);
        runs.setCommand(sendSessionKey, 'ack_unknown');
        runs.observeActivity({
          sessionKey: sendSessionKey,
          runId: localRunId,
          kind: 'unknown',
          label: 'ack_unknown',
          observedAt: Date.now(),
          source: 'local-ack',
        });
        void runs.requestReconcile(sendSessionKey, 'chat.send-ack-unknown');
        if (normalizeSessionKey(get().sessionKey) === normalizeSessionKey(sendSessionKey)) {
          void get().loadHistory();
        }
      }
    }
  },

  abort: () => {
    stopStaleStreamWatchdog();
    const { runId, sessionKey } = get();
    const sessionRun = useSessionRunsStore.getState();
    if (runId) sessionRun.setLocalRunId(sessionKey, runId);
    void sessionRun.requestAbort(sessionKey);

    // Restore input immediately on stop — do not wait for gateway 'aborted' event
    // (it may be delayed, missing, or carry a mismatched runId).
    const optimisticRestore = buildAbortInputRestorePatch(get(), runId ?? undefined);

    // If no runId, this is an orphan streaming state (e.g. after session switch
    // or reconnect). Clean up immediately — no server event will come.
    if (!runId) {
      set((s) => ({
        streaming: false,
        compacting: false,
        streamText: null,
        runId: null,
        _pendingUserMsgs: [],
        _streamStartedAt: null,
        _lastDeltaAt: null,
        ...(optimisticRestore ?? {}),
      }));
      return;
    }

    // Keep streamText until gateway 'aborted' (or timeout) so partial reply can be saved.
    // Tag this runId as user-aborted so the 'aborted' handler stays silent for it
    // (vs a gateway timeout, which should offer "continue").
    set((s) => ({
      streaming: false,
      compacting: false,
      _userAbortedRunId: runId,
      canContinue: false,
      ...(optimisticRestore ?? {}),
    }));

    // A local timer cannot prove that abort succeeded. If the terminal event is
    // delayed or lost, ask the Session authority and keep Stop state until it answers.
    const abortedRunId = runId;
    setTimeout(() => {
      if (get().runId === abortedRunId) {
        console.info('[Chat] Abort still pending — reconciling OC Session state');
        void useSessionRunsStore.getState().requestReconcile(sessionKey, 'abort-pending');
      }
    }, 3000);
  },

  loadHistory: async () => {
    const client = useGatewayStore.getState().client;
    if (!client || !client.isConnected) return;

    const requestedKey = get().sessionKey;
    const normalizedRequestedKey = normalizeSessionKey(requestedKey);
    const historyGeneration = (historyGenerationBySession.get(normalizedRequestedKey) ?? 0) + 1;
    historyGenerationBySession.set(normalizedRequestedKey, historyGeneration);
    const isCurrentRequest = () => (
      normalizeSessionKey(get().sessionKey) === normalizedRequestedKey
      && historyGenerationBySession.get(normalizedRequestedKey) === historyGeneration
    );
    try {
      const result = await client.request<{
        messages: ChatMessage[];
        sessionInfo?: SessionRunRowLike;
        inFlightRun?: { runId?: string; text?: string };
      }>('chat.history', {
        sessionKey: requestedKey,
        limit: 500,
      });
      // Guard both session identity and request generation. A → B → A can make
      // a key-only guard accept the first A response after the second A wins.
      if (!isCurrentRequest()) return;

      const eventEpoch = useGatewayStore.getState().eventEpoch ?? 0;
      const pendingAck = get()._pendingSendAck;
      const rawMessages = result.messages ?? [];
      const acceptedIndex = pendingAck
        ? rawMessages.findIndex((message) => (
            message.role === 'user'
            && message.idempotencyKey === `${pendingAck.runId}:user`
          ))
        : -1;
      const acceptedByHistory = acceptedIndex >= 0;
      const completedByHistory = acceptedByHistory
        && rawMessages.slice(acceptedIndex + 1).some((message) => message.role === 'assistant');
      const inFlightRunId = result.inFlightRun?.runId?.trim();
      const acceptedByInFlight = Boolean(
        pendingAck && inFlightRunId && inFlightRunId === pendingAck.runId,
      );
      if (pendingAck && (acceptedByHistory || acceptedByInFlight)) {
        clearPersistedPendingSendAck(requestedKey);
        set({ _pendingSendAck: null });
        useSessionRunsStore.getState().setCommand(requestedKey, 'idle');
      } else if (pendingAck) {
        // Neither an empty history nor an unrelated server run proves that the
        // exact idempotency generation was rejected. Preserve uncertainty.
        const runs = useSessionRunsStore.getState();
        runs.setLocalRunId(requestedKey, pendingAck.runId);
        runs.setCommand(requestedKey, 'ack_unknown');
      }
      if (result.sessionInfo) {
        useSessionRunsStore.getState().ingestSnapshot(result.sessionInfo, {
          eventEpoch,
          observedAt: Date.now(),
        });
      }
      if (inFlightRunId) {
        const text = result.inFlightRun?.text ?? '';
        const runs = useSessionRunsStore.getState();
        runs.ingestSessionEvent({
          sessionKey: requestedKey,
          runId: inFlightRunId,
          phase: 'start',
          status: 'running',
          hasActiveRun: true,
          ...(typeof result.sessionInfo?.startedAt === 'number'
            ? { startedAt: result.sessionInfo.startedAt }
            : {}),
        }, { eventEpoch, observedAt: Date.now() });
        runs.setLocalRunId(requestedKey, inFlightRunId);
        runs.setCommand(requestedKey, get()._pendingSendAck ? 'ack_unknown' : 'idle');
        runs.observeActivity({
          sessionKey: requestedKey,
          runId: inFlightRunId,
          kind: text ? 'streaming' : 'processing',
          label: text ? 'streaming' : 'processing',
          observedAt: Date.now(),
          source: 'chat-event',
        });
        set({
          runId: inFlightRunId,
          streaming: true,
          streamText: text || null,
          _streamStartedAt: result.sessionInfo?.startedAt ?? Date.now(),
          _lastDeltaAt: text ? Date.now() : null,
          _reconnectedAt: null,
        });
        startStaleStreamWatchdog(get);
      } else if (
        !get()._pendingSendAck
        && !selectSessionRunView(useSessionRunsStore.getState(), requestedKey).serverActive
      ) {
        set({
          streaming: false,
          compacting: false,
          streamText: null,
          runId: null,
          _streamStartedAt: null,
          _lastDeltaAt: null,
          _reconnectedAt: null,
        });
        if (completedByHistory) {
          useSessionRunsStore.getState().clearTransient(requestedKey, pendingAck?.runId);
        }
      }
      // Filter out toolResult messages — they are tool internals, not user-visible.
      // This matches OpenClaw Lit UI behavior (chat.ts:566).
      let restored = restoreExecutionBindings(requestedKey, result.messages ?? []);
      try {
        let turnStartedAt: number | undefined;
        const candidates: Array<{
          index: number;
          timestamp: number;
          textHashes: string[];
          turnStartedAt?: number;
        }> = [];
        restored.forEach((message, index) => {
          if (message.role === 'user') {
            turnStartedAt = message.timestamp;
            return;
          }
          if (message.role !== 'assistant' || message.executionRunId) return;
          candidates.push({
            index,
            timestamp: message.timestamp ?? 0,
            textHashes: Array.from(new Set([
              hashMessageText(extractRawText(message)),
              hashMessageText(extractText(message)),
            ])),
            ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
          });
        });
        if (candidates.length > 0) {
          const resolution = await client.request<{
            bindings?: Array<{ index: number; runId: string }>;
          }>('rc.execution.resolve', {
            sessionKey: toGatewaySessionKey(requestedKey),
            candidates,
          });
          if (!isCurrentRequest()) return;
          const byIndex = new Map(
            (resolution?.bindings ?? []).map((binding) => [binding.index, binding.runId]),
          );
          restored = restored.map((message, index) => {
            const executionRunId = byIndex.get(index);
            return executionRunId && !message.executionRunId
              ? { ...message, executionRunId }
              : message;
          });
        }
      } catch {
        // Older gateways do not expose the durable resolver. The privacy-safe
        // browser binding above remains a compatible best-effort fallback.
      }
      const visible = restored.filter((m) => isVisibleRole(m.role));
      // Strip system-injected context and channel relay attribution from user messages.
      // Uses unified sanitizeUserMessage() which handles all known injection patterns:
      // [Research-Claw] blocks, System: lines, channel attributions (ou_xxx:, [System:], etc.)
      const cleaned = visible
        .map((m) => {
          if (m.role !== 'user') return m;
          const rawText = extractText(m);
          const stripped = sanitizeUserMessage(rawText);
          if (!stripped) return null;
          // Preserve image content blocks from history (don't wipe content)
          // Only set text override; keep original content for image rendering
          return { ...m, text: stripped };
        })
        .filter(Boolean) as ChatMessage[];

      const filtered = filterAbortedUserMessagesFromTranscript(
        cleaned,
        get()._abortedUserSuppressCounts,
      );
      const cleanedAfterAbort = filtered.messages;
      const prunedSuppress = pruneAbortedUserSuppress(filtered.suppressCounts);
      if (prunedSuppress !== get()._abortedUserSuppressCounts) {
        set({ _abortedUserSuppressCounts: prunedSuppress });
      }

      // Fix: Preserve optimistic user messages when the gateway has queued them
      // (collect mode) but hasn't persisted them to the transcript yet.
      // Without this, loadHistory() replaces messages[] and pending messages
      // vanish because they only exist in the gateway's in-memory followup queue.
      const now = Date.now();
      const allPending = get()._pendingUserMsgs;
      // Remove expired entries
      const activePending = allPending.filter((m) =>
        m.timestamp && (now - m.timestamp) < PENDING_EXPIRY_MS,
      );

      if (activePending.length > 0) {
        // Filter out pending messages that are already in the transcript.
        // A pending message is "resolved" if the transcript contains a user message
        // whose text includes the pending text (covers both direct match and
        // collect-mode combined format "[Queued messages...]\nQueued #1\n你好").
        const transcriptUserTexts = cleanedAfterAbort
          .filter((m) => m.role === 'user')
          .map((m) => m.text ?? '');
        const stillPending = activePending.filter((p) => {
          const pText = p.text?.trim();
          if (!pText) return false;
          return !transcriptUserTexts.some((tt) => tt.includes(pText));
        });

        if (stillPending.length > 0) {
          // Insert pending messages at their chronological positions in the transcript.
          // This keeps the chat order correct (user msg above its response).
          const merged = mergeLocalMessages(
            mergeLocalMessages(cleanedAfterAbort, stillPending),
            get()._localOnlyMsgs,
          );
          set({ messages: merged, _pendingUserMsgs: stillPending });
        } else {
          // All pending messages now in transcript — clear
          set({
            messages: mergeLocalMessages(cleanedAfterAbort, get()._localOnlyMsgs),
            _pendingUserMsgs: [],
          });
        }
      } else {
        set({
          messages: mergeLocalMessages(cleanedAfterAbort, get()._localOnlyMsgs),
          _pendingUserMsgs: [],
        });
      }
    } catch {
      // History load failure is non-fatal
    }
  },

  loadSessionUsage: async () => {
    const client = useGatewayStore.getState().client;
    if (!client || !client.isConnected) return;

    try {
      const sessionKey = get().sessionKey;
      const result = await client.request<{
        totals: { input: number; output: number };
      }>('sessions.usage', {
        key: toGatewaySessionKey(sessionKey),
      });

      if (get().sessionKey !== sessionKey) return;

      const totals = result?.totals;
      console.log('[Chat] sessions.usage totals:', totals);
      set({
        tokensIn: totals?.input ?? 0,
        tokensOut: totals?.output ?? 0,
      });
    } catch (err) {
      console.warn('[Chat] loadSessionUsage failed:', err);
    }
  },

  handleCompactionAgentEvent: (payload: unknown) => {
    const evt = payload as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
      data?: { phase?: string };
    };
    if (evt.stream !== 'compaction' || !evt.data?.phase) return;

    if (
      evt.sessionKey
      && normalizeSessionKey(evt.sessionKey) !== normalizeSessionKey(get().sessionKey)
    ) {
      return;
    }

    const { runId } = get();
    if (evt.runId && runId && evt.runId !== runId) return;

    if (evt.data.phase === 'start') {
      set({ compacting: true });
      useTaskFlowStore.getState().handleCompaction(true);
      return;
    }
    if (evt.data.phase === 'end') {
      set({ compacting: false });
      useTaskFlowStore.getState().handleCompaction(false);
    }
  },

  handleAgentFailureEvent: (payload: unknown) => {
    const evt = payload as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
      data?: AgentFailureData;
    };

    // Session-less agent errors can belong to cron, heartbeat, or another
    // operator. They must never leak into whichever chat happens to be active.
    if (
      !evt.sessionKey
      || normalizeSessionKey(evt.sessionKey) !== normalizeSessionKey(get().sessionKey)
    ) {
      return;
    }

    const isStructuredOperationalError = Boolean(
      evt.stream === 'error'
      && (evt.data?.code || evt.data?.suggestion || evt.data?.capability),
    );
    const { runId, streaming, sending } = get();
    if (!streaming && !sending && !runId && !isStructuredOperationalError) return;
    // Gateway embedded runs may use an internal runId that differs from our
    // chat.send idempotencyKey — still surface failures for the active session.
    if (evt.runId && runId && evt.runId !== runId && !streaming && !sending) return;

    let failureText: string | null = null;
    if (evt.stream === 'lifecycle' && evt.data?.phase === 'error' && evt.data.error) {
      failureText = formatStructuredRunFailureForUser(evt.data);
    } else if (evt.stream === 'error' && evt.data?.reason) {
      failureText = formatStructuredRunFailureForUser(evt.data);
    }
    if (!failureText) return;

    // The real gateway can emit one or more assistant deltas and then terminate
    // with an agent lifecycle error without a separate chat:error frame. Preserve
    // that visible partial output before clearActiveRunState() clears streamText,
    // and classify the recovery action with the same partial-output context used
    // by chat:error / system-abort handling.
    const partialText = get().streamText?.trim() ? get().streamText : null;
    const rawFailure = String(evt.data?.reason ?? evt.data?.error ?? '');
    const failureInfo = classifyRunFailure(
      rawFailure,
      undefined,
      { origin: 'foreground', hasPartialOutput: Boolean(partialText) },
    );
    stopStaleStreamWatchdog();
    useTaskFlowStore.getState().endRun(runId, 'error');
    set((state) => ({
      ...clearActiveRunState(),
      messages: partialText
        ? [...state.messages, { role: 'assistant', text: partialText, timestamp: Date.now() }]
        : state.messages,
      sending: false,
      lastError: failureText,
      lastErrorMeta: {
        ...failureInfo,
        message: failureText,
      },
      canContinue: failureInfo.category === 'foreground-continue',
      _lastAgentFailureRunId: evt.runId ?? runId,
    }));
    void get().loadHistory();
  },

  handleChatEvent: (event: ChatStreamEvent) => {
    // Session isolation: drop events for non-active sessions.
    // Gateway canonicalizes keys: "project-xxx" → "agent:main:project-xxx".
    // Dashboard stores bare key, so normalize both sides before comparing.
    // Source: openclaw/src/gateway/server-methods/chat.ts:1189-1190
    if (normalizeSessionKey(event.sessionKey) !== normalizeSessionKey(get().sessionKey)) {
      return;
    }

    const { runId } = get();
    const pendingAck = get()._pendingSendAck;
    if (pendingAck && event.runId === pendingAck.runId) {
      clearPersistedPendingSendAck(pendingAck.sessionKey);
      set({ _pendingSendAck: null });
      useSessionRunsStore.getState().setCommand(pendingAck.sessionKey, 'idle');
    }

    // Accumulate token usage from any event that carries it
    if (event.usage) {
      const input = event.usage.input ?? 0;
      const output = event.usage.output ?? 0;
      if (input > 0 || output > 0) {
        get().updateTokens(input, output);
      }
    }

    // Stop the stale-streaming watchdog on TERMINAL events (final/aborted/error)
    // matching our current run. Delta events update _lastDeltaAt only to schedule
    // a later read-only Session comparison if the stream becomes quiet.
    if (!event.runId || !runId || event.runId === runId) {
      if (event.state !== 'delta') {
        stopStaleStreamWatchdog();
      }
    }

    switch (event.state) {
      case 'delta': {
        // Match OC triple-AND: skip only when BOTH runIds are set AND differ.
        // When runId is null (no active user chat), process ALL deltas —
        // this is critical for server-initiated runs (heartbeat, cron, sub-agents).
        // Source: openclaw/ui/src/ui/controllers/chat.ts:272
        if (event.runId && runId && event.runId !== runId) return;
        // Skip non-visible roles (e.g. toolResult deltas)
        if (event.message && !isVisibleRole(event.message.role)) return;
        if (event.message?.role === 'user') {
          const raw = extractText(event.message);
          if (isCronReminderInjection(raw)) return;
        }
        const deltaText = event.message ? extractText(event.message) : '';
        // Gateway sends full accumulated text in each delta (not incremental).
        // Match OpenClaw native UI: REPLACE stream text, taking the longer value.
        set((s) => {
          const current = s.streamText ?? '';
          const nextText = !current || deltaText.length >= current.length ? deltaText : current;
          if (nextText.trim()) {
            useTaskFlowStore.getState().handleStreamText(event.runId ?? runId, true);
          }
          return {
            streaming: true,
            streamText: nextText,
            _lastDeltaAt: Date.now(),
            // Fix 3: clear reconnect flag on first successful delta
            _reconnectedAt: null,
          };
        });
        break;
      }

      case 'final': {
        if (!event.message) {
          // MiniMax and some providers send final without a message body.
          // Clear streaming state and reload history to show the result.
          if (event.runId === runId || (get().streaming && !runId)) {
            const wasCompacting = get().compacting;
            set({
              ...clearActiveRunState(),
              // During context overflow auto-compaction / retry, providers may emit
              // a "final without message" for the first attempt. Clearing `compacting`
              // causes the UI to drop the status row and appear "silent".
              compacting: wasCompacting,
              _pendingGapReload: false,
            });
            void get().loadHistory().then(() => {
              // Don't classify as "no output" while we are mid-compaction/retry.
              if (!wasCompacting && detectRunEndedWithoutReply(get().messages)) {
                set({ lastError: i18n.t('chat.runEndedNoOutput'), lastErrorMeta: classifyRunFailure('') });
              }
            });
            useTaskFlowStore.getState().endRun(runId, wasCompacting ? 'clear' : 'done');
            setTimeout(() => {
              useLibraryStore.getState().loadPapers();
              useLibraryStore.getState().loadTags();
              useTasksStore.getState().loadTasks();
              useSessionsStore.getState().loadSessions();
              useMonitorStore.getState().loadMonitors();
              useCronStore.getState().loadPresets();
              useUiStore.getState().triggerWorkspaceRefresh();
              useUiStore.getState().checkNotifications();
              get().loadSessionUsage();
              void useSessionsStore.getState().autoNameSession(get().sessionKey);
            }, 500);
          }
          return;
        }
        // Skip tool result messages — not user-visible
        if (!isVisibleRole(event.message.role)) return;
        const text = extractText(event.message);
        if (isSilentReply(text)) return;
        if (event.message.role === 'user' && isCronReminderInjection(text)) return;

        const finalMsg: ChatMessage = {
          ...event.message,
          text,
          timestamp: event.message.timestamp ?? Date.now(),
          executionRunId: event.runId,
        };
        rememberExecutionBinding(get().sessionKey, finalMsg, event.runId);

        if (event.runId === runId) {
          // OC surface_error finals use the exact "Agent failed before reply"
          // contract. A naked warning emoji is ordinary answer content. Such a
          // final ENDS the run but is a
          // failure: keep the draft for Retry, and classify here so the Alert
          // appears deterministically — the follow-up agent-failure event may
          // be dropped by its own guards once this final clears runId (race
          // observed live: "⚠️ Agent failed before reply: Unknown model: …").
          const isSurfacedFailure =
            event.message.isError === true
            || /^(?:⚠️\s*)?(?:embedded\s+)?agent failed before reply:/i.test(text.trimStart());
          set((s) => ({
            messages: [...s.messages, finalMsg],
            streaming: false,
            compacting: false,
            streamText: null,
            runId: null,
            _pendingUserMsgs: [],
            _streamStartedAt: null, _lastDeltaAt: null, _reconnectedAt: null,
            _lastSentDraft:
              s._lastSentDraft?.runId === runId && !isSurfacedFailure
                ? null
                : s._lastSentDraft,
          }));
          if (isSurfacedFailure) {
            const surfacedFailure = classifyRunFailure(text);
            set({ lastError: surfacedFailure.message, lastErrorMeta: surfacedFailure });
            useTaskFlowStore.getState().endRun(runId, 'error');
          } else {
            useTaskFlowStore.getState().endRun(runId, 'done');
          }
          // After a full conversation turn, refresh panel data
          // (the LLM may have used tools that modified library/tasks/workspace)
          console.log('[Chat] Run complete → refreshing panel stores');
          setTimeout(() => {
            useLibraryStore.getState().loadPapers();
            useLibraryStore.getState().loadTags();
            useTasksStore.getState().loadTasks();
            useSessionsStore.getState().loadSessions();
            useCronStore.getState().loadPresets();
            useMonitorStore.getState().loadMonitors();
            useUiStore.getState().triggerWorkspaceRefresh();
            // Channel A: poll for deadline-based notifications
            useUiStore.getState().checkNotifications();
            // Refresh token usage from gateway transcript
            get().loadSessionUsage();
            void useSessionsStore.getState().autoNameSession(get().sessionKey);
          }, 500);

          // Channel B: extract notifications from card types in assistant message
          extractCardNotifications(text);

          // Deferred gap recovery: if a seq gap was detected during this streaming
          // run, reload history now to fill in any missed messages from other runs.
          // loadHistory() does a full REPLACE of messages[], so the finalMsg we just
          // pushed is overwritten by gateway truth — no duplication.
          if (get()._pendingGapReload) {
            set({ _pendingGapReload: false });
            get().loadHistory();
          }
        } else {
          // Sub-agent, heartbeat, cron, or different run — append message.
          // If this was a server-initiated run that we were streaming (runId was null),
          // clean up orphaned streaming state so UI doesn't stay stuck.
          //
          // Fix 4 — Queue-drain runId mismatch recovery:
          // When gateway queues our message (collect mode) and drains it later,
          // the drained run uses a NEW runId ≠ our localRunId. The response arrives
          // here (else branch) because event.runId !== runId. Detect this case:
          // we're streaming, never received any deltas (streamText is null), AND
          // we've been waiting long enough (>5s) to rule out quick heartbeat/cron finals.
          const isQueueDrainResponse = (() => {
            const s = get();
            if (!s.streaming || s.streamText || !s.runId || !s._streamStartedAt) return false;
            return Date.now() - s._streamStartedAt > 5000;
          })();

          set((s) => ({
            messages: [...s.messages, finalMsg],
            ...(isQueueDrainResponse
              // Don't clear _pendingUserMessages here — more queue-drain responses
              // may follow. Let loadHistory() handle them via the 3-min expiry.
              ? { streaming: false, compacting: false, streamText: null, runId: null, _streamStartedAt: null, _lastDeltaAt: null, _reconnectedAt: null }
              : s.streaming && !s.runId
                ? { streaming: false, compacting: false, streamText: null, _reconnectedAt: null }
                : {}),
          }));

          if (isQueueDrainResponse) {
            console.log('[Chat] Queue-drain response detected (runId mismatch, no prior deltas) — clearing streaming state');
            // Refresh panels since the queued run may have used tools
            setTimeout(() => {
              useLibraryStore.getState().loadPapers();
              useLibraryStore.getState().loadTags();
              useTasksStore.getState().loadTasks();
              useSessionsStore.getState().loadSessions();
              useMonitorStore.getState().loadMonitors();
              useCronStore.getState().loadPresets();
              useUiStore.getState().triggerWorkspaceRefresh();
              useUiStore.getState().checkNotifications();
              get().loadSessionUsage();
              void useSessionsStore.getState().autoNameSession(get().sessionKey);
            }, 500);
          }

          // Channel B: server-initiated runs (heartbeat, cron, monitor) also produce
          // card notifications (progress_card from heartbeat, monitor_digest from monitor).
          extractCardNotifications(text);
        }
        break;
      }

      case 'aborted': {
        // Fix 1 — runId guard: skip aborted events from OTHER runs (e.g. queryA aborting
        // while queryB is streaming). Without this, queryA's abort destroys queryB's state.
        // Uses the same triple-AND pattern as the delta handler (line 575).
        if (event.runId && runId && event.runId !== runId) return;

        // Distinguish a USER-initiated stop (abort() tagged _userAbortedRunId) from a
        // gateway/system abort (same 'aborted' event, no tag). Only the latter
        // surfaces an interruption + recovery affordance; user stops stay silent.
        const wasUserAbort = get()._userAbortedRunId !== null && get()._userAbortedRunId === runId;
        const partialText = get().streamText?.trim() ? get().streamText : null;
        if (wasUserAbort) {
          // Match restore to client runId (idempotencyKey), not gateway event.runId.
          set((s) => {
            const restore = buildAbortInputRestorePatch(s, runId);
            const restoredMessages = restore?.messages ?? s.messages;
            return {
              ...clearActiveRunState(),
              ...(restore ?? { _pendingUserMsgs: [] }),
              messages: partialText
                ? [...restoredMessages, { role: 'assistant', text: partialText, timestamp: Date.now() }]
                : restoredMessages,
              _userAbortedRunId: null,
              canContinue: false,
            };
          });
        } else {
          const explicitTimeout = event.stopReason === 'timeout' || event.errorKind === 'timeout';
          const interruptionMessage = explicitTimeout
            ? partialText
              ? i18n.t('chat.runTimedOut')
              : i18n.t('chat.runTimedOutNoOutput')
            : partialText
              ? i18n.t('chat.runInterrupted')
              : i18n.t('chat.runInterruptedNoOutput');
          const failureInfo = {
            ...classifyRunFailure(explicitTimeout ? 'request timed out' : 'request aborted', undefined, {
              origin: 'foreground',
              hasPartialOutput: Boolean(partialText),
            }),
            message: interruptionMessage,
            retryable: !partialText,
          };
          set((s) => ({
            ...clearActiveRunState(),
            messages: partialText
              ? [...s.messages, { role: 'assistant', text: partialText, timestamp: Date.now() }]
              : s.messages,
            _pendingUserMsgs: [],
            _userAbortedRunId: null,
            lastError: interruptionMessage,
            lastErrorMeta: failureInfo,
            canContinue: Boolean(partialText),
          }));
        }
        // Top-banner notification for gateway/system aborts (user stops stay silent).
        if (!wasUserAbort) {
          const explicitTimeout = event.stopReason === 'timeout' || event.errorKind === 'timeout';
          useUiStore.getState().addNotification({
            type: 'error',
            title: i18n.t('chat.runIssueNotificationTitle'),
            body: explicitTimeout
              ? partialText
                ? i18n.t('chat.runTimedOut')
                : i18n.t('chat.runTimedOutNoOutput')
              : partialText
                ? i18n.t('chat.runInterrupted')
                : i18n.t('chat.runInterruptedNoOutput'),
            dedupKey: `chat-run-interrupted:${get().sessionKey}:${runId ?? 'unknown'}`,
            targetSessionKey: get().sessionKey,
          });
        }
        // Deferred gap recovery
        if (get()._pendingGapReload) {
          set({ _pendingGapReload: false });
          get().loadHistory();
        }
        useTaskFlowStore.getState().endRun(runId, 'clear');
        break;
      }

      case 'error': {
        // Fix 1 — runId guard: skip error events from OTHER runs.
        // Same triple-AND pattern as delta/aborted.
        if (event.runId && runId && event.runId !== runId) return;
        // A lifecycle error is emitted immediately, while the corresponding
        // chat:error can arrive after provider/fallback teardown. The lifecycle
        // handler already persisted partial output and chose the recovery
        // action; processing the delayed duplicate would erase that context.
        if (
          event.runId
          && get()._lastAgentFailureRunId === event.runId
        ) return;

        // Classify with the gateway's own errorKind first; free-text sniffing
        // covers auth/network cases that upstream maps to "unknown".
        const partialText = get().streamText?.trim() ? get().streamText : null;
        const failureInfo = classifyRunFailure(
          event.errorMessage ?? '',
          event.errorKind,
          { origin: 'foreground', hasPartialOutput: Boolean(partialText) },
        );
        set((s) => ({
          ...clearActiveRunState(),
          messages: partialText
            ? [...s.messages, { role: 'assistant', text: partialText, timestamp: Date.now() }]
            : s.messages,
          _pendingUserMsgs: [],
          lastError: failureInfo.message,
          lastErrorMeta: failureInfo,
          canContinue: failureInfo.category === 'foreground-continue',
        }));
        // Deferred gap recovery
        if (get()._pendingGapReload) {
          set({ _pendingGapReload: false });
          get().loadHistory();
        }
        useTaskFlowStore.getState().endRun(runId, 'error');
        break;
      }
    }
  },

  setSessionKey: (key: string) => {
    // Clear all chat state for session switch.
    // Matches OC resetChatStateForSessionSwitch: clears chatStream, chatStreamStartedAt,
    // chatRunId, chatMessage, resets tool stream + scroll.
    stopStaleStreamWatchdog();
    useTaskFlowStore.getState().clear();
    const pendingAck = loadPendingSendAck(key);
    if (pendingAck) {
      const runs = useSessionRunsStore.getState();
      runs.setLocalRunId(key, pendingAck.runId);
      runs.setCommand(key, 'ack_unknown');
    }
    set({
      sessionKey: key,
      messages: loadLocalMsgs(key),
      streaming: false,
      compacting: false,
      streamText: null,
      runId: pendingAck?.runId ?? null,
      sending: false,
      lastError: null,
      lastErrorMeta: null,
      tokensIn: 0,
      tokensOut: 0,
      _pendingGapReload: false,
      _lastAgentFailureRunId: null,
      _pendingUserMsgs: [],
      _localOnlyMsgs: loadLocalMsgs(key),
      _streamStartedAt: null, _lastDeltaAt: null, _reconnectedAt: null,
      _lastSentDraft: null,
      _pendingSendAck: pendingAck,
      inputRestore: null,
      inputRestoreSeq: 0,
      _abortedUserSuppressCounts: {},
    });
  },

  appendLocalMessage: (message) => {
    set((s) => {
      if (localMessageExists(s.messages, message)) {
        return s;
      }
      const nextLocal = [...s._localOnlyMsgs, message];
      return {
        messages: [...s.messages, message],
        _localOnlyMsgs: nextLocal,
      };
    });
  },

  clearError: () => {
    set({ lastError: null, lastErrorMeta: null, canContinue: false });
  },

  continueRun: () => {
    // Guard: only resume when idle (no active run) and a continue is actually offered.
    if (get().streaming || get().sending || !get().canContinue) return;
    set({ canContinue: false, lastError: null, lastErrorMeta: null });
    void get().send(i18n.t('chat.continueInstruction'));
  },

  retry: () => {
    const { streaming, sending, _lastSentDraft, messages } = get();
    // Same idle guard as continueRun; a Retry during an active run would fork it.
    if (streaming || sending) return;
    const latestUserMessage = [...messages].reverse().find((message) =>
      message.role === 'user'
      && (Boolean(extractText(message).trim()) || Boolean(message.references?.length)),
    );
    const draft = _lastSentDraft ?? (latestUserMessage
      ? {
          text: extractText(latestUserMessage),
          attachments: [] as ChatAttachment[],
          references: [...(latestUserMessage.references ?? [])],
          runId: '',
        }
      : null);
    if (!draft) return;
    set({ lastError: null, lastErrorMeta: null, canContinue: false });
    // send() generates a fresh localRunId → fresh idempotencyKey: the failed
    // attempt was never persisted, so this is a NEW run, not a duplicate.
    void get().send(draft.text, draft.attachments, {
      references: draft.references,
    });
  },

  updateTokens: (input: number, output: number) => {
    set((s) => ({
      tokensIn: s.tokensIn + input,
      tokensOut: s.tokensOut + output,
    }));
  },
}));

// Auto-persist _pendingUserMsgs to sessionStorage whenever it changes.
// This ensures optimistic messages survive browser refresh (F5).
useChatStore.subscribe(
  (state, prev) => {
    if (state._pendingUserMsgs !== prev._pendingUserMsgs) {
      savePendingMsgs(state._pendingUserMsgs);
    }
    if (state._localOnlyMsgs !== prev._localOnlyMsgs) {
      saveLocalMsgs(state.sessionKey, state._localOnlyMsgs);
    }
  },
);

/** @internal Exported for tests only — start/stop the stale-stream watchdog. */
export const _testWatchdog = {
  start: () => startStaleStreamWatchdog(useChatStore.getState as () => ChatState),
  stop: stopStaleStreamWatchdog,
};
