/**
 * M6 integration — reviews are persisted through the real plugin and recoverable
 * via rc.supervisor.reviews.* with NO broadcast involved (the harness never
 * adopts _broadcast), proving the DB is the truth source. Automatic reviews are
 * keyed by the per-turn runId so concurrent turns stay distinct.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPluginFresh, type Harness } from './harness/plugin-harness.js';

const CONFIG = {
  enabled: true,
  supervisorModel: 'testprov/testmodel',
  reviewMode: 'correct',
  grounding: { networkPolicy: 'identifiers-only', verdictMode: 'flag' },
  providers: { testprov: { api: 'openai-completions', baseUrl: 'http://mock.local/x', apiKey: 'k', models: [{ id: 'testmodel' }] } },
};

const origFetch = globalThis.fetch;
/** OpenAlex DOI resolves 200 → exists; everything else 404. */
function mockRegistries() {
  (globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string) => {
    const ok = String(url).includes('openalex.org/works/doi:');
    return { ok, status: ok ? 200 : 404, json: async () => (ok ? { id: 'W1' } : null) };
  });
}

interface Review { reviewId: string; state: string; verdict: string; runId: string | null; findings: Array<{ raw: string; sources?: Record<string, string> }> }

async function reviewsByRun(h: Harness, runId: string): Promise<Review[]> {
  const r = (await h.rpc.get('rc.supervisor.reviews.list')!({ runId })) as { reviews: Review[] };
  return r.reviews;
}
async function waitForTerminal(h: Harness, runId: string, timeoutMs = 2000): Promise<Review> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [r] = await reviewsByRun(h, runId);
    if (r && r.state !== 'started') return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('review did not reach terminal state in time');
}

describe('M6 review persistence integration', () => {
  afterEach(() => { (globalThis as { fetch: unknown }).fetch = origFetch; vi.restoreAllMocks(); });

  it('manual review is persisted and recoverable via reviews.get (no broadcast)', async () => {
    mockRegistries();
    const h = await loadPluginFresh(CONFIG);
    const res = (await h.rpc.get('rc.supervisor.review')!({ target: { inlineText: 'builds on 10.1038/nature14539' } })) as { reviewId: string };
    const got = (await h.rpc.get('rc.supervisor.reviews.get')!({ reviewId: res.reviewId })) as { review: Review | null };
    expect(got.review).not.toBeNull();
    expect(got.review!.state).toBe('completed');
    expect(got.review!.findings.length).toBeGreaterThan(0);
  });

  it('automatic grounding persists a review keyed by runId, recoverable via reviews.list', async () => {
    mockRegistries();
    const h = await loadPluginFresh(CONFIG);
    await h.fire(
      'llm_output',
      { runId: 'run-1', sessionId: 's1', provider: 'p', model: 'm', assistantTexts: ['our method extends 10.1038/nature14539'], lastAssistant: { role: 'assistant', content: 'x' } },
      { sessionKey: 'agent:main:skA', sessionId: 's1', runId: 'run-1' },
    );
    const r = await waitForTerminal(h, 'run-1');
    expect(r.state).toBe('completed');
    expect(r.verdict).toBe('exists');
    expect(r.runId).toBe('run-1');
    // The PERSISTED finding (produced by the real grounding checker, not hand-built)
    // carries per-registry sources — proving production produces + persists them.
    expect(r.findings[0].sources).toMatchObject({ openalex_doi: 'hit' });
  });

  it('two concurrent turns in one session persist as two distinct reviews', async () => {
    mockRegistries();
    const h = await loadPluginFresh(CONFIG);
    const fireTurn = (runId: string) =>
      h.fire(
        'llm_output',
        { runId, sessionId: 's', provider: 'p', model: 'm', assistantTexts: ['cite 10.1038/nature14539'], lastAssistant: { role: 'assistant', content: 'x' } },
        { sessionKey: 'agent:main:sameSession', sessionId: 's', runId },
      );
    await Promise.all([fireTurn('turn-A'), fireTurn('turn-B')]);
    await waitForTerminal(h, 'turn-A');
    await waitForTerminal(h, 'turn-B');
    const all = (await h.rpc.get('rc.supervisor.reviews.list')!({ sessionKey: 'agent:main:sameSession' })) as { reviews: Review[] };
    const ids = all.reviews.map((r) => r.reviewId);
    expect(new Set(ids).size).toBe(2); // distinct per runId, not merged
  });
});
