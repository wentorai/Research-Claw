/**
 * Composer "no vision model" hint gating — §13.5 single-source-of-truth (SPEC:417-419).
 *
 * MessageInput's `attachNoVisionModel` hint condition (MessageInput.tsx) is
 *
 *     attachments.length > 0
 *       && Boolean(gatewayConfig)
 *       && vision.supportsImage === false        // useVisionSupport() — session-aware
 *       && !imageModelSupportsVision();           // dedicated /image escape hatch
 *
 * Before the fix it used primaryModelSupportsVision() (config primary ONLY), which
 * diverged from the send pipeline (chat.ts:995 resolveVisionSupport): under a
 * session /model override the composer hint and the actual /image routing forked —
 * exactly the inconsistency §13.5 forbids. This test drives the REAL stores through
 * the SAME reactive hook the composer consumes (useVisionSupport → resolveVisionSupport)
 * plus imageModelSupportsVision, and asserts the derived gate matches the send
 * pipeline's `supportsImage === false` degradation trigger.
 *
 * No vision-capability mock — same contract CameraDetail / chat.ts rely on.
 * Catalog entry shape: oc-catalog-align.ts (id/name/provider/input).
 * Session row shape: OC session-utils.ts:2186-2187 (runtime-merged modelProvider/model).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisionSupport } from '../../hooks/useVisionSupport';
import { imageModelSupportsVision } from '../../stores/config';
import { useSessionsStore } from '../../stores/sessions';
import { useModelCatalogStore } from '../../stores/model-catalog';
import { useConfigStore } from '../../stores/config';

const VISION_ENTRY = { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', provider: 'zai', input: ['text', 'image'] };
const TEXTONLY_ENTRY = { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', input: ['text'] };

/** Replicates MessageInput.tsx's attachNoVisionModel gate (attachments present). */
function composerHintShown(vision: { supportsImage: boolean | 'unknown' }): boolean {
  const gatewayConfig = useConfigStore.getState().gatewayConfig;
  return (
    /* attachments.length > 0 */ true &&
    Boolean(gatewayConfig) &&
    vision.supportsImage === false &&
    !imageModelSupportsVision()
  );
}

beforeEach(() => {
  useSessionsStore.setState({ sessions: [{ key: 'main', label: 'Main' }], activeSessionKey: 'main' } as never);
  useModelCatalogStore.setState({ catalog: null } as never);
  useConfigStore.setState({ gatewayConfig: null } as never);
});

describe('composer no-vision hint — §13.5 shares the session-aware resolver', () => {
  it('F5 anchor: config primary=vision but session /model override=text-only → hint SHOWN (matches chat.ts /image degradation)', () => {
    // Config primary is a vision model; the OLD primaryModelSupportsVision() gate
    // would evaluate true here and HIDE the hint — while chat.ts:995 degrades to
    // /image because the SESSION model is text-only. That fork is the §13.5 bug.
    useConfigStore.setState({
      gatewayConfig: {
        agents: { defaults: { model: { primary: 'zai/glm-5v-turbo' } } },
      } as never,
    });
    useModelCatalogStore.setState({ catalog: [VISION_ENTRY, TEXTONLY_ENTRY] as never });
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'deepseek', model: 'deepseek-v4-pro' }],
      activeSessionKey: 'main',
    } as never);

    const { result } = renderHook(() => useVisionSupport());
    // Session-aware verdict: confirmed text-only from the OVERRIDE model.
    expect(result.current.supportsImage).toBe(false);
    expect(result.current.source).toBe('session');
    expect(result.current.modelRef).toBe('deepseek/deepseek-v4-pro');
    // Composer hint fires — consistent with the send pipeline degrading to /image.
    expect(composerHintShown(result.current)).toBe(true);
  });

  it('reverse: config primary=text-only but session override=vision → hint HIDDEN (model can read the image)', () => {
    useConfigStore.setState({
      gatewayConfig: {
        agents: { defaults: { model: { primary: 'deepseek/deepseek-v4-pro' } } },
      } as never,
    });
    useModelCatalogStore.setState({ catalog: [VISION_ENTRY, TEXTONLY_ENTRY] as never });
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'zai', model: 'glm-5v-turbo' }],
      activeSessionKey: 'main',
    } as never);

    const { result } = renderHook(() => useVisionSupport());
    expect(result.current.supportsImage).toBe(true);
    expect(composerHintShown(result.current)).toBe(false);
  });

  it("unknown verdict (cold catalog, no config card) → hint HIDDEN (fail-open, never blocks on uncertainty)", () => {
    useConfigStore.setState({
      gatewayConfig: {
        agents: { defaults: { model: { primary: 'moonshot-cn/kimi-k3' } } },
      } as never,
    });
    // Catalog cold and no explicit config card for the session model → 'unknown'.
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'moonshot-cn', model: 'kimi-k3' }],
      activeSessionKey: 'main',
    } as never);

    const { result } = renderHook(() => useVisionSupport());
    expect(result.current.supportsImage).toBe('unknown');
    expect(composerHintShown(result.current)).toBe(false);
  });

  it('confirmed text-only BUT a dedicated /image vision model configured → hint HIDDEN (imageModel escape hatch)', () => {
    useConfigStore.setState({
      gatewayConfig: {
        agents: {
          defaults: {
            model: { primary: 'deepseek/deepseek-v4-pro' },
            // A separate vision model wired for the /image tool can still read the
            // image, so the composer must not warn "no vision model".
            imageModel: { primary: 'zai/glm-5v-turbo' },
          },
        },
        models: {
          providers: {
            zai: { models: [{ id: 'glm-5v-turbo', input: ['text', 'image'] }] },
          },
        },
      } as never,
    });
    useModelCatalogStore.setState({ catalog: [TEXTONLY_ENTRY] as never });
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'deepseek', model: 'deepseek-v4-pro' }],
      activeSessionKey: 'main',
    } as never);

    const { result } = renderHook(() => useVisionSupport());
    expect(result.current.supportsImage).toBe(false);
    // imageModelSupportsVision() === true suppresses the hint.
    expect(imageModelSupportsVision()).toBe(true);
    expect(composerHintShown(result.current)).toBe(false);
  });

  it('reactivity: hint flips when /model switches the active session from vision to text-only', () => {
    useConfigStore.setState({
      gatewayConfig: { agents: { defaults: { model: { primary: 'zai/glm-5v-turbo' } } } } as never,
    });
    useModelCatalogStore.setState({ catalog: [VISION_ENTRY, TEXTONLY_ENTRY] as never });
    useSessionsStore.setState({
      sessions: [{ key: 'main', label: 'Main', modelProvider: 'zai', model: 'glm-5v-turbo' }],
      activeSessionKey: 'main',
    } as never);

    const { result } = renderHook(() => useVisionSupport());
    expect(composerHintShown(result.current)).toBe(false);

    act(() => {
      useSessionsStore.setState({
        sessions: [{ key: 'main', label: 'Main', modelProvider: 'deepseek', model: 'deepseek-v4-pro' }],
        activeSessionKey: 'main',
      } as never);
    });
    expect(result.current.supportsImage).toBe(false);
    expect(composerHintShown(result.current)).toBe(true);
  });
});
