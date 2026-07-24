/**
 * Multi-modal vision capability resolution.
 *
 * Determines whether the "current model" (the one that will actually process
 * the next chat turn) supports image input, in three-tier priority order:
 *
 *   1. Session-level override  — active session row's modelProvider/model fields
 *      (OC session-utils.ts:2186-2187, runtime-merged values after session patch).
 *      Checked against the model-catalog store cache (no live fetch).
 *
 *   2. Config default model    — agents.defaults.model.primary from gateway config.
 *      Also checked against catalog (exact → basename, via findCatalogEntry).
 *
 *   3. config store fallback   — primaryModelSupportsVision().
 *      NOTE: config.get snapshot systematically mis-reports text-only for models
 *      that are only listed under models.list (not config providers), so a `false`
 *      from this level is NOT trusted — it returns 'unknown' (fail-open, SPEC §6.3
 *      Appendix A). A `true` is still trusted.
 *
 * Consumers (T14): use supportsImage === false to show a "model doesn't support
 * images" hint; 'unknown' → do NOT show the blocking hint (fail-open).
 */

import { useSessionsStore } from '../stores/sessions';
import { useModelCatalogStore } from '../stores/model-catalog';
import { useConfigStore, primaryModelSupportsVision } from '../stores/config';
import { findCatalogEntry } from './oc-catalog-align';
import { normalizeSessionKey } from './session-key';

/** Result of resolveVisionSupport(). */
export type VisionSupport = {
  /**
   * Whether the current model supports inline image input.
   * - true  → confirmed supports image
   * - false → confirmed text-only
   * - 'unknown' → could not determine (fail-open: don't block the user)
   */
  supportsImage: boolean | 'unknown';
  /**
   * Where the decision came from:
   * - 'session'  → from session-level model override + catalog lookup
   * - 'catalog'  → from config default model + catalog lookup
   * - 'config'   → from primaryModelSupportsVision() fallback
   * - 'none'     → no model reference found at all
   */
  source: 'session' | 'catalog' | 'config' | 'none';
  /**
   * The model reference used for the decision, in "provider/modelId" form,
   * or null when no model reference could be constructed.
   */
  modelRef: string | null;
};

/**
 * Resolve vision support for the currently-active model.
 *
 * Pure read from Zustand stores — never triggers a network fetch.
 * Safe to call from any render or event handler.
 */
export function resolveVisionSupport(): VisionSupport {
  // ── Tier 1: session-level model override ──────────────────────────────────
  //
  // The sessions store holds the raw session rows returned by sessions.list.
  // When an active session has a model override (sessions.patch was used to set
  // a per-session model), OC's session-utils.ts:2186-2187 merges the override
  // into the row, so modelProvider/model reflect the effective runtime values.
  //
  // "Current session" = the session whose key matches activeSessionKey, resolved
  // by findSessionRow (normalised key comparison). We replicate the lookup inline
  // to stay dependency-free of internal store helpers.
  const sessState = useSessionsStore.getState();
  const { sessions, activeSessionKey } = sessState;

  // Fix 2: use normalizeSessionKey on both sides for robust key matching
  const activeSession = sessions.find(
    (s) => normalizeSessionKey(s.key) === normalizeSessionKey(activeSessionKey),
  );

  if (activeSession?.modelProvider && activeSession?.model) {
    const sessionProvider = activeSession.modelProvider;
    const sessionModelId = activeSession.model;
    const sessionModelRef = `${sessionProvider}/${sessionModelId}`;

    // Fix 1: session row has model fields → catalog hit → true/false/session.
    // Catalog miss (null, empty, or model not found) → unknown/session/sessionRef.
    // Do NOT fall through to config-model tiers — the session model IS the
    // effective model; using config primary would misrepresent capability AND name.
    const catalog = useModelCatalogStore.getState().catalog;
    if (catalog && catalog.length > 0) {
      const hit = findCatalogEntry(sessionProvider, sessionModelId, catalog);
      if (hit) {
        const supportsImage = hit.entry.input?.includes('image') === true;
        return { supportsImage, source: 'session', modelRef: sessionModelRef };
      }
    }
    // Catalog null/empty/miss → cannot determine; fail-open. Do NOT fall through.
    return { supportsImage: 'unknown', source: 'session', modelRef: sessionModelRef };
  }

  // ── Tier 2: config default model → catalog lookup ─────────────────────────
  //
  // agents.defaults.model.primary is "provider/modelId" (e.g. "zai/glm-5v-plus").
  const cfg = useConfigStore.getState().gatewayConfig;
  const primaryRef = cfg?.agents?.defaults?.model?.primary ?? null;

  if (primaryRef) {
    const slashIdx = primaryRef.indexOf('/');
    if (slashIdx > 0) {
      const cfgProvider = primaryRef.slice(0, slashIdx);
      const cfgModelId = primaryRef.slice(slashIdx + 1);

      const catalog = useModelCatalogStore.getState().catalog;
      if (catalog && catalog.length > 0) {
        const hit = findCatalogEntry(cfgProvider, cfgModelId, catalog);
        if (hit) {
          const supportsImage = hit.entry.input?.includes('image') === true;
          return { supportsImage, source: 'catalog', modelRef: primaryRef };
        }
      }
    }
  }

  // ── Tier 3: primaryModelSupportsVision() config-store fallback ────────────
  //
  // This reads model cards from the gateway config snapshot. Those cards may be
  // missing the 'input' field (or not listed at all) for models that appear only
  // in the OC catalog, causing systematic false negatives. Per SPEC §6.3 Appendix
  // A: a `true` here is trusted; a `false` is NOT (fail-open → 'unknown').
  if (primaryRef) {
    const configSaysVision = primaryModelSupportsVision();
    if (configSaysVision) {
      return { supportsImage: true, source: 'config', modelRef: primaryRef };
    }
    // false is not trusted → 'unknown'
    return { supportsImage: 'unknown', source: 'config', modelRef: primaryRef };
  }

  // ── Tier 4: no model reference at all ─────────────────────────────────────
  return { supportsImage: 'unknown', source: 'none', modelRef: null };
}
