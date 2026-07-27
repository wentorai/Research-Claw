import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore, type PeriphDeviceRow, type PeriphObservationRow } from '../../stores/peripherals';
import { useMonitorStore } from '../../stores/monitor';

// §14 rewrite: PeripheralsPanel now renders store.devices as first-class device
// cards (DeviceCard), plus an explicit [+ Add device] entry (AddDeviceFlow), plus
// Lab/Embodied placeholder cards. These tests drive the REAL peripherals + monitor
// stores (only the gateway client.request is a mock returning real payload shapes)
// so the data-source flip (§14.1) is exercised, not mocked away.

// CameraDetail touches navigator.mediaDevices + gateway contracts; stub it so the
// panel-navigation test stays focused on card ↔ detail switching.
vi.mock('../peripherals/CameraDetail', () => ({
  default: ({ deviceId }: { deviceId: string | null }) => (
    <div data-testid="camera-detail-stub" data-device-id={String(deviceId)}>
      camera detail
    </div>
  ),
}));

// PlaudCard touches peripheral + config stores; stub it (it is rendered inside
// AddDeviceFlow's Plaud pane, not at the top level in IA v2).
vi.mock('../peripherals/PlaudCard', () => ({
  default: () => <div data-testid="plaud-card-stub">plaud card</div>,
}));

// PlaceholderCards open Modals and read config store; stub them so panel tests
// stay focused on device-card rendering.
vi.mock('../peripherals/PlaceholderCards', () => ({
  LabPlaceholderCard: () => <div data-testid="lab-placeholder-stub">lab placeholder</div>,
  EmbodiedPlaceholderCard: () => <div data-testid="embodied-placeholder-stub">embodied placeholder</div>,
}));

// Mock i18n — t() returns fallback string if provided, else the key. Interpolates
// {{var}} from option keys so count/name copy is assertable.
function interpolate(template: string, opts: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k) => (k in opts ? String(opts[k]) : `{{${k}}}`));
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && 'defaultValue' in fallbackOrOpts) {
        return interpolate(fallbackOrOpts.defaultValue as string, fallbackOrOpts);
      }
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

// ── Device fixtures (real PeriphDeviceRow shape) ──────────────────────────────
function makeDevice(overrides: Partial<PeriphDeviceRow> = {}): PeriphDeviceRow {
  return {
    id: 'dev-cam-001',
    name: 'FaceTime HD Camera',
    kind: 'camera',
    driver: 'browser-camera',
    enabled: true,
    config: { deviceId: 'cam-a', label: 'FaceTime HD Camera' },
    check_prompt: 'Is the bench clear?',
    last_seen_at: null,
    last_error: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const PLAUD_DEVICE = makeDevice({
  id: 'plaud',
  name: 'Plaud 录音笔',
  kind: 'audio-recorder',
  driver: 'mcp-plaud',
  config: {},
  check_prompt: '',
});

function makeObs(overrides: Partial<PeriphObservationRow> = {}): PeriphObservationRow {
  return {
    id: 'obs-1',
    device_id: 'dev-cam-001',
    monitor_id: 'mon-1',
    kind: 'check',
    verdict: 'ok',
    summary: 'Bench is clear',
    frame_path: null,
    result_json: {},
    captured_at: '2026-07-20T10:00:00.000Z',
    cursor: 1,
    ...overrides,
  };
}

// ── mediaDevices harness (browser enumeration is an internal source, §14.1) ───
function installMediaDevices(cams: Array<Record<string, string>>) {
  const enumerate = vi.fn().mockResolvedValue(cams);
  const getUserMedia = vi.fn().mockResolvedValue({
    getTracks: () => [{ stop: vi.fn() }],
    getVideoTracks: () => [{ stop: vi.fn(), getSettings: () => ({}) }],
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: enumerate, getUserMedia },
  });
  return { enumerate, getUserMedia };
}

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

const PRESENT_CAMERAS = [
  { deviceId: 'cam-a', kind: 'videoinput', label: 'FaceTime HD Camera', groupId: 'g1' },
  { deviceId: 'cam-b', kind: 'videoinput', label: 'USB Webcam', groupId: 'g2' },
];

let mockRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  setSecureContext(true);
  installMediaDevices(PRESENT_CAMERAS);
  useConfigStore.setState({ theme: 'dark', gatewayConfig: null });
  // Return real payload shapes per method so store calls (loadObservations etc.)
  // resolve to valid data instead of crashing on undefined fields.
  mockRequest = vi.fn().mockImplementation((method: string) => {
    if (method === 'rc.periph.observations.list') return Promise.resolve({ observations: [] });
    if (method === 'rc.periph.devices.list') return Promise.resolve({ devices: usePeripheralsStore.getState().devices });
    return Promise.resolve({});
  });
  useGatewayStore.setState({
    state: 'connected',
    client: { isConnected: true, request: mockRequest } as never,
  });
  // Real stores, empty by default. Individual tests set devices/monitors/observations.
  usePeripheralsStore.setState({
    devices: [],
    observations: {},
    observationsHasMore: {},
    loading: false,
    error: null,
    unavailable: false,
  });
  useMonitorStore.setState({ monitors: [], loading: false, loaded: true });
});

