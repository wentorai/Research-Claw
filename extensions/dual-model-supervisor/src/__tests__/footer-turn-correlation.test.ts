/**
 * P1-B (reopened) — channel review footer must correlate to the TURN that
 * produced it, and channel detection must read the OpenClaw ctx (ctx.channelId),
 * not the event.
 *
 * Two independently-confirmed defects this guards against:
 *  - H1-a: OC's `buildMessageSendingBeforeDeliver` fires message_sending with the
 *    event = { to, content } (NO metadata) and the channel ONLY in the 2nd ctx arg
 *    (`ctx.channelId`). The pre-fix impl inspected the EVENT only, so on that real
 *    path it judged "not a channel", cleared the cached footer, and dropped it.
 *  - H1-b: the single-slot, session-keyed footer cache had NO turn identity. Because
 *    OC fires llm_output fire-and-forget, turn 1's late async review could cache its
 *    FULL message into the shared slot, and turn 2's message_sending would then
 *    deliver turn 1's answer in place of turn 2's content (cross-turn REPLACEMENT).
 *
 * The fix correlates each cached footer to the exact content it was computed from
 * (content hash) + a monotonic turnSeq, and WITHHOLDS (never misdelivers) on
 * mismatch. Detection uses ctx.channelId.
 */

import { describe, expect, it } from 'vitest';
import { loadPluginFresh, type Harness } from './harness/plugin-harness.js';

const CONFIG = {
  enabled: true,
  supervisorModel: 'fake/model', // active but no adapter → deterministic fallback footer, no network
  reviewMode: 'correct',
  appendReviewToChannelOutput: true,
};

function seedEvent(sk: string, text: string) {
  return {
    event: { runId: `run-${sk}`, sessionId: sk, provider: 'p', model: 'm', assistantTexts: [text], lastAssistant: { role: 'assistant', content: text } },
    ctx: { sessionKey: sk, sessionId: sk, runId: `run-${sk}` },
  };
}
async function seedSession(h: Harness, sk: string, text: string) {
  const s = seedEvent(sk, text);
  await h.fire('llm_output', s.event, s.ctx);
  await h.waitUntil(() => h.peekFooter(sk) !== undefined);
}
function contentOf(r: unknown): string {
  const c = (r as { content?: string } | undefined)?.content;
  return typeof c === 'string' ? c : '<no-footer-delivered>';
}

describe('P1-B footer↔turn correlation', () => {
  it('a later turn is NEVER given an earlier turn\'s cached footer (no cross-turn replacement)', async () => {
    const h = await loadPluginFresh(CONFIG);
    // Turn 1 produced a footer computed from 'TURN_ONE_ANSWER' and cached it.
    await seedSession(h, 'skX', 'TURN_ONE_ANSWER');
    // Turn 2 delivers DIFFERENT content. The pre-fix impl replaced it with turn 1's
    // cached footer (which embeds 'TURN_ONE_ANSWER'); the fix must withhold.
    const t2 = contentOf(await h.fire('message_sending', { to: 'chat1', content: 'TURN_TWO_ANSWER', metadata: { channel: 'telegram' } }, { channelId: 'telegram', sessionKey: 'skX' }));
    expect(t2).not.toContain('TURN_ONE_ANSWER'); // must not deliver turn 1's answer onto turn 2
  });

  it('delivers the footer on the no-metadata outbound path (channel only in ctx.channelId)', async () => {
    const h = await loadPluginFresh(CONFIG);
    await seedSession(h, 'skX', 'HELLO_WORLD');
    // OC buildMessageSendingBeforeDeliver shape: event has NO metadata; channel is in ctx.channelId.
    const r = contentOf(await h.fire('message_sending', { to: 'chat1', content: 'HELLO_WORLD' }, { channelId: 'telegram', sessionKey: 'skX' }));
    expect(r).toContain('HELLO_WORLD'); // footer for this turn's content must be delivered
  });

  it('withholds (and keeps cached) the footer for dashboard delivery (ctx.channelId=dashboard)', async () => {
    const h = await loadPluginFresh(CONFIG);
    await seedSession(h, 'skX', 'PANEL_ONLY');
    const r = await h.fire('message_sending', { to: 'x', content: 'PANEL_ONLY' }, { channelId: 'dashboard', sessionKey: 'skX' });
    expect(r).toEqual({}); // dashboard delivery does not carry the footer
    expect(h.peekFooter('skX')).toBeDefined(); // footer stays cached for the panel/audit path
  });

  it('the matching turn\'s content still receives its own footer (positive delivery preserved)', async () => {
    const h = await loadPluginFresh(CONFIG);
    await seedSession(h, 'skX', 'MATCHING_TURN');
    const r = contentOf(await h.fire('message_sending', { to: 'chat1', content: 'MATCHING_TURN' }, { channelId: 'telegram', sessionKey: 'skX' }));
    expect(r).toContain('MATCHING_TURN');
  });
});
