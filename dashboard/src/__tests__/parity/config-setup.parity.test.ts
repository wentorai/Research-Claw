/**
 * Behavioral Parity Tests: Config System & Setup Wizard
 *
 * These tests verify the full config.get -> extractConfigFields -> user edits ->
 * buildSaveConfig -> config.apply integration flow, ensuring our dashboard
 * produces configs that the OpenClaw gateway will accept.
 *
 * References:
 *   - openclaw/src/gateway/server-methods/config.ts:263-270  (config.get handler)
 *   - openclaw/src/gateway/server-methods/config.ts:455-514  (config.apply handler)
 *   - openclaw/src/gateway/server-methods/config.ts:131-168  (parseValidateConfigFromRawOrRespond)
 *   - openclaw/src/gateway/protocol/schema/config.ts:10      (ConfigGetParamsSchema: empty {})
 *   - openclaw/src/gateway/protocol/schema/config.ts:20-31   (ConfigApplyParamsSchema: { raw, baseHash?, ... })
 *   - openclaw/src/config/redact-snapshot.ts:73               (REDACTED_SENTINEL)
 *   - openclaw/src/config/redact-snapshot.ts:418-452          (restoreRedactedValues)
 *   - openclaw/src/config/types.openclaw.ts:137-154           (ConfigFileSnapshot shape)
 *
 * Each test cites the specific OpenClaw source file and line number it verifies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSaveConfig,
  extractConfigFields,
  isConfigValid,
  hasModelConfigured,
  REDACTED_SENTINEL,
  type ConfigPatchInput,
  type ExtractedConfig,
} from '../../utils/config-patch';
import { getPreset, PROVIDER_PRESETS } from '../../utils/provider-presets';
import {
  CONFIG_GET_ZAI_SINGLE,
  CONFIG_GET_DUAL_PROVIDER,
  CONFIG_GET_WITH_PROXY,
  CONFIG_GET_EMPTY,
  CONFIG_GET_WITH_HEARTBEAT,
  CONFIG_GET_STALE_PROVIDER,
} from '../../__fixtures__/gateway-payloads/config-responses';

// ─── Helpers ────────────────────────────────────────────────────────

/** Simulate the loadGatewayConfig store logic that maps config.get response -> GatewayConfig */
function simulateLoadGatewayConfig(snapshot: {
  config?: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  raw?: string | null;
  hash?: string | null;
}) {
  // openclaw/src/gateway/server-methods/config.ts:269 — returns full snapshot
  // Our store at stores/config.ts:131 — uses resolved ?? config
  const configObj = (snapshot.resolved ?? snapshot.config ?? {}) as Record<string, unknown>;
  return {
    agents: configObj.agents,
    models: configObj.models,
    env: configObj.env,
    raw: snapshot.raw ?? null,
    baseHash: snapshot.hash ?? null,
    projectConfig: (snapshot.config ?? null) as Record<string, unknown> | null,
  };
}

/**
 * Simulate the SetupWizard handleStart flow:
 *   1. config.get -> snapshot
 *   2. extractConfigFields -> prefill UI
 *   3. User edits (simulated via overrides)
 *   4. buildSaveConfig -> full config
 *   5. config.apply({ raw: JSON.stringify(fullConfig), baseHash: snapshot.hash })
 */
