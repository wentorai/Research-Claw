import { describe, it, expect } from 'vitest';
import {
  buildSaveConfig,
  extractConfigFields,
  isConfigValid,
  hasModelConfigured,
  REDACTED_SENTINEL,
} from './config-patch';

describe('buildSaveConfig', () => {
  it('builds single-provider config with preset model capabilities', () => {
    const config = buildSaveConfig(null, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      textModel: 'gpt-4o',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.openai).toBeDefined();
    expect(providers.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(providers.openai.apiKey).toBe('sk-test');

    // gpt-4o is multimodal in the preset → input includes 'image'
    const models = providers.openai.models as Array<{ id: string; input: string[] }>;
    expect(models[0].input).toEqual(['text', 'image']);

    const defaults = (config.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect((defaults.model as Record<string, string>).primary).toBe('openai/gpt-4o');
    expect((defaults.imageModel as Record<string, string>).primary).toBe('openai/gpt-4o');
  });

  it('respects preset input capabilities — text-only models stay text-only', () => {
    const config = buildSaveConfig(null, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      textModel: 'glm-5',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    const models = providers.zai.models as Array<{ id: string; input: string[] }>;
    // glm-5 is text-only in preset → gateway uses /image tool with imageModel instead
    expect(models[0].id).toBe('glm-5');
    expect(models[0].input).toEqual(['text']);
  });

  it('marks vision models correctly in same-provider ZAI config', () => {
    const config = buildSaveConfig(null, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      textModel: 'glm-5',
      visionEnabled: true,
      visionProvider: 'zai',
      visionModel: 'glm-4.6v',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    const models = providers.zai.models as Array<{ id: string; input: string[] }>;
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('glm-5');
    expect(models[0].input).toEqual(['text']);
    expect(models[1].id).toBe('glm-4.6v');
    expect(models[1].input).toEqual(['text', 'image']);
  });

  it('defaults to multimodal for unknown models not in preset', () => {
    const config = buildSaveConfig(null, {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      textModel: 'google/gemini-3.1-pro-preview',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    const models = providers.openrouter.models as Array<{ id: string; input: string[] }>;
    // Not in preset → defaults to multimodal
    expect(models[0].input).toEqual(['text', 'image']);
  });

  it('builds same-provider vision config (different model)', () => {
    const config = buildSaveConfig(null, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      textModel: 'gpt-4o',
      visionEnabled: true,
      visionProvider: 'openai',
      visionModel: 'gpt-4o-vision',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.openai).toBeDefined();
    // No separate vision provider entry when same provider
    expect(Object.keys(providers)).toEqual(['openai']);

    const models = providers.openai.models as Array<{ id: string; input: string[] }>;
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('gpt-4o');
    expect(models[1].id).toBe('gpt-4o-vision');

    const defaults = (config.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect((defaults.model as Record<string, string>).primary).toBe('openai/gpt-4o');
    expect((defaults.imageModel as Record<string, string>).primary).toBe('openai/gpt-4o-vision');
  });

  it('builds dual-provider config with native keys', () => {
    const config = buildSaveConfig(null, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-text',
      textModel: 'gpt-4o',
      visionEnabled: true,
      visionProvider: 'zai',
      visionModel: 'glm-4.6v',
      visionBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      visionApiKey: 'sk-vision',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.openai).toBeDefined();
    expect(providers.zai).toBeDefined();
    expect(providers.zai.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(providers.zai.apiKey).toBe('sk-vision');

    const defaults = (config.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect((defaults.model as Record<string, string>).primary).toBe('openai/gpt-4o');
    expect((defaults.imageModel as Record<string, string>).primary).toBe('zai/glm-4.6v');
  });

  it('uses visionApi for vision provider when specified', () => {
    const config = buildSaveConfig(null, {
      provider: 'minimax',
      baseUrl: 'https://api.minimax.io/anthropic',
      api: 'anthropic-messages',
      apiKey: 'sk-text',
      textModel: 'MiniMax-M2.5',
      visionEnabled: true,
      visionProvider: 'zai',
      visionModel: 'glm-4.6v',
      visionBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      visionApiKey: 'sk-vision',
      visionApi: 'openai-completions',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.minimax.api).toBe('anthropic-messages');
    expect(providers.zai.api).toBe('openai-completions');
  });

  it('routes minimax via local proxy when apiKey is sk-cp-*', () => {
    const config = buildSaveConfig(null, {
      provider: 'minimax',
      baseUrl: 'https://api.minimax.io/anthropic',
      api: 'anthropic-messages',
      apiKey: 'sk-cp-foo',
      textModel: 'MiniMax-M2.5',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.minimax.baseUrl).toBe('http://127.0.0.1:28790/anthropic');
    expect(providers.minimax.upstreamBaseUrl).toBe('https://api.minimax.io/anthropic');
    expect(providers.minimax.apiKey).toBe('sk-cp-foo');
  });

  it('includes proxy env when proxyUrl is set', () => {
    const config = buildSaveConfig(null, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      textModel: 'gpt-4o',
      proxyUrl: 'http://127.0.0.1:7890',
    });

    const env = config.env as Record<string, string>;
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
  });

  it('clears proxy when proxyUrl is empty string', () => {
    const config = buildSaveConfig(null, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      textModel: 'gpt-4o',
      proxyUrl: '',
    });

    const env = config.env as Record<string, string>;
    expect(env.HTTP_PROXY).toBe('');
    expect(env.HTTPS_PROXY).toBe('');
  });

  it('omits env when proxyUrl is undefined and no existing env', () => {
    const config = buildSaveConfig(null, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      textModel: 'gpt-4o',
    });

    expect(config.env).toBeUndefined();
  });

  it('strips trailing slashes from baseUrl', () => {
    const config = buildSaveConfig(null, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1///',
      apiKey: 'sk-test',
      textModel: 'gpt-4o',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.openai.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('strips /chat/completions from baseUrl', () => {
    const config = buildSaveConfig(null, {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: 'sk-test',
      textModel: 'google/gemini-3.1-pro-preview',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('preserves existing API key when no new key provided', () => {
    const existing = {
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-old-key' },
        },
      },
    };

    const config = buildSaveConfig(existing, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      textModel: 'gpt-4o',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.openai.apiKey).toBe('sk-old-key');
  });

  it('does not create separate provider when vision is disabled', () => {
    const config = buildSaveConfig(null, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      textModel: 'gpt-4o',
      visionEnabled: false,
      visionProvider: 'zai',
      visionModel: 'glm-4.6v',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(Object.keys(providers)).toEqual(['openai']);

    const defaults = (config.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    // When vision disabled, imageModel = text model
    expect((defaults.imageModel as Record<string, string>).primary).toBe('openai/gpt-4o');
  });

  it('falls back to text provider apiKey for vision when visionApiKey is not set', () => {
    const config = buildSaveConfig(null, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-shared',
      textModel: 'gpt-4o',
      visionEnabled: true,
      visionProvider: 'zai',
      visionModel: 'glm-4.6v',
      visionBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.zai.apiKey).toBe('sk-shared');
  });

  // --- New tests: stale provider cleanup ---

  it('removes stale providers not referenced by user input', () => {
    const existing = {
      models: {
        providers: {
          rc: { baseUrl: 'http://old.example.com', apiKey: 'old-key' },
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-old' },
        },
      },
      agents: { defaults: { model: { primary: 'rc/old-model' } } },
    };

    const config = buildSaveConfig(existing, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-new',
      textModel: 'gpt-4o',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.rc).toBeUndefined();
    expect(providers.openai).toBeDefined();
    expect(Object.keys(providers)).toEqual(['openai']);
  });

  // --- New tests: config preservation ---

  it('preserves heartbeat and other agent settings from existing config', () => {
    const existing = {
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4o' },
          heartbeat: { every: '5m' },
        },
      },
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-old' },
        },
      },
    };

    const config = buildSaveConfig(existing, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-new',
      textModel: 'gpt-4o',
    });

    const defaults = (config.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect((defaults.heartbeat as Record<string, string>).every).toBe('5m');
    expect((defaults.model as Record<string, string>).primary).toBe('openai/gpt-4o');
  });

  // --- New tests: sentinel round-trip ---

  it('preserves redacted sentinel when no new key is provided', () => {
    const existing = {
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: REDACTED_SENTINEL },
        },
      },
    };

    const config = buildSaveConfig(existing, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      textModel: 'gpt-4o',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.openai.apiKey).toBe(REDACTED_SENTINEL);
  });

  // --- New tests: contextWindow / maxTokens from presets ---

  it('uses preset contextWindow and maxTokens for known models', () => {
    const config = buildSaveConfig(null, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      textModel: 'glm-5',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    const models = providers.zai.models as Array<{ id: string; contextWindow: number; maxTokens: number }>;
    expect(models[0].contextWindow).toBe(204_800);
    expect(models[0].maxTokens).toBe(131_072);
  });

  it('uses default contextWindow/maxTokens for unknown models', () => {
    const config = buildSaveConfig(null, {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      textModel: 'some/unknown-model',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    const models = providers.openrouter.models as Array<{ id: string; contextWindow: number; maxTokens: number }>;
    expect(models[0].contextWindow).toBe(128_000);
    expect(models[0].maxTokens).toBe(16_384);
  });

  // --- New tests: reasoning flag ---

  it('passes through reasoning flag for known models', () => {
    const config = buildSaveConfig(null, {
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      textModel: 'glm-5',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    const models = providers.zai.models as Array<{ id: string; reasoning: boolean }>;
    expect(models[0].reasoning).toBe(true);
  });

  it('defaults reasoning to false for unknown models', () => {
    const config = buildSaveConfig(null, {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      textModel: 'some/unknown-model',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    const models = providers.openrouter.models as Array<{ id: string; reasoning: boolean }>;
    expect(models[0].reasoning).toBe(false);
  });

  // --- Preserves existing env when proxyUrl undefined ---

  it('preserves existing env when proxyUrl is undefined', () => {
    const existing = {
      env: { CUSTOM_VAR: 'hello' },
    };

    const config = buildSaveConfig(existing, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      textModel: 'gpt-4o',
    });

    const env = config.env as Record<string, string>;
    expect(env.CUSTOM_VAR).toBe('hello');
  });

  // --- Vision provider preserves existing API key ---

  it('preserves existing vision provider API key when no new keys provided', () => {
    const existing = {
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-text-old' },
          zai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-vision-old' },
        },
      },
    };

    const config = buildSaveConfig(existing, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      textModel: 'gpt-4o',
      visionEnabled: true,
      visionProvider: 'zai',
      visionModel: 'glm-4.6v',
      visionBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    });

    const providers = (config.models as Record<string, unknown>).providers as Record<string, Record<string, unknown>>;
    expect(providers.openai.apiKey).toBe('sk-text-old');
    expect(providers.zai.apiKey).toBe('sk-vision-old');
  });
});

describe('extractConfigFields', () => {
  it('returns empty fields for null config', () => {
    const fields = extractConfigFields(null);
    expect(fields.baseUrl).toBe('');
    expect(fields.apiKey).toBe('');
    expect(fields.apiKeyConfigured).toBe(false);
    expect(fields.textModel).toBe('');
    expect(fields.visionEnabled).toBe(false);
    expect(fields.visionApiKeyConfigured).toBe(false);
    expect(fields.provider).toBe('custom');
  });

  it('extracts single-provider config with native key', () => {
    const config = {
      agents: { defaults: { model: { primary: 'openai/gpt-4o' } } },
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.provider).toBe('openai');
    expect(fields.baseUrl).toBe('https://api.openai.com/v1');
    expect(fields.apiKey).toBe('sk-test');
    expect(fields.textModel).toBe('gpt-4o');
    expect(fields.visionEnabled).toBe(false);
  });

  it('extracts dual-provider config with native keys', () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4o' },
          imageModel: { primary: 'zai/glm-4.6v' },
        },
      },
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-text', api: 'openai-completions' },
          zai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-vision', api: 'openai-completions' },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.provider).toBe('openai');
    expect(fields.textModel).toBe('gpt-4o');
    expect(fields.visionEnabled).toBe(true);
    expect(fields.visionProvider).toBe('zai');
    expect(fields.visionModel).toBe('glm-4.6v');
    expect(fields.visionBaseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(fields.visionApiKey).toBe('sk-vision');
    expect(fields.visionApi).toBe('openai-completions');
  });

  it('extracts same-provider vision config', () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4o' },
          imageModel: { primary: 'openai/gpt-4o-vision' },
        },
      },
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.provider).toBe('openai');
    expect(fields.visionEnabled).toBe(true);
    expect(fields.visionProvider).toBe('openai');
    expect(fields.visionModel).toBe('gpt-4o-vision');
    // Same provider → vision baseUrl comes from text provider
    expect(fields.visionBaseUrl).toBe('https://api.openai.com/v1');
    expect(fields.visionApiKey).toBe('');
  });

  it('extracts visionApi from dual-provider config with different protocols', () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: 'minimax/MiniMax-M2.5' },
          imageModel: { primary: 'zai/glm-4.6v' },
        },
      },
      models: {
        providers: {
          minimax: { baseUrl: 'https://api.minimax.io/anthropic', api: 'anthropic-messages' },
          zai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.api).toBe('anthropic-messages');
    expect(fields.visionApi).toBe('openai-completions');
  });

  it('strips __OPENCLAW_REDACTED__ sentinel from apiKey but marks as configured', () => {
    const config = {
      agents: { defaults: { model: { primary: 'openai/gpt-4o' } } },
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: REDACTED_SENTINEL },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.baseUrl).toBe('https://api.openai.com/v1');
    expect(fields.apiKey).toBe('');
    expect(fields.apiKeyConfigured).toBe(true);
    expect(fields.textModel).toBe('gpt-4o');
  });

  it('strips __OPENCLAW_REDACTED__ sentinel from visionApiKey but marks as configured', () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4o' },
          imageModel: { primary: 'zai/glm-4.6v' },
        },
      },
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: REDACTED_SENTINEL },
          zai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: REDACTED_SENTINEL },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.apiKey).toBe('');
    expect(fields.apiKeyConfigured).toBe(true);
    expect(fields.visionApiKey).toBe('');
    expect(fields.visionApiKeyConfigured).toBe(true);
    expect(fields.baseUrl).toBe('https://api.openai.com/v1');
    expect(fields.visionBaseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('marks apiKeyConfigured false when no apiKey in provider', () => {
    const config = {
      agents: { defaults: { model: { primary: 'ollama/llama3' } } },
      models: {
        providers: {
          ollama: { baseUrl: 'http://localhost:11434' },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.apiKey).toBe('');
    expect(fields.apiKeyConfigured).toBe(false);
  });

  it('marks apiKeyConfigured true when apiKey has actual value', () => {
    const config = {
      agents: { defaults: { model: { primary: 'openai/gpt-4o' } } },
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real-key' },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.apiKey).toBe('sk-real-key');
    expect(fields.apiKeyConfigured).toBe(true);
  });

  it('extracts proxy from env', () => {
    const config = {
      agents: { defaults: { model: { primary: 'openai/gpt-4o' } } },
      models: { providers: { openai: { baseUrl: 'https://api.openai.com' } } },
      env: { HTTP_PROXY: 'http://127.0.0.1:7890' },
    };

    const fields = extractConfigFields(config);
    expect(fields.proxyUrl).toBe('http://127.0.0.1:7890');
  });

  it('handles multi-segment model refs (e.g. openrouter)', () => {
    const config = {
      agents: { defaults: { model: { primary: 'openrouter/google/gemini-3.1-pro-preview' } } },
      models: {
        providers: {
          openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.provider).toBe('openrouter');
    expect(fields.textModel).toBe('google/gemini-3.1-pro-preview');
  });

  it('vision not enabled when imageModel equals text model', () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4o' },
          imageModel: { primary: 'openai/gpt-4o' },
        },
      },
      models: {
        providers: {
          openai: { baseUrl: 'https://api.openai.com/v1' },
        },
      },
    };

    const fields = extractConfigFields(config);
    expect(fields.visionEnabled).toBe(false);
    expect(fields.visionModel).toBe('');
  });
});

