/**
 * Harness `waitUntil` — a state-based completion condition, NOT a fixed sleep.
 * Verifies it (a) waits correctly for a condition that becomes true only after
 * >50ms, and (b) rejects (times out) for a condition that never becomes true.
 */

import { describe, expect, it } from 'vitest';
import { loadPluginFresh } from './harness/plugin-harness.js';

const CONFIG = { enabled: true, supervisorModel: 'fake/model', reviewMode: 'correct' };

describe('harness waitUntil', () => {
  it('resolves after the condition flips true, even when that takes >50ms', async () => {
    const h = await loadPluginFresh(CONFIG);
    let ready = false;
    setTimeout(() => { ready = true; }, 90); // longer than any fixed short sleep
    const t0 = Date.now();
    await h.waitUntil(() => ready, { timeoutMs: 2000, intervalMs: 5 });
    const elapsed = Date.now() - t0;
    expect(ready).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(85); // actually waited for the condition
  });

  it('rejects (times out) when the condition never becomes true', async () => {
    const h = await loadPluginFresh(CONFIG);
    await expect(h.waitUntil(() => false, { timeoutMs: 60, intervalMs: 5 })).rejects.toThrow(/within 60ms/);
  });
});