function simulateSetupWizardFlow(
  snapshot: {
    config?: Record<string, unknown>;
    resolved?: Record<string, unknown>;
    raw?: string | null;
    hash?: string | null;
  },
  userEdits: Partial<ConfigPatchInput>,
): {
  extracted: ExtractedConfig;
  savedConfig: Record<string, unknown>;
  applyParams: { raw: string; baseHash?: string };
} {
  // Step 1-2: Load and extract
  const gc = simulateLoadGatewayConfig(snapshot);
  const configRecord = gc as unknown as Record<string, unknown>;
  const extracted = extractConfigFields(configRecord);

  // Step 3-4: Build save config from user edits, using project-level config
  // SetupWizard.tsx:138-143 — re-fetches config.get and uses snapshot.config
  const input: ConfigPatchInput = {
    provider: userEdits.provider ?? extracted.provider,
    baseUrl: userEdits.baseUrl ?? extracted.baseUrl,
    api: userEdits.api ?? extracted.api,
    apiKey: userEdits.apiKey,
    textModel: userEdits.textModel ?? extracted.textModel,
    visionEnabled: userEdits.visionEnabled ?? extracted.visionEnabled,
    visionProvider: userEdits.visionProvider ?? extracted.visionProvider,
    visionModel: userEdits.visionModel ?? extracted.visionModel,
    visionBaseUrl: userEdits.visionBaseUrl ?? extracted.visionBaseUrl,
    visionApiKey: userEdits.visionApiKey,
    visionApi: userEdits.visionApi ?? extracted.visionApi,
    proxyUrl: userEdits.proxyUrl,
  };

  const savedConfig = buildSaveConfig(
    (snapshot.config ?? null) as Record<string, unknown> | null,
    input,
  );

  // Step 5: Build config.apply params
  // SetupWizard.tsx:161-164 — sends { raw: JSON.stringify(fullConfig), baseHash: snapshot.hash }
  const applyParams: { raw: string; baseHash?: string } = {
    raw: JSON.stringify(savedConfig),
  };
  if (snapshot.hash) {
    applyParams.baseHash = snapshot.hash;
  }

  return { extracted, savedConfig, applyParams };
}

// =====================================================================
// Tests
// =====================================================================

