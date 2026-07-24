/**
 * P2-F — production rc.supervisor.* RPC tests.
 *
 * Drives the REAL registered handlers (via the harness, which registers through
 * the same registerMethod the gateway uses) — NOT a re-implementation of the
 * allowlist/merge logic. Verifies the config allowlist, prototype-pollution
 * resistance, the new allowlist keys (grounding / dangerousToolPolicy), nested
 * deep-merge, and that status exposes them.
 */

import { describe, expect, it } from 'vitest';
import { loadPluginFresh, type Harness } from './harness/plugin-harness.js';

const CONFIG = {
  enabled: true,
  supervisorModel: 'testprov/testmodel',
  reviewMode: 'correct',
  grounding: { networkPolicy: 'off', verdictMode: 'flag' },
};

async function setConfig(h: Harness, params: Record<string, unknown>) {
  const fn = h.rpc.get('rc.supervisor.config');
  expect(fn).toBeDefined();
  return (await fn!(params)) as { ok: boolean; config: Record<string, unknown> };
}

describe('P2-F rc.supervisor.config production RPC', () => {
  it('applies known keys, drops unknown, and resists prototype/constructor pollution', async () => {
    const h = await loadPluginFresh(CONFIG);
    const res = await setConfig(h, { reviewMode: 'full', bogusKey: 'x', constructor: 'evil' });
    expect(res.config.reviewMode).toBe('full');
    expect(res.config.bogusKey).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).bogusKey).toBeUndefined();
  });

  it('applies grounding.networkPolicy and dangerousToolPolicy via the allowlist', async () => {
    const h = await loadPluginFresh(CONFIG);
    const res = await setConfig(h, { grounding: { networkPolicy: 'identifiers-only' }, dangerousToolPolicy: 'approve' });
    expect((res.config.grounding as { networkPolicy: string }).networkPolicy).toBe('identifiers-only');
    expect(res.config.dangerousToolPolicy).toBe('approve');
  });

  it('deep-merges grounding sub-fields on partial update (preserves verdictMode)', async () => {
    const h = await loadPluginFresh({ ...CONFIG, grounding: { networkPolicy: 'full', verdictMode: 'info' } });
    const res = await setConfig(h, { grounding: { networkPolicy: 'off' } });
    const g = res.config.grounding as { networkPolicy: string; verdictMode: string };
    expect(g.networkPolicy).toBe('off');
    expect(g.verdictMode).toBe('info'); // preserved via deep merge, not clobbered
  });

  it('rc.supervisor.status exposes grounding + dangerousToolPolicy', async () => {
    const h = await loadPluginFresh({ ...CONFIG, dangerousToolPolicy: 'approve', grounding: { networkPolicy: 'full', verdictMode: 'flag' } });
    const s = (await h.rpc.get('rc.supervisor.status')!({})) as { dangerousToolPolicy?: string; grounding?: { networkPolicy?: string } };
    expect(s.dangerousToolPolicy).toBe('approve');
    expect(s.grounding?.networkPolicy).toBe('full');
  });

  it('applies toolReviewGateMs via the allowlist (not silently dropped on RPC write)', async () => {
    const h = await loadPluginFresh(CONFIG);
    const res = await setConfig(h, { toolReviewGateMs: 25000 });
    expect(res.config.toolReviewGateMs).toBe(25000); // survives the allowlist filter → persisted
  });

  it('rc.supervisor.status exposes toolReviewGateMs', async () => {
    const h = await loadPluginFresh({ ...CONFIG, toolReviewGateMs: 25000 });
    const s = (await h.rpc.get('rc.supervisor.status')!({})) as { toolReviewGateMs?: number };
    expect(s.toolReviewGateMs).toBe(25000);
  });
});
