import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import customPolicyCapture from './__fixtures__/gateway-payloads/product-policy-custom.config-get-2026.6.1.json';
import noPolicyCapture from './__fixtures__/gateway-payloads/product-policy-none.config-get-2026.6.1.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./components/TopBar', () => ({ default: () => <div data-testid="topbar" /> }));
vi.mock('./components/LeftNav', () => ({ default: () => <div data-testid="leftnav" /> }));
vi.mock('./components/chat/ChatView', () => ({ default: () => <div data-testid="chat" /> }));
vi.mock('./components/RightPanel', () => ({ default: () => <div data-testid="right-panel" /> }));
vi.mock('./components/StatusBar', () => ({ default: () => <div data-testid="statusbar" /> }));
vi.mock('./components/setup/SetupWizard', () => ({ default: () => <div data-testid="setup-wizard" /> }));
vi.mock('./components/ProductPolicyRuntime', () => ({ default: () => <div data-testid="policy-runtime" /> }));
vi.mock('./components/PluginApprovalListener', () => ({ default: () => <div data-testid="plugin-approval-listener" /> }));
vi.mock('./components/CronEventListener', () => ({ default: () => null }));
vi.mock('./components/PaperReviewRunListener', () => ({ default: () => null }));
vi.mock('./components/ConfigRestartListener', () => ({ default: () => null }));
vi.mock('./components/ModelCatalogAligner', () => ({ default: () => null }));
vi.mock('./components/JobsActivityListener', () => ({ default: () => null }));
vi.mock('./components/CoreRuntimeAlert', () => ({ default: () => null }));

import App from './App';
import { useConfigStore } from './stores/config';
import { useGatewayStore } from './stores/gateway';
import { useProductPolicyStore } from './stores/product-policy';
import { useUiStore } from './stores/ui';

describe('App product-policy boot shell', () => {
  beforeEach(() => {
    useConfigStore.setState({
      bootState: 'ready',
      theme: 'dark',
      locale: 'en',
      loadConfig: vi.fn(),
    } as never);
    useGatewayStore.setState({
      state: 'connected',
      client: null,
      connectError: null,
      connect: vi.fn(),
    } as never);
    useUiStore.setState({ rightPanelOpen: false, leftNavCollapsed: false });
    useProductPolicyStore.getState().resetPending();
  });

  it('does not flash the main shell while config.get policy normalization is pending', () => {
    render(<App />);

    expect(screen.getByText('boot.loadingProductPolicy')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-approval-listener')).toBeInTheDocument();
    expect(screen.queryByTestId('leftnav')).not.toBeInTheDocument();
    expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('policy-runtime')).not.toBeInTheDocument();
  });

  it('fails closed with an explicit error and no shell for malformed present policy', () => {
    const malformed = structuredClone(customPolicyCapture.response.config) as {
      plugins: { entries: { 'research-claw-core': { config: {
        productPolicy: { capabilities: { peripherals: string } };
      } } } };
    };
    malformed.plugins.entries['research-claw-core'].config.productPolicy.capabilities.peripherals = 'off';
    expect(() => useProductPolicyStore.getState().loadFromConfig(malformed)).toThrow();

    render(<App />);

    expect(screen.getByText('boot.productPolicyInvalid')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-approval-listener')).toBeInTheDocument();
    expect(screen.getByText(/Invalid productPolicy capability state/)).toBeInTheDocument();
    expect(screen.queryByTestId('leftnav')).not.toBeInTheDocument();
    expect(screen.queryByTestId('policy-runtime')).not.toBeInTheDocument();
  });

  it('renders the ordinary shell/runtime from the real absent-policy fixture', () => {
    useProductPolicyStore.getState().loadFromConfig(
      noPolicyCapture.response.config as Record<string, unknown>,
    );

    render(<App />);

    expect(screen.getByTestId('leftnav')).toBeInTheDocument();
    expect(screen.getByTestId('chat')).toBeInTheDocument();
    expect(screen.getByTestId('policy-runtime')).toBeInTheDocument();
    expect(screen.getAllByTestId('plugin-approval-listener')).toHaveLength(1);
    expect(screen.queryByText('boot.loadingProductPolicy')).not.toBeInTheDocument();
  });

  it('renders the custom-profile shell/runtime without restricted-panel flash', () => {
    useProductPolicyStore.getState().loadFromConfig(
      customPolicyCapture.response.config as Record<string, unknown>,
    );

    render(<App />);

    expect(screen.getByTestId('leftnav')).toBeInTheDocument();
    expect(screen.getByTestId('policy-runtime')).toBeInTheDocument();
    expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();
  });

  it('handles Ctrl shortcuts at App level using custom visible order and CJK IME guards', () => {
    useProductPolicyStore.getState().loadFromConfig(
      customPolicyCapture.response.config as Record<string, unknown>,
    );
    render(<App />);

    fireEvent.keyDown(window, { key: '5', keyCode: 53, ctrlKey: true });
    expect(useUiStore.getState()).toMatchObject({ rightPanelTab: 'monitor', rightPanelOpen: true });

    useUiStore.setState({ rightPanelTab: 'library', rightPanelOpen: false });
    fireEvent.keyDown(window, { key: '6', keyCode: 54, ctrlKey: true });
    expect(useUiStore.getState()).toMatchObject({ rightPanelTab: 'library', rightPanelOpen: false });

    fireEvent.keyDown(window, { key: '2', keyCode: 50, ctrlKey: true, isComposing: true });
    expect(useUiStore.getState()).toMatchObject({ rightPanelTab: 'library', rightPanelOpen: false });
    fireEvent.keyDown(window, { key: '2', keyCode: 229, ctrlKey: true });
    expect(useUiStore.getState()).toMatchObject({ rightPanelTab: 'library', rightPanelOpen: false });
  });

  it('keeps first-run Setup usable even when Settings is hidden by the real custom fixture', () => {
    useProductPolicyStore.getState().loadFromConfig(
      customPolicyCapture.response.config as Record<string, unknown>,
    );
    useConfigStore.setState({ bootState: 'needs_setup' });

    render(<App />);

    expect(screen.getByTestId('setup-wizard')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-approval-listener')).toBeInTheDocument();
    expect(screen.queryByTestId('leftnav')).not.toBeInTheDocument();
  });

  it.each([
    ['legacy all-enabled', noPolicyCapture.response.config, customPolicyCapture.response.config],
    ['custom restricted', customPolicyCapture.response.config, noPolicyCapture.response.config],
  ])('fails the shell/runtime closed across a %s reconnect until the new profile lands', (
    _label,
    initialConfig,
    nextConfig,
  ) => {
    useProductPolicyStore.getState().loadFromConfig(initialConfig as Record<string, unknown>);
    render(<App />);
    expect(screen.getByTestId('leftnav')).toBeInTheDocument();
    expect(screen.getByTestId('policy-runtime')).toBeInTheDocument();

    act(() => useProductPolicyStore.getState().resetPending());

    expect(screen.getByText('boot.loadingProductPolicy')).toBeInTheDocument();
    expect(screen.queryByTestId('leftnav')).not.toBeInTheDocument();
    expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('policy-runtime')).not.toBeInTheDocument();

    act(() => {
      useProductPolicyStore.getState().loadFromConfig(nextConfig as Record<string, unknown>);
    });

    expect(screen.getByTestId('leftnav')).toBeInTheDocument();
    expect(screen.getByTestId('policy-runtime')).toBeInTheDocument();
    expect(screen.queryByText('boot.loadingProductPolicy')).not.toBeInTheDocument();
  });
});
