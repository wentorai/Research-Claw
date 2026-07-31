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
import { classifyRunFailure, recoveryCategory } from '../../utils/run-failure';
import {
  ERROR_AUTH_401,
  ERROR_AUTH_401_FAILOVER,
  ERROR_RATE_LIMIT,
  ERROR_TIMEOUT_KIND,
  ERROR_TIMEOUT_TEXT,
  FINAL_BEFORE_TIMEOUT_ERROR,
  ERROR_TIMEOUT_IDLE_REAL,
  ERROR_ABORTED_TEXT,
  ERROR_RATE_LIMIT_TEXT,
  ERROR_AUTH_403_TEXT,
  ERROR_NETWORK,
  ERROR_CONTEXT_OVERFLOW,
  ERROR_REFUSAL,
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

describe('classifyRunFailure — kind, category & new coverage (FIX-T1)', () => {
  it('routes a foreground "This operation was aborted" with no output to resend', () => {
    const info = classifyRunFailure('This operation was aborted');
    expect(info.kind).toBe('aborted');
    expect(info.category).toBe('foreground-resend');
    expect(info.retryable).toBe(true);
  });

  it('routes the real screenshot timeout text to foreground resend', () => {
    const info = classifyRunFailure('LLM request failed. | Request timed out before a response was generated.');
    expect(info.kind).toBe('timeout');
    expect(info.category).toBe('foreground-resend');
  });

  it('classifies a Cloudflare error as network (N11)', () => {
    expect(classifyRunFailure('Cloudflare Error 502 Bad Gateway').kind).toBe('network');
  });

  it('maps the same transient failure by foreground/background and partial-output context', () => {
    expect(recoveryCategory('timeout', { origin: 'background' })).toBe('transient-self-healing');
    expect(recoveryCategory('network', { origin: 'foreground' })).toBe('foreground-resend');
    expect(recoveryCategory('rate_limit', { origin: 'foreground', hasPartialOutput: true })).toBe('foreground-continue');
    expect(recoveryCategory('aborted', { origin: 'foreground' })).toBe('foreground-resend');
    expect(recoveryCategory('auth')).toBe('config-fixable');
    expect(recoveryCategory('context_overflow')).toBe('unrecoverable');
    expect(recoveryCategory('refusal')).toBe('unrecoverable');
    expect(recoveryCategory('unknown')).toBe('foreground-resend');
  });

  it('auth is config-fixable (not a plain-resend transient)', () => {
    const info = classifyRunFailure('HTTP 401: Invalid Authentication');
    expect(info.kind).toBe('auth');
    expect(info.category).toBe('config-fixable');
  });

  it('refusal is unrecoverable and NOT retryable', () => {
    const info = classifyRunFailure('x', 'refusal');
    expect(info.category).toBe('unrecoverable');
    expect(info.retryable).toBe(false);
  });

  it('errorKind still wins over conflicting text, and carries a category', () => {
    const info = classifyRunFailure('HTTP 401: Invalid Authentication', 'timeout');
    expect(info.kind).toBe('timeout');
    expect(info.category).toBe('foreground-resend');
  });

  it('empty foreground failure → unknown/resend, retryable', () => {
    const info = classifyRunFailure('');
    expect(info.kind).toBe('unknown');
    expect(info.category).toBe('foreground-resend');
    expect(info.retryable).toBe(true);
  });
});

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
    expect(s.lastErrorMeta?.retryable).toBe(false);
    expect(s.lastErrorMeta?.category).toBe('config-fixable');
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

  it('surfaces the real idle-timeout error even when an empty final event arrived first', () => {
    primeErrorState(ERROR_TIMEOUT_IDLE_REAL.runId);
    useChatStore.getState().handleChatEvent(FINAL_BEFORE_TIMEOUT_ERROR);
    expect(useChatStore.getState().runId).toBeNull();
    expect(useChatStore.getState().lastError).toBeNull();

    useChatStore.getState().handleChatEvent(ERROR_TIMEOUT_IDLE_REAL);
    const state = useChatStore.getState();
    expect(state.lastErrorMeta?.kind).toBe('timeout');
    expect(state.lastErrorMeta?.category).toBe('foreground-resend');
    expect(state.lastErrorMeta?.raw).toBe(ERROR_TIMEOUT_IDLE_REAL.errorMessage);
  });

  it.each([
    [ERROR_TIMEOUT_TEXT, 'timeout'],
    [ERROR_ABORTED_TEXT, 'aborted'],
    [ERROR_RATE_LIMIT_TEXT, 'rate_limit'],
    [ERROR_AUTH_403_TEXT, 'auth'],
  ] as const)('classifies real text-only gateway payload %#', (event, expectedKind) => {
    primeErrorState(event.runId);
    useChatStore.getState().handleChatEvent(event);
    expect(useChatStore.getState().lastErrorMeta?.kind).toBe(expectedKind);
  });

  it('honors upstream refusal and exposes no resend action', () => {
    primeErrorState(ERROR_REFUSAL.runId);
    useChatStore.getState().handleChatEvent(ERROR_REFUSAL);
    const meta = useChatStore.getState().lastErrorMeta;
    expect(meta?.kind).toBe('refusal');
    expect(meta?.category).toBe('unrecoverable');
    expect(meta?.retryable).toBe(false);
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
        category: 'foreground-resend',
        message: 'boom',
        suggestion: null,
        retryable: true,
        raw: 'boom',
      },
      canContinue: false,
      _lastSentDraft: {
        text: 'find papers on RNA',
        attachments: [],
        references: ['sources/rna-notes.pdf'],
        runId: 'old-run-id',
      },
      _pendingUserMsgs: [],
    });
  });

  it('resends the same text under a NEW idempotencyKey and clears the error', async () => {
    useChatStore.getState().retry();
    // send() is async; wait for the RPC to fire.
    await vi.waitFor(() => {
      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({ message: expect.stringContaining('find papers on RNA') }),
      );
    });
    const call = mockGatewayClient.request.mock.calls.find((c) => c[0] === 'chat.send');
    expect(call?.[1].idempotencyKey).toBeTruthy();
    expect(call?.[1].idempotencyKey).not.toBe('old-run-id');
    expect(call?.[1].message).toContain('sources/rna-notes.pdf');
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

  it('recovers from the latest visible user turn when the in-memory draft is absent', async () => {
    useChatStore.setState({
      _lastSentDraft: null,
      messages: [{
        role: 'user',
        text: 'rerun monitor analysis',
        references: ['sources/monitor-context.md'],
      }],
    });
    useChatStore.getState().retry();
    await vi.waitFor(() => {
      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({
          message: expect.stringContaining('sources/monitor-context.md'),
        }),
      );
    });
  });
});

