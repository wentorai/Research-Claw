import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureFrameFromCamera, CAPTURE_METADATA_TIMEOUT_MS } from './camera';

/**
 * Audit #9: captureFrameFromCamera waited on `loadedmetadata` with no deadline.
 * A browser that never fires `loadedmetadata` nor `error` (camera held by
 * another app, suspended tab) left a manual snap permanently busy. These tests
 * mock a <video> element that never emits `loadedmetadata` NOR `error`, so only
 * the new finite timeout (camera.ts CAPTURE_METADATA_TIMEOUT_MS) can settle the
 * promise, and the `finally` block must still stop the getUserMedia track.
 *
 * Why a hand-rolled <video>: happy-dom rejects `srcObject = stream` unless the
 * value is a real MediaStream (and never dispatches media events), which would
 * mask the exact hang this fix targets. Stubbing createElement('video') gives a
 * settable srcObject + inert listeners that reproduce the "metadata never
 * arrives" browser condition faithfully.
 */

function makeTrack() {
  return { stop: vi.fn() };
}

function makeStream(tracks: Array<{ stop: ReturnType<typeof vi.fn> }>) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

/** A <video> that accepts srcObject and never fires loadedmetadata/error. */
function makeInertVideo() {
  return {
    muted: false,
    playsInline: false,
    srcObject: null as unknown,
    videoWidth: 0,
    videoHeight: 0,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
  };
}

let track: ReturnType<typeof makeTrack>;
let getUserMedia: ReturnType<typeof vi.fn>;
let createElementSpy: { mockRestore: () => void };

beforeEach(() => {
  vi.useFakeTimers();
  track = makeTrack();
  getUserMedia = vi.fn().mockResolvedValue(makeStream([track]));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  const realCreate = document.createElement.bind(document);
  createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') return makeInertVideo() as unknown as HTMLElement;
    return realCreate(tag as 'div');
  }) as unknown as typeof document.createElement);
});

afterEach(() => {
  createElementSpy.mockRestore();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('captureFrameFromCamera — metadata timeout (audit #9)', () => {
  it('rejects with a CameraTimeoutError when loadedmetadata never fires', async () => {
    const promise = captureFrameFromCamera('cam-a');
    // Attach a rejection handler up front so advancing timers doesn't surface an
    // unhandled rejection; assert on the settled result.
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );

    // Let the getUserMedia microtask resolve and the <video> wiring run…
    await Promise.resolve();
    await Promise.resolve();
    // …then cross the deadline. No `loadedmetadata` is ever dispatched.
    await vi.advanceTimersByTimeAsync(CAPTURE_METADATA_TIMEOUT_MS + 1);

    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.name).toBe('CameraTimeoutError');
      expect(result.err.message).toContain('camera-timeout');
    }
  });

  it('stops the getUserMedia track after the timeout (camera never left held)', async () => {
    const settled = captureFrameFromCamera('cam-a').catch(() => undefined);

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(CAPTURE_METADATA_TIMEOUT_MS + 1);
    await settled;

    // The `finally` block must release the camera even though we never got a frame.
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('does not resolve before the deadline (no premature settle)', async () => {
    let settledFlag = false;
    const p = captureFrameFromCamera('cam-a')
      .catch(() => undefined)
      .finally(() => {
        settledFlag = true;
      });

    await Promise.resolve();
    await Promise.resolve();
    // Advance to just before the deadline — must still be pending.
    await vi.advanceTimersByTimeAsync(CAPTURE_METADATA_TIMEOUT_MS - 1);
    expect(settledFlag).toBe(false);
    expect(track.stop).not.toHaveBeenCalled();

    // Cross the deadline → now it settles and releases.
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(settledFlag).toBe(true);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
