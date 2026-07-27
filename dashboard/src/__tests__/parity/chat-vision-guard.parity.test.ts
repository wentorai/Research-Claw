/**
 * Behavioral Parity Tests: Vision-capability send guard (Scenario 3)
 *
 * When a message carries image attachments, the chat store decides how to route
 * them based on the CURRENT-MODEL capability, resolved by the SAME session-aware
 * resolver the CameraDetail hint uses (F5/§13.5: resolveVisionSupport,
 * utils/vision-capability.ts). It is NOT primaryModelSupportsVision() (config
 * primary only), which mis-routed images whenever a session /model override
 * diverged from the config primary.
 *
 *   - supportsImage === false (confirmed text-only current model) → save to
 *     workspace and route file paths for the agent's tools (/image, OCR, code);
 *     inline attachments are stripped. NEVER hard-blocked.
 *   - supportsImage === true / 'unknown' → fail-open: send attachments inline.
 *
 * REAL-LINK PROOF (audit #11 remediation):
 * These are true end-to-end parity tests, NOT mock-first. The resolver is NOT
 * mocked. Each case drives the real chain:
 *
 *   sessions.list payload  →  useSessionsStore.loadSessions()  (real store)
 *                          →  useModelCatalogStore.catalog       (real store)
 *                          →  resolveVisionSupport()             (real 3-tier)
 *                          →  useChatStore.send()  →  chat.send routing
 *
 * The `sessions.list` fixtures (SESSIONS_LIST_MODEL_OVERRIDE_RESPONSE /
 * SESSIONS_LIST_VISION_OVERRIDE_RESPONSE) carry the exact runtime-merged
 * modelProvider/model projection OC emits (session-utils.ts:2058-2059 →
 * :2186-2187), and are ingested through the store's real loadSessions() over a
 * mocked gateway client — so the fixtures are actively consumed, not dead code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chat';
import { useSessionsStore } from '../../stores/sessions';
import { useModelCatalogStore } from '../../stores/model-catalog';
import { CLIENT_ATTACHMENT_PNG } from '../../__fixtures__/gateway-payloads/chat-send';
import {
  SESSIONS_LIST_MODEL_OVERRIDE_RESPONSE,
  SESSIONS_LIST_VISION_OVERRIDE_RESPONSE,
  MODELS_LIST_CATALOG_RESPONSE,
} from '../../__fixtures__/gateway-payloads/rpc-responses';

// ── Gateway client: dispatch by RPC method ──────────────────────────────────
// sessions.list returns the F5 override fixture so loadSessions() ingests the
// real runtime-merged row; every other method (rc.ws.saveImage, chat.send,
// rc.dashboard.setSystemPromptAppend) resolves a generic ack. Per-method
// dispatch (not a blanket mockResolvedValue) keeps the resolver's data source —
// the sessions store — fed by the fixture, closing the real link.
const sessionsListResponse = vi.hoisted(() => ({
  value: null as null | { sessions: unknown[] },
}));

const mockGatewayClient = {
  isConnected: true,
  // Loose param typing keeps `.mock.calls` as unknown[] so tests can index the
  // params tuple (c[0] method, c[1] payload) the way OC's client.request is used.
  request: vi.fn((...args: unknown[]) => {
    const method = args[0];
    if (method === 'sessions.list') return Promise.resolve(sessionsListResponse.value);
    return Promise.resolve({ runId: 'run-1' });
  }),
};

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: mockGatewayClient, state: 'connected' }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// Config store: the resolver's Tier-1 (session override + catalog hit) returns
// before ever reading gatewayConfig, so config here only satisfies the send
// pipeline's systemPromptAppend read and loadSessions()'s freshness policy. The
// config-primary vision flag is deliberately left `false` to prove routing does
// NOT come from primaryModelSupportsVision() — it comes from the session model.
vi.mock('../../stores/config', () => ({
  primaryModelSupportsVision: () => false,
  imageModelSupportsVision: () => false,
  useConfigStore: {
    getState: () => ({
      systemPromptAppend: '',
      gatewayConfig: null,
      // Valid policy so computeActiveSessionStale() inside loadSessions() runs
      // without throwing (session-freshness.ts:94 → evaluateSessionFreshness).
      sessionResetPolicy: { mode: 'daily', atHour: 4 },
    }),
  },
}));

function findCall(method: string) {
  return mockGatewayClient.request.mock.calls.find((c: unknown[]) => c[0] === method);
}

/** Ingest a sessions.list fixture through the REAL store, then the REAL resolver. */
async function loadRealSessionOverride(fixture: { sessions: unknown[] }) {
  sessionsListResponse.value = fixture;
  await useSessionsStore.getState().loadSessions();
}