describe('abort recovery semantics', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.request.mockResolvedValue({});
    useChatStore.setState({
      messages: [{ role: 'user', text: 'long analysis', timestamp: 1 }],
      sending: false,
      streaming: true,
      streamText: null,
      runId: 'run-time-limit',
      sessionKey: 'main',
      lastError: null,
      lastErrorMeta: null,
      canContinue: false,
      _userAbortedRunId: null,
      _lastSentDraft: {
        text: 'long analysis',
        attachments: [],
        references: [],
        runId: 'run-time-limit',
      },
      _pendingUserMsgs: [],
    });
  });

  it('keeps the draft and offers resend when a non-user abort produced no output', () => {
    useChatStore.getState().handleChatEvent({
      runId: 'run-time-limit',
      sessionKey: 'main',
      state: 'aborted',
    });
    const state = useChatStore.getState();
    expect(state._lastSentDraft?.text).toBe('long analysis');
    expect(state.messages.some((message) => message.role === 'user')).toBe(true);
    expect(state.canContinue).toBe(false);
    expect(state.lastErrorMeta?.category).toBe('foreground-resend');
  });

  it('offers continue only when a non-user abort preserves partial output', () => {
    useChatStore.setState({ streamText: 'Partial result' });
    useChatStore.getState().handleChatEvent({
      runId: 'run-time-limit',
      sessionKey: 'main',
      state: 'aborted',
    });
    const state = useChatStore.getState();
    expect(state.canContinue).toBe(true);
    expect(state.lastErrorMeta?.category).toBe('foreground-continue');
    expect(state.messages.at(-1)?.text).toBe('Partial result');
  });
});

