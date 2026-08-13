import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { useMonitorStore } from '../../stores/monitor';
import {
  usePeripheralsStore,
  type PeriphDeviceRow,
  type PeriphObservationRow,
} from '../../stores/peripherals';
import { classifyDeviceStatus } from './DeviceCard';

// DeviceCard embeds DeviceMonitors + ObservationTimeline; stub those so the card
// unit test focuses on §14.2/§14.4/§14.6 card semantics (they have their own tests).
vi.mock('./DeviceMonitors', () => ({
  default: ({ deviceId, deviceName }: { deviceId: string; deviceName?: string }) => (
    <div data-testid="mock-device-monitors" data-device-id={deviceId} data-device-name={deviceName} />
  ),
}));
vi.mock('./ObservationTimeline', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="mock-observation-timeline" data-device-id={deviceId} />
  ),
}));

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

// ── hls.js mock (RtspLivePreview §15 场景③) ──────────────────────────────────
// A controllable fake so we can assert (a) loadSource/attachMedia are called with
// the gateway HLS URL, (b) the Bearer token is set via xhrSetup, (c) destroy() runs
// on stop/unmount (H1 resource reclaim). isSupported()=true drives the MSE path.
const hlsInstances: Array<{
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  config: unknown;
  emit: (event: string, data?: unknown) => void;
}> = [];
vi.mock('hls.js', () => {
  const Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
  class FakeHls {
    static Events = Events;
    static isSupported = vi.fn(() => true);
    config: unknown;
    private handlers: Record<string, (evt: string, data?: unknown) => void> = {};
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    on = vi.fn((event: string, cb: (evt: string, data?: unknown) => void) => {
      this.handlers[event] = cb;
    });
    emit = (event: string, data?: unknown) => {
      this.handlers[event]?.(event, data);
    };
    constructor(cfg: unknown) {
      this.config = cfg;
      hlsInstances.push(this as never);
    }
  }
  return { default: FakeHls };
});

import Hls from 'hls.js';
import DeviceCard, { RtspLivePreview, type BrowserCameraOption } from './DeviceCard';

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

const PRESENT: BrowserCameraOption[] = [
  { deviceId: 'cam-a', label: 'FaceTime HD Camera' },
  { deviceId: 'cam-b', label: 'USB Webcam' },
];

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

let mockRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useConfigStore.setState({ theme: 'dark' });
  mockRequest = vi.fn().mockImplementation((method: string) => {
    if (method === 'rc.periph.observations.list') return Promise.resolve({ observations: [] });
    return Promise.resolve({});
  });
  useGatewayStore.setState({
    state: 'connected',
    client: { isConnected: true, request: mockRequest } as never,
  });
  usePeripheralsStore.setState({
    devices: [], observations: {}, observationsHasMore: {}, loading: false, error: null, unavailable: false,
  });
  useMonitorStore.setState({ monitors: [], loading: false, loaded: true });
});

function renderCard(props: Partial<React.ComponentProps<typeof DeviceCard>> = {}) {
  const device = props.device ?? makeDevice();
  usePeripheralsStore.setState({ devices: [device] });
  return render(
    <Wrapper>
      <DeviceCard device={device} browserCameras={PRESENT} bridgeOnline {...props} />
    </Wrapper>,
  );
}

// ── classifyDeviceStatus (pure) ───────────────────────────────────────────────
describe('classifyDeviceStatus (§14.2 / §14.6)', () => {
  it('online when enabled + enumerated + bridge online', () => {
    expect(classifyDeviceStatus(makeDevice({ enabled: true }), PRESENT, true)).toBe('online');
  });
  it('registered when enumerated but not enabled', () => {
    expect(classifyDeviceStatus(makeDevice({ enabled: false }), PRESENT, true)).toBe('registered');
  });
  it('registered when enabled + enumerated but bridge offline', () => {
    expect(classifyDeviceStatus(makeDevice({ enabled: true }), PRESENT, false)).toBe('registered');
  });
  it('offline (orphan) when config.deviceId is not enumerated', () => {
    expect(
      classifyDeviceStatus(makeDevice({ config: { deviceId: 'cam-GONE' }, enabled: true }), PRESENT, true),
    ).toBe('offline');
  });
  it('plaud (non-browser driver) is registered when enabled', () => {
    const plaud = makeDevice({ id: 'plaud', kind: 'audio-recorder', driver: 'mcp-plaud', config: {}, enabled: true });
    expect(classifyDeviceStatus(plaud, [], false)).toBe('registered');
  });
});

