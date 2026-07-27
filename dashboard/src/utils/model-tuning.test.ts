import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveModelDef,
  validateModelTuning,
  clampSavedContextWindow,
  isManualModelEndpoint,
  buildSaveConfig,
  extractProviderFieldsForEditor,
  compactionCanRecover,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_MAX,
  OC_DEFAULT_CONTEXT_WINDOW,
  RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS,
  type ConfigPatchInput,
} from './config-patch';
import { setModelCatalogCache } from './catalog-cache';
import { alignConfigModels, type RcModelCard } from './oc-catalog-align';
import { ocModelsListAllPayload } from '../__fixtures__/gateway-payloads/oc-model-catalog';

afterEach(() => setModelCatalogCache(null));

describe('isManualModelEndpoint', () => {
  it('true for local runtimes and custom API profiles', () => {
    expect(isManualModelEndpoint('ollama')).toBe(true);
    expect(isManualModelEndpoint('vllm')).toBe(true);
    expect(isManualModelEndpoint('custom')).toBe(true);
    expect(isManualModelEndpoint('custom-relay-a')).toBe(true);
  });
  it('false for preset/OC-known providers', () => {
    expect(isManualModelEndpoint('openai')).toBe(false);
    expect(isManualModelEndpoint('deepseek')).toBe(false);
    expect(isManualModelEndpoint('minimax')).toBe(false);
  });
});

describe('resolveModelDef — manual contextWindow override', () => {
  // No provenance flag is persisted on the card (OC's strict schema rejects unknown
  // keys); the window is owned by manual-endpoint providers via isManualModelEndpoint.
  it('honors a positive override', () => {
    const card = resolveModelDef('custom-relay', 'house-model', {
      contextWindowOverride: 96_000,
    });
    expect(card.contextWindow).toBe(96_000);
  });

  it('floors a fractional override and keeps it', () => {
    const card = resolveModelDef('ollama', 'qwen3', { contextWindowOverride: 40_000.7 });
    expect(card.contextWindow).toBe(40_000);
  });

  it('ignores a non-positive / non-finite override (falls back to default)', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const card = resolveModelDef('custom', 'x', { contextWindowOverride: bad });
      // OC-aligned hard fallback (DEFAULT_CONTEXT_TOKENS); must stay above the
      // compaction-recoverable threshold so self-compaction never loops forever.
      expect(card.contextWindow).toBe(200_000);
    }
  });

  it('without an override falls back to the default window', () => {
    const card = resolveModelDef('custom', 'x');
    expect(card.contextWindow).toBe(200_000); // OC-aligned hard fallback, no preset/cache
  });

  it('override beats the OC catalog value', () => {
    setModelCatalogCache(ocModelsListAllPayload.models);
    // openai/gpt-5.4 resolves to 272K from the catalog; the override must win.
    const card = resolveModelDef('openai', 'gpt-5.4', { contextWindowOverride: 50_000 });
    expect(card.contextWindow).toBe(50_000);
  });
});

describe('compactionCanRecover — mirrors OC compaction budget math', () => {
  // historyTarget = cw·share·1.2 must stay below promptBudget = cw − reserve(≤20000).
  it('the OC-aligned default window recovers comfortably', () => {
    expect(compactionCanRecover(OC_DEFAULT_CONTEXT_WINDOW)).toBe(true);
    expect(OC_DEFAULT_CONTEXT_WINDOW).toBe(200_000);
  });

  it('reproduces the regression: the old 32K window can NOT recover', () => {
    // 32000·0.5·1.2 = 19200 ≥ promptBudget 32000−20000 = 12000 → loops forever.
    expect(compactionCanRecover(32_000)).toBe(false);
  });

  it('is unrecoverable at and below the default-share threshold (~50K)', () => {
    expect(compactionCanRecover(50_000)).toBe(false); // 30000 ≥ 30000
    expect(compactionCanRecover(60_000)).toBe(true); // 36000 < 40000
  });

  it('a small window becomes recoverable with a low enough history share', () => {
    expect(compactionCanRecover(32_000, 0.5)).toBe(false);
    expect(compactionCanRecover(32_000, 0.3)).toBe(true); // 11520 < 12000
  });

  it('any share ≥ ~0.84 can never recover (share·1.2 ≥ window)', () => {
    expect(compactionCanRecover(OC_DEFAULT_CONTEXT_WINDOW, 0.9)).toBe(false);
    expect(compactionCanRecover(1_000_000, 0.9)).toBe(false);
  });

  it('rejects non-positive / non-finite windows', () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(compactionCanRecover(bad)).toBe(false);
  });
});

