/**
 * Named custom API profiles — multiple relay / gateway configs under models.providers.
 * Each profile uses an independent provider key: `custom` (legacy) or `custom-{slug}`.
 */

import { extractProviderFieldsForEditor } from './config-patch';
import { PROVIDER_PRESETS } from './provider-presets';

const PRESET_IDS = new Set(PROVIDER_PRESETS.map((p) => p.id));

export interface CustomApiProfile {
  providerKey: string;
  label: string;
  baseUrl: string;
  api: string;
  textModel: string;
  apiKeyConfigured: boolean;
  isActive: boolean;
}

export interface NewCustomApiProfileInput {
  label: string;
  baseUrl: string;
  apiKey?: string;
  textModel: string;
  api: string;
}

/** Legacy single slot or named custom-* profiles (not bundled presets). */
export function isCustomApiProfileKey(providerKey: string): boolean {
  if (!providerKey) return false;
  if (providerKey === 'custom') return true;
  if (!providerKey.startsWith('custom-')) return false;
  return !PRESET_IDS.has(providerKey);
}

export function sanitizeProfileSlug(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'profile';
}

export function allocateProfileKey(label: string, existingKeys: Iterable<string>): string {
  const used = new Set(existingKeys);
  const base = `custom-${sanitizeProfileSlug(label)}`;
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `custom-${Date.now().toString(36)}`;
}

export function readProfileLabels(config: Record<string, unknown> | null): Record<string, string> {
  if (!config) return {};
  const ui = config.ui as Record<string, unknown> | undefined;
  const rc = ui?.researchClaw as Record<string, unknown> | undefined;
  const raw = rc?.customApiProfiles as Record<string, { label?: string }> | undefined;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, meta] of Object.entries(raw)) {
    if (typeof meta?.label === 'string' && meta.label.trim()) {
      out[key] = meta.label.trim();
    }
  }
  return out;
}

export function resolveCustomProfileLabel(
  providerKey: string,
  labels: Record<string, string>,
  t?: (key: string, opts?: { defaultValue?: string }) => string,
): string {
  if (labels[providerKey]) return labels[providerKey];
  if (providerKey === 'custom') {
    return t?.('settings.customProfileLegacy', { defaultValue: 'Custom gateway' }) ?? 'Custom gateway';
  }
  if (providerKey.startsWith('custom-')) {
    const slug = providerKey.slice('custom-'.length).replace(/-/g, ' ');
    return slug || providerKey;
  }
  return providerKey;
}

export function listCustomProfileProviderKeys(config: Record<string, unknown> | null): string[] {
  if (!config) return [];
  const providers = (config.models as Record<string, unknown> | undefined)
    ?.providers as Record<string, unknown> | undefined;
  if (!providers) return [];
  return Object.keys(providers).filter(isCustomApiProfileKey).sort((a, b) => {
    if (a === 'custom') return -1;
    if (b === 'custom') return 1;
    return a.localeCompare(b);
  });
}

export function listCustomApiProfiles(
  config: Record<string, unknown> | null,
  labels: Record<string, string> = readProfileLabels(config),
): CustomApiProfile[] {
  const keys = listCustomProfileProviderKeys(config);
  const agents = config?.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const primary = (defaults?.model as { primary?: string } | undefined)?.primary ?? '';
  const activeKey = primary.includes('/') ? primary.split('/')[0] : '';

  return keys.map((providerKey) => {
    const fields = extractProviderFieldsForEditor(config, providerKey);
    return {
      providerKey,
      label: resolveCustomProfileLabel(providerKey, labels),
      baseUrl: fields?.baseUrl ?? '',
      api: fields?.api ?? 'openai-completions',
      textModel: fields?.textModel ?? '',
      apiKeyConfigured: fields?.apiKeyConfigured ?? false,
      isActive: providerKey === activeKey,
    };
  });
}

export function resolveEditorProviderKey(
  providerKey: string,
  baseUrl?: string,
): string {
  if (isCustomApiProfileKey(providerKey)) return providerKey;
  const exact = PRESET_IDS.has(providerKey) ? providerKey : null;
  if (exact && exact !== 'custom') return exact;
  if (baseUrl) {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.urlPattern?.test(baseUrl)) return preset.id;
    }
  }
  return providerKey || 'custom';
}
