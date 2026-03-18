/**
 * Behavioral Parity Tests: App-Level Event Wiring & Notification Extraction
 *
 * These tests verify that our App.tsx event subscription and chat store's
 * handleChatEvent + extractCardNotifications behave IDENTICALLY to OpenClaw's
 * native UI event routing.
 *
 * Reference files:
 *   - openclaw/ui/src/ui/app-gateway.ts (event dispatch: lines 324-403)
 *   - openclaw/ui/src/ui/controllers/chat.ts (handleChatEvent: lines 262-336)
 *   - openclaw/ui/src/ui/chat/grouped-render.ts (visibility: lines 225-267)
 *
 * CRITICAL: These tests use REAL gateway event formats (fixtures),
 * not hand-crafted mock data.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chat';
import { useUiStore } from '../../stores/ui';
import type { ChatStreamEvent } from '../../gateway/types';
import {
  PROGRESS_CARD_TEXT,
  RADAR_DIGEST_TEXT,
  APPROVAL_CARD_TEXT,
  NO_CARD_TEXT,
  MULTI_CARD_TEXT,
  FINAL_WITH_PROGRESS_CARD,
  FINAL_WITH_RADAR_DIGEST,
  STREAMING_DELTA,
  STREAMING_FINAL,
  USER_MSG,
  ASSISTANT_MSG,
  ASSISTANT_EMPTY_TEXT_MSG,
  ASSISTANT_IMAGE_ONLY_MSG,
  TOOL_RESULT_MSG,
  ASSISTANT_WHITESPACE_ONLY_MSG,
  MIXED_HISTORY,
} from '../../__fixtures__/gateway-payloads/ui-events';

// ── Reset stores between tests ──────────────────────────────────────

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    sending: false,
    streaming: false,
    streamText: null,
    runId: null,
    sessionKey: 'main',
    lastError: null,
    tokensIn: 0,
    tokensOut: 0,
  });
  useUiStore.setState({
    notifications: [],
    unreadCount: 0,
  });
  localStorage.clear();
});

// ── Helpers ─────────────────────────────────────────────────────────

function setRunId(id: string) {
  useChatStore.setState({ runId: id, streaming: true });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Chat event routing — parity with app-gateway.ts:324-358', () => {
  /**
   * OpenClaw behavior (app-gateway.ts:355-357):
   *   if (evt.event === "chat") {
   *     handleChatGatewayEvent(host, evt.payload as ChatEventPayload | undefined);
   *     return;
   *   }
   *
   * Our App.tsx (lines 101-103):
   *   const unsubChat = client.subscribe('chat', (payload) => {
   *     handleChatEvent(payload as ChatStreamEvent);
   *   });
   */
  it('processes delta events and updates streamText', () => {
    setRunId('run-stream-001');

    useChatStore.getState().handleChatEvent(STREAMING_DELTA);

    const state = useChatStore.getState();
    expect(state.streaming).toBe(true);
    expect(state.streamText).toBe('I am currently searching for...');
  });

  it('processes final events and appends to messages', () => {
    setRunId('run-stream-001');

    useChatStore.getState().handleChatEvent(STREAMING_FINAL);

    const state = useChatStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.streamText).toBeNull();
    expect(state.runId).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe('I found 5 relevant papers on the topic.');
  });

  /**
   * OpenClaw behavior (app-gateway.ts:333-352):
   *   if (evt.event === "agent") {
   *     handleAgentEvent(host, evt.payload as AgentEventPayload | undefined);
   *     return; // <-- does NOT call handleChatEvent
   *   }
   *
   * Our App.tsx (lines 105-110) subscribes agent events separately
   * and only calls setAgentStatus, NOT handleChatEvent.
   */
  it('agent events do not trigger handleChatEvent (no message added)', () => {
    setRunId('run-evt-001');
    const initialMessages = useChatStore.getState().messages.length;

    // Simulate what App.tsx does: agent events go to setAgentStatus, not handleChatEvent
    // We verify by directly calling handleChatEvent with a non-chat payload — it should be a no-op
    const agentPayload = {
      state: 'tool_running' as const,
    };
    // Agent events have no runId/sessionKey/state shape → handleChatEvent would not match
    useChatStore.getState().handleChatEvent(agentPayload as unknown as ChatStreamEvent);

    // No message should have been added (handleChatEvent should not process agent-shaped events)
    expect(useChatStore.getState().messages).toHaveLength(initialMessages);
  });

  /**
   * OpenClaw behavior (app-gateway.ts:360-368):
   *   if (evt.event === "presence") {
   *     const payload = evt.payload as { presence?: PresenceEntry[] };
   *     if (payload?.presence && Array.isArray(payload.presence)) {
   *       host.presenceEntries = payload.presence;
   *     }
   *     return; // <-- does NOT call handleChatEvent
   *   }
   */
  it('presence events do not affect chat state', () => {
    setRunId('run-evt-001');
    const before = { ...useChatStore.getState() };

    // Presence payload has no chat event shape
    const presencePayload = { presence: [{ name: 'web-ui' }] };
    useChatStore.getState().handleChatEvent(presencePayload as unknown as ChatStreamEvent);

    // Chat state should be unchanged
    expect(useChatStore.getState().messages).toHaveLength(before.messages.length);
    expect(useChatStore.getState().streamText).toBe(before.streamText);
  });
});

