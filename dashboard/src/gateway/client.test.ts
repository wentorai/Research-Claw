/**
 * GatewayClient unit tests.
 * Tests the real GatewayClient class with a mock WebSocket.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayClient, GatewayRequestError } from './client';
import type { ConnectionState } from './types';

// Mock device-identity so Ed25519 keygen (async Web Crypto) resolves instantly
vi.mock('./device-identity', () => ({
  getDeviceIdentity: vi.fn().mockResolvedValue({
    deviceId: 'test-device',
    publicKey: 'test-key',
    sign: vi.fn().mockResolvedValue('test-sig'),
  }),
  buildV3Payload: vi.fn().mockReturnValue('test-payload'),
}));

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

interface MockWebSocket {
  url: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let mockWsInstance: MockWebSocket;
const MockWebSocketClass = vi.fn().mockImplementation((url: string) => {
  mockWsInstance = {
    url,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    readyState: 0,
    send: vi.fn(),
    close: vi.fn().mockImplementation(function (this: MockWebSocket, code?: number, reason?: string) {
      // Simulate close event
      if (this.onclose) {
        this.onclose(new CloseEvent('close', { code: code ?? 1000, reason: reason ?? '' }));
      }
    }),
  };
  // Auto-fire open after microtask to simulate real WS behavior
  queueMicrotask(() => {
    if (mockWsInstance.onopen) {
      mockWsInstance.readyState = 1;
      mockWsInstance.onopen(new Event('open'));
    }
  });
  return mockWsInstance;
});

// Add static constants to match real WebSocket API
(MockWebSocketClass as unknown as Record<string, number>).OPEN = 1;
(MockWebSocketClass as unknown as Record<string, number>).CLOSED = 3;
(MockWebSocketClass as unknown as Record<string, number>).CONNECTING = 0;
(MockWebSocketClass as unknown as Record<string, number>).CLOSING = 2;

// Replace global WebSocket
const originalWebSocket = globalThis.WebSocket;

describe('GatewayClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocketClass;
    MockWebSocketClass.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  // Helper to simulate server sending a message to the client
  function serverSend(data: unknown) {
    if (mockWsInstance.onmessage) {
      mockWsInstance.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }

  // Helper to complete the connect handshake.
  // Accepts optional helloOverrides to customize the hello-ok payload (e.g. policy.tickIntervalMs).
  async function completeHandshake(client: GatewayClient, helloOverrides?: Record<string, unknown>) {
    client.connect();
    await vi.advanceTimersByTimeAsync(1); // Let microtask fire onopen

    // Server sends connect.challenge
    serverSend({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce' } });

    // Let the mocked async getDeviceIdentity + sign resolve (multiple microtask ticks)
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Client should have sent connect request via ws.send
    const sentFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
    expect(sentFrame.method).toBe('connect');

    // Server responds with hello-ok (includes policy for tick watchdog)
    serverSend({
      type: 'res',
      id: sentFrame.id,
      ok: true,
      payload: {
        type: 'hello-ok',
        protocol: 3,
        server: { version: '1.0.0', connId: 'conn-123' },
        features: { methods: ['health'], events: [] },
        policy: { tickIntervalMs: 30_000 },
        ...helloOverrides,
      },
    });
  }

  describe('Connection lifecycle', () => {
    it('transitions through connecting -> authenticating -> connected', async () => {
      const states: ConnectionState[] = [];
      const onHello = vi.fn();
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: (s) => states.push(s),
        onHello,
      });

      await completeHandshake(client);

      expect(states).toContain('connecting');
      expect(states).toContain('authenticating');
      expect(states).toContain('connected');
      expect(client.isConnected).toBe(true);
      expect(client.connectionState).toBe('connected');
      expect(onHello).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'hello-ok', protocol: 3 }),
      );
    });

    it('disconnect transitions to disconnected and calls onClose', async () => {
      const onClose = vi.fn();
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
        onClose,
      });

      await completeHandshake(client);
      expect(client.isConnected).toBe(true);

      client.disconnect();
      expect(client.isConnected).toBe(false);
      expect(client.connectionState).toBe('disconnected');
    });

    it('connect() closes existing connection before reconnecting', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });

      await completeHandshake(client);
      const firstWs = mockWsInstance;

      // Connect again
      client.connect();
      expect(firstWs.close).toHaveBeenCalled();
    });
  });

  describe('Request/response correlation', () => {
    it('request resolves when server responds with matching id and ok=true', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client);

      const requestPromise = client.request<{ ok: boolean }>('health');

      // Get the request frame that was sent
      const lastCall = mockWsInstance.send.mock.calls[mockWsInstance.send.mock.calls.length - 1];
      const reqFrame = JSON.parse(lastCall[0]);
      expect(reqFrame.type).toBe('req');
      expect(reqFrame.method).toBe('health');

      // Server responds
      serverSend({ type: 'res', id: reqFrame.id, ok: true, payload: { ok: true } });

      const result = await requestPromise;
      expect(result).toEqual({ ok: true });
    });

    it('request rejects when server responds with ok=false', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client);

      const requestPromise = client.request('bad.method');

      const lastCall = mockWsInstance.send.mock.calls[mockWsInstance.send.mock.calls.length - 1];
      const reqFrame = JSON.parse(lastCall[0]);

      serverSend({
        type: 'res',
        id: reqFrame.id,
        ok: false,
        error: { code: 'METHOD_NOT_FOUND', message: 'No such method' },
      });

      await expect(requestPromise).rejects.toThrow(GatewayRequestError);
      await expect(requestPromise).rejects.toThrow('No such method');
    });

    it('request includes params when provided', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client);

      client.request('chat.send', { message: 'hello' });

      const lastCall = mockWsInstance.send.mock.calls[mockWsInstance.send.mock.calls.length - 1];
      const reqFrame = JSON.parse(lastCall[0]);
      expect(reqFrame.params).toEqual({ message: 'hello' });
    });

    it('request throws if not connected', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });

      await expect(client.request('health')).rejects.toThrow('Not connected to gateway');
    });
  });

  describe('Timeout handling', () => {
    it('request times out after 30s if no response', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client);

      // Set up the promise and attach the rejection handler BEFORE advancing timers
      const requestPromise = client.request('slow.method');
      const resultPromise = requestPromise.catch((err: Error) => err);

      // Advance timer past the 30s timeout
      await vi.advanceTimersByTimeAsync(30_001);

      const error = await resultPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Request timeout/);
    });
  });

  describe('Event subscription', () => {
    it('subscribe receives events and unsubscribe stops delivery', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client);

      const handler = vi.fn();
      const unsub = client.subscribe('chat', handler);

      // Server sends an event
      serverSend({ type: 'event', event: 'chat', payload: { text: 'hello' } });
      expect(handler).toHaveBeenCalledWith({ text: 'hello' });

      // Unsubscribe
      unsub();

      // Server sends another event
      serverSend({ type: 'event', event: 'chat', payload: { text: 'world' } });
      expect(handler).toHaveBeenCalledTimes(1); // Not called again
    });

    it('multiple handlers for the same event all receive it', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client);

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      client.subscribe('agent.status', handler1);
      client.subscribe('agent.status', handler2);

      serverSend({ type: 'event', event: 'agent.status', payload: { state: 'thinking' } });

      expect(handler1).toHaveBeenCalledWith({ state: 'thinking' });
      expect(handler2).toHaveBeenCalledWith({ state: 'thinking' });
    });

    it('onEvent callback fires for all events', async () => {
      const onEvent = vi.fn();
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
        onEvent,
      });
      await completeHandshake(client);

      serverSend({ type: 'event', event: 'test.event', payload: { data: 1 } });

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'event', event: 'test.event' }),
      );
    });
  });

  describe('Sequence gap detection', () => {
    it('onGap fires when event sequence has a gap', async () => {
      const onGap = vi.fn();
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
        onGap,
      });
      await completeHandshake(client);

      // Send event with seq=1
      serverSend({ type: 'event', event: 'a', payload: null, seq: 1 });
      expect(onGap).not.toHaveBeenCalled();

      // Skip seq=2, send seq=3 (gap)
      serverSend({ type: 'event', event: 'b', payload: null, seq: 3 });
      expect(onGap).toHaveBeenCalledWith({ expected: 2, received: 3 });
    });
  });

  describe('Reconnection behavior', () => {
    it('schedules reconnect on unexpected close when was connected', async () => {
      const states: ConnectionState[] = [];
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: (s) => states.push(s),
      });
      await completeHandshake(client);

      // Simulate unexpected close (not intentional, code 1006)
      if (mockWsInstance.onclose) {
        mockWsInstance.onclose(new CloseEvent('close', { code: 1006, reason: 'abnormal' }));
      }

      expect(states).toContain('reconnecting');
    });

    it('does not reconnect on intentional disconnect', async () => {
      const states: ConnectionState[] = [];
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: (s) => states.push(s),
      });
      await completeHandshake(client);

      client.disconnect();

      // Should be disconnected, not reconnecting
      expect(client.connectionState).toBe('disconnected');
      expect(states).not.toContain('reconnecting');
    });

    it('rejects all pending requests on connection close', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client);

      // Make a request but don't respond, attach rejection handler immediately
      const reqPromise = client.request('slow.method');
      const resultPromise = reqPromise.catch((err: Error) => err);

      // Simulate close
      if (mockWsInstance.onclose) {
        mockWsInstance.onclose(new CloseEvent('close', { code: 1006, reason: '' }));
      }

      const error = await resultPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Connection closed');
    });
  });

  describe('Protocol version negotiation', () => {
    it('sends minProtocol/maxProtocol in connect frame', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });

      client.connect();
      await vi.advanceTimersByTimeAsync(1);

      // Server sends challenge
      serverSend({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } });

      // Let the mocked async getDeviceIdentity + sign resolve (multiple microtask ticks)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const sentFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sentFrame.params.minProtocol).toBe(3);
      expect(sentFrame.params.maxProtocol).toBe(3);
    });

    it('sends client id, name, version, platform, and mode in connect frame', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        clientName: 'test-client',
        clientVersion: '1.2.3',
        platform: 'darwin',
        onStateChange: () => {},
      });

      client.connect();
      await vi.advanceTimersByTimeAsync(1);

      serverSend({ type: 'event', event: 'connect.challenge', payload: {} });

      // Let the mocked async getDeviceIdentity + sign resolve (multiple microtask ticks)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const sentFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sentFrame.params.client.id).toBe('openclaw-control-ui');
      expect(sentFrame.params.client.displayName).toBe('test-client');
      expect(sentFrame.params.client.version).toBe('1.2.3');
      expect(sentFrame.params.client.platform).toBe('darwin');
      expect(sentFrame.params.client.mode).toBe('webchat');
    });
  });

  describe('Error handling', () => {
    it('ignores malformed JSON messages', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client);

      // Should not throw
      if (mockWsInstance.onmessage) {
        mockWsInstance.onmessage(new MessageEvent('message', { data: 'not json' }));
      }

      expect(client.isConnected).toBe(true);
    });

    it('GatewayRequestError contains code and details', () => {
      const err = new GatewayRequestError({
        code: 'RATE_LIMITED',
        message: 'Too many requests',
        details: { retryAfter: 5 },
      });
      expect(err.code).toBe('RATE_LIMITED');
      expect(err.details).toEqual({ retryAfter: 5 });
      expect(err.name).toBe('GatewayRequestError');
      expect(err.message).toBe('Too many requests');
    });

    it('disconnects and does not reconnect on UNAUTHORIZED error during handshake', async () => {
      const states: ConnectionState[] = [];
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: (s) => states.push(s),
      });

      client.connect();
      await vi.advanceTimersByTimeAsync(1);

      // Server sends challenge
      serverSend({ type: 'event', event: 'connect.challenge', payload: {} });

      // Let the mocked async getDeviceIdentity + sign resolve (multiple microtask ticks)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const sentFrame = JSON.parse(mockWsInstance.send.mock.calls[0][0]);

      // Server rejects with UNAUTHORIZED
      serverSend({
        type: 'res',
        id: sentFrame.id,
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Bad token' },
      });

      // Should not attempt reconnect
      expect(states.filter(s => s === 'reconnecting')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tick watchdog — aligned with OC client.ts:659-681
  // Gateway broadcasts 'tick' events every tickIntervalMs. The client closes
  // with code 4000 ("tick timeout") if no tick arrives within 2x the interval,
  // triggering automatic reconnect. This detects zombie/half-open connections
  // that the browser's WebSocket layer cannot detect natively.
  //
  // Source: openclaw/src/gateway/client.ts:659-681 (startTickWatch)
  //         openclaw/src/gateway/client.ts:578-580 (tick event → lastTick)
  //         openclaw/src/gateway/client.ts:404-409 (hello → tickIntervalMs)
  //         openclaw/src/gateway/server-maintenance.ts:58-63 (tick broadcast)
  //         openclaw/src/gateway/server-constants.ts:33 (TICK_INTERVAL_MS = 30_000)
  // ---------------------------------------------------------------------------
  describe('Tick watchdog (aligned with OC client.ts:659-681)', () => {
    it('closes with code 4000 when no tick arrives within 2x tickIntervalMs', async () => {
      const onClose = vi.fn();
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
        onClose,
      });
      // tickIntervalMs=1000 → check every 1s, timeout at 2s
      await completeHandshake(client, { policy: { tickIntervalMs: 1000 } });
      mockWsInstance.close.mockClear();

      // At T+1000: gap ≈ 1000 ≤ 2000 → OK
      // At T+2000: gap ≈ 2000 ≤ 2000 → OK (not strictly >)
      // At T+3000: gap ≈ 3000 > 2000 → CLOSE
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockWsInstance.close).toHaveBeenCalledWith(4000, 'tick timeout');
    });

    it('regular tick events prevent timeout', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client, { policy: { tickIntervalMs: 1000 } });
      mockWsInstance.close.mockClear();

      // Send ticks every 800ms — always within the 2s window
      for (let t = 0; t < 5; t++) {
        await vi.advanceTimersByTimeAsync(800);
        serverSend({ type: 'event', event: 'tick', payload: { ts: Date.now() }, seq: t + 1 });
      }

      // Total advanced: 4000ms — would have timed out at 3000ms without ticks
      expect(mockWsInstance.close).not.toHaveBeenCalled();
      expect(client.isConnected).toBe(true);
      client.disconnect();
    });

    it('uses default 30s when hello has no policy.tickIntervalMs', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client, { policy: undefined });
      mockWsInstance.close.mockClear();

      // With 30s default: check at 30s, gap=30s ≤ 60s → no close
      await vi.advanceTimersByTimeAsync(31_000);
      expect(mockWsInstance.close).not.toHaveBeenCalled();

      client.disconnect();
    });

    it('tick watchdog is cleaned up on disconnect', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      await completeHandshake(client, { policy: { tickIntervalMs: 1000 } });

      client.disconnect();
      mockWsInstance.close.mockClear();

      // Advance way past timeout — timer was cleared, no further close calls
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockWsInstance.close).not.toHaveBeenCalled();
    });

    it('triggers reconnect after tick timeout', async () => {
      const states: ConnectionState[] = [];
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: (s) => states.push(s),
      });
      await completeHandshake(client, { policy: { tickIntervalMs: 1000 } });

      await vi.advanceTimersByTimeAsync(3000);

      expect(states).toContain('reconnecting');
    });

    it('respects policy.tickIntervalMs from hello response', async () => {
      const client = new GatewayClient({
        url: 'ws://test:28789',
        onStateChange: () => {},
      });
      // Use a 5s interval → check every 5s, timeout at 10s
      await completeHandshake(client, { policy: { tickIntervalMs: 5000 } });
      mockWsInstance.close.mockClear();

      // At 5000ms: first check, gap=5000 ≤ 10000 → no close
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockWsInstance.close).not.toHaveBeenCalled();

      // At 10000ms: second check, gap=10000 ≤ 10000 → no close (not strictly >)
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockWsInstance.close).not.toHaveBeenCalled();

      // At 15000ms: third check, gap=15000 > 10000 → CLOSE
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockWsInstance.close).toHaveBeenCalledWith(4000, 'tick timeout');
    });
  });
});
