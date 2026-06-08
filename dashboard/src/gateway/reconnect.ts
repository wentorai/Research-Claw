/**
 * Exponential backoff reconnection strategy.
 *
 * Pattern: 800ms initial → 15s cap, 1.7x multiplier.
 * Based on OpenClaw's GatewayBrowserClient reconnection logic.
 */

export interface ReconnectConfig {
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
}

const DEFAULTS: Required<ReconnectConfig> = {
  initialDelayMs: 800,
  maxDelayMs: 15_000,
  multiplier: 1.7,
};

export class ReconnectScheduler {
  private delay: number;
  private config: Required<ReconnectConfig>;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: ReconnectConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.delay = this.config.initialDelayMs;
  }

  schedule(fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    const jitter = 0.85 + Math.random() * 0.3;
    const delay = Math.round(this.delay * jitter);
    // Increase backoff BEFORE timer fires (aligned with OC gateway.ts:214-221).
    // Ensures the next schedule() call uses the increased delay even if
    // fn() synchronously triggers another schedule.
    this.delay = Math.min(this.delay * this.config.multiplier, this.config.maxDelayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, delay);
  }

  reset(): void {
    this.delay = this.config.initialDelayMs;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