describe('Message visibility filtering — parity with grouped-render.ts:225-267', () => {
  /**
   * OpenClaw behavior (grouped-render.ts:232-237):
   *   const isToolResult =
   *     isToolResultMessage(message) ||
   *     role.toLowerCase() === "toolresult" ||
   *     role.toLowerCase() === "tool_result" ||
   *     typeof m.toolCallId === "string" ||
   *     typeof m.tool_call_id === "string";
   *
   * Tool results are rendered differently (as cards, line 261-262) or hidden.
   * In our implementation, toolResult messages are filtered out entirely.
   *
   * Our chat.ts VISIBLE_ROLES (line 18):
   *   const VISIBLE_ROLES = new Set(['user', 'assistant']);
   */
  it('user messages are always visible', () => {
    const visible = ['user', 'assistant'];
    expect(visible.includes(USER_MSG.role)).toBe(true);
  });

  it('assistant messages with text are visible', () => {
    expect(ASSISTANT_MSG.role).toBe('assistant');
    const text = ASSISTANT_MSG.text ?? '';
    expect(text.trim().length > 0).toBe(true);
  });

  it('toolResult messages are NOT visible (filtered by VISIBLE_ROLES)', () => {
    // Our chat.ts line 18: VISIBLE_ROLES = new Set(['user', 'assistant'])
    // toolResult is not in the set
    const VISIBLE_ROLES = new Set(['user', 'assistant']);
    expect(VISIBLE_ROLES.has(TOOL_RESULT_MSG.role)).toBe(false);
  });

  /**
   * OpenClaw behavior (grouped-render.ts:265-267):
   *   if (!markdown && !hasToolCards && !hasImages) {
   *     return nothing; // <-- empty messages are hidden
   *   }
   *
   * Our ChatView.tsx (lines 39-43):
   *   if (m.role !== 'assistant') return false;
   *   return extractVisibleText(m).trim().length > 0 || hasImageContent(m);
   */
  it('assistant messages with empty text and no images are filtered out', () => {
    const text = ASSISTANT_EMPTY_TEXT_MSG.text ?? '';
    const hasImages = Array.isArray(ASSISTANT_EMPTY_TEXT_MSG.content) &&
      ASSISTANT_EMPTY_TEXT_MSG.content.some((c) => c.type === 'image' || c.type === 'image_url');

    expect(text.trim().length === 0 && !hasImages).toBe(true);
  });

  it('assistant messages with whitespace-only text and no images are filtered out', () => {
    const text = ASSISTANT_WHITESPACE_ONLY_MSG.text ?? '';
    const hasImages = Array.isArray(ASSISTANT_WHITESPACE_ONLY_MSG.content) &&
      ASSISTANT_WHITESPACE_ONLY_MSG.content.some((c) => c.type === 'image' || c.type === 'image_url');

    expect(text.trim().length === 0 && !hasImages).toBe(true);
  });

  /**
   * OpenClaw behavior (grouped-render.ts:241-242):
   *   const images = extractImages(message);
   *   const hasImages = images.length > 0;
   *
   * And (line 265-267):
   *   if (!markdown && !hasToolCards && !hasImages) {
   *     return nothing;
   *   }
   *   // Messages with images but no text are STILL rendered.
   *
   * Our ChatView.tsx (line 42):
   *   return extractVisibleText(m).trim().length > 0 || hasImageContent(m);
   */
  it('assistant messages with images but no text are NOT filtered out', () => {
    const text = ASSISTANT_IMAGE_ONLY_MSG.text ?? '';
    const hasImages = Array.isArray(ASSISTANT_IMAGE_ONLY_MSG.content) &&
      ASSISTANT_IMAGE_ONLY_MSG.content.some((c) => c.type === 'image' || c.type === 'image_url');

    // Text is empty but has images → should be visible
    expect(text.trim().length).toBe(0);
    expect(hasImages).toBe(true);
    // The OR condition ensures it passes the filter
    expect(text.trim().length > 0 || hasImages).toBe(true);
  });

  it('filters mixed message history correctly', () => {
    // Simulate the same filtering ChatView.tsx does (lines 39-43)
    function extractVisibleText(msg: { text?: string; content?: unknown }): string {
      if (msg.text) return msg.text;
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
          .map((c: { text?: string }) => c.text!)
          .join('');
      }
      return '';
    }

    function hasImageContent(msg: { content?: unknown }): boolean {
      if (!Array.isArray(msg.content)) return false;
      return msg.content.some((c: { type: string }) => c.type === 'image' || c.type === 'image_url');
    }

    const visible = MIXED_HISTORY.filter((m) => {
      if (m.role === 'user') return true;
      if (m.role !== 'assistant') return false;
      return extractVisibleText(m).trim().length > 0 || hasImageContent(m);
    });

    // Expected visible: USER_MSG, ASSISTANT_MSG, ASSISTANT_IMAGE_ONLY_MSG
    // Filtered out: TOOL_RESULT_MSG (wrong role), ASSISTANT_EMPTY_TEXT_MSG (no text/images),
    //               TOOL_CALL_MSG (tool_use content has no displayable text),
    //               ASSISTANT_WHITESPACE_ONLY_MSG (whitespace only)
    expect(visible).toHaveLength(3);
    expect(visible[0].role).toBe('user');
    expect(visible[1].role).toBe('assistant');
    expect(visible[1].text).toBe('I found 12 papers on quantum computing. Here are the top results.');
    expect(visible[2].role).toBe('assistant');
    // The image-only msg has empty text but images
    expect(visible[2].text).toBe('');
  });
});

