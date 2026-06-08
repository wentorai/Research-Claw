import type { RegisterMethod } from '../types.js';

type ConfigRecord = Record<string, unknown>;

interface ProviderRuntimeConfigApi {
  current: () => ConfigRecord;
  mutateConfigFile: (params: {
    afterWrite: { mode: 'auto' };
    mutate: (draft: ConfigRecord) => void;
  }) => Promise<{
    path: string;
    persistedHash: string | null;
    afterWrite?: unknown;
    followUp?: unknown;
  }>;
}

interface ProviderRpcDeps {
  config: ProviderRuntimeConfigApi;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  setApiKey: (provider: string, apiKey: string) => unknown;
  clearApiKey: (provider: string) => unknown;
}

const ALLOWED_TOP_LEVEL_KEYS = ['models', 'env', 'tools'] as const;

function asRecord(value: unknown): ConfigRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ConfigRecord
    : undefined;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Accept configs produced by older Dashboard builds after OpenClaw renamed this API. */
function normalizeLegacyProviderApis(config: ConfigRecord): ConfigRecord {
  const normalized = clone(config);
  const models = asRecord(normalized.models);
  const providers = asRecord(models?.providers);
  if (!providers) return normalized;

  for (const providerValue of Object.values(providers)) {
    const provider = asRecord(providerValue);
    if (!provider) continue;
    if (provider.api === 'openai-codex-responses') {
      provider.api = 'openai-chatgpt-responses';
    }
    if (Array.isArray(provider.models)) {
      for (const modelValue of provider.models) {
        const model = asRecord(modelValue);
        if (model?.api === 'openai-codex-responses') {
          model.api = 'openai-chatgpt-responses';
        }
      }
    }
  }
  return normalized;
}

function readPrimary(config: ConfigRecord): string {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const model = asRecord(defaults?.model);
  return typeof model?.primary === 'string' ? model.primary : '';
}

function readImagePrimary(config: ConfigRecord): string {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const model = asRecord(defaults?.imageModel);
  return typeof model?.primary === 'string' ? model.primary : '';
}

function providerFromRef(ref: string): string {
  const idx = ref.indexOf('/');
  return idx > 0 ? ref.slice(0, idx) : '';
}

function getProvider(config: ConfigRecord, providerId: string): ConfigRecord | undefined {
  const models = asRecord(config.models);
  const providers = asRecord(models?.providers);
  return asRecord(providers?.[providerId]);
}

function validateDesiredConfig(desired: ConfigRecord): {
  ok: boolean;
  provider: string;
  model: string;
  issues: string[];
} {
  const primary = readPrimary(desired);
  const provider = providerFromRef(primary);
  const model = primary.includes('/') ? primary.slice(primary.indexOf('/') + 1) : '';
  const entry = getProvider(desired, provider);
  const issues: string[] = [];

  if (!primary || !provider || !model) issues.push('agents.defaults.model.primary must be provider/model');
  if (!entry) issues.push(`models.providers.${provider} is missing`);
  if (entry && typeof entry.baseUrl !== 'string') issues.push(`models.providers.${provider}.baseUrl is missing`);
  if (entry && !Array.isArray(entry.models)) issues.push(`models.providers.${provider}.models must be an array`);

  return { ok: issues.length === 0, provider, model, issues };
}

function applyDesiredProviderConfig(draft: ConfigRecord, desired: ConfigRecord): void {
  for (const key of ALLOWED_TOP_LEVEL_KEYS) {
    if (key in desired) draft[key] = clone(desired[key]);
  }

  const desiredAgents = asRecord(desired.agents);
  const desiredDefaults = asRecord(desiredAgents?.defaults);
  if (desiredDefaults) {
    const currentAgents = asRecord(draft.agents) ?? {};
    draft.agents = {
      ...currentAgents,
      defaults: clone(desiredDefaults),
    };
  }

  const desiredPlugins = asRecord(desired.plugins);
  const desiredEntries = asRecord(desiredPlugins?.entries);
  const desiredSupervisor = desiredEntries?.['dual-model-supervisor'];
  if (desiredSupervisor !== undefined) {
    const currentPlugins = asRecord(draft.plugins) ?? {};
    const currentEntries = asRecord(currentPlugins.entries) ?? {};
    draft.plugins = {
      ...currentPlugins,
      entries: {
        ...currentEntries,
        'dual-model-supervisor': clone(desiredSupervisor),
      },
    };
  }
}

