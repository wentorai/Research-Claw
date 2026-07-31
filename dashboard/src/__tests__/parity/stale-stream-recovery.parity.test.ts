/**
 * Compatibility coverage for tool activity timestamps and reconnect deltas.
 *
 * Run-liveness assertions live in stale-run-authority.parity.test.ts. Quiet
 * tools and reconnect age are observations only: they no longer own recovery,
 * terminal state, or foreground-tool eviction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELTA_SECOND } from '../../__fixtures__/gateway-payloads/chat-events';
import { AGENT_LIFECYCLE_RECOVERED_FOREGROUND } from '../../__fixtures__/gateway-payloads/session-run-state';
import { useChatStore, _testWatchdog } from '../../stores/chat';
import { useSessionRunsStore } from '../../stores/session-runs';
import { useToolStreamStore } from '../../stores/tool-stream';

const request = vi.fn().mockResolvedValue({ sessions: [] });

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      client: { isConnected: true, request },
      state: 'connected',
      eventEpoch: 1,
    }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

describe('stale stream compatibility observations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    request.mockResolvedValue({ sessions: [] });
    useSessionRunsStore.getState().resetForTests();
    useChatStore.setState({
      messages: [],
      sending: false,
      streaming: false,
      streamText: null,
      runId: null,
      sessionKey: 'main',
      lastError: null,
      _streamStartedAt: null,
      _lastDeltaAt: null,
      _reconnectedAt: null,
    });
    useToolStreamStore.setState({ pendingTools: [], bgActivity: null });
  });

  afterEach(() => {
    _testWatchdog.stop();
    useSessionRunsStore.getState().resetForTests();
    vi.useRealTimers();
  });

  it('tracks the most recent event timestamp for an active tool', () => {
    useToolStreamStore.getState().handleAgentEvent(
      {
        runId: 'run-1',
        sessionKey: 'main',
        stream: 'tool',
        data: { phase: 'start', toolCallId: 'tc-1', name: 'exec' },
      },
      'run-1',
      'main',
    );
    const startedAt = useToolStreamStore.getState().pendingTools[0].lastEventAt;

    vi.advanceTimersByTime(5_000);
    useToolStreamStore.getState().handleAgentEvent(
      {
        runId: 'run-1',
        sessionKey: 'main',
        stream: 'tool',
        data: { phase: 'running', toolCallId: 'tc-1' },
      },
      'run-1',
      'main',
    );

    expect(useToolStreamStore.getState().pendingTools[0].lastEventAt).toBeGreaterThan(startedAt);
  });

  it('does not evict or terminate a quiet tool from the chat watchdog', async () => {
    const longAgo = Date.now() - 370_000;
    useChatStore.setState({
      streaming: true,
      runId: 'run-1',
      _streamStartedAt: longAgo,
      _lastDeltaAt: longAgo,
    });
    useToolStreamStore.setState({
      pendingTools: [{
        toolCallId: 'tc-1',
        name: 'exec',
        phase: 'running',
        startedAt: longAgo,
        lastEventAt: longAgo,
      }],
    });

    _testWatchdog.start();
    vi.advanceTimersByTime(15_000);
    await vi.runAllTicks();

    expect(request).toHaveBeenCalledWith('sessions.list', expect.anything());
    expect(useChatStore.getState()).toMatchObject({ streaming: true, runId: 'run-1' });
    expect(useToolStreamStore.getState().pendingTools).toHaveLength(1);
  });

  it('reconnect age cannot activate a short fake-terminal timeout', () => {
    useChatStore.setState({
      streaming: true,
      runId: 'run-1',
      _streamStartedAt: Date.now() - 30_000,
      _lastDeltaAt: Date.now() - 20_000,
      _reconnectedAt: Date.now(),
    });

    _testWatchdog.start();
    vi.advanceTimersByTime(15_000);

    expect(useChatStore.getState()).toMatchObject({ streaming: true, runId: 'run-1' });
  });

  it('restores full accumulated text when a delta arrives after reconnect', () => {
    useChatStore.setState({
      streaming: true,
      runId: DELTA_SECOND.runId,
      streamText: null,
      _reconnectedAt: Date.now(),
    });

    useChatStore.getState().handleChatEvent(DELTA_SECOND);

    expect(useChatStore.getState().streamText).toBe('Hello, I can help');
    expect(useChatStore.getState()._reconnectedAt).toBeNull();
  });

  it('does not relabel the active session run as background after F5 loses local runId', () => {
    useToolStreamStore.getState().handleAgentEvent(
      AGENT_LIFECYCLE_RECOVERED_FOREGROUND,
      null,
      'project-longrun',
    );

    expect(useToolStreamStore.getState().bgActivity).toBeNull();
  });
});