describe('Config.get response parsing — openclaw/src/gateway/server-methods/config.ts:263-270', () => {
  describe('extractConfigFields with real gateway payloads', () => {
    it('parses ZAI single-provider config.get response correctly', () => {
      // config.get handler (config.ts:269) returns redactConfigSnapshot(snapshot, uiHints)
      // which includes { config, resolved, raw, hash }
      const gc = simulateLoadGatewayConfig(CONFIG_GET_ZAI_SINGLE);
      const fields = extractConfigFields(gc as unknown as Record<string, unknown>);

      expect(fields.provider).toBe('zai');
      expect(fields.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
      expect(fields.api).toBe('openai-completions');
      expect(fields.textModel).toBe('glm-5');
      // Redacted sentinel stripped — stores/config.ts:131 uses resolved which has REDACTED
      // extractConfigFields deRedact (config-patch.ts:261-264) strips it to ''
      expect(fields.apiKey).toBe('');
      expect(fields.apiKeyConfigured).toBe(true);
      expect(fields.visionEnabled).toBe(false);
      expect(fields.proxyUrl).toBe('');
    });

    it('parses dual-provider config.get response correctly', () => {
      const gc = simulateLoadGatewayConfig(CONFIG_GET_DUAL_PROVIDER);
      const fields = extractConfigFields(gc as unknown as Record<string, unknown>);

      expect(fields.provider).toBe('openai');
      expect(fields.textModel).toBe('gpt-4o');
      expect(fields.visionEnabled).toBe(true);
      expect(fields.visionProvider).toBe('zai');
      expect(fields.visionModel).toBe('glm-4.6v');
      expect(fields.visionBaseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
      // Both keys are redacted
      expect(fields.apiKey).toBe('');
      expect(fields.apiKeyConfigured).toBe(true);
      expect(fields.visionApiKey).toBe('');
      expect(fields.visionApiKeyConfigured).toBe(true);
    });

    it('parses config with proxy settings', () => {
      const gc = simulateLoadGatewayConfig(CONFIG_GET_WITH_PROXY);
      const fields = extractConfigFields(gc as unknown as Record<string, unknown>);

      expect(fields.provider).toBe('anthropic');
      expect(fields.api).toBe('anthropic-messages');
      expect(fields.proxyUrl).toBe('http://127.0.0.1:7890');
    });

    it('returns empty/defaults for empty config (needs_setup)', () => {
      const gc = simulateLoadGatewayConfig(CONFIG_GET_EMPTY);
      const fields = extractConfigFields(gc as unknown as Record<string, unknown>);

      expect(fields.provider).toBe('custom');
      expect(fields.baseUrl).toBe('');
      expect(fields.textModel).toBe('');
      expect(fields.apiKey).toBe('');
      expect(fields.apiKeyConfigured).toBe(false);
      expect(fields.visionEnabled).toBe(false);
    });
  });
});

describe('config.apply param format — openclaw/src/gateway/protocol/schema/config.ts:20-31', () => {
  // ConfigApplyParamsSchema = { raw: NonEmptyString, baseHash?: NonEmptyString,
  //   sessionKey?: string, note?: string, restartDelayMs?: integer }
  // additionalProperties: false

  it('raw must be a NonEmptyString', () => {
    // openclaw/src/gateway/protocol/schema/config.ts:22 — raw: NonEmptyString
    // openclaw/src/gateway/protocol/schema/primitives.ts — NonEmptyString = { minLength: 1 }
    const { applyParams } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test-key',
      textModel: 'glm-5',
    });

    expect(typeof applyParams.raw).toBe('string');
    expect(applyParams.raw.length).toBeGreaterThan(0);
    // Must be valid JSON
    expect(() => JSON.parse(applyParams.raw)).not.toThrow();
  });

  it('baseHash is passed when available from config.get', () => {
    // openclaw/src/gateway/protocol/schema/config.ts:23 — baseHash: Optional(NonEmptyString)
    // server-methods/config.ts:460-462 — requireConfigBaseHash checks it
    const { applyParams } = simulateSetupWizardFlow(CONFIG_GET_ZAI_SINGLE, {
      textModel: 'glm-4.7',
      apiKey: 'sk-new-key',
    });

    expect(applyParams.baseHash).toBe(CONFIG_GET_ZAI_SINGLE.hash);
  });

  it('baseHash is omitted for fresh config (no existing file)', () => {
    // When snapshot.exists=false, requireConfigBaseHash returns true (pass-through)
    // openclaw/src/gateway/server-methods/config.ts:62-64
    const snapshot = { config: undefined, resolved: undefined, raw: null, hash: null };
    const { applyParams } = simulateSetupWizardFlow(snapshot as unknown as typeof CONFIG_GET_EMPTY, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-new',
      textModel: 'glm-5',
    });

    expect(applyParams.baseHash).toBeUndefined();
  });

  it('no extra properties in applyParams (additionalProperties: false)', () => {
    // openclaw/src/gateway/protocol/schema/config.ts:29 — additionalProperties: false
    const { applyParams } = simulateSetupWizardFlow(CONFIG_GET_ZAI_SINGLE, {
      apiKey: 'sk-test',
    });

    const keys = Object.keys(applyParams);
    const allowedKeys = ['raw', 'baseHash', 'sessionKey', 'note', 'restartDelayMs'];
    for (const key of keys) {
      expect(allowedKeys).toContain(key);
    }
  });
});

