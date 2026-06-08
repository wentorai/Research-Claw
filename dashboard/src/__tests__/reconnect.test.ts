import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReconnectScheduler } from '../gateway/reconnect';

describe('ReconnectScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // schedule() applies jitter in [0.85, 1.15]; fix at 1.0 for deterministic delays.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('initial delay is 800ms', () => {
    const scheduler = new ReconnectScheduler();
    const fn = vi.fn();
    scheduler.schedule(fn);

    vi.advanceTimersByTime(799);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('delay increases with 1.7x multiplier', () => {
    const scheduler = new ReconnectScheduler();
    const fn = vi.fn();

    // First call at 800ms
    scheduler.schedule(fn);
    vi.advanceTimersByTime(800);
    expect(fn).toHaveBeenCalledTimes(1);

    // Second call at 800 * 1.7 = 1360ms
    scheduler.schedule(fn);
    vi.advanceTimersByTime(1359);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('delay caps at 15000ms', () => {
    const scheduler = new ReconnectScheduler();
    const fn = vi.fn();

    // Simulate many retries to exceed cap
    for (let i = 0; i < 20; i++) {
      scheduler.schedule(fn);
      vi.advanceTimersByTime(20_000); // More than max
    }

    // All should have fired (delay never exceeds 15s)
    expect(fn).toHaveBeenCalledTimes(20);
  });

  it('reset brings delay back to initial', () => {
    const scheduler = new ReconnectScheduler();
    const fn = vi.fn();

    // Advance a few times to increase delay
    scheduler.schedule(fn);
    vi.advanceTimersByTime(800);
    scheduler.schedule(fn);
    vi.advanceTimersByTime(1360);

    // Reset
    scheduler.reset();

    // Should be back to 800ms
    scheduler.schedule(fn);
    vi.advanceTimersByTime(799);
    expect(fn).toHaveBeenCalledTimes(2); // Only first two
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('cancel prevents scheduled callback', () => {
    const scheduler = new ReconnectScheduler();
    const fn = vi.fn();

    scheduler.schedule(fn);
    scheduler.cancel();
    vi.advanceTimersByTime(2000);

    expect(fn).not.toHaveBeenCalled();
  });
});
