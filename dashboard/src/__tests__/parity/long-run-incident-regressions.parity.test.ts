/**
 * Regression gates reconstructed from the real 2026-08-01 acceptance incident.
 *
 * These tests intentionally exercise continuous same-session transitions.
 * Isolated status rows are insufficient to catch the production race.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_LONG_420_AFTER_360_ACTIVE,
  ACCEPTANCE_LONG_420_FINAL,
  ACCEPTANCE_LONG_420_SESSION_KEY,
  ACCEPTANCE_LONG_420_V2_RUN_ID,
  ACCEPTANCE_F5_TIMEOUT_HISTORY,
  ACCEPTANCE_STOP_COMMAND_CONFIRMED,
  ACCEPTANCE_STOP_RUN_ID,
  INCIDENT_COARSE_TIMEOUT_SNAPSHOT,
  INCIDENT_SESSION_B_RUN_ID,
  INCIDENT_SESSION_KEY,
  INCIDENT_SLEEP_180_RUN_ID,
  INCIDENT_STALE_DONE_AFTER_NEW_ACK,
  INCIDENT_STALE_KILLED_AFTER_NEW_ACK,
} from '../../__fixtures__/gateway-payloads/long-run-incidents';
import { projectConfirmedStopCommand } from '../../utils/confirmed-stop-command';
import {
  beginSessionRunRequest,
  createSessionRunReconcilerState,
  getSessionRunLifecycle,
  getSessionRunRecord,
  reconcileSessionRun,
  type SessionRunReconcilerState,
  type SessionRunRowLike,
} from '../../utils/session-run-reconciler';

function snapshot(
  state: SessionRunReconcilerState,
  row: SessionRunRowLike,
  observedAt: number,
): SessionRunReconcilerState {
  const request = beginSessionRunRequest(state, INCIDENT_SESSION_KEY, { eventEpoch: 1 });
  return reconcileSessionRun(request.state, {
    type: 'snapshot',
    sessionKey: INCIDENT_SESSION_KEY,
    requestGeneration: request.generation,
    eventEpoch: 1,
    observedAt,
    row,
  });
}

describe('real long-run incident generation fencing', () => {
  it.each([
    ['done', INCIDENT_STALE_DONE_AFTER_NEW_ACK.sessions[0]],
    ['killed', INCIDENT_STALE_KILLED_AFTER_NEW_ACK.sessions[0]],
  ] as const)(
    'does not attribute a previous %s sessions.list terminal to a new local ACK generation',
    (_terminal, staleRow) => {
      let state = snapshot(createSessionRunReconcilerState(), staleRow, staleRow.endedAt);
      state = reconcileSessionRun(state, {
        type: 'local-start',
        sessionKey: INCIDENT_SESSION_KEY,
        runId: INCIDENT_SLEEP_180_RUN_ID,
        observedAt: staleRow.endedAt + 10_000,
      });
      state = snapshot(state, staleRow, staleRow.endedAt + 10_100);

      const record = getSessionRunRecord(state, INCIDENT_SESSION_KEY);
      expect(record?.runId).toBe(INCIDENT_SLEEP_180_RUN_ID);
      expect(record?.terminal).toBeUndefined();
      expect(getSessionRunLifecycle(record)).not.toBe(staleRow.status);
    },
  );

  it('keeps a same-generation done terminal absorbing against a late aborted event', () => {
    let state = reconcileSessionRun(createSessionRunReconcilerState(), {
      type: 'local-start',
      sessionKey: INCIDENT_SESSION_KEY,
      runId: INCIDENT_SESSION_B_RUN_ID,
      observedAt: 1_785_516_617_705,
    });
    state = reconcileSessionRun(state, {
      type: 'chat-terminal',
      sessionKey: INCIDENT_SESSION_KEY,
      runId: INCIDENT_SESSION_B_RUN_ID,
      status: 'done',
      eventEpoch: 1,
      seq: 30,
      observedAt: 1_785_516_677_727,
    });
    state = reconcileSessionRun(state, {
      type: 'chat-terminal',
      sessionKey: INCIDENT_SESSION_KEY,
      runId: INCIDENT_SESSION_B_RUN_ID,
      status: 'interrupted',
      eventEpoch: 1,
      seq: 31,
      observedAt: 1_785_516_677_900,
    });

    const record = getSessionRunRecord(state, INCIDENT_SESSION_KEY);
    expect(record?.terminal?.status).toBe('done');
    expect(getSessionRunLifecycle(record)).toBe('done');
  });

  it('does not let a cause-free timeout snapshot overwrite an observed RPC Stop', () => {
    let state = reconcileSessionRun(createSessionRunReconcilerState(), {
      type: 'local-start',
      sessionKey: INCIDENT_SESSION_KEY,
      runId: INCIDENT_SLEEP_180_RUN_ID,
      observedAt: 1_785_516_695_990,
    });
    state = reconcileSessionRun(state, {
      type: 'chat-terminal',
      sessionKey: INCIDENT_SESSION_KEY,
      runId: INCIDENT_SLEEP_180_RUN_ID,
      status: 'killed',
      eventEpoch: 1,
      seq: 40,
      observedAt: 1_785_516_720_844,
    });
    state = snapshot(
      state,
      INCIDENT_COARSE_TIMEOUT_SNAPSHOT.sessions[0],
      1_785_516_721_000,
    );

    const record = getSessionRunRecord(state, INCIDENT_SESSION_KEY);
    expect(record?.terminal?.status).toBe('killed');
    expect(getSessionRunLifecycle(record)).toBe('killed');
  });

  it('recovers a confirmed RPC Stop after F5 when OC only retains a coarse timeout', () => {
    const projected = projectConfirmedStopCommand(
      ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo,
      ACCEPTANCE_STOP_COMMAND_CONFIRMED,
    );

    expect(projected).toMatchObject({
      status: 'killed',
      hasActiveRun: false,
      startedAt: ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo.startedAt,
      endedAt: ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo.endedAt,
    });
  });

  it('does not apply an old confirmed Stop to a later run generation', () => {
    const projected = projectConfirmedStopCommand(
      {
        ...ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo,
        startedAt: ACCEPTANCE_STOP_COMMAND_CONFIRMED.confirmedAt + 1,
        endedAt: ACCEPTANCE_STOP_COMMAND_CONFIRMED.confirmedAt + 60_000,
      },
      ACCEPTANCE_STOP_COMMAND_CONFIRMED,
    );

    expect(projected.status).toBe('timeout');
    expect(projected).not.toHaveProperty('runId', ACCEPTANCE_STOP_RUN_ID);
  });

  it('keeps the exact real Run active beyond 360s and accepts only the later server terminal', () => {
    let state = reconcileSessionRun(createSessionRunReconcilerState(), {
      type: 'local-start',
      sessionKey: ACCEPTANCE_LONG_420_SESSION_KEY,
      runId: ACCEPTANCE_LONG_420_V2_RUN_ID,
      observedAt: ACCEPTANCE_LONG_420_AFTER_360_ACTIVE.startedAt,
    });
    const request = beginSessionRunRequest(state, ACCEPTANCE_LONG_420_SESSION_KEY, {
      eventEpoch: 3,
    });
    state = reconcileSessionRun(request.state, {
      type: 'snapshot',
      sessionKey: ACCEPTANCE_LONG_420_SESSION_KEY,
      requestGeneration: request.generation,
      eventEpoch: 3,
      observedAt: ACCEPTANCE_LONG_420_AFTER_360_ACTIVE.updatedAt,
      row: ACCEPTANCE_LONG_420_AFTER_360_ACTIVE,
    });

    expect(getSessionRunLifecycle(
      getSessionRunRecord(state, ACCEPTANCE_LONG_420_SESSION_KEY),
    )).toBe('running');

    state = reconcileSessionRun(state, {
      type: 'chat-terminal',
      sessionKey: ACCEPTANCE_LONG_420_SESSION_KEY,
      runId: ACCEPTANCE_LONG_420_V2_RUN_ID,
      status: 'done',
      eventEpoch: 3,
      seq: 54,
      observedAt: ACCEPTANCE_LONG_420_FINAL.endedAt,
    });

    expect(getSessionRunLifecycle(
      getSessionRunRecord(state, ACCEPTANCE_LONG_420_SESSION_KEY),
    )).toBe('done');
  });
});