describe('Sentinel round-trip — openclaw/src/config/redact-snapshot.ts:418-452', () => {
  // The gateway's restoreRedactedValues() walks the incoming config object and
  // replaces REDACTED_SENTINEL values at sensitive paths with the on-disk original.
  // Our buildSaveConfig must preserve REDACTED sentinels for keys the user didn't change.

  it('preserves redacted API key when user does not provide a new key', () => {
    // redact-snapshot.ts:73 — REDACTED_SENTINEL = '__OPENCLAW_REDACTED__'
    // redact-snapshot.ts:627-628 — if value === REDACTED_SENTINEL → restore from original
    // config-patch.ts:137-142 — preserves existing key (which is REDACTED) when no new key
    const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_ZAI_SINGLE, {
      // No apiKey provided -> should keep sentinel
      textModel: 'glm-4.7',
    });

    const providers = (savedConfig.models as Record<string, unknown>)
      .providers as Record<string, Record<string, unknown>>;
    expect(providers.zai.apiKey).toBe(REDACTED_SENTINEL);
  });

  it('replaces sentinel when user provides a new key', () => {
    // When user types a new key, it replaces the sentinel.
    // Gateway's restoreRedactedValues won't touch non-sentinel values.
    const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_ZAI_SINGLE, {
      apiKey: 'sk-brand-new-key',
    });

    const providers = (savedConfig.models as Record<string, unknown>)
      .providers as Record<string, Record<string, unknown>>;
    expect(providers.zai.apiKey).toBe('sk-brand-new-key');
  });

  it('preserves both text and vision sentinels in dual-provider config', () => {
    // When editing dual-provider config without changing keys,
    // both providers keep their REDACTED values
    const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_DUAL_PROVIDER, {
      // No apiKey or visionApiKey
      textModel: 'gpt-5.4',
      visionEnabled: true,
      visionProvider: 'zai',
      visionModel: 'glm-4.6v',
      visionBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    });

    const providers = (savedConfig.models as Record<string, unknown>)
      .providers as Record<string, Record<string, unknown>>;
    expect(providers.openai.apiKey).toBe(REDACTED_SENTINEL);
    expect(providers.zai.apiKey).toBe(REDACTED_SENTINEL);
  });

  it('sentinel value exactly matches OpenClaw constant', () => {
    // openclaw/src/config/redact-snapshot.ts:73
    expect(REDACTED_SENTINEL).toBe('__OPENCLAW_REDACTED__');
  });
});

describe('evaluateConfig — stores/config.ts:147-178', () => {
  // The evaluateConfig function implements a 3-level validation cascade:
  // Level 1: isConfigValid (strict — model ref + matching provider)
  // Level 2: hasModelConfigured (relaxed — gateway connected + model exists)
  // Level 3: Retry with delay (gateway race condition)

  it('valid config -> ready (Level 1 strict validation)', () => {
    // stores/config.ts:152-155 — isConfigValid -> bootState='ready'
    const gc = simulateLoadGatewayConfig(CONFIG_GET_ZAI_SINGLE);
    expect(isConfigValid(gc as unknown as Record<string, unknown>)).toBe(true);
  });

  it('valid dual-provider config -> ready', () => {
    const gc = simulateLoadGatewayConfig(CONFIG_GET_DUAL_PROVIDER);
    expect(isConfigValid(gc as unknown as Record<string, unknown>)).toBe(true);
  });

  it('empty config -> NOT valid (triggers needs_setup)', () => {
    // stores/config.ts:168-178 — after retries exhausted, bootState='needs_setup'
    const gc = simulateLoadGatewayConfig(CONFIG_GET_EMPTY);
    expect(isConfigValid(gc as unknown as Record<string, unknown>)).toBe(false);
  });

  it('empty config -> NOT has model configured (Level 2 also fails)', () => {
    const gc = simulateLoadGatewayConfig(CONFIG_GET_EMPTY);
    expect(hasModelConfigured(gc as unknown as Record<string, unknown>)).toBe(false);
  });

  it('config with model but no matching provider -> Level 2 relaxed passes', () => {
    // stores/config.ts:161-164 — hasModelConfigured is relaxed, only checks model ref
    // This covers the case where resolved config structure differs from project config
    const configWithModelOnly = {
      agents: { defaults: { model: { primary: 'zai/glm-5' } } },
      // No models.providers
    };
    expect(isConfigValid(configWithModelOnly)).toBe(false);
    expect(hasModelConfigured(configWithModelOnly)).toBe(true);
  });

  it('config freshly saved by SetupWizard -> valid', () => {
    // After the full flow, the generated config MUST pass isConfigValid
    const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      textModel: 'glm-5',
    });
    expect(isConfigValid(savedConfig)).toBe(true);
  });
});

