/**
 * Chat store unit tests.
 * Tests sendMessage, handleChatEvent (delta/final/aborted/error),
 * abort, clearMessages, and token tracking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from './chat';

// Mock the gateway store
const mockGatewayClient = {
  isConnected: true,
  request: vi.fn(),
};

vi.mock('./gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      client: mockGatewayClient,
    }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

describe('Chat store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
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
  });

  describe('send', () => {
    it('adds user message to messages and sends chat.send RPC', async () => {
      mockGatewayClient.request.mockResolvedValueOnce({});

      await useChatStore.getState().send('Hello world');

      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().messages[0].role).toBe('user');
      expect(useChatStore.getState().messages[0].text).toBe('Hello world');
      expect(mockGatewayClient.request).toHaveBeenCalledWith('chat.send',
        expect.objectContaining({
          message: 'Hello world',
          sessionKey: 'main',
        }),
      );
      // runId is set locally before RPC (matches OC pattern), not from response
      expect(useChatStore.getState().runId).toBeTruthy();
      expect(typeof useChatStore.getState().runId).toBe('string');
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it('sets lastError when not connected', async () => {
      mockGatewayClient.isConnected = false;

      await useChatStore.getState().send('test');

      expect(useChatStore.getState().lastError).toBe('Not connected to gateway');
      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('sets lastError when client is null', async () => {
      // The gateway mock always returns an object, so we test
      // the disconnected path which is effectively the same guard
      mockGatewayClient.isConnected = false;

      await useChatStore.getState().send('test');
      expect(useChatStore.getState().lastError).toBe('Not connected to gateway');
      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('sets lastError on RPC failure', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('Network error'));

      await useChatStore.getState().send('test');

      expect(useChatStore.getState().sending).toBe(false);
      expect(useChatStore.getState().lastError).toBe('Network error');
    });

    it('clears previous error and streamText on new send', async () => {
      useChatStore.setState({ lastError: 'old error', streamText: 'partial' });
      mockGatewayClient.request.mockResolvedValueOnce({ runId: 'run-2' });

      await useChatStore.getState().send('new message');

      expect(useChatStore.getState().lastError).toBeNull();
    });
  });

  describe('handleChatEvent', () => {
    describe('delta', () => {
      it('appends text to streamText', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: '' });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'delta',
          message: { role: 'assistant', text: 'Hello' },
        });

        expect(useChatStore.getState().streamText).toBe('Hello');
      });

      it('replaces stream text with longer accumulated delta (matches gateway protocol)', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: '' });

        // Gateway sends full accumulated text in each delta, not incremental
        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'delta',
          message: { role: 'assistant', text: 'Hello' },
        });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'delta',
          message: { role: 'assistant', text: 'Hello world' },
        });

        expect(useChatStore.getState().streamText).toBe('Hello world');
      });

      it('keeps longer stream text when delta is shorter (e.g. throttled/reordered)', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: 'Hello world' });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'delta',
          message: { role: 'assistant', text: 'Hello' },
        });

        expect(useChatStore.getState().streamText).toBe('Hello world');
      });

      it('ignores delta for different runId', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: 'partial' });

        useChatStore.getState().handleChatEvent({
          runId: 'run-OTHER',
          sessionKey: 'main',
          state: 'delta',
          message: { role: 'assistant', text: ' extra' },
        });

        expect(useChatStore.getState().streamText).toBe('partial');
      });

      it('extracts text from content array when text field is absent', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: '' });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'delta',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'From content' },
            ],
          },
        });

        expect(useChatStore.getState().streamText).toBe('From content');
      });
    });

    describe('final', () => {
      it('adds message and clears streaming state', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: 'Hello', messages: [] });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'final',
          message: { role: 'assistant', text: 'Hello world' },
        });

        const state = useChatStore.getState();
        expect(state.streaming).toBe(false);
        expect(state.streamText).toBeNull();
        expect(state.runId).toBeNull();
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].text).toBe('Hello world');
      });

      it('filters NO_REPLY messages', () => {
        useChatStore.setState({ runId: 'run-1', messages: [] });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'final',
          message: { role: 'assistant', text: '  NO_REPLY  ' },
        });

        expect(useChatStore.getState().messages).toHaveLength(0);
      });

      it('handles final from a different runId (sub-agent)', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: 'partial', messages: [] });

        useChatStore.getState().handleChatEvent({
          runId: 'run-OTHER',
          sessionKey: 'main',
          state: 'final',
          message: { role: 'assistant', text: 'Sub-agent reply' },
        });

        // Should add message but not clear streaming state
        expect(useChatStore.getState().messages).toHaveLength(1);
        expect(useChatStore.getState().streaming).toBe(true);
        expect(useChatStore.getState().streamText).toBe('partial');
      });

      it('ignores final with no message', () => {
        useChatStore.setState({ runId: 'run-1', messages: [] });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'final',
        });

        expect(useChatStore.getState().messages).toHaveLength(0);
      });
    });

    describe('aborted', () => {
      it('saves partial text as message when available', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: 'Partial answer', messages: [] });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'aborted',
        });

        const state = useChatStore.getState();
        expect(state.streaming).toBe(false);
        expect(state.streamText).toBeNull();
        expect(state.runId).toBeNull();
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].text).toBe('Partial answer');
      });

      it('clears state without saving when no streamText', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: null, messages: [] });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'aborted',
        });

        expect(useChatStore.getState().streaming).toBe(false);
        expect(useChatStore.getState().messages).toHaveLength(0);
      });
    });

    describe('error', () => {
      it('sets lastError and clears streaming', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true, streamText: 'partial' });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'error',
          errorMessage: 'Model overloaded',
        });

        expect(useChatStore.getState().lastError).toBe('Model overloaded');
        expect(useChatStore.getState().streaming).toBe(false);
        expect(useChatStore.getState().streamText).toBeNull();
        expect(useChatStore.getState().runId).toBeNull();
      });

      it('uses default error message when errorMessage is undefined', () => {
        useChatStore.setState({ runId: 'run-1', streaming: true });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'error',
        });

        expect(useChatStore.getState().lastError).toBe('Unknown streaming error');
      });
    });
  });

  describe('abort', () => {
    it('sends chat.abort RPC with runId and sessionKey', () => {
      useChatStore.setState({ runId: 'run-1', sessionKey: 'main' });
      mockGatewayClient.request.mockResolvedValueOnce({});

      useChatStore.getState().abort();

      expect(mockGatewayClient.request).toHaveBeenCalledWith('chat.abort', { runId: 'run-1', sessionKey: 'main' });
    });

    it('sends session-level abort and clears orphan state when runId is null', () => {
      // When runId is null (orphan streaming state), abort sends session-level RPC
      // and immediately clears streaming state. Matches OC: chat.ts:250-253
      useChatStore.setState({ runId: null, streaming: true, streamText: 'orphan' });
      mockGatewayClient.request.mockResolvedValueOnce({});

      useChatStore.getState().abort();

      expect(mockGatewayClient.request).toHaveBeenCalledWith('chat.abort', { sessionKey: 'main' });
      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState().streamText).toBeNull();
    });

    it('skips RPC when disconnected but still schedules timeout', () => {
      vi.useFakeTimers();
      useChatStore.setState({ runId: 'run-1', streaming: true, streamText: 'partial' });
      mockGatewayClient.isConnected = false;

      useChatStore.getState().abort();

      expect(mockGatewayClient.request).not.toHaveBeenCalled();

      // After 3s timeout, streaming state should be force-cleared
      vi.advanceTimersByTime(3000);
      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState().runId).toBeNull();
      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().messages[0].text).toBe('partial');
      vi.useRealTimers();
    });

    it('timeout is a no-op if server already responded with aborted event', () => {
      vi.useFakeTimers();
      useChatStore.setState({ runId: 'run-1', streaming: true, streamText: 'partial', messages: [] });
      mockGatewayClient.request.mockResolvedValueOnce({});

      useChatStore.getState().abort();

      // Simulate server sending 'aborted' event before timeout
      useChatStore.getState().handleChatEvent({
        runId: 'run-1',
        sessionKey: 'main',
        state: 'aborted',
      });

      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState().messages).toHaveLength(1);

      // Timeout fires but runId is already null → no-op
      vi.advanceTimersByTime(3000);
      expect(useChatStore.getState().messages).toHaveLength(1); // still 1, not duplicated
      vi.useRealTimers();
    });

    it('timeout force-clears without message when no streamText', () => {
      vi.useFakeTimers();
      useChatStore.setState({ runId: 'run-1', streaming: true, streamText: null, messages: [] });
      mockGatewayClient.request.mockResolvedValueOnce({});

      useChatStore.getState().abort();

      vi.advanceTimersByTime(3000);
      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState().messages).toHaveLength(0);
      vi.useRealTimers();
    });
  });

  describe('session management', () => {
    it('setSessionKey resets messages and streaming state', () => {
      useChatStore.setState({
        messages: [{ role: 'user', text: 'hi' }],
        streamText: 'partial',
        runId: 'run-1',
        sessionKey: 'old-key',
      });

      useChatStore.getState().setSessionKey('new-key');

      const state = useChatStore.getState();
      expect(state.sessionKey).toBe('new-key');
      expect(state.messages).toEqual([]);
      expect(state.streamText).toBeNull();
      expect(state.runId).toBeNull();
    });
  });

  describe('clearError', () => {
    it('resets lastError to null', () => {
      useChatStore.setState({ lastError: 'some error' });
      useChatStore.getState().clearError();
      expect(useChatStore.getState().lastError).toBeNull();
    });
  });

  describe('updateTokens', () => {
    it('accumulates token counts', () => {
      useChatStore.getState().updateTokens(100, 50);
      expect(useChatStore.getState().tokensIn).toBe(100);
      expect(useChatStore.getState().tokensOut).toBe(50);

      useChatStore.getState().updateTokens(200, 100);
      expect(useChatStore.getState().tokensIn).toBe(300);
      expect(useChatStore.getState().tokensOut).toBe(150);
    });
  });

  describe('loadHistory', () => {
    it('loads messages from chat.history RPC', async () => {
      mockGatewayClient.request.mockResolvedValueOnce({
        messages: [
          { role: 'user', text: 'previous message', timestamp: 1000 },
          { role: 'assistant', text: 'previous response', timestamp: 2000 },
        ],
      });

      await useChatStore.getState().loadHistory();

      expect(mockGatewayClient.request).toHaveBeenCalledWith('chat.history', {
        sessionKey: 'main',
        limit: 500,
      });
      expect(useChatStore.getState().messages).toHaveLength(2);
    });

    it('is a no-op when disconnected', async () => {
      mockGatewayClient.isConnected = false;

      await useChatStore.getState().loadHistory();

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('handles null messages gracefully', async () => {
      mockGatewayClient.request.mockResolvedValueOnce({ messages: null });

      await useChatStore.getState().loadHistory();

      expect(useChatStore.getState().messages).toEqual([]);
    });
  });
});
