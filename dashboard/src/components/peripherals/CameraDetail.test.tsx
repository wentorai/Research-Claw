import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore } from '../../stores/peripherals';
import { useSessionsStore } from '../../stores/sessions';
import { useModelCatalogStore } from '../../stores/model-catalog';
import { useUiStore } from '../../stores/ui';
// P2-T1 contract fixture: a REAL gateway observations shape (rpc.ts observations.list
// output), used to pin the { observation: PeriphObservation } response the
// rc.periph.observations.create handler MUST return once the plugin-backend agent
// registers it. Source: __fixtures__/gateway-payloads/periph.ts (mirrors
// extensions/research-claw-core/src/periph/types.ts:26-43 PeriphObservation).
import { RC_PERIPH_OBSERVATIONS_LIST_RESPONSE } from '../../__fixtures__/gateway-payloads/periph';

// ── Mock i18n — t() returns fallback string if provided, else the key ─────────
// Mocked t() returns the English fallback and, for object options, interpolates
// {{var}} placeholders from the option keys so tests can assert the model name
// actually reaches the copy (P1-V2 modelRef assertion).
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

// ── Mock the capture + upload + vision contracts ──────────────────────────────
const mockCaptureFrame = vi.fn();
vi.mock('../../gateway/camera', () => ({
  captureFrameFromCamera: (deviceId?: string) => mockCaptureFrame(deviceId),
}));

const mockUpload = vi.fn();
vi.mock('../../gateway/upload', () => ({
  uploadFileToWorkspace: (file: File, destination: string) => mockUpload(file, destination),
}));

// P1-V3: vision-capability is NOT mocked. CameraDetail now consumes the reactive
// useVisionSupport() hook, which reads the sessions / model-catalog / config
// stores. Tests drive the verdict by setting those stores' real state so the
// hook's responsiveness (async catalog arrival, /model override) is exercised.

// ── Mock ObservationTimeline (Fix 3: now rendered by CameraDetail) ────────────
// Keeps CameraDetail tests free of periph store / fetch side-effects.
vi.mock('./ObservationTimeline', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="mock-observation-timeline" data-device-id={deviceId} />
  ),
}));

// ── Mock DeviceMonitors (keep focus on CameraDetail) ─────────────────────────
vi.mock('./DeviceMonitors', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="mock-device-monitors" data-device-id={deviceId} />
  ),
}));

// ── Mock DeviceCard's RtspLivePreview (its own player is unit-tested in
// DeviceCard.test.tsx; here we only assert CameraDetail routes an rtsp device to
// it, without pulling hls.js into this suite). ────────────────────────────────
vi.mock('./DeviceCard', () => ({
  RtspLivePreview: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="mock-rtsp-preview" data-device-id={deviceId} />
  ),
}));

import CameraDetail from './CameraDetail';

// ── mediaDevices harness ──────────────────────────────────────────────────────

function makeTrack(settings: MediaTrackSettings) {
  return {
    stop: vi.fn(),
    getSettings: () => settings,
  };
}

function makeStream(track: ReturnType<typeof makeTrack>) {
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

const TWO_CAMERAS = [
  { deviceId: 'cam-a', kind: 'videoinput', label: 'FaceTime HD', groupId: 'g1' },
  { deviceId: 'cam-b', kind: 'videoinput', label: 'USB Webcam', groupId: 'g2' },
  { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Mic', groupId: 'g3' },
];

function installMediaDevices(devices: Array<Record<string, string>>, track = makeTrack({ width: 1280, height: 720, frameRate: 30 })) {
  const enumerate = vi.fn().mockResolvedValue(devices);
  const getUserMedia = vi.fn().mockResolvedValue(makeStream(track));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: enumerate, getUserMedia },
  });
  return { enumerate, getUserMedia, track };
}

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

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
  usePeripheralsStore.setState({ devices: [], unavailable: false, error: null });
  useUiStore.setState({ chatAttachmentPrefill: null });
  // Default vision baseline: config primary is a vision model + catalog loaded →
  // resolveVisionSupport() returns true/catalog. No session override.
  useConfigStore.setState({
    gatewayConfig: { agents: { defaults: { model: { primary: 'zai/glm-5v-turbo' } } } } as never,
  });
  useModelCatalogStore.setState({
    catalog: [{ id: 'glm-5v-turbo', name: 'GLM-5V Turbo', provider: 'zai', input: ['text', 'image'] }] as never,
  });
  useSessionsStore.setState({
    sessions: [{ key: 'main', label: 'Main' }],
    activeSessionKey: 'main',
  } as never);
  setSecureContext(true);
  installMediaDevices(TWO_CAMERAS);

  // HTMLMediaElement.play is not implemented in happy-dom
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Secure context degradation ────────────────────────────────────────────────

describe('CameraDetail — secure context', () => {
  it('shows insecure hint and no camera controls when not a secure context', () => {
    setSecureContext(false);
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    expect(screen.getByTestId('periph-camera-insecure')).toBeTruthy();
    // No device select rendered
    expect(screen.queryByTestId('periph-camera-device-select')).toBeNull();
    expect(screen.queryByTestId('periph-camera-snap')).toBeNull();
  });

  it('shows insecure hint when getUserMedia is missing', () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    expect(screen.getByTestId('periph-camera-insecure')).toBeTruthy();
  });
});

// ── Unavailable banner ────────────────────────────────────────────────────────

describe('CameraDetail — unavailable', () => {
  it('shows plugin-too-old banner when store.unavailable', async () => {
    usePeripheralsStore.setState({ unavailable: true });
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('periph-camera-unavailable')).toBeTruthy());
  });
});

// ── Device selection ──────────────────────────────────────────────────────────

