/**
 * useVisionSupport — reactive wrapper over the pure resolveVisionSupport().
 *
 * P1-V3 (SPEC:376): resolveVisionSupport() reads the sessions / model-catalog /
 * config stores via getState() snapshots. Calling it inside an empty-dependency
 * useMemo (CameraDetail's old `useMemo(() => resolveVisionSupport(), [])`) froze
 * the verdict at first render, so it never recomputed when the catalog arrived
 * asynchronously (model-catalog.ts fetch) or after a /model session switch.
 *
 * This hook subscribes — via Zustand selectors — to exactly the reactive inputs
 * resolveVisionSupport() consumes, and memoizes on their VALUES. When any of
 * them changes, React re-renders and the memo re-runs the pure resolver against
 * the fresh store snapshots. The resolver itself stays pure (still consumed by
 * the vision-capability parity tests unchanged).
 */

import { useMemo } from 'react';
import { useSessionsStore } from '../stores/sessions';
import { useModelCatalogStore } from '../stores/model-catalog';
import { useConfigStore } from '../stores/config';
import { resolveVisionSupport, type VisionSupport } from '../utils/vision-capability';
import { normalizeSessionKey } from '../utils/session-key';

export function useVisionSupport(): VisionSupport {
  // Subscribe to the model catalog (arrives asynchronously after models.list).
  const catalog = useModelCatalogStore((s) => s.catalog);
  // Subscribe to the config snapshot used by tiers 2/3.
  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);
  // Subscribe to the active session's key and its runtime-merged model identity
  // (session-utils.ts:2186-2187). A /model override mutates modelProvider/model
  // on the active row, so both must be in the dependency set to trigger a recompute.
  const activeSessionKey = useSessionsStore((s) => s.activeSessionKey);
  const activeSession = useSessionsStore((s) =>
    s.sessions.find(
      (row) => normalizeSessionKey(row.key) === normalizeSessionKey(s.activeSessionKey),
    ),
  );
  const sessionModelProvider = activeSession?.modelProvider ?? null;
  const sessionModel = activeSession?.model ?? null;

  return useMemo(
    () => resolveVisionSupport(),
    // Depend on the resolver's real reactive inputs so a catalog fetch, config
    // load, session switch, or /model override forces a recompute.
    [catalog, gatewayConfig, activeSessionKey, sessionModelProvider, sessionModel],
  );
}
