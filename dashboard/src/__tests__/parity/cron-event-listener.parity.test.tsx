import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRON_AUTH_FIRST,
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

  it('rings on the third provider-preflight skip without creating a chat Alert', () => {
    render(<CronEventListener />);
    emit(CRON_PREFLIGHT_SKIP_THIRD);

    expect(notification.error).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().notifications[0]).toMatchObject({
      type: 'error',
      targetSessionKey: 'cron:monitor-job-7:run:preflight-3',
    });
    expect(useChatStore.getState().lastError).toBeNull();
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