afterEach(() => {
  // Reset stores so device rows don't leak across tests.
  usePeripheralsStore.setState({ devices: [], observations: {}, observationsHasMore: {} });
  useMonitorStore.setState({ monitors: [], loaded: true });
});

// ── VALID_TABS + LeftNav (unchanged nav wiring) ───────────────────────────────
describe('ui store — VALID_TABS', () => {
  it("VALID_TABS includes 'peripherals'", async () => {
    const { useUiStore } = await import('../../stores/ui');
    useUiStore.getState().setRightPanelTab('peripherals');
    expect(useUiStore.getState().rightPanelTab).toBe('peripherals');
  });
});

describe('LeftNav — peripherals nav item', () => {
  it('renders Peripherals nav item', async () => {
    const { default: LeftNav } = await import('../LeftNav');
    const { useSessionsStore } = await import('../../stores/sessions');
    useSessionsStore.setState({ sessions: [], activeSessionKey: 'main' });
    render(<Wrapper><LeftNav /></Wrapper>);
    expect(screen.getByText('nav.peripherals')).toBeTruthy();
  });

  it('surfaces an alert latest verdict as a red dot on the peripherals tab (P2-S1)', async () => {
    const { default: LeftNav } = await import('../LeftNav');
    const { useSessionsStore } = await import('../../stores/sessions');
    useSessionsStore.setState({ sessions: [], activeSessionKey: 'main' });
    usePeripheralsStore.setState({
      devices: [makeDevice()],
      observations: { 'dev-cam-001': [makeObs({ verdict: 'alert' })] },
    });

    render(<Wrapper><LeftNav /></Wrapper>);

    expect(screen.getByTestId('nav-peripherals-alert')).toBeTruthy();
  });
});

// ── Disconnected + header ─────────────────────────────────────────────────────
describe('PeripheralsPanel — connection + header', () => {
  it('shows disconnected guidance when gateway is not connected', async () => {
    useGatewayStore.setState({ state: 'disconnected', client: null });
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);
    expect(screen.getByText('Connect to gateway to manage peripherals')).toBeTruthy();
  });

  it('shows the panel title and an explicit [+ Add device] button when connected (§14.3)', async () => {
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);
    expect(screen.getByText('Peripherals')).toBeTruthy();
    expect(screen.getByTestId('periph-add-device-btn')).toBeTruthy();
  });

  it('calls loadDevices on mount (data-source flip, §14.1)', async () => {
    const spy = vi.spyOn(usePeripheralsStore.getState(), 'loadDevices');
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });
});