describe('CameraDetail — device list (T19 P4)', () => {
  it('lists two videoinput devices as rows (filters out audioinput)', async () => {
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-device-list')).toBeTruthy());

    // Both cameras render as their own rows; audioinput is excluded.
    await waitFor(() => {
      expect(screen.getByTestId('periph-camera-device-row-cam-a')).toBeTruthy();
      expect(screen.getByTestId('periph-camera-device-row-cam-b')).toBeTruthy();
    });
    expect(screen.queryByTestId('periph-camera-device-row-mic-1')).toBeNull();
    expect(screen.getByText('FaceTime HD')).toBeTruthy();
    expect(screen.getByText('USB Webcam')).toBeTruthy();
    expect(screen.queryByText('Built-in Mic')).toBeNull();
  });

  it('title shows the valid device count [N]', async () => {
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => {
      const title = screen.getByTestId('periph-camera-list-title');
      // Mocked t() returns the interpolated defaultValue → "Camera devices [2]"
      expect(title.textContent).toContain('[2]');
    });
  });

  it('clicking a row selects that device (highlights it)', async () => {
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('periph-camera-device-row-cam-b')).toBeTruthy());

    // cam-a is auto-selected first (first non-empty deviceId).
    await waitFor(() =>
      expect(screen.getByTestId('periph-camera-device-row-cam-a').getAttribute('data-selected')).toBe('true'),
    );

    fireEvent.click(screen.getByTestId('periph-camera-device-row-cam-b'));

    await waitFor(() => {
      expect(screen.getByTestId('periph-camera-device-row-cam-b').getAttribute('data-selected')).toBe('true');
      expect(screen.getByTestId('periph-camera-device-row-cam-a').getAttribute('data-selected')).toBe('false');
    });
  });

  it('shows an empty state when there are no video devices', async () => {
    installMediaDevices([{ deviceId: 'mic-1', kind: 'audioinput', label: 'Mic', groupId: 'g' }]);
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('periph-camera-empty')).toBeTruthy());
  });

  it('renders the locked placeholder + authorize button when labels are empty (permission not granted)', async () => {
    installMediaDevices([
      { deviceId: 'cam-a', kind: 'videoinput', label: '', groupId: 'g1' },
    ]);
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('periph-camera-authorize')).toBeTruthy();
      // Locked placeholder replaces the device list until access is granted.
      expect(screen.getByTestId('periph-camera-list-locked')).toBeTruthy();
      expect(screen.queryByTestId('periph-camera-device-list')).toBeNull();
    });
  });

  it("skips empty-string deviceId when auto-selecting (never latches '')", async () => {
    // Pre-auth harness: one placeholder ('' deviceId, no label) + one real cam.
    // The auto-select must land on the real cam, never on the '' placeholder.
    installMediaDevices([
      { deviceId: '', kind: 'videoinput', label: 'Camera 1', groupId: 'g1' },
      { deviceId: 'cam-real', kind: 'videoinput', label: 'Real Cam', groupId: 'g2' },
    ]);
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    // labels present → not needsAuth → list renders. Only the real device is a row.
    await waitFor(() => expect(screen.getByTestId('periph-camera-device-row-cam-real')).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId('periph-camera-device-row-cam-real').getAttribute('data-selected')).toBe('true'),
    );
    // Capture actions must be enabled (a valid device is selected).
    expect((screen.getByTestId('periph-camera-snap') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables snap/save when no valid device is selected', async () => {
    // A single placeholder camera with an empty-string deviceId but a present label
    // (label present → not needsAuth, list renders, but no valid selection exists).
    installMediaDevices([
      { deviceId: '', kind: 'videoinput', label: 'Ghost Cam', groupId: 'g1' },
    ]);
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    // No valid device → no rows, but action buttons still render (disabled).
    await waitFor(() => expect(screen.getByTestId('periph-camera-snap')).toBeTruthy());
    expect((screen.getByTestId('periph-camera-snap') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('periph-camera-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── Live preview / mount points ───────────────────────────────────────────────

describe('CameraDetail — preview + mount points', () => {
  it('exposes T16 mount points for monitors and timeline (always present)', async () => {
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId('periph-camera-monitors')).toBeTruthy();
      expect(screen.getByTestId('periph-camera-timeline')).toBeTruthy();
    });
  });

  it('renders ObservationTimeline inside periph-camera-timeline when bridgeDevice is active (Fix 3)', async () => {
    const bridgeDevice = {
      id: 'dev-bridge-1',
      name: 'FaceTime HD',
      kind: 'camera' as const,
      driver: 'browser-camera' as const,
      enabled: true,
      config: { deviceId: 'cam-a', label: 'FaceTime HD' },
      check_prompt: '',
      last_seen_at: null,
      last_error: null,
      created_at: '',
      updated_at: '',
    };
    usePeripheralsStore.setState({ devices: [bridgeDevice] });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => {
      const timelineMount = screen.getByTestId('periph-camera-timeline');
      const tl = timelineMount.querySelector('[data-testid="mock-observation-timeline"]');
      expect(tl).toBeTruthy();
      expect(tl!.getAttribute('data-device-id')).toBe('dev-bridge-1');
    });
  });

  it('periph-camera-timeline is empty when no bridgeDevice is active', async () => {
    // No devices in store → no bridgeDevice
    usePeripheralsStore.setState({ devices: [] });

    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    await waitFor(() => {
      const timelineMount = screen.getByTestId('periph-camera-timeline');
      // No ObservationTimeline inside
      expect(timelineMount.querySelector('[data-testid="mock-observation-timeline"]')).toBeNull();
    });
  });
});

// ── RTSP device detail (§15 场景③ H5): HLS preview instead of getUserMedia ─────
describe('CameraDetail — rtsp device (HLS preview branch)', () => {
  const rtspDevice = {
    id: 'dev-rtsp-1',
    name: 'Lab IP Cam',
    kind: 'camera' as const,
    driver: 'rtsp' as const,
    enabled: true,
    config: { url: 'rtsp://cam.local/stream' },
    check_prompt: 'Is the bench clear?',
    last_seen_at: null,
    last_error: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };

  it('renders the RTSP live-preview branch (no getUserMedia enumeration) for an rtsp device', async () => {
    usePeripheralsStore.setState({ devices: [rtspDevice] });
    render(<Wrapper><CameraDetail deviceId="dev-rtsp-1" /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('periph-camera-rtsp-detail')).toBeTruthy());
    // The HLS preview player is mounted with the registered device id.
    const preview = screen.getByTestId('mock-rtsp-preview');
    expect(preview.getAttribute('data-device-id')).toBe('dev-rtsp-1');
    // Monitors + timeline are wired to the rtsp device.
    expect(screen.getByTestId('mock-device-monitors').getAttribute('data-device-id')).toBe('dev-rtsp-1');
    expect(screen.getByTestId('mock-observation-timeline').getAttribute('data-device-id')).toBe('dev-rtsp-1');
    // The getUserMedia camera-detail chrome (authorize / device select) is absent.
    expect(screen.queryByTestId('periph-camera-authorize')).toBeNull();
    expect(screen.queryByTestId('periph-camera-device-select')).toBeNull();
  });

  it('does NOT take the rtsp branch for a browser-camera device with the same id', async () => {
    const browserDev = { ...rtspDevice, driver: 'browser-camera' as const, config: { deviceId: 'dev-rtsp-1' } };
    usePeripheralsStore.setState({ devices: [browserDev] });
    render(<Wrapper><CameraDetail deviceId="dev-rtsp-1" /></Wrapper>);
    // rtsp branch not rendered (driver !== rtsp).
    await waitFor(() => expect(screen.queryByTestId('periph-camera-rtsp-detail')).toBeNull());
  });
});

describe('CameraDetail — local-camera device (gateway capture branch)', () => {
  it('routes the registered local-camera id to gateway detail, monitors and timeline', async () => {
    usePeripheralsStore.setState({
      devices: [{
        id: 'dev-local-1',
        name: 'USB Lab Camera',
        kind: 'camera',
        driver: 'local-camera',
        enabled: true,
        config: { device: '0' },
        check_prompt: 'Check the sample tray',
        last_seen_at: null,
        last_error: null,
        created_at: '',
        updated_at: '',
      }],
    });

    render(<Wrapper><CameraDetail deviceId="dev-local-1" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-local-detail')).toBeTruthy());
    expect(screen.getByText(/System camera address: 0/)).toBeTruthy();
    expect(screen.getByTestId('mock-device-monitors').getAttribute('data-device-id')).toBe('dev-local-1');
    expect(screen.getByTestId('mock-observation-timeline').getAttribute('data-device-id')).toBe('dev-local-1');
    expect(screen.queryByTestId('periph-camera-device-select')).toBeNull();
  });
});

// ── Vision hint three states ──────────────────────────────────────────────────

describe('CameraDetail — vision hint (store-driven, reactive)', () => {
  // Catalog entries reused across cases (oc-catalog-align.ts shape).
  const VISION_ENTRY = { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', provider: 'zai', input: ['text', 'image'] };
  const TEXTONLY_ENTRY = { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', input: ['text'] };

  it('true → supports-image copy with model name (P1-V2)', async () => {
    // Baseline (beforeEach): config primary zai/glm-5v-turbo + vision catalog.
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => {
      const hint = screen.getByTestId('periph-camera-vision-hint');
      expect(hint.textContent).toContain('supports image input');
      // Model name interpolated into the copy (basename of the resolved ref).
      expect(hint.textContent).toContain('glm-5v-turbo');
    });
  });

  it('authoritative false → definite copy (not "may") + model name (P2-V4)', async () => {
    // Config primary points at a text-only model present in the catalog →
    // catalog-authoritative false. Copy must be the definite wording.
    useConfigStore.setState({
      gatewayConfig: { agents: { defaults: { model: { primary: 'deepseek/deepseek-v4-pro' } } } } as never,
    });
    useModelCatalogStore.setState({ catalog: [VISION_ENTRY, TEXTONLY_ENTRY] as never });
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => {
      const hint = screen.getByTestId('periph-camera-vision-hint');
      expect(hint.textContent).toContain('does not support image input');
      expect(hint.textContent).not.toContain('may not support');
      expect(hint.textContent).toContain('deepseek-v4-pro');
    });
  });

  it("'unknown' → cannot-confirm copy (weak wording)", async () => {
    // No config primary, empty catalog → tier 4 unknown/none.
    useConfigStore.setState({ gatewayConfig: {} as never });
    useModelCatalogStore.setState({ catalog: [] as never });
    useSessionsStore.setState({ sessions: [{ key: 'main', label: 'Main' }], activeSessionKey: 'main' } as never);
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => {
      const hint = screen.getByTestId('periph-camera-vision-hint');
      expect(hint.textContent).toContain('Cannot confirm');
    });
  });

  it('reactive: catalog=null at mount → unknown, then act(set catalog) → true (P1-V3)', async () => {
    // Session override to a vision model, but catalog cold → session-tier unknown.
    useConfigStore.setState({ gatewayConfig: {} as never });
    useModelCatalogStore.setState({ catalog: null as never });
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'zai', model: 'glm-5v-turbo' }],
      activeSessionKey: 'main',
    } as never);
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    // Cold catalog → cannot confirm the session model.
    await waitFor(() => {
      expect(screen.getByTestId('periph-camera-vision-hint').textContent).toContain('Cannot confirm');
    });

    // Catalog arrives asynchronously → hook recomputes → confirmed vision.
    act(() => {
      useModelCatalogStore.setState({ catalog: [VISION_ENTRY] as never });
    });
    await waitFor(() => {
      expect(screen.getByTestId('periph-camera-vision-hint').textContent).toContain('supports image input');
    });
  });

  it('session /model override → override provenance line contains modelRef + clear entry (P1-V2)', async () => {
    // Config primary is a vision model; the session is /model-switched to a
    // text-only model → source:'session', modelRef≠primary → override hint shows.
    useConfigStore.setState({
      gatewayConfig: { agents: { defaults: { model: { primary: 'zai/glm-5v-turbo' } } } } as never,
    });
    useModelCatalogStore.setState({ catalog: [VISION_ENTRY, TEXTONLY_ENTRY] as never });
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'deepseek', model: 'deepseek-v4-pro' }],
      activeSessionKey: 'main',
    } as never);

    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    await waitFor(() => {
      const override = screen.getByTestId('periph-camera-vision-override');
      // Provenance line names the overriding model (modelRef basename).
      expect(override.textContent).toContain('deepseek-v4-pro');
      expect(override.textContent).toContain('/model override');
      // One-click clear entry is present.
      expect(screen.getByTestId('periph-camera-vision-clear-override')).toBeTruthy();
    });
  });

  // 缺陷：patchSession 返回 Promise<void> 且吞掉一切失败（未连接 → 直接 return;
  // sessions.patch 拒绝 → catch 空吞）,handleClearOverride 却 await 之后无条件
  // message.success。结果:网关拒绝 / 超时 / 未连接时,用户看到「已清除本会话的
  // 模型覆写。」而覆写提示行仍在原地 —— UI 自相矛盾,且用户以为已生效。
  it('clear override 失败（sessions.patch 拒绝）→ 报错,且不得弹成功提示', async () => {
    useConfigStore.setState({
      gatewayConfig: { agents: { defaults: { model: { primary: 'zai/glm-5v-turbo' } } } } as never,
    });
    useModelCatalogStore.setState({ catalog: [VISION_ENTRY, TEXTONLY_ENTRY] as never });
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'deepseek', model: 'deepseek-v4-pro' }],
      activeSessionKey: 'main',
    } as never);

    // 真实拒绝形态:OC 网关对 sessions.patch 的拒绝以 RPC error 冒泡到 request()
    const request = vi.fn((method: string) => {
      if (method === 'sessions.patch') return Promise.reject(new Error('invalid session key'));
      return Promise.resolve({});
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });

    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    const clearBtn = await screen.findByTestId('periph-camera-vision-clear-override');

    await act(async () => { fireEvent.click(clearBtn); });

    // 失败必须被如实告知
    expect(
      await screen.findByText('Failed to clear the session model override — please retry.'),
    ).toBeTruthy();
    // 且绝不能同时出现成功文案
    expect(screen.queryByText('Session model override cleared.')).toBeNull();
    // 覆写提示行仍在（覆写确实没被清掉）—— 与失败提示自洽
    expect(screen.getByTestId('periph-camera-vision-override')).toBeTruthy();
  });

  it('clear override 成功 → 弹成功提示,不弹失败提示', async () => {
    useConfigStore.setState({
      gatewayConfig: { agents: { defaults: { model: { primary: 'zai/glm-5v-turbo' } } } } as never,
    });
    useModelCatalogStore.setState({ catalog: [VISION_ENTRY, TEXTONLY_ENTRY] as never });
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'deepseek', model: 'deepseek-v4-pro' }],
      activeSessionKey: 'main',
    } as never);

    const request = vi.fn((method: string, _params?: unknown) => {
      if (method === 'sessions.patch') return Promise.resolve({});
      if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
      return Promise.resolve({});
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });

    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    const clearBtn = await screen.findByTestId('periph-camera-vision-clear-override');

    await act(async () => { fireEvent.click(clearBtn); });

    expect(await screen.findByText('Session model override cleared.')).toBeTruthy();
    expect(
      screen.queryByText('Failed to clear the session model override — please retry.'),
    ).toBeNull();
    // 真的发出了 model:null 的 patch
    const patchCall = request.mock.calls.find(([m]) => m === 'sessions.patch');
    expect(patchCall).toBeTruthy();
    expect((patchCall![1] as Record<string, unknown>).model).toBeNull();
  });

  it('no override (config-primary judgment) → no override provenance line', async () => {
    // Baseline: judgment from config primary, no session override → hint has no
    // override line and no clear button.
    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('periph-camera-vision-hint')).toBeTruthy());
    expect(screen.queryByTestId('periph-camera-vision-override')).toBeNull();
    expect(screen.queryByTestId('periph-camera-vision-clear-override')).toBeNull();
  });
});

