/**
 * P0 authority integration tests: OpenClaw Session truth drives busy/Stop;
 * local command and activity remain independent projections.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_LIST_ACTIVE_RESPONSE } from '../../__fixtures__/gateway-payloads/session-run-state';
import {
  selectSessionRunView,
  useSessionRunsStore,
} from '../../stores/session-runs';

describe('central session run authority', () => {
  beforeEach(() => {
    useSessionRunsStore.getState().resetForTests();
  });

  it('keeps command, lifecycle, and activity as separate dimensions', () => {
    const store = useSessionRunsStore.getState();
    store.setCommand('project-longrun', 'submitting');
    store.setLocalRunId('project-longrun', 'local-run-1');
    store.observeActivity({
      sessionKey: 'project-longrun',
      runId: 'local-run-1',
      kind: 'streaming',
      label: 'streaming',
      observedAt: 100,
      source: 'chat-event',
    });

    const view = selectSessionRunView(useSessionRunsStore.getState(), 'project-longrun');
    expect(view).toMatchObject({
      command: 'submitting',
      lifecycle: 'unknown',
      isBusy: true,
      canAbort: true,
      isStreaming: true,
    });
  });

  it('derives busy and Stop from authoritative server active after local runId is lost', () => {
    useSessionRunsStore.getState().ingestSnapshot(
      SESSION_LIST_ACTIVE_RESPONSE.sessions[0],
      { eventEpoch: 1, observedAt: 200 },
    );

    const view = selectSessionRunView(useSessionRunsStore.getState(), 'agent:main:project-longrun');
    expect(view).toMatchObject({
      command: 'idle',
      lifecycle: 'running',
      serverActive: true,
      isBusy: true,
      canAbort: true,
    });
    expect(view.localRunId).toBeNull();
  });

  it('atomically clears only the terminal session generation', () => {
    const store = useSessionRunsStore.getState();
    store.ingestSnapshot(SESSION_LIST_ACTIVE_RESPONSE.sessions[0], { eventEpoch: 1, observedAt: 200 });
    store.ingestSnapshot({
      key: 'agent:main:project-b',
      sessionId: 'session-b',
      status: 'running',
      hasActiveRun: true,
      startedAt: 100,
    }, { eventEpoch: 1, observedAt: 200 });
    store.setCommand('project-longrun', 'stopping');
    store.setLocalRunId('project-longrun', 'run-generation-1');
    store.setCommand('project-b', 'submitting');
    store.setLocalRunId('project-b', 'run-b');

    store.applyChatTerminal({
      sessionKey: 'project-longrun',
      runId: 'run-generation-1',
      status: 'done',
      eventEpoch: 1,
      seq: 30,
      observedAt: 300,
    });

    expect(selectSessionRunView(useSessionRunsStore.getState(), 'project-longrun')).toMatchObject({
      command: 'idle',
      lifecycle: 'done',
      canAbort: false,
    });
    expect(selectSessionRunView(useSessionRunsStore.getState(), 'project-b')).toMatchObject({
      command: 'submitting',
      lifecycle: 'running',
      canAbort: true,
    });
  });
});
