import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';

import { useConfigStore } from '../stores/config';
import { useProductPolicyStore } from '../stores/product-policy';
import { useUiStore } from '../stores/ui';
import NotificationDropdown from './NotificationDropdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

describe('NotificationDropdown product-policy targets', () => {
  beforeEach(() => {
    useConfigStore.setState({ theme: 'dark', locale: 'en' });
    useProductPolicyStore.getState().loadFromConfig({
      plugins: { entries: { 'research-claw-core': { config: { productPolicy: {
        capabilities: {
          settings: 'enabled-hidden', extensions: 'enabled', supervisor: 'enabled', peripherals: 'enabled',
        },
      } } } } },
    });
    useUiStore.setState({
      notifications: [{
        id: 'stale-settings', type: 'error', title: 'Stale Settings action',
        timestamp: new Date().toISOString(), read: true, targetPanel: 'settings',
      }],
      unreadCount: 0,
      rightPanelTab: 'library',
      rightPanelOpen: false,
    });
  });

  afterEach(cleanup);

  it('renders a read hidden-only target as non-interactive and cannot navigate it', async () => {
    render(<ConfigProvider><AntdApp><NotificationDropdown /></AntdApp></ConfigProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'a11y.notifications' }));

    const label = await screen.findByText('Stale Settings action');
    const item = label.closest('[data-notification-id="stale-settings"]');
    expect(item).not.toHaveAttribute('role');
    fireEvent.click(item!);
    expect(useUiStore.getState()).toMatchObject({ rightPanelTab: 'library', rightPanelOpen: false });
  });
});
