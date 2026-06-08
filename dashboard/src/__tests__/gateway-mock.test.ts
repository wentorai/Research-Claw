import { describe, it, expect, vi } from 'vitest';
import { GatewayClient, GatewayRequestError } from '../gateway/__mocks__/client';

describe('GatewayClient (mock mode)', () => {
  it('connects and transitions through states', async () => {
    const states: string[] = [];
    const client = new GatewayClient({
      url: 'ws://mock:28789',
      onStateChange: (s) => states.push(s),
      onHello: () => {},
    });

    client.connect();

    // Wait for microtasks (connecting → authenticating → connected)
    await new Promise((r) => setTimeout(r, 10));

    expect(states).toEqual(['connecting', 'authenticating', 'connected']);
    expect(client.isConnected).toBe(true);
    expect(client.connectionState).toBe('connected');
  });

  it('request("health") returns { ok: true }', async () => {
    const client = new GatewayClient({
      url: 'ws://mock:28789',
      onStateChange: () => {},
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    const result = await client.request<{ ok: boolean }>('health');
    expect(result).toEqual({ ok: true });
  });

  it('request while disconnected throws', async () => {
    const client = new GatewayClient({
      url: 'ws://mock:28789',
      onStateChange: () => {},
    });

    await expect(client.request('health')).rejects.toThrow('Not connected');
  });

  it('mockResponse allows custom method responses', async () => {
    const client = new GatewayClient({
      url: 'ws://mock:28789',
      onStateChange: () => {},
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    client.mockResponse('custom.method', (params) => ({ echo: params }));
    const result = await client.request('custom.method', { foo: 'bar' });
    expect(result).toEqual({ echo: { foo: 'bar' } });
  });

  it('unknown method throws GatewayRequestError', async () => {
    const client = new GatewayClient({
      url: 'ws://mock:28789',
      onStateChange: () => {},
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    await expect(client.request('nonexistent')).rejects.toThrow(GatewayRequestError);
  });

  it('subscribe and simulateEvent work', async () => {
    const client = new GatewayClient({
      url: 'ws://mock:28789',
      onStateChange: () => {},
    });

    const handler = vi.fn();
    const unsub = client.subscribe('test.event', handler);

    client.simulateEvent('test.event', { data: 123 });
    expect(handler).toHaveBeenCalledWith({ data: 123 });

    unsub();
    client.simulateEvent('test.event', { data: 456 });
    expect(handler).toHaveBeenCalledTimes(1); // Not called again after unsub
  });

  it('disconnect transitions to disconnected', async () => {
    const client = new GatewayClient({
      url: 'ws://mock:28789',
      onStateChange: () => {},
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.isConnected).toBe(true);

    client.disconnect();
    expect(client.isConnected).toBe(false);
    expect(client.connectionState).toBe('disconnected');
  });

  it('onHello callback receives server info', async () => {
    const onHello = vi.fn();
    const client = new GatewayClient({
      url: 'ws://mock:28789',
      onStateChange: () => {},
      onHello,
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 10));

    expect(onHello).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'hello-ok',
        protocol: 4,
        server: { version: '0.0.0-mock', connId: 'mock-conn-id' },
      }),
    );
  });
});
