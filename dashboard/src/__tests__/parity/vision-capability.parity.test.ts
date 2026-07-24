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
 * Fixture provenance:
 *   - Sessions.list row shape: OC session-utils.ts:2186-2187 (runtime-merged fields)
 *   - Catalog entry shape: utils/oc-catalog-align.ts:26-33 (OcModelCatalogEntry)
 *
 * Store injection: vi.fn() / setState mocks — no gateway RPC calls made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveVisionSupport } from '../../utils/vision-capability';

// ── Fixtures (anchored to OC source refs) ──────────────────────────────────

/**
 * sessions.list row with a session-level model override.
 * Shape: OC session-utils.ts:2186-2187 — after merge, modelProvider/model
 * reflect the runtime-effective values for this session.
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
 * Catalog entries per OcModelCatalogEntry shape (oc-catalog-align.ts:26-33).
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

// ── Mock store state containers (mutated per test) ──────────────────────────

const mockSessions = {
  sessions: [{ key: 'main', label: 'Main' }],  // default: no model override
  activeSessionKey: 'main',
};

const mockCatalog = {
  catalog: null as null | typeof CATALOG_ENTRY_VISION[],
};

const mockConfig = {
  gatewayConfig: null as null | Record<string, unknown>,
};

// primaryModelSupportsVision() return value
let mockPrimarySupports = false;

// fetchCatalog spy (Fix 3: resolveVisionSupport must never trigger a fetch)
const fetchCatalogSpy = vi.fn().mockResolvedValue(null);

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../../stores/sessions', () => ({
  useSessionsStore: {
    getState: () => mockSessions,
  },
}));

vi.mock('../../stores/model-catalog', () => ({
  useModelCatalogStore: {
    getState: () => ({
      ...mockCatalog,
      fetchCatalog: fetchCatalogSpy,
    }),
  },
}));

vi.mock('../../stores/config', () => ({
  useConfigStore: {
    getState: () => ({ gatewayConfig: mockConfig.gatewayConfig }),
  },
  primaryModelSupportsVision: () => mockPrimarySupports,
}));

// ══════════════════════════════════════════════════════════════════════════
// Test suites
// ══════════════════════════════════════════════════════════════════════════

describe('resolveVisionSupport() — three-tier parity (SPEC §6.3)', () => {
  beforeEach(() => {
    // Reset to a "no-info" baseline before each test
    mockSessions.sessions = [{ key: 'main', label: 'Main' }];
    mockSessions.activeSessionKey = 'main';
    mockCatalog.catalog = null;
    mockConfig.gatewayConfig = null;
    mockPrimarySupports = false;
    fetchCatalogSpy.mockClear();
  });

  // ── Tier 1: session override → catalog hit ─────────────────────────────

  describe('Tier 1 — session model override + catalog lookup → source: session', () => {
    it('vision model in session override + catalog hit → true/session', () => {
      // Fixture: OC session-utils.ts:2186-2187 — runtime modelProvider/model
      mockSessions.sessions = [SESSION_ROW_VISION_OVERRIDE];
      mockSessions.activeSessionKey = 'main';
      // Catalog populated (oc-catalog-align.ts:26-33 shape)
      mockCatalog.catalog = [CATALOG_ENTRY_TEXTONLY, CATALOG_ENTRY_VISION];

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(true);
      expect(result.source).toBe('session');
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });

    it('text-only model in session override + catalog hit → false/session', () => {
      // Fixture: session has model that is text-only per catalog
      mockSessions.sessions = [SESSION_ROW_TEXTONLY_OVERRIDE];
      mockSessions.activeSessionKey = 'main';
      mockCatalog.catalog = [CATALOG_ENTRY_TEXTONLY, CATALOG_ENTRY_VISION];

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(false);
      expect(result.source).toBe('session');
      expect(result.modelRef).toBe('zai/glm-5');
    });

    it('session override present + catalog null → unknown/session/sessionRef (no fall-through)', () => {
      // Fix 1: session row has model fields; catalog not yet loaded.
      // Old (wrong): fell through to config primary model → misrepresented capability + name.
      // New (correct): returns unknown/session/sessionRef immediately — the session model
      // IS the effective model; we must not substitute the config model's identity.
      mockSessions.sessions = [SESSION_ROW_VISION_OVERRIDE];
      mockSessions.activeSessionKey = 'main';
      mockCatalog.catalog = null;  // catalog not loaded
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
      // Fix 4: prior version set catalog=null then immediately overwrote with a value,
      // and expected source:'config', which reflected the old (wrong) fall-through behavior.
      // New (correct): empty catalog → treat as not-loaded, return unknown/session/sessionRef.
      mockSessions.sessions = [SESSION_ROW_VISION_OVERRIDE];
      mockSessions.activeSessionKey = 'main';
      mockCatalog.catalog = [];  // empty → treated as not loaded

      const result = resolveVisionSupport();

      expect(result.source).toBe('session');
      expect(result.supportsImage).toBe('unknown');
      expect(result.modelRef).toBe('zai/glm-5v-turbo');
    });

    it('no session override (modelProvider/model absent) → skips tier 1', () => {
      mockSessions.sessions = [{ key: 'main', label: 'Main' }]; // no model fields
      mockSessions.activeSessionKey = 'main';
      mockCatalog.catalog = [CATALOG_ENTRY_VISION];
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
      mockCatalog.catalog = [CATALOG_ENTRY_ANTHROPIC_VISION];

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(true);
      expect(result.source).toBe('catalog');
      expect(result.modelRef).toBe('anthropic/claude-sonnet-4-6');
    });

    it('exact catalog hit for text-only model → false/catalog', () => {
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'zai/glm-5' } } },
      };
      mockCatalog.catalog = [CATALOG_ENTRY_TEXTONLY];

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
      mockCatalog.catalog = [CATALOG_ENTRY_TEXTONLY, CATALOG_ENTRY_VISION];

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe(true);
      expect(result.source).toBe('catalog');
      expect(result.modelRef).toBe('zai-coding/glm-5v-turbo');
    });

    it('catalog populated but model not found → falls to tier 3', () => {
      mockConfig.gatewayConfig = {
        agents: { defaults: { model: { primary: 'custom/totally-unknown-model' } } },
      };
      mockCatalog.catalog = [CATALOG_ENTRY_VISION, CATALOG_ENTRY_TEXTONLY];
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
      mockCatalog.catalog = [];  // empty → catalog miss
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
      mockCatalog.catalog = [];
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
      mockCatalog.catalog = null;
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
      mockSessions.sessions = [{ key: 'main', label: 'Main' }];
      mockCatalog.catalog = null;
      mockConfig.gatewayConfig = null;

      const result = resolveVisionSupport();

      expect(result.supportsImage).toBe('unknown');
      expect(result.source).toBe('none');
      expect(result.modelRef).toBeNull();
    });

    it('gatewayConfig exists but no agents.defaults.model.primary → unknown/none', () => {
      mockConfig.gatewayConfig = { agents: { defaults: {} } };
      mockCatalog.catalog = [CATALOG_ENTRY_VISION];

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
      mockSessions.sessions = [SESSION_ROW_VISION_OVERRIDE];
      mockSessions.activeSessionKey = 'main';
      mockCatalog.catalog = null;  // catalog not loaded → could tempt a lazy fetch

      resolveVisionSupport();

      expect(fetchCatalogSpy).not.toHaveBeenCalled();
    });

    it('does not call fetchCatalog even when catalog is populated', () => {
      mockSessions.sessions = [SESSION_ROW_VISION_OVERRIDE];
      mockSessions.activeSessionKey = 'main';
      mockCatalog.catalog = [CATALOG_ENTRY_VISION];

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
