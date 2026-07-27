/**
 * Behavioral Parity Tests: resolveVisionSupport() — multi-modal capability judgment
 *
 * Verifies the three-tier decision logic (SPEC §6.3 + Appendix A):
 *   Tier 1 — session override (modelProvider/model) → catalog lookup → source:'session'
 *   Tier 2 — config default model (agents.defaults.model.primary) → catalog → source:'catalog'
 *   Tier 3 — primaryModelSupportsVision() fallback → source:'config'
 *             (false from config is NOT trusted → 'unknown', fail-open per Appendix A)
 *   Tier 4 — no model ref at all → source:'none', supportsImage:'unknown'
 *
 * REAL-LINK DISCIPLINE (audit #11 remediation):
 * The decision SOURCE (sessions store + model-catalog store) is NOT mocked. Both
 * are the real Zustand stores. Tier fixtures are injected via the stores' real
 * setState, and the dedicated "real sessions.list link" suite drives the full
 * chain sessions.list → useSessionsStore.loadSessions() → resolveVisionSupport()
 * over a mocked gateway client, so the sessions.list fixtures are actively
 * consumed (not asserted from behind a mock). Only the gateway transport and the
 * config snapshot (gatewayConfig + primaryModelSupportsVision) are mocked — those
 * are external inputs to the resolver, not the resolver's judgment source.
 *
 * Fixture provenance:
 *   - sessions.list row shape: OC session-utils.ts:2058-2059 (rowModelIdentity)
 *     → :2186-2187 (projected modelProvider/model)
 *   - Catalog entry shape: utils/oc-catalog-align.ts:26-35 (OcModelCatalogEntry)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveVisionSupport } from '../../utils/vision-capability';
import { useSessionsStore } from '../../stores/sessions';
import { useModelCatalogStore } from '../../stores/model-catalog';
import {
  SESSIONS_LIST_MODEL_OVERRIDE_RESPONSE,
  SESSIONS_LIST_VISION_OVERRIDE_RESPONSE,
  MODELS_LIST_CATALOG_RESPONSE,
} from '../../__fixtures__/gateway-payloads/rpc-responses';

// ── Fixtures (anchored to OC source refs) ──────────────────────────────────

/**
 * sessions.list row with a session-level model override.
 * Shape: OC session-utils.ts:2058-2059 → :2186-2187 — after merge, modelProvider/
 * model reflect the runtime-effective values for this session.
 */
const SESSION_ROW_VISION_OVERRIDE = {
  key: 'main',
  label: 'Main',
  modelProvider: 'zai',
  model: 'glm-5v-turbo',  // OC catalog zai/glm-5v-turbo: input:['text','image']
};

const SESSION_ROW_TEXTONLY_OVERRIDE = {
  key: 'main',
  label: 'Main',
  modelProvider: 'zai',
  model: 'glm-5',  // OC catalog zai/glm-5: input:['text'] only
};

/**
 * Catalog entries per OcModelCatalogEntry shape (oc-catalog-align.ts:26-35).
 * Mirrors the real OC 2026.6.1 catalog snapshot.
 */
const CATALOG_ENTRY_VISION = {
  id: 'glm-5v-turbo',
  name: 'GLM-5V Turbo',
  provider: 'zai',
  contextWindow: 202800,
  input: ['text', 'image'],
};

const CATALOG_ENTRY_TEXTONLY = {
  id: 'glm-5',
  name: 'GLM-5',
  provider: 'zai',
  contextWindow: 202800,
  input: ['text'],
};

const CATALOG_ENTRY_ANTHROPIC_VISION = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  provider: 'anthropic',
  contextWindow: 200000,
  input: ['text', 'image'],
};

// ── Config snapshot mock (external input to the resolver) ───────────────────
// gatewayConfig + primaryModelSupportsVision are config-store reads the resolver
// consumes at Tier 2/3. These are NOT the judgment source under test (that is the
// sessions + catalog stores, kept real) — they are inputs, so mocking them keeps
// the tier boundaries exercisable without a live gateway.

const mockConfig = {
  gatewayConfig: null as null | Record<string, unknown>,
};
let mockPrimarySupports = false;

vi.mock('../../stores/config', () => ({
  useConfigStore: {
    getState: () => ({
      gatewayConfig: mockConfig.gatewayConfig,
      // loadSessions()'s computeActiveSessionStale needs a valid reset policy.
      sessionResetPolicy: { mode: 'daily', atHour: 4 },
    }),
  },
  primaryModelSupportsVision: () => mockPrimarySupports,
}));

// ── Gateway transport mock (for the real sessions.list link suite) ──────────
const sessionsListResponse = vi.hoisted(() => ({
  value: null as null | { sessions: unknown[] },
}));
const fetchCatalogSpy = vi.fn().mockResolvedValue(null);

