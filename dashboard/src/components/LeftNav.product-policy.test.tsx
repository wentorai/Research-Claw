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
import { fireEvent } from '@testing-library/react';
import { useTeamsStore } from '../stores/teams';

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
    useTeamsStore.setState({ open: false });
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

  it('renders teams with the shared navigation style, icon and active state', () => {
    render(<Wrapper><LeftNav /></Wrapper>);
    const teams = screen.getByRole('button', { name: 'nav.teams' });
    const library = screen.getByRole('button', { name: 'nav.library' });
    expect(teams.style.height).toBe(library.style.height);
    expect(teams.style.padding).toBe(library.style.padding);
    expect(teams.querySelector('[aria-label="team"]')).toBeTruthy();
    fireEvent.click(teams);
    expect(teams).toHaveAttribute('aria-current', 'page');
    fireEvent.click(library);
    expect(useTeamsStore.getState().open).toBe(false);
  });

  it('shows only the team icon in collapsed navigation', () => {
    useUiStore.setState({ leftNavCollapsed: true });
    render(<Wrapper><LeftNav /></Wrapper>);
    const teams = screen.getByRole('button', { name: 'nav.teams' });
    expect(teams.querySelector('[aria-label="team"]')).toBeTruthy();
    expect(teams.textContent).toBe('');
  });

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