describe('Provider preset metadata — openclaw/src/agents/provider-capabilities.ts', () => {
  // Our provider presets include model metadata (contextWindow, maxTokens, reasoning)
  // that buildSaveConfig bakes into the config. The gateway validates this.
  // openclaw/src/agents/models-config.providers.static.ts — static model definitions

  it('ZAI preset includes correct models with proper metadata', () => {
    const preset = getPreset('zai');
    expect(preset.id).toBe('zai');
    expect(preset.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(preset.api).toBe('openai-completions');

    // glm-5 should be text-only and reasoning-capable
    const glm5 = preset.models.find((m) => m.id === 'glm-5');
    expect(glm5).toBeDefined();
    expect(glm5!.reasoning).toBe(true);
    expect(glm5!.input).toEqual(['text']);
    expect(glm5!.contextWindow).toBe(204_800);
    expect(glm5!.maxTokens).toBe(131_072);

    // glm-4.6v should be vision-capable
    const glm46v = preset.models.find((m) => m.id === 'glm-4.6v');
    expect(glm46v).toBeDefined();
    expect(glm46v!.input).toContain('image');
  });

  it('Anthropic preset uses anthropic-messages API protocol', () => {
    // openclaw/src/agents/provider-capabilities.ts — anthropic provider uses anthropic-messages
    const preset = getPreset('anthropic');
    expect(preset.api).toBe('anthropic-messages');
    expect(preset.baseUrl).toBe('https://api.anthropic.com');
  });

  it('OpenAI preset uses openai-completions API protocol', () => {
    const preset = getPreset('openai');
    expect(preset.api).toBe('openai-completions');
    expect(preset.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('all presets have valid API protocol types', () => {
    // openclaw accepts these api values in provider config
    const validApis = [
      'openai-completions',
      'openai-codex-responses',
      'anthropic-messages',
      'google-generative-ai',
      'bedrock-converse-stream',
      'ollama',
      'github-copilot',
    ];
    for (const preset of PROVIDER_PRESETS) {
      expect(validApis).toContain(preset.api);
    }
  });

  it('getPreset falls back to custom for unknown provider', () => {
    const preset = getPreset('nonexistent-provider');
    expect(preset.id).toBe('custom');
  });

  it('model definition shape matches what OpenClaw expects in providers.*.models[]', () => {
    // openclaw config expects models entries with: id, name, input[], contextWindow, maxTokens
    // Our resolveModelDef (config-patch.ts:68-79) produces this shape
    const config = buildSaveConfig(null, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      textModel: 'glm-5',
    });

    const providers = (config.models as Record<string, unknown>)
      .providers as Record<string, Record<string, unknown>>;
    const models = providers.zai.models as Array<Record<string, unknown>>;
    const model = models[0];

    // Verify all required fields exist with correct types
    expect(typeof model.id).toBe('string');
    expect(typeof model.name).toBe('string');
    expect(typeof model.reasoning).toBe('boolean');
    expect(Array.isArray(model.input)).toBe(true);
    expect(typeof model.contextWindow).toBe('number');
    expect(typeof model.maxTokens).toBe('number');
  });
});

describe('Full SetupWizard flow — config.get -> edit -> config.apply', () => {
  // This tests the complete integration path as implemented in
  // SetupWizard.tsx:131-165 (handleStart)

  describe('Fresh setup (no existing config)', () => {
    it('ZAI provider: select -> enter key -> save produces valid config', () => {
      // SetupWizard.tsx:138-164 — handleStart flow
      const { savedConfig, applyParams } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
        provider: 'zai',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        api: 'openai-completions',
        apiKey: 'sk-test-key-12345',
        textModel: 'glm-5',
      });

      // Config must be valid for the gateway
      expect(isConfigValid(savedConfig)).toBe(true);

      // Verify structure matches what config.apply expects
      const parsed = JSON.parse(applyParams.raw);
      expect(parsed.agents.defaults.model.primary).toBe('zai/glm-5');
      expect(parsed.models.providers.zai.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
      expect(parsed.models.providers.zai.apiKey).toBe('sk-test-key-12345');
      expect(parsed.models.providers.zai.api).toBe('openai-completions');

      // Model metadata from preset (text-only per preset, gateway uses /image tool for vision)
      const models = parsed.models.providers.zai.models;
      expect(models[0].id).toBe('glm-5');
      expect(models[0].reasoning).toBe(true);
      expect(models[0].input).toEqual(['text']);
      expect(models[0].contextWindow).toBe(204_800);
      expect(models[0].maxTokens).toBe(131_072);
    });

    it('Anthropic provider: correct api protocol', () => {
      const { savedConfig, applyParams } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        api: 'anthropic-messages',
        apiKey: 'sk-ant-test',
        textModel: 'claude-sonnet-4-6',
      });

      expect(isConfigValid(savedConfig)).toBe(true);

      const parsed = JSON.parse(applyParams.raw);
      expect(parsed.models.providers.anthropic.api).toBe('anthropic-messages');
    });

    it('with vision enabled (separate provider)', () => {
      const { savedConfig, applyParams } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        textModel: 'gpt-4o',
        visionEnabled: true,
        visionProvider: 'zai',
        visionModel: 'glm-4.6v',
        visionBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        visionApiKey: 'sk-zai-vision',
        visionApi: 'openai-completions',
      });

      expect(isConfigValid(savedConfig)).toBe(true);

      const parsed = JSON.parse(applyParams.raw);
      // Two providers
      expect(Object.keys(parsed.models.providers)).toEqual(
        expect.arrayContaining(['openai', 'zai']),
      );
      // Model refs
      expect(parsed.agents.defaults.model.primary).toBe('openai/gpt-4o');
      expect(parsed.agents.defaults.imageModel.primary).toBe('zai/glm-4.6v');
      // Vision provider has its own apiKey
      expect(parsed.models.providers.zai.apiKey).toBe('sk-zai-vision');
    });

    it('with proxy enabled', () => {
      const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        textModel: 'gpt-4o',
        proxyUrl: 'http://127.0.0.1:7890',
      });

      const env = savedConfig.env as Record<string, string>;
      expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
      expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    });
  });

  describe('Re-configuration (existing config)', () => {
    it('changing model preserves API key sentinel', () => {
      // The most common re-config: user changes model but not API key.
      // SetupWizard.tsx:149 — apiKey: apiKey.trim() || undefined
      // When apiKey is empty (user didn't type anything), it becomes undefined
      // config-patch.ts:137-142 — falls back to existing key (REDACTED sentinel)
      const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_ZAI_SINGLE, {
        textModel: 'glm-4.7',
        // No apiKey -> preserve sentinel
      });

      const providers = (savedConfig.models as Record<string, unknown>)
        .providers as Record<string, Record<string, unknown>>;
      expect(providers.zai.apiKey).toBe(REDACTED_SENTINEL);
      expect(providers.zai.models).toBeDefined();

      // Model ref updated
      const defaults = (savedConfig.agents as Record<string, unknown>)
        .defaults as Record<string, unknown>;
      expect((defaults.model as Record<string, string>).primary).toBe('zai/glm-4.7');
    });

    it('preserves heartbeat from existing config', () => {
      // config-patch.ts:174-176 — existingDefaults spread preserves heartbeat
      const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_WITH_HEARTBEAT, {
        textModel: 'glm-4.7',
        apiKey: 'sk-new',
      });

      const defaults = (savedConfig.agents as Record<string, unknown>)
        .defaults as Record<string, unknown>;
      expect((defaults.heartbeat as Record<string, string>).every).toBe('3m');
    });

    it('switching provider removes stale provider entry', () => {
      // config-patch.ts:144-146 — only referenced providers appear in output
      // This is critical: stale providers would cause confusion and potential key leaks
      const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_STALE_PROVIDER, {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-new-openai',
        textModel: 'gpt-4o',
      });

      const providers = (savedConfig.models as Record<string, unknown>)
        .providers as Record<string, Record<string, unknown>>;
      expect(providers.rc).toBeUndefined();
      expect(providers.openai).toBeDefined();
      expect(Object.keys(providers)).toEqual(['openai']);
    });

    it('disabling proxy clears env proxy vars', () => {
      // SetupWizard.tsx:157 — proxyUrl: proxyEnabled ? proxyUrl.trim() : ''
      // config-patch.ts:187-195 — empty string clears proxy
      const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_WITH_PROXY, {
        proxyUrl: '',
      });

      const env = savedConfig.env as Record<string, string>;
      expect(env.HTTP_PROXY).toBe('');
      expect(env.HTTPS_PROXY).toBe('');
    });
  });
});

