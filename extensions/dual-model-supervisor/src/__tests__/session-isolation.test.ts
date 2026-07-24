/**
 * P1-A — cross-session isolation of the channel review footer.
 *
 * Drives the REAL plugin (via plugin-harness) with the true OpenClaw
 * `handler(event, ctx)` contract. The channel footer is produced by `llm_output`
 * and consumed by `message_sending`; the two must correlate by the canonical
 * `ctx.sessionKey` (message_sending's event has NO sessionId). The pre-fix impl
 * registers single-arg handlers, reads `event.message`/`event.sessionId` (absent
 * on the real message_sending event), and falls back to a process-global "last
 * active session" — leaking one session's output to another.
 *
 * Per acceptance: the test asserts POSITIVE delivery (A→A, B→B), so an impl whose
 * footer never works cannot pass vacuously; plus interleave isolation, no-op on
 * missing sessionKey, and consume-once.
 */

import { describe, expect, it } from 'vitest';
import { loadPluginFresh, type Harness } from './harness/plugin-harness.js';

const CONFIG = {
  enabled: true,
  supervisorModel: 'fake/model', // active but no adapter → deterministic fallback footer, no network
  reviewMode: 'correct',
  appendReviewToChannelOutput: true,
};

/** Real llm_output event (carries sessionId + assistant text) + agent ctx (canonical sessionKey). */
function seedEvent(sk: string, text: string) {
  return {
    event: { runId: `run-${sk}`, sessionId: sk, provider: 'p', model: 'm', assistantTexts: [text], lastAssistant: { role: 'assistant', content: text } },
    ctx: { sessionKey: sk, sessionId: sk, runId: `run-${sk}` },
  };
}
/** Real message_sending event {to, content, metadata} + message ctx {channelId, sessionKey}. */
function sendEvent(content: string, channel = 'telegram') {
  return { to: '+15555550100', content, metadata: { channel } };
}
function sendCtx(sk: string | undefined) {
  return { channelId: 'telegram', sessionKey: sk };
}

/** llm_output(text) → wait (state-based) until the async footer is actually cached. */
async function seedSession(h: Harness, sk: string, text: string) {
  const s = seedEvent(sk, text);
  await h.fire('llm_output', s.event, s.ctx);
  await h.waitUntil(() => h.peekFooter(sk) !== undefined);
}

/** Normalize a hook result to the delivered footer text (or a readable marker). */
function contentOf(r: unknown): string {
  const c = (r as { content?: string } | undefined)?.content;
  return typeof c === 'string' ? c : '<no-footer-delivered>';
}

describe('P1-A cross-session footer isolation', () => {
  it('A receives A and B receives B under interleaved sessions (no cross-talk)', async () => {
    const h = await loadPluginFresh(CONFIG);
    await seedSession(h, 'skA', 'RESULT_A');
    await seedSession(h, 'skB', 'RESULT_B'); // makes skB the global "last active" session

    // Deliver to A: must get A's review, never B's.
    const rA = contentOf(await h.fire('message_sending', sendEvent('RESULT_A'), sendCtx('skA')));
    expect(rA).toContain('RESULT_A');
    expect(rA).not.toContain('RESULT_B');

    // Deliver to B: must get B's review.
    const rB = contentOf(await h.fire('message_sending', sendEvent('RESULT_B'), sendCtx('skB')));
    expect(rB).toContain('RESULT_B');
    expect(rB).not.toContain('RESULT_A');
  });

  it('does not consume any session cache when sessionKey is missing (no guessing)', async () => {
    const h = await loadPluginFresh(CONFIG);
    await seedSession(h, 'skA', 'RESULT_A');

    // No resolvable sessionKey → must no-op (return {}), NOT guess the last active session.
    const rNoKey = await h.fire('message_sending', sendEvent('RESULT_A'), sendCtx(undefined));
    expect(rNoKey).toEqual({});

    // A's footer must still be intact (was not consumed by the keyless delivery).
    const rA = contentOf(await h.fire('message_sending', sendEvent('RESULT_A'), sendCtx('skA')));
    expect(rA).toContain('RESULT_A');
  });

  it('consumes each cached footer exactly once (the cache is never re-delivered)', async () => {
    const h = await loadPluginFresh(CONFIG);
    await seedSession(h, 'skA', 'CACHED_A'); // llm_output caches a footer containing CACHED_A

    const first = contentOf(await h.fire('message_sending', sendEvent('CACHED_A'), sendCtx('skA')));
    expect(first).toContain('CACHED_A'); // cached footer delivered once

    // A second delivery for the same session, with different outgoing text, must
    // NOT re-deliver the already-consumed cached footer.
    const second = contentOf(await h.fire('message_sending', sendEvent('A_LATER_MESSAGE'), sendCtx('skA')));
    expect(second).not.toContain('CACHED_A');
  });
});
