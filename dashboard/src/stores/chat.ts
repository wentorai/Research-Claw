import { create } from 'zustand';
import type { ChatMessage, ChatStreamEvent, ChatAttachment } from '../gateway/types';
import { useGatewayStore } from './gateway';
import { useLibraryStore } from './library';
import { useTasksStore } from './tasks';
import { useToolStreamStore } from './tool-stream';
import { useTaskFlowStore } from './task-flow';
import { useSessionsStore } from './sessions';
import { useCronStore } from './cron';
import { useMonitorStore } from './monitor';
import { useUiStore } from './ui';
import { primaryModelSupportsVision, hasImageModelConfigured, useConfigStore } from './config';
import { syncSystemPromptAppendToGateway } from '../utils/sync-system-prompt-append';
import i18n from '../i18n';
import { sanitizeUserMessage, CRON_REMINDER_RE } from '../utils/sanitize-message';
import { sanitizeAssistantMessage } from '../utils/sanitize-assistant-message';
import { parseSlashCommand, executeSlashCommand } from '../utils/slash-commands';
import {
  detectStagedWritingIntent,
  extractStagedWritingSourcePaths,
  isExplicitStagedWritingRestart,
} from '../utils/staged-writing-detect';
import { isStagedWritingJobForSession } from '../utils/staged-writing-run';
import { useStagedWritingStore } from './staged-writing';

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

import { normalizeSessionKey, toGatewaySessionKey } from '../utils/session-key';

/**
 * Debounce timer for gap-triggered history reloads.
 * Module-level to avoid polluting Zustand store serialization.
 */
let _gapDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const GAP_DEBOUNCE_MS = 500;

/**
 * Stale-streaming watchdog.
 * Periodically checks if no chat delta has arrived within STALE_STREAM_TIMEOUT_MS.
 * Recovers via loadHistory() when the stream appears dead.
 *
 * Improvement over the original setTimeout approach: tracks _lastDeltaAt so it
 * can detect mid-stream connection deaths (where streamText is non-null but no
 * more deltas arrive), not just the "no first delta" case.
 *
 * Tool-aware recovery (Fix 1 — Plan B):
 * Instead of unconditionally skipping recovery when tools are pending, the
 * watchdog now checks each tool's `lastEventAt`. If ALL pending tools have
 * received no events for > STALE_TOOL_MS (120s), they are considered hung and
 * forcibly evicted, allowing recovery to proceed. This prevents a single hung
 * tool (e.g. SSH timeout) from blocking recovery indefinitely.
 *
 * Reconnect-aware timeout (Fix 3):
 * After a WS reconnect (_reconnectedAt is set), the watchdog uses a shorter
 * timeout (RECONNECT_STALE_MS = 15s) to speed up recovery when the run
 * completed during the disconnect window and no more deltas will arrive.
 *
 * Backup: the tick watchdog (client.ts) detects dead connections at the transport
 * layer and forces reconnect → loadHistory(), so this watchdog mainly covers the
 * "alive connection but stale model response" scenario.
 */
let _staleStreamWatchdog: ReturnType<typeof setInterval> | null = null;
const STALE_STREAM_TIMEOUT_MS = 60_000;
const STALE_WATCHDOG_CHECK_MS = 15_000;
/** Shorter stale timeout used after WS reconnect (Fix 3). */
const RECONNECT_STALE_MS = 15_000;
/** Max age (ms) for a pending tool with no events before watchdog treats it as hung. */
const WATCHDOG_TOOL_STALE_MS = 120_000;

const CONTEXT_OVERFLOW_RE = /context overflow|prompt too large|too large for the model/i;

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
  const trimmed = raw.trim();
  if (!trimmed) return i18n.t('chat.runEndedNoOutput');
  if (CONTEXT_OVERFLOW_RE.test(trimmed)) return i18n.t('chat.contextOverflow');
  if (trimmed.startsWith('⚠️') || trimmed.startsWith('Error:')) return trimmed;
  return trimmed;
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

