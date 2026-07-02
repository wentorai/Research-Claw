import { describe, expect, it, vi } from 'vitest';
import { registerProviderRpc } from '../provider/rpc.js';
import type { RegisterMethod } from '../types.js';

interface TestProviderConfig {
  baseUrl: string;
  api: string;
  apiKey?: string;
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

  it('preserves existing real API key when the desired config omits it', async () => {
    const { handlers, config } = setup();
    const current = desiredConfig();
    current.models.providers.openai.apiKey = 'sk-existing';
    config.models = current.models;

    const desired = desiredConfig();
    delete desired.models.providers.openai.apiKey;
    await handlers.get('rc.provider.upsert')!({ desiredConfig: desired });

    const providers = (config.models as TestDesiredConfig['models']).providers;
    expect(providers.openai.apiKey).toBe('sk-existing');
  });

  it('strips legacy redacted API key placeholders before persisting', async () => {
    const { handlers, config } = setup();
    const current = desiredConfig();
    current.models.providers.openai.apiKey = '__OPENCLAW_REDACTED__';
    config.models = current.models;

    const desired = desiredConfig();
    desired.models.providers.openai.apiKey = '__OPENCLAW_REDACTED__';
    await handlers.get('rc.provider.upsert')!({ desiredConfig: desired });

    const providers = (config.models as TestDesiredConfig['models']).providers;
    expect(providers.openai.apiKey).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('__OPENCLAW_REDACTED__');
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

interface ProbeResult {
  detected: string | null;
  reason: string;
  attempts: Array<{ protocol: string; endpoint: string; status: number | null; klass: string }>;
}

function mockFetchByStatus(map: Record<string, number | 'throw'>): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    for (const [needle, value] of Object.entries(map)) {
      if (url.includes(needle)) {
        if (value === 'throw') throw new Error('network down');
        return { ok: value >= 200 && value < 300, status: value } as Response;
      }
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  });
}

describe('rc.provider.probeProtocol', () => {
  const baseParams = {
    baseUrl: 'https://llm.test/v1',
    apiKey: 'sk-real-key',
    model: 'gpt-5',
  };

  it('detects openai-completions on /chat/completions 200 and short-circuits', async () => {
    const { handlers } = setup();
    const fetchMock = mockFetchByStatus({ '/chat/completions': 200 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await handlers.get('rc.provider.probeProtocol')!(baseParams) as ProbeResult;
      expect(result.detected).toBe('openai-completions');
      expect(result.reason).toBe('detected');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({ protocol: 'openai-completions', status: 200, klass: 'hit' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('detects anthropic-messages via /v1/messages 200 when order is anthropic-first', async () => {
    const { handlers } = setup();
    const fetchMock = mockFetchByStatus({ '/v1/messages': 200, '/chat/completions': 404 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await handlers.get('rc.provider.probeProtocol')!({
        baseUrl: 'https://llm.test/anthropic',
        apiKey: 'sk-real-key',
        model: 'claude-4',
        order: ['anthropic-messages', 'openai-completions'],
      }) as ProbeResult;
      expect(result.detected).toBe('anthropic-messages');
      expect(result.reason).toBe('detected');
      expect(result.attempts[0].endpoint).toContain('/v1/messages');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats 402 as a hit', async () => {
    const { handlers } = setup();
    const fetchMock = mockFetchByStatus({ '/chat/completions': 402 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await handlers.get('rc.provider.probeProtocol')!(baseParams) as ProbeResult;
      expect(result.detected).toBe('openai-completions');
      expect(result.attempts[0].klass).toBe('hit');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns no-protocol when all candidates 404', async () => {
    const { handlers } = setup();
    const fetchMock = mockFetchByStatus({
      '/chat/completions': 404,
      '/responses': 404,
      '/v1/messages': 404,
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await handlers.get('rc.provider.probeProtocol')!(baseParams) as ProbeResult;
      expect(result.detected).toBeNull();
      expect(result.reason).toBe('no-protocol');
      expect(result.attempts).toHaveLength(3);
      expect(result.attempts.every((a) => a.klass === 'absent')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns auth-failed when a candidate is 401', async () => {
    const { handlers } = setup();
    const fetchMock = mockFetchByStatus({
      '/chat/completions': 401,
      '/responses': 404,
      '/v1/messages': 404,
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await handlers.get('rc.provider.probeProtocol')!(baseParams) as ProbeResult;
      expect(result.detected).toBeNull();
      expect(result.reason).toBe('auth-failed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns network-error when every probe throws', async () => {
    const { handlers } = setup();
    const fetchMock = mockFetchByStatus({
      '/chat/completions': 'throw',
      '/responses': 'throw',
      '/v1/messages': 'throw',
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await handlers.get('rc.provider.probeProtocol')!(baseParams) as ProbeResult;
      expect(result.detected).toBeNull();
      expect(result.reason).toBe('network-error');
      expect(result.attempts.every((a) => a.klass === 'error')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns missing-key without probing when apiKey is empty', async () => {
    const { handlers } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await handlers.get('rc.provider.probeProtocol')!({
        ...baseParams,
        apiKey: '',
      }) as ProbeResult;
      expect(result).toEqual({ detected: null, reason: 'missing-key', attempts: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns missing-key without probing when apiKey is the redaction sentinel', async () => {
    const { handlers } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await handlers.get('rc.provider.probeProtocol')!({
        ...baseParams,
        apiKey: '__OPENCLAW_REDACTED__',
      }) as ProbeResult;
      expect(result.reason).toBe('missing-key');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a non-HTTP baseUrl as invalid-url', async () => {
    const { handlers } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await handlers.get('rc.provider.probeProtocol')!({
        ...baseParams,
        baseUrl: 'ftp://llm.test/v1',
      }) as ProbeResult;
      expect(result).toEqual({ detected: null, reason: 'invalid-url', attempts: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