// ── Snap → inject into chat ───────────────────────────────────────────────────

describe('CameraDetail — snap to chat', () => {
  it('captures, uploads to periph/<id>, and prefills a chat attachment with wsPath', async () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    mockCaptureFrame.mockResolvedValue({ blob, width: 640, height: 480 });
    mockUpload.mockResolvedValue({ path: 'periph/cam-a/frame.jpg', name: 'frame.jpg' });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-snap')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-snap'));

    await waitFor(() => {
      expect(mockCaptureFrame).toHaveBeenCalledWith('cam-a');
    });

    await waitFor(() => {
      const [, destination] = mockUpload.mock.calls[0];
      expect(destination).toContain('periph/');
    });

    await waitFor(() => {
      const prefill = useUiStore.getState().chatAttachmentPrefill;
      expect(prefill).not.toBeNull();
      expect(prefill).toHaveLength(1);
      expect(prefill![0].wsPath).toBe('periph/cam-a/frame.jpg');
      expect(prefill![0].mimeType).toBe('image/jpeg');
    });

    // dataUrl must be non-empty and start with 'data:' for ≤5MB blobs
    await waitFor(() => {
      const prefill = useUiStore.getState().chatAttachmentPrefill;
      expect(prefill![0].dataUrl).toBeTruthy();
      expect(prefill![0].dataUrl).toMatch(/^data:/);
    });
  });

  it('sets dataUrl to empty string (but preserves wsPath) when blob exceeds 5 MB', async () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    Object.defineProperty(blob, 'size', { value: 6_000_000 });
    mockCaptureFrame.mockResolvedValue({ blob, width: 1920, height: 1080 });
    mockUpload.mockResolvedValue({ path: 'periph/cam-a/frame.jpg', name: 'frame.jpg' });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-snap')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-snap'));

    await waitFor(() => {
      const prefill = useUiStore.getState().chatAttachmentPrefill;
      expect(prefill).not.toBeNull();
      expect(prefill).toHaveLength(1);
      // Oversized blob: dataUrl must be empty string
      expect(prefill![0].dataUrl).toBe('');
      // wsPath must still be preserved
      expect(prefill![0].wsPath).toBe('periph/cam-a/frame.jpg');
    });
  });
});

