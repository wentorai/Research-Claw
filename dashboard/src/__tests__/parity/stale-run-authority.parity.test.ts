/**
 * P0 stale watchdog parity: inactivity may request authoritative reconciliation,
 * but it must never create a terminal state or erase a live run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_LIST_ACTIVE_RESPONSE } from '../../__fixtures__/gateway-payloads/session-run-state';
import { useChatStore, _testWatchdog } from '../../stores/chat';
import { useSessionRunsStore } from '../../stores/session-runs';
import { useTaskFlowStore } from '../../stores/task-flow';
import { useToolStreamStore } from '../../stores/tool-stream';

const request = vi.fn();

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

function seedActive(lastActivityAt: number) {
  useSessionRunsStore.getState().ingestSnapshot(SESSION_LIST_ACTIVE_RESPONSE.sessions[0], {
    eventEpoch: 1,
    observedAt: lastActivityAt,
  });
  useSessionRunsStore.getState().setLocalRunId('project-longrun', 'run-generation-1');
  useChatStore.setState({
    messages: [],
    sessionKey: 'project-longrun',
    sending: false,
    streaming: true,
    compacting: false,
    streamText: null,
    runId: 'run-generation-1',
    lastError: null,
    _streamStartedAt: lastActivityAt,
    _lastDeltaAt: lastActivityAt,
    _reconnectedAt: null,
  });
  useTaskFlowStore.getState().startRun('run-generation-1', 'project-longrun');
}

describe('stale watchdog delegates to Session reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'));
    vi.resetAllMocks();
    request.mockResolvedValue({ sessions: SESSION_LIST_ACTIVE_RESPONSE.sessions });
    useSessionRunsStore.getState().resetForTests();
    useToolStreamStore.setState({ pendingTools: [], bgActivity: null });
    useTaskFlowStore.getState().clear();
  });

  afterEach(() => {
    _testWatchdog.stop();
    useSessionRunsStore.getState().resetForTests();
    vi.useRealTimers();
  });

  it('207 seconds without a chat delta does not imply failure', () => {
    seedActive(Date.now() - 207_000);
    _testWatchdog.start();
    vi.advanceTimersByTime(15_000);

    // Active sessions may be reconciled by the bounded 15s polling fallback.
    // The important parity invariant is that quiet time itself cannot terminate it.
    expect(useChatStore.getState()).toMatchObject({
      streaming: true,
      runId: 'run-generation-1',
      lastError: null,
    });
  });

  it('more than 360 seconds only requests a Session snapshot and preserves the run', async () => {
    seedActive(Date.now() - 370_000);
    _testWatchdog.start();
    vi.advanceTimersByTime(15_000);
    await vi.runAllTicks();

    expect(request).toHaveBeenCalledWith('sessions.list', expect.objectContaining({ limit: 1000 }));
    expect(useChatStore.getState()).toMatchObject({
      streaming: true,
      runId: 'run-generation-1',
      lastError: null,
    });
    expect(useTaskFlowStore.getState().flow?.activeIndex).toBeGreaterThanOrEqual(0);
  });

  it('does not evict a tool merely because it has been quiet for 120 seconds', async () => {
    seedActive(Date.now() - 370_000);
    useToolStreamStore.setState({
      pendingTools: [{
        toolCallId: 'tool-1',
        name: 'search_openalex',
        phase: 'running',
        startedAt: Date.now() - 200_000,
        lastEventAt: Date.now() - 130_000,
      }],
    });
    _testWatchdog.start();
    vi.advanceTimersByTime(15_000);
    await vi.runAllTicks();

    expect(useToolStreamStore.getState().pendingTools).toHaveLength(1);
    expect(useChatStore.getState().runId).toBe('run-generation-1');
  });

  it('reconnect age no longer grants a 15 second fake-terminal path', async () => {
    seedActive(Date.now() - 40_000);
    useChatStore.setState({ _reconnectedAt: Date.now() - 20_000 });
    _testWatchdog.start();
    vi.advanceTimersByTime(15_000);
    await vi.runAllTicks();

    // A reconnect/session poll is allowed; it is an authority query, not a fake terminal.
    expect(useChatStore.getState().runId).toBe('run-generation-1');
    expect(useChatStore.getState().streaming).toBe(true);
  });
});
