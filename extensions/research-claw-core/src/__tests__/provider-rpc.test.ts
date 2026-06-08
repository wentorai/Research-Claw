import { describe, expect, it, vi } from 'vitest';
import { registerProviderRpc } from '../provider/rpc.js';
import type { RegisterMethod } from '../types.js';

interface TestProviderConfig {
  baseUrl: string;
  api: string;
  models: Array<{ id: string; name: string; api?: string }>;
}

interface TestDesiredConfig {
  agents: {
    defaults: {
      model: { primary: string };
      imageModel: { primary: string };
    };
  };
  models: {
    providers: Record<string, TestProviderConfig>;
  };
  env: { HTTP_PROXY: string; HTTPS_PROXY: string };
}

function desiredConfig(): TestDesiredConfig {
  return {
    agents: {
      defaults: {
        model: { primary: 'openai/gpt-5' },
        imageModel: { primary: 'openai/gpt-5' },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          api: 'openai-completions',
          models: [{ id: 'gpt-5', name: 'gpt-5' }],
        },
      },
    },
    env: { HTTP_PROXY: '', HTTPS_PROXY: '' },
  };
}

function setup() {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>();
  const config: Record<string, unknown> = {
    gateway: { port: 28789 },
    agents: { defaults: { model: { primary: 'old/model' } }, list: [{ id: 'main' }] },
  };
  const mutateConfigFile = vi.fn(async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
    mutate(config);
    return { path: '/tmp/openclaw.json', persistedHash: 'hash' };
  });
  const registerMethod: RegisterMethod = (method, handler) => handlers.set(method, handler);

  registerProviderRpc(registerMethod, {
    config: {
      current: () => config,
      mutateConfigFile,
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    setApiKey: vi.fn(),
    clearApiKey: vi.fn(),
  });
  return { handlers, config, mutateConfigFile };
}

describe('provider RPC', () => {
  it('validates a structurally complete provider config', async () => {
    const { handlers } = setup();
    const result = await handlers.get('rc.provider.validate')!({
      desiredConfig: desiredConfig(),
      probe: false,
    }) as { ok: boolean; provider: string; model: string };

    expect(result).toMatchObject({ ok: true, provider: 'openai', model: 'gpt-5' });
  });

  it('persists only provider-owned config surfaces and preserves unrelated config', async () => {
    const { handlers, config, mutateConfigFile } = setup();
    await handlers.get('rc.provider.upsert')!({
      desiredConfig: desiredConfig(),
      operationId: 'op-1',
    });

    expect(mutateConfigFile).toHaveBeenCalledWith(expect.objectContaining({
      afterWrite: { mode: 'auto' },
    }));
    expect(config.gateway).toEqual({ port: 28789 });
    expect((config.agents as Record<string, unknown>).list).toEqual([{ id: 'main' }]);
    expect(config.models).toEqual(desiredConfig().models);
  });

  it('migrates the legacy OpenAI Codex protocol before persisting', async () => {
    const { handlers, config } = setup();
    const desired = desiredConfig();
    desired.agents.defaults.model.primary = 'openai-codex/gpt-5.4';
    desired.models.providers = {
      'openai-codex': {
        baseUrl: 'https://chatgpt.com/backend-api',
        api: 'openai-codex-responses',
        models: [{ id: 'gpt-5.4', name: 'gpt-5.4', api: 'openai-codex-responses' }],
      },
    };

    await handlers.get('rc.provider.upsert')!({ desiredConfig: desired });

    const providers = (config.models as { providers: Record<string, {
      api: string;
      models: Array<{ api: string }>;
    }> }).providers;
    expect(providers['openai-codex'].api).toBe('openai-chatgpt-responses');
    expect(providers['openai-codex'].models[0].api).toBe('openai-chatgpt-responses');
  });

  it('activates a provider without replacing provider inventory', async () => {
    const { handlers, config } = setup();
    config.models = desiredConfig().models;

    await handlers.get('rc.provider.activate')!({
      primary: 'openai/gpt-5',
      imagePrimary: 'openai/gpt-5-vision',
    });

    const defaults = ((config.agents as Record<string, unknown>).defaults as Record<string, unknown>);
    expect(defaults.model).toEqual({ primary: 'openai/gpt-5' });
    expect(defaults.imageModel).toEqual({ primary: 'openai/gpt-5-vision' });
    expect(config.models).toEqual(desiredConfig().models);
  });
});