// ── Manual snap → observation timeline (P2-T1) ────────────────────────────────
// A successful manual snap records a kind='snapshot' observation for the camera's
// REGISTERED bridge device, so a human snap shows up on the same timeline the
// agent/cron writes to. Contract: rc.periph.observations.create
// { device_id, kind:'snapshot', verdict:'info', summary, frame_path }
// (mirrors service.recordObservation input, extensions/.../periph/service.ts:181-206).
// A device with no registered bridge writes nothing (would violate the FK to
// rc_periph_devices); a missing method / transport error never fails the snap.
//
// ⚠ These are CLIENT-SEAM tests: they assert the dashboard EMITS the correct call.
// They mock client.request, so they intentionally CANNOT prove the gateway actually
// registers rc.periph.observations.create — as of rpc.ts:98-272 it does NOT (only
// devices.*/observations.list/captureResult/bridge.announce/plaud.*). P2-T1 is
// blocked-on-RPC until the plugin-backend agent adds that handler (→ recordObservation).
// The "contract" test below pins the exact wire shape both ends must agree on and
// consumes a REAL gateway observation fixture so the response contract is executable.

describe('CameraDetail — manual snap observation (P2-T1)', () => {
  const bridgeDevice = {
    id: 'dev-bridge-uuid-1',
    name: 'FaceTime HD',
    kind: 'camera' as const,
    driver: 'browser-camera' as const,
    enabled: true,
    config: { deviceId: 'cam-a', label: 'FaceTime HD' },
    check_prompt: '',
    last_seen_at: null,
    last_error: null,
    created_at: '',
    updated_at: '',
  };

  it('writes a snapshot observation keyed on the registered device uuid after a manual snap', async () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    mockCaptureFrame.mockResolvedValue({ blob, width: 640, height: 480 });
    // P2-F1: derive the returned path from the ACTUAL upload destination instead of
    // hardcoding the uuid dir. A hardcoded `periph/dev-bridge-uuid-1/...` return
    // would make the frame_path assertion pass even if production uploaded to the
    // browser id (`periph/cam-a`) — the exact defect this block must catch. By
    // echoing back `<destination>/frame.jpg`, frame_path is only correct when the
    // upload REALLY targets the uuid dir (CameraDetail.tsx captureAndUpload).
    mockUpload.mockImplementation((_file: File, destination: string) =>
      Promise.resolve({ path: `${destination}/frame.jpg`, name: 'frame.jpg' }),
    );

    const requestSpy = vi.fn().mockResolvedValue({ observation: { id: 'obs-x' } });
    useGatewayStore.setState({ client: { isConnected: true, request: requestSpy } as never });
    usePeripheralsStore.setState({ devices: [bridgeDevice] });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-snap')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-snap'));

    // P2-F1: the frame directory must unify on the registered uuid, NOT the browser
    // mediaDevice id (bridgeDevice.config.deviceId='cam-a' → id='dev-bridge-uuid-1').
    // Assert the REAL upload destination (mirrors the snap test's mock.calls[0][1]
    // pattern at ~line 450), not just the echoed return value.
    await waitFor(() => {
      const uploadCall = mockUpload.mock.calls[0];
      expect(uploadCall).toBeTruthy();
      expect(uploadCall[1]).toBe('periph/dev-bridge-uuid-1');
    });

    await waitFor(() => {
      const call = requestSpy.mock.calls.find((c) => c[0] === 'rc.periph.observations.create');
      expect(call).toBeTruthy();
      const params = call![1] as Record<string, unknown>;
      // device_id must be the STABLE registered uuid, not the browser mediaDevice id.
      expect(params.device_id).toBe('dev-bridge-uuid-1');
      expect(params.kind).toBe('snapshot');
      expect(params.verdict).toBe('info');
      // frame_path is the uploaded path under the uuid dir (echoed from the real
      // destination above, so it can only be this when the upload targeted it).
      expect(params.frame_path).toBe('periph/dev-bridge-uuid-1/frame.jpg');
    });
  });

  it('writes NO observation when the selected camera has no registered bridge device', async () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    mockCaptureFrame.mockResolvedValue({ blob, width: 640, height: 480 });
    mockUpload.mockResolvedValue({ path: 'periph/cam-a/frame.jpg', name: 'frame.jpg' });

    const requestSpy = vi.fn().mockResolvedValue({ ok: true });
    useGatewayStore.setState({ client: { isConnected: true, request: requestSpy } as never });
    // No devices registered → no bridge for cam-a.
    usePeripheralsStore.setState({ devices: [] });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-snap')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-snap'));

    // Upload happens (proves the snap ran); the observation-create must NOT.
    await waitFor(() => expect(mockUpload).toHaveBeenCalled());
    // P2-F1 fallback: with NO registered bridge there is no uuid to key on, so the
    // upload directory falls back to the browser mediaDevice id (`cam-a`). This is
    // the only case where a browser id keys the frame dir.
    expect(mockUpload.mock.calls[0][1]).toBe('periph/cam-a');
    await new Promise((r) => setTimeout(r, 0));
    expect(requestSpy.mock.calls.some((c) => c[0] === 'rc.periph.observations.create')).toBe(false);
  });

  it('a missing observation-create method never fails the snap (still injects into chat)', async () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    mockCaptureFrame.mockResolvedValue({ blob, width: 640, height: 480 });
    // Echo the real destination (P2-F1) → path is only the uuid dir if the upload
    // actually targeted it.
    mockUpload.mockImplementation((_file: File, destination: string) =>
      Promise.resolve({ path: `${destination}/frame.jpg`, name: 'frame.jpg' }),
    );

    // Reserved RPC absent on an older gateway → rejects METHOD_NOT_FOUND.
    const requestSpy = vi.fn().mockRejectedValue(
      Object.assign(new Error('no such method'), { code: 'METHOD_NOT_FOUND' }),
    );
    useGatewayStore.setState({ client: { isConnected: true, request: requestSpy } as never });
    usePeripheralsStore.setState({ devices: [bridgeDevice] });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-snap')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-snap'));

    // The observation-create was attempted…
    await waitFor(() =>
      expect(requestSpy.mock.calls.some((c) => c[0] === 'rc.periph.observations.create')).toBe(true),
    );
    // …but the snap still completed: chat prefill was set despite the RPC rejection.
    await waitFor(() => {
      const prefill = useUiStore.getState().chatAttachmentPrefill;
      expect(prefill).not.toBeNull();
      expect(prefill![0].wsPath).toBe('periph/dev-bridge-uuid-1/frame.jpg');
    });
  });

  // ── CONTRACT: rc.periph.observations.create request/response wire shape ──────
  // Pins the exact contract the gateway handler (NOT yet in rpc.ts — see the block
  // header) MUST honor. The REQUEST assertion is driven by the real snap; the
  // RESPONSE assertion consumes a REAL gateway observation fixture
  // (RC_PERIPH_OBSERVATIONS_LIST_RESPONSE, produced by rpc.ts observations.list →
  // service.recordObservation output, PeriphObservation types.ts:26-43) so both
  // ends of the seam are locked to one executable shape. When the plugin-backend
  // agent registers observations.create forwarding to service.recordObservation
  // (service.ts:181-206), it returns { observation } of exactly this shape.
  it('emits a request payload field-compatible with the recordObservation input contract; response is { observation:PeriphObservation }', async () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    mockCaptureFrame.mockResolvedValue({ blob, width: 640, height: 480 });
    // P2-F1: echo the real upload destination so frame_path is derived, not pinned.
    mockUpload.mockImplementation((_file: File, destination: string) =>
      Promise.resolve({ path: `${destination}/frame.jpg`, name: 'frame.jpg' }),
    );

    // The response the gateway MUST return: { observation: PeriphObservation }.
    // Reuse a real fixture row as the returned observation (same shape a
    // recordObservation insert yields), proving the client tolerates the real shape.
    const fixtureObservation = RC_PERIPH_OBSERVATIONS_LIST_RESPONSE.observations[0];
    const requestSpy = vi.fn().mockResolvedValue({ observation: fixtureObservation });
    useGatewayStore.setState({ client: { isConnected: true, request: requestSpy } as never });
    usePeripheralsStore.setState({ devices: [bridgeDevice] });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-snap')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-snap'));

    let params: Record<string, unknown> = {};
    await waitFor(() => {
      const call = requestSpy.mock.calls.find((c) => c[0] === 'rc.periph.observations.create');
      expect(call).toBeTruthy();
      params = call![1] as Record<string, unknown>;
    });

    // ── REQUEST contract (mirrors service.recordObservation input, service.ts:181-189) ──
    // device_id: STABLE registered uuid (FK → rc_periph_devices), never the browser id.
    expect(params.device_id).toBe('dev-bridge-uuid-1');
    // kind ∈ PeriphObservation['kind'] (types.ts:30) — a manual snap is 'snapshot'.
    expect(['snapshot', 'check', 'note']).toContain(params.kind);
    expect(params.kind).toBe('snapshot');
    // verdict ∈ PeriphVerdict (types.ts:10) — a human snap carries no judgment → 'info'.
    expect(['ok', 'alert', 'info', 'unverified', 'missed', 'error']).toContain(params.verdict);
    expect(params.verdict).toBe('info');
    // P2-F1: the upload directory itself must key on the registered uuid, so assert
    // the REAL upload destination — the frame_path below is only trustworthy because
    // it is echoed from this destination.
    expect(mockUpload.mock.calls[0][1]).toBe('periph/dev-bridge-uuid-1');
    // frame_path is the uploaded workspace-relative path (the exact upload() result).
    expect(params.frame_path).toBe('periph/dev-bridge-uuid-1/frame.jpg');
    // summary is a non-empty string (stored verbatim, no i18n key).
    expect(typeof params.summary).toBe('string');
    expect((params.summary as string).length).toBeGreaterThan(0);
    // No stray/unknown fields the handler would have to reject.
    expect(Object.keys(params).sort()).toEqual(
      ['device_id', 'frame_path', 'kind', 'summary', 'verdict'],
    );

    // ── RESPONSE contract: { observation: PeriphObservation } (fixture-locked) ──
    // The plugin-backend handler must return this shape; assert the fixture we
    // handed back satisfies every required PeriphObservation field (types.ts:26-43).
    for (const key of ['id', 'device_id', 'kind', 'verdict', 'summary', 'frame_path', 'captured_at', 'cursor'] as const) {
      expect(fixtureObservation).toHaveProperty(key);
    }
    // A registered device_id is what makes the FK insert legal.
    expect(typeof fixtureObservation.device_id).toBe('string');
    // The client is fire-and-forget: a well-formed response must not break the snap.
    await waitFor(() => {
      const prefill = useUiStore.getState().chatAttachmentPrefill;
      expect(prefill).not.toBeNull();
      expect(prefill![0].wsPath).toBe('periph/dev-bridge-uuid-1/frame.jpg');
    });
  });
});

