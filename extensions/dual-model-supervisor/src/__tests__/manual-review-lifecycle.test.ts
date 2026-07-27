/**
 * P2-C — manual review (rc.supervisor.review) state lifecycle.
 *
 * A manual review runs grounding on ad-hoc inline text. It must use EPHEMERAL
 * state — never entered into the session map — so repeated/concurrent manual
 * reviews do not accumulate active sessions and cannot disturb real sessions.
 * With grounding networkPolicy 'off' it returns unverifiable (local-only).
 */

import os from 'node:os';
import path from 'node:path';
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

  // H4-a: restart-stable identity — a new boot on the SAME db must not reuse a prior
  // boot's manual id (which would collide with the persisted record and shadow it).
  it('manual reviewId is restart-stable across boots on the same DB (no cross-boot collision)', async () => {
    const dbPath = path.join(os.tmpdir(), `rc-sup-restart-${process.pid}-${Math.round(performance.now())}.db`);
    const h1 = await loadPluginFresh({ ...CONFIG, dbPath });
    const r1 = await review(h1, 'ref 10.1/x');
    const h2 = await loadPluginFresh({ ...CONFIG, dbPath }); // simulate a process restart on the same DB
    const r2 = await review(h2, 'ref 10.1/y');
    expect(r1.reviewId).not.toBe(r2.reviewId); // epoch namespaced → distinct
    // boot-2's review is recoverable (not shadowed by boot-1's manual:e1:1)
    const got = (await h2.rpc.get('rc.supervisor.reviews.get')!({ reviewId: r2.reviewId })) as { review: unknown };
    expect(got.review).not.toBeNull();
  });

  // H4-e: DB-unavailable is surfaced, not a silent ok.
  it('manual review with an unwritable DB returns persisted:false + dbUnavailable, and is not recoverable', async () => {
    const h = await loadPluginFresh({ ...CONFIG, dbPath: '/dev/null/nope/supervisor.db' }); // mkdirSync fails → _db=null
    const res = (await review(h, 'ref 10.1/x')) as { ok: boolean; persisted?: boolean; dbUnavailable?: boolean; reviewId?: string };
    expect(res.ok).toBe(true); // the check still ran (findings inline)
    expect(res.persisted).toBe(false); // honest: nothing durable
    expect(res.dbUnavailable).toBe(true);
    const got = (await h.rpc.get('rc.supervisor.reviews.get')!({ reviewId: res.reviewId! })) as { review: unknown };
    expect(got.review).toBeNull(); // consistent with persisted:false
    const s = (await h.rpc.get('rc.supervisor.status')!({})) as { reviewStoreAvailable?: boolean };
    expect(s.reviewStoreAvailable).toBe(false);
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
