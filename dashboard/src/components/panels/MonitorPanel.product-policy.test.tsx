import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';

import { useChatStore } from '../../stores/chat';
import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';
import { useMonitorStore } from '../../stores/monitor';
import { useProductPolicyStore } from '../../stores/product-policy';
import MonitorPanel from './MonitorPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

function loadPeripheralsPolicy(state: 'enabled' | 'enabled-hidden' | 'disabled') {
  useProductPolicyStore.getState().loadFromConfig({
    plugins: { entries: { 'research-claw-core': { config: { productPolicy: {
      capabilities: {
        settings: 'enabled', extensions: 'enabled', supervisor: 'enabled', peripherals: state,
      },
    } } } } },
  });
}

describe('MonitorPanel peripheral source policy', () => {
  const send = vi.fn();

  beforeEach(() => {
    send.mockReset();
    useConfigStore.setState({ theme: 'dark' });
    useGatewayStore.setState({ state: 'connected' });
    useMonitorStore.setState({ monitors: [], loading: false, loaded: true, error: null });
    useChatStore.setState({ send } as never);
  });

  afterEach(cleanup);

  it('uses an ordinary-source prompt with no peripheral vocabulary when disabled', () => {
    loadPeripheralsPolicy('disabled');
    render(<ConfigProvider><AntdApp><MonitorPanel /></AntdApp></ConfigProvider>);

    fireEvent.click(screen.getByRole('button', { name: /monitor\.add/i }));

    expect(send).toHaveBeenCalledTimes(1);
    const prompt = String(send.mock.calls[0][0]);
    expect(prompt).toContain('arXiv');
    expect(prompt).not.toMatch(/camera|peripheral|device|periph_/i);
  });

  it.each(['\tDEVICE\n', '\u00a0DeViCe\u00a0'])(
    'does not render a legacy device row with source_type %j when disabled',
    (sourceType) => {
      loadPeripheralsPolicy('disabled');
      useMonitorStore.setState({
        monitors: [{
          id: 'legacy-device-monitor',
          name: 'Legacy hidden camera monitor',
          source_type: sourceType,
          target: 'camera-legacy',
          filters: {},
          schedule: '*/5 * * * *',
          enabled: true,
          notify: false,
          agent_prompt: '',
          gateway_job_id: null,
          last_check_at: null,
          last_results: null,
          last_error: null,
          check_count: 0,
          finding_count: 0,
          created_at: '2026-08-13T00:00:00Z',
          updated_at: '2026-08-13T00:00:00Z',
        }],
        loaded: true,
      });

      render(<ConfigProvider><AntdApp><MonitorPanel /></AntdApp></ConfigProvider>);

      expect(screen.queryByText('Legacy hidden camera monitor')).not.toBeInTheDocument();
    },
  );

  it.each(['enabled', 'enabled-hidden'] as const)(
    'retains device setup guidance when peripherals are %s',
    (state) => {
      loadPeripheralsPolicy(state);
      render(<ConfigProvider><AntdApp><MonitorPanel /></AntdApp></ConfigProvider>);

      fireEvent.click(screen.getByRole('button', { name: /monitor\.add/i }));

      expect(String(send.mock.calls[0][0])).toMatch(/Camera\/Peripheral.*periph_list/i);
    },
  );
});