// ── Preview stream track.stop on device switch / unmount ─────────────────────

describe('CameraDetail — preview stream cleanup', () => {
  it('stops the old track when the user switches to a different device', async () => {
    // Two distinct tracks, one per camera
    const trackA = makeTrack({ width: 1280, height: 720, frameRate: 30 });
    const trackB = makeTrack({ width: 640, height: 480, frameRate: 30 });
    const streamA = makeStream(trackA);
    const streamB = makeStream(trackB);

    let callCount = 0;
    const getUserMedia = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve(callCount === 1 ? streamA : streamB);
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: vi.fn().mockResolvedValue(TWO_CAMERAS), getUserMedia },
    });

    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    // Wait for the first stream (cam-a) to be established
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    // Switch to cam-b by clicking its list row
    await waitFor(() => expect(screen.getByTestId('periph-camera-device-row-cam-b')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-device-row-cam-b'));

    // After the switch, stream A's track must have been stopped
    await waitFor(() => expect(trackA.stop).toHaveBeenCalled());
  });

  it('stops the active track when the component unmounts', async () => {
    const track = makeTrack({ width: 1280, height: 720, frameRate: 30 });
    const stream = makeStream(track);
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: vi.fn().mockResolvedValue(TWO_CAMERAS), getUserMedia },
    });

    const { unmount } = render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    // Wait for stream to be established
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    unmount();

    // The track must be stopped after unmount
    expect(track.stop).toHaveBeenCalled();
  });
});