describe('validateModelTuning — 防蠢 (contextWindow is the only knob)', () => {
  it('passes for a sane window and for the empty (all-auto) form', () => {
    expect(validateModelTuning({ contextWindow: 128_000 })).toEqual([]);
    expect(validateModelTuning({})).toEqual([]);
  });

  it('rejects a non-integer contextWindow', () => {
    expect(validateModelTuning({ contextWindow: 1024.5 }).map((i) => i.code)).toEqual([
      'contextWindow.notInteger',
    ]);
  });

  it('rejects a contextWindow above the hard maximum', () => {
    expect(validateModelTuning({ contextWindow: CONTEXT_WINDOW_MAX + 1 }).map((i) => i.code)).toEqual([
      'contextWindow.outOfRange',
    ]);
  });

  it('does NOT flag a sub-floor window — that is auto-raised on save, not an error', () => {
    // The save-time clamp (clampSavedContextWindow) owns the floor; validation stays
    // silent so the user is never blocked, only nudged via toast.
    expect(validateModelTuning({ contextWindow: CONTEXT_WINDOW_MIN - 1 })).toEqual([]);
    expect(validateModelTuning({ contextWindow: 1_000 })).toEqual([]);
  });

  it('accepts the exact upper bound', () => {
    expect(validateModelTuning({ contextWindow: CONTEXT_WINDOW_MAX })).toEqual([]);
  });
});

describe('clampSavedContextWindow — floor enforcement with a clamp signal', () => {
  it('passes through an empty (auto) window untouched', () => {
    expect(clampSavedContextWindow(undefined)).toEqual({ value: undefined, clamped: false });
    expect(clampSavedContextWindow(null)).toEqual({ value: undefined, clamped: false });
    expect(clampSavedContextWindow(NaN)).toEqual({ value: undefined, clamped: false });
  });

  it('raises a sub-floor window to CONTEXT_WINDOW_MIN and flags the clamp', () => {
    expect(clampSavedContextWindow(8_000)).toEqual({ value: CONTEXT_WINDOW_MIN, clamped: true });
    expect(clampSavedContextWindow(CONTEXT_WINDOW_MIN - 1)).toEqual({
      value: CONTEXT_WINDOW_MIN,
      clamped: true,
    });
  });

  it('keeps an at-or-above-floor window and floors fractions without flagging', () => {
    expect(clampSavedContextWindow(CONTEXT_WINDOW_MIN)).toEqual({
      value: CONTEXT_WINDOW_MIN,
      clamped: false,
    });
    expect(clampSavedContextWindow(96_000.7)).toEqual({ value: 96_000, clamped: false });
  });
});

