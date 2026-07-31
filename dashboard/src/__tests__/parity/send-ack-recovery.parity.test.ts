/** P1 chat.send ACK and uncertainty contracts from locked OC 2026.6.1. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayRequestError } from '../../gateway/client';
import { useChatStore } from '../../stores/chat';
import { selectSessionRunView, useSessionRunsStore } from '../../stores/session-runs';

const gateway = {
  isConnected: true,
  connId: 'runtime-1',
  request: vi.fn(),
};

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      client: gateway,
      state: gateway.isConnected ? 'connected' : 'reconnecting',
      eventEpoch: 3,
      connId: gateway.connId,
    }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

function reset() {
  sessionStorage.clear();
  useSessionRunsStore.getState().resetForTests();
  useChatStore.setState({
    messages: [],
    sending: false,
    streaming: false,
    compacting: false,
    streamText: null,
    runId: null,
    sessionKey: 'main',
    lastError: null,
    lastErrorMeta: null,
    inputRestore: null,
    _pendingSendAck: null,
    _lastSentDraft: null,
    _pendingUserMsgs: [],
    _localOnlyMsgs: [],
  });
}

describe('chat.send ACK recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    gateway.isConnected = true;
    gateway.connId = 'runtime-1';
    reset();
  });

  it.each(['started', 'in_flight'] as const)('adopts the server run on ACK=%s', async (status) => {
    gateway.request.mockImplementation(async (method: string) => {
      if (method === 'chat.send') return { runId: 'server-run', status };
      if (method === 'sessions.list') return { sessions: [{ key: 'main', status: 'running', hasActiveRun: true }] };
      return {};
    });

    await useChatStore.getState().send('long task');

    expect(useChatStore.getState()).toMatchObject({ runId: 'server-run', streaming: true });
    expect(selectSessionRunView(useSessionRunsStore.getState(), 'main')).toMatchObject({
      localRunId: 'server-run',
      canAbort: true,
    });
    expect(gateway.request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
  });

  it('ACK=ok loads the cached completion instead of entering streaming', async () => {
    gateway.request.mockImplementation(async (method: string) => {
      if (method === 'chat.send') return { runId: 'cached-run', status: 'ok' };
      if (method === 'chat.history') return { messages: [{ role: 'assistant', text: 'cached result' }] };
      return {};
    });

    await useChatStore.getState().send('already completed');
    await vi.waitFor(() => expect(useChatStore.getState().messages.some((m) => m.text === 'cached result')).toBe(true));

    expect(useChatStore.getState()).toMatchObject({ runId: null, streaming: false });
    expect(selectSessionRunView(useSessionRunsStore.getState(), 'main').command).toBe('idle');
    expect(gateway.request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
  });

  it('keeps the exact generation in ack_unknown when transport closes after send', async () => {
    gateway.request.mockImplementation(async (method: string) => {
      if (method === 'chat.send') throw new Error('Connection closed while waiting for chat.send');
      if (method === 'sessions.list') return { sessions: [] };
      if (method === 'chat.history') return { messages: [] };
      return {};
    });

    await useChatStore.getState().send('do not duplicate me');

    const run = selectSessionRunView(useSessionRunsStore.getState(), 'main');
    expect(run.command).toBe('ack_unknown');
    expect(run.localRunId).toBeTruthy();
    expect(useChatStore.getState()).toMatchObject({ lastError: null, runId: run.localRunId });
    const pending = (useChatStore.getState() as unknown as {
      _pendingSendAck?: { params?: { message?: string; idempotencyKey?: string } };
    })._pendingSendAck;
    expect(pending?.params).toMatchObject({
      message: 'do not duplicate me',
      idempotencyKey: run.localRunId,
    });
    expect(gateway.request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
  });

  it('treats a Gateway RPC rejection as definitive and restores the draft', async () => {
    gateway.request.mockImplementation(async (method: string) => {
      if (method === 'chat.send') {
        throw new GatewayRequestError({ code: 'INVALID_REQUEST', message: 'send blocked' });
      }
      return {};
    });

    await useChatStore.getState().send('restore this');

    expect(useChatStore.getState().lastError).toBe('send blocked');
    expect(useChatStore.getState().inputRestore?.text).toBe('restore this');
    expect(selectSessionRunView(useSessionRunsStore.getState(), 'main')).toMatchObject({
      command: 'idle',
      localRunId: null,
    });
  });

  it('recovers a persisted unknown ACK by exact idempotency evidence after F5/session restore', async () => {
    gateway.request.mockImplementation(async (method: string) => {
      if (method === 'chat.send') throw new Error('Connection closed while waiting for chat.send');
      if (method === 'sessions.list') return { sessions: [] };
      if (method === 'chat.history') return { messages: [] };
      return {};
    });
    await useChatStore.getState().send('persist this generation');
    const pendingRunId = (useChatStore.getState() as unknown as {
      _pendingSendAck: { runId: string };
    })._pendingSendAck.runId;

    useChatStore.getState().setSessionKey('project-b');
    useChatStore.getState().setSessionKey('main');
    gateway.request.mockImplementation(async (method: string) => {
      if (method === 'chat.history') {
        return {
          messages: [
            { role: 'user', text: 'persist this generation', idempotencyKey: `${pendingRunId}:user` },
            { role: 'assistant', text: 'completed while disconnected' },
          ],
        };
      }
      return {};
    });
    await useChatStore.getState().loadHistory();

    expect((useChatStore.getState() as unknown as { _pendingSendAck: unknown })._pendingSendAck).toBeNull();
    expect(useChatStore.getState()).toMatchObject({ runId: null, streaming: false });
    expect(selectSessionRunView(useSessionRunsStore.getState(), 'main').command).toBe('idle');
    expect(gateway.request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
  });
});
