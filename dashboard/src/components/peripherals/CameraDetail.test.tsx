import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore } from '../../stores/peripherals';
import { useUiStore } from '../../stores/ui';

// ── Mock i18n — t() returns fallback string if provided, else the key ─────────
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

// ── Mock the capture + upload + vision contracts ──────────────────────────────
const mockCaptureFrame = vi.fn();
vi.mock('../../gateway/camera', () => ({
  captureFrameFromCamera: (deviceId?: string) => mockCaptureFrame(deviceId),
}));

const mockUpload = vi.fn();
vi.mock('../../gateway/upload', () => ({
  uploadFileToWorkspace: (file: File, destination: string) => mockUpload(file, destination),
}));

const mockResolveVision = vi.fn();
vi.mock('../../utils/vision-capability', () => ({
  resolveVisionSupport: () => mockResolveVision(),
}));

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
  mockResolveVision.mockReturnValue({ supportsImage: true, source: 'catalog', modelRef: 'zai/glm' });
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
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);

    expect(screen.getByTestId('periph-camera-insecure')).toBeTruthy();
    // No device select rendered
    expect(screen.queryByTestId('periph-camera-device-select')).toBeNull();
    expect(screen.queryByTestId('periph-camera-snap')).toBeNull();
  });

  it('shows insecure hint when getUserMedia is missing', () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);
    expect(screen.getByTestId('periph-camera-insecure')).toBeTruthy();
  });
});

// ── Unavailable banner ────────────────────────────────────────────────────────

describe('CameraDetail — unavailable', () => {
  it('shows plugin-too-old banner when store.unavailable', async () => {
    usePeripheralsStore.setState({ unavailable: true });
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('periph-camera-unavailable')).toBeTruthy());
  });
});

// ── Device selection ──────────────────────────────────────────────────────────

describe('CameraDetail — device select', () => {
  it('lists two videoinput devices (filters out audioinput)', async () => {
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-device-select')).toBeTruthy());

    // Open the antd Select dropdown
    const select = screen.getByTestId('periph-camera-device-select').querySelector('.ant-select-selector');
    fireEvent.mouseDown(select!);

    // Both cameras appear as dropdown options (cam-a also shows as the selection item → getAllByText)
    await waitFor(() => {
      expect(screen.getAllByText('FaceTime HD').length).toBeGreaterThan(0);
      expect(screen.getByText('USB Webcam')).toBeTruthy();
    });
    // audioinput must not appear
    expect(screen.queryByText('Built-in Mic')).toBeNull();
  });

  it('shows an empty state when there are no video devices', async () => {
    installMediaDevices([{ deviceId: 'mic-1', kind: 'audioinput', label: 'Mic', groupId: 'g' }]);
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('periph-camera-empty')).toBeTruthy());
  });

  it('renders an authorize button when labels are empty (permission not granted)', async () => {
    installMediaDevices([
      { deviceId: 'cam-a', kind: 'videoinput', label: '', groupId: 'g1' },
    ]);
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('periph-camera-authorize')).toBeTruthy());
  });
});

// ── Live preview / mount points ───────────────────────────────────────────────

describe('CameraDetail — preview + mount points', () => {
  it('exposes T16 mount points for monitors and timeline (always present)', async () => {
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);
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

    render(<Wrapper><CameraDetail browserDeviceId="cam-a" /></Wrapper>);

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

    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);

    await waitFor(() => {
      const timelineMount = screen.getByTestId('periph-camera-timeline');
      // No ObservationTimeline inside
      expect(timelineMount.querySelector('[data-testid="mock-observation-timeline"]')).toBeNull();
    });
  });
});

// ── Vision hint three states ──────────────────────────────────────────────────

describe('CameraDetail — vision hint', () => {
  // Note: the mocked t() returns the English fallback; assert distinct copy per state.
  it('true → supports-image copy', async () => {
    mockResolveVision.mockReturnValue({ supportsImage: true, source: 'catalog', modelRef: 'm' });
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);
    await waitFor(() => {
      const hint = screen.getByTestId('periph-camera-vision-hint');
      expect(hint.textContent).toContain('supports image input');
    });
  });

  it('false → may-not-support copy', async () => {
    mockResolveVision.mockReturnValue({ supportsImage: false, source: 'catalog', modelRef: 'm' });
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);
    await waitFor(() => {
      const hint = screen.getByTestId('periph-camera-vision-hint');
      expect(hint.textContent).toContain('may not support');
    });
  });

  it("'unknown' → cannot-confirm copy", async () => {
    mockResolveVision.mockReturnValue({ supportsImage: 'unknown', source: 'none', modelRef: null });
    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);
    await waitFor(() => {
      const hint = screen.getByTestId('periph-camera-vision-hint');
      expect(hint.textContent).toContain('Cannot confirm');
    });
  });
});

// ── Snap → inject into chat ───────────────────────────────────────────────────

describe('CameraDetail — snap to chat', () => {
  it('captures, uploads to periph/<id>, and prefills a chat attachment with wsPath', async () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    mockCaptureFrame.mockResolvedValue({ blob, width: 640, height: 480 });
    mockUpload.mockResolvedValue({ path: 'periph/cam-a/frame.jpg', name: 'frame.jpg' });

    render(<Wrapper><CameraDetail browserDeviceId="cam-a" /></Wrapper>);

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

    render(<Wrapper><CameraDetail browserDeviceId="cam-a" /></Wrapper>);

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

    render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);

    // Wait for the first stream (cam-a) to be established
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    // Switch to cam-b via the Select dropdown
    const select = screen.getByTestId('periph-camera-device-select').querySelector('.ant-select-selector');
    fireEvent.mouseDown(select!);
    await waitFor(() => expect(screen.getByText('USB Webcam')).toBeTruthy());
    fireEvent.click(screen.getByText('USB Webcam'));

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

    const { unmount } = render(<Wrapper><CameraDetail browserDeviceId={null} /></Wrapper>);

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

    render(<Wrapper><CameraDetail browserDeviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-save')).toBeTruthy());
    fireEvent.click(screen.getByTestId('periph-camera-save'));

    await waitFor(() => expect(mockUpload).toHaveBeenCalled());
    // Give any async chains a tick, then assert prefill stays null
    await new Promise((r) => setTimeout(r, 0));
    expect(useUiStore.getState().chatAttachmentPrefill).toBeNull();
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

    render(<Wrapper><CameraDetail browserDeviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-bridge-switch')).toBeTruthy());
    const sw = screen.getByTestId('periph-camera-bridge-switch').querySelector('button')
      ?? screen.getByTestId('periph-camera-bridge-switch');
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

    render(<Wrapper><CameraDetail browserDeviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-bridge-switch')).toBeTruthy());
    const sw = screen.getByTestId('periph-camera-bridge-switch').querySelector('button')
      ?? screen.getByTestId('periph-camera-bridge-switch');
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

    render(<Wrapper><CameraDetail browserDeviceId="cam-a" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('periph-camera-bridge-switch')).toBeTruthy());
    const sw = screen.getByTestId('periph-camera-bridge-switch').querySelector('button')
      ?? screen.getByTestId('periph-camera-bridge-switch');
    // switch derived on → click turns off
    fireEvent.click(sw);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('dev-existing', expect.objectContaining({ enabled: false }));
    });
  });
});
