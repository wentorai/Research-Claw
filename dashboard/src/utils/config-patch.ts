/**
 * Build & parse OpenClaw config for the dashboard.
 *
 * Uses config.apply (full replacement + restart) instead of config.patch
 * (deep merge) so that stale providers are cleaned up, all model metadata
 * (contextWindow, maxTokens, reasoning) comes from presets, and the
 * gateway's restoreRedactedValues() handles API key round-trips.
 *
 * Uses OpenClaw's native provider keys (e.g. 'zai', 'openai', 'anthropic')
 * so that ProviderCapabilities and imageModel fallback logic work correctly.
 */

import { getPreset } from './provider-presets';

/** Sentinel value OpenClaw uses to redact secrets in resolved config */
export const REDACTED_SENTINEL = '__OPENCLAW_REDACTED__';

export interface ConfigPatchInput {
  /** OpenClaw native provider key (e.g. 'zai', 'openai', 'anthropic') */
  provider: string;
  baseUrl: string;
  /** API protocol: 'openai-completions' | 'anthropic-messages' | etc. */
  api?: string;
  /** Omit or empty → preserve existing key via sentinel round-trip */
  apiKey?: string;
  textModel: string;
  visionEnabled?: boolean;
  /** Native provider key for vision (may equal text provider) */
  visionProvider?: string;
  visionModel?: string;
  /** When vision uses a different provider, its baseUrl */
  visionBaseUrl?: string;
  visionApiKey?: string;
  /** API protocol for the vision provider */
  visionApi?: string;
  /** undefined = don't touch env, "" = clear proxy, "http://..." = set proxy */
  proxyUrl?: string;
  /** Hint: the gateway reported an API key is configured (even if redacted).
   *  Used as fallback to emit the sentinel when resolveExistingApiKey fails. */
  apiKeyConfigured?: boolean;
  /** Same hint for the vision provider */
  visionApiKeyConfigured?: boolean;
}

export interface ExtractedConfig {
  /** Detected native provider key */
  provider: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  /** True when the gateway has an API key configured (even if redacted) */
  apiKeyConfigured: boolean;
  textModel: string;
  visionEnabled: boolean;
  visionProvider: string;
  visionModel: string;
  visionBaseUrl: string;
  visionApiKey: string;
  /** True when the gateway has a vision API key configured (even if redacted) */
  visionApiKeyConfigured: boolean;
  visionApi: string;
  proxyUrl: string;
}

function cleanUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

/**
 * Resolve full model definition from provider presets.
 * Returns all metadata fields (input, contextWindow, maxTokens, reasoning).
 *
 * Uses the preset's actual `input` capability so that OpenClaw's model routing
 * works correctly:
 *   - Text-only primary model → detectAndLoadPromptImages skips images →
 *     agent uses `/image` tool with imageModel (e.g. glm-4.6v) instead.
 *   - Vision-capable primary model → images sent inline to the primary model.
 *
 * Unknown models (not in preset) default to ['text', 'image'] so that custom
 * models don't silently drop images.
 */
function resolveModelDef(provider: string, modelId: string): Record<string, unknown> {
  const preset = getPreset(provider);
  const known = preset.models.find((m) => m.id === modelId);
  return {
    id: modelId,
    name: modelId,
    reasoning: known?.reasoning ?? false,
    input: known?.input ?? ['text', 'image'],
    contextWindow: known?.contextWindow ?? 128_000,
    maxTokens: known?.maxTokens ?? 16_384,
  };
}

/**
 * Resolve the existing API key from project config for a given provider.
 * Returns the key (may be REDACTED_SENTINEL) or undefined if not found.
 */
function resolveExistingApiKey(
  projectConfig: Record<string, unknown> | null,
  providerKey: string,
): string | undefined {
  if (!projectConfig) return undefined;
  const providers = (projectConfig.models as Record<string, unknown> | undefined)
    ?.providers as Record<string, Record<string, unknown>> | undefined;
  const key = providers?.[providerKey]?.apiKey;
  return typeof key === 'string' ? key : undefined;
}

