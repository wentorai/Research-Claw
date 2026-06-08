/**
 * Lightweight notification chime via Web Audio API (no asset files).
 */

export type NotificationSoundType =
  | 'deadline'
  | 'heartbeat'
  | 'system'
  | 'error'
  | 'update'
  | 'default';

let audioContext: AudioContext | null = null;
let unlockBound = false;

const SOUND_PROFILES: Record<NotificationSoundType, { freq1: number; freq2: number }> = {
  deadline: { freq1: 880, freq2: 660 },
  error: { freq1: 440, freq2: 349 },
  heartbeat: { freq1: 784, freq2: 988 },
  system: { freq1: 659, freq2: 784 },
  update: { freq1: 523, freq2: 659 },
  default: { freq1: 660, freq2: 880 },
};

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!audioContext) audioContext = new Ctx();
  return audioContext;
}

function ensureAudioUnlocked(): void {
  if (typeof window === 'undefined' || unlockBound) return;
  unlockBound = true;
  const unlock = () => {
    void getAudioContext()?.resume();
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true, passive: true });
}

function resolveProfile(type?: string): { freq1: number; freq2: number } {
  if (type && type in SOUND_PROFILES) {
    return SOUND_PROFILES[type as NotificationSoundType];
  }
  return SOUND_PROFILES.default;
}

function playTone(ctx: AudioContext, type?: string): void {
  const { freq1, freq2 } = resolveProfile(type);
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

  const osc1 = ctx.createOscillator();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(freq1, now);
  osc1.connect(gain);
  osc1.start(now);
  osc1.stop(now + 0.12);

  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(freq2, now + 0.1);
  osc2.connect(gain);
  osc2.start(now + 0.1);
  osc2.stop(now + 0.35);
}

export function playNotificationSound(type?: string): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  ensureAudioUnlocked();

  if (ctx.state === 'suspended') {
    void ctx.resume().then(() => {
      if (ctx.state === 'running') playTone(ctx, type);
    });
    return;
  }

  playTone(ctx, type);
}

/** Reset module state — for unit tests only. */
export function resetNotificationSoundForTests(): void {
  audioContext = null;
  unlockBound = false;
}
