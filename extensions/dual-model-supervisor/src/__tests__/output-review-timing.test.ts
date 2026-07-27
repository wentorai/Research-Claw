/**
 * P1-B (reopened → footer architecture removed) — REAL fire-and-forget output-review timing.
 *
 * OC fires `llm_output` fire-and-forget: the outbound message is delivered before the
 * async reviewer completes. So the plugin NEVER modifies/blocks the message and no longer
 * registers `message_sending`. The review result is delivered ONLY via the audit log /
 * Dashboard panel / RPC (the truth source) and is recoverable after the DB is reopened.
 *
 * This replaces the old footer tests, which used `waitUntil(footerCached)` BEFORE the
 * outbound step — artificially eliminating the very race that made channel footers
 * silently lost. Here we drive the true allowed timing: fire, assert nothing blocks /
 * no audit yet, THEN release the reviewer and assert the audit lands + recovers.
 */

import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPluginFresh, type Harness } from './harness/plugin-harness.js';
import { OUTPUT_REVIEW_SYSTEM_PROMPT } from '../core/prompts.js';

const CONFIG = {
  enabled: true,
  supervisorModel: 'testprov/testmodel',
  reviewMode: 'correct',
  courseCorrection: { enabled: false },
  providers: {
    testprov: { api: 'openai-completions', baseUrl: 'http://mock.local/v1/chat/completions', apiKey: 'k', models: [{ id: 'testmodel', maxTokens: 1000 }] },
  },
};

const origFetch = globalThis.fetch;
let releaseReview: (() => void) | null = null;
/** Reviewer fetch is DEFERRED until released — models the real async gap between
 *  fire-and-forget llm_output and the reviewer completing. */
function installDeferredReviewer() {
  releaseReview = null;
  (globalThis as { fetch: unknown }).fetch = vi.fn(
    (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = body.messages?.find((message) => message.role === 'system')?.content;
      const response = (content: Record<string, unknown>) => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(content) } }],
        }),
        text: async () => '',
      });

      // Summary extraction is a separate reviewer call on the same queue. Let it
      // complete immediately so this probe defers exactly the output-review call.
      if (systemPrompt !== OUTPUT_REVIEW_SYSTEM_PROMPT) {
        return Promise.resolve(response({}));
      }

      return new Promise((resolve) => {
        releaseReview = () =>
          resolve(
            response({
              flagged: false,
              hasSuggestion: false,
              warnings: [],
              memoryAlerts: [],
              qualityScore: 0.9,
              deviationScore: 0.1,
            }),
          );
      });
    },
  );
}

function llmOutput(sk: string, text: string) {
  return {
    event: { runId: `run-${sk}`, sessionId: sk, provider: 'p', model: 'm', assistantTexts: [text], lastAssistant: { role: 'assistant', content: text } },
    ctx: { sessionKey: sk, sessionId: sk, runId: `run-${sk}` },
  };
}
interface OutputReviewEntry {
  details?: string;
}
async function deepOutputReviews(h: Harness, sk: string): Promise<OutputReviewEntry[]> {
  const r = (await h.rpc.get('rc.supervisor.log')!({
    sessionId: sk,
    type: 'output_review',
  })) as { entries: OutputReviewEntry[] };
  return r.entries.filter((entry) =>
    /^(Review passed|Deep review degraded|Suggested correction|Flagged)/.test(
      entry.details ?? '',
    ),
  );
}
async function waitForOutputReview(h: Harness, sk: string, timeoutMs = 2000): Promise<unknown[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const e = await deepOutputReviews(h, sk);
    if (e.length > 0) return e;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('output_review audit did not land in time');
}

describe('P1-B output review is fire-and-forget, audit-delivered (no footer)', () => {
  beforeEach(() => installDeferredReviewer());
  afterEach(() => {
    releaseReview?.();
    (globalThis as { fetch: unknown }).fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('does NOT register the message_sending hook (no outbound modification path exists)', async () => {
    const h = await loadPluginFresh(CONFIG);
    expect(h.hookNames()).not.toContain('message_sending');
  });

  it('llm_output returns immediately (never blocks on the reviewer); no late footer, and the audit lands only after the review completes', async () => {
    const h = await loadPluginFresh(CONFIG);
    const sk = 'agent:main:skT';
    const s = llmOutput(sk, 'ANSWER_TEXT');

    // Fire llm_output while the reviewer fetch is DEFERRED. It must return promptly.
    const raced = await Promise.race([
      h.fire('llm_output', s.event, s.ctx).then(() => 'RETURNED'),
      new Promise((r) => setTimeout(() => r('BLOCKED'), 250)),
    ]);
    expect(raced).toBe('RETURNED'); // never blocks on the reviewer
    await h.waitUntil(() => releaseReview !== null);

    // The review is still pending → no output_review audit yet, and there is no
    // outbound-modification path to produce a late footer.
    expect(await deepOutputReviews(h, sk)).toHaveLength(0);

    // Release the reviewer; the review result is now delivered via the audit path.
    releaseReview!();
    const entries = await waitForOutputReview(h, sk);
    expect(entries.length).toBeGreaterThan(0); // queryable via rc.supervisor.log
  });

  it('the review audit is recoverable via RPC after the DB is reopened', async () => {
    const dbPath = path.join(os.tmpdir(), `rc-sup-timing-${process.pid}-${Math.round(performance.now())}.db`);
    const sk = 'agent:main:skR';
    const h1 = await loadPluginFresh({ ...CONFIG, dbPath });
    const s = llmOutput(sk, 'ANSWER_TEXT');
    await h1.fire('llm_output', s.event, s.ctx);
    await h1.waitUntil(() => releaseReview !== null);
    releaseReview!();
    await waitForOutputReview(h1, sk);

    // Reopen the plugin on the SAME db (simulate a restart) and re-query.
    const h2 = await loadPluginFresh({ ...CONFIG, dbPath });
    const recovered = await deepOutputReviews(h2, sk);
    expect(recovered.length).toBeGreaterThan(0); // persisted in SQLite, recovered after reopen
  });
});
