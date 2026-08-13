import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';

import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';
import { useProductPolicyStore } from '../../stores/product-policy';
import { useSupervisorStore } from '../../stores/supervisor';
import SupervisorPanel from './SupervisorPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

describe('SupervisorPanel Settings CTA policy', () => {
  beforeEach(() => {
    useConfigStore.setState({ theme: 'dark', locale: 'en' });
    useProductPolicyStore.getState().loadFromConfig({
      plugins: { entries: { 'research-claw-core': { config: { productPolicy: {
        capabilities: {
          settings: 'enabled-hidden', extensions: 'enabled', supervisor: 'enabled', peripherals: 'enabled',
        },
      } } } } },
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request: vi.fn().mockResolvedValue({ entries: [], total: 0 }) } as never,
    });
    useSupervisorStore.getState().stopPolling();
    useSupervisorStore.setState({
      status: {
        enabled: false,
        reviewMode: 'off',
        supervisorModel: '',
        courseCorrectionEnabled: false,
        deviationThreshold: 0.5,
        forceRegenerate: false,
        maxRegenerateAttempts: 1,
        highRiskTools: [],
        stats: { total: 0, blocked: 0, corrected: 0, warnings: 0 },
        activeSessions: 0,
        sessionsInfo: [],
      },
      auditLog: [],
      auditLogTotal: 0,
      auditLogClearing: false,
    });
  });

  afterEach(() => {
    cleanup();
    useSupervisorStore.getState().stopPolling();
  });

  it('keeps the disabled explanation but removes the dead Go to Settings link', () => {
    render(<ConfigProvider><AntdApp><SupervisorPanel /></AntdApp></ConfigProvider>);

    expect(screen.getByText('Response and action review is off.')).toBeInTheDocument();
    expect(screen.queryByText('Go to Settings')).not.toBeInTheDocument();
  });
});