const mockGatewayClient = {
  isConnected: true,
  request: vi.fn((...args: unknown[]) => {
    if (args[0] === 'sessions.list') return Promise.resolve(sessionsListResponse.value);
    return Promise.resolve({});
  }),
};

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: mockGatewayClient, state: 'connected' }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

/** Drive the real sessions store from a sessions.list fixture. */
async function loadRealSessionOverride(fixture: { sessions: unknown[] }) {
  sessionsListResponse.value = fixture;
  await useSessionsStore.getState().loadSessions();
}

// ══════════════════════════════════════════════════════════════════════════
// Test suites
// ══════════════════════════════════════════════════════════════════════════

describe('resolveVisionSupport() — three-tier parity (SPEC §6.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the REAL stores to a "no-info" baseline before each test.
    useSessionsStore.setState({ sessions: [{ key: 'main', label: 'Main' }], activeSessionKey: 'main', loading: false });
    useModelCatalogStore.setState({ catalog: null });
    mockConfig.gatewayConfig = null;
    mockPrimarySupports = false;
    sessionsListResponse.value = null;
    // The real store never triggers a live catalog fetch from resolveVisionSupport;
    // splice the spy over the real fetchCatalog so a lazy fetch would be observable.
    useModelCatalogStore.setState({ fetchCatalog: fetchCatalogSpy });
  });

  // ── Real sessions.list link — proves the fixtures are consumed end-to-end ──
  //
  // This suite injects the runtime-merged sessions.list payload through the REAL
  // useSessionsStore.loadSessions() (over a mocked gateway client), then reads
  // the verdict through the REAL resolver + REAL catalog store. Both catalog
  // states (hot / cold) are covered.

  describe('real sessions.list → loadSessions() → resolveVisionSupport()', () => {
    it('text-only override (deepseek-v4-pro) + catalog HOT → false/session', async () => {
      // Fixture: SESSIONS_LIST_MODEL_OVERRIDE_RESPONSE (session-utils.ts:2186-2187)
      useModelCatalogStore.setState({ catalog: MODELS_LIST_CATALOG_RESPONSE.models });
      await loadRealSessionOverride(SESSIONS_LIST_MODEL_OVERRIDE_RESPONSE);

      const result = resolveVisionSupport();

      expect(result.source).toBe('session');
      expect(result.supportsImage).toBe(false);
      expect(result.modelRef).toBe('deepseek/deepseek-v4-pro');
    });

    it('vision override (glm-5v-turbo) + catalog HOT → true/session', async () => {
      // Fixture: SESSIONS_LIST_VISION_OVERRIDE_RESPONSE — the reverse direction.
      useModelCatalogStore.setState({ catalog: MODELS_LIST_CATALOG_RESPONSE.models });
      await loadRealSessionOverride(SESSIONS_LIST_VISION_OVERRIDE_RESPONSE);

      const result = resolveVisionSupport();

      expect(result.source).toBe('session');
      expect(result.supportsImage).toBe(true);
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });

    it('override present + catalog COLD + no config card → unknown/session (fail-open)', async () => {
      // Catalog store cold (never fetched) and no explicit config card for the
      // session model → Tier 1 fail-open per SPEC §6.3 Appendix A.
      useModelCatalogStore.setState({ catalog: null });
      mockConfig.gatewayConfig = null;
      await loadRealSessionOverride(SESSIONS_LIST_VISION_OVERRIDE_RESPONSE);

      const result = resolveVisionSupport();

      expect(result.source).toBe('session');
      expect(result.supportsImage).toBe('unknown');
      // modelRef stays the SESSION model, never a config substitute.
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });
  });

  // ── Tier 1: session override → catalog hit ─────────────────────────────

  describe('Tier 1 — session model override + catalog lookup → source: session', () => {
    it('vision model in session override + catalog hit → true/session', () => {
      // Fixture: OC session-utils.ts:2186-2187 — runtime modelProvider/model
      useSessionsStore.setState({ sessions: [SESSION_ROW_VISION_OVERRIDE], activeSessionKey: 'main' });
      // Catalog populated (oc-catalog-align.ts:26-35 shape)
      useModelCatalogStore.setState({ catalog: [CATALOG_ENTRY_TEXTONLY, CATALOG_ENTRY_VISION] });

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(true);
      expect(result.source).toBe('session');
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });

    it('text-only model in session override + catalog hit → false/session', () => {
      useSessionsStore.setState({ sessions: [SESSION_ROW_TEXTONLY_OVERRIDE], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: [CATALOG_ENTRY_TEXTONLY, CATALOG_ENTRY_VISION] });

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(false);
      expect(result.source).toBe('session');
      expect(result.modelRef).toBe('zai/glm-5');
    });

    it('session override present + catalog null → unknown/session/sessionRef (no fall-through)', () => {
      // Fix 1: session row has model fields; catalog not yet loaded.
      // New (correct): returns unknown/session/sessionRef immediately — the session
      // model IS the effective model; we must not substitute the config model's identity.
      useSessionsStore.setState({ sessions: [SESSION_ROW_VISION_OVERRIDE], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: null });
      // Config primary exists but must NOT be consulted when session has model fields
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-6' } } },
      };

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe('unknown');
      expect(result.source).toBe('session');
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });

    it('session override present, catalog empty array → unknown/session/sessionRef (no fall-through)', () => {
      // Empty catalog → treat as not-loaded, return unknown/session/sessionRef.
      useSessionsStore.setState({ sessions: [SESSION_ROW_VISION_OVERRIDE], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: [] });

      const result = resolveVisionSupport();

      expect(result.source).toBe('session');
      expect(result.supportsImage).toBe('unknown');
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });

    // ── T19 P5: session override + catalog cold → explicit config card ────

    it('session override + catalog empty + config explicit image → true/config (kimi fix)', () => {
      // Real bug: moonshot-cn/kimi-k3 input=['text','image'] in models.json, but
      // the dashboard model-catalog store was never fetched → cache empty. Now the
      // explicit config card is trusted.
      const KIMI_SESSION = { key: 'main', label: 'Main', modelProvider: 'moonshot-cn', model: 'kimi-k3' };
      useSessionsStore.setState({ sessions: [KIMI_SESSION], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: [] });
      mockConfig.gatewayConfig = {
        models: {
          providers: {
            'moonshot-cn': {
              models: [{ id: 'kimi-k3', input: ['text', 'image'] }],
            },
          },
        },
      };

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(true);
      expect(result.source).toBe('config');
      // modelRef must stay the SESSION model, not config primary.
      expect(result.modelRef).toBe('moonshot-cn/kimi-k3');
    });

    it('session override + catalog null + config explicit text-only → false/config', () => {
      // Explicit config card declares input=['text'] only → confirmed text-only.
      const GLM5_SESSION = { key: 'main', label: 'Main', modelProvider: 'zai', model: 'glm-5' };
      useSessionsStore.setState({ sessions: [GLM5_SESSION], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: null });
      mockConfig.gatewayConfig = {
        models: {
          providers: {
            zai: {
              models: [{ id: 'glm-5', input: ['text'] }],
            },
          },
        },
      };

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(false);
      expect(result.source).toBe('config');
      expect(result.modelRef).toBe('zai/glm-5');
    });

    it('session override + catalog cold + no explicit config card → unknown/session', () => {
      // Neither catalog nor an explicit config card covers the session model →
      // fail-open to unknown/session/sessionRef.
      useSessionsStore.setState({ sessions: [SESSION_ROW_VISION_OVERRIDE], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: null });
      mockConfig.gatewayConfig = {
        models: { providers: { zai: { models: [{ id: 'some-other-model', input: ['text', 'image'] }] } } },
      };

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe('unknown');
      expect(result.source).toBe('session');
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });

    it('no session override (modelProvider/model absent) → skips tier 1', () => {
      useSessionsStore.setState({ sessions: [{ key: 'main', label: 'Main' }], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: [CATALOG_ENTRY_VISION] });
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'zai/glm-5v-turbo' } } },
      };

      const result = resolveVisionSupport();

      expect(result.source).toBe('catalog');
      expect(result.supportsImage).toBe(true);
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });
  });

  // ── Tier 2: config default model → catalog lookup ──────────────────────

  describe('Tier 2 — config primary model + catalog lookup → source: catalog', () => {
    it('exact catalog hit (provider+id match) → true/catalog for vision model', () => {
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-6' } } },
      };
      useModelCatalogStore.setState({ catalog: [CATALOG_ENTRY_ANTHROPIC_VISION] });

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(true);
      expect(result.source).toBe('catalog');
      expect(result.modelRef).toBe('anthropic/claude-sonnet-4-6');
    });

    it('exact catalog hit for text-only model → false/catalog', () => {
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'zai/glm-5' } } },
      };
      useModelCatalogStore.setState({ catalog: [CATALOG_ENTRY_TEXTONLY] });

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(false);
      expect(result.source).toBe('catalog');
      expect(result.modelRef).toBe('zai/glm-5');
    });

    it('basename match (provider mismatch but id matches) → resolves correctly', () => {
      // "zai-coding/glm-5v-turbo" — custom provider key but same model id
      // findCatalogEntry falls back to basename match across all providers
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'zai-coding/glm-5v-turbo' } } },
      };
      useModelCatalogStore.setState({ catalog: [CATALOG_ENTRY_TEXTONLY, CATALOG_ENTRY_VISION] });

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(true);
      expect(result.source).toBe('catalog');
      expect(result.modelRef).toBe('zai-coding/glm-5v-turbo');
    });

    it('catalog populated but model not found → falls to tier 3', () => {
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'custom/totally-unknown-model' } } },
      };
      useModelCatalogStore.setState({ catalog: [CATALOG_ENTRY_VISION, CATALOG_ENTRY_TEXTONLY] });
      mockPrimarySupports = true;

      const result = resolveVisionSupport();

      expect(result.source).toBe('config');
      expect(result.supportsImage).toBe(true);
      expect(result.modelRef).toBe('custom/totally-unknown-model');
    });
  });

  // ── Tier 3: config fallback (primaryModelSupportsVision) ──────────────

  describe('Tier 3 — config fallback → source: config (SPEC Appendix A)', () => {
    it('catalog empty + config true → true/config', () => {
      // SPEC: config true is trusted
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'zai/glm-5v-turbo' } } },
      };
      useModelCatalogStore.setState({ catalog: [] });
      mockPrimarySupports = true;

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(true);
      expect(result.source).toBe('config');
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });

    it('catalog empty + config false → unknown/config (fail-open, Appendix A)', () => {
      // SPEC §6.3 Appendix A: config.get snapshot systematically mis-reports
      // text-only for models only in OC catalog. false is NOT trusted → 'unknown'.
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'zai/glm-5' } } },
      };
      useModelCatalogStore.setState({ catalog: [] });
      mockPrimarySupports = false;

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe('unknown');
      expect(result.source).toBe('config');
      expect(result.modelRef).toBe('zai/glm-5');
    });

    it('catalog null + config false → unknown/config (null catalog treated as not-loaded)', () => {
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'zai/glm-5' } } },
      };
      useModelCatalogStore.setState({ catalog: null });
      mockPrimarySupports = false;

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe('unknown');
      expect(result.source).toBe('config');
      expect(result.modelRef).toBe('zai/glm-5');
    });
  });

  // ── Tier 4: no model reference at all ─────────────────────────────────

  describe('Tier 4 — no model ref → source: none', () => {
    it('no session override, no gatewayConfig → unknown/none/null', () => {
      // Complete blank slate
      useSessionsStore.setState({ sessions: [{ key: 'main', label: 'Main' }], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: null });
      mockConfig.gatewayConfig = null;

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe('unknown');
      expect(result.source).toBe('none');
      expect(result.modelRef).toBeNull();
    });

    it('gatewayConfig exists but no agents.defaults.model.primary → unknown/none', () => {
      mockConfig.gatewayConfig = { agents: { defaults: {} } };
      useModelCatalogStore.setState({ catalog: [CATALOG_ENTRY_VISION] });

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe('unknown');
      expect(result.source).toBe('none');
      expect(result.modelRef).toBeNull();
    });
  });

  // ── Fix 3: resolveVisionSupport must never trigger a network fetch ────

  describe('no-fetch contract — pure store read (Fix 3)', () => {
    it('does not call fetchCatalog regardless of catalog state', () => {
      // resolveVisionSupport() is documented as "Pure read from Zustand stores —
      // never triggers a network fetch." fetchCatalog must never be called.
      useSessionsStore.setState({ sessions: [SESSION_ROW_VISION_OVERRIDE], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: null, fetchCatalog: fetchCatalogSpy });

      resolveVisionSupport();

      expect(fetchCatalogSpy).not.toHaveBeenCalled();
    });

    it('does not call fetchCatalog even when catalog is populated', () => {
      useSessionsStore.setState({ sessions: [SESSION_ROW_VISION_OVERRIDE], activeSessionKey: 'main' });
      useModelCatalogStore.setState({ catalog: [CATALOG_ENTRY_VISION], fetchCatalog: fetchCatalogSpy });

      resolveVisionSupport();

      expect(fetchCatalogSpy).not.toHaveBeenCalled();
    });
  });

  // ── Type contract (T14 consumption) ───────────────────────────────────

  describe('return type contract (for T14 consumption)', () => {
    it('always returns an object with supportsImage, source, modelRef', () => {
      const result = resolveVisionSupport();

      expect(result).toHaveProperty('supportsImage');
      expect(result).toHaveProperty('source');
      expect(result).toHaveProperty('modelRef');
    });

    it('supportsImage is boolean or "unknown" (never other strings)', () => {
      const result = resolveVisionSupport();
      expect(
        result.supportsImage === true ||
        result.supportsImage === false ||
        result.supportsImage === 'unknown',
      ).toBe(true);
    });

    it('source is one of session/catalog/config/none', () => {
      const result = resolveVisionSupport();
      expect(['session', 'catalog', 'config', 'none']).toContain(result.source);
    });
  });
});
