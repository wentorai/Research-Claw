/**
 * P2-C — manual review (rc.supervisor.review) state lifecycle.
 *
 * A manual review runs grounding on ad-hoc inline text. It must use EPHEMERAL
 * state — never entered into the session map — so repeated/concurrent manual
 * reviews do not accumulate active sessions and cannot disturb real sessions.
 * With grounding networkPolicy 'off' it returns unverifiable (local-only).
 */

import { describe, expect, it } from 'vitest';
import { loadPluginFresh, type Harness } from './harness/plugin-harness.js';

const CONFIG = {
  enabled: true,
  supervisorModel: 'testprov/testmodel',
  reviewMode: 'correct',
  grounding: { networkPolicy: 'off', verdictMode: 'flag' },
};

async function activeSessions(h: Harness): Promise<number> {
  const s = (await h.rpc.get('rc.supervisor.status')!({})) as { activeSessions: number };
  return s.activeSessions;
}
async function review(h: Harness, inlineText: string) {
  const fn = h.rpc.get('rc.supervisor.review');
  expect(fn).toBeDefined();
  return (await fn!({ target: { inlineText } })) as { ok: boolean; reviewId?: string; findings?: unknown[]; error?: string };
}

describe('P2-C manual review ephemeral state', () => {
  it('runs grounding, returns findings, and does NOT grow active sessions', async () => {
    const h = await loadPluginFresh(CONFIG);
    const before = await activeSessions(h);
    const res = await review(h, 'builds on 10.1038/nature14539 and arXiv:1706.03762');
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.findings)).toBe(true);
    expect(res.findings!.length).toBeGreaterThan(0);
    expect(await activeSessions(h)).toBe(before); // ephemeral — no permanent session
  });

  it('off policy → findings are unverifiable/local-only (not not_found)', async () => {
    const h = await loadPluginFresh(CONFIG);
    const res = await review(h, 'cite 10.9999/definitely-fake-doi');
    expect(res.ok).toBe(true);
    expect((res.findings as Array<{ verdict: string }>).every((f) => f.verdict === 'unverifiable')).toBe(true);
  });

  it('many manual reviews do not accumulate sessions', async () => {
    const h = await loadPluginFresh(CONFIG);
    for (let i = 0; i < 6; i++) await review(h, `ref 10.1/x${i}`);
    expect(await activeSessions(h)).toBe(0);
  });

  it('concurrent manual reviews do not collide or grow sessions', async () => {
    const h = await loadPluginFresh(CONFIG);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => review(h, `ref 10.1/c${i}`)));
    const ids = results.map((r) => r.reviewId);
    expect(new Set(ids).size).toBe(ids.length); // unique, non-colliding ids
    expect(await activeSessions(h)).toBe(0);
  });

  it('rejects unsupported target explicitly (never a silent no-op)', async () => {
    const h = await loadPluginFresh(CONFIG);
    const fn = h.rpc.get('rc.supervisor.review')!;
    const res = (await fn({ target: { workspacePath: '/x/y' } })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsupported target/i);
  });

  it('does not delete or alter a real tracked session', async () => {
    const h = await loadPluginFresh(CONFIG);
    // Create a real session via llm_output (summary extractor tracks it).
    await h.fire(
      'llm_output',
      { runId: 'r', sessionId: 'skReal', provider: 'p', model: 'm', assistantTexts: ['hello'], lastAssistant: { role: 'assistant', content: 'hello' } },
      { sessionKey: 'skReal', sessionId: 'skReal' },
    );
    const withReal = await activeSessions(h);
    expect(withReal).toBeGreaterThanOrEqual(1);
    await review(h, 'ref 10.1/z');
    expect(await activeSessions(h)).toBe(withReal); // real session untouched, no new session
  });
});