// ── Save to workspace (no inject) ─────────────────────────────────────────────

describe('CameraDetail — save to workspace', () => {
  it('uploads without prefilling the chat attachment', async () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    mockCaptureFrame.mockResolvedValue({ blob, width: 640, height: 480 });
    mockUpload.mockResolvedValue({ path: 'periph/cam-a/frame.jpg', name: 'frame.jpg' });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-save')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-save'));

    await waitFor(() => expect(mockUpload).toHaveBeenCalled());
    // Give any async chains a tick, then assert prefill stays null
    await new Promise((r) => setTimeout(r, 0));
    expect(useUiStore.getState().chatAttachmentPrefill).toBeNull();
  });
});

// ── getUserMedia error diagnostics (T19 P-2) ─────────────────────────────────

describe('CameraDetail — error diagnostics', () => {
  function makeGumError(name: string): Error {
    const e = new Error(`${name} message`);
    e.name = name;
    return e;
  }

  it('preview NotAllowedError → shows permission copy in the caption', async () => {
    const enumerate = vi.fn().mockResolvedValue(TWO_CAMERAS);
    const getUserMedia = vi.fn().mockRejectedValue(makeGumError('NotAllowedError'));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: enumerate, getUserMedia },
    });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => {
      const caption = screen.getByTestId('periph-camera-caption');
      expect(caption.textContent).toContain('系统设置');
    });
  });

  it('preview NotReadableError → shows "in use by another app" copy', async () => {
    const enumerate = vi.fn().mockResolvedValue(TWO_CAMERAS);
    const getUserMedia = vi.fn().mockRejectedValue(makeGumError('NotReadableError'));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: enumerate, getUserMedia },
    });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => {
      const caption = screen.getByTestId('periph-camera-caption');
      expect(caption.textContent).toContain('被其他应用占用');
    });
  });

  it('preview unclassified error → appends err.name/message', async () => {
    const enumerate = vi.fn().mockResolvedValue(TWO_CAMERAS);
    const getUserMedia = vi.fn().mockRejectedValue(makeGumError('SomeWeirdError'));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: enumerate, getUserMedia },
    });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => {
      const caption = screen.getByTestId('periph-camera-caption');
      expect(caption.textContent).toContain('SomeWeirdError');
    });
  });

  it('authorize NotFoundError → surfaces "no camera device" via message', async () => {
    // Labels empty → authorize button renders. getUserMedia rejects NotFound.
    const enumerate = vi.fn().mockResolvedValue([
      { deviceId: 'cam-a', kind: 'videoinput', label: '', groupId: 'g1' },
    ]);
    const getUserMedia = vi.fn().mockRejectedValue(makeGumError('NotFoundError'));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: enumerate, getUserMedia },
    });

    render(<Wrapper><CameraDetail deviceId={null} /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-authorize')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-authorize'));

    // antd message renders the classified copy into the DOM.
    await waitFor(() => {
      expect(document.body.textContent).toContain('未检测到摄像头设备');
    });
  });
});

