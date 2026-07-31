/** P1 offline/pending Stop contract. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_LIST_ABORT_SETTLING_RESPONSE,
  SESSION_LIST_ABORT_TERMINAL_RESPONSE,
} from '../../__fixtures__/gateway-payloads/session-run-state';
import { selectSessionRunView, useSessionRunsStore } from '../../stores/session-runs';

const gateway = { isConnected: false, request: vi.fn() };

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: gateway, state: gateway.isConnected ? 'connected' : 'reconnecting', eventEpoch: 2 }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

type AbortRecoveryStore = ReturnType<typeof useSessionRunsStore.getState> & {
  pendingAborts: Record<string, { runId?: string }>;
  requestAbort: (sessionKey: string) => Promise<void>;
  flushPendingAborts: () => Promise<void>;
};

describe('pending abort recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    gateway.isConnected = false;
    useSessionRunsStore.getState().resetForTests();
    useSessionRunsStore.getState().ingestSnapshot({
      key: 'main', status: 'running', hasActiveRun: true,
    }, { eventEpoch: 1, observedAt: 10 });
  });

  afterEach(() => {
    useSessionRunsStore.getState().resetForTests();
    vi.useRealTimers();
  });

  it('records one pending Stop while offline without inventing killed', async () => {
    const store = useSessionRunsStore.getState() as AbortRecoveryStore;
    await store.requestAbort('main');
    await store.requestAbort('main');

    const state = useSessionRunsStore.getState() as AbortRecoveryStore;
    expect(state.pendingAborts.main).toBeDefined();
    expect(state.commands.main).toBe('stopping');
    expect(state.reconciler.records.main.terminal).toBeUndefined();
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it('flushes the session-level abort once after reconnect', async () => {
    const store = useSessionRunsStore.getState() as AbortRecoveryStore;
    await store.requestAbort('main');
    gateway.isConnected = true;
    gateway.request.mockImplementation(async (method: string) => (
      method === 'sessions.list'
        ? { sessions: [{ key: 'main', status: 'running', hasActiveRun: true }] }
        : { aborted: true }
    ));

    await (useSessionRunsStore.getState() as AbortRecoveryStore).flushPendingAborts();

    expect(gateway.request.mock.calls.filter(([method]) => method === 'chat.abort')).toEqual([
      ['chat.abort', { sessionKey: 'main' }],
    ]);
  });

  it('keeps reconciling when abort clears hasActiveRun before OC persists killed', async () => {
    gateway.isConnected = true;
    useSessionRunsStore.getState().resetForTests();
    useSessionRunsStore.getState().ingestSnapshot(
      SESSION_LIST_ABORT_SETTLING_RESPONSE.sessions[0],
      { eventEpoch: 2, observedAt: 20 },
    );
    gateway.request.mockResolvedValueOnce(SESSION_LIST_ABORT_TERMINAL_RESPONSE);

    expect(selectSessionRunView(useSessionRunsStore.getState(), 'project-longrun')).toMatchObject({
      lifecycle: 'unknown',
      serverActive: false,
      needsResultConfirmation: true,
      canAbort: false,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(gateway.request).toHaveBeenCalledWith('sessions.list', {
      includeDerivedTitles: true,
      limit: 1000,
    });
    expect(selectSessionRunView(useSessionRunsStore.getState(), 'project-longrun')).toMatchObject({
      lifecycle: 'killed',
      needsResultConfirmation: false,
      isBusy: false,
      canAbort: false,
    });
  });
});
