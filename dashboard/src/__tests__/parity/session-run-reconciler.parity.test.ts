/**
 * Session lifecycle reducer parity and fencing tests.
 *
 * References:
 * - openclaw/ui/src/ui/controllers/sessions.ts (partial sessions.changed merge)
 * - openclaw/ui/src/ui/chat/run-lifecycle.ts (terminal stale-active fence)
 * - openclaw/src/gateway/session-lifecycle-state.ts (sessionId reset fence)
 */
import { describe, expect, it } from 'vitest';

import {
  SESSION_CHANGED_MESSAGE_PARTIAL,
  SESSION_CHANGED_TERMINAL_PARTIAL,
  SESSION_LIST_ACTIVE_RESPONSE,
  SESSION_LIST_GATEWAY_RESTART_RESPONSE,
  SESSION_LIST_TERMINAL_CONFLICT_RESPONSE,
} from '../../__fixtures__/gateway-payloads/session-run-state';
import {
  beginSessionRunRequest,
  createSessionRunReconcilerState,
  getSessionRunLifecycle,
  getSessionRunRecord,
  reconcileSessionRun,
} from '../../utils/session-run-reconciler';

const SESSION_KEY = 'project-longrun';

function applyActiveSnapshot() {
  const initial = createSessionRunReconcilerState();
  const request = beginSessionRunRequest(initial, SESSION_KEY, { eventEpoch: 1 });
  const state = reconcileSessionRun(request.state, {
    type: 'snapshot',
    sessionKey: SESSION_KEY,
    requestGeneration: request.generation,
    eventEpoch: 1,
    observedAt: 1_754_000_010_100,
    row: SESSION_LIST_ACTIVE_RESPONSE.sessions[0],
  });
  return state;
}