// ── Empty state guide (§14.6 / P1-U1) ─────────────────────────────────────────
describe('PeripheralsPanel — empty guide', () => {
  it('renders a guide card (not a silent empty div) when there are no devices', async () => {
    usePeripheralsStore.setState({ devices: [] });
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);
    expect(screen.getByTestId('periph-empty-guide')).toBeTruthy();
    // Placeholder cards stay below the guide.
    expect(screen.getByTestId('lab-placeholder-stub')).toBeTruthy();
    expect(screen.getByTestId('embodied-placeholder-stub')).toBeTruthy();
  });
});

// ── Device cards render from store.devices (§14.2) ────────────────────────────
describe('PeripheralsPanel — device cards from store (§14.2)', () => {
  it('renders one DeviceCard per registered device, including plaud', async () => {
    usePeripheralsStore.setState({ devices: [makeDevice(), PLAUD_DEVICE] });
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    expect(screen.getByTestId('periph-device-card-dev-cam-001')).toBeTruthy();
    // plaud renders as its own top-level device card (P1-M1), no longer hidden.
    expect(screen.getByTestId('periph-device-card-plaud')).toBeTruthy();
    // Device name is shown.
    expect(screen.getByTestId('periph-device-name-dev-cam-001').textContent).toContain('FaceTime HD Camera');
  });

  it('shows a GREEN "Bridging" status for an enabled+enumerated camera bridge (§14.2)', async () => {
    usePeripheralsStore.setState({ devices: [makeDevice({ enabled: true })] });
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    await waitFor(() => {
      const label = screen.getByTestId('periph-device-status-label-dev-cam-001');
      expect(label.textContent).toContain('Bridging');
    });
    const card = screen.getByTestId('periph-device-card-dev-cam-001');
    expect(card.getAttribute('data-status')).toBe('online');
  });

  it('shows the device monitor count from the monitor store (§14.2)', async () => {
    usePeripheralsStore.setState({ devices: [makeDevice()] });
    useMonitorStore.setState({
      monitors: [
        {
          id: 'mon-1', name: 'c1', source_type: 'device', target: 'dev-cam-001',
          filters: {}, schedule: '*/5 * * * *', enabled: true, notify: false, agent_prompt: '',
          gateway_job_id: 'j1', last_check_at: null, last_results: null, last_error: null,
          check_count: 0, finding_count: 0, created_at: '', updated_at: '',
        },
        {
          id: 'mon-2', name: 'other', source_type: 'device', target: 'dev-cam-999',
          filters: {}, schedule: '*/5 * * * *', enabled: true, notify: false, agent_prompt: '',
          gateway_job_id: 'j2', last_check_at: null, last_results: null, last_error: null,
          check_count: 0, finding_count: 0, created_at: '', updated_at: '',
        },
      ],
      loaded: true,
    });
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);
    // Only the mon-1 target matches this device → count 1.
    expect(screen.getByTestId('periph-device-monitor-count-dev-cam-001').textContent).toContain('1 scheduled check');
  });

  it('shows the latest observation verdict dot when observations exist (§14.2 / P2-S1)', async () => {
    usePeripheralsStore.setState({
      devices: [makeDevice()],
      observations: { 'dev-cam-001': [makeObs({ verdict: 'alert' })] },
    });
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);
    const dot = screen.getByTestId('periph-device-latest-dot-dev-cam-001');
    expect(dot.getAttribute('data-verdict')).toBe('alert');
  });
});

