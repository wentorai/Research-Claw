/**
 * Behavioral Parity Tests: Chat Streaming
 *
 * These tests verify that our dashboard handles gateway events
 * IDENTICALLY to OpenClaw's native Lit UI.
 *
 * Reference: openclaw/ui/src/ui/controllers/chat.ts
 *
 * Each test documents the exact OpenClaw behavior and line number
 * it verifies parity with.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chat';
import {
  DELTA_FIRST,
  DELTA_SECOND,
  DELTA_THIRD,
  DELTA_SHORTER_REORDER,
  DELTA_TOOL_RESULT,
  DELTA_SERVER_INITIATED,
  DELTA_SERVER_INITIATED_2,
  FINAL_TEXT,
  FINAL_NO_REPLY,
  FINAL_SUB_AGENT,
  FINAL_SERVER_INITIATED,
  ERROR_EVENT,
  ABORTED_EVENT,
} from '../../__fixtures__/gateway-payloads/chat-events';

// Mock gateway store
const mockGatewayClient = {
  isConnected: true,
  request: vi.fn(),
};

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: mockGatewayClient, state: 'connected' }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

describe('Chat streaming parity with OpenClaw native UI', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useChatStore.setState({
      messages: [],
      sending: false,
      streaming: false,
      streamText: null,
      runId: DELTA_FIRST.runId,
      sessionKey: 'main',
      lastError: null,
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  describe('Delta handling — openclaw/ui/src/ui/controllers/chat.ts:284-290', () => {
    it('REPLACES stream text with accumulated delta (not appends)', () => {
      // OpenClaw behavior (chat.ts:289):
      //   state.chatStream = next;
      // NOT:
      //   state.chatStream += next;

      useChatStore.getState().handleChatEvent(DELTA_FIRST);
      expect(useChatStore.getState().streamText).toBe('Hello');

      useChatStore.getState().handleChatEvent(DELTA_SECOND);
      expect(useChatStore.getState().streamText).toBe('Hello, I can help');

      useChatStore.getState().handleChatEvent(DELTA_THIRD);
      expect(useChatStore.getState().streamText).toBe('Hello, I can help you with that question.');
    });

    it('keeps longer text when shorter delta arrives (throttle/reorder)', () => {
      // OpenClaw behavior (chat.ts:288):
      //   if (!current || next.length >= current.length)
      // Shorter deltas are ignored (can happen with network reordering)

      useChatStore.getState().handleChatEvent(DELTA_SECOND); // "Hello, I can help"
      useChatStore.getState().handleChatEvent(DELTA_SHORTER_REORDER); // "Hello, I can" (shorter)

      expect(useChatStore.getState().streamText).toBe('Hello, I can help');
    });

    it('filters toolResult role deltas (not user-visible)', () => {
      // OpenClaw behavior: toolResult messages are internal, not shown in chat UI
      // See: grouped-render.ts uses isToolResultMessage() filter

      useChatStore.getState().handleChatEvent(DELTA_FIRST); // visible
      useChatStore.getState().handleChatEvent(DELTA_TOOL_RESULT); // should be ignored

      expect(useChatStore.getState().streamText).toBe('Hello');
    });

    it('ignores deltas from different runId when BOTH runIds are set', () => {
      // OpenClaw behavior (chat.ts:272): triple-AND condition
      //   if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId)
      // Only skips when BOTH event.runId and store.runId exist AND differ.

      useChatStore.getState().handleChatEvent(DELTA_FIRST);
      useChatStore.getState().handleChatEvent({
        ...DELTA_SECOND,
        runId: 'different-run',
      });

      expect(useChatStore.getState().streamText).toBe('Hello');
    });

    it('processes deltas when no active user chat (runId is null)', () => {
      // OpenClaw behavior (chat.ts:272): when chatRunId is null (falsy),
      // the triple-AND short-circuits to false → delta is NOT skipped.
      // This is critical for server-initiated runs (heartbeat, cron).
      useChatStore.setState({ runId: null });

      useChatStore.getState().handleChatEvent(DELTA_SERVER_INITIATED);
      expect(useChatStore.getState().streaming).toBe(true);
      expect(useChatStore.getState().streamText).toBe('Heartbeat: checking your research tasks...');

      useChatStore.getState().handleChatEvent(DELTA_SERVER_INITIATED_2);
      expect(useChatStore.getState().streamText).toBe(
        'Heartbeat: checking your research tasks... Found 2 new papers matching your monitor query.',
      );
    });

    it('sets streaming to true on first delta', () => {
      useChatStore.setState({ streaming: false });
      useChatStore.getState().handleChatEvent(DELTA_FIRST);
      expect(useChatStore.getState().streaming).toBe(true);
    });
  });

  describe('Final handling — openclaw/ui/src/ui/controllers/chat.ts:292-307', () => {
    it('adds final message to messages and clears streaming state', () => {
      useChatStore.setState({ streaming: true, streamText: 'partial' });
      useChatStore.getState().handleChatEvent(FINAL_TEXT);

      const state = useChatStore.getState();
      expect(state.streaming).toBe(false);
      expect(state.streamText).toBeNull();
      expect(state.runId).toBeNull();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].role).toBe('assistant');
    });

    it('tracks token usage from final event', () => {
      useChatStore.getState().handleChatEvent(FINAL_TEXT);

      expect(useChatStore.getState().tokensIn).toBe(150);
      expect(useChatStore.getState().tokensOut).toBe(42);
    });

    it('filters NO_REPLY messages', () => {
      // OpenClaw behavior: isAssistantSilentReply() checks /^\s*NO_REPLY\s*$/
      // See: chat.ts:274, chat.ts:296

      useChatStore.getState().handleChatEvent(FINAL_NO_REPLY);
      expect(useChatStore.getState().messages).toHaveLength(0);
    });

    it('appends sub-agent final without clearing main streaming state', () => {
      // OpenClaw behavior (chat.ts:272-277):
      //   if (payload.runId !== state.chatRunId && payload.state === "final")
      //     → append message only, don't touch streaming state

      useChatStore.setState({ streaming: true, streamText: 'main stream text' });
      useChatStore.getState().handleChatEvent(FINAL_SUB_AGENT);

      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().streaming).toBe(true); // NOT cleared
      expect(useChatStore.getState().streamText).toBe('main stream text'); // NOT cleared
    });
  });

  describe('Server-initiated runs — openclaw/ui/src/ui/controllers/chat.ts:272 (triple-AND)', () => {
    it('streams heartbeat/cron deltas when user is not chatting', () => {
      // Simulate: no active user chat, agent starts a heartbeat run.
      // All deltas should stream normally since store.runId is null.
      useChatStore.setState({ runId: null, streaming: false, streamText: null });

      useChatStore.getState().handleChatEvent(DELTA_SERVER_INITIATED);
      expect(useChatStore.getState().streaming).toBe(true);
      expect(useChatStore.getState().streamText).toContain('Heartbeat');

      useChatStore.getState().handleChatEvent(DELTA_SERVER_INITIATED_2);
      expect(useChatStore.getState().streamText).toContain('Found 2 new papers');
    });

    it('final from server-initiated run appends message and cleans streaming state', () => {
      // Server-initiated run streams, then final arrives.
      // Since store.runId is null, final goes to else branch → should clean up.
      useChatStore.setState({ runId: null, streaming: true, streamText: 'Heartbeat partial...' });

      useChatStore.getState().handleChatEvent(FINAL_SERVER_INITIATED);

      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].text).toContain('Added to library');
      // Orphaned streaming state must be cleaned
      expect(state.streaming).toBe(false);
      expect(state.streamText).toBeNull();
    });

    it('full server-initiated lifecycle: delta → delta → final', () => {
      // Complete heartbeat run without any user chat active
      useChatStore.setState({ runId: null, streaming: false, streamText: null, messages: [] });

      useChatStore.getState().handleChatEvent(DELTA_SERVER_INITIATED);
      expect(useChatStore.getState().streaming).toBe(true);

      useChatStore.getState().handleChatEvent(DELTA_SERVER_INITIATED_2);
      expect(useChatStore.getState().streamText).toContain('Found 2 new papers');

      useChatStore.getState().handleChatEvent(FINAL_SERVER_INITIATED);

      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.streaming).toBe(false);
      expect(state.streamText).toBeNull();
    });

    it('server-initiated deltas are dropped when user IS actively chatting', () => {
      // When user has an active chat (runId is set), heartbeat deltas from
      // a different run are still dropped — same behavior as OC.
      useChatStore.setState({ runId: 'user-active-run', streaming: true, streamText: 'User typing...' });

      useChatStore.getState().handleChatEvent(DELTA_SERVER_INITIATED);

      // User's streaming state unchanged
      expect(useChatStore.getState().streamText).toBe('User typing...');
    });
  });

  describe('Error/Abort — openclaw/ui/src/ui/controllers/chat.ts:309-333', () => {
    it('sets error and clears all streaming state', () => {
      useChatStore.setState({ streaming: true, streamText: 'partial' });
      useChatStore.getState().handleChatEvent(ERROR_EVENT);

      const state = useChatStore.getState();
      expect(state.lastError).toBe('Model overloaded, please retry');
      expect(state.streaming).toBe(false);
      expect(state.streamText).toBeNull();
      expect(state.runId).toBeNull();
    });

    it('saves partial stream text on abort', () => {
      // OpenClaw behavior (chat.ts:314-325):
      //   Uses streamedText as message content if available

      useChatStore.setState({ streaming: true, streamText: 'Partial answer before abort' });
      useChatStore.getState().handleChatEvent(ABORTED_EVENT);

      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].text).toBe('Partial answer before abort');
      expect(state.streaming).toBe(false);
    });

    it('clears without message on abort when no stream text', () => {
      useChatStore.setState({ streaming: true, streamText: null });
      useChatStore.getState().handleChatEvent(ABORTED_EVENT);

      expect(useChatStore.getState().messages).toHaveLength(0);
      expect(useChatStore.getState().streaming).toBe(false);
    });
  });

  describe('Session usage loading via sessions.usage RPC', () => {
    it('loads token usage from sessions.usage RPC', async () => {
      // OpenClaw gateway tracks token usage in session transcripts but does NOT
      // include usage in chat stream events. We fetch aggregate totals via the
      // sessions.usage RPC (without key param to avoid key format mismatch).
      mockGatewayClient.request.mockResolvedValueOnce({
        totals: { input: 1200, output: 350 },
      });

      await useChatStore.getState().loadSessionUsage();

      expect(mockGatewayClient.request).toHaveBeenCalledWith('sessions.usage', {});
      expect(useChatStore.getState().tokensIn).toBe(1200);
      expect(useChatStore.getState().tokensOut).toBe(350);
    });

    it('sets absolute values (not accumulating)', async () => {
      // Ensure RPC result REPLACES existing counters, not adds to them
      useChatStore.setState({ tokensIn: 500, tokensOut: 100 });

      mockGatewayClient.request.mockResolvedValueOnce({
        totals: { input: 800, output: 200 },
      });

      await useChatStore.getState().loadSessionUsage();

      expect(useChatStore.getState().tokensIn).toBe(800);
      expect(useChatStore.getState().tokensOut).toBe(200);
    });

    it('handles RPC failure gracefully (non-fatal)', async () => {
      useChatStore.setState({ tokensIn: 100, tokensOut: 50 });
      mockGatewayClient.request.mockRejectedValueOnce(new Error('timeout'));

      await useChatStore.getState().loadSessionUsage();

      // Values unchanged on error
      expect(useChatStore.getState().tokensIn).toBe(100);
      expect(useChatStore.getState().tokensOut).toBe(50);
    });

    it('resets tokens on session switch', () => {
      useChatStore.setState({ tokensIn: 500, tokensOut: 200 });

      useChatStore.getState().setSessionKey('project-abc');

      expect(useChatStore.getState().tokensIn).toBe(0);
      expect(useChatStore.getState().tokensOut).toBe(0);
      expect(useChatStore.getState().sessionKey).toBe('project-abc');
    });
  });

  describe('Session isolation — openclaw/ui/src/ui/controllers/chat.ts:266', () => {
    it('drops delta events for non-active session', () => {
      // OC behavior (chat.ts:266):
      //   if (payload.sessionKey !== state.sessionKey) return null;
      useChatStore.setState({ sessionKey: 'session-2', runId: null });

      useChatStore.getState().handleChatEvent(DELTA_FIRST); // sessionKey: 'main'
      expect(useChatStore.getState().streamText).toBeNull();
      expect(useChatStore.getState().streaming).toBe(false);
    });

    it('drops final events for non-active session', () => {
      useChatStore.setState({ sessionKey: 'session-2', runId: null, streaming: true, streamText: 'local' });

      useChatStore.getState().handleChatEvent(FINAL_TEXT); // sessionKey: 'main'
      // Streaming state for session-2 must NOT be modified
      expect(useChatStore.getState().streaming).toBe(true);
      expect(useChatStore.getState().streamText).toBe('local');
      expect(useChatStore.getState().messages).toHaveLength(0);
    });

    it('drops error events for non-active session', () => {
      useChatStore.setState({ sessionKey: 'session-2', lastError: null });

      useChatStore.getState().handleChatEvent(ERROR_EVENT); // sessionKey: 'main'
      expect(useChatStore.getState().lastError).toBeNull();
    });

    it('processes events when sessionKey matches', () => {
      useChatStore.setState({ sessionKey: 'main', runId: DELTA_FIRST.runId });

      useChatStore.getState().handleChatEvent(DELTA_FIRST); // sessionKey: 'main'
      expect(useChatStore.getState().streamText).toBe('Hello');
    });

    it('drops events with undefined sessionKey (strict !== like OC)', () => {
      // OC: payload.sessionKey !== state.sessionKey → undefined !== 'main' → true → drop
      useChatStore.setState({ sessionKey: 'main', runId: null });

      const eventNoKey = { ...DELTA_FIRST, sessionKey: undefined as unknown as string };
      useChatStore.getState().handleChatEvent(eventNoKey);
      expect(useChatStore.getState().streamText).toBeNull();
    });
  });

  describe('Full streaming sequence (realistic)', () => {
    it('handles a complete delta → final lifecycle', () => {
      // Simulate what actually happens: multiple deltas then a final

      useChatStore.getState().handleChatEvent(DELTA_FIRST);
      expect(useChatStore.getState().streamText).toBe('Hello');
      expect(useChatStore.getState().streaming).toBe(true);

      useChatStore.getState().handleChatEvent(DELTA_SECOND);
      expect(useChatStore.getState().streamText).toBe('Hello, I can help');

      useChatStore.getState().handleChatEvent(DELTA_THIRD);
      expect(useChatStore.getState().streamText).toBe('Hello, I can help you with that question.');

      // Final arrives — stream clears, message added
      useChatStore.getState().handleChatEvent(FINAL_TEXT);

      const state = useChatStore.getState();
      expect(state.streaming).toBe(false);
      expect(state.streamText).toBeNull();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].text).toContain('Here is the answer.');
    });
  });
});