describe('agent failure isolation', () => {
  it('drops a structured operational error that has no sessionKey', () => {
    useChatStore.setState({
      sessionKey: 'main',
      lastError: null,
      lastErrorMeta: null,
      runId: null,
      sending: false,
      streaming: false,
    });
    useChatStore.getState().handleAgentFailureEvent({
      stream: 'error',
      data: {
        code: 'AUTH_FAILED',
        reason: 'HTTP 401: Invalid Authentication',
        suggestion: 'fix config',
      },
    });
    expect(useChatStore.getState().lastError).toBeNull();
  });

  it('preserves streamed output and offers continue when lifecycle error follows a delta', () => {
    useChatStore.setState({
      sessionKey: 'main',
      messages: [{ role: 'user', text: 'long analysis', timestamp: 1 }],
      streamText: 'Partial result already shown',
      lastError: null,
      lastErrorMeta: null,
      canContinue: false,
      runId: 'run-partial-lifecycle-error',
      sending: false,
      streaming: true,
    });

    useChatStore.getState().handleAgentFailureEvent({
      runId: 'run-partial-lifecycle-error',
      sessionKey: 'agent:main:main',
      stream: 'lifecycle',
      data: {
        phase: 'error',
        error: 'LLM request timed out.',
      },
    });

    const state = useChatStore.getState();
    expect(state.messages.at(-1)?.text).toBe('Partial result already shown');
    expect(state.lastErrorMeta?.category).toBe('foreground-continue');
    expect(state.canContinue).toBe(true);
  });

  it('does not let delayed chat:error overwrite lifecycle partial-output recovery', () => {
    useChatStore.setState({
      sessionKey: 'main',
      messages: [{ role: 'user', text: 'long analysis', timestamp: 1 }],
      streamText: 'Partial result already shown',
      lastError: null,
      lastErrorMeta: null,
      canContinue: false,
      runId: 'run-dual-terminal',
      sending: false,
      streaming: true,
      _lastAgentFailureRunId: null,
    });

    useChatStore.getState().handleAgentFailureEvent({
      runId: 'run-dual-terminal',
      sessionKey: 'agent:main:main',
      stream: 'lifecycle',
      data: {
        phase: 'error',
        error: 'LLM request timed out.',
      },
    });
    useChatStore.getState().handleChatEvent({
      runId: 'run-dual-terminal',
      sessionKey: 'agent:main:main',
      state: 'error',
      errorMessage: 'LLM request timed out.',
      errorKind: 'timeout',
    });

    const state = useChatStore.getState();
    expect(state.messages.filter(
      message => message.text === 'Partial result already shown',
    )).toHaveLength(1);
    expect(state.lastErrorMeta?.category).toBe('foreground-continue');
    expect(state.canContinue).toBe(true);
  });
});

describe('history reload after a provider/system abort', () => {
  it('keeps the failed user turn instead of deleting it with an empty aborted assistant row', async () => {
    mockGatewayClient.request.mockResolvedValueOnce({
      messages: [
        { role: 'user', text: 'keep this failed turn', timestamp: 1 },
        {
          role: 'assistant',
          content: [],
          stopReason: 'aborted',
          errorMessage: 'This operation was aborted',
          timestamp: 2,
        },
      ],
    });
    useChatStore.setState({
      sessionKey: 'main',
      messages: [],
      _pendingUserMsgs: [],
      _localOnlyMsgs: [],
      _abortedUserSuppressCounts: {},
    });

    await useChatStore.getState().loadHistory();

    expect(useChatStore.getState().messages.some(
      (message) => message.role === 'user' && message.text === 'keep this failed turn',
    )).toBe(true);
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
      _lastSentDraft: {
        text: '你好,请简短回复。',
        attachments: [],
        references: [],
        runId: 'run-fail-1',
      },
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
    expect(s.lastErrorMeta?.kind).toBe('model_not_found');
    expect(s.lastErrorMeta?.category).toBe('config-fixable');
    expect(s.lastErrorMeta?.retryable).toBe(false);
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

  it('does not treat a normal warning-prefixed answer as a surfaced failure', () => {
    useChatStore.getState().handleChatEvent({
      runId: 'run-fail-1',
      sessionKey: 'main',
      state: 'final',
      message: {
        role: 'assistant',
        text: '⚠️ 注意：这段 SQL 存在注入风险，但分析已正常完成。',
        timestamp: Date.now(),
      },
    });
    const state = useChatStore.getState();
    expect(state.lastError).toBeNull();
    expect(state._lastSentDraft).toBeNull();
  });
});
