/**
 * P1-B (reopened) — before_tool_call must NEVER over-block on the deep reviewer.
 *
 * The security gate (deep model review of high-risk tools) is KEPT: a tool the
 * deep review flags as dangerous can still be blocked. But a high-risk-but-not-
 * determined-danger tool (e.g. `exec ls -la`, which the deterministic quick-check
 * passes) must NOT stall tool execution on a slow/queued 30s reviewer round-trip.
 * The deep review runs with a SHORT gate timeout (fail-open) and bypasses the
 * shared reviewer queue, so the tool proceeds promptly when the reviewer is slow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPluginFresh } from './harness/plugin-harness.js';

const CONFIG = {
  enabled: true,
  supervisorModel: 'testprov/testmodel',
  reviewMode: 'correct',
  // The floor of the supported range — the shortest gate a real deployment can be set to,
  // so the test runs against a value the parser will not silently substitute. It used to
  // say 150 "for a fast test", which parseConfig now clamps to 500: the number in the
  // fixture was no longer the number under test, and the race margins below were being
  // measured against a gate a third of its real length.
  toolReviewGateMs: 500,
  providers: {
    testprov: { api: 'openai-completions', baseUrl: 'http://mock.local/v1/chat/completions', apiKey: 'k', models: [{ id: 'testmodel', maxTokens: 1000 }] },
  },
};

const origFetch = globalThis.fetch;
let fetchCalls = 0;
let release: Array<() => void> = [];

function installHangingFetch() {
  fetchCalls = 0;
  release = [];
  (globalThis as { fetch: unknown }).fetch = vi.fn(
    () =>
      new Promise((resolve) => {
        fetchCalls++;
        release.push(() => resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }), text: async () => '' }));
      }),
  );
}

describe('P1-B before_tool_call never over-blocks on the reviewer', () => {
  beforeEach(() => installHangingFetch());
  afterEach(() => {
    release.forEach((r) => r());
    release = [];
    (globalThis as { fetch: unknown }).fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('a benign high-risk tool (exec ls -la) fails OPEN within the gate when the reviewer hangs', async () => {
    const h = await loadPluginFresh(CONFIG);
    const hookP = h.fire('before_tool_call', { toolName: 'exec', params: { command: 'ls -la' } }, { sessionKey: 'agent:main:skA' });
    const raced = (await Promise.race([
      hookP.then((r) => ({ tag: 'RESOLVED', r })),
      // 4× the gate: enough headroom that a slow machine cannot fail this, while still far
      // below the reviewer round-trip it is guarding against (the stub fetch never resolves).
      new Promise((res) => setTimeout(() => res({ tag: 'BLOCKED' }), 2000)),
    ])) as { tag: string; r?: unknown };
    expect(raced.tag).toBe('RESOLVED'); // must not hang on the 30s reviewer round-trip
    expect(raced.r).toEqual({}); // fail-open: tool allowed (no block)
    expect(fetchCalls).toBeGreaterThanOrEqual(1); // the deep review WAS attempted — the gate bounds it, does not skip it
  });

  it('the tool gate BYPASSES the shared reviewer queue (deep review runs even when the queue is busy)', async () => {
    const h = await loadPluginFresh(CONFIG);
    // Occupy the shared reviewer queue with a hanging (non-bypass) review.
    void h.fire(
      'llm_output',
      { runId: 'r1', sessionId: 's', provider: 'p', model: 'm', assistantTexts: ['some analysis output'], lastAssistant: { role: 'assistant', content: 'x' } },
      { sessionKey: 'agent:main:skQ', sessionId: 's', runId: 'r1' },
    );
    await h.waitUntil(() => fetchCalls >= 1); // a queued review is now in-flight (hanging), holding the queue
    const before = fetchCalls;
    // The tool gate must NOT queue behind the occupied queue — its deep review runs now.
    const hookP = h.fire('before_tool_call', { toolName: 'exec', params: { command: 'ls -la' } }, { sessionKey: 'agent:main:skQ' });
    await Promise.race([hookP, new Promise((r) => setTimeout(r, 600))]);
    expect(fetchCalls).toBeGreaterThan(before); // tool review fetch was issued despite the busy queue (bypassed)
  });

  it('still BLOCKS a tool the deep review flags as dangerous (security gate preserved)', async () => {
    // Reviewer responds immediately with a block verdict.
    (globalThis as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ blocked: true, blockReason: 'model flagged danger' }) } }] }),
      text: async () => '',
    }));
    const h = await loadPluginFresh(CONFIG);
    const r = (await h.fire('before_tool_call', { toolName: 'exec', params: { command: 'echo hello' } }, { sessionKey: 'agent:main:skB' })) as { block?: boolean };
    expect(r.block).toBe(true); // deep-review-confirmed danger is still gated
  });
});
