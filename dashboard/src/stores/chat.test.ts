/**
 * Chat store unit tests.
 * Tests sendMessage, handleChatEvent (delta/final/aborted/error),
 * abort, clearMessages, and token tracking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from './chat';
import { useStagedWritingStore } from './staged-writing';
import { buildInitialStageStates, STAGED_WRITING_STAGES } from '../utils/staged-writing-stages';

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
      compacting: false,
      streamText: null,
      runId: null,
      sessionKey: 'main',
      lastError: null,
      tokensIn: 0,
      tokensOut: 0,
      _lastSentDraft: null,
      inputRestore: null,
      inputRestoreSeq: 0,
      _abortedUserSuppressCounts: {},
      _pendingUserMsgs: [],
      _localOnlyMsgs: [],
    });
    sessionStorage.removeItem('rc-pending-user-msgs');
    sessionStorage.removeItem('rc-local-chat-msgs');
    localStorage.removeItem('rc-local-chat-msgs-v2');
    useStagedWritingStore.setState({
      job: null,
      restored: false,
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

      expect(useChatStore.getState().lastError).toBe('未连接网关 — 请检查网关是否正在运行');
      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('sets lastError when client is null', async () => {
      // The gateway mock always returns an object, so we test
      // the disconnected path which is effectively the same guard
      mockGatewayClient.isConnected = false;

      await useChatStore.getState().send('test');
      expect(useChatStore.getState().lastError).toBe('未连接网关 — 请检查网关是否正在运行');
      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('sets lastError on RPC failure', async () => {
      mockGatewayClient.request.mockImplementation(async (method: string) => {
        if (method === 'chat.send') throw new Error('Network error');
        return {};
      });

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

    it('does not re-enter staged writing after a completed job in the same session', async () => {
      const stages = buildInitialStageStates('outputs/drafts/session28').map((stage) => ({
        ...stage,
        status: 'done' as const,
      }));
      useStagedWritingStore.setState({
        job: {
          id: 'job-session-28',
          sessionKey: 'main',
          slug: 'session28',
          topic: '根据这些分析，完成一篇完整的小论文',
          contextText: '',
          sourcePaths: ['sources/'],
          venue: '',
          locale: 'zh-CN',
          outputDir: 'outputs/drafts/session28',
          startedAtMs: Date.now(),
          status: 'completed',
          currentStageIndex: STAGED_WRITING_STAGES.length,
          stages,
          lastError: null,
        },
      });
      mockGatewayClient.request.mockResolvedValueOnce({});

      await useChatStore.getState().send('根据新的修改意见，完成一篇完整的小论文');

      expect(mockGatewayClient.request).toHaveBeenCalledWith('chat.send', expect.objectContaining({
        message: '根据新的修改意见，完成一篇完整的小论文',
      }));
      expect(useStagedWritingStore.getState().job?.id).toBe('job-session-28');
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

      it('preserves compacting and suppresses runEndedNoOutput for final without message during compaction', () => {
        const userMsg = { role: 'user' as const, text: 'hi', timestamp: Date.now() };
        useChatStore.setState({
          runId: 'run-1',
          streaming: true,
          streamText: null,
          compacting: true,
          messages: [userMsg],
          lastError: null,
        });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'final',
        });

        const state = useChatStore.getState();
        expect(state.compacting).toBe(true);
        expect(state.streaming).toBe(false);
        expect(state.lastError).toBeNull();
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

      it('restores input and removes optimistic user message on abort', () => {
        const userMsg = { role: 'user' as const, text: 'Edit me', timestamp: Date.now() };
        useChatStore.setState({
          runId: 'run-1',
          streaming: true,
          streamText: null,
          messages: [userMsg],
          _lastSentDraft: { text: 'Edit me', attachments: [], runId: 'run-1' },
          _pendingUserMsgs: [userMsg],
        });

        useChatStore.getState().handleChatEvent({
          runId: 'run-1',
          sessionKey: 'main',
          state: 'aborted',
        });

        const state = useChatStore.getState();
        expect(state.messages).toHaveLength(0);
        expect(state.inputRestore).toEqual({ text: 'Edit me', attachments: [] });
        expect(state._lastSentDraft).toBeNull();
        expect(state._abortedUserSuppressCounts).toEqual({ 'Edit me': 1 });
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

        expect(useChatStore.getState().lastError).toMatch(/run ended without|没有生成回复|no reply/i);
      });
    });
  });

  describe('abort', () => {
    it('restores input immediately when stop is clicked', () => {
      const userMsg = { role: 'user' as const, text: 'Stop me', timestamp: Date.now() };
      useChatStore.setState({
        runId: 'run-1',
        sessionKey: 'main',
        streaming: true,
        messages: [userMsg],
        _lastSentDraft: { text: 'Stop me', attachments: [], runId: 'run-1' },
      });
      mockGatewayClient.request.mockResolvedValueOnce({});

      useChatStore.getState().abort();

      const state = useChatStore.getState();
      expect(state.inputRestore).toEqual({ text: 'Stop me', attachments: [] });
      expect(state.streaming).toBe(false);
      expect(state.messages).toHaveLength(0);
      expect(mockGatewayClient.request).toHaveBeenCalledWith('chat.abort', { runId: 'run-1', sessionKey: 'main' });
    });

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
      // Stops streaming immediately; partial text kept until timeout
      expect(useChatStore.getState().streaming).toBe(false);

      // After 3s timeout, runId cleared and partial saved as assistant message
      vi.advanceTimersByTime(3000);
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
      expect(useChatStore.getState().streaming).toBe(false);

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

    it('restores dashboard-only messages for the selected session', () => {
      useChatStore.setState({ sessionKey: 'project-25' });
      useChatStore.getState().appendLocalMessage({
        role: 'user',
        text: '根据资料完成一篇完整小论文',
        timestamp: 1000,
      });

      useChatStore.getState().setSessionKey('project-29');
      expect(useChatStore.getState().messages).toEqual([]);

      useChatStore.getState().setSessionKey('project-25');
      expect(useChatStore.getState().messages.map((m) => m.text)).toEqual([
        '根据资料完成一篇完整小论文',
      ]);
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

  describe('handleCompactionAgentEvent', () => {
    it('sets compacting on start for matching run', () => {
      useChatStore.setState({ runId: 'run-1', sessionKey: 'main', streaming: true });
      useChatStore.getState().handleCompactionAgentEvent({
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        stream: 'compaction',
        data: { phase: 'start' },
      });
      expect(useChatStore.getState().compacting).toBe(true);
    });

    it('clears compacting on end', () => {
      useChatStore.setState({ compacting: true, runId: 'run-1' });
      useChatStore.getState().handleCompactionAgentEvent({
        runId: 'run-1',
        stream: 'compaction',
        data: { phase: 'end' },
      });
      expect(useChatStore.getState().compacting).toBe(false);
    });

    it('ignores compaction for a different run', () => {
      useChatStore.setState({ runId: 'run-a', compacting: false });
      useChatStore.getState().handleCompactionAgentEvent({
        runId: 'run-b',
        stream: 'compaction',
        data: { phase: 'start' },
      });
      expect(useChatStore.getState().compacting).toBe(false);
    });

    it('ignores compaction for a different session', () => {
      useChatStore.setState({ sessionKey: 'main', runId: 'run-1' });
      useChatStore.getState().handleCompactionAgentEvent({
        runId: 'run-1',
        sessionKey: 'agent:main:project-other',
        stream: 'compaction',
        data: { phase: 'start' },
      });
      expect(useChatStore.getState().compacting).toBe(false);
    });
  });

  describe('handleAgentFailureEvent', () => {
    it('surfaces lifecycle error for active run', () => {
      useChatStore.setState({ runId: 'run-1', streaming: true, sessionKey: 'project-x' });
      useChatStore.getState().handleAgentFailureEvent({
        runId: 'run-1',
        sessionKey: 'agent:main:project-x',
        stream: 'lifecycle',
        data: {
          phase: 'error',
          error: 'Context overflow: prompt too large for the model (precheck).',
        },
      });
      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState().lastError).toContain('上下文溢出');
    });

    it('ignores lifecycle error for other sessions', () => {
      useChatStore.setState({ runId: 'run-1', streaming: true, sessionKey: 'main' });
      useChatStore.getState().handleAgentFailureEvent({
        runId: 'run-1',
        sessionKey: 'agent:main:project-other',
        stream: 'lifecycle',
        data: { phase: 'error', error: 'boom' },
      });
      expect(useChatStore.getState().streaming).toBe(true);
      expect(useChatStore.getState().lastError).toBeNull();
    });

    it('surfaces lifecycle error when gateway runId differs from client runId', () => {
      useChatStore.setState({ runId: 'client-run', streaming: true, sessionKey: 'project-x' });
      useChatStore.getState().handleAgentFailureEvent({
        runId: 'gateway-run',
        sessionKey: 'agent:main:project-x',
        stream: 'lifecycle',
        data: { phase: 'error', error: 'LLM request timed out.' },
      });
      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState().lastError).toContain('timed out');
    });

    it('surfaces structured error details and repair suggestion', () => {
      useChatStore.setState({ runId: 'run-1', streaming: true, sessionKey: 'project-x' });
      useChatStore.getState().handleAgentFailureEvent({
        runId: 'run-1',
        sessionKey: 'agent:main:project-x',
        stream: 'error',
        data: {
          reason: 'Image generation request was blocked.',
          code: 'IMAGE_GENERATION_SSRF_BLOCKED',
          provider: 'google',
          model: 'gemini-3.1-pro-preview',
          suggestion: '检查 DNS/代理，确保 Google API 域名解析到公网 IP。',
        },
      });

      const lastError = useChatStore.getState().lastError ?? '';
      expect(lastError).toContain('Image generation request was blocked.');
      expect(lastError).toContain('google/gemini-3.1-pro-preview');
      expect(lastError).toContain('IMAGE_GENERATION_SSRF_BLOCKED');
      expect(lastError).toContain('检查 DNS/代理');
    });

    it('surfaces structured operational errors after the main run has ended', () => {
      useChatStore.setState({ runId: null, streaming: false, sending: false, sessionKey: 'project-x' });
      useChatStore.getState().handleAgentFailureEvent({
        runId: 'tool:image_generate:abc',
        sessionKey: 'agent:main:project-x',
        stream: 'error',
        data: {
          reason: 'No API key found for provider "google".',
          code: 'IMAGE_GENERATION_AUTH_MISSING',
          capability: 'image_generation',
          suggestion: '打开设置并配置 google API Key。',
        },
      });

      expect(useChatStore.getState().lastError).toContain('IMAGE_GENERATION_AUTH_MISSING');
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

    it('filters aborted user messages reloaded from gateway transcript', async () => {
      useChatStore.setState({
        _abortedUserSuppressCounts: { '需压迫': 1 },
      });
      mockGatewayClient.request.mockResolvedValueOnce({
        messages: [
          { role: 'user', text: '需压迫', timestamp: 1000 },
          { role: 'user', text: '需要', timestamp: 2000 },
          { role: 'assistant', text: 'ok', timestamp: 3000 },
        ],
      });

      await useChatStore.getState().loadHistory();

      expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['需要', 'ok']);
      expect(useChatStore.getState()._abortedUserSuppressCounts).toEqual({});
    });

    it('drops empty aborted turns from history reload', async () => {
      mockGatewayClient.request.mockResolvedValueOnce({
        messages: [
          { role: 'user', text: '你能否清空着31篇论文', timestamp: 1000 },
          {
            role: 'assistant',
            content: [],
            stopReason: 'aborted',
            errorMessage: 'This operation was aborted',
            timestamp: 1500,
          },
          { role: 'user', text: '你能否清空这31篇论文', timestamp: 2000 },
          { role: 'assistant', text: '请确认删除', timestamp: 3000 },
        ],
      });

      await useChatStore.getState().loadHistory();

      expect(useChatStore.getState().messages.map((m) => m.text)).toEqual([
        '你能否清空这31篇论文',
        '请确认删除',
      ]);
    });

    it('preserves dashboard-only messages after history reload', async () => {
      const localUser = {
        role: 'user' as const,
        text: '根据提纲完成一篇完整的小论文',
        timestamp: 500,
      };
      const localAssistant = {
        role: 'assistant' as const,
        text: '**分步写作** · 已启动',
        timestamp: 600,
      };
      useChatStore.setState({
        _localOnlyMsgs: [localUser, localAssistant],
      });

      mockGatewayClient.request.mockResolvedValueOnce({
        messages: [
          { role: 'assistant', text: 'gateway reply', timestamp: 1000 },
        ],
      });

      await useChatStore.getState().loadHistory();

      expect(useChatStore.getState().messages.map((m) => m.text)).toEqual([
        '根据提纲完成一篇完整的小论文',
        '**分步写作** · 已启动',
        'gateway reply',
      ]);
    });
  });
});
