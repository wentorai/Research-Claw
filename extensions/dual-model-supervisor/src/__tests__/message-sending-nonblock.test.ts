/**
 * P1-B — message_sending must NEVER synchronously wait for the reviewer.
 *
 * The channel footer is produced asynchronously by `llm_output` and cached on the
 * session. When `message_sending` fires with NO cached footer, it must best-effort
 * pass the message through immediately — it must NOT run a live reviewer on the
 * delivery path (that blocks outbound delivery on reviewer/network latency and
 * violates the never-block invariant), and must NOT create a permanent session
 * just to review.
 *
 * RED harness: a reviewer whose fetch HANGS (controllable deferred). If
 * message_sending calls the live reviewer, it blocks; a causal counter proves it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPluginFresh } from './harness/plugin-harness.js';

// Real provider so the reviewer actually resolves an adapter and calls fetch.
const CONFIG = {
  enabled: true,
  supervisorModel: 'testprov/testmodel',
  reviewMode: 'correct',
  appendReviewToChannelOutput: true,
  providers: {
    testprov: {
      api: 'openai-completions',
      baseUrl: 'http://mock.local/v1/chat/completions',
      apiKey: 'k',
      models: [{ id: 'testmodel', maxTokens: 1000 }],
    },
  },
};

function sendEvent(content: string) {
  return { to: '+15555550100', content, metadata: { channel: 'telegram' } };
}
function sendCtx(sk: string) {
  return { channelId: 'telegram', sessionKey: sk };
}

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
        release.push(() =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: '{}' } }] }),
            text: async () => '',
          }),
        );
      }),
  );
}

describe('P1-B message_sending never blocks on the reviewer', () => {
  beforeEach(() => installHangingFetch());
  afterEach(() => {
    release.forEach((r) => r()); // unblock any hung reviewer so nothing leaks
    release = [];
    (globalThis as { fetch: unknown }).fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('returns promptly and does NOT call the live reviewer when there is no cached footer', async () => {
    const h = await loadPluginFresh(CONFIG);
    const msgP = h.fire('message_sending', sendEvent('hello world'), sendCtx('agent:main:skA'));
    const raced = await Promise.race([
      msgP.then(() => 'RESOLVED'),
      new Promise((r) => setTimeout(() => r('BLOCKED'), 250)),
    ]);
    expect(raced).toBe('RESOLVED'); // must not block on the hanging reviewer
    expect(fetchCalls).toBe(0); // stronger: must not even call the live reviewer on the delivery path
  });

  it('does NOT create a permanent session on the no-cache delivery path', async () => {
    const h = await loadPluginFresh(CONFIG);
    await Promise.race([
      h.fire('message_sending', sendEvent('hi'), sendCtx('agent:main:skB')),
      new Promise((r) => setTimeout(r, 250)),
    ]);
    const status = (await h.rpc.get('rc.supervisor.status')!({})) as { activeSessions: number };
    expect(status.activeSessions).toBe(0);
  });
});
