import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRON_AUTH_FIRST,
  CRON_AUTH_NEW_EPISODE,
  CRON_AUTH_SECOND,
  CRON_PREFLIGHT_SKIP_THIRD,
  CRON_SUCCESS_AFTER_FAILURE,
  CRON_TIMEOUT_FIRST,
  CRON_TIMEOUT_THIRD,
} from '../../__fixtures__/gateway-payloads/cron-events';

const notification = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const MockApp = Object.assign(actual.App, {
    useApp: () => ({ notification }),
  });
  return { ...actual, App: MockApp };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      return `${key}:${Object.values(params).join(':')}`;
    },
  }),
}));

import CronEventListener from '../../components/CronEventListener';
import { useChatStore } from '../../stores/chat';
import { useCronStore } from '../../stores/cron';
import { useGatewayStore } from '../../stores/gateway';
import { useMonitorStore } from '../../stores/monitor';
import { useUiStore } from '../../stores/ui';

type CronListener = (payload: unknown) => void;
let cronListener: CronListener | null = null;

beforeEach(() => {
  notification.info.mockReset();
  notification.error.mockReset();
  notification.destroy.mockReset();
  cronListener = null;
  localStorage.clear();
  useUiStore.setState({
    notifications: [],
    unreadCount: 0,
    notificationSoundEnabled: false,
    rightPanelTab: 'library',
    rightPanelOpen: false,
  });
  useChatStore.setState({ lastError: null, lastErrorMeta: null });
  useCronStore.setState({
    presets: [{
      id: 'preset-7',
      name: 'Citation monitor',
      description: '',
      schedule: '0 */6 * * *',
      enabled: true,
      config: {},
      last_run_at: null,
      next_run_at: null,
      gateway_job_id: 'monitor-job-7',
    }],
    presetsLoaded: true,
  });
  useMonitorStore.setState({ monitors: [], loaded: true, loading: false });
  useGatewayStore.setState({
    state: 'connected',
    client: {
      isConnected: true,
      subscribe: (event: string, listener: CronListener) => {
        if (event === 'cron') cronListener = listener;
        return vi.fn();
      },
    } as never,
  });
});

afterEach(cleanup);

function emit(payload: unknown): void {
  act(() => {
    cronListener?.(payload);
  });
}

describe('CronEventListener — background policy delivery', () => {
  it('keeps transient failures silent until three, then rings without touching chat Alert', () => {
    render(<CronEventListener />);
    expect(cronListener).not.toBeNull();

    emit(CRON_TIMEOUT_FIRST);
    expect(notification.error).not.toHaveBeenCalled();
    expect(useUiStore.getState().notifications).toHaveLength(0);

    emit(CRON_TIMEOUT_THIRD);
    expect(notification.error).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().notifications[0]).toMatchObject({
      type: 'error',
      targetSessionKey: 'cron:monitor-job-7:run:timeout-3',
    });
    expect(useChatStore.getState().lastError).toBeNull();
  });

  it('rings on the first auth failure and persists a Settings action', () => {
    render(<CronEventListener />);
    emit(CRON_AUTH_FIRST);

    expect(notification.error).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().notifications[0]).toMatchObject({
      type: 'error',
      targetPanel: 'settings',
      targetSessionKey: undefined,
    });
    expect(useChatStore.getState().lastErrorMeta).toBeNull();
  });

  // The run never started, so there is no session to open and nothing "failed
  // N times" — the actionable surface is the provider endpoint in Settings.
  it('rings on the third provider-preflight skip with skip wording and a Settings action', () => {
    render(<CronEventListener />);
    emit(CRON_PREFLIGHT_SKIP_THIRD);

    expect(notification.error).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().notifications[0]).toMatchObject({
      type: 'error',
      targetPanel: 'settings',
      targetSessionKey: undefined,
    });
    expect(useUiStore.getState().notifications[0]?.title).toContain('cron.skippedTitle');
    expect(useChatStore.getState().lastError).toBeNull();
  });

  // The gateway drops cron broadcasts under back-pressure, so the config
  // notification must not depend on catching the consecutiveErrors===1 event.
  it('reports a configuration failure once per episode, re-arming after a success', () => {
    render(<CronEventListener />);
    const midEpisode = {
      ...CRON_AUTH_FIRST,
      job: {
        ...CRON_AUTH_FIRST.job,
        state: { ...CRON_AUTH_FIRST.job.state, consecutiveErrors: 9 },
      },
    };

    emit(midEpisode);
    expect(notification.error).toHaveBeenCalledTimes(1);

    emit(midEpisode);
    expect(notification.error).toHaveBeenCalledTimes(1);

    emit(CRON_SUCCESS_AFTER_FAILURE);
    emit(midEpisode);
    expect(notification.error).toHaveBeenCalledTimes(2);
  });

  // The success that ends an episode is itself droppable, so recovery must not be
  // the only thing that re-arms the report.
  it('reports the next configuration episode even when the success was never delivered', () => {
    render(<CronEventListener />);

    emit(CRON_AUTH_FIRST);
    expect(notification.error).toHaveBeenCalledTimes(1);

    // No CRON_SUCCESS_AFTER_FAILURE: OpenClaw still zeroed the counter, which is
    // why the relapse arrives back at consecutiveErrors 1.
    emit(CRON_AUTH_NEW_EPISODE);
    expect(notification.error).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().notifications).toHaveLength(2);
  });

  // Covers the listener applying an episode write that came from a *silent*
  // decision: without it the watermark stalls and the next run re-notifies.
  it('stays quiet for the whole of a reported episode as its counter climbs', () => {
    render(<CronEventListener />);

    emit(CRON_AUTH_FIRST);
    expect(notification.error).toHaveBeenCalledTimes(1);

    emit(CRON_AUTH_SECOND);
    const third = {
      ...CRON_AUTH_SECOND,
      job: {
        ...CRON_AUTH_SECOND.job,
        state: { ...CRON_AUTH_SECOND.job.state, consecutiveErrors: 3 },
      },
      runAtMs: CRON_AUTH_SECOND.runAtMs + 21_600_000,
    };
    emit(third);

    expect(notification.error).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing success notification path for successful completions', () => {
    render(<CronEventListener />);
    emit(CRON_SUCCESS_AFTER_FAILURE);

    expect(notification.info).toHaveBeenCalledTimes(1);
    expect(notification.error).not.toHaveBeenCalled();
    expect(useUiStore.getState().notifications[0]).toMatchObject({
      type: 'system',
      targetSessionKey: 'cron:monitor-job-7:run:success',
    });
  });
});
