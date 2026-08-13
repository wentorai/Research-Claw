import { create } from 'zustand';

import { parseProductPolicy, type ProductPolicy } from '../utils/profile-policy';
import { canOpenPanel, type PolicyPanelTab } from '../utils/profile-policy';

export type ProductPolicyStatus = 'pending' | 'ready' | 'error';

interface ProductPolicyState {
  status: ProductPolicyStatus;
  policy: ProductPolicy | null;
  error: string | null;
  publish: (policy: ProductPolicy) => void;
  fail: (error: unknown) => void;
  loadFromConfig: (config: Record<string, unknown>) => void;
  resetPending: () => void;
}

function policyValueFromConfig(config: Record<string, unknown>): unknown {
  const plugins = config.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return undefined;
  const entries = (plugins as Record<string, unknown>).entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return undefined;
  const core = (entries as Record<string, unknown>)['research-claw-core'];
  if (!core || typeof core !== 'object' || Array.isArray(core)) return undefined;
  const pluginConfig = (core as Record<string, unknown>).config;
  if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) return undefined;
  return (pluginConfig as Record<string, unknown>).productPolicy;
}

/** Pure extraction + validation. Callers can build a complete config snapshot
 * before publishing either store, preventing a ready policy over stale config. */
export function parseProductPolicyFromConfig(config: Record<string, unknown>): ProductPolicy {
  return parseProductPolicy(policyValueFromConfig(config));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid productPolicy';
}

export const useProductPolicyStore = create<ProductPolicyState>()((set) => ({
  status: 'pending',
  policy: null,
  error: null,

  publish: (policy) => set({ status: 'ready', policy, error: null }),

  fail: (error) => set({ status: 'error', policy: null, error: errorMessage(error) }),

  loadFromConfig: (config) => {
    try {
      const policy = parseProductPolicyFromConfig(config);
      set({ status: 'ready', policy, error: null });
    } catch (error) {
      set({ status: 'error', policy: null, error: errorMessage(error) });
      throw error;
    }
  },

  resetPending: () => set({ status: 'pending', policy: null, error: null }),
}));

export function currentProductPolicy(): ProductPolicy | null {
  const state = useProductPolicyStore.getState();
  return state.status === 'ready' ? state.policy : null;
}

export function canOpenPanelNow(tab: PolicyPanelTab): boolean {
  const policy = currentProductPolicy();
  return policy ? canOpenPanel(tab, policy) : false;
}

/** Runtime-side peripheral availability. Pending/error deliberately fail closed. */
export function peripheralsRuntimeAvailableNow(): boolean {
  const policy = currentProductPolicy();
  return policy !== null && policy.capabilities.peripherals !== 'disabled';
}
