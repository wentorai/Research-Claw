import { beforeEach, describe, expect, it, vi } from 'vitest';

import noPolicyCapture from '../__fixtures__/gateway-payloads/product-policy-none.config-get-2026.6.1.json';

const gatewayHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    emitState: (state: string) => void;
  }>,
}));

vi.mock('../gateway/client', () => {
  class FakeGatewayClient {
    isConnected = false;
    private readonly options: { onStateChange?: (state: string) => void };

    constructor(options: { onStateChange?: (state: string) => void }) {
      this.options = options;
      gatewayHarness.instances.push(this);
    }

    connect() {
      this.emitState('connected');
    }

    disconnect() {
      this.emitState('disconnected');
    }

    emitState(state: string) {
      this.isConnected = state === 'connected';
      this.options.onStateChange?.(state);
    }
  }

  return { GatewayClient: FakeGatewayClient };
});

import { useConfigStore } from './config';
import { useGatewayStore } from './gateway';
import { useProductPolicyStore } from './product-policy';

describe('Gateway connection epoch product-policy boundary', () => {
  beforeEach(() => {
    gatewayHarness.instances.length = 0;
    useGatewayStore.setState({ client: null, state: 'disconnected', eventEpoch: 0 });
    useConfigStore.setState({ _configRequestGeneration: 0 } as never);
    useProductPolicyStore.getState().resetPending();
  });

  it('synchronously invalidates the visible policy when transport leaves connected', () => {
    useGatewayStore.getState().connect('ws://example.invalid');
    useProductPolicyStore.getState().loadFromConfig(
      noPolicyCapture.response.config as Record<string, unknown>,
    );
    expect(useProductPolicyStore.getState().status).toBe('ready');

    gatewayHarness.instances.at(-1)?.emitState('reconnecting');

    expect(useProductPolicyStore.getState()).toMatchObject({
      status: 'pending',
      policy: null,
      error: null,
    });
  });

  it('cold-loads the gateway store and reaches its first connection without a store cycle', async () => {
    vi.resetModules();
    const { useGatewayStore: coldGatewayStore } = await import('./gateway');
    const { useProductPolicyStore: coldPolicyStore } = await import('./product-policy');

    expect(coldPolicyStore.getState().status).toBe('pending');
    expect(() => coldGatewayStore.getState().connect('ws://cold-start.invalid')).not.toThrow();
    expect(coldGatewayStore.getState().state).toBe('connected');
  });
});
