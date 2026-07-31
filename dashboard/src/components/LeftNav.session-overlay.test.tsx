import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { SESSIONS_LIST_RESPONSE } from '../__fixtures__/gateway-payloads/rpc-responses';
import { useGatewayStore } from '../stores/gateway';
import { usePeripheralsStore } from '../stores/peripherals';
import { useSessionsStore } from '../stores/sessions';
import { useUiStore } from '../stores/ui';
import LeftNav from './LeftNav';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => (
      typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key
    ),
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

async function openSessionDropdown() {
  const triggerLabel = await screen.findByText('Research discussion about transformers');
  const trigger = triggerLabel.closest('.ant-dropdown-trigger');
  expect(trigger).toBeTruthy();

  fireEvent.click(trigger!);
  await waitFor(() => expect(trigger).toHaveClass('ant-dropdown-open'));

  const search = await screen.findByPlaceholderText('Search sessions...');
  const popup = search.closest('.ant-dropdown');
  expect(popup).toBeTruthy();
  return { popup: popup!, trigger: trigger! };
}

describe('LeftNav session action overlays', () => {
  beforeEach(() => {
    const request = vi.fn().mockImplementation((method: string) => {
      if (method === 'sessions.list') return Promise.resolve(SESSIONS_LIST_RESPONSE);
      return Promise.resolve({});
    });

    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });
    useSessionsStore.setState({
      sessions: SESSIONS_LIST_RESPONSE.sessions,
      activeSessionKey: 'agent:main:main',
      loading: false,
    });
    usePeripheralsStore.setState({ devices: [], observations: {} });
    useUiStore.setState({ leftNavCollapsed: false });
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll('.ant-modal-root, .ant-dropdown').forEach((node) => node.remove());
  });

  it('closes the session dropdown before opening the rename modal', async () => {
    render(<Wrapper><LeftNav /></Wrapper>);

    const { popup, trigger } = await openSessionDropdown();
    const renameAction = popup.querySelector<HTMLElement>('.anticon-edit');
    expect(renameAction).toBeTruthy();

    fireEvent.click(renameAction!);

    expect(await screen.findByText('project.renameTitle')).toBeInTheDocument();
    await waitFor(() => expect(trigger).not.toHaveClass('ant-dropdown-open'));
    await waitFor(() => expect(popup.className).toMatch(/\b(?:ant-dropdown-hidden|ant-slide-up-leave)\b/));
  });

  it.each([
    ['clear', '.anticon-clear', 'project.clearConfirmTitle'],
    ['delete', '.anticon-delete', 'project.deleteConfirm'],
  ])('closes the session dropdown before opening the %s confirmation', async (
    _action,
    iconSelector,
    confirmationTitle,
  ) => {
    render(<Wrapper><LeftNav /></Wrapper>);

    const { popup, trigger } = await openSessionDropdown();
    const action = popup.querySelector<HTMLElement>(iconSelector);
    expect(action).toBeTruthy();

    fireEvent.click(action!);

    expect((await screen.findAllByText(confirmationTitle)).length).toBeGreaterThan(0);
    await waitFor(() => expect(trigger).not.toHaveClass('ant-dropdown-open'));
    await waitFor(() => expect(popup.className).toMatch(/\b(?:ant-dropdown-hidden|ant-slide-up-leave)\b/));
  });
});