describe('Config structure matches OpenClaw expectations', () => {
  // openclaw/src/gateway/server-methods/config.ts:131-168 validates:
  //   1. parseConfigJson5(raw) — JSON parse
  //   2. restoreRedactedValues(parsed, snapshot.config, hints) — sentinel restore
  //   3. validateConfigObjectWithPlugins(restored) — schema validation

  it('config.apply raw is valid JSON (parseConfigJson5 compatibility)', () => {
    // server-methods/config.ts:141 — parseConfigJson5 accepts JSON5 (superset of JSON)
    // Our JSON.stringify output is always valid JSON, which is also valid JSON5
    const { applyParams } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      textModel: 'glm-5',
    });

    const parsed = JSON.parse(applyParams.raw);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
  });

  it('config has agents.defaults.model.primary in provider/model format', () => {
    // OpenClaw uses 'provider/model' format for model refs
    // The provider part must match a key in models.providers
    const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      textModel: 'glm-5',
    });

    const agents = savedConfig.agents as Record<string, unknown>;
    const defaults = agents.defaults as Record<string, unknown>;
    const model = defaults.model as Record<string, string>;

    expect(model.primary).toMatch(/^[a-z0-9-]+\/.+$/);
    // Provider part matches a key in models.providers
    const providerKey = model.primary.split('/')[0];
    const providers = (savedConfig.models as Record<string, unknown>)
      .providers as Record<string, unknown>;
    expect(providers[providerKey]).toBeDefined();
  });

  it('agents.defaults.imageModel.primary follows same provider/model format', () => {
    const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      textModel: 'gpt-4o',
      visionEnabled: true,
      visionProvider: 'zai',
      visionModel: 'glm-4.6v',
      visionBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      visionApiKey: 'sk-zai',
    });

    const defaults = (savedConfig.agents as Record<string, unknown>)
      .defaults as Record<string, unknown>;
    const imageModel = defaults.imageModel as Record<string, string>;

    expect(imageModel.primary).toBe('zai/glm-4.6v');
    // Vision provider must exist in providers map
    const providers = (savedConfig.models as Record<string, unknown>)
      .providers as Record<string, unknown>;
    expect(providers.zai).toBeDefined();
  });

  it('provider entry has required fields: baseUrl, api, models[]', () => {
    // These fields are what OpenClaw expects for each provider entry
    const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      textModel: 'glm-5',
    });

    const providers = (savedConfig.models as Record<string, unknown>)
      .providers as Record<string, Record<string, unknown>>;
    const zai = providers.zai;

    expect(typeof zai.baseUrl).toBe('string');
    expect((zai.baseUrl as string).length).toBeGreaterThan(0);
    expect(typeof zai.api).toBe('string');
    expect(Array.isArray(zai.models)).toBe(true);
    expect((zai.models as unknown[]).length).toBeGreaterThan(0);
  });

  it('model entry includes all required metadata fields', () => {
    // Each model in providers.*.models[] needs:
    // id, name, reasoning, input, contextWindow, maxTokens
    const { savedConfig } = simulateSetupWizardFlow(CONFIG_GET_EMPTY, {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      api: 'anthropic-messages',
      apiKey: 'sk-test',
      textModel: 'claude-sonnet-4-6',
    });

    const providers = (savedConfig.models as Record<string, unknown>)
      .providers as Record<string, Record<string, unknown>>;
    const models = providers.anthropic.models as Array<Record<string, unknown>>;
    const model = models[0];

    expect(model.id).toBe('claude-sonnet-4-6');
    expect(model.name).toBe('claude-sonnet-4-6');
    expect(typeof model.reasoning).toBe('boolean');
    expect(Array.isArray(model.input)).toBe(true);
    expect((model.input as string[]).length).toBeGreaterThan(0);
    expect(typeof model.contextWindow).toBe('number');
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(typeof model.maxTokens).toBe('number');
    expect(model.maxTokens).toBeGreaterThan(0);
  });
});