/**
 * Build the complete project-level config by merging user edits into
 * the current project config.
 *
 * This produces a full config ready for config.apply (not a partial patch).
 * Only providers referenced by the user appear in the output — stale
 * providers (e.g. old 'rc') are naturally excluded.
 *
 * API keys: when the user doesn't supply a new key, the existing key
 * (which may be __OPENCLAW_REDACTED__) is preserved. The gateway's
 * restoreRedactedValues() restores sentinels to real values on write.
 */
/**
 * RC-specific config fields that must survive a config.apply round-trip.
 * When currentConfig is null (e.g. config.get returned valid:false due to CWD drift),
 * these defaults prevent RC functionality (plugins, skills, tools, dashboard) from
 * being erased. Values here use relative paths — run.sh resolves them to absolute
 * before gateway startup.
 */
const RC_CONFIG_DEFAULTS: Record<string, unknown> = {
  ui: { assistant: { name: 'Research-Claw' } },
  agents: {
    defaults: {
      workspace: './workspace',
      skipBootstrap: true,
      compaction: { mode: 'safeguard' },
      thinkingDefault: 'medium',
      subagents: { announceTimeoutMs: 480000 },
    },
  },
  gateway: {
    port: 28789,
    mode: 'local',
    bind: 'loopback',
    controlUi: {
      root: './dashboard/dist',
      allowedOrigins: [
        'http://127.0.0.1:28789', 'http://localhost:28789',
        'http://127.0.0.1:5175', 'http://localhost:5175',
      ],
    },
    auth: { mode: 'none' },
  },
  skills: { load: { extraDirs: ['./skills'] } },
  plugins: {
    enabled: true,
    load: { paths: ['./extensions/research-claw-core'] },
    entries: {
      'research-claw-core': {
        enabled: true,
        config: {
          dbPath: '.research-claw/library.db',
          autoTrackGit: true,
          defaultCitationStyle: 'apa',
          heartbeatDeadlineWarningHours: 48,
        },
      },
    },
  },
  tools: {
    profile: 'full',
    alsoAllow: [
      'library_add_paper', 'library_search', 'library_update_paper', 'library_get_paper',
      'library_export_bibtex', 'library_reading_stats', 'library_batch_add',
      'library_manage_collection', 'library_tag_paper', 'library_add_note',
      'library_import_bibtex', 'library_citation_graph',
      'task_create', 'task_list', 'task_complete', 'task_update',
      'task_link', 'task_note', 'task_link_file', 'cron_update_schedule', 'send_notification',
      'workspace_save', 'workspace_read', 'workspace_list', 'workspace_diff',
      'workspace_history', 'workspace_restore', 'workspace_move',
      'monitor_create', 'monitor_list', 'monitor_report', 'monitor_get_context', 'monitor_note',
      'library_import_ris', 'library_zotero_detect', 'library_zotero_import',
      'library_endnote_detect', 'library_endnote_import',
      'get_paper', 'get_citations',
      'search_openalex', 'get_work', 'get_author_openalex',
      'resolve_doi', 'search_crossref', 'search_arxiv', 'get_arxiv_paper',
      'search_pubmed', 'get_article', 'find_oa_version',
    ],
    sessions: { visibility: 'all' },
  },
  commands: { native: 'auto', nativeSkills: 'auto', restart: true, ownerDisplay: 'raw' },
  cron: { enabled: true },
};

