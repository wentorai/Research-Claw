import { create } from 'zustand';
import type { ChatMessage, ChatStreamEvent, ChatAttachment } from '../gateway/types';
import { useGatewayStore } from './gateway';
import { useLibraryStore } from './library';
import { useTasksStore } from './tasks';
import { useSessionsStore } from './sessions';
import { useCronStore } from './cron';
import { useMonitorStore } from './monitor';
import { useUiStore } from './ui';
import { primaryModelSupportsVision, hasImageModelConfigured } from './config';
import i18n from '../i18n';

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

/**
 * Debounce timer for gap-triggered history reloads.
 * Module-level to avoid polluting Zustand store serialization.
 */
let _gapDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const GAP_DEBOUNCE_MS = 500;

function isSilentReply(text: string | undefined): boolean {
  return text !== undefined && SILENT_REPLY_PATTERN.test(text);
}

/** Roles that should be displayed in the chat UI. */
const VISIBLE_ROLES = new Set(['user', 'assistant']);

/**
 * Strip system-injected context that OpenClaw stores inside user messages.
 *
 * Our `before_prompt_build` hook returns `{ prependContext }` which OpenClaw
 * persists as part of the user message. On history reload, these lines pollute
 * the displayed message. Two patterns are stripped:
 *
 *   1. `[Research-Claw] ...` header lines + their `  - ...` continuations
 *   2. `System: ...` lines (exec events, run commands, etc.)
 */
function stripInjectedContext(text: string): string {
  const lines = text.split('\n');
  const cleaned: string[] = [];
  let inRcBlock = false;

  for (const line of lines) {
    if (line.startsWith('[Research-Claw]')) {
      inRcBlock = true;
      continue;
    }
    // Indented continuation of an [Research-Claw] block
    if (inRcBlock && /^\s{2,}-\s/.test(line)) {
      continue;
    }
    inRcBlock = false;

    // All System: prefixed lines (exec events, run commands, etc.)
    if (/^System:\s/.test(line)) {
      continue;
    }

    cleaned.push(line);
  }

  return cleaned.join('\n').trim();
}

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
 * Strip leaked model control tokens from assistant text.
 * Source: openclaw/src/agents/pi-embedded-utils.ts:49-60 (stripModelSpecialTokens)
 *
 * Models like GLM-5 and DeepSeek sometimes leak internal delimiters:
 *   - ASCII pipes: <|assistant|>, <|tool_call_result_begin|>, <|end|>
 *   - Full-width pipes: <｜begin▁of▁sentence｜> (U+FF5C, used by DeepSeek)
 */
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

function stripModelSpecialTokens(text: string): string {
  if (!text) return text;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) return text;
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  return text.replace(MODEL_SPECIAL_TOKEN_RE, ' ').replace(/  +/g, ' ').trim();
}

/**
 * Regex matching `<think>`, `<thinking>`, `<thought>`, `<antthinking>` tags and their content.
 * Source: openclaw/src/shared/text/reasoning-tags.ts:7 (THINKING_TAG_RE)
 * Source: openclaw/ui/src/ui/chat/message-extract.ts:66
 *
 * We use a simpler approach than OpenClaw's full state-machine (which also handles
 * code-region awareness) since chat messages rarely contain code fences with these tags.
 */
const THINK_TAG_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

/**
 * Strip thinking/reasoning tags from text.
 * Matches OpenClaw behavior: message-extract.ts:10-11
 *   if (role === "assistant") return stripThinkingTags(text);
 */
function stripThinkingTags(text: string): string {
  THINK_TAG_RE.lastIndex = 0;
  return text.replace(THINK_TAG_RE, '').trimStart();
}

