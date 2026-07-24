import { describe, expect, it } from 'vitest';
import {
  CRON_AUTH_FIRST,
  CRON_PREFLIGHT_SKIP_FIRST,
  CRON_PREFLIGHT_SKIP_THIRD,
  CRON_SUCCESS_AFTER_FAILURE,
  CRON_TIMEOUT_FIRST,
  CRON_TIMEOUT_THIRD,
} from '../../__fixtures__/gateway-payloads/cron-events';
import { classifyCronCompletion } from '../../utils/cron-failure-notification';
import { navigateNotificationTarget } from '../../components/NotificationDropdown';
import { useUiStore } from '../../stores/ui';

describe('background cron failure policy — OpenClaw 2026.6.1 payload parity', () => {
  it('keeps the first transient timeout silent while OpenClaw can self-heal', () => {
    expect(classifyCronCompletion(CRON_TIMEOUT_FIRST)).toEqual({
      action: 'silent',
      reason: 'below-transient-threshold',
    });
  });

  it('rings once at the third consecutive transient failure', () => {
    const result = classifyCronCompletion(CRON_TIMEOUT_THIRD);
    expect(result).toMatchObject({
      action: 'notify-transient',
      failureKind: 'timeout',
      consecutiveCount: 3,
      targetSessionKey: CRON_TIMEOUT_THIRD.sessionKey,
    });
    if (result.action !== 'notify-transient') throw new Error('expected transient notification');
    expect(result.dedupKey).toContain(String(CRON_TIMEOUT_THIRD.runAtMs));
  });

  it('rings on the first configuration-permanent failure and routes to settings', () => {
    expect(classifyCronCompletion(CRON_AUTH_FIRST)).toMatchObject({
      action: 'notify-config',
      failureKind: 'auth',
      consecutiveCount: 1,
      targetPanel: 'settings',
    });
  });

  it('does not create a recovery notification for a successful run', () => {
    expect(classifyCronCompletion(CRON_SUCCESS_AFTER_FAILURE)).toEqual({
      action: 'success',
    });
  });

  it('uses consecutiveSkipped for real provider-preflight skips', () => {
    expect(classifyCronCompletion(CRON_PREFLIGHT_SKIP_FIRST)).toEqual({
      action: 'silent',
      reason: 'below-transient-threshold',
    });
    expect(classifyCronCompletion(CRON_PREFLIGHT_SKIP_THIRD)).toMatchObject({
      action: 'notify-transient',
      failureKind: 'timeout',
      consecutiveCount: 3,
      targetSessionKey: CRON_PREFLIGHT_SKIP_THIRD.sessionKey,
    });
  });

  it('uses the post-run job snapshot counter, not a dashboard-local counter', () => {
    const malformed = {
      ...CRON_TIMEOUT_THIRD,
      job: {
        ...CRON_TIMEOUT_THIRD.job,
        state: {
          ...CRON_TIMEOUT_THIRD.job.state,
          consecutiveErrors: undefined,
        },
      },
    };
    expect(classifyCronCompletion(malformed)).toEqual({
      action: 'silent',
      reason: 'missing-consecutive-count',
    });
  });

  it('opens Settings from a persisted configuration-failure notification', () => {
    useUiStore.setState({ rightPanelTab: 'library', rightPanelOpen: false });
    navigateNotificationTarget({ targetPanel: 'settings' });
    expect(useUiStore.getState()).toMatchObject({
      rightPanelTab: 'settings',
      rightPanelOpen: true,
    });
  });
});
