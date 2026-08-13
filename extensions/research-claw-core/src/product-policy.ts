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
 * Parse the Core plugin's sole product-policy source.
 *
 * A completely absent policy preserves legacy all-enabled behavior. Once a
 * policy exists it is strict and complete: malformed values are programmer or
 * deployment errors and must never be converted into an accidental disable.
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