describe('Round-trip integrity: extract -> edit -> build -> extract', () => {
  // Verify that extracting fields from a config, building a new config from those fields,
  // and then extracting again produces consistent results

  it('ZAI config survives extract -> build -> extract round-trip', () => {
    // Extract from gateway response
    const gc = simulateLoadGatewayConfig(CONFIG_GET_ZAI_SINGLE);
    const fields1 = extractConfigFields(gc as unknown as Record<string, unknown>);

    // Build new config from extracted fields (with a fresh key since sentinel was stripped)
    const rebuilt = buildSaveConfig(null, {
      provider: fields1.provider,
      baseUrl: fields1.baseUrl,
      api: fields1.api,
      apiKey: 'sk-roundtrip-key',
      textModel: fields1.textModel,
    });

    // Extract from rebuilt config
    const fields2 = extractConfigFields(rebuilt);

    expect(fields2.provider).toBe(fields1.provider);
    expect(fields2.baseUrl).toBe(fields1.baseUrl);
    expect(fields2.api).toBe(fields1.api);
    expect(fields2.textModel).toBe(fields1.textModel);
    expect(fields2.apiKey).toBe('sk-roundtrip-key');
    expect(fields2.apiKeyConfigured).toBe(true);
  });

  it('dual-provider config survives round-trip', () => {
    const gc = simulateLoadGatewayConfig(CONFIG_GET_DUAL_PROVIDER);
    const fields1 = extractConfigFields(gc as unknown as Record<string, unknown>);

    const rebuilt = buildSaveConfig(null, {
      provider: fields1.provider,
      baseUrl: fields1.baseUrl,
      api: fields1.api,
      apiKey: 'sk-text-rt',
      textModel: fields1.textModel,
      visionEnabled: fields1.visionEnabled,
      visionProvider: fields1.visionProvider,
      visionModel: fields1.visionModel,
      visionBaseUrl: fields1.visionBaseUrl,
      visionApiKey: 'sk-vision-rt',
      visionApi: fields1.visionApi,
    });

    const fields2 = extractConfigFields(rebuilt);

    expect(fields2.provider).toBe('openai');
    expect(fields2.textModel).toBe('gpt-4o');
    expect(fields2.visionEnabled).toBe(true);
    expect(fields2.visionProvider).toBe('zai');
    expect(fields2.visionModel).toBe('glm-4.6v');
  });

  it('proxy config survives round-trip', () => {
    const gc = simulateLoadGatewayConfig(CONFIG_GET_WITH_PROXY);
    const fields1 = extractConfigFields(gc as unknown as Record<string, unknown>);

    const rebuilt = buildSaveConfig(null, {
      provider: fields1.provider,
      baseUrl: fields1.baseUrl,
      api: fields1.api,
      apiKey: 'sk-rt',
      textModel: fields1.textModel,
      proxyUrl: fields1.proxyUrl,
    });

    const fields2 = extractConfigFields(rebuilt);
    expect(fields2.proxyUrl).toBe('http://127.0.0.1:7890');
  });
});
