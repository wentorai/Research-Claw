import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { App as AntdApp } from 'antd';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';

// CameraDetail touches navigator.mediaDevices + gateway contracts; stub it so the
// panel-navigation test stays focused on list ↔ detail switching.
vi.mock('../peripherals/CameraDetail', () => ({
  default: () => <div data-testid="camera-detail-stub">camera detail</div>,
}));

// PlaudCard touches peripheral + config stores at mount; stub it here so
// PeripheralsPanel navigation tests stay focused.
vi.mock('../peripherals/PlaudCard', () => ({
  default: () => <div data-testid="plaud-card-stub">plaud card</div>,
}));

// PlaceholderCards open Modals and read config store; stub them here so
// PeripheralsPanel navigation tests stay focused on slot rendering.
vi.mock('../peripherals/PlaceholderCards', () => ({
  LabPlaceholderCard: () => <div data-testid="lab-placeholder-stub">lab placeholder</div>,
  EmbodiedPlaceholderCard: () => <div data-testid="embodied-placeholder-stub">embodied placeholder</div>,
}));

// Mock i18n — t() returns fallback string if provided, else the key
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && 'defaultValue' in fallbackOrOpts) return fallbackOrOpts.defaultValue as string;
      return key;
    },
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

beforeEach(() => {
  vi.clearAllMocks();
  useConfigStore.setState({ theme: 'dark' });
  useGatewayStore.setState({
    state: 'connected',
    client: { isConnected: true, request: vi.fn() } as never,
  });
});

// ── VALID_TABS contains 'peripherals' ────────────────────────────────────────
describe('ui store — VALID_TABS', () => {
  it("VALID_TABS includes 'peripherals'", async () => {
    // We test indirectly: setRightPanelTab('peripherals') should persist and
    // loadPanelTab() should return 'peripherals' (it only returns valid tabs).
    const { useUiStore } = await import('../../stores/ui');
    useUiStore.getState().setRightPanelTab('peripherals');
    expect(useUiStore.getState().rightPanelTab).toBe('peripherals');
  });
});

// ── LeftNav renders nav.peripherals item ─────────────────────────────────────
describe('LeftNav — peripherals nav item', () => {
  it('renders Peripherals nav item', async () => {
    // Dynamic import to avoid circular dep issues with full component
    const { default: LeftNav } = await import('../LeftNav');
    const { useSessionsStore } = await import('../../stores/sessions');
    useSessionsStore.setState({
      sessions: [],
      activeSessionKey: 'main',
    });
    render(<Wrapper><LeftNav /></Wrapper>);
    // nav.peripherals key is rendered (t() returns key when no fallback)
    expect(screen.getByText('nav.peripherals')).toBeTruthy();
  });
});

// ── PeripheralsPanel — disconnected state ─────────────────────────────────────
describe('PeripheralsPanel', () => {
  it('shows disconnected guidance when gateway is not connected', async () => {
    useGatewayStore.setState({ state: 'disconnected', client: null });

    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    // t('periph.disconnected', 'Connect to gateway to manage peripherals') → returns fallback
    expect(screen.getByText('Connect to gateway to manage peripherals')).toBeTruthy();
  });

  it('renders four device card slots when connected', async () => {
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request: vi.fn() } as never,
    });

    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    expect(screen.getByTestId('periph-slot-camera')).toBeTruthy();
    expect(screen.getByTestId('periph-slot-plaud')).toBeTruthy();
    expect(screen.getByTestId('periph-slot-lab')).toBeTruthy();
    expect(screen.getByTestId('periph-slot-embodied')).toBeTruthy();
  });

  it('shows panel title when connected', async () => {
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    expect(screen.getByText('periph.title')).toBeTruthy();
  });

  it('lab slot renders LabPlaceholderCard stub (camera/plaud unaffected)', async () => {
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    // lab and embodied slots contain the placeholder stubs
    expect(screen.getByTestId('lab-placeholder-stub')).toBeTruthy();
    expect(screen.getByTestId('embodied-placeholder-stub')).toBeTruthy();

    // camera and plaud slots are unaffected
    expect(screen.getByTestId('periph-slot-camera')).toBeTruthy();
    expect(screen.getByTestId('plaud-card-stub')).toBeTruthy();
  });

  it('opens the camera detail view when the camera slot is clicked, and returns via Back', async () => {
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    // List → detail
    fireEvent.click(screen.getByTestId('periph-slot-camera'));
    await waitFor(() => expect(screen.getByTestId('camera-detail-stub')).toBeTruthy());
    expect(screen.getByTestId('periph-detail-back')).toBeTruthy();

    // Detail → list
    fireEvent.click(screen.getByTestId('periph-detail-back'));
    await waitFor(() => expect(screen.getByTestId('periph-slot-plaud')).toBeTruthy());
    expect(screen.queryByTestId('camera-detail-stub')).toBeNull();
  });
});
