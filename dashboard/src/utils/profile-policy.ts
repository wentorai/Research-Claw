export type VisibleCapabilityState = 'enabled' | 'enabled-hidden';
export type PeripheralCapabilityState = VisibleCapabilityState | 'disabled';

export interface ProductPolicy {
  capabilities: {
    settings: VisibleCapabilityState;
    extensions: VisibleCapabilityState;
    supervisor: VisibleCapabilityState;
    peripherals: PeripheralCapabilityState;
  };
}

const POLICY_KEYS = ['capabilities'] as const;
const CAPABILITY_KEYS = [
  'settings',
  'extensions',
  'supervisor',
  'peripherals',
] as const;
const VISIBLE_STATES = new Set<unknown>(['enabled', 'enabled-hidden']);
const PERIPHERAL_STATES = new Set<unknown>([
  'enabled',
  'enabled-hidden',
  'disabled',
]);

function freezePolicy(policy: ProductPolicy): ProductPolicy {
  Object.freeze(policy.capabilities);
  return Object.freeze(policy);
}

function enabledPolicy(): ProductPolicy {
  return freezePolicy({
    capabilities: {
      settings: 'enabled',
      extensions: 'enabled',
      supervisor: 'enabled',
      peripherals: 'enabled',
    },
  });
}

export const DEFAULT_PRODUCT_POLICY = enabledPolicy();

export type PolicyPanelTab =
  | 'library'
  | 'workspace'
  | 'review'
  | 'tasks'
  | 'jobs'
  | 'monitor'
  | 'peripherals'
  | 'supervisor'
  | 'extensions'
  | 'settings';

const PANEL_CAPABILITY: Partial<Record<PolicyPanelTab, keyof ProductPolicy['capabilities']>> = {
  peripherals: 'peripherals',
  supervisor: 'supervisor',
  extensions: 'extensions',
  settings: 'settings',
};

/** A panel is visible only when its capability is explicitly `enabled`. */
export function canOpenPanel(tab: PolicyPanelTab, policy: ProductPolicy): boolean {
  const capability = PANEL_CAPABILITY[tab];
  return capability === undefined || policy.capabilities[capability] === 'enabled';
}

export function visiblePanelTabs<T extends PolicyPanelTab>(
  tabs: readonly T[],
  policy: ProductPolicy,
): T[] {
  return tabs.filter((tab) => canOpenPanel(tab, policy));
}

export const visibleShortcutTabs = visiblePanelTabs;

export function firstVisiblePanel(policy: ProductPolicy): PolicyPanelTab {
  // Library is not profile-controlled in v1. Keeping the fallback explicit makes
  // a future expansion fail loudly instead of persisting a restricted tab.
  if (!canOpenPanel('library', policy)) {
    throw new Error('No visible Dashboard panel is available');
  }
  return 'library';
}

export function shouldMountPeripheralsListener(policy: ProductPolicy): boolean {
  return policy.capabilities.peripherals !== 'disabled';
}

export function shouldMountSupervisorUiHydration(policy: ProductPolicy): boolean {
  return policy.capabilities.supervisor === 'enabled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key);
}

/**
 * Normalize the product policy returned by OpenClaw's config.get snapshot.
 *
 * A missing policy preserves the legacy all-enabled product. Any present but
 * malformed policy is rejected, so a future UI gate cannot silently interpret
 * an unsupported value as permission to expose or disable a capability.
 */
export function parseProductPolicy(value: unknown): ProductPolicy {
  if (value === undefined) return enabledPolicy();
  if (!isRecord(value) || !hasExactKeys(value, POLICY_KEYS)) {
    throw new Error('Invalid productPolicy object');
  }
  const capabilities = value.capabilities;
  if (!isRecord(capabilities) || !hasExactKeys(capabilities, CAPABILITY_KEYS)) {
    throw new Error('Invalid productPolicy capabilities');
  }
  if (
    !VISIBLE_STATES.has(capabilities.settings)
    || !VISIBLE_STATES.has(capabilities.extensions)
    || !VISIBLE_STATES.has(capabilities.supervisor)
    || !PERIPHERAL_STATES.has(capabilities.peripherals)
  ) {
    throw new Error('Invalid productPolicy capability state');
  }
  return freezePolicy({
    capabilities: {
      settings: capabilities.settings as VisibleCapabilityState,
      extensions: capabilities.extensions as VisibleCapabilityState,
      supervisor: capabilities.supervisor as VisibleCapabilityState,
      peripherals: capabilities.peripherals as PeripheralCapabilityState,
    },
  });
}