// ── Card render (§14.2) ───────────────────────────────────────────────────────
describe('DeviceCard render (§14.2)', () => {
  it('shows name + status label + kind, and the latest observation dot', () => {
    usePeripheralsStore.setState({ observations: { 'dev-cam-001': [makeObs({ verdict: 'alert' })] } });
    renderCard();
    expect(screen.getByTestId('periph-device-name-dev-cam-001').textContent).toContain('FaceTime HD Camera');
    expect(screen.getByTestId('periph-device-status-label-dev-cam-001').textContent).toContain('Bridging');
    expect(screen.getByTestId('periph-device-latest-dot-dev-cam-001').getAttribute('data-verdict')).toBe('alert');
  });

  it('shows the device monitor count (source_type===device && target===id)', () => {
    useMonitorStore.setState({
      monitors: [
        { id: 'm1', name: 'a', source_type: 'device', target: 'dev-cam-001', filters: {}, schedule: '*/5 * * * *', enabled: true, notify: false, agent_prompt: '', gateway_job_id: 'j', last_check_at: null, last_results: null, last_error: null, check_count: 0, finding_count: 0, created_at: '', updated_at: '' },
        { id: 'm2', name: 'b', source_type: 'feed', target: 'x', filters: {}, schedule: '*/5 * * * *', enabled: true, notify: false, agent_prompt: '', gateway_job_id: 'j', last_check_at: null, last_results: null, last_error: null, check_count: 0, finding_count: 0, created_at: '', updated_at: '' },
      ],
      loaded: true,
    });
    renderCard();
    expect(screen.getByTestId('periph-device-monitor-count-dev-cam-001').textContent).toContain('1 scheduled check');
  });

  it.each(['\tDEVICE\n', '\u00a0DeViCe\u00a0'])(
    'counts a legacy device monitor with source_type %j',
    (sourceType) => {
      useMonitorStore.setState({
        monitors: [
          { id: 'legacy-m1', name: 'legacy', source_type: sourceType, target: 'dev-cam-001', filters: {}, schedule: '*/5 * * * *', enabled: true, notify: false, agent_prompt: '', gateway_job_id: 'j', last_check_at: null, last_results: null, last_error: null, check_count: 0, finding_count: 0, created_at: '', updated_at: '' },
        ],
      });

      renderCard();

      expect(screen.getByTestId('periph-device-monitor-count-dev-cam-001').textContent).toContain('1');
    },
  );

  it('renders an error strip when the device has last_error', () => {
    renderCard({ device: makeDevice({ last_error: 'capture timed out' }) });
    expect(screen.getByTestId('periph-device-status-label-dev-cam-001').textContent).toContain('Error');
  });
});

// ── Expand: per-card monitors + timeline titled with the device name (§14.4) ──
describe('DeviceCard expand (§14.4)', () => {
  it('expands to per-device monitors + timeline whose title carries the device name', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('periph-device-expand-btn-dev-cam-001'));
    const monitors = screen.getByTestId('mock-device-monitors');
    expect(monitors.getAttribute('data-device-id')).toBe('dev-cam-001');
    // §14.4: DeviceMonitors receives the device NAME so its askAgent prefill is name+(id).
    expect(monitors.getAttribute('data-device-name')).toBe('FaceTime HD Camera');
    expect(screen.getByTestId('mock-observation-timeline').getAttribute('data-device-id')).toBe('dev-cam-001');
    expect(screen.getByTestId('periph-device-timeline-title-dev-cam-001').textContent).toContain('FaceTime HD Camera');
  });
});

