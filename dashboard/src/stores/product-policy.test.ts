import { beforeEach, describe, expect, it } from 'vitest';

import customPolicyCapture from '../__fixtures__/gateway-payloads/product-policy-custom.config-get-2026.6.1.json';
import noPolicyCapture from '../__fixtures__/gateway-payloads/product-policy-none.config-get-2026.6.1.json';
import { useProductPolicyStore } from './product-policy';

function configFrom(capture: typeof customPolicyCapture | typeof noPolicyCapture): Record<string, unknown> {
  return capture.response.config as Record<string, unknown>;
}

describe('product policy state from real OpenClaw 2026.6.1 config.get projections', () => {
  beforeEach(() => useProductPolicyStore.getState().resetPending());

  it('starts pending so restricted entries cannot flash before config.get resolves', () => {
    expect(useProductPolicyStore.getState()).toMatchObject({
      status: 'pending',
      policy: null,
      error: null,
    });
  });

  it('normalizes an absent policy to all-enabled exactly once per response', () => {
    useProductPolicyStore.getState().loadFromConfig(configFrom(noPolicyCapture));
    expect(useProductPolicyStore.getState()).toMatchObject({
      status: 'ready',
      policy: {
        capabilities: {
          settings: 'enabled',
          extensions: 'enabled',
          supervisor: 'enabled',
          peripherals: 'enabled',
        },
      },
      error: null,
    });
  });

  it('preserves the customized policy from the real config.get response', () => {
    useProductPolicyStore.getState().loadFromConfig(configFrom(customPolicyCapture));
    expect(useProductPolicyStore.getState().policy).toEqual({
      capabilities: {
        settings: 'enabled-hidden',
        extensions: 'enabled-hidden',
        supervisor: 'enabled-hidden',
        peripherals: 'disabled',
      },
    });
  });

  it('fails closed with an explicit error for any present malformed policy', () => {
    const malformed = structuredClone(configFrom(customPolicyCapture));
    const plugins = malformed.plugins as { entries: Record<string, { config: Record<string, unknown> }> };
    plugins.entries['research-claw-core'].config.productPolicy = {
      capabilities: {
        settings: 'enabled',
        extensions: 'enabled',
        supervisor: 'enabled',
        peripherals: 'off',
      },
    };

    expect(() => useProductPolicyStore.getState().loadFromConfig(malformed)).toThrow(/productPolicy/);
    expect(useProductPolicyStore.getState()).toMatchObject({
      status: 'error',
      policy: null,
    });
    expect(useProductPolicyStore.getState().error).toMatch(/productPolicy/);
  });
});