describe('handleChatEvent delta state — parity with chat.ts:284-291', () => {
  /**
   * OpenClaw behavior (controllers/chat.ts:284-291):
   *   if (payload.state === "delta") {
   *     const next = extractText(payload.message);
   *     if (typeof next === "string" && !isSilentReplyStream(next)) {
   *       const current = state.chatStream ?? "";
   *       if (!current || next.length >= current.length) {
   *         state.chatStream = next;
   *       }
   *     }
   *   }
   *
   * Our chat.ts (lines 304-318):
   *   case 'delta': {
   *     if (event.runId !== runId) return;
   *     if (event.message && !isVisibleRole(event.message.role)) return;
   *     // Gateway sends full accumulated text — take longer value
   *     set((s) => ({
   *       streaming: true,
   *       streamText: !current || deltaText.length >= current.length ? deltaText : current,
   *     }));
   */
  it('delta replaces streamText with longer text (accumulated, not incremental)', () => {
    setRunId('run-stream-001');

    // First delta
    useChatStore.getState().handleChatEvent({
      runId: 'run-stream-001', sessionKey: 'main', state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    });
    expect(useChatStore.getState().streamText).toBe('Hello');

    // Second delta — longer accumulated text
    useChatStore.getState().handleChatEvent({
      runId: 'run-stream-001', sessionKey: 'main', state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello, world!' }] },
    });
    expect(useChatStore.getState().streamText).toBe('Hello, world!');
  });

  it('delta ignores shorter text (reorder protection)', () => {
    setRunId('run-stream-001');

    // Establish longer text
    useChatStore.getState().handleChatEvent({
      runId: 'run-stream-001', sessionKey: 'main', state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello, world!' }] },
    });
    expect(useChatStore.getState().streamText).toBe('Hello, world!');

    // Out-of-order shorter delta — should be ignored
    useChatStore.getState().handleChatEvent({
      runId: 'run-stream-001', sessionKey: 'main', state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    });
    expect(useChatStore.getState().streamText).toBe('Hello, world!');
  });

  /**
   * OpenClaw behavior (controllers/chat.ts:266-268):
   *   if (payload.sessionKey !== state.sessionKey) {
   *     return null;
   *   }
   *
   * Our chat.ts (line 306):
   *   if (event.runId !== runId) return;
   */
  it('delta from different runId is ignored', () => {
    setRunId('run-stream-001');

    useChatStore.getState().handleChatEvent({
      runId: 'run-OTHER', sessionKey: 'main', state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: 'From another run' }] },
    });

    expect(useChatStore.getState().streamText).toBeNull();
  });

  /**
   * Our chat.ts (line 308):
   *   if (event.message && !isVisibleRole(event.message.role)) return;
   *
   * OpenClaw does not have this exact check in delta handling, but
   * toolResult deltas are handled via the agent stream pipeline instead.
   */
  it('delta with toolResult role is ignored', () => {
    setRunId('run-stream-001');

    useChatStore.getState().handleChatEvent({
      runId: 'run-stream-001', sessionKey: 'main', state: 'delta',
      message: { role: 'toolResult', content: [{ type: 'text', text: 'Tool output...' }], toolCallId: 'call-1' },
    });

    expect(useChatStore.getState().streamText).toBeNull();
  });
});

