/** P1 offline/pending Stop contract. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionRunsStore } from '../../stores/session-runs';

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
    gateway.isConnected = false;
    useSessionRunsStore.getState().resetForTests();
    useSessionRunsStore.getState().ingestSnapshot({
      key: 'main', status: 'running', hasActiveRun: true,
    }, { eventEpoch: 1, observedAt: 10 });
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
});
