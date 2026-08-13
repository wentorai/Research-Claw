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

/** `enabled-hidden` changes Dashboard presentation, not the Core runtime. */
export function arePeripheralsEnabled(policy: ProductPolicy): boolean {
  return policy.capabilities.peripherals !== 'disabled';
}

/**
 * Remove the canonical peripherals section from an in-memory AGENTS payload.
 * The L1 workspace file stays untouched so a later cold restart can restore it.
 */
export function filterPeripheralsBootstrapSection(content: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+§11(?:\s|$)/i.test(line));
  if (start === -1) return content;

  let end = start + 1;
  while (end < lines.length && !/^##\s+§\d+(?:\s|$)/i.test(lines[end])) end += 1;
  lines.splice(start, end - start);
  return lines.join(newline);
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
