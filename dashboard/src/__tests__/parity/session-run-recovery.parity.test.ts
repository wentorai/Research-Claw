/** P1 recovery parity for chat.history sessionInfo + inFlightRun. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHAT_HISTORY_IN_FLIGHT_RESPONSE,
  SESSION_LIST_ACTIVE_RESPONSE,
} from '../../__fixtures__/gateway-payloads/session-run-state';
import { useChatStore } from '../../stores/chat';
import { selectSessionRunView, useSessionRunsStore } from '../../stores/session-runs';

const request = vi.fn();

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      client: { isConnected: true, request },
      state: 'connected',
      eventEpoch: 4,
      connId: 'runtime-1',
    }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

function reset() {
  useSessionRunsStore.getState().resetForTests();
  useChatStore.setState({
    messages: [],
    sending: false,
    streaming: false,
    compacting: false,
    streamText: null,
    runId: null,
    sessionKey: 'project-longrun',
    lastError: null,
    _pendingUserMsgs: [],
    _localOnlyMsgs: [],
  });
}

describe('chat.history run recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    reset();
  });

  it('restores inFlight runId, accumulated text, lifecycle and Stop after F5', async () => {
    request.mockResolvedValueOnce(CHAT_HISTORY_IN_FLIGHT_RESPONSE);

    await useChatStore.getState().loadHistory();

    expect(useChatStore.getState()).toMatchObject({
      runId: 'run-generation-1',
      streaming: true,
      streamText: 'I am checking the literature sources',
    });
    expect(selectSessionRunView(useSessionRunsStore.getState(), 'project-longrun')).toMatchObject({
      lifecycle: 'running',
      serverActive: true,
      canAbort: true,
      localRunId: 'run-generation-1',
    });
  });

  it('restores generic active and session-level Stop when inFlightRun is absent', async () => {
    request.mockResolvedValueOnce({
      sessionKey: 'agent:main:project-longrun',
      sessionInfo: SESSION_LIST_ACTIVE_RESPONSE.sessions[0],
      messages: [],
    });

    await useChatStore.getState().loadHistory();

    expect(selectSessionRunView(useSessionRunsStore.getState(), 'project-longrun')).toMatchObject({
      lifecycle: 'running',
      isBusy: true,
      canAbort: true,
      localRunId: null,
    });
    expect(useChatStore.getState()).toMatchObject({ runId: null, streamText: null });
  });

  it('discards an older same-session response after A → B → A switching', async () => {
    let resolveOld!: (value: unknown) => void;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    request.mockReturnValueOnce(old);
    const oldLoad = useChatStore.getState().loadHistory();

    useChatStore.getState().setSessionKey('project-b');
    useChatStore.getState().setSessionKey('project-longrun');
    request.mockResolvedValueOnce({ messages: [{ role: 'assistant', text: 'new result' }] });
    await useChatStore.getState().loadHistory();

    resolveOld({ messages: [{ role: 'assistant', text: 'stale result' }] });
    await oldLoad;

    expect(useChatStore.getState().messages.map((message) => message.text)).toEqual(['new result']);
  });
});