// ── Orphan / offline device (§14.6) ───────────────────────────────────────────
describe('PeripheralsPanel — orphan / offline device (§14.6)', () => {
  it('renders an OFFLINE card with a rebind entry when config.deviceId is not enumerated', async () => {
    usePeripheralsStore.setState({
      devices: [makeDevice({ config: { deviceId: 'cam-GONE', label: 'Unplugged Cam' }, enabled: true })],
    });
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    await waitFor(() => {
      const card = screen.getByTestId('periph-device-card-dev-cam-001');
      expect(card.getAttribute('data-status')).toBe('offline');
    });
    expect(screen.getByTestId('periph-device-offline-note-dev-cam-001')).toBeTruthy();
    expect(screen.getByTestId('periph-device-rebind-btn-dev-cam-001')).toBeTruthy();
    // Still deletable — the orphan is not permanently unreachable (P1-M2).
    expect(screen.getByTestId('periph-device-delete-btn-dev-cam-001')).toBeTruthy();
  });

  it('rebind updates config.deviceId to the chosen present camera (P1-M2)', async () => {
    usePeripheralsStore.setState({
      devices: [makeDevice({ config: { deviceId: 'cam-GONE', label: 'Unplugged' }, enabled: true })],
    });
    const updateSpy = vi.spyOn(usePeripheralsStore.getState(), 'updateDevice').mockResolvedValue();
    const announceSpy = vi.spyOn(usePeripheralsStore.getState(), 'announceBridge').mockResolvedValue();

    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    fireEvent.click(screen.getByTestId('periph-device-rebind-btn-dev-cam-001'));
    // Open the select and choose a present camera (cam-a).
    const select = screen.getByTestId('periph-device-rebind-select-dev-cam-001');
    fireEvent.mouseDown(within(select).getByRole('combobox'));
    await waitFor(() => expect(screen.getByText('FaceTime HD Camera')).toBeTruthy());
    fireEvent.click(screen.getAllByText('FaceTime HD Camera').at(-1)!);
    fireEvent.click(screen.getByTestId('periph-device-rebind-confirm-dev-cam-001'));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        'dev-cam-001',
        expect.objectContaining({ config: expect.objectContaining({ deviceId: 'cam-a' }) }),
      ),
    );
    expect(announceSpy).toHaveBeenCalled();
  });
});