describe('buildSaveConfig — manual window + global compaction (拉通)', () => {
  const baseInput = (over: Partial<ConfigPatchInput> = {}): ConfigPatchInput => ({
    provider: 'custom-relay',
    baseUrl: 'https://relay.example.com/v1',
    api: 'openai-completions',
    apiKey: 'sk-test',
    textModel: 'house-model',
    profileLabel: 'House Relay',
    ...over,
  });

  it('writes the manual window onto the text card', () => {
    const cfg = buildSaveConfig(null, baseInput({ customContextWindow: 96_000 }));
    const providers = (cfg.models as { providers: Record<string, { models: RcModelCard[] }> }).providers;
    const card = providers['custom-relay'].models[0];
    expect(card.contextWindow).toBe(96_000);
  });

  it('ignores customContextWindow for a preset (non-manual) provider', () => {
    const cfg = buildSaveConfig(
      null,
      baseInput({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', textModel: 'gpt-5.4', customContextWindow: 999_999, profileLabel: undefined }),
    );
    const providers = (cfg.models as { providers: Record<string, { models: RcModelCard[] }> }).providers;
    const card = providers.openai.models[0];
    expect(card.contextWindow).not.toBe(999_999);
  });

  it('writes no reserve keys for a small window (reserve is OC-owned, floor guarantees turn-1)', () => {
    // RC no longer tunes the compaction reserve — OC pins the turn-1 precheck reserve
    // at its own default regardless of config, so the CONTEXT_WINDOW_MIN floor is what
    // guarantees turn-1 fits. The only additional compaction field is the
    // Research-Claw scientific-fidelity instruction.
    const cfg = buildSaveConfig(null, baseInput({ customContextWindow: 32_000 }));
    const compaction = (
      (cfg.agents as { defaults: { compaction: Record<string, unknown> } }).defaults.compaction
    );
    expect(compaction).toEqual({
      mode: 'safeguard',
      customInstructions: RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS,
    });
  });

  it('writes no reserve keys for a large window (mainstream untouched, OC default 20000)', () => {
    const cfg = buildSaveConfig(null, baseInput({ customContextWindow: 200_000 }));
    const compaction = (
      (cfg.agents as { defaults: { compaction: Record<string, unknown> } }).defaults.compaction
    );
    expect(compaction).toEqual({
      mode: 'safeguard',
      customInstructions: RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS,
    });
  });

  it('keeps safeguard plus the scientific instructions when no manual window is provided', () => {
    const cfg = buildSaveConfig(null, baseInput());
    const compaction = (
      (cfg.agents as { defaults: { compaction: Record<string, unknown> } }).defaults.compaction
    );
    expect(compaction).toEqual({
      mode: 'safeguard',
      customInstructions: RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS,
    });
  });

  it('always strips any prior maxHistoryShare (RC defers it to OC default 0.5)', () => {
    const current: Record<string, unknown> = {
      agents: { defaults: { compaction: { mode: 'safeguard', maxHistoryShare: 0.7 } } },
    };
    const cfg = buildSaveConfig(current, baseInput());
    const compaction = (
      (cfg.agents as { defaults: { compaction: Record<string, unknown> } }).defaults.compaction
    );
    expect(compaction.maxHistoryShare).toBeUndefined();
    expect(compaction.mode).toBe('safeguard');
  });

  it('always clears any prior RC-written reserve keys (reserve deferred to OC)', () => {
    const current: Record<string, unknown> = {
      agents: {
        defaults: {
          compaction: { mode: 'safeguard', reserveTokens: 12_000, reserveTokensFloor: 12_000 },
        },
      },
    };
    // Window-independent: stale reserve keys are stripped even for a small window.
    const cfg = buildSaveConfig(current, baseInput({ customContextWindow: 32_000 }));
    const compaction = (
      (cfg.agents as { defaults: { compaction: Record<string, unknown> } }).defaults.compaction
    );
    expect(compaction.reserveTokens).toBeUndefined();
    expect(compaction.reserveTokensFloor).toBeUndefined();
  });

  it('round-trips: manual card survives the startup aligner and reads back identically', () => {
    setModelCatalogCache(ocModelsListAllPayload.models);
    // Use an id OC knows under another provider so a non-manual card WOULD be re-aligned.
    const cfg = buildSaveConfig(
      null,
      baseInput({ textModel: 'gpt-5.4', customContextWindow: 64_000 }),
    );

    // Startup aligner must not touch the manual-endpoint card — wired exactly as
    // production (model-catalog.ts) by passing isManualModelEndpoint.
    const { config: aligned, changes } = alignConfigModels(
      cfg,
      ocModelsListAllPayload.models,
      isManualModelEndpoint,
    );
    expect(changes.find((c) => c.provider === 'custom-relay')).toBeUndefined();

    const providerFields = extractProviderFieldsForEditor(aligned, 'custom-relay');
    expect(providerFields?.contextWindow).toBe(64_000);
    expect(providerFields?.contextWindowManual).toBe(true);
  });

  it('manual protection is by provider key, not a pinned window', () => {
    setModelCatalogCache(ocModelsListAllPayload.models);
    // A custom-relay card whose stale 32K window OC could lift to 272K via the gpt-5.4 id.
    const cfg: Record<string, unknown> = {
      models: {
        providers: {
          'custom-relay': {
            api: 'openai-completions',
            models: [{ id: 'gpt-5.4', name: 'My Relay', contextWindow: 32_000, maxTokens: 16_384 }],
          },
        },
      },
    };
    // Production wiring passes isManualModelEndpoint → custom-relay is skipped, frozen at 32K.
    const guarded = alignConfigModels(cfg, ocModelsListAllPayload.models, isManualModelEndpoint);
    const guardedProviders = (guarded.config.models as { providers: Record<string, { models: RcModelCard[] }> }).providers;
    expect(guardedProviders['custom-relay'].models[0].contextWindow).toBe(32_000);
    expect(guarded.changes).toHaveLength(0);

    // Without the predicate (default), the same card WOULD be re-aligned — proving the
    // provider-key predicate is what protects it, regardless of any pinned window.
    const unguarded = alignConfigModels(cfg, ocModelsListAllPayload.models);
    const unguardedProviders = (unguarded.config.models as { providers: Record<string, { models: RcModelCard[] }> }).providers;
    expect(unguardedProviders['custom-relay'].models[0].contextWindow).toBe(272_000);
  });
});
