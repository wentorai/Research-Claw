import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';

import { useGatewayStore } from '../stores/gateway';
import { useProductPolicyStore } from '../stores/product-policy';
import { useUiStore, type PanelTab } from '../stores/ui';
import RightPanel from './RightPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('./panels/LibraryPanel', () => ({ default: () => <div data-testid="panel-library" /> }));
vi.mock('./panels/WorkspacePanel', () => ({ default: () => <div data-testid="panel-workspace" /> }));
vi.mock('./panels/TaskPanel', () => ({ default: () => <div data-testid="panel-tasks" /> }));
vi.mock('./panels/JobsPanel', () => ({ default: () => <div data-testid="panel-jobs" /> }));
vi.mock('./panels/MonitorPanel', () => ({ default: () => <div data-testid="panel-monitor" /> }));
vi.mock('./panels/ExtensionsPanel', () => ({ default: () => <div data-testid="panel-extensions" /> }));
vi.mock('./panels/SettingsPanel', () => ({ default: () => <div data-testid="panel-settings" /> }));
vi.mock('./panels/SupervisorPanel', () => ({ default: () => <div data-testid="panel-supervisor" /> }));
vi.mock('./panels/PaperReviewPanel', () => ({ default: () => <div data-testid="panel-review" /> }));
vi.mock('./panels/PeripheralsPanel', () => ({ default: () => <div data-testid="panel-peripherals" /> }));

describe('RightPanel defense-in-depth policy guard', () => {
  beforeEach(() => {
    useGatewayStore.setState({ coreFailure: null });
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
    useUiStore.setState({ rightPanelTab: 'library', rightPanelOpen: true });
  });

  afterEach(() => cleanup());

  it.each(['settings', 'extensions', 'supervisor', 'peripherals'] as PanelTab[])(
    'never mounts a directly injected restricted %s panel',
    async (tab) => {
      useUiStore.setState({ rightPanelTab: tab, rightPanelOpen: true });
      render(<ConfigProvider><RightPanel /></ConfigProvider>);

      expect(await screen.findByTestId('panel-library')).toBeInTheDocument();
      expect(screen.queryByTestId(`panel-${tab}`)).not.toBeInTheDocument();
      expect(useUiStore.getState().rightPanelTab).toBe('library');
    },
  );

  it('repairs an injected hidden tab without opening a previously closed panel', async () => {
    useUiStore.setState({ rightPanelTab: 'extensions', rightPanelOpen: false });
    render(<ConfigProvider><RightPanel /></ConfigProvider>);

    expect(await screen.findByTestId('panel-library')).toBeInTheDocument();
    expect(useUiStore.getState()).toMatchObject({
      rightPanelTab: 'library',
      rightPanelOpen: false,
    });
  });
});