// ── Rename + delete actions (§14.2 / P1-M1) ───────────────────────────────────
describe('PeripheralsPanel — rename / delete (P1-M1)', () => {
  it('rename calls updateDevice({name}) (§14.2)', async () => {
    usePeripheralsStore.setState({ devices: [makeDevice()] });
    const updateSpy = vi.spyOn(usePeripheralsStore.getState(), 'updateDevice').mockResolvedValue();
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    fireEvent.click(screen.getByTestId('periph-device-rename-btn-dev-cam-001'));
    const input = screen.getByTestId('periph-device-rename-input-dev-cam-001');
    fireEvent.change(input, { target: { value: 'Bench Cam' } });
    fireEvent.click(screen.getByTestId('periph-device-rename-save-dev-cam-001'));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('dev-cam-001', { name: 'Bench Cam' }));
  });

  it('delete calls deleteDevice (补齐 P1-M1 zero-caller)', async () => {
    usePeripheralsStore.setState({ devices: [makeDevice()] });
    const deleteSpy = vi.spyOn(usePeripheralsStore.getState(), 'deleteDevice').mockResolvedValue();
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    fireEvent.click(screen.getByTestId('periph-device-delete-btn-dev-cam-001'));
    // Popconfirm — click the OK button.
    await waitFor(() => expect(screen.getByText('OK')).toBeTruthy());
    fireEvent.click(screen.getByText('OK'));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('dev-cam-001'));
  });

  it('rename input does not submit while IME is composing (CJK guard)', async () => {
    usePeripheralsStore.setState({ devices: [makeDevice()] });
    const updateSpy = vi.spyOn(usePeripheralsStore.getState(), 'updateDevice').mockResolvedValue();
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    fireEvent.click(screen.getByTestId('periph-device-rename-btn-dev-cam-001'));
    const input = screen.getByTestId('periph-device-rename-input-dev-cam-001');
    fireEvent.change(input, { target: { value: '实验台相机' } });
    // Enter while composing → must NOT commit.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

// ── Camera detail entry (§14.5) — real config.deviceId, no null dead-prop ──────
describe('PeripheralsPanel — camera detail entry (§14.5)', () => {
  it('opens CameraDetail with the registered device id and returns via Back', async () => {
    usePeripheralsStore.setState({ devices: [makeDevice({ config: { deviceId: 'cam-a', label: 'x' } })] });
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);

    fireEvent.click(screen.getByTestId('periph-device-open-detail-dev-cam-001'));
    await waitFor(() => expect(screen.getByTestId('camera-detail-stub')).toBeTruthy());
    expect(screen.getByTestId('camera-detail-stub').getAttribute('data-device-id')).toBe('dev-cam-001');

    fireEvent.click(screen.getByTestId('periph-detail-back'));
    await waitFor(() => expect(screen.getByTestId('periph-device-card-dev-cam-001')).toBeTruthy());
  });

  it.each([
    ['rtsp', { url: 'rtsp://cam.local/stream' }],
    ['local-camera', { device: '0' }],
  ] as const)(
    'opens %s CameraDetail with the registered device id',
    async (driver, config) => {
      const id = driver === 'rtsp' ? 'dev-rtsp-001' : 'dev-local-001';
      usePeripheralsStore.setState({
        devices: [makeDevice({ id, driver, config })],
      });
      const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
      render(<Wrapper><PeripheralsPanel /></Wrapper>);

      fireEvent.click(screen.getByTestId(`periph-device-open-detail-${id}`));
      await waitFor(() => expect(screen.getByTestId('camera-detail-stub')).toBeTruthy());
      expect(screen.getByTestId('camera-detail-stub').getAttribute('data-device-id')).toBe(id);
    },
  );
});

// ── Add-device flow (§14.3) ───────────────────────────────────────────────────
describe('PeripheralsPanel — add device flow (§14.3)', () => {
  it('opens the AddDeviceFlow modal from the [+ Add device] button', async () => {
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-add-device-btn'));
    await waitFor(() => expect(screen.getByTestId('periph-add-device-flow')).toBeTruthy());
    // RTSP source is present but greyed (Phase 5).
    expect(screen.getByTestId('periph-add-source-rtsp')).toBeTruthy();
  });

  it('adding a browser camera calls createDevice + announceBridge (§14.3)', async () => {
    const createSpy = vi
      .spyOn(usePeripheralsStore.getState(), 'createDevice')
      .mockResolvedValue(makeDevice({ id: 'dev-new', config: { deviceId: 'cam-b' } }));
    const announceSpy = vi.spyOn(usePeripheralsStore.getState(), 'announceBridge').mockResolvedValue();

    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-add-device-btn'));

    await waitFor(() => expect(screen.getByTestId('periph-add-camera-row-cam-a')).toBeTruthy());
    // Name + add cam-b.
    const nameInput = screen.getByTestId('periph-add-camera-name-cam-b');
    fireEvent.change(nameInput, { target: { value: 'USB Cam' } });
    fireEvent.click(screen.getByTestId('periph-add-camera-btn-cam-b'));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'USB Cam', kind: 'camera', driver: 'browser-camera', config: expect.objectContaining({ deviceId: 'cam-b' }) }),
      ),
    );
    expect(announceSpy).toHaveBeenCalledWith(
      [{ deviceId: 'cam-b', label: 'USB Cam' }],
      expect.any(Boolean),
    );
  });

  it('RTSP pane is active with a URL + credentials form (§15-D8 案 A)', async () => {
    const { default: PeripheralsPanel } = await import('./PeripheralsPanel');
    render(<Wrapper><PeripheralsPanel /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-add-device-btn'));
    await waitFor(() => expect(screen.getByTestId('periph-add-device-flow')).toBeTruthy());
    // antd Segmented switches on the label wrapper — click the item's label ancestor.
    const rtspLabel = screen.getByTestId('periph-add-source-rtsp').closest('label');
    fireEvent.click(rtspLabel ?? screen.getByTestId('periph-add-source-rtsp'));
    await waitFor(() => expect(screen.getByTestId('periph-add-rtsp-url')).toBeTruthy());
    // Active pane exposes the URL field + a submit action (no longer greyed).
    expect(screen.getByTestId('periph-add-rtsp-blurb')).toBeTruthy();
    expect(screen.getByTestId('periph-add-rtsp-submit')).toBeTruthy();
  });
});