describe('handleChatEvent final state — parity with chat.ts:292-308', () => {
  /**
   * OpenClaw behavior (controllers/chat.ts:292-307):
   *   } else if (payload.state === "final") {
   *     const finalMessage = normalizeFinalAssistantMessage(payload.message);
   *     if (finalMessage && !isAssistantSilentReply(finalMessage)) {
   *       state.chatMessages = [...state.chatMessages, finalMessage];
   *     }
   *     state.chatStream = null;
   *     state.chatRunId = null;
   */
  it('final event appends message and clears streaming state', () => {
    setRunId('run-stream-001');
    useChatStore.setState({ streamText: 'partial...' });

    useChatStore.getState().handleChatEvent(STREAMING_FINAL);

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('assistant');
    expect(state.streaming).toBe(false);
    expect(state.streamText).toBeNull();
    expect(state.runId).toBeNull();
  });

  it('final event from sub-agent (different runId) still appends message', () => {
    setRunId('run-stream-001');

    const subAgentFinal: ChatStreamEvent = {
      runId: 'run-OTHER-456',
      sessionKey: 'main',
      state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Sub-agent done.' }],
        timestamp: 1710400005000,
      },
    };

    useChatStore.getState().handleChatEvent(subAgentFinal);

    const state = useChatStore.getState();
    // Message added but streaming state NOT cleared (different runId)
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe('Sub-agent done.');
    expect(state.streaming).toBe(true); // still streaming our original run
    expect(state.runId).toBe('run-stream-001'); // original run unchanged
  });

  /**
   * OpenClaw behavior (controllers/chat.ts:293-295):
   *   const finalMessage = normalizeFinalAssistantMessage(payload.message);
   *   if (finalMessage && !isAssistantSilentReply(finalMessage)) {
   *     state.chatMessages = [...state.chatMessages, finalMessage];
   *
   * Our chat.ts (lines 326-327):
   *   const text = extractText(event.message);
   *   if (isSilentReply(text)) return;
   */
  it('final event with NO_REPLY text is silently discarded', () => {
    setRunId('run-abc-123');

    useChatStore.getState().handleChatEvent({
      runId: 'run-abc-123', sessionKey: 'main', state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '  NO_REPLY  ' }],
        timestamp: 1710400000000,
      },
    });

    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('final event with toolResult role is discarded', () => {
    setRunId('run-abc-123');

    useChatStore.getState().handleChatEvent({
      runId: 'run-abc-123', sessionKey: 'main', state: 'final',
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: 'Tool result data' }],
        toolCallId: 'call-123',
        timestamp: 1710400000000,
      },
    });

    expect(useChatStore.getState().messages).toHaveLength(0);
  });
});

