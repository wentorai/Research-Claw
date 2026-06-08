import { afterEach, describe, expect, it, vi } from 'vitest';

import { playNotificationSound, resetNotificationSoundForTests } from './notification-sound';

describe('notification-sound', () => {
  afterEach(() => {
    resetNotificationSoundForTests();
    vi.restoreAllMocks();
  });

  it('plays a two-tone chime when AudioContext is available', () => {
    const start = vi.fn();
    const stop = vi.fn();
    const connect = vi.fn();
    const setValueAtTime = vi.fn();
    const exponentialRampToValueAtTime = vi.fn();
    const createOscillator = vi.fn(() => ({
      type: 'sine',
      frequency: { setValueAtTime },
      connect,
      start,
      stop,
    }));
    const createGain = vi.fn(() => ({
      connect,
      gain: { setValueAtTime, exponentialRampToValueAtTime },
    }));

    class MockAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume = vi.fn().mockResolvedValue(undefined);
      createOscillator = createOscillator;
      createGain = createGain;
    }

    vi.stubGlobal('AudioContext', MockAudioContext);

    playNotificationSound('system');

    expect(createOscillator).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('does not throw when AudioContext is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    expect(() => playNotificationSound('error')).not.toThrow();
  });
});