/**
 * Extract raw text from a ChatMessage, then strip thinking tags for assistant messages.
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

  // For assistant messages, strip thinking tags + model control tokens from text
  // Source: message-extract.ts:10-11, pi-embedded-utils.ts:49-60
  if (msg.role === 'assistant') {
    return stripModelSpecialTokens(stripThinkingTags(raw));
  }

  return raw;
}

interface ChatState {
  messages: ChatMessage[];
  sending: boolean;
  streaming: boolean;
  streamText: string | null;
  runId: string | null;
  sessionKey: string;
  lastError: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Set when a seq gap is detected during streaming — cleared after deferred reload. */
  _pendingGapReload: boolean;

  send: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  abort: () => void;
  loadHistory: () => Promise<void>;
  loadSessionUsage: () => Promise<void>;
  handleChatEvent: (event: ChatStreamEvent) => void;
  /** Called by gateway onGap — debounced reload when idle, deferred when streaming. */
  onGapDetected: () => void;
  setSessionKey: (key: string) => void;
  clearError: () => void;
  updateTokens: (input: number, output: number) => void;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  sending: false,
  streaming: false,
  streamText: null,
  runId: null,
  sessionKey: 'main',
  lastError: null,
  tokensIn: 0,
  tokensOut: 0,
  _pendingGapReload: false,

  onGapDetected: () => {
    if (!get().streaming) {
      // Idle: debounced reload — batches multiple rapid gaps into one RPC
      if (_gapDebounceTimer) clearTimeout(_gapDebounceTimer);
      _gapDebounceTimer = setTimeout(() => {
        _gapDebounceTimer = null;
        get().loadHistory();
      }, GAP_DEBOUNCE_MS);
    } else {
      // Streaming: defer reload to avoid wiping streamText / causing duplication.
      // The pending flag is consumed when streaming ends (final/aborted/error).
      set({ _pendingGapReload: true });
    }
  },

  send: async (text: string, attachments?: ChatAttachment[]) => {
    const client = useGatewayStore.getState().client;
    if (!client || !client.isConnected) {
      set({ lastError: 'Not connected to gateway' });
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

    // Build user message — include content blocks for display when attachments present
    const userMessage: ChatMessage = {
      role: 'user',
      text,
      content: attachments?.length
        ? [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...attachments.map((att) => ({
              type: 'image' as const,
              source: { type: 'base64', media_type: att.mimeType, data: att.dataUrl },
            })),
          ]
        : undefined,
      timestamp: Date.now(),
    };

    // Match OC pattern: generate runId locally and set BEFORE the RPC call.
    // OC uses the idempotencyKey as chatRunId (chat.ts:194-195) so delta events
    // can match immediately, with no timing gap between RPC send and response.
    // Source: openclaw/ui/src/ui/controllers/chat.ts:192-196
    const localRunId = crypto.randomUUID();

    set((s) => ({
      messages: [...s.messages, userMessage],
      sending: true,
      lastError: null,
      streamText: null,
      runId: localRunId,
    }));

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
      // Workspace paths are embedded as [rc-image:uploads/xxx.png] markers
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
        set({
          sending: false,
          lastError: i18n.t('chat.imageNotSupported'),
        });
        return;
      }

      if (rpcAttachments?.length) {
        const savedPaths: string[] = [];
        for (const att of rpcAttachments) {
          const ts = Date.now();
          const safeName = att.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const wsPath = `uploads/${ts}-${safeName}`;
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

      await client.request('chat.send', {
        message: finalMessage,
        sessionKey: get().sessionKey,
        idempotencyKey: localRunId,
        ...(finalAttachments?.length ? { attachments: finalAttachments } : {}),
      });
      set({ sending: false, streaming: true });
    } catch (err) {
      // Match OC chat.ts:226-230: clear runId + chatStream on failure
      set({
        sending: false,
        streaming: false,
        streamText: null,
        runId: null,
        lastError: err instanceof Error ? err.message : 'Failed to send message',
      });
    }
  },

  abort: () => {
    const client = useGatewayStore.getState().client;
    const { runId, sessionKey } = get();

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
      set({ streaming: false, streamText: null, runId: null });
      return;
    }

    // Safety: if server doesn't send 'aborted' event within 3s, force-clear streaming state.
    // Normal case: server responds → handleChatEvent clears state → runId is null → timeout is a no-op.
    // OC also does NOT clear state optimistically — it waits for the server's 'aborted' event.
    const abortedRunId = runId;
    setTimeout(() => {
      if (get().runId === abortedRunId) {
        console.warn('[Chat] Abort timeout — force-clearing streaming state');
        const partialText = get().streamText;
        if (partialText) {
          set((s) => ({
            messages: [...s.messages, { role: 'assistant' as const, text: partialText, timestamp: Date.now() }],
            streaming: false,
            streamText: null,
            runId: null,
          }));
        } else {
          set({ streaming: false, streamText: null, runId: null });
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
      });
      // Guard: discard stale response if session changed during the await
      if (get().sessionKey !== requestedKey) return;
      // Filter out toolResult messages — they are tool internals, not user-visible.
      // This matches OpenClaw Lit UI behavior (chat.ts:566).
      const visible = (result.messages ?? []).filter((m) => isVisibleRole(m.role));
      // Strip system-injected context from user messages (before_prompt_build prependContext,
      // exec event lines, etc.) and drop messages that become empty after stripping.
      const cleaned = visible
        .map((m) => {
          if (m.role !== 'user') return m;
          const rawText = extractText(m);
          const stripped = stripInjectedContext(rawText);
          if (!stripped) return null;
          // Preserve image content blocks from history (don't wipe content)
          // Only set text override; keep original content for image rendering
          return { ...m, text: stripped };
        })
        .filter(Boolean) as ChatMessage[];
      set({ messages: cleaned });
    } catch {
      // History load failure is non-fatal
    }
  },

  loadSessionUsage: async () => {
    const client = useGatewayStore.getState().client;
    if (!client || !client.isConnected) return;

    try {
      // Fetch aggregate token usage across all sessions (last 30 days default).
      // We deliberately omit `key` to avoid session key format mismatch:
      // the chat store uses 'main' but the gateway stores 'agent:main:main'.
      const result = await client.request<{
        totals: { input: number; output: number };
      }>('sessions.usage', {});

      console.log('[Chat] sessions.usage totals:', result.totals);
      set({
        tokensIn: result.totals?.input ?? 0,
        tokensOut: result.totals?.output ?? 0,
      });
    } catch (err) {
      console.warn('[Chat] loadSessionUsage failed:', err);
    }
  },

  handleChatEvent: (event: ChatStreamEvent) => {
    // Session isolation: drop events for non-active sessions.
    // Strict match with OC: openclaw/ui/src/ui/controllers/chat.ts:266
    //   if (payload.sessionKey !== state.sessionKey) return null;
    if (event.sessionKey !== get().sessionKey) {
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

    switch (event.state) {
      case 'delta': {
        // Match OC triple-AND: skip only when BOTH runIds are set AND differ.
        // When runId is null (no active user chat), process ALL deltas —
        // this is critical for server-initiated runs (heartbeat, cron, sub-agents).
        // Source: openclaw/ui/src/ui/controllers/chat.ts:272
        if (event.runId && runId && event.runId !== runId) return;
        // Skip non-visible roles (e.g. toolResult deltas)
        if (event.message && !isVisibleRole(event.message.role)) return;
        const deltaText = event.message ? extractText(event.message) : '';
        // Gateway sends full accumulated text in each delta (not incremental).
        // Match OpenClaw native UI: REPLACE stream text, taking the longer value.
        set((s) => {
          const current = s.streamText ?? '';
          return {
            streaming: true,
            streamText: !current || deltaText.length >= current.length ? deltaText : current,
          };
        });
        break;
      }

      case 'final': {
        if (!event.message) return;
        // Skip tool result messages — not user-visible
        if (!isVisibleRole(event.message.role)) return;
        const text = extractText(event.message);
        if (isSilentReply(text)) return;

        const finalMsg: ChatMessage = {
          ...event.message,
          text,
          timestamp: event.message.timestamp ?? Date.now(),
        };

        if (event.runId === runId) {
          set((s) => ({
            messages: [...s.messages, finalMsg],
            streaming: false,
            streamText: null,
            runId: null,
          }));
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
          set((s) => ({
            messages: [...s.messages, finalMsg],
            ...(s.streaming && !s.runId ? { streaming: false, streamText: null } : {}),
          }));

          // Channel B: server-initiated runs (heartbeat, cron, monitor) also produce
          // card notifications (progress_card from heartbeat, monitor_digest from monitor).
          extractCardNotifications(text);
        }
        break;
      }

      case 'aborted': {
        const partialText = get().streamText;
        if (partialText) {
          const abortedMsg: ChatMessage = {
            role: 'assistant',
            text: partialText,
            timestamp: Date.now(),
          };
          set((s) => ({
            messages: [...s.messages, abortedMsg],
            streaming: false,
            streamText: null,
            runId: null,
          }));
        } else {
          set({ streaming: false, streamText: null, runId: null });
        }
        // Deferred gap recovery
        if (get()._pendingGapReload) {
          set({ _pendingGapReload: false });
          get().loadHistory();
        }
        break;
      }

      case 'error': {
        set({
          streaming: false,
          streamText: null,
          runId: null,
          lastError: event.errorMessage ?? 'Unknown streaming error',
        });
        // Deferred gap recovery
        if (get()._pendingGapReload) {
          set({ _pendingGapReload: false });
          get().loadHistory();
        }
        break;
      }
    }
  },

  setSessionKey: (key: string) => {
    // Clear all chat state for session switch.
    // Matches OC resetChatStateForSessionSwitch: clears chatStream, chatStreamStartedAt,
    // chatRunId, chatMessage, resets tool stream + scroll.
    set({
      sessionKey: key,
      messages: [],
      streaming: false,
      streamText: null,
      runId: null,
      sending: false,
      lastError: null,
      tokensIn: 0,
      tokensOut: 0,
      _pendingGapReload: false,
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