function detectRunEndedWithoutReply(messages: ChatMessage[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return last.role === 'user';
}

function clearActiveRunState(): Pick<
  ChatState,
  'streaming' | 'compacting' | 'streamText' | 'runId' | '_streamStartedAt' | '_lastDeltaAt' | '_reconnectedAt'
> {
  return {
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
    // Context compaction can run for several minutes with no chat deltas.
    if (s.compacting) return;
    const lastActivity = s._lastDeltaAt ?? s._streamStartedAt;
    if (!lastActivity) return;

    // Fix 3: use shorter timeout after reconnect
    const effectiveTimeout = s._reconnectedAt ? RECONNECT_STALE_MS : STALE_STREAM_TIMEOUT_MS;
    const gap = Date.now() - lastActivity;
    if (gap > effectiveTimeout) {
      // Fix 1 (Plan B): check tool staleness via lastEventAt
      const pendingTools = useToolStreamStore.getState().pendingTools;
      if (pendingTools.length > 0) {
        const now = Date.now();
        const allStale = pendingTools.every(t => now - t.lastEventAt >= WATCHDOG_TOOL_STALE_MS);
        if (!allStale) return; // some tools still active — keep waiting
        // All tools are hung — force-evict and proceed with recovery
        useToolStreamStore.setState({ pendingTools: [] });
      }

      stopStaleStreamWatchdog();
      const staleRunId = s.runId;
      console.log(`[Chat] Stale streaming detected (${Math.round(gap / 1000)}s since last activity, reconnect=${!!s._reconnectedAt}) — recovering via loadHistory`);
      useTaskFlowStore.getState().endRun(staleRunId, 'error');
      useChatStore.setState(clearActiveRunState());
      void useChatStore.getState().loadHistory().then(() => {
        if (detectRunEndedWithoutReply(useChatStore.getState().messages)) {
          useChatStore.setState({ lastError: i18n.t('chat.runEndedNoOutput') });
        } else {
          const message = i18n.t('chat.runStoppedAfterStaleStream');
          useChatStore.setState({ lastError: message });
          useUiStore.getState().addNotification({
            type: 'error',
            title: i18n.t('chat.runIssueNotificationTitle'),
            body: message,
            dedupKey: `chat-stale-stream:${s.sessionKey}:${staleRunId ?? 'unknown'}`,
            targetSessionKey: s.sessionKey,
          });
        }
      });
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
function extractText(msg: ChatMessage): string {
  // Get raw text — only from type:'text' blocks (NOT type:'thinking')
  // This matches OpenClaw's extractRawText (message-extract.ts:92-100)
  let raw: string;
  if (msg.text) {
    raw = msg.text;
  } else if (typeof msg.content === 'string') {
    raw = msg.content;
  } else if (Array.isArray(msg.content)) {
    raw = msg.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('');
  } else {
    raw = '';
  }

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
}

interface LastSentDraft extends ChatInputRestore {
  runId: string;
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

function isEmptyAbortedAssistantMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  const stopReason = message.stopReason;
  const errorCode = (message as { errorCode?: string }).errorCode;
  const errorMessage = (message as { errorMessage?: string }).errorMessage ?? '';
  const aborted =
    stopReason === 'aborted'
    || errorCode === '20'
    || /aborted/i.test(errorMessage);
  return aborted && extractText(message).trim().length === 0;
}

function removeEmptyAbortedTurns(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    const next = messages[i + 1];
    if (
      current?.role === 'user'
      && next
      && isEmptyAbortedAssistantMessage(next)
    ) {
      // The dashboard removes optimistic user input when a run is aborted.
      // If the gateway transcript later reloads the empty aborted turn, keep
      // the UI consistent by dropping both the cancelled user and empty reply.
      i += 1;
      continue;
    }
    out.push(current);
  }
  return out;
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
    inputRestore: { text: draft.text, attachments: draft.attachments },
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
  tokensIn: number;
  tokensOut: number;
  /** Set when a seq gap is detected during streaming — cleared after deferred reload. */
  _pendingGapReload: boolean;
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
  /** Timestamp of last received chat delta. Used by stale-stream watchdog to detect
   *  mid-stream deaths (connection alive but no more deltas arriving). */
  _lastDeltaAt: number | null;
  /** Timestamp of the most recent WS reconnect while a run was in-flight.
   *  When set, the stale-stream watchdog uses a shorter timeout (RECONNECT_STALE_MS)
   *  to speed up recovery. Cleared on first delta/final/aborted/error after reconnect. */
  _reconnectedAt: number | null;
  /** Last user send for the active run — cleared on final or after abort restore. */
  _lastSentDraft: LastSentDraft | null;
  /** Per-text suppress counts — aborted sends stay out after loadHistory(). */
  _abortedUserSuppressCounts: Record<string, number>;
  /** Set on abort; MessageInput consumes and clears via clearInputRestore(). */
  inputRestore: ChatInputRestore | null;
  /** Bumped on each restore so MessageInput re-applies even if text is unchanged. */
  inputRestoreSeq: number;

  send: (text: string, attachments?: ChatAttachment[], options?: { displayText?: string }) => Promise<void>;
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
  updateTokens: (input: number, output: number) => void;
}

// Restore pending messages from sessionStorage on module load (survives F5).
const _restoredPendingMsgs = loadPendingMsgs();
const _restoredLocalMsgs = loadLocalMsgs('main');

export const useChatStore = create<ChatState>()((set, get) => ({
  // Initialize messages with restored pending so they're visible immediately
  // after F5, before WS reconnects and loadHistory() runs.
  messages: mergeLocalMessages(_restoredPendingMsgs, _restoredLocalMsgs),
  sending: false,
  streaming: false,
  compacting: false,
  streamText: null,
  runId: null,
  sessionKey: 'main',
  lastError: null,
  tokensIn: 0,
  tokensOut: 0,
  _pendingGapReload: false,
  _pendingUserMsgs: _restoredPendingMsgs,
  _localOnlyMsgs: _restoredLocalMsgs,
  _streamStartedAt: null, _lastDeltaAt: null, _reconnectedAt: null,
  _lastSentDraft: null,
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

  send: async (text: string, attachments?: ChatAttachment[], options?: { displayText?: string }) => {
    const client = useGatewayStore.getState().client;
    if (!client || !client.isConnected) {
      set({ lastError: i18n.t('chat.notConnected') });
      return;
    }

    // Empty message guard — matches OpenClaw sendChatMessage (chat.ts:160-164):
    //   const msg = message.trim();
    //   const hasAttachments = attachments && attachments.length > 0;
    //   if (!msg && !hasAttachments) { return null; }
    const trimmed = text.trim();
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (!trimmed && !hasAttachments) {
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
        set({ lastError: err instanceof Error ? err.message : i18n.t('chat.commandFailed') });
      }
      return; // Don't send to agent
    }

    const displayText = options?.displayText?.trim() || text;

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
          set({ lastError: null });

          if (staged.job && !isStagedWritingJobForSession(staged.job, currentSessionKey)) {
            if (writingIntent.mode === 'scan' || writingIntent.mode === 'resume') {
              set({ lastError: i18n.t('stagedWriting.chatWrongSession') });
              return;
            }
            if (staged.job.status === 'running') {
              set({ lastError: i18n.t('stagedWriting.chatRunningOtherSession') });
              return;
            }
          }

          if (writingIntent.mode === 'scan') {
            if (!staged.job) {
              set({ lastError: i18n.t('stagedWriting.chatNoJob') });
              return;
            }
            await staged.syncStageFiles();
            return;
          }

          if (writingIntent.mode === 'resume') {
            if (!staged.job) {
              set({ lastError: i18n.t('stagedWriting.chatNoJob') });
              return;
            }
            if (staged.job.status === 'running') {
              set({ lastError: i18n.t('stagedWriting.chatAlreadyRunning') });
              return;
            }
            const ok = await staged.resumeJob();
            if (!ok) {
              const afterJob = useStagedWritingStore.getState().job;
              set({ lastError: afterJob?.lastError ?? i18n.t('stagedWriting.chatNoJob') });
            }
            return;
          }

          if (staged.job?.status === 'running') {
            set({ lastError: i18n.t('stagedWriting.chatAlreadyRunning') });
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
            set({ lastError: job?.lastError ?? i18n.t('chat.sendFailed') });
          }
          return;
        }
      }
    }

    // Match OC pattern: generate runId locally and set BEFORE the RPC call.
    // OC uses the idempotencyKey as chatRunId (chat.ts:194-195) so delta events
    // can match immediately, with no timing gap between RPC send and response.
    // Source: openclaw/ui/src/ui/controllers/chat.ts:192-196
    const localRunId = crypto.randomUUID();

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
      timestamp: Date.now(),
      idempotencyKey: `${localRunId}:user`,
    };

    set((s) => ({
      messages: [...s.messages, userMessage],
      sending: true,
      lastError: null,
      streamText: null,
      runId: localRunId,
      _pendingUserMsgs: [...s._pendingUserMsgs, userMessage],
      _lastSentDraft: {
        text: displayText,
        attachments: cloneAttachments(attachments),
        runId: localRunId,
      },
      inputRestore: null,
    }));
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
      // Workspace paths are embedded as [rc-image:sources/xxx.png] markers
      // in the message text, which MessageBubble can detect and render
      // after history reload.
      // -----------------------------------------------------------------
      let finalMessage = text;
      let finalAttachments = rpcAttachments;
      const visionCapable = primaryModelSupportsVision();

      // Scenario 3 guard: text-only primary, no imageModel configured.
      // The gateway would silently drop attachments AND there's no /image tool
      // fallback. Block the send with a clear error instead of a cryptic 400.
      if (rpcAttachments?.length && !visionCapable && !hasImageModelConfigured()) {
        set((s) => ({
          ...clearActiveRunState(),
          ...(buildAbortInputRestorePatch(s, localRunId) ?? { _pendingUserMsgs: [] }),
          sending: false,
          lastError: i18n.t('chat.imageNotSupported'),
        }));
        useTaskFlowStore.getState().endRun(localRunId, 'error');
        return;
      }

      if (rpcAttachments?.length) {
        const savedPaths: string[] = [];
        for (const att of rpcAttachments) {
          const ts = Date.now();
          const safeName = att.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const wsPath = `sources/${ts}-${safeName}`;
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

      void syncSystemPromptAppendToGateway(useConfigStore.getState().systemPromptAppend);

      await client.request('chat.send', {
        message: finalMessage,
        sessionKey: get().sessionKey,
        idempotencyKey: localRunId,
        deliver: false, // Don't deliver response to external channels (Telegram/Discord etc.)
        ...(finalAttachments?.length ? { attachments: finalAttachments } : {}),
      });
      set({ sending: false, streaming: true, _streamStartedAt: Date.now(), _lastDeltaAt: null });

      // Start stale-streaming watchdog. Checks every 15s if no delta has arrived
      // within 60s (covers both "no first delta" and "mid-stream death" scenarios).
      startStaleStreamWatchdog(get);
    } catch (err) {
      stopStaleStreamWatchdog();
      // Match OC chat.ts:226-230: clear runId + chatStream on failure.
      // Keep _pendingUserMessages so loadHistory() preserves the optimistic message.
      set({
        sending: false,
        streaming: false,
        compacting: false,
        streamText: null,
        runId: null,
        _streamStartedAt: null, _lastDeltaAt: null,
        lastError: err instanceof Error ? err.message : i18n.t('chat.sendFailed'),
      });
      useTaskFlowStore.getState().endRun(localRunId, 'error');
    }
  },

  abort: () => {
    stopStaleStreamWatchdog();
    const client = useGatewayStore.getState().client;
    const { runId, sessionKey } = get();

    // Restore input immediately on stop — do not wait for gateway 'aborted' event
    // (it may be delayed, missing, or carry a mismatched runId).
    const optimisticRestore = buildAbortInputRestorePatch(get(), runId ?? undefined);

    // Send abort RPC — with runId if available, session-level fallback if not.
    // Matches OC abortChatRun (chat.ts:250-253):
    //   runId ? { sessionKey, runId } : { sessionKey }
    if (client && client.isConnected) {
      const params = runId ? { runId, sessionKey } : { sessionKey };
      client.request('chat.abort', params).catch((err) => {
        console.warn('[Chat] Abort failed:', err);
      });
    }

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
    set((s) => ({
      streaming: false,
      compacting: false,
      ...(optimisticRestore ?? {}),
    }));

    // Safety: if server doesn't send 'aborted' event within 3s, force-clear runId.
    const abortedRunId = runId;
    useTaskFlowStore.getState().endRun(abortedRunId, 'clear');
    setTimeout(() => {
      if (get().runId === abortedRunId) {
        console.warn('[Chat] Abort timeout — force-clearing streaming state');
        const partialText = get().streamText;
        if (partialText) {
          set((s) => ({
            messages: [
              ...s.messages,
              { role: 'assistant' as const, text: partialText, timestamp: Date.now() },
            ],
            streamText: null,
            runId: null,
            _streamStartedAt: null,
            _lastDeltaAt: null,
            _pendingUserMsgs: [],
          }));
        } else {
          set({
            streamText: null,
            runId: null,
            _streamStartedAt: null,
            _lastDeltaAt: null,
            _pendingUserMsgs: [],
          });
        }
      }
    }, 3000);
  },

  loadHistory: async () => {
    const client = useGatewayStore.getState().client;
    if (!client || !client.isConnected) return;

    const requestedKey = get().sessionKey;
    try {
      const result = await client.request<{ messages: ChatMessage[] }>('chat.history', {
        sessionKey: requestedKey,
        limit: 500,
      });
      // Guard: discard stale response if session changed during the await
      if (get().sessionKey !== requestedKey) return;
      // Filter out toolResult messages — they are tool internals, not user-visible.
      // This matches OpenClaw Lit UI behavior (chat.ts:566).
      const visible = (result.messages ?? []).filter((m) => isVisibleRole(m.role));
      // Strip system-injected context and channel relay attribution from user messages.
      // Uses unified sanitizeUserMessage() which handles all known injection patterns:
      // [Research-Claw] blocks, System: lines, channel attributions (ou_xxx:, [System:], etc.)
      const cleaned = removeEmptyAbortedTurns(visible
        .map((m) => {
          if (m.role !== 'user') return m;
          const rawText = extractText(m);
          const stripped = sanitizeUserMessage(rawText);
          if (!stripped) return null;
          // Preserve image content blocks from history (don't wipe content)
          // Only set text override; keep original content for image rendering
          return { ...m, text: stripped };
        })
        .filter(Boolean) as ChatMessage[]);

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

      console.log('[Chat] sessions.usage totals:', result.totals);
      set({
        tokensIn: result.totals?.input ?? 0,
        tokensOut: result.totals?.output ?? 0,
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

    if (evt.sessionKey && normalizeSessionKey(evt.sessionKey) !== normalizeSessionKey(get().sessionKey)) {
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

    stopStaleStreamWatchdog();
    useTaskFlowStore.getState().endRun(runId, 'error');
    set({
      ...clearActiveRunState(),
      sending: false,
      lastError: failureText,
    });
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

    // Accumulate token usage from any event that carries it
    if (event.usage) {
      const input = event.usage.input ?? 0;
      const output = event.usage.output ?? 0;
      if (input > 0 || output > 0) {
        get().updateTokens(input, output);
      }
    }

    // Stop the stale-streaming watchdog on TERMINAL events (final/aborted/error)
    // matching our current run. Delta events update _lastDeltaAt instead, so the
    // watchdog can detect mid-stream deaths (connection alive but no more deltas).
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
                set({ lastError: i18n.t('chat.runEndedNoOutput') });
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
        };

        if (event.runId === runId) {
          set((s) => ({
            messages: [...s.messages, finalMsg],
            streaming: false,
            compacting: false,
            streamText: null,
            runId: null,
            _pendingUserMsgs: [],
            _streamStartedAt: null, _lastDeltaAt: null, _reconnectedAt: null,
            _lastSentDraft: s._lastSentDraft?.runId === runId ? null : s._lastSentDraft,
          }));
          useTaskFlowStore.getState().endRun(runId, 'done');
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

        // Match restore to client runId (idempotencyKey), not gateway event.runId.
        const partialText = get().streamText;
        if (partialText) {
          const abortedMsg: ChatMessage = {
            role: 'assistant',
            text: partialText,
            timestamp: Date.now(),
          };
          set((s) => {
            const restore = buildAbortInputRestorePatch(s, runId);
            return {
              messages: [...(restore?.messages ?? s.messages), abortedMsg],
              streaming: false,
              compacting: false,
              streamText: null,
              runId: null,
              _streamStartedAt: null,
              _lastDeltaAt: null,
              _reconnectedAt: null,
              ...(restore ?? { _pendingUserMsgs: [] }),
            };
          });
        } else {
          set((s) => {
            const restore = buildAbortInputRestorePatch(s, runId);
            return {
              streaming: false,
              compacting: false,
              streamText: null,
              runId: null,
              _streamStartedAt: null,
              _lastDeltaAt: null,
              _reconnectedAt: null,
              ...(restore ?? { _pendingUserMsgs: [] }),
            };
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

        set({
          ...clearActiveRunState(),
          _pendingUserMsgs: [],
          lastError: event.errorMessage
            ? formatRunFailureForUser(event.errorMessage)
            : i18n.t('chat.runEndedNoOutput'),
        });
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
    set({
      sessionKey: key,
      messages: loadLocalMsgs(key),
      streaming: false,
      compacting: false,
      streamText: null,
      runId: null,
      sending: false,
      lastError: null,
      tokensIn: 0,
      tokensOut: 0,
      _pendingGapReload: false,
      _pendingUserMsgs: [],
      _localOnlyMsgs: loadLocalMsgs(key),
      _streamStartedAt: null, _lastDeltaAt: null, _reconnectedAt: null,
      _lastSentDraft: null,
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
    set({ lastError: null });
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
