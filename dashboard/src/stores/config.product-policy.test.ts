import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import customPolicyCapture from '../__fixtures__/gateway-payloads/product-policy-custom.config-get-2026.6.1.json';
import noPolicyCapture from '../__fixtures__/gateway-payloads/product-policy-none.config-get-2026.6.1.json';
import { useGatewayStore } from './gateway';
import { useProductPolicyStore } from './product-policy';
import { useUiStore } from './ui';
import { useConfigStore } from './config';

function runtimeSnapshot(capture: typeof customPolicyCapture | typeof noPolicyCapture) {
  return {
    ...capture.response,
    config: {
      ...capture.response.config,
      agents: { defaults: { model: { primary: 'test/model' } } },
      models: {
        providers: {
          test: { baseUrl: 'https://example.invalid', models: [{ id: 'model' }] },
        },
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('config.get is the single Dashboard product-policy normalization point', () => {
  beforeEach(() => {
    localStorage.clear();
    useProductPolicyStore.getState().resetPending();
    useUiStore.setState({ rightPanelTab: 'library', rightPanelOpen: false });
    useConfigStore.setState({
      bootState: 'pending',
      gatewayConfig: null,
      gatewayConfigLoading: false,
      _configRetryCount: 0,
      _configRequestGeneration: 0,
      toolCallProbe: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes the real custom fixture from the same config.get response and repairs stale UI', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'config.get') return runtimeSnapshot(customPolicyCapture);
      if (method === 'rc.model.probeToolCalling') return { supported: true };
      return {};
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });
    localStorage.setItem('rc-right-panel-tab', 'extensions');
    useUiStore.setState({ rightPanelTab: 'extensions', rightPanelOpen: true });

    await useConfigStore.getState().loadGatewayConfig();

    expect(request.mock.calls.filter(([method]) => method === 'config.get')).toHaveLength(1);
    expect(useProductPolicyStore.getState()).toMatchObject({
      status: 'ready',
      policy: {
        capabilities: {
          settings: 'enabled-hidden',
          extensions: 'enabled-hidden',
          supervisor: 'enabled-hidden',
          peripherals: 'disabled',
        },
      },
    });
    expect(useUiStore.getState()).toMatchObject({ rightPanelTab: 'library', rightPanelOpen: true });
    expect(localStorage.getItem('rc-right-panel-tab')).toBe('library');
  });

  it('keeps the legacy real fixture all-enabled when productPolicy is absent', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'config.get') return runtimeSnapshot(noPolicyCapture);
      if (method === 'rc.model.probeToolCalling') return { supported: true };
      return {};
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });

    await useConfigStore.getState().loadGatewayConfig();

    expect(useProductPolicyStore.getState().policy?.capabilities).toEqual({
      settings: 'enabled',
      extensions: 'enabled',
      supervisor: 'enabled',
      peripherals: 'enabled',
    });
  });

  it('fails closed and retains an explicit error when a present policy is malformed', async () => {
    const malformed = structuredClone(runtimeSnapshot(customPolicyCapture));
    const coreConfig = malformed.config.plugins.entries['research-claw-core'].config as {
      productPolicy: { capabilities: { peripherals: string } };
    };
    coreConfig.productPolicy.capabilities.peripherals = 'off';
    const request = vi.fn(async (method: string) => {
      if (method === 'config.get') return malformed;
      return {};
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });

    await useConfigStore.getState().loadGatewayConfig();

    expect(useProductPolicyStore.getState()).toMatchObject({
      status: 'error',
      policy: null,
    });
    expect(useProductPolicyStore.getState().error).toMatch(/productPolicy/);
    expect(useConfigStore.getState().gatewayConfig).toBeNull();
  });

  it('does not publish a ready policy until the entire config snapshot is buildable', async () => {
    const incomplete = runtimeSnapshot(customPolicyCapture);
    Object.defineProperty(incomplete.config, 'agents', {
      enumerable: true,
      get() {
        throw new Error('broken agents projection');
      },
    });
    const request = vi.fn(async (method: string) => {
      if (method === 'config.get') return incomplete;
      return {};
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });

    await useConfigStore.getState().loadGatewayConfig();

    expect(useProductPolicyStore.getState()).toMatchObject({
      status: 'error',
      policy: null,
    });
    expect(useProductPolicyStore.getState().error).toMatch(/broken agents projection/);
    expect(useConfigStore.getState().gatewayConfig).toBeNull();
  });

  it('does not let an older config.get response overwrite the newest connection generation', async () => {
    const oldResponse = deferred<ReturnType<typeof runtimeSnapshot>>();
    const newResponse = deferred<ReturnType<typeof runtimeSnapshot>>();
    let configGetCount = 0;
    const request = vi.fn((method: string) => {
      if (method === 'config.get') {
        configGetCount += 1;
        return configGetCount === 1 ? oldResponse.promise : newResponse.promise;
      }
      if (method === 'rc.model.probeToolCalling') return Promise.resolve({ supported: true });
      return Promise.resolve({});
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });

    const oldLoad = useConfigStore.getState().loadGatewayConfig();
    const newLoad = useConfigStore.getState().loadGatewayConfig();

    newResponse.resolve(runtimeSnapshot(customPolicyCapture));
    await newLoad;
    expect(useProductPolicyStore.getState().policy?.capabilities.peripherals).toBe('disabled');

    oldResponse.resolve(runtimeSnapshot(noPolicyCapture));
    await oldLoad;

    expect(useProductPolicyStore.getState().policy?.capabilities).toEqual({
      settings: 'enabled-hidden',
      extensions: 'enabled-hidden',
      supervisor: 'enabled-hidden',
      peripherals: 'disabled',
    });
  });

  it('retries a transient config.get failure after reconnect even when boot was already ready', async () => {
    vi.useFakeTimers();
    useConfigStore.setState({ bootState: 'ready', _configRetryCount: 0 });
    useProductPolicyStore.getState().resetPending();
    let configGetCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'config.get') {
        configGetCount += 1;
        if (configGetCount === 1) throw new Error('transient config.get failure');
        return runtimeSnapshot(customPolicyCapture);
      }
      if (method === 'rc.model.probeToolCalling') return { supported: true };
      return {};
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });

    await useConfigStore.getState().loadGatewayConfig();
    expect(useProductPolicyStore.getState().status).toBe('pending');

    await vi.advanceTimersByTimeAsync(2_000);

    expect(configGetCount).toBe(2);
    expect(useProductPolicyStore.getState()).toMatchObject({
      status: 'ready',
      policy: { capabilities: { peripherals: 'disabled' } },
    });
    expect(useConfigStore.getState()._configRetryCount).toBe(0);
  });

  it('does not let an older transport-retry timer supersede a newer config.get authority', async () => {
    vi.useFakeTimers();
    useConfigStore.setState({ bootState: 'ready', _configRetryCount: 0 });
    useProductPolicyStore.getState().resetPending();
    let configGetCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'config.get') {
        configGetCount += 1;
        if (configGetCount === 1) throw new Error('transient config.get failure');
        return runtimeSnapshot(customPolicyCapture);
      }
      if (method === 'rc.model.probeToolCalling') return { supported: true };
      return {};
    });
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request } as never,
    });

    await useConfigStore.getState().loadGatewayConfig();
    await useConfigStore.getState().loadGatewayConfig();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(configGetCount).toBe(2);
    expect(useProductPolicyStore.getState()).toMatchObject({
      status: 'ready',
      policy: { capabilities: { peripherals: 'disabled' } },
    });
  });
});