export function buildSaveConfig(
  currentConfig: Record<string, unknown> | null,
  input: ConfigPatchInput,
): Record<string, unknown> {
  // When currentConfig is null (config.get returned valid:false), use RC defaults
  // to prevent plugins/skills/tools/gateway fields from being erased.
  const base = currentConfig
    ? structuredClone(currentConfig)
    : structuredClone(RC_CONFIG_DEFAULTS);

  const providerKey = input.provider;
  const baseUrl = cleanUrl(input.baseUrl);
  const apiType = input.api || 'openai-completions';

  const hasVision = !!input.visionEnabled && !!input.visionModel;
  const visionProviderKey = input.visionProvider || providerKey;
  const useSeparateProvider = hasVision && visionProviderKey !== providerKey;

  // --- Text provider entry ---
  const textModels = [resolveModelDef(providerKey, input.textModel)];

  // Same provider, different vision model → add to same provider entry
  if (hasVision && !useSeparateProvider && input.visionModel !== input.textModel) {
    textModels.push(resolveModelDef(providerKey, input.visionModel!));
  }

  const textProvider: Record<string, unknown> = {
    baseUrl,
    api: apiType,
    models: textModels,
  };

  // API key: use new value if provided, otherwise preserve existing (may be sentinel).
  // Defensive fallback: if resolveExistingApiKey can't find the key (e.g., OC
  // normalized the config structure), emit REDACTED_SENTINEL so restoreRedactedValues
  // can restore the real key from the gateway's in-memory copy.
  if (input.apiKey) {
    textProvider.apiKey = input.apiKey;
  } else {
    const existing = resolveExistingApiKey(currentConfig, providerKey);
    if (existing) {
      textProvider.apiKey = existing;
    } else if (input.apiKeyConfigured) {
      textProvider.apiKey = REDACTED_SENTINEL;
    }
  }

  const providers: Record<string, unknown> = {
    [providerKey]: textProvider,
  };

  // --- Vision provider entry (only when using a different provider) ---
  if (useSeparateProvider) {
    const visionEntry: Record<string, unknown> = {
      baseUrl: cleanUrl(input.visionBaseUrl || input.baseUrl),
      api: input.visionApi || apiType,
      models: [resolveModelDef(visionProviderKey, input.visionModel!)],
    };

    if (input.visionApiKey) {
      visionEntry.apiKey = input.visionApiKey;
    } else if (input.apiKey) {
      visionEntry.apiKey = input.apiKey;
    } else {
      const existing = resolveExistingApiKey(currentConfig, visionProviderKey);
      if (existing) {
        visionEntry.apiKey = existing;
      } else if (input.visionApiKeyConfigured) {
        visionEntry.apiKey = REDACTED_SENTINEL;
      }
    }

    providers[visionProviderKey] = visionEntry;
  }

  // --- Agent model refs ---
  const visionRef = hasVision
    ? `${visionProviderKey}/${input.visionModel}`
    : `${providerKey}/${input.textModel}`;

  // Preserve existing agent defaults (heartbeat, models aliases, etc.)
  const existingAgents = base.agents as Record<string, unknown> | undefined;
  const existingDefaults = existingAgents?.defaults as Record<string, unknown> | undefined;
  const defaults: Record<string, unknown> = {
    ...existingDefaults,
    model: { primary: `${providerKey}/${input.textModel}` },
    imageModel: { primary: visionRef },
  };

  // --- Build full config ---
  const result: Record<string, unknown> = { ...base };
  result.agents = { ...existingAgents, defaults };
  result.models = { providers };

  if (input.proxyUrl !== undefined) {
    result.env = {
      ...(base.env as Record<string, string> | undefined),
      HTTP_PROXY: input.proxyUrl,
      HTTPS_PROXY: input.proxyUrl,
    };
  } else if (base.env !== undefined) {
    result.env = base.env;
  }

  return result;
}

/**
 * Extract user-facing fields from an OpenClaw gateway config snapshot.
 */
