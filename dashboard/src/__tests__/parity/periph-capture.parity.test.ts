/**
 * Behavioral Parity Tests: PeriphCaptureListener (抓帧执行端)
 *
 * Verifies the dashboard's response to gateway camera-capture requests:
 *   gateway agent tool periph_camera_snap
 *     → periphBridge.requestCapture() broadcasts
 *        `plugin.rc.periph.captureRequest` { requestId, deviceId, purposeHint }
 *        Source (broadcast line): extensions/research-claw-core/src/periph/bridge.ts:129
 *          broadcast('plugin.rc.periph.captureRequest', { requestId, deviceId, purposeHint })
 *     → this listener captures a frame, POSTs to /rc/upload (destination `periph/<deviceId>`)
 *     → replies `rc.periph.captureResult` { requestId, ok, path?, width?, height?, error? }
 *        Result-payload shape source: bridge.ts:38-44 (CaptureResult interface)
 *
 * The event payload fixture below is copied verbatim from bridge.ts:129's broadcast call.
 *
 * getUserMedia's real behavior cannot be exercised under happy-dom, so the
 * `gateway/camera` module (which owns captureFrameFromCamera) is mocked at its
 * boundary; its own orchestration is verified against real hardware in T19.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

// ── Event payload fixture ────────────────────────────────────────────────
// Source: extensions/research-claw-core/src/periph/bridge.ts:129
//   broadcast('plugin.rc.periph.captureRequest', { requestId, deviceId, purposeHint })
const CAPTURE_REQUEST_EVENT = {
  requestId: 'req-cap-0001',
  deviceId: 'media-device-abc123',
  purposeHint: 'Check if the lab bench is clear',
};

// ── Mock gateway client (subscribe captures the handler, request is spied) ─
type EventHandler = (payload: unknown) => void;
const subscribed = new Map<string, EventHandler>();
const mockClient = {
  isConnected: true,
  request: vi.fn(),
  subscribe: vi.fn((event: string, handler: EventHandler) => {
    subscribed.set(event, handler);
    return () => subscribed.delete(event);
  }),
};

// Gateway store: expose client + connected state (component reads both).
vi.mock('../../stores/gateway', () => ({
  useGatewayStore: Object.assign(
    // hook form: useGatewayStore((s) => s.client) etc.
    (selector: (s: unknown) => unknown) =>
      selector({ client: mockClient, state: 'connected' }),
    {
      getState: () => ({ client: mockClient, state: 'connected' }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

// Upload helper mock
vi.mock('../../gateway/upload', () => ({
  uploadFileToWorkspace: vi.fn(),
}));

// Camera helper mock — the component captures frames through gateway/camera,
// so mocking that module's boundary keeps getUserMedia out of the test.
vi.mock('../../gateway/camera', () => ({
  captureFrameFromCamera: vi.fn(),
}));

// peripherals store: announceBridge + loadDevices mocks (called on connect + heartbeat)
const announceBridge = vi.fn().mockResolvedValue(undefined);
const loadDevices = vi.fn().mockResolvedValue(undefined);
vi.mock('../../stores/peripherals', () => ({
  usePeripheralsStore: {
    getState: () => ({ announceBridge, loadDevices }),
  },
}));

import { uploadFileToWorkspace } from '../../gateway/upload';
import { captureFrameFromCamera } from '../../gateway/camera';
import PeriphCaptureListener from '../../components/PeriphCaptureListener';

const mockCaptureFrame = vi.mocked(captureFrameFromCamera);
const mockUpload = vi.mocked(uploadFileToWorkspace);

// ── Helpers ───────────────────────────────────────────────────────────────
function makeBlob(): Blob {
  return new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
}

/** Flush microtasks so the async handler chain completes. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function fireCaptureRequest(payload: Record<string, unknown>) {
  const handler = subscribed.get('plugin.rc.periph.captureRequest');
  if (!handler) throw new Error('captureRequest handler not subscribed');
  handler(payload);
  await flush();
}

// Provide a mediaDevices.enumerateDevices default so connect-time announce works.
function stubMediaDevices(videoInputs: Array<{ deviceId: string; label: string }>) {
  vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    mediaDevices: {
      enumerateDevices: vi.fn().mockResolvedValue(
        videoInputs.map((v) => ({ kind: 'videoinput', deviceId: v.deviceId, label: v.label })),
      ),
      getUserMedia: vi.fn(),
    },
  });
}

describe('PeriphCaptureListener — capture request handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    subscribed.clear();
    announceBridge.mockResolvedValue(undefined);
    mockClient.isConnected = true;
    mockClient.subscribe.mockImplementation((event: string, handler: EventHandler) => {
      subscribed.set(event, handler);
      return () => subscribed.delete(event);
    });
    vi.stubGlobal('isSecureContext', true);
    stubMediaDevices([{ deviceId: 'media-device-abc123', label: 'Built-in Camera' }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('subscribes to plugin.rc.periph.captureRequest on mount', () => {
    render(createElement(PeriphCaptureListener));
    expect(mockClient.subscribe).toHaveBeenCalledWith(
      'plugin.rc.periph.captureRequest',
      expect.any(Function),
    );
  });

  it('captures → uploads to periph/<deviceId> → replies rc.periph.captureResult ok', async () => {
    mockCaptureFrame.mockResolvedValue({ blob: makeBlob(), width: 1280, height: 720 });
    mockUpload.mockResolvedValue({
      name: 'x.jpg',
      path: 'periph/media-device-abc123/1700000000000.jpg',
      type: 'file',
      size: 100,
      mime_type: 'image/jpeg',
      modified_at: '2026-07-24T00:00:00.000Z',
      git_status: 'untracked',
    });
    mockClient.request.mockResolvedValue({ ok: true });

    render(createElement(PeriphCaptureListener));
    await fireCaptureRequest(CAPTURE_REQUEST_EVENT);

    // Captured from the requested device id (透传给 getUserMedia)
    expect(mockCaptureFrame).toHaveBeenCalledWith('media-device-abc123');

    // Upload destination is periph/<deviceId>
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [file, destination] = mockUpload.mock.calls[0];
    expect(destination).toBe('periph/media-device-abc123');
    expect(file).toBeInstanceOf(File);
    expect((file as File).type).toBe('image/jpeg');
    expect((file as File).name).toMatch(/^\d+\.jpg$/);

    // captureResult payload — field by field
    expect(mockClient.request).toHaveBeenCalledWith('rc.periph.captureResult', {
      requestId: 'req-cap-0001',
      ok: true,
      path: 'periph/media-device-abc123/1700000000000.jpg',
      width: 1280,
      height: 720,
    });
  });

  it('permission-denied → captureResult { ok:false, error:"permission-denied" }', async () => {
    const err = new Error('Permission denied');
    err.name = 'NotAllowedError';
    mockCaptureFrame.mockRejectedValue(err);
    mockClient.request.mockResolvedValue({ ok: true });

    render(createElement(PeriphCaptureListener));
    await fireCaptureRequest(CAPTURE_REQUEST_EVENT);

    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockClient.request).toHaveBeenCalledWith('rc.periph.captureResult', {
      requestId: 'req-cap-0001',
      ok: false,
      error: 'permission-denied',
    });
  });

  it('device-not-found (NotFoundError) → error:"device-not-found"', async () => {
    const err = new Error('device gone');
    err.name = 'NotFoundError';
    mockCaptureFrame.mockRejectedValue(err);
    mockClient.request.mockResolvedValue({ ok: true });

    render(createElement(PeriphCaptureListener));
    await fireCaptureRequest(CAPTURE_REQUEST_EVENT);

    expect(mockClient.request).toHaveBeenCalledWith('rc.periph.captureResult', {
      requestId: 'req-cap-0001',
      ok: false,
      error: 'device-not-found',
    });
  });

  it('OverconstrainedError → error:"device-not-found"', async () => {
    const err = new Error('constraints not satisfiable');
    err.name = 'OverconstrainedError';
    mockCaptureFrame.mockRejectedValue(err);
    mockClient.request.mockResolvedValue({ ok: true });

    render(createElement(PeriphCaptureListener));
    await fireCaptureRequest(CAPTURE_REQUEST_EVENT);

    expect(mockClient.request).toHaveBeenCalledWith('rc.periph.captureResult', {
      requestId: 'req-cap-0001',
      ok: false,
      error: 'device-not-found',
    });
  });

  it('insecure context → error:"insecure-context", never captures', async () => {
    vi.stubGlobal('isSecureContext', false);

    render(createElement(PeriphCaptureListener));
    await fireCaptureRequest(CAPTURE_REQUEST_EVENT);

    expect(mockCaptureFrame).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockClient.request).toHaveBeenCalledWith('rc.periph.captureResult', {
      requestId: 'req-cap-0001',
      ok: false,
      error: 'insecure-context',
    });
  });

  it('upload failure → error:"upload-failed: <msg>"', async () => {
    mockCaptureFrame.mockResolvedValue({ blob: makeBlob(), width: 640, height: 480 });
    mockUpload.mockRejectedValue(new Error('413 too large'));
    mockClient.request.mockResolvedValue({ ok: true });

    render(createElement(PeriphCaptureListener));
    await fireCaptureRequest(CAPTURE_REQUEST_EVENT);

    expect(mockClient.request).toHaveBeenCalledWith('rc.periph.captureResult', {
      requestId: 'req-cap-0001',
      ok: false,
      error: 'upload-failed: 413 too large',
    });
  });

  it('unknown error → error:String(err)', async () => {
    mockCaptureFrame.mockRejectedValue(new Error('weird failure'));
    mockClient.request.mockResolvedValue({ ok: true });

    render(createElement(PeriphCaptureListener));
    await fireCaptureRequest(CAPTURE_REQUEST_EVENT);

    const call = mockClient.request.mock.calls.find(
      (c) => c[0] === 'rc.periph.captureResult',
    );
    expect(call).toBeDefined();
    expect((call![1] as { ok: boolean }).ok).toBe(false);
    expect((call![1] as { error: string }).error).toContain('weird failure');
  });

  it('deduplicates: same requestId processed only once', async () => {
    mockCaptureFrame.mockResolvedValue({ blob: makeBlob(), width: 1280, height: 720 });
    mockUpload.mockResolvedValue({
      name: 'x.jpg',
      path: 'periph/media-device-abc123/1.jpg',
      type: 'file',
      size: 1,
      mime_type: 'image/jpeg',
      modified_at: '',
      git_status: '',
    });
    mockClient.request.mockResolvedValue({ ok: true });

    render(createElement(PeriphCaptureListener));
    await fireCaptureRequest(CAPTURE_REQUEST_EVENT);
    await fireCaptureRequest(CAPTURE_REQUEST_EVENT); // duplicate delivery

    expect(mockCaptureFrame).toHaveBeenCalledTimes(1);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const resultCalls = mockClient.request.mock.calls.filter(
      (c) => c[0] === 'rc.periph.captureResult',
    );
    expect(resultCalls).toHaveLength(1);
  });
});

describe('PeriphCaptureListener — bridge announce + heartbeat', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    subscribed.clear();
    announceBridge.mockResolvedValue(undefined);
    loadDevices.mockResolvedValue(undefined);
    mockClient.isConnected = true;
    mockClient.subscribe.mockImplementation((event: string, handler: EventHandler) => {
      subscribed.set(event, handler);
      return () => subscribed.delete(event);
    });
    vi.stubGlobal('isSecureContext', true);
    stubMediaDevices([
      { deviceId: 'media-device-abc123', label: 'Built-in Camera' },
      { deviceId: 'media-device-xyz789', label: 'USB Webcam HD' },
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('announces enumerated videoinput devices + secureContext on connect', async () => {
    render(createElement(PeriphCaptureListener));
    await flush();

    expect(announceBridge).toHaveBeenCalledWith(
      [
        { deviceId: 'media-device-abc123', label: 'Built-in Camera' },
        { deviceId: 'media-device-xyz789', label: 'USB Webcam HD' },
      ],
      true,
    );
  });

  it('loads the device list on connect (mirrors loadMonitors)', async () => {
    render(createElement(PeriphCaptureListener));
    await flush();

    expect(loadDevices).toHaveBeenCalled();
  });

  it('re-announces every 60s (heartbeat) and clears timer on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = render(createElement(PeriphCaptureListener));
    // initial announce (async enumerate) — flush real microtasks under fake timers
    await vi.advanceTimersByTimeAsync(0);
    const initialCalls = announceBridge.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(60_000); // tick 1
    expect(announceBridge.mock.calls.length).toBe(initialCalls + 1);

    await vi.advanceTimersByTimeAsync(60_000); // tick 2
    expect(announceBridge.mock.calls.length).toBe(initialCalls + 2);

    unmount();
    await vi.advanceTimersByTimeAsync(60_000); // no more after cleanup
    expect(announceBridge.mock.calls.length).toBe(initialCalls + 2);
  });

  it('announces secureContext:false and does NOT enumerate in insecure context', async () => {
    vi.stubGlobal('isSecureContext', false);
    const enumSpy = navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>;

    render(createElement(PeriphCaptureListener));
    await flush();

    expect(announceBridge).toHaveBeenCalledWith([], false);
    expect(enumSpy).not.toHaveBeenCalled();
  });
});