describe('isConfigValid', () => {
  it('returns false for null', () => {
    expect(isConfigValid(null)).toBe(false);
  });

  it('returns false when no model primary', () => {
    expect(isConfigValid({ agents: { defaults: {} } })).toBe(false);
  });

  it('returns false when provider missing', () => {
    expect(isConfigValid({
      agents: { defaults: { model: { primary: 'openai/gpt-4o' } } },
      models: { providers: {} },
    })).toBe(false);
  });

  it('returns true when model + provider match', () => {
    expect(isConfigValid({
      agents: { defaults: { model: { primary: 'openai/gpt-4o' } } },
      models: { providers: { openai: { baseUrl: 'https://api.openai.com' } } },
    })).toBe(true);
  });

  it('returns true with native zai provider', () => {
    expect(isConfigValid({
      agents: { defaults: { model: { primary: 'zai/glm-5' } } },
      models: { providers: { zai: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' } } },
    })).toBe(true);
  });
});

describe('hasModelConfigured', () => {
  it('returns false for null', () => {
    expect(hasModelConfigured(null)).toBe(false);
  });

  it('returns false for empty config', () => {
    expect(hasModelConfigured({})).toBe(false);
  });

  it('returns false when no model primary', () => {
    expect(hasModelConfigured({ agents: { defaults: {} } })).toBe(false);
  });

  it('returns false when primary has no provider prefix', () => {
    expect(hasModelConfigured({
      agents: { defaults: { model: { primary: 'gpt-4o' } } },
    })).toBe(false);
  });

  it('returns true when primary has provider/model format', () => {
    expect(hasModelConfigured({
      agents: { defaults: { model: { primary: 'openai/gpt-4o' } } },
    })).toBe(true);
  });

  it('returns true even without matching provider entry (relaxed check)', () => {
    expect(hasModelConfigured({
      agents: { defaults: { model: { primary: 'openai/gpt-4o' } } },
      models: { providers: {} },
    })).toBe(true);
  });

  it('returns true for multi-segment model refs', () => {
    expect(hasModelConfigured({
      agents: { defaults: { model: { primary: 'openrouter/google/gemini-3.1-pro-preview' } } },
    })).toBe(true);
  });
});
