import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useGatewayStore } from '../stores/gateway';
import { usePeripheralsStore } from '../stores/peripherals';
import { useProductPolicyStore } from '../stores/product-policy';

/**
 * P2-F1 (dashboard side): the upload destination for an agent-requested capture
 * must key on the STABLE registered device uuid, not the volatile browser
 * mediaDevice id.
 *
 * Cross-agent contract (plugin-backend agent adds `registeredDeviceId` to the
 * broadcast payload):
 *   plugin.rc.periph.captureRequest { requestId, deviceId, registeredDeviceId?, purposeHint }
 *   Broadcast source: extensions/research-claw-core/src/periph/bridge.ts:147
 *   deviceId          = browser media id (config.deviceId ?? device.id, tools.ts:318-319)
 *   registeredDeviceId = rc_periph_devices row uuid (device.id, tools.ts:295)
 *
 * PeriphCaptureListener must upload to `periph/<registeredDeviceId ?? deviceId>`
 * so frames land under the same directory the agent tool + observation timeline
 * reference. Older gateways omit registeredDeviceId → fall back to deviceId.
 */

// ── Mock capture + upload at the module boundary ──────────────────────────────
const mockCaptureFrame = vi.fn();
vi.mock('../gateway/camera', () => ({
  captureFrameFromCamera: (deviceId?: string) => mockCaptureFrame(deviceId),
}));

const mockUpload = vi.fn();
vi.mock('../gateway/upload', () => ({
  uploadFileToWorkspace: (file: File, destination: string) => mockUpload(file, destination),
}));

import PeriphCaptureListener from './PeriphCaptureListener';

// ── driveable gateway client mock ─────────────────────────────────────────────
type CaptureHandler = (payload: unknown) => void;

function makeClient() {
  let captureHandler: CaptureHandler | null = null;
  const request = vi.fn().mockResolvedValue({ ok: true });
  const client = {
    isConnected: true,
    subscribe: vi.fn((event: string, handler: CaptureHandler) => {
      if (event === 'plugin.rc.periph.captureRequest') captureHandler = handler;
      return () => undefined;
    }),
    request,
  };
  return { client, request, emit: (p: unknown) => captureHandler?.(p) };
}

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

beforeEach(() => {
  vi.clearAllMocks();
  setSecureContext(true);
  // isCameraSecureContext() requires navigator.mediaDevices.getUserMedia to exist.
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([]) },
  });
  // Neutralize the connect-effect side effects (loadDevices + announceBridge).
  usePeripheralsStore.setState({
    devices: [],
    loadDevices: vi.fn().mockResolvedValue(undefined) as never,
    loadObservations: vi.fn().mockResolvedValue(undefined) as never,
    announceBridge: vi.fn().mockResolvedValue(undefined) as never,
  });
  const blob = new Blob(['x'], { type: 'image/jpeg' });
  mockCaptureFrame.mockResolvedValue({ blob, width: 640, height: 480 });
  mockUpload.mockResolvedValue({ path: 'periph/uuid/frame.jpg', name: 'frame.jpg' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PeriphCaptureListener — upload destination keys on registered uuid (P2-F1)', () => {
  it('uploads to periph/<registeredDeviceId> when the payload carries it', async () => {
    const { client, request, emit } = makeClient();
    useGatewayStore.setState({ client: client as never, state: 'connected' });

    render(<PeriphCaptureListener />);
    await waitFor(() => expect(client.subscribe).toHaveBeenCalled());

    emit({
      requestId: 'req-1',
      deviceId: 'browser-media-abc',
      registeredDeviceId: 'reg-uuid-xyz',
      purposeHint: 'agent snap',
    });

    // Capture still targets the browser device…
    await waitFor(() => expect(mockCaptureFrame).toHaveBeenCalledWith('browser-media-abc'));
    // …but the upload directory keys on the STABLE registered uuid.
    await waitFor(() => {
      const [, destination] = mockUpload.mock.calls[0];
      expect(destination).toBe('periph/reg-uuid-xyz');
    });
    // captureResult is replied with the uploaded path.
    await waitFor(() => {
      const call = request.mock.calls.find((c) => c[0] === 'rc.periph.captureResult');
      expect(call).toBeTruthy();
      expect((call![1] as { ok: boolean }).ok).toBe(true);
    });
  });

  it('falls back to periph/<deviceId> when registeredDeviceId is absent (older gateway)', async () => {
    const { client, emit } = makeClient();
    useGatewayStore.setState({ client: client as never, state: 'connected' });

    render(<PeriphCaptureListener />);
    await waitFor(() => expect(client.subscribe).toHaveBeenCalled());

    emit({ requestId: 'req-2', deviceId: 'browser-media-abc', purposeHint: 'agent snap' });

    await waitFor(() => expect(mockCaptureFrame).toHaveBeenCalledWith('browser-media-abc'));
    await waitFor(() => {
      const [, destination] = mockUpload.mock.calls[0];
      expect(destination).toBe('periph/browser-media-abc');
    });
  });

  it('treats an empty-string registeredDeviceId as absent (falls back to deviceId)', async () => {
    const { client, emit } = makeClient();
    useGatewayStore.setState({ client: client as never, state: 'connected' });

    render(<PeriphCaptureListener />);
    await waitFor(() => expect(client.subscribe).toHaveBeenCalled());

    emit({ requestId: 'req-3', deviceId: 'browser-media-abc', registeredDeviceId: '' });

    await waitFor(() => {
      const [, destination] = mockUpload.mock.calls[0];
      expect(destination).toBe('periph/browser-media-abc');
    });
  });
});