describe('session run reconciler', () => {
  it('applies a complete snapshot atomically and normalizes canonical keys', () => {
    const state = applyActiveSnapshot();
    const record = getSessionRunRecord(state, 'agent:main:project-longrun');

    expect(record?.truth).toMatchObject({
      sessionKey: SESSION_KEY,
      sessionId: 'session-generation-1',
      status: 'running',
      hasActiveRun: true,
      startedAt: 1_754_000_000_000,
    });
    expect(getSessionRunLifecycle(record)).toBe('running');
  });

  it('preserves hasActiveRun when a partial sessions.changed event omits it', () => {
    const state = reconcileSessionRun(applyActiveSnapshot(), {
      type: 'event',
      sessionKey: SESSION_CHANGED_MESSAGE_PARTIAL.sessionKey,
      eventEpoch: 1,
      seq: 11,
      observedAt: 1_754_000_011_100,
      patch: SESSION_CHANGED_MESSAGE_PARTIAL,
    });

    expect(getSessionRunRecord(state, SESSION_KEY)?.truth).toMatchObject({
      status: 'running',
      hasActiveRun: true,
    });
  });

  it('lets terminal status win even when the partial event omits hasActiveRun', () => {
    const state = reconcileSessionRun(applyActiveSnapshot(), {
      type: 'event',
      sessionKey: SESSION_CHANGED_TERMINAL_PARTIAL.sessionKey,
      eventEpoch: 1,
      seq: 12,
      observedAt: 1_754_000_020_100,
      runId: SESSION_CHANGED_TERMINAL_PARTIAL.runId,
      patch: SESSION_CHANGED_TERMINAL_PARTIAL,
    });
    const record = getSessionRunRecord(state, SESSION_KEY);

    expect(record?.truth).toMatchObject({ status: 'done', hasActiveRun: false });
    expect(getSessionRunLifecycle(record)).toBe('done');
  });

  it('ignores stale request generations instead of overwriting a newer snapshot', () => {
    const first = beginSessionRunRequest(createSessionRunReconcilerState(), SESSION_KEY, { eventEpoch: 1 });
    const second = beginSessionRunRequest(first.state, SESSION_KEY, { eventEpoch: 1 });
    let state = reconcileSessionRun(second.state, {
      type: 'snapshot',
      sessionKey: SESSION_KEY,
      requestGeneration: second.generation,
      eventEpoch: 1,
      observedAt: 200,
      row: SESSION_LIST_GATEWAY_RESTART_RESPONSE.sessions[0],
    });
    state = reconcileSessionRun(state, {
      type: 'snapshot',
      sessionKey: SESSION_KEY,
      requestGeneration: first.generation,
      eventEpoch: 1,
      observedAt: 100,
      row: SESSION_LIST_ACTIVE_RESPONSE.sessions[0],
    });

    expect(getSessionRunRecord(state, SESSION_KEY)?.truth?.hasActiveRun).toBe(false);
  });

  it('ignores duplicate, out-of-order, and prior-epoch events', () => {
    let state = reconcileSessionRun(applyActiveSnapshot(), {
      type: 'event',
      sessionKey: SESSION_KEY,
      eventEpoch: 2,
      seq: 20,
      observedAt: 300,
      patch: { status: 'done', endedAt: 300 },
    });
    for (const cursor of [
      { eventEpoch: 2, seq: 20 },
      { eventEpoch: 2, seq: 19 },
      { eventEpoch: 1, seq: 999 },
    ]) {
      state = reconcileSessionRun(state, {
        type: 'event',
        sessionKey: SESSION_KEY,
        observedAt: 400,
        patch: { status: 'running', hasActiveRun: true },
        ...cursor,
      });
    }

    expect(getSessionRunLifecycle(getSessionRunRecord(state, SESSION_KEY))).toBe('done');
  });

  it('does not let an old sessionId terminal event end a reset session', () => {
    let state = applyActiveSnapshot();
    state = reconcileSessionRun(state, {
      type: 'event',
      sessionKey: SESSION_KEY,
      eventEpoch: 2,
      seq: 1,
      observedAt: 1_754_000_030_000,
      patch: {
        phase: 'start',
        sessionId: 'session-generation-2',
        status: 'running',
        startedAt: 1_754_000_030_000,
      },
      runId: 'run-generation-2',
    });
    state = reconcileSessionRun(state, {
      type: 'event',
      sessionKey: SESSION_KEY,
      eventEpoch: 2,
      seq: 2,
      observedAt: 1_754_000_040_000,
      patch: {
        phase: 'end',
        sessionId: 'session-generation-1',
        status: 'failed',
        endedAt: 1_754_000_040_000,
      },
      runId: 'run-generation-1',
    });

    const record = getSessionRunRecord(state, SESSION_KEY);
    expect(record?.truth?.sessionId).toBe('session-generation-2');
    expect(getSessionRunLifecycle(record)).toBe('running');
  });

  it('keeps terminal absorbing against a late running event for the same generation', () => {
    let state = reconcileSessionRun(applyActiveSnapshot(), {
      type: 'event',
      sessionKey: SESSION_KEY,
      eventEpoch: 1,
      seq: 12,
      observedAt: 1_754_000_020_100,
      runId: 'run-generation-1',
      patch: SESSION_CHANGED_TERMINAL_PARTIAL,
    });
    state = reconcileSessionRun(state, {
      type: 'event',
      sessionKey: SESSION_KEY,
      eventEpoch: 1,
      seq: 13,
      observedAt: 1_754_000_020_200,
      runId: 'run-generation-1',
      patch: { status: 'running', hasActiveRun: true, startedAt: 1_754_000_000_000 },
    });

    expect(getSessionRunLifecycle(getSessionRunRecord(state, SESSION_KEY))).toBe('done');
  });

  it('allows a genuinely newer run to replace a terminal fence', () => {
    let state = reconcileSessionRun(applyActiveSnapshot(), {
      type: 'event',
      sessionKey: SESSION_KEY,
      eventEpoch: 1,
      seq: 12,
      observedAt: 1_754_000_020_100,
      runId: 'run-generation-1',
      patch: SESSION_CHANGED_TERMINAL_PARTIAL,
    });
    state = reconcileSessionRun(state, {
      type: 'event',
      sessionKey: SESSION_KEY,
      eventEpoch: 1,
      seq: 13,
      observedAt: 1_754_000_030_000,
      runId: 'run-generation-2',
      patch: {
        phase: 'start',
        status: 'running',
        hasActiveRun: true,
        startedAt: 1_754_000_030_000,
      },
    });

    expect(getSessionRunLifecycle(getSessionRunRecord(state, SESSION_KEY))).toBe('running');
  });

  it('isolates concurrent sessions by normalized sessionKey', () => {
    let state = applyActiveSnapshot();
    const other = beginSessionRunRequest(state, 'project-b', { eventEpoch: 1 });
    state = reconcileSessionRun(other.state, {
      type: 'snapshot',
      sessionKey: 'project-b',
      requestGeneration: other.generation,
      eventEpoch: 1,
      observedAt: 100,
      row: {
        key: 'agent:main:project-b',
        sessionId: 'session-b',
        status: 'running',
        hasActiveRun: true,
        startedAt: 100,
      },
    });
    state = reconcileSessionRun(state, {
      type: 'event',
      sessionKey: SESSION_KEY,
      eventEpoch: 1,
      seq: 12,
      observedAt: 200,
      patch: { status: 'done', endedAt: 200 },
    });

    expect(getSessionRunLifecycle(getSessionRunRecord(state, SESSION_KEY))).toBe('done');
    expect(getSessionRunLifecycle(getSessionRunRecord(state, 'project-b'))).toBe('running');
  });

  it('matches conflict precedence for gateway restart and terminal rows', () => {
    const restart = beginSessionRunRequest(createSessionRunReconcilerState(), SESSION_KEY, { eventEpoch: 1 });
    const restartState = reconcileSessionRun(restart.state, {
      type: 'snapshot',
      sessionKey: SESSION_KEY,
      requestGeneration: restart.generation,
      eventEpoch: 1,
      observedAt: 100,
      row: SESSION_LIST_GATEWAY_RESTART_RESPONSE.sessions[0],
    });
    const terminal = beginSessionRunRequest(createSessionRunReconcilerState(), SESSION_KEY, { eventEpoch: 1 });
    const terminalState = reconcileSessionRun(terminal.state, {
      type: 'snapshot',
      sessionKey: SESSION_KEY,
      requestGeneration: terminal.generation,
      eventEpoch: 1,
      observedAt: 100,
      row: SESSION_LIST_TERMINAL_CONFLICT_RESPONSE.sessions[0],
    });

    expect(getSessionRunLifecycle(getSessionRunRecord(restartState, SESSION_KEY))).toBe('unknown');
    expect(getSessionRunLifecycle(getSessionRunRecord(terminalState, SESSION_KEY))).toBe('timeout');
  });
});