// ── Actions: rename / delete / rebind ─────────────────────────────────────────
describe('DeviceCard actions (§14.2 / P1-M1 / P1-M2)', () => {
  it('rename → updateDevice({name})', async () => {
    const spy = vi.spyOn(usePeripheralsStore.getState(), 'updateDevice').mockResolvedValue();
    renderCard();
    fireEvent.click(screen.getByTestId('periph-device-rename-btn-dev-cam-001'));
    fireEvent.change(screen.getByTestId('periph-device-rename-input-dev-cam-001'), { target: { value: 'Bench Cam' } });
    fireEvent.click(screen.getByTestId('periph-device-rename-save-dev-cam-001'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('dev-cam-001', { name: 'Bench Cam' }));
  });

  it('delete → deleteDevice (补齐 P1-M1 zero-caller)', async () => {
    const spy = vi.spyOn(usePeripheralsStore.getState(), 'deleteDevice').mockResolvedValue();
    renderCard();
    fireEvent.click(screen.getByTestId('periph-device-delete-btn-dev-cam-001'));
    await waitFor(() => expect(screen.getByText('OK')).toBeTruthy());
    fireEvent.click(screen.getByText('OK'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('dev-cam-001'));
  });

  it('offline device: rebind → updateDevice(config.deviceId) + announceBridge (P1-M2)', async () => {
    const upd = vi.spyOn(usePeripheralsStore.getState(), 'updateDevice').mockResolvedValue();
    const ann = vi.spyOn(usePeripheralsStore.getState(), 'announceBridge').mockResolvedValue();
    renderCard({ device: makeDevice({ config: { deviceId: 'cam-GONE', label: 'Unplugged' }, enabled: true }) });

    // Offline note + rebind entry present (§14.6).
    expect(screen.getByTestId('periph-device-offline-note-dev-cam-001')).toBeTruthy();
    fireEvent.click(screen.getByTestId('periph-device-rebind-btn-dev-cam-001'));
    const select = screen.getByTestId('periph-device-rebind-select-dev-cam-001');
    fireEvent.mouseDown(within(select).getByRole('combobox'));
    await waitFor(() => expect(screen.getAllByText('USB Webcam').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('USB Webcam').at(-1)!);
    fireEvent.click(screen.getByTestId('periph-device-rebind-confirm-dev-cam-001'));

    await waitFor(() =>
      expect(upd).toHaveBeenCalledWith('dev-cam-001', expect.objectContaining({ config: expect.objectContaining({ deviceId: 'cam-b' }) })),
    );
    expect(ann).toHaveBeenCalled();
  });

  it('local-camera rebind updates config.device and does not announce a browser bridge', async () => {
    const upd = vi.spyOn(usePeripheralsStore.getState(), 'updateDevice').mockResolvedValue();
    const ann = vi.spyOn(usePeripheralsStore.getState(), 'announceBridge').mockResolvedValue();
    const load = vi
      .spyOn(usePeripheralsStore.getState(), 'loadLocalCameras')
      .mockResolvedValue([{ device: '2', label: 'USB Capture' }]);
    renderCard({
      device: makeDevice({
        id: 'dev-local-1',
        driver: 'local-camera',
        config: { device: '0' },
      }),
    });

    fireEvent.click(screen.getByTestId('periph-device-rebind-btn-dev-local-1'));
    await waitFor(() => expect(load).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('periph-device-local-rebind-input-dev-local-1'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByTestId('periph-device-rebind-confirm-dev-local-1'));

    await waitFor(() =>
      expect(upd).toHaveBeenCalledWith(
        'dev-local-1',
        expect.objectContaining({ config: expect.objectContaining({ device: '2' }) }),
      ),
    );
    expect(ann).not.toHaveBeenCalled();
  });

  it('rtsp devices do not expose the browser/local-camera rebind control', () => {
    renderCard({
      device: makeDevice({
        id: 'dev-rtsp-1',
        driver: 'rtsp',
        config: { url: 'rtsp://cam.local/stream' },
      }),
    });
    expect(screen.queryByTestId('periph-device-rebind-btn-dev-rtsp-1')).toBeNull();
  });

  it('rename input honors IME composition (no submit mid-compose)', () => {
    const spy = vi.spyOn(usePeripheralsStore.getState(), 'updateDevice').mockResolvedValue();
    renderCard();
    fireEvent.click(screen.getByTestId('periph-device-rename-btn-dev-cam-001'));
    const input = screen.getByTestId('periph-device-rename-input-dev-cam-001');
    fireEvent.change(input, { target: { value: '实验台' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Camera detail entry (§14.5) ───────────────────────────────────────────────
describe('DeviceCard camera detail entry (§14.5)', () => {
  it('invokes onOpenCameraDetail with the device (config.deviceId flows in, not null)', () => {
    const onOpen = vi.fn();
    renderCard({ onOpenCameraDetail: onOpen });
    fireEvent.click(screen.getByTestId('periph-device-open-detail-dev-cam-001'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'dev-cam-001', config: expect.objectContaining({ deviceId: 'cam-a' }) }));
  });
});

// ── RTSP live preview (§15 场景③ H5/H6) ───────────────────────────────────────
function makeRtspDevice(overrides: Partial<PeriphDeviceRow> = {}): PeriphDeviceRow {
  return makeDevice({
    id: 'dev-rtsp-1',
    name: 'Lab IP Cam',
    kind: 'camera',
    driver: 'rtsp',
    config: { url: 'rtsp://cam.local/stream' },
    ...overrides,
  });
}

describe('DeviceCard RTSP preview gating (§15 场景③ H5)', () => {
  it('shows the live-preview section only when the card is expanded for an rtsp device', () => {
    const dev = makeRtspDevice();
    render(
      <Wrapper>
        <DeviceCard device={dev} browserCameras={[]} />
      </Wrapper>,
    );
    // Collapsed: no preview yet.
    expect(screen.queryByTestId('periph-rtsp-preview-dev-rtsp-1')).toBeNull();
    fireEvent.click(screen.getByTestId('periph-device-expand-btn-dev-rtsp-1'));
    expect(screen.getByTestId('periph-rtsp-preview-dev-rtsp-1')).toBeTruthy();
    expect(screen.getByTestId('periph-rtsp-preview-start-dev-rtsp-1')).toBeTruthy();
  });

  it('does NOT show the live-preview section for a browser-camera device', () => {
    renderCard(); // default browser-camera device
    fireEvent.click(screen.getByTestId('periph-device-expand-btn-dev-cam-001'));
    expect(screen.queryByTestId('periph-rtsp-preview-dev-cam-001')).toBeNull();
  });
});

describe('RtspLivePreview player (§15 场景③ H1/H3/H5)', () => {
  beforeEach(() => {
    hlsInstances.length = 0;
    vi.mocked(Hls.isSupported).mockReturnValue(true);
    // A gateway token in the URL so xhrSetup should stamp it.
    window.history.replaceState({}, '', '/?token=test-token');
  });

  function renderPreview(deviceId = 'dev-rtsp-1') {
    return render(
      <Wrapper>
        <RtspLivePreview deviceId={deviceId} />
      </Wrapper>,
    );
  }

  it('start → rtspPreviewStart → hls.loadSource(gateway URL) + Bearer via xhrSetup', async () => {
    const startSpy = vi
      .spyOn(usePeripheralsStore.getState(), 'rtspPreviewStart')
      .mockResolvedValue({ sessionToken: 'tok-1', playlistUrl: '/rc/rtsp-preview/tok-1/index.m3u8' });
    renderPreview();
    fireEvent.click(screen.getByTestId('periph-rtsp-preview-start-dev-rtsp-1'));

    await waitFor(() => expect(startSpy).toHaveBeenCalledWith('dev-rtsp-1'));
    await waitFor(() => expect(hlsInstances.length).toBe(1));

    const inst = hlsInstances[0];
    // loadSource got the absolute gateway URL for the playlist (no credential).
    expect(inst.loadSource).toHaveBeenCalledWith(expect.stringContaining('/rc/rtsp-preview/tok-1/index.m3u8'));
    expect(inst.attachMedia).toHaveBeenCalled();

    // xhrSetup stamps the Bearer token from the URL (H3 auth on every segment).
    const cfg = inst.config as { xhrSetup: (xhr: { setRequestHeader: ReturnType<typeof vi.fn> }) => void };
    const xhr = { setRequestHeader: vi.fn() };
    cfg.xhrSetup(xhr);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Authorization', 'Bearer test-token');
  });

  it('start failure (rtspPreviewStart → null) degrades to an error message', async () => {
    vi.spyOn(usePeripheralsStore.getState(), 'rtspPreviewStart').mockResolvedValue(null);
    renderPreview();
    fireEvent.click(screen.getByTestId('periph-rtsp-preview-start-dev-rtsp-1'));
    await waitFor(() => expect(screen.getByTestId('periph-rtsp-preview-error-dev-rtsp-1')).toBeTruthy());
    // No hls instance was created on a failed start.
    expect(hlsInstances.length).toBe(0);
  });

  it('native-HLS-only branch explicitly rejects playback that cannot carry gateway auth', async () => {
    vi.mocked(Hls.isSupported).mockReturnValue(false);
    const canPlayType = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockReturnValue('probably');
    vi.spyOn(usePeripheralsStore.getState(), 'rtspPreviewStart').mockResolvedValue({
      sessionToken: 'tok-native',
      playlistUrl: '/rc/rtsp-preview/tok-native/index.m3u8',
    });
    const stopSpy = vi.spyOn(usePeripheralsStore.getState(), 'rtspPreviewStop').mockResolvedValue();

    renderPreview();
    fireEvent.click(screen.getByTestId('periph-rtsp-preview-start-dev-rtsp-1'));

    await waitFor(() => {
      expect(screen.getByTestId('periph-rtsp-preview-error-dev-rtsp-1').textContent)
        .toContain('cannot attach gateway authentication');
    });
    const video = screen.getByTestId('periph-rtsp-preview-video-dev-rtsp-1') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBeNull();
    expect(stopSpy).toHaveBeenCalledWith('dev-rtsp-1');
    canPlayType.mockRestore();
  });

  it('stop → destroys hls + calls rtspPreviewStop (H1 resource reclaim)', async () => {
    vi.spyOn(usePeripheralsStore.getState(), 'rtspPreviewStart').mockResolvedValue({
      sessionToken: 'tok-2',
      playlistUrl: '/rc/rtsp-preview/tok-2/index.m3u8',
    });
    const stopSpy = vi.spyOn(usePeripheralsStore.getState(), 'rtspPreviewStop').mockResolvedValue();
    renderPreview();
    fireEvent.click(screen.getByTestId('periph-rtsp-preview-start-dev-rtsp-1'));
    await waitFor(() => expect(hlsInstances.length).toBe(1));

    fireEvent.click(screen.getByTestId('periph-rtsp-preview-stop-dev-rtsp-1'));
    await waitFor(() => expect(hlsInstances[0].destroy).toHaveBeenCalled());
    expect(stopSpy).toHaveBeenCalledWith('dev-rtsp-1');
  });

  it('unmount destroys hls + releases the gateway session (H1)', async () => {
    vi.spyOn(usePeripheralsStore.getState(), 'rtspPreviewStart').mockResolvedValue({
      sessionToken: 'tok-3',
      playlistUrl: '/rc/rtsp-preview/tok-3/index.m3u8',
    });
    const stopSpy = vi.spyOn(usePeripheralsStore.getState(), 'rtspPreviewStop').mockResolvedValue();
    const { unmount } = renderPreview();
    fireEvent.click(screen.getByTestId('periph-rtsp-preview-start-dev-rtsp-1'));
    await waitFor(() => expect(hlsInstances.length).toBe(1));

    unmount();
    expect(hlsInstances[0].destroy).toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledWith('dev-rtsp-1');
  });

  it('fatal hls error degrades to an error message (H5)', async () => {
    vi.spyOn(usePeripheralsStore.getState(), 'rtspPreviewStart').mockResolvedValue({
      sessionToken: 'tok-4',
      playlistUrl: '/rc/rtsp-preview/tok-4/index.m3u8',
    });
    renderPreview();
    fireEvent.click(screen.getByTestId('periph-rtsp-preview-start-dev-rtsp-1'));
    await waitFor(() => expect(hlsInstances.length).toBe(1));

    // Emit a fatal error → the player tears down and shows the error copy.
    hlsInstances[0].emit('hlsError', { fatal: true });
    await waitFor(() => expect(screen.getByTestId('periph-rtsp-preview-error-dev-rtsp-1')).toBeTruthy());
    expect(hlsInstances[0].destroy).toHaveBeenCalled();
  });
});
