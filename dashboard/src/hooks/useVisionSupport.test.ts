/**
 * useVisionSupport — reactivity unit test (P1-V3, SPEC:376).
 *
 * Proves the hook recomputes resolveVisionSupport() when its reactive store
 * inputs change (async catalog arrival, /model session override), unlike the
 * old empty-dependency useMemo that froze the verdict at first render.
 *
 * Drives REAL stores (no vision-capability mock) — the same contract CameraDetail
 * relies on. Catalog entry shape: oc-catalog-align.ts:26-33. Session row shape:
 * OC session-utils.ts:2186-2187 (runtime-merged modelProvider/model).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisionSupport } from './useVisionSupport';
import { useSessionsStore } from '../stores/sessions';
import { useModelCatalogStore } from '../stores/model-catalog';
import { useConfigStore } from '../stores/config';

const VISION_ENTRY = { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', provider: 'zai', input: ['text', 'image'] };
const TEXTONLY_ENTRY = { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', input: ['text'] };

beforeEach(() => {
  useSessionsStore.setState({ sessions: [{ key: 'main', label: 'Main' }], activeSessionKey: 'main' } as never);
  useModelCatalogStore.setState({ catalog: null } as never);
  useConfigStore.setState({ gatewayConfig: null } as never);
});

describe('useVisionSupport — reactive resolveVisionSupport wrapper', () => {
  it('recomputes when the catalog arrives asynchronously', () => {
    // Session override to a vision model, catalog cold → unknown/session.
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'zai', model: 'glm-5v-turbo' }],
      activeSessionKey: 'main',
    } as never);

    const { result } = renderHook(() => useVisionSupport());
    expect(result.current.supportsImage).toBe('unknown');
    expect(result.current.source).toBe('session');
    expect(result.current.modelRef).toBe('zai/glm-5v-turbo');

    // Catalog loads → re-render → confirmed vision.
    act(() => {
      useModelCatalogStore.setState({ catalog: [VISION_ENTRY] as never });
    });
    expect(result.current.supportsImage).toBe(true);
    expect(result.current.source).toBe('session');
  });

  it('recomputes when the active session /model override changes', () => {
    useConfigStore.setState({
      gatewayConfig: { agents: { defaults: { model: { primary: 'zai/glm-5v-turbo' } } } } as never,
    });
    useModelCatalogStore.setState({ catalog: [VISION_ENTRY, TEXTONLY_ENTRY] as never });

    const { result } = renderHook(() => useVisionSupport());
    // No override yet → judged from config primary (vision).
    expect(result.current.supportsImage).toBe(true);
    expect(result.current.source).toBe('catalog');

    // /model switch to a text-only model → override row updates → false/session.
    act(() => {
      useSessionsStore.setState({
        sessions: [{ key: 'main', label: 'Main', modelProvider: 'deepseek', model: 'deepseek-v4-pro' }],
        activeSessionKey: 'main',
      } as never);
    });
    expect(result.current.supportsImage).toBe(false);
    expect(result.current.source).toBe('session');
    expect(result.current.modelRef).toBe('deepseek/deepseek-v4-pro');
  });
});
