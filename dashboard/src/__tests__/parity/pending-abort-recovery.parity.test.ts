/** P1 offline/pending Stop contract. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCEPTANCE_F5_TIMEOUT_HISTORY,
  ACCEPTANCE_STOP_COMMAND_CONFIRMED,
  ACCEPTANCE_STOP_RUN_ID,
  ACCEPTANCE_STOP_SESSION_KEY,
  INCIDENT_RUNNING_WITHOUT_ACTIVE,
} from '../../__fixtures__/gateway-payloads/long-run-incidents';
import {
  SESSION_LIST_ABORT_SETTLING_RESPONSE,
  SESSION_LIST_ABORT_TERMINAL_RESPONSE,
} from '../../__fixtures__/gateway-payloads/session-run-state';
import { selectSessionRunView, useSessionRunsStore } from '../../stores/session-runs';
import {
  projectStoredConfirmedStopCommand,
  resetConfirmedStopCommandsForTests,
} from '../../utils/confirmed-stop-command';

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
    resetConfirmedStopCommandsForTests();
    useSessionRunsStore.getState().resetForTests();
    useSessionRunsStore.getState().ingestSnapshot({
      key: 'main', status: 'running', hasActiveRun: true,
    }, { eventEpoch: 1, observedAt: 10 });
  });

  afterEach(() => {
    useSessionRunsStore.getState().resetForTests();
    resetConfirmedStopCommandsForTests();
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

  it('persists only a server-confirmed Stop receipt so F5 can recover its cause', async () => {
    gateway.isConnected = true;
    vi.setSystemTime(ACCEPTANCE_STOP_COMMAND_CONFIRMED.requestedAt);
    useSessionRunsStore.getState().resetForTests();
    useSessionRunsStore.getState().ingestSnapshot({
      ...ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo,
      status: 'running',
      hasActiveRun: true,
      endedAt: undefined,
    }, { eventEpoch: 2, observedAt: ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo.startedAt });
    useSessionRunsStore.getState().setLocalRunId(
      ACCEPTANCE_STOP_SESSION_KEY,
      ACCEPTANCE_STOP_RUN_ID,
    );
    gateway.request.mockImplementation(async (method: string) => {
      if (method === 'chat.abort') {
        return { ok: true, aborted: true, runIds: [ACCEPTANCE_STOP_RUN_ID] };
      }
      return { sessions: [ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo] };
    });

    await useSessionRunsStore.getState().requestAbort(ACCEPTANCE_STOP_SESSION_KEY);

    expect(projectStoredConfirmedStopCommand(
      ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo,
      ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo.endedAt + 1,
    ).row.status).toBe('killed');
  });

  it('falls back to session-level Stop when a restored local runId is stale', async () => {
    gateway.isConnected = true;
    useSessionRunsStore.getState().setLocalRunId('main', 'stale-local-run');
    gateway.request.mockImplementation(async (method: string, params: { runId?: string }) => {
      if (method === 'chat.abort' && params.runId) {
        return { ok: true, aborted: false, runIds: [] };
      }
      if (method === 'chat.abort') {
        return { ok: true, aborted: true, runIds: ['actual-server-run'] };
      }
      return { sessions: [{ key: 'main', status: 'killed', hasActiveRun: false }] };
    });

    await useSessionRunsStore.getState().requestAbort('main');

    expect(gateway.request.mock.calls.filter(([method]) => method === 'chat.abort')).toEqual([
      ['chat.abort', { sessionKey: 'main', runId: 'stale-local-run' }],
      ['chat.abort', { sessionKey: 'main' }],
    ]);
  });

  it('retries the canonical OC session key when a restarted announce run is active under the gateway key', async () => {
    gateway.isConnected = true;
    useSessionRunsStore.getState().resetForTests();
    useSessionRunsStore.getState().ingestSnapshot({
      key: 'project-6a04c754',
      sessionId: 'd38c7192-b46c-4c09-ad48-2c1e307ff05d',
      status: 'running',
      hasActiveRun: true,
      startedAt: 1_785_526_021_959,
    }, { eventEpoch: 2, observedAt: 1_785_526_160_697 });
    gateway.request.mockImplementation(async (method: string, params: { sessionKey?: string }) => {
      if (method === 'chat.abort' && params.sessionKey === 'project-6a04c754') {
        return { ok: true, aborted: false, runIds: [] };
      }
      if (method === 'chat.abort' && params.sessionKey === 'agent:main:project-6a04c754') {
        return {
          ok: true,
          aborted: true,
          runIds: ['announce:v1:agent:main:subagent:child:replacement-run'],
        };
      }
      return {
        sessions: [{
          key: 'project-6a04c754',
          sessionId: 'd38c7192-b46c-4c09-ad48-2c1e307ff05d',
          status: 'killed',
          hasActiveRun: false,
        }],
      };
    });

    await useSessionRunsStore.getState().requestAbort('project-6a04c754');

    expect(gateway.request.mock.calls.filter(([method]) => method === 'chat.abort')).toEqual([
      ['chat.abort', { sessionKey: 'project-6a04c754' }],
      ['chat.abort', { sessionKey: 'agent:main:project-6a04c754' }],
    ]);
    expect(selectSessionRunView(useSessionRunsStore.getState(), 'project-6a04c754')).toMatchObject({
      lifecycle: 'killed',
      serverActive: false,
      command: 'idle',
      canAbort: false,
    });
  });

  it('does not persist a Stop cause when OC reports that nothing was aborted', async () => {
    gateway.isConnected = true;
    gateway.request.mockImplementation(async (method: string) => (
      method === 'chat.abort'
        ? { ok: true, aborted: false, runIds: [] }
        : { sessions: [ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo] }
    ));

    await useSessionRunsStore.getState().requestAbort('main');

    expect(projectStoredConfirmedStopCommand(
      { ...ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo, key: 'main' },
      ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo.endedAt + 1,
    ).row.status).toBe('timeout');
  });

  it('stops result confirmation after two queries instead of polling forever', async () => {
    gateway.isConnected = true;
    useSessionRunsStore.getState().resetForTests();
    gateway.request.mockResolvedValue(INCIDENT_RUNNING_WITHOUT_ACTIVE);

    useSessionRunsStore.getState().ingestSnapshot(
      INCIDENT_RUNNING_WITHOUT_ACTIVE.sessions[0],
      { eventEpoch: 2, observedAt: 20 },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(gateway.request.mock.calls.filter(([method]) => method === 'sessions.list')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(gateway.request.mock.calls.filter(([method]) => method === 'sessions.list')).toHaveLength(2);
    expect(selectSessionRunView(useSessionRunsStore.getState(), 'project-d1921f34')).toMatchObject({
      lifecycle: 'unknown',
      serverActive: false,
      needsResultConfirmation: false,
      resultUnconfirmed: true,
      isBusy: false,
      canAbort: false,
    });
  });
});