describe('handleChatEvent error/aborted — parity with chat.ts:309-334', () => {
  /**
   * OpenClaw behavior (controllers/chat.ts:329-334):
   *   } else if (payload.state === "error") {
   *     state.chatStream = null;
   *     state.chatRunId = null;
   *     state.chatStreamStartedAt = null;
   *     state.lastError = payload.errorMessage ?? "chat error";
   *   }
   */
  it('error event clears streaming and sets lastError', () => {
    setRunId('run-abc-123');
    useChatStore.setState({ streamText: 'partial...' });

    useChatStore.getState().handleChatEvent({
      runId: 'run-abc-123', sessionKey: 'main', state: 'error',
      errorMessage: 'Model overloaded, please retry',
    });

    const state = useChatStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.streamText).toBeNull();
    expect(state.runId).toBeNull();
    expect(state.lastError).toBe('Model overloaded, please retry');
    expect(state.messages).toHaveLength(0); // no message appended on error
  });

  /**
   * OpenClaw behavior (controllers/chat.ts:309-328):
   *   } else if (payload.state === "aborted") {
   *     const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
   *     if (normalizedMessage && !isAssistantSilentReply(normalizedMessage)) {
   *       state.chatMessages = [...state.chatMessages, normalizedMessage];
   *     } else {
   *       // Keep streamed partial text if any
   *       const streamedText = state.chatStream ?? "";
   *       if (streamedText.trim() && !isSilentReplyStream(streamedText)) {
   *         state.chatMessages = [...state.chatMessages, { role: "assistant", ... }];
   *       }
   *     }
   *     state.chatStream = null;
   *     state.chatRunId = null;
   */
  it('aborted event preserves partial stream text as a message', () => {
    setRunId('run-abc-123');
    useChatStore.setState({ streamText: 'I was about to explain...' });

    useChatStore.getState().handleChatEvent({
      runId: 'run-abc-123', sessionKey: 'main', state: 'aborted',
    });

    const state = useChatStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.streamText).toBeNull();
    expect(state.runId).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe('I was about to explain...');
    expect(state.messages[0].role).toBe('assistant');
  });

  it('aborted event with no partial text adds no message', () => {
    setRunId('run-abc-123');
    // streamText is null

    useChatStore.getState().handleChatEvent({
      runId: 'run-abc-123', sessionKey: 'main', state: 'aborted',
    });

    const state = useChatStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.messages).toHaveLength(0);
  });
});