async function probeProvider(desired: ConfigRecord): Promise<{
  attempted: boolean;
  reachable: boolean | null;
  message?: string;
}> {
  const validation = validateDesiredConfig(desired);
  if (!validation.ok) return { attempted: false, reachable: null };

  const entry = getProvider(desired, validation.provider);
  const baseUrl = typeof entry?.baseUrl === 'string' ? entry.baseUrl.replace(/\/+$/, '') : '';
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    return { attempted: false, reachable: null, message: 'Provider URL is not HTTP(S)' };
  }

  const apiKey = typeof entry?.apiKey === 'string' && entry.apiKey !== '__OPENCLAW_REDACTED__'
    ? entry.apiKey
    : '';
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    return {
      attempted: true,
      reachable: response.ok || response.status === 401 || response.status === 403 || response.status === 404,
      message: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      attempted: true,
      reachable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function registerProviderRpc(registerMethod: RegisterMethod, deps: ProviderRpcDeps): void {
  registerMethod('rc.provider.status', () => {
    const config = clone(deps.config.current());
    const primary = readPrimary(config);
    const imagePrimary = readImagePrimary(config);
    return {
      primary,
      imagePrimary,
      provider: providerFromRef(primary),
      configured: Boolean(getProvider(config, providerFromRef(primary))),
    };
  });

  registerMethod('rc.provider.validate', async (params) => {
    const desiredRaw = asRecord(params.desiredConfig);
    if (!desiredRaw) throw new Error('desiredConfig is required');
    const desired = normalizeLegacyProviderApis(desiredRaw);
    const validation = validateDesiredConfig(desired);
    const probe = params.probe === false ? { attempted: false, reachable: null } : await probeProvider(desired);
    return { ...validation, probe };
  });

  registerMethod('rc.provider.upsert', async (params) => {
    const desiredRaw = asRecord(params.desiredConfig);
    if (!desiredRaw) throw new Error('desiredConfig is required');
    const desired = normalizeLegacyProviderApis(desiredRaw);
    const validation = validateDesiredConfig(desired);
    if (!validation.ok) throw new Error(validation.issues.join('; '));

    const authActions = Array.isArray(params.authActions) ? params.authActions : [];
    for (const action of authActions) {
      const authAction = asRecord(action);
      const provider = typeof authAction?.provider === 'string' ? authAction.provider : '';
      if (!provider) throw new Error('authActions[].provider is required');
      if (authAction?.clear === true) {
        await deps.clearApiKey(provider);
      } else {
        const apiKey = typeof authAction?.apiKey === 'string' ? authAction.apiKey.trim() : '';
        if (!apiKey) throw new Error(`authActions apiKey is required for ${provider}`);
        await deps.setApiKey(provider, apiKey);
      }
    }

    const result = await deps.config.mutateConfigFile({
      afterWrite: { mode: 'auto' },
      mutate: (draft) => applyDesiredProviderConfig(draft, desired),
    });
    deps.logger.info(`Provider config persisted: ${validation.provider}/${validation.model}`);
    return {
      ok: true,
      operationId: typeof params.operationId === 'string' ? params.operationId : undefined,
      provider: validation.provider,
      model: validation.model,
      path: result.path,
      persistedHash: result.persistedHash,
      restartManagedByGateway: true,
    };
  });

  registerMethod('rc.provider.activate', async (params) => {
    const primary = typeof params.primary === 'string' ? params.primary.trim() : '';
    const imagePrimary = typeof params.imagePrimary === 'string' ? params.imagePrimary.trim() : primary;
    if (!providerFromRef(primary)) throw new Error('primary must be provider/model');

    const result = await deps.config.mutateConfigFile({
      afterWrite: { mode: 'auto' },
      mutate: (draft) => {
        const agents = asRecord(draft.agents) ?? {};
        const defaults = asRecord(agents.defaults) ?? {};
        draft.agents = {
          ...agents,
          defaults: {
            ...defaults,
            model: { ...asRecord(defaults.model), primary },
            imageModel: { ...asRecord(defaults.imageModel), primary: imagePrimary },
          },
        };
      },
    });
    return { ok: true, primary, imagePrimary, path: result.path, restartManagedByGateway: true };
  });

  registerMethod('rc.provider.delete', async (params) => {
    const desired = asRecord(params.desiredConfig);
    if (!desired) throw new Error('desiredConfig is required');
    const result = await deps.config.mutateConfigFile({
      afterWrite: { mode: 'auto' },
      mutate: (draft) => applyDesiredProviderConfig(draft, desired),
    });
    deps.logger.info('Provider profiles deleted through focused config mutation');
    return { ok: true, path: result.path, restartManagedByGateway: true };
  });
}