// ── Bridge enable toggle: create + announce, idempotent update ────────────────

describe('CameraDetail — bridge toggle', () => {
  it('creates a browser-camera device and announces the bridge when turned on', async () => {
    const created = {
      id: 'dev-1', name: 'FaceTime HD', kind: 'camera', driver: 'browser-camera',
      enabled: true, config: { deviceId: 'cam-a', label: 'FaceTime HD' },
      check_prompt: '', last_seen_at: null, last_error: null, created_at: '', updated_at: '',
    };
    const createSpy = vi.fn().mockResolvedValue(created);
    const announceSpy = vi.fn().mockResolvedValue(undefined);
    const updateSpy = vi.fn().mockResolvedValue(undefined);
    usePeripheralsStore.setState({
      createDevice: createSpy as never,
      announceBridge: announceSpy as never,
      updateDevice: updateSpy as never,
    });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-bridge-switch-cam-a')).toBeTruthy());
    const sw = screen.getByTestId('periph-camera-bridge-switch-cam-a').querySelector('button')
      ?? screen.getByTestId('periph-camera-bridge-switch-cam-a');
    fireEvent.click(sw);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
      const arg = createSpy.mock.calls[0][0];
      expect(arg.kind).toBe('camera');
      expect(arg.driver).toBe('browser-camera');
      expect(arg.config.deviceId).toBe('cam-a');
    });
    await waitFor(() => expect(announceSpy).toHaveBeenCalled());
    // idempotent: no update path taken when there was no existing device
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('each row toggles its OWN bridge (parameterized, per-device idempotency)', async () => {
    // cam-a already bridged+enabled; cam-b unregistered. Toggling cam-b must
    // create a NEW device for cam-b (not touch cam-a), and toggling cam-a off
    // must update cam-a's device only.
    const existingA = {
      id: 'dev-a', name: 'FaceTime HD', kind: 'camera' as const, driver: 'browser-camera' as const,
      enabled: true, config: { deviceId: 'cam-a', label: 'FaceTime HD' },
      check_prompt: '', last_seen_at: null, last_error: null, created_at: '', updated_at: '',
    };
    const createSpy = vi.fn().mockResolvedValue({ ...existingA, id: 'dev-b', config: { deviceId: 'cam-b', label: 'USB Webcam' } });
    const announceSpy = vi.fn().mockResolvedValue(undefined);
    const updateSpy = vi.fn().mockResolvedValue(undefined);
    usePeripheralsStore.setState({
      devices: [existingA],
      createDevice: createSpy as never,
      announceBridge: announceSpy as never,
      updateDevice: updateSpy as never,
    });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    // Turn cam-b's bridge ON → creates a device for cam-b (deviceId cam-b).
    await waitFor(() => expect(screen.getByTestId('periph-camera-bridge-switch-cam-b')).toBeTruthy());
    const swB = screen.getByTestId('periph-camera-bridge-switch-cam-b').querySelector('button')!;
    fireEvent.click(swB);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0][0].config.deviceId).toBe('cam-b');
    });
    // cam-a's existing device was never updated by the cam-b toggle.
    expect(updateSpy).not.toHaveBeenCalled();

    // Turn cam-a's bridge OFF → updates dev-a (enabled:false), no new create.
    const swA = screen.getByTestId('periph-camera-bridge-switch-cam-a').querySelector('button')!;
    fireEvent.click(swA);
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('dev-a', expect.objectContaining({ enabled: false }));
    });
    expect(createSpy).toHaveBeenCalledTimes(1); // no extra create for cam-a
  });

  it('updates the existing device (enabled:true) instead of creating a duplicate', async () => {
    const existing = {
      id: 'dev-existing', name: 'FaceTime HD', kind: 'camera' as const, driver: 'browser-camera' as const,
      enabled: false, config: { deviceId: 'cam-a', label: 'FaceTime HD' },
      check_prompt: '', last_seen_at: null, last_error: null, created_at: '', updated_at: '',
    };
    const createSpy = vi.fn();
    const announceSpy = vi.fn().mockResolvedValue(undefined);
    const updateSpy = vi.fn().mockResolvedValue(undefined);
    usePeripheralsStore.setState({
      devices: [existing],
      createDevice: createSpy as never,
      announceBridge: announceSpy as never,
      updateDevice: updateSpy as never,
    });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-bridge-switch-cam-a')).toBeTruthy());
    const sw = screen.getByTestId('periph-camera-bridge-switch-cam-a').querySelector('button')
      ?? screen.getByTestId('periph-camera-bridge-switch-cam-a');
    fireEvent.click(sw);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('dev-existing', expect.objectContaining({ enabled: true }));
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('disables the existing device when turned off', async () => {
    const existing = {
      id: 'dev-existing', name: 'FaceTime HD', kind: 'camera' as const, driver: 'browser-camera' as const,
      enabled: true, config: { deviceId: 'cam-a', label: 'FaceTime HD' },
      check_prompt: '', last_seen_at: null, last_error: null, created_at: '', updated_at: '',
    };
    const updateSpy = vi.fn().mockResolvedValue(undefined);
    usePeripheralsStore.setState({
      devices: [existing],
      updateDevice: updateSpy as never,
    });

    render(<Wrapper><CameraDetail deviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-bridge-switch-cam-a')).toBeTruthy());
    const sw = screen.getByTestId('periph-camera-bridge-switch-cam-a').querySelector('button')
      ?? screen.getByTestId('periph-camera-bridge-switch-cam-a');
    // switch derived on → click turns off
    fireEvent.click(sw);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('dev-existing', expect.objectContaining({ enabled: false }));
    });
  });
});
