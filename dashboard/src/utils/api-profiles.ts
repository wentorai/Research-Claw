/**
 * Custom API profile helpers — multiple relay/gateway configs as separate
 * `models.providers.custom-*` entries (OpenClaw-native provider keys).
 */

import { getPreset, PROVIDER_PRESETS } from './provider-presets';
import { REDACTED_SENTINEL, resolveExistingApiKey } from './config-patch';
import { isOAuthProvider } from './oauth-providers';

export const API_PROFILE_PROVIDER_PREFIX = 'custom-';
export const LEGACY_CUSTOM_PROVIDER_ID = 'custom';

export interface ApiProfile {
  /** Provider key in models.providers (e.g. custom-relay-a). */
  id: string;
  /** User-facing label (from model.name or derived from id). */
  label: string;
  baseUrl: string;
  api: string;
  modelId: string;
  apiKeyConfigured: boolean;
  /** True when agents.defaults.model.primary uses this provider. */
  isActive: boolean;
  /** True for a configured preset provider (openai/deepseek/…), not a custom-* slot. */
  isBuiltin: boolean;
  /** False for OAuth providers (token lives gateway-side, no apiKey needed). */
  requiresApiKey: boolean;
}

const BUILTIN_PROVIDER_IDS = new Set(PROVIDER_PRESETS.map((p) => p.id));

export function isApiProfileProviderKey(providerKey: string): boolean {
  return providerKey === LEGACY_CUSTOM_PROVIDER_ID || providerKey.startsWith(API_PROFILE_PROVIDER_PREFIX);
}

export function isBuiltinProviderKey(providerKey: string): boolean {
  return BUILTIN_PROVIDER_IDS.has(providerKey as (typeof PROVIDER_PRESETS)[number]['id']);
}

export function slugifyProfileLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return 'profile';
  const ascii = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (ascii.length >= 2) return ascii;
  let hash = 0;
  for (const ch of trimmed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `p${hash.toString(36)}`;
}

export function profileIdToDisplayName(id: string): string {
  if (id === LEGACY_CUSTOM_PROVIDER_ID) return '';
  if (id.startsWith(API_PROFILE_PROVIDER_PREFIX)) {
    return id.slice(API_PROFILE_PROVIDER_PREFIX.length).replace(/-/g, ' ');
  }
  return id;
}

export function allocateProfileProviderId(label: string, existingKeys: string[]): string {
  const base = `${API_PROFILE_PROVIDER_PREFIX}${slugifyProfileLabel(label)}`;
  if (!existingKeys.includes(base)) return base;
  let n = 2;
  while (existingKeys.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Next custom profile slot — first profile uses `custom`, then `custom-profile`, `custom-profile-2`, … */
export function allocateNextProfileProviderId(existingKeys: Iterable<string>): string {
  const used = new Set(existingKeys);
  if (!used.has(LEGACY_CUSTOM_PROVIDER_ID)) return LEGACY_CUSTOM_PROVIDER_ID;
  const base = `${API_PROFILE_PROVIDER_PREFIX}profile`;
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
  return `${API_PROFILE_PROVIDER_PREFIX}${Date.now().toString(36)}`;
}

function getProvidersMap(
  config: Record<string, unknown> | null,
): Record<string, Record<string, unknown>> | undefined {
  return (config?.models as Record<string, unknown> | undefined)?.providers as
    | Record<string, Record<string, unknown>>
    | undefined;
}

function modelIdFromProviderEntry(
  providerId: string,
  entry: Record<string, unknown>,
  primaryRef: string,
): string {
  if (primaryRef.startsWith(`${providerId}/`)) {
    return primaryRef.slice(providerId.length + 1);
  }
  const models = entry.models as Array<{ id?: string }> | undefined;
  return models?.[0]?.id ?? '';
}

function labelFromProviderEntry(providerId: string, entry: Record<string, unknown>): string {
  const models = entry.models as Array<{ id?: string; name?: string }> | undefined;
  const name = models?.[0]?.name?.trim();
  if (name && name !== models?.[0]?.id) return name;
  const derived = profileIdToDisplayName(providerId);
  return derived || providerId;
}

export function listApiProfilesFromConfig(
  config: Record<string, unknown> | null,
): ApiProfile[] {
  if (!config) return [];

  const providers = getProvidersMap(config);
  if (!providers) return [];

  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const primary = ((defaults?.model as { primary?: string } | undefined)?.primary) ?? '';
  const activeProviderKey = primary.includes('/') ? primary.split('/')[0] : '';

  const profiles: ApiProfile[] = [];
  for (const [id, entry] of Object.entries(providers)) {
    const isCustom = isApiProfileProviderKey(id);
    const isBuiltin = isBuiltinProviderKey(id) && !isCustom;
    if (!isCustom && !isBuiltin) continue;

    // A provider is "configured" only once it carries at least one model. Skip
    // residual scaffolds so empty preset entries never surface as switchable.
    const models = entry.models as Array<{ id?: string }> | undefined;
    if (!Array.isArray(models) || models.length === 0) continue;

    const modelId = modelIdFromProviderEntry(id, entry, primary);
    const apiKeyRaw = entry.apiKey;
    const label = isBuiltin
      ? getPreset(id)?.label ?? labelFromProviderEntry(id, entry)
      : labelFromProviderEntry(id, entry) || '自定义 API';
    profiles.push({
      id,
      label,
      baseUrl: (entry.baseUrl as string) ?? '',
      api: (entry.api as string) ?? getPreset('custom').api,
      modelId,
      apiKeyConfigured: typeof apiKeyRaw === 'string' && apiKeyRaw.length > 0,
      isActive: id === activeProviderKey,
      isBuiltin,
      requiresApiKey: !isOAuthProvider(id),
    });
  }

  profiles.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
  return profiles;
}

export function getActiveModelPrimary(config: Record<string, unknown> | null): string {
  const agents = config?.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  return ((defaults?.model as { primary?: string } | undefined)?.primary) ?? '';
}

/** Collect non-active API profiles for restoreProviders on config.apply. */
export function collectApiProfileRestoreEntries(
  config: Record<string, unknown> | null,
  activeProvider: string,
  caches: {
    apiKeys: Record<string, string>;
    models: Record<string, string>;
  },
  excludeIds: string[] = [],
): Record<string, { modelId: string; apiKey: string }> {
  const out: Record<string, { modelId: string; apiKey: string }> = {};
  const exclude = new Set(excludeIds);
  const providers = getProvidersMap(config);
  if (!providers) return out;

  for (const [pId, entry] of Object.entries(providers)) {
    if (!isApiProfileProviderKey(pId)) continue;
    if (pId === activeProvider) continue;
    if (exclude.has(pId)) continue;

    const modelId =
      caches.models[pId] ||
      modelIdFromProviderEntry(pId, entry, getActiveModelPrimary(config)) ||
      getPreset('custom').models[0]?.id ||
      'default';
    if (!modelId) continue;

    const cachedKey = caches.apiKeys[pId]?.trim();
    const existing = resolveExistingApiKey(config, pId);
    const apiKey =
      cachedKey ||
      (existing && existing !== REDACTED_SENTINEL ? existing : '') ||
      (existing === REDACTED_SENTINEL ? REDACTED_SENTINEL : '');

    if (!apiKey && !(typeof entry.apiKey === 'string' && entry.apiKey.length > 0)) {
      continue;
    }

    out[pId] = { modelId, apiKey: apiKey || REDACTED_SENTINEL };
  }

  return out;
}