describe('PeriphCaptureListener — P2-S1 alert hydration', () => {
  it('loads each registered device latest observations after the device list hydrates', async () => {
    const { client } = makeClient();
    // Keep the parallel bridge-announce path pending. This makes the assertion
    // prove the dedicated loadDevices → loadObservations sequence rather than
    // accidentally passing because announce() also refreshes observations.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(() => new Promise<MediaDeviceInfo[]>(() => undefined)),
      },
    });
    const loadDevices = vi.fn().mockImplementation(async () => {
      usePeripheralsStore.setState({
        devices: [
          {
            id: 'registered-camera',
            name: 'Camera',
            kind: 'camera',
            driver: 'browser-camera',
            enabled: true,
            config: {},
            check_prompt: '',
            last_seen_at: null,
            last_error: null,
            created_at: '',
            updated_at: '',
          },
        ],
      });
    });
    const loadObservations = vi.fn().mockResolvedValue(undefined);
    usePeripheralsStore.setState({
      devices: [],
      loadDevices: loadDevices as never,
      loadObservations: loadObservations as never,
    });
    useGatewayStore.setState({ client: client as never, state: 'connected' });

    render(<PeriphCaptureListener />);

    await waitFor(() => expect(loadDevices).toHaveBeenCalled());
    await waitFor(() => expect(loadObservations).toHaveBeenCalledWith('registered-camera'));
  });
});

describe('PeriphCaptureListener — disabled product policy', () => {
  it('continues subscription, hydration, and enumeration when peripherals is enabled-hidden', async () => {
    useProductPolicyStore.getState().loadFromConfig({
      plugins: { entries: { 'research-claw-core': { config: { productPolicy: {
        capabilities: {
          settings: 'enabled', extensions: 'enabled', supervisor: 'enabled',
          peripherals: 'enabled-hidden',
        },
      } } } } },
    });
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(), enumerateDevices },
    });
    const { client } = makeClient();
    useGatewayStore.setState({ client: client as never, state: 'connected' });

    render(<PeriphCaptureListener />);

    await waitFor(() => expect(client.subscribe).toHaveBeenCalledWith(
      'plugin.rc.periph.captureRequest', expect.any(Function),
    ));
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
    await waitFor(() => expect(usePeripheralsStore.getState().loadDevices).toHaveBeenCalled());
    await waitFor(() => expect(usePeripheralsStore.getState().announceBridge).toHaveBeenCalled());
  });

  it('has zero subscription, enumeration, RPC, hydration, or heartbeat timer', async () => {
    vi.useFakeTimers();
    useProductPolicyStore.getState().loadFromConfig({
      plugins: { entries: { 'research-claw-core': { config: { productPolicy: {
        capabilities: {
          settings: 'enabled', extensions: 'enabled', supervisor: 'enabled', peripherals: 'disabled',
        },
      } } } } },
    });
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(), enumerateDevices },
    });
    const { client, request } = makeClient();
    useGatewayStore.setState({ client: client as never, state: 'connected' });

    render(<PeriphCaptureListener />);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(client.subscribe).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(usePeripheralsStore.getState().loadDevices).not.toHaveBeenCalled();
    expect(usePeripheralsStore.getState().announceBridge).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
