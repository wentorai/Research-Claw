/**
 * PeriphBridge — TDD test suite (Task 4)
 *
 * Covers:
 *  - requestCapture: no context → immediate {ok:false, error:'bridge-offline'}
 *  - requestCapture: broadcasts correct event name & payload shape
 *  - resolveCapture: first delivery resolves the promise, returns true
 *  - resolveCapture: second delivery (duplicate/late) returns false
 *  - requestCapture: timeout path via vi.useFakeTimers → {ok:false, error:'bridge-timeout'}
 *  - resolveCapture after timeout → returns false (pending already cleared)
 *  - announce / getAnnounce round-trip
 *  - getAnnounce: returns null when announce is older than ANNOUNCE_TTL_MS
 *  - adoptContext: idempotent (second call with different ctx ignored)
 *  - adoptContext: defensive (non-function broadcast rejected)
 *  - hasBroadcast: reflects adoptContext state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PeriphBridge,
  CAPTURE_TIMEOUT_MS,
  ANNOUNCE_TTL_MS,
} from '../periph/bridge.js';

// ── Helpers ────────────────────────────────────────────────────────────────

type BroadcastMock = ReturnType<typeof vi.fn<(event: string, payload: unknown, opts?: unknown) => void>>;

function makeBroadcast(): BroadcastMock {
  return vi.fn<(event: string, payload: unknown, opts?: unknown) => void>();
}

function makeCtx(broadcast: BroadcastMock = makeBroadcast()) {
  return { broadcast };
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe('PeriphBridge', () => {
  let bridge: PeriphBridge;

  beforeEach(() => {
    bridge = new PeriphBridge();
  });

  // ── hasBroadcast / adoptContext ─────────────────────────────────────────

  it('hasBroadcast() is false before adoptContext', () => {
    expect(bridge.hasBroadcast()).toBe(false);
  });

  it('hasBroadcast() is true after adoptContext with a valid context', () => {
    bridge.adoptContext(makeCtx());
    expect(bridge.hasBroadcast()).toBe(true);
  });

  it('adoptContext is idempotent: second call does not replace the first context', () => {
    const first = makeBroadcast();
    const second = makeBroadcast();
    bridge.adoptContext(makeCtx(first));
    bridge.adoptContext(makeCtx(second));
    expect(bridge.hasBroadcast()).toBe(true);
    // Verify the first broadcast is the one used by triggering a capture
    void bridge.requestCapture('d1', 'test');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(0);
  });

  it('adoptContext rejects ctx where broadcast is not a function', () => {
    bridge.adoptContext({ broadcast: 'not-a-function' });
    expect(bridge.hasBroadcast()).toBe(false);
  });

  it('adoptContext rejects null', () => {
    bridge.adoptContext(null);
    expect(bridge.hasBroadcast()).toBe(false);
  });

  it('adoptContext rejects ctx with no broadcast property', () => {
    bridge.adoptContext({ foo: 'bar' });
    expect(bridge.hasBroadcast()).toBe(false);
  });

  // ── requestCapture — offline ────────────────────────────────────────────

  it('requestCapture returns {ok:false, error:"bridge-offline"} when no context', async () => {
    const result = await bridge.requestCapture('dev1', 'check');
    expect(result).toEqual({ ok: false, error: 'bridge-offline' });
  });

  // ── requestCapture — broadcasts correct event + payload ─────────────────

  it('requestCapture broadcasts "plugin.rc.periph.captureRequest" with correct payload shape', async () => {
    const broadcast = makeBroadcast();
    bridge.adoptContext(makeCtx(broadcast));

    // Start capture but don't await — we'll resolve it manually
    const promise = bridge.requestCapture('cam-01', 'lab-snapshot');

    // Should have broadcast synchronously (before any await)
    expect(broadcast).toHaveBeenCalledTimes(1);

    const [event, payload] = broadcast.mock.calls[0] as [string, unknown];
    expect(event).toBe('plugin.rc.periph.captureRequest');
    expect(payload).toMatchObject({
      requestId: expect.any(String),
      deviceId: 'cam-01',
      purposeHint: 'lab-snapshot',
    });

    // Resolve so the promise doesn't leak
    const requestId = (payload as { requestId: string }).requestId;
    bridge.resolveCapture(requestId, { ok: true, path: '/tmp/frame.jpg' });
    await promise;
  });

  // ── resolveCapture — first delivery wins ────────────────────────────────

  it('resolveCapture resolves the promise and returns true', async () => {
    const broadcast = makeBroadcast();
    bridge.adoptContext(makeCtx(broadcast));

    const promise = bridge.requestCapture('cam-02', 'hint');
    const [, payload] = broadcast.mock.calls[0] as [string, unknown];
    const requestId = (payload as { requestId: string }).requestId;

    const captureResult: import('../periph/bridge.js').CaptureResult = {
      ok: true,
      path: '/tmp/snap.jpg',
      width: 1920,
      height: 1080,
    };
    const resolved = bridge.resolveCapture(requestId, captureResult);
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result).toEqual(captureResult);
  });

  it('resolveCapture returns false on second call (idempotent)', async () => {
    const broadcast = makeBroadcast();
    bridge.adoptContext(makeCtx(broadcast));

    const promise = bridge.requestCapture('cam-03', 'hint');
    const [, payload] = broadcast.mock.calls[0] as [string, unknown];
    const requestId = (payload as { requestId: string }).requestId;

    const first = bridge.resolveCapture(requestId, { ok: true });
    const second = bridge.resolveCapture(requestId, { ok: true });
    expect(first).toBe(true);
    expect(second).toBe(false);
    await promise;
  });

  it('resolveCapture returns false for unknown requestId', () => {
    expect(bridge.resolveCapture('nonexistent-id', { ok: true })).toBe(false);
  });

  // ── requestCapture — timeout path ───────────────────────────────────────

  it('requestCapture resolves with {ok:false, error:"bridge-timeout"} after timeout', async () => {
    vi.useFakeTimers();
    try {
      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtx(broadcast));

      const promise = bridge.requestCapture('cam-04', 'hint');

      // Advance past CAPTURE_TIMEOUT_MS
      vi.advanceTimersByTime(CAPTURE_TIMEOUT_MS + 1);

      const result = await promise;
      expect(result).toEqual({ ok: false, error: 'bridge-timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolveCapture returns false if called after timeout', async () => {
    vi.useFakeTimers();
    try {
      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtx(broadcast));

      const promise = bridge.requestCapture('cam-05', 'hint');
      const [, payload] = broadcast.mock.calls[0] as [string, unknown];
      const requestId = (payload as { requestId: string }).requestId;

      // Let it time out
      vi.advanceTimersByTime(CAPTURE_TIMEOUT_MS + 1);
      await promise;

      // Now try to resolve — should be false (already cleaned up)
      const late = bridge.resolveCapture(requestId, { ok: true });
      expect(late).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requestCapture respects custom timeoutMs parameter', async () => {
    vi.useFakeTimers();
    try {
      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtx(broadcast));

      const promise = bridge.requestCapture('cam-06', 'hint', 5_000);

      // Should NOT resolve after only 4999ms
      vi.advanceTimersByTime(4_999);
      // Advance to exactly 5001ms to trigger
      vi.advanceTimersByTime(2);

      const result = await promise;
      expect(result).toEqual({ ok: false, error: 'bridge-timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  // ── announce / getAnnounce ───────────────────────────────────────────────

  it('getAnnounce returns null before any announce', () => {
    expect(bridge.getAnnounce()).toBeNull();
  });

  it('announce + getAnnounce round-trip', () => {
    const payload = {
      devices: [{ deviceId: 'd1', label: 'Front Camera' }],
      secureContext: true,
    };
    bridge.announce(payload);
    const result = bridge.getAnnounce();
    expect(result).not.toBeNull();
    expect(result!.devices).toEqual(payload.devices);
    expect(result!.secureContext).toBe(true);
    expect(typeof result!.at).toBe('string');
    // at should be a valid ISO date
    expect(new Date(result!.at).getTime()).toBeGreaterThan(0);
  });

  it('getAnnounce returns null when announce is older than ANNOUNCE_TTL_MS', () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);

      bridge.announce({
        devices: [{ deviceId: 'd2', label: 'Lab Cam' }],
        secureContext: false,
      });

      expect(bridge.getAnnounce()).not.toBeNull();

      // Advance time past TTL
      vi.setSystemTime(now + ANNOUNCE_TTL_MS + 1);
      expect(bridge.getAnnounce()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('getAnnounce returns non-null when announce is exactly at TTL boundary', () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);

      bridge.announce({ devices: [], secureContext: true });

      // Exactly at TTL — should still be valid (> not >=)
      vi.setSystemTime(now + ANNOUNCE_TTL_MS);
      expect(bridge.getAnnounce()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('announce overwrites a previous announce', () => {
    bridge.announce({ devices: [{ deviceId: 'd1', label: 'Old' }], secureContext: false });
    bridge.announce({ devices: [{ deviceId: 'd2', label: 'New' }], secureContext: true });
    const result = bridge.getAnnounce();
    expect(result!.devices[0]!.label).toBe('New');
  });
});
