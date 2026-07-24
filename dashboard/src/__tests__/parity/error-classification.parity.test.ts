/**
 * Behavioral Parity Tests: chat error classification + retry.
 *
 * The gateway's ChatErrorEvent carries errorKind ("refusal" | "timeout" |
 * "rate_limit" | "context_length" | "unknown") plus a free-form errorMessage
 * (openclaw/packages/gateway-protocol/src/schema/logs-chat.ts:153-164,
 * populated at src/gateway/server-chat.ts:480,783).
 *
 * The dashboard must:
 *  1. honor errorKind when present (upstream classification wins),
 *  2. text-classify auth/network failures that upstream maps to "unknown"
 *     (OC detectErrorKind() has no auth/network branches — infra/errors.ts),
 *  3. mark which failures are sensibly retryable,
 *  4. let retry() resend the last draft under a NEW idempotencyKey.
 *
 * Error texts in fixtures are real payloads from a production gateway log.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chat';
import i18n from '../../i18n';
import {
  ERROR_AUTH_401,
  ERROR_AUTH_401_FAILOVER,
  ERROR_RATE_LIMIT,
  ERROR_TIMEOUT_KIND,
  ERROR_NETWORK,
  ERROR_CONTEXT_OVERFLOW,
  ERROR_KIND_PRECEDENCE,
  ERROR_UNKNOWN,
} from '../../__fixtures__/gateway-payloads/chat-error-events';

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

function primeErrorState(runId: string) {
  useChatStore.setState({
    messages: [],
    sending: false,
    streaming: true,
    streamText: null,
    runId,
    sessionKey: 'main',
    lastError: null,
    lastErrorMeta: null,
    canContinue: false,
  });
}

describe('Chat error classification (errorKind + text fallback)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.request.mockResolvedValue({});
  });

  it('classifies real 401 relay error as auth with settings guidance', () => {
    primeErrorState(ERROR_AUTH_401.runId);
    useChatStore.getState().handleChatEvent(ERROR_AUTH_401);
    const s = useChatStore.getState();
    expect(s.lastError).toBe(i18n.t('chat.failAuth'));
    expect(s.lastErrorMeta?.kind).toBe('auth');
    expect(s.lastErrorMeta?.suggestion).toBe(i18n.t('chat.failAuthSuggestion'));
    expect(s.lastErrorMeta?.retryable).toBe(true);
    // Raw provider text preserved for the details block.
    expect(s.lastErrorMeta?.raw).toContain('HTTP 401: Invalid Authentication');
    expect(s.streaming).toBe(false);
    expect(s.runId).toBeNull();
  });

  it('classifies FailoverError-wrapped 401 (errorKind=unknown) as auth via text fallback', () => {
    primeErrorState(ERROR_AUTH_401_FAILOVER.runId);
    useChatStore.getState().handleChatEvent(ERROR_AUTH_401_FAILOVER);
    expect(useChatStore.getState().lastErrorMeta?.kind).toBe('auth');
  });

  it('honors upstream errorKind=rate_limit', () => {
    primeErrorState(ERROR_RATE_LIMIT.runId);
    useChatStore.getState().handleChatEvent(ERROR_RATE_LIMIT);
    const s = useChatStore.getState();
    expect(s.lastError).toBe(i18n.t('chat.failRateLimit'));
    expect(s.lastErrorMeta?.kind).toBe('rate_limit');
    expect(s.lastErrorMeta?.retryable).toBe(true);
  });

  it('honors upstream errorKind=timeout', () => {
    primeErrorState(ERROR_TIMEOUT_KIND.runId);
    useChatStore.getState().handleChatEvent(ERROR_TIMEOUT_KIND);
    const s = useChatStore.getState();
    expect(s.lastErrorMeta?.kind).toBe('timeout');
    expect(s.lastErrorMeta?.retryable).toBe(true);
  });

  it('classifies ECONNREFUSED as network via text fallback', () => {
    primeErrorState(ERROR_NETWORK.runId);
    useChatStore.getState().handleChatEvent(ERROR_NETWORK);
    const s = useChatStore.getState();
    expect(s.lastError).toBe(i18n.t('chat.failNetwork'));
    expect(s.lastErrorMeta?.kind).toBe('network');
  });

  it('marks context overflow as NOT retryable', () => {
    primeErrorState(ERROR_CONTEXT_OVERFLOW.runId);
    useChatStore.getState().handleChatEvent(ERROR_CONTEXT_OVERFLOW);
    const s = useChatStore.getState();
    expect(s.lastError).toBe(i18n.t('chat.contextOverflow'));
    expect(s.lastErrorMeta?.kind).toBe('context_overflow');
    expect(s.lastErrorMeta?.retryable).toBe(false);
  });

  it('errorKind wins over conflicting text (timeout beats 401 text)', () => {
    primeErrorState(ERROR_KIND_PRECEDENCE.runId);
    useChatStore.getState().handleChatEvent(ERROR_KIND_PRECEDENCE);
    expect(useChatStore.getState().lastErrorMeta?.kind).toBe('timeout');
  });

  it('surfaces unclassifiable errors verbatim (legacy behavior preserved)', () => {
    primeErrorState(ERROR_UNKNOWN.runId);
    useChatStore.getState().handleChatEvent(ERROR_UNKNOWN);
    const s = useChatStore.getState();
    expect(s.lastError).toBe('Something exploded in a novel way');
    expect(s.lastErrorMeta?.kind).toBe('unknown');
    expect(s.lastErrorMeta?.retryable).toBe(true);
  });

  it('clearError also clears lastErrorMeta', () => {
    primeErrorState(ERROR_AUTH_401.runId);
    useChatStore.getState().handleChatEvent(ERROR_AUTH_401);
    useChatStore.getState().clearError();
    const s = useChatStore.getState();
    expect(s.lastError).toBeNull();
    expect(s.lastErrorMeta).toBeNull();
  });
});

describe('retry() — resend last draft after failure', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.request.mockResolvedValue({});
    useChatStore.setState({
      messages: [],
      sending: false,
      streaming: false,
      streamText: null,
      runId: null,
      sessionKey: 'main',
      lastError: 'boom',
      lastErrorMeta: {
        kind: 'network',
        message: 'boom',
        suggestion: null,
        retryable: true,
        raw: 'boom',
      },
      canContinue: false,
      _lastSentDraft: { text: 'find papers on RNA', attachments: [], runId: 'old-run-id' },
      _pendingUserMsgs: [],
    });
  });

  it('resends the same text under a NEW idempotencyKey and clears the error', async () => {
    useChatStore.getState().retry();
    // send() is async; wait for the RPC to fire.
    await vi.waitFor(() => {
      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({ message: 'find papers on RNA' }),
      );
    });
    const call = mockGatewayClient.request.mock.calls.find((c) => c[0] === 'chat.send');
    expect(call?.[1].idempotencyKey).toBeTruthy();
    expect(call?.[1].idempotencyKey).not.toBe('old-run-id');
    expect(useChatStore.getState().lastError).toBeNull();
  });

  it('is a no-op while streaming', () => {
    useChatStore.setState({ streaming: true });
    useChatStore.getState().retry();
    expect(mockGatewayClient.request).not.toHaveBeenCalledWith('chat.send', expect.anything());
  });

  it('is a no-op while sending', () => {
    useChatStore.setState({ sending: true });
    useChatStore.getState().retry();
    expect(mockGatewayClient.request).not.toHaveBeenCalledWith('chat.send', expect.anything());
  });

  it('is a no-op without a saved draft', () => {
    useChatStore.setState({ _lastSentDraft: null });
    useChatStore.getState().retry();
    expect(mockGatewayClient.request).not.toHaveBeenCalledWith('chat.send', expect.anything());
  });
});

describe('surface_error final must not consume the retry draft', () => {
  // Real event sequence observed live (2026-07-24, /model bogus experiment):
  // 1. chat FINAL with assistant message "⚠️ Agent failed before reply: …"
  // 2. agent failure event sets lastError/lastErrorMeta.
  // The final ends the run; the draft must survive so Retry can show.
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.request.mockResolvedValue({});
    useChatStore.setState({
      messages: [],
      sending: false,
      streaming: true,
      streamText: null,
      runId: 'run-fail-1',
      sessionKey: 'main',
      lastError: null,
      lastErrorMeta: null,
      canContinue: false,
      _lastSentDraft: { text: '你好,请简短回复。', attachments: [], runId: 'run-fail-1' },
      _pendingUserMsgs: [],
    });
  });

  it('keeps _lastSentDraft when the final is an ⚠️-surfaced failure', () => {
    useChatStore.getState().handleChatEvent({
      runId: 'run-fail-1',
      sessionKey: 'main',
      state: 'final',
      message: {
        role: 'assistant',
        text: '⚠️ Agent failed before reply: Unknown model: wentor/no-such-model-999. Logs: openclaw logs --follow',
        timestamp: Date.now(),
      },
    });
    const s = useChatStore.getState();
    expect(s.streaming).toBe(false);
    expect(s._lastSentDraft?.text).toBe('你好,请简短回复。');
    // The final itself must surface the Alert deterministically — the
    // follow-up agent-failure event may be dropped by its guards (live race).
    expect(s.lastError).toBeTruthy();
    expect(s.lastErrorMeta?.retryable).toBe(true);
  });

  it('still clears _lastSentDraft on a normal successful final', () => {
    useChatStore.getState().handleChatEvent({
      runId: 'run-fail-1',
      sessionKey: 'main',
      state: 'final',
      message: { role: 'assistant', text: '你好!有什么可以帮你?', timestamp: Date.now() },
    });
    expect(useChatStore.getState()._lastSentDraft).toBeNull();
  });
});
