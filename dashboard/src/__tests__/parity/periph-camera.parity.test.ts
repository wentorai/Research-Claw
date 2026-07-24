/**
 * Unit test: captureFrameFromCamera orchestration (gateway/camera.ts)
 *
 * getUserMedia's real behavior is unavailable under happy-dom, so this test
 * mocks navigator.mediaDevices.getUserMedia + the video/canvas DOM primitives
 * and asserts the orchestration is correct:
 *   - getUserMedia is called with { deviceId: { exact } } for a specific id
 *   - getUserMedia is called with { video: true } for an empty id
 *   - drawImage → canvas.toBlob('image/jpeg', 0.85)
 *   - ALL stream tracks are stopped in `finally` (success AND failure)
 *
 * Real-hardware verification is T19.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureFrameFromCamera } from '../../gateway/camera';

// ── Fakes ──────────────────────────────────────────────────────────────────
function makeTrack() {
  return { stop: vi.fn() };
}

function makeStream(tracks: ReturnType<typeof makeTrack>[]) {
  return { getTracks: () => tracks };
}

/**
 * Install a fake <video>/<canvas> pair. The fake video fires 'loadedmetadata'
 * on the next microtask after play(); the fake canvas returns a jpeg blob.
 */
function installDom(opts: { videoWidth?: number; videoHeight?: number; toBlobNull?: boolean } = {}) {
  const listeners = new Map<string, () => void>();
  const drawImage = vi.fn();
  const toBlob = vi.fn(
    (cb: (b: Blob | null) => void, _type?: string, _q?: number) =>
      cb(opts.toBlobNull ? null : new Blob(['jpg'], { type: 'image/jpeg' })),
  );

  const video = {
    muted: false,
    playsInline: false,
    srcObject: null as unknown,
    videoWidth: opts.videoWidth ?? 1280,
    videoHeight: opts.videoHeight ?? 720,
    addEventListener: (ev: string, cb: () => void) => listeners.set(ev, cb),
    removeEventListener: (ev: string) => listeners.delete(ev),
    play: vi.fn(() => {
      // fire loadedmetadata after play resolves
      queueMicrotask(() => listeners.get('loadedmetadata')?.());
      return Promise.resolve();
    }),
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob,
  };

  const createElement = vi.fn((tag: string) =>
    tag === 'video' ? (video as unknown) : (canvas as unknown),
  ) as unknown as typeof document.createElement;

  vi.stubGlobal('document', { createElement });
  return { video, canvas, drawImage, toBlob };
}

describe('captureFrameFromCamera orchestration', () => {
  let tracks: ReturnType<typeof makeTrack>[];
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tracks = [makeTrack(), makeTrack()];
    getUserMedia = vi.fn().mockResolvedValue(makeStream(tracks));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests the exact deviceId, draws, encodes jpeg @0.85, returns dims, stops tracks', async () => {
    const { drawImage, toBlob } = installDom({ videoWidth: 1920, videoHeight: 1080 });

    const result = await captureFrameFromCamera('media-device-abc123');

    expect(getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: 'media-device-abc123' } },
    });
    expect(drawImage).toHaveBeenCalled();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.blob.type).toBe('image/jpeg');
    // Every track released.
    for (const t of tracks) expect(t.stop).toHaveBeenCalledTimes(1);
  });

  it('uses { video: true } when deviceId is empty', async () => {
    installDom();
    await captureFrameFromCamera('');
    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
  });

  it('stops tracks even when encoding fails (finally cleanup)', async () => {
    installDom({ toBlobNull: true });

    await expect(captureFrameFromCamera('dev-1')).rejects.toThrow();
    for (const t of tracks) expect(t.stop).toHaveBeenCalledTimes(1);
  });

  it('propagates getUserMedia rejection (NotAllowedError) without leaking a stream', async () => {
    const err = new Error('denied');
    err.name = 'NotAllowedError';
    getUserMedia.mockRejectedValueOnce(err);

    await expect(captureFrameFromCamera('dev-1')).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
    // No stream was ever acquired → no tracks to stop.
    for (const t of tracks) expect(t.stop).not.toHaveBeenCalled();
  });
});
