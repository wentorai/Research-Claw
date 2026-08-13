import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';

import { SESSIONS_LIST_RESPONSE } from '../__fixtures__/gateway-payloads/rpc-responses';
import { useGatewayStore } from '../stores/gateway';
import { usePeripheralsStore } from '../stores/peripherals';
import { useProductPolicyStore } from '../stores/product-policy';
import { useSessionsStore } from '../stores/sessions';
import { useUiStore } from '../stores/ui';
import LeftNav from './LeftNav';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  return <ConfigProvider><AntdApp>{children}</AntdApp></ConfigProvider>;
}

describe('LeftNav product-policy filtering', () => {
  beforeEach(() => {
    const request = vi.fn(async (method: string) => (
      method === 'sessions.list' ? SESSIONS_LIST_RESPONSE : {}
    ));
    useGatewayStore.setState({ state: 'connected', client: { isConnected: true, request } as never });
    useSessionsStore.setState({
      sessions: SESSIONS_LIST_RESPONSE.sessions,
      activeSessionKey: 'agent:main:main',
      loading: false,
    });
    usePeripheralsStore.setState({ devices: [], observations: {} });
    useUiStore.setState({ leftNavCollapsed: false, rightPanelTab: 'library', rightPanelOpen: false });
    useProductPolicyStore.getState().loadFromConfig({
      plugins: {
        entries: {
          'research-claw-core': {
            config: {
              productPolicy: {
                capabilities: {
                  settings: 'enabled-hidden',
                  extensions: 'enabled-hidden',
                  supervisor: 'enabled-hidden',
                  peripherals: 'disabled',
                },
              },
            },
          },
        },
      },
    });
  });

  afterEach(() => cleanup());

  it('does not render any hidden or disabled capability entry', () => {
    render(<Wrapper><LeftNav /></Wrapper>);

    expect(screen.getByText('nav.library')).toBeInTheDocument();
    expect(screen.getByText('nav.monitor')).toBeInTheDocument();
    expect(screen.queryByText('nav.peripherals')).not.toBeInTheDocument();
    expect(screen.queryByText('nav.supervisor')).not.toBeInTheDocument();
    expect(screen.queryByText('nav.extensions')).not.toBeInTheDocument();
    expect(screen.queryByText('nav.settings')).not.toBeInTheDocument();
  });
});