export function extractConfigFields(
  config: Record<string, unknown> | null,
): ExtractedConfig {
  const empty: ExtractedConfig = {
    provider: 'custom',
    baseUrl: '',
    api: 'openai-completions',
    apiKey: '',
    apiKeyConfigured: false,
    textModel: '',
    visionEnabled: false,
    visionProvider: 'custom',
    visionModel: '',
    visionBaseUrl: '',
    visionApiKey: '',
    visionApiKeyConfigured: false,
    visionApi: 'openai-completions',
    proxyUrl: '',
  };
  if (!config) return empty;

  // --- Model refs ---
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const modelDef = defaults?.model as { primary?: string } | undefined;
  const imageModelDef = defaults?.imageModel as { primary?: string } | undefined;

  const primary = modelDef?.primary ?? '';
  const imagePrimary = imageModelDef?.primary ?? '';

  const providerOf = (ref: string) =>
    ref.includes('/') ? ref.split('/')[0] : '';
  const modelOf = (ref: string) =>
    ref.includes('/') ? ref.split('/').slice(1).join('/') : ref;

  const textProviderKey = providerOf(primary) || 'custom';
  const textModelId = modelOf(primary);

  const visionProviderKey = providerOf(imagePrimary) || textProviderKey;
  const visionModelId = modelOf(imagePrimary);

  // Vision is enabled when imageModel exists and differs from text model
  const visionEnabled = !!visionModelId &&
    (visionProviderKey !== textProviderKey || visionModelId !== textModelId);

  // --- Providers ---
  const providers = (config.models as Record<string, unknown> | undefined)
    ?.providers as Record<string, Record<string, unknown>> | undefined;

  const textProviderDef = providers?.[textProviderKey];
  const visionProviderDef = visionProviderKey !== textProviderKey
    ? providers?.[visionProviderKey]
    : undefined;

  // --- Proxy ---
  const env = config.env as Record<string, string> | undefined;
  const proxyUrl = env?.HTTP_PROXY || env?.HTTPS_PROXY || '';

  const deRedact = (v: unknown): string => {
    const s = (v as string) ?? '';
    return s === REDACTED_SENTINEL ? '' : s;
  };

  const apiKeyRaw = textProviderDef?.apiKey;
  const visionApiKeyRaw = visionProviderDef?.apiKey;

  return {
    provider: textProviderKey,
    baseUrl: (textProviderDef?.baseUrl as string) ?? '',
    api: (textProviderDef?.api as string) ?? 'openai-completions',
    apiKey: deRedact(apiKeyRaw),
    apiKeyConfigured: typeof apiKeyRaw === 'string' && apiKeyRaw.length > 0,
    textModel: textModelId,
    visionEnabled,
    visionProvider: visionProviderKey,
    visionModel: visionEnabled ? visionModelId : '',
    visionBaseUrl: visionEnabled
      ? (visionProviderDef?.baseUrl as string) ?? (textProviderDef?.baseUrl as string) ?? ''
      : '',
    visionApiKey: visionProviderDef ? deRedact(visionApiKeyRaw) : '',
    visionApiKeyConfigured: typeof visionApiKeyRaw === 'string' && visionApiKeyRaw.length > 0,
    visionApi: (visionProviderDef?.api as string) ?? (textProviderDef?.api as string) ?? 'openai-completions',
    proxyUrl,
  };
}

/**
 * Check if a gateway config has a valid model + matching provider.
 * Strict validation: requires both model ref AND a matching provider entry.
 */
export function isConfigValid(config: Record<string, unknown> | null): boolean {
  if (!config) return false;

  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const modelDef = defaults?.model as { primary?: string } | undefined;
  const primary = modelDef?.primary ?? '';
  if (!primary) return false;

  const providerKey = primary.includes('/') ? primary.split('/')[0] : '';
  if (!providerKey) return false;

  const providers = (config.models as Record<string, unknown> | undefined)
    ?.providers as Record<string, Record<string, unknown>> | undefined;
  return !!providers?.[providerKey];
}

/**
 * Relaxed config check: only verifies that a model reference exists.
 * Used as a fallback when the gateway is running (hello-ok received)
 * but strict validation fails due to resolved config structure differences.
 */
export function hasModelConfigured(config: Record<string, unknown> | null): boolean {
  if (!config) return false;
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const modelDef = defaults?.model as { primary?: string } | undefined;
  const primary = modelDef?.primary ?? '';
  return primary.length > 0 && primary.includes('/');
}