describe('Vision-capability routing parity — chat.ts send() [real resolver link]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGatewayClient.isConnected = true;
    sessionsListResponse.value = null;
    // Real catalog store: OC models.list projection carrying the authoritative
    // input[] modality lists the resolver reads (Tier-1 catalog hit).
    useModelCatalogStore.setState({ catalog: MODELS_LIST_CATALOG_RESPONSE.models });
    useSessionsStore.setState({ sessions: [], activeSessionKey: 'main', loading: false });
    useChatStore.setState({
      messages: [],
      sending: false,
      streaming: false,
      streamText: null,
      runId: null,
      sessionKey: 'main',
      lastError: null,
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  // ── F5 anchor: session override to text-only + vision-agnostic config ──────
  // Fixture SESSIONS_LIST_MODEL_OVERRIDE_RESPONSE models the exact break: the
  // `main` session was /model-switched to deepseek-v4-pro (input:['text'] in the
  // catalog fixture). Fed through the real store, resolveVisionSupport() returns
  // supportsImage:false (source:'session'), so send MUST degrade to the /image
  // path — the old primaryModelSupportsVision() would have (wrongly) inlined it.
  it('session /model override to a text-only model → routes to /image degradation path (real link)', async () => {
    await loadRealSessionOverride(SESSIONS_LIST_MODEL_OVERRIDE_RESPONSE);

    // Guard: the real resolver actually saw the override row + catalog.
    const row = useSessionsStore.getState().sessions.find((s) => s.key === 'agent:main:main');
    expect(row?.model).toBe('deepseek-v4-pro');

    await useChatStore.getState().send('what is on my desk?', [CLIENT_ATTACHMENT_PNG]);

    // sessions.list was actually consumed to make the routing decision.
    expect(findCall('sessions.list')).toBeDefined();
    expect(findCall('rc.ws.saveImage')).toBeDefined();
    const chatSend = findCall('chat.send');
    expect(chatSend).toBeDefined();
    // Degradation path: inline attachments dropped, workspace marker + path list
    // embedded so the agent reaches the image via its /image tool.
    expect((chatSend![1] as { attachments?: unknown }).attachments).toBeUndefined();
    expect((chatSend![1] as { message: string }).message).toContain('[rc-image:');
    expect(useChatStore.getState().lastError).toBeNull();
  });

  // ── Reverse of the F5 break: override to VISION while config is text-only ──
  // Fixture SESSIONS_LIST_VISION_OVERRIDE_RESPONSE: `main` /model-switched to
  // zai/glm-5v-turbo (input:['text','image']). primaryModelSupportsVision()
  // returns false here, yet the resolver must trust the SESSION model → true, so
  // the image is sent INLINE (no false /image degradation).
  it('session /model override to a vision model while config primary text-only → sends inline, no false degradation (real link)', async () => {
    await loadRealSessionOverride(SESSIONS_LIST_VISION_OVERRIDE_RESPONSE);

    const row = useSessionsStore.getState().sessions.find((s) => s.key === 'agent:main:main');
    expect(row?.model).toBe('glm-5v-turbo');

    await useChatStore.getState().send('what is on my desk?', [CLIENT_ATTACHMENT_PNG]);

    expect(findCall('sessions.list')).toBeDefined();
    expect(findCall('rc.ws.saveImage')).toBeDefined();
    const chatSend = findCall('chat.send');
    expect(chatSend).toBeDefined();
    // Vision current model: attachments kept inline (NOT stripped).
    expect((chatSend![1] as { attachments?: unknown[] }).attachments).toBeDefined();
    expect(((chatSend![1] as { attachments?: unknown[] }).attachments ?? []).length).toBe(1);
    expect(useChatStore.getState().lastError).toBeNull();
  });

  // ── Fail-open: session override present but catalog cold + no config card ──
  // Same text-only-break fixture, but with the catalog store EMPTY (cold cache)
  // and no explicit config card → resolver returns supportsImage:'unknown'
  // (source:'session'). Per SPEC §6.3 Appendix A the send must fail-open and
  // keep the attachment inline — never strip on uncertainty.
  it('session override + catalog cold → unknown → fail-open, sends attachments inline (real link)', async () => {
    useModelCatalogStore.setState({ catalog: null }); // cold cache
    await loadRealSessionOverride(SESSIONS_LIST_MODEL_OVERRIDE_RESPONSE);

    const row = useSessionsStore.getState().sessions.find((s) => s.key === 'agent:main:main');
    expect(row?.model).toBe('deepseek-v4-pro');

    await useChatStore.getState().send('look at this', [CLIENT_ATTACHMENT_PNG]);

    expect(findCall('sessions.list')).toBeDefined();
    expect(findCall('rc.ws.saveImage')).toBeDefined();
    const chatSend = findCall('chat.send');
    expect(chatSend).toBeDefined();
    expect((chatSend![1] as { attachments?: unknown[] }).attachments).toBeDefined();
    expect(useChatStore.getState().lastError).toBeNull();
  });

  // ── No override at all → resolver Tier-2/4, no session model → fail-open ───
  // Baseline sanity: an ordinary session row (no modelProvider/model) with a
  // null config → resolveVisionSupport() reaches Tier 4 (unknown/none). Image is
  // still saved to workspace and sent inline (never stripped, never blocked).
  it('no session override + no config → unknown → sends attachments inline (real link)', async () => {
    await loadRealSessionOverride({
      sessions: [
        {
          key: 'agent:main:main',
          displayName: 'Main',
          updatedAt: 1781104748782,
          sessionId: 'd3f3cd82-c5c1-4d9f-9b89-e163305365ac',
          kind: 'agent',
          // no modelProvider/model → resolver skips Tier 1
        },
      ],
    });

    const row = useSessionsStore.getState().sessions.find((s) => s.key === 'agent:main:main');
    expect(row?.model).toBeUndefined();

    await useChatStore.getState().send('look at this', [CLIENT_ATTACHMENT_PNG]);

    expect(findCall('rc.ws.saveImage')).toBeDefined();
    const chatSend = findCall('chat.send');
    expect(chatSend).toBeDefined();
    expect((chatSend![1] as { attachments?: unknown[] }).attachments).toBeDefined();
    expect(useChatStore.getState().lastError).toBeNull();
  });
});