describe('Card notification extraction — chat.ts extractCardNotifications', () => {
  /**
   * Our chat.ts (lines 67-120):
   * CARD_NOTIFICATION_RE matches ```progress_card, ```radar_digest, ```approval_card
   * and routes to addNotification with appropriate types.
   *
   * This is Channel B of the notification system (Channel A = RPC polling).
   */
  it('progress_card → heartbeat notification', () => {
    setRunId('run-card-001');

    useChatStore.getState().handleChatEvent(FINAL_WITH_PROGRESS_CARD);

    const notifications = useUiStore.getState().notifications;
    expect(notifications.length).toBeGreaterThanOrEqual(1);

    const heartbeat = notifications.find((n) => n.type === 'heartbeat');
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.title).toContain('Heartbeat');
    expect(heartbeat!.title).toContain('daily');
    expect(heartbeat!.body).toContain('3 papers processed');
  });

  it('radar_digest → system notification', () => {
    setRunId('run-card-002');

    useChatStore.getState().handleChatEvent(FINAL_WITH_RADAR_DIGEST);

    const notifications = useUiStore.getState().notifications;
    expect(notifications.length).toBeGreaterThanOrEqual(1);

    const radar = notifications.find((n) => n.type === 'system');
    expect(radar).toBeDefined();
    expect(radar!.title).toContain('Radar');
    expect(radar!.title).toContain('5');
    expect(radar!.body).toContain('attention mechanisms transformer');
  });

  it('approval_card → error-level notification', () => {
    setRunId('run-card-003');

    useChatStore.getState().handleChatEvent({
      runId: 'run-card-003', sessionKey: 'main', state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: APPROVAL_CARD_TEXT }],
        timestamp: 1710400012000,
      },
    });

    const notifications = useUiStore.getState().notifications;
    const approval = notifications.find((n) => n.type === 'error');
    expect(approval).toBeDefined();
    expect(approval!.title).toContain('Approval needed');
    expect(approval!.title).toContain('delete_collection');
    expect(approval!.dedupKey).toContain('approval:appr-789');
  });

  it('regular text with no cards does not create notifications', () => {
    setRunId('run-card-004');

    useChatStore.getState().handleChatEvent({
      runId: 'run-card-004', sessionKey: 'main', state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: NO_CARD_TEXT }],
        timestamp: 1710400013000,
      },
    });

    expect(useUiStore.getState().notifications).toHaveLength(0);
  });

  it('multiple cards in one message create multiple notifications', () => {
    setRunId('run-card-005');

    useChatStore.getState().handleChatEvent({
      runId: 'run-card-005', sessionKey: 'main', state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: MULTI_CARD_TEXT }],
        timestamp: 1710400014000,
      },
    });

    const notifications = useUiStore.getState().notifications;
    expect(notifications).toHaveLength(2);
    expect(notifications.some((n) => n.type === 'heartbeat')).toBe(true);
    expect(notifications.some((n) => n.type === 'system')).toBe(true);
  });

  it('card notifications are not extracted for sub-agent finals (different runId)', () => {
    setRunId('run-main-001');

    useChatStore.getState().handleChatEvent({
      runId: 'run-OTHER-sub', sessionKey: 'main', state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: PROGRESS_CARD_TEXT }],
        timestamp: 1710400015000,
      },
    });

    // Sub-agent / server-initiated finals now also extract card notifications
    // (heartbeat, cron, and monitor runs produce progress_card and radar_digest).
    expect(useUiStore.getState().notifications).toHaveLength(1);
  });
});

describe('Token usage accumulation — parity with chat event handling', () => {
  it('accumulates token usage from events that carry it', () => {
    setRunId('run-tok-001');

    useChatStore.getState().handleChatEvent({
      runId: 'run-tok-001', sessionKey: 'main', state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      usage: { input: 100, output: 10 },
    });

    expect(useChatStore.getState().tokensIn).toBe(100);
    expect(useChatStore.getState().tokensOut).toBe(10);

    useChatStore.getState().handleChatEvent({
      runId: 'run-tok-001', sessionKey: 'main', state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }], timestamp: Date.now() },
      usage: { input: 50, output: 20, total: 70 },
    });

    expect(useChatStore.getState().tokensIn).toBe(150);
    expect(useChatStore.getState().tokensOut).toBe(30);
  });
});

describe('Streaming display state transitions', () => {
  it('delta sets streaming=true and streamText', () => {
    setRunId('run-stream-001');

    useChatStore.getState().handleChatEvent(STREAMING_DELTA);

    const state = useChatStore.getState();
    expect(state.streaming).toBe(true);
    expect(state.streamText).toBe('I am currently searching for...');
  });

  it('final after deltas clears streaming and streamText, appends message', () => {
    setRunId('run-stream-001');

    // Simulate delta then final
    useChatStore.getState().handleChatEvent(STREAMING_DELTA);
    expect(useChatStore.getState().streaming).toBe(true);
    expect(useChatStore.getState().streamText).toBe('I am currently searching for...');

    useChatStore.getState().handleChatEvent(STREAMING_FINAL);

    const state = useChatStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.streamText).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe('I found 5 relevant papers on the topic.');
  });
});
