import { beforeEach, describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_F5_TIMEOUT_HISTORY,
  ACCEPTANCE_LATE_TIMEOUT_SESSION_EVENT,
  ACCEPTANCE_STOP_COMMAND_CONFIRMED,
} from '../__fixtures__/gateway-payloads/long-run-incidents';
import {
  projectStoredConfirmedStopCommand,
  rememberConfirmedStopCommand,
  resetConfirmedStopCommandsForTests,
} from './confirmed-stop-command';

describe('confirmed Stop command evidence', () => {
  beforeEach(() => {
    resetConfirmedStopCommandsForTests();
  });

  it('survives a browser-store round trip without storing message content', () => {
    rememberConfirmedStopCommand(ACCEPTANCE_STOP_COMMAND_CONFIRMED);

    const projection = projectStoredConfirmedStopCommand(
      ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo,
      ACCEPTANCE_STOP_COMMAND_CONFIRMED.confirmedAt + 1,
    );

    expect(projection.row.status).toBe('killed');
    expect(projection.fact).toMatchObject({
      ...ACCEPTANCE_STOP_COMMAND_CONFIRMED,
      sessionKey: 'project-d254ab8b',
    });
    expect(localStorage.getItem('rc-confirmed-stop-commands-v1')).not.toContain(
      'sleep 180',
    );
  });

  it('requires complete lifecycle timestamps instead of filling missing fields', () => {
    rememberConfirmedStopCommand(ACCEPTANCE_STOP_COMMAND_CONFIRMED);

    const projection = projectStoredConfirmedStopCommand({
      ...ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo,
      endedAt: undefined,
    }, ACCEPTANCE_STOP_COMMAND_CONFIRMED.confirmedAt + 1);

    expect(projection.row.status).toBe('timeout');
    expect(projection.fact).toBeUndefined();
  });

  it('projects the exact late terminal event even though sessions.changed omits hasActiveRun', () => {
    rememberConfirmedStopCommand(ACCEPTANCE_STOP_COMMAND_CONFIRMED);

    const projection = projectStoredConfirmedStopCommand(
      ACCEPTANCE_LATE_TIMEOUT_SESSION_EVENT,
      ACCEPTANCE_STOP_COMMAND_CONFIRMED.confirmedAt + 1,
    );

    expect(projection.row.status).toBe('killed');
    expect(projection.fact?.runId).toBe(ACCEPTANCE_STOP_COMMAND_CONFIRMED.runId);
  });

  it('does not cross session ids even when timestamps overlap', () => {
    rememberConfirmedStopCommand({
      ...ACCEPTANCE_STOP_COMMAND_CONFIRMED,
      sessionId: ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo.sessionId,
    });

    const projection = projectStoredConfirmedStopCommand({
      ...ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo,
      sessionId: 'replacement-session',
    }, ACCEPTANCE_STOP_COMMAND_CONFIRMED.confirmedAt + 1);

    expect(projection.row.status).toBe('timeout');
  });

  it('expires bounded command evidence instead of becoming permanent run truth', () => {
    rememberConfirmedStopCommand(ACCEPTANCE_STOP_COMMAND_CONFIRMED);

    const projection = projectStoredConfirmedStopCommand(
      ACCEPTANCE_F5_TIMEOUT_HISTORY.sessionInfo,
      ACCEPTANCE_STOP_COMMAND_CONFIRMED.confirmedAt + 8 * 24 * 60 * 60 * 1000,
    );

    expect(projection.row.status).toBe('timeout');
    expect(projection.fact).toBeUndefined();
  });
});
