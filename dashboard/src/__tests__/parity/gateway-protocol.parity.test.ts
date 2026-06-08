/**
 * Behavioral Parity Tests: Gateway Protocol
 *
 * These tests verify that our GatewayClient handles the WS protocol
 * IDENTICALLY to OpenClaw's native GatewayBrowserClient.
 *
 * Reference files:
 *   - openclaw/ui/src/ui/gateway.ts (browser WS client)
 *   - openclaw/src/gateway/client.ts (Node WS client)
 *   - openclaw/src/gateway/protocol/schema/frames.ts (frame schemas)
 *   - openclaw/src/gateway/server/ws-connection.ts (server handshake)
 *   - openclaw/src/gateway/server-constants.ts (tick interval)
 *   - openclaw/src/gateway/protocol/connect-error-details.ts (error codes)
 *
 * Each test cites the OpenClaw source file and line number it verifies parity with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayClient, GatewayRequestError } from '../../gateway/client';
import type { GatewayClientOptions } from '../../gateway/client';
import { MIN_PROTOCOL, MAX_PROTOCOL } from '../../gateway/types';
import {
  CONNECT_CHALLENGE,
  HELLO_OK_PAYLOAD,
  HELLO_OK_RESPONSE,
  HELLO_OK_MINIMAL,
  CONNECT_ERROR_RESPONSE,
  RPC_ERROR_RESPONSE,
  ERROR_UNAUTHORIZED,
  ERROR_INVALID_REQUEST,
  TICK_EVENT_SEQ_1,
  TICK_EVENT_SEQ_2,
  TICK_EVENT_SEQ_5_GAP,
  CHAT_EVENT_SEQ_3,
  AGENT_EVENT_SEQ_4,
  PRESENCE_EVENT_NO_SEQ,
  HEALTH_EVENT,
  SHUTDOWN_EVENT,
  CONFIG_GET_RESPONSE,
} from '../../__fixtures__/gateway-payloads/protocol-frames';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type MessageHandler = (ev: { data: string }) => void;
type CloseHandler = (ev: { code: number; reason: string }) => void;
type OpenHandler = () => void;

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: OpenHandler | null = null;
  onmessage: MessageHandler | null = null;
  onclose: CloseHandler | null = null;
  onerror: (() => void) | null = null;

  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = MockWebSocket.CLOSED;
    // Fire onclose asynchronously so tests can inspect state
    if (this.onclose) {
      this.onclose({ code: code ?? 1000, reason: reason ?? '' });
    }
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

let mockWsInstance: MockWebSocket;

// Replace global WebSocket
const OrigWebSocket = globalThis.WebSocket;

// Mock device identity so handleChallenge doesn't fail
vi.mock('../../gateway/device-identity', () => ({
  getDeviceIdentity: vi.fn().mockResolvedValue({
    deviceId: 'mock-device-id-sha256hex64chars0000000000000000000000000000000000',
    publicKey: 'mock-public-key-base64url',
    sign: vi.fn().mockResolvedValue('mock-signature-base64url'),
  }),
  buildV3Payload: vi.fn().mockReturnValue('v3|mock-payload'),
}));

beforeEach(() => {
  vi.useFakeTimers();
  mockWsInstance = new MockWebSocket();
  const MockWsCtor: any = vi.fn().mockImplementation(() => mockWsInstance);
  // Expose static constants so client.ts comparisons like
  // `this.ws.readyState !== WebSocket.OPEN` resolve correctly
  MockWsCtor.OPEN = 1;
  MockWsCtor.CONNECTING = 0;
  MockWsCtor.CLOSING = 2;
  MockWsCtor.CLOSED = 3;
  (globalThis as any).WebSocket = MockWsCtor;
});

afterEach(() => {
  vi.useRealTimers();
  // Use clearAllMocks (not restoreAllMocks) to preserve the vi.mock factory
  // while resetting call counts. restoreAllMocks would undo mockResolvedValue.
  vi.clearAllMocks();
  (globalThis as any).WebSocket = OrigWebSocket;
});

// ---------------------------------------------------------------------------
// Helper: create client, connect, and complete the handshake
// ---------------------------------------------------------------------------
function createClient(overrides: Partial<GatewayClientOptions> = {}): GatewayClient {
  return new GatewayClient({
    url: 'ws://127.0.0.1:28789',
    ...overrides,
  });
}

/**
 * Complete the full handshake: open -> challenge -> connect request -> hello-ok response.
 * Returns the connect request ID so tests can inject custom responses.
 */
/**
 * Flush microtasks to let async mock resolutions propagate.
 * `handleChallenge` has two await points (getDeviceIdentity + sign),
 * so we need multiple microtask flushes with fake timers.
 */
async function flushMicrotasks(): Promise<void> {
  // Multiple rounds to drain chained promise resolutions
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function completeHandshake(
  client: GatewayClient,
  ws: MockWebSocket,
  helloPayload: unknown = HELLO_OK_PAYLOAD,
): Promise<string> {
  client.connect();
  ws.simulateOpen();
  // Server sends connect.challenge
  ws.simulateMessage(CONNECT_CHALLENGE);
  // Let the async handleChallenge resolve (device identity + sign)
  await flushMicrotasks();

  // Find the connect request frame sent by client
  const connectFrame = ws.sent
    .map((s) => JSON.parse(s))
    .find((f: any) => f.method === 'connect');
  expect(connectFrame).toBeDefined();

  // Server responds with hello-ok
  ws.simulateMessage({
    type: 'res',
    id: connectFrame.id,
    ok: true,
    payload: helloPayload,
  });

  return connectFrame.id;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Gateway protocol parity with OpenClaw', () => {
  // ─── Hello Handshake ────────────────────────────────────────────────

  describe('Hello handshake — openclaw/ui/src/ui/gateway.ts:307-324', () => {
    it('sends minProtocol/maxProtocol both set to 3 in connect params', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:308-309
      //   minProtocol: 3,
      //   maxProtocol: 3,
      const client = createClient();
      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();

      const connectFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'connect');

      expect(connectFrame).toBeDefined();
      expect(connectFrame.params.minProtocol).toBe(MIN_PROTOCOL);
      expect(connectFrame.params.maxProtocol).toBe(MAX_PROTOCOL);
      expect(connectFrame.params.minProtocol).toBe(4);
      expect(connectFrame.params.maxProtocol).toBe(4);

      client.disconnect();
    });

    it('sends connect frame as type "req" with method "connect"', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:326
      //   void this.request<GatewayHelloOk>("connect", params)
      // OpenClaw reference: ui/src/ui/gateway.ts:451
      //   const frame = { type: "req", id, method, params };
      const client = createClient();
      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();

      const connectFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'connect');

      expect(connectFrame.type).toBe('req');
      expect(connectFrame.method).toBe('connect');
      expect(typeof connectFrame.id).toBe('string');
      expect(connectFrame.id.length).toBeGreaterThan(0);

      client.disconnect();
    });

    it('includes device identity in connect params', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:275-306
      //   device: { id, publicKey, signature, signedAt, nonce }
      const client = createClient();
      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();

      const connectFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'connect');

      expect(connectFrame.params.device).toBeDefined();
      expect(connectFrame.params.device.id).toBeTruthy();
      expect(connectFrame.params.device.publicKey).toBeTruthy();
      expect(connectFrame.params.device.signature).toBeTruthy();
      expect(typeof connectFrame.params.device.signedAt).toBe('number');
      expect(connectFrame.params.device.nonce).toBe(
        (CONNECT_CHALLENGE.payload as any).nonce
      );

      client.disconnect();
    });

    it('includes client info with mode, role, and scopes', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:310-316
      //   client: { id, version, platform, mode, instanceId }
      // OpenClaw reference: ui/src/ui/gateway.ts:317-318
      //   role, scopes,
      const client = createClient();
      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();

      const connectFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'connect');

      expect(connectFrame.params.client).toBeDefined();
      expect(connectFrame.params.client.id).toBeTruthy();
      expect(connectFrame.params.client.version).toBeTruthy();
      expect(connectFrame.params.client.platform).toBeTruthy();
      expect(connectFrame.params.client.mode).toBeTruthy();
      expect(connectFrame.params.role).toBeTruthy();
      expect(Array.isArray(connectFrame.params.scopes)).toBe(true);

      client.disconnect();
    });

    it('transitions to "connected" state on hello-ok', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:327-339
      //   .then((hello) => { ... this.opts.onHello?.(hello); })
      // Our equivalent: client.ts:281-286
      const onHello = vi.fn();
      const onStateChange = vi.fn();
      const client = createClient({ onHello, onStateChange });

      await completeHandshake(client, mockWsInstance);

      expect(client.isConnected).toBe(true);
      expect(client.connectionState).toBe('connected');
      expect(onHello).toHaveBeenCalledTimes(1);
      expect(onHello).toHaveBeenCalledWith(HELLO_OK_PAYLOAD);

      client.disconnect();
    });

    it('sends connect request only after receiving connect.challenge', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:398-408
      //   The client waits for the connect.challenge event before sending connect.
      //   ws open event just queues — the actual connect is deferred until challenge.
      // OpenClaw reference: server/ws-connection.ts:174-179
      //   Server sends challenge immediately on ws open.
      const client = createClient();
      client.connect();
      mockWsInstance.simulateOpen();

      // Before challenge, no connect request should be sent
      const preChallengeFrames = mockWsInstance.sent.map((s) => JSON.parse(s));
      expect(preChallengeFrames.filter((f: any) => f.method === 'connect')).toHaveLength(0);

      // After challenge, connect request should appear
      mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();

      const postChallengeFrames = mockWsInstance.sent.map((s) => JSON.parse(s));
      expect(postChallengeFrames.filter((f: any) => f.method === 'connect').length).toBeGreaterThan(0);

      client.disconnect();
    });
  });

  // ─── Frame Parsing ──────────────────────────────────────────────────

  describe('Frame parsing — openclaw/ui/src/ui/gateway.ts:389-443', () => {
    it('routes response frames by correlating id', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:424-443
      //   if (frame.type === "res") {
      //     const res = parsed as GatewayResponseFrame;
      //     const pending = this.pending.get(res.id);
      //     ...
      const onHello = vi.fn();
      const client = createClient({ onHello });
      await completeHandshake(client, mockWsInstance);

      const promise = client.request('config.get', { scope: 'resolved' });
      await vi.advanceTimersByTimeAsync(1);

      // Find the request ID
      const reqFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'config.get');
      expect(reqFrame).toBeDefined();

      // Respond with matching ID
      mockWsInstance.simulateMessage({
        ...CONFIG_GET_RESPONSE,
        id: reqFrame.id,
      });

      await expect(promise).resolves.toEqual(CONFIG_GET_RESPONSE.payload);

      client.disconnect();
    });

    it('ignores response frames with unknown ids', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:427-429
      //   const pending = this.pending.get(res.id);
      //   if (!pending) { return; }
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      // Send a response with an id that doesn't match any pending request
      expect(() => {
        mockWsInstance.simulateMessage({
          type: 'res',
          id: 'non-existent-request-id',
          ok: true,
          payload: { data: 'orphan' },
        });
      }).not.toThrow();

      client.disconnect();
    });

    it('resolves ok responses with payload', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:431-432
      //   if (res.ok) { pending.resolve(res.payload); }
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      const promise = client.request('sessions.list');
      await vi.advanceTimersByTimeAsync(1);

      const reqFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'sessions.list');

      mockWsInstance.simulateMessage({
        type: 'res',
        id: reqFrame.id,
        ok: true,
        payload: { sessions: [{ key: 'main', label: 'Main' }] },
      });

      const result = await promise;
      expect(result).toEqual({ sessions: [{ key: 'main', label: 'Main' }] });

      client.disconnect();
    });

    it('rejects error responses with GatewayRequestError', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:433-441
      //   pending.reject(new GatewayRequestError({
      //     code: res.error?.code ?? "UNAVAILABLE",
      //     message: res.error?.message ?? "request failed",
      //   }));
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      const promise = client.request('chat.send', { message: '' });
      await vi.advanceTimersByTimeAsync(1);

      const reqFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'chat.send');

      mockWsInstance.simulateMessage({
        ...RPC_ERROR_RESPONSE,
        id: reqFrame.id,
      });

      await expect(promise).rejects.toThrow(GatewayRequestError);
      try {
        await promise;
      } catch (e: any) {
        expect(e).toBeInstanceOf(GatewayRequestError);
        expect(e.code).toBe(ERROR_INVALID_REQUEST.code);
        expect(e.message).toBe(ERROR_INVALID_REQUEST.message);
      }

      client.disconnect();
    });

    it('silently ignores malformed JSON messages', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:392-395
      //   try { parsed = JSON.parse(raw); } catch { return; }
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      expect(() => {
        mockWsInstance.onmessage?.({ data: 'not valid json {{{' });
      }).not.toThrow();

      expect(client.isConnected).toBe(true);

      client.disconnect();
    });

    it('sends request frames as {type: "req", id, method, params}', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:450-452
      //   const id = generateUUID();
      //   const frame = { type: "req", id, method, params };
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      // Clear sent buffer from handshake
      mockWsInstance.sent.length = 0;

      // Create a request to inspect the frame. Catch rejection since disconnect()
      // will reject pending requests when it closes the socket.
      const pending = client.request('config.get', { scope: 'resolved' });
      pending.catch(() => {}); // prevent unhandled rejection on disconnect
      await vi.advanceTimersByTimeAsync(1);

      expect(mockWsInstance.sent.length).toBe(1);
      const frame = JSON.parse(mockWsInstance.sent[0]);
      expect(frame.type).toBe('req');
      expect(typeof frame.id).toBe('string');
      expect(frame.method).toBe('config.get');
      expect(frame.params).toEqual({ scope: 'resolved' });

      client.disconnect();
    });
  });

  // ─── Event Subscription ─────────────────────────────────────────────

  describe('Event subscription — our extension beyond OpenClaw onEvent pattern', () => {
    it('dispatches events to named subscribers', async () => {
      // Our client extends OpenClaw's single-callback onEvent pattern with
      // per-event subscribe(). This test verifies the subscribe pathway.
      // Related: openclaw/ui/src/ui/gateway.ts:416-421
      //   this.opts.onEvent?.(evt);
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      const chatHandler = vi.fn();
      const unsub = client.subscribe('chat', chatHandler);

      mockWsInstance.simulateMessage(CHAT_EVENT_SEQ_3);

      expect(chatHandler).toHaveBeenCalledTimes(1);
      expect(chatHandler).toHaveBeenCalledWith(CHAT_EVENT_SEQ_3.payload);

      unsub();
      mockWsInstance.simulateMessage(CHAT_EVENT_SEQ_3);
      expect(chatHandler).toHaveBeenCalledTimes(1); // No additional call

      client.disconnect();
    });

    it('dispatches to multiple subscribers for the same event', async () => {
      // Verifies fan-out — multiple handlers for one event name.
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      client.subscribe('agent', handler1);
      client.subscribe('agent', handler2);

      mockWsInstance.simulateMessage(AGENT_EVENT_SEQ_4);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      client.disconnect();
    });

    it('also fires the global onEvent callback', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:416-421
      //   try { this.opts.onEvent?.(evt); } catch (err) { ... }
      const onEvent = vi.fn();
      const client = createClient({ onEvent });
      await completeHandshake(client, mockWsInstance);

      mockWsInstance.simulateMessage(HEALTH_EVENT);

      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent).toHaveBeenCalledWith(HEALTH_EVENT);

      client.disconnect();
    });

    it('unsubscribe returns a function that removes the handler', async () => {
      // Our subscribe() returns an unsubscribe function.
      // Pattern mirrors React/Zustand convention.
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      const handler = vi.fn();
      const unsub = client.subscribe('tick', handler);

      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_1);
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();
      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_2);
      expect(handler).toHaveBeenCalledTimes(1); // Still 1

      client.disconnect();
    });
  });

  // ─── Request Timeout ────────────────────────────────────────────────

  describe('Request timeout — client.ts:163-166', () => {
    it('rejects pending request after 30s timeout', async () => {
      // Our client: client.ts:44 REQUEST_TIMEOUT_MS = 30_000
      // OpenClaw browser client doesn't have a per-request timeout
      // (it relies on WS close). Our client adds one for safety.
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      // Catch the rejection eagerly to avoid unhandled rejection warnings
      const promise = client.request('slow.rpc');
      const rejection = promise.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(1);

      // Advance past the 30s timeout
      await vi.advanceTimersByTimeAsync(30_001);

      const error = await rejection;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timeout/i);

      client.disconnect();
    });

    it('does not reject if response arrives before timeout', async () => {
      // Verifies timer is cleared on successful response.
      // Our client: client.ts:307 clearTimeout(entry.timer);
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      const promise = client.request('fast.rpc');
      await vi.advanceTimersByTimeAsync(1);

      const reqFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'fast.rpc');

      mockWsInstance.simulateMessage({
        type: 'res',
        id: reqFrame.id,
        ok: true,
        payload: { fast: true },
      });

      await expect(promise).resolves.toEqual({ fast: true });

      // Advance past timeout — should NOT cause additional rejection
      await vi.advanceTimersByTimeAsync(31_000);
      // If we got here without unhandled rejection, the timer was cleared

      client.disconnect();
    });
  });

  // ─── Sequence Gap Detection ─────────────────────────────────────────

  describe('Sequence gap detection — openclaw/ui/src/ui/gateway.ts:409-415', () => {
    it('detects gap when seq jumps (e.g., 2 -> 5 means 3,4 missed)', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:411-412
      //   if (this.lastSeq !== null && seq > this.lastSeq + 1) {
      //     this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
      //   }
      // Our client: client.ts (aligned with OC)
      //   if (this.lastSeq > 0 && frame.seq > this.lastSeq + 1) {
      //     this.opts.onGap?.({ expected: this.lastSeq + 1, received: frame.seq });
      //   }
      const onGap = vi.fn();
      const client = createClient({ onGap });
      await completeHandshake(client, mockWsInstance);

      // Receive seq 1, 2 normally
      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_1);
      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_2);
      expect(onGap).not.toHaveBeenCalled();

      // Receive seq 5 — gap (3 and 4 missing)
      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_5_GAP);
      expect(onGap).toHaveBeenCalledTimes(1);
      expect(onGap).toHaveBeenCalledWith({ expected: 3, received: 5 });

      client.disconnect();
    });

    it('does not report gap for first event (seq=1)', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:411
      //   if (this.lastSeq !== null && ...) — lastSeq is null initially
      // Our client: client.ts:321
      //   if (this.lastSeq > 0 && ...) — lastSeq is 0 initially
      const onGap = vi.fn();
      const client = createClient({ onGap });
      await completeHandshake(client, mockWsInstance);

      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_1);
      expect(onGap).not.toHaveBeenCalled();

      client.disconnect();
    });

    it('does not report gap for consecutive events', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:411
      //   seq > this.lastSeq + 1 — only fires when there IS a gap
      const onGap = vi.fn();
      const client = createClient({ onGap });
      await completeHandshake(client, mockWsInstance);

      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_1);
      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_2);
      mockWsInstance.simulateMessage(CHAT_EVENT_SEQ_3);
      mockWsInstance.simulateMessage(AGENT_EVENT_SEQ_4);

      expect(onGap).not.toHaveBeenCalled();

      client.disconnect();
    });

    it('ignores events without seq for gap tracking', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:409-410
      //   const seq = typeof evt.seq === "number" ? evt.seq : null;
      //   if (seq !== null) { ... }
      // Our client: client.ts:320
      //   if (frame.seq !== undefined) { ... }
      const onGap = vi.fn();
      const client = createClient({ onGap });
      await completeHandshake(client, mockWsInstance);

      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_1);
      // Non-sequenced event should not affect gap tracking
      mockWsInstance.simulateMessage(PRESENCE_EVENT_NO_SEQ);
      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_2);

      expect(onGap).not.toHaveBeenCalled();

      client.disconnect();
    });

    it('updates lastSeq even when gap is detected', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:414
      //   this.lastSeq = seq;  (after gap callback)
      // After a gap, the next expected seq should be based on the new value.
      const onGap = vi.fn();
      const client = createClient({ onGap });
      await completeHandshake(client, mockWsInstance);

      // seq 1, then gap to 5
      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_1);
      mockWsInstance.simulateMessage(TICK_EVENT_SEQ_5_GAP);
      expect(onGap).toHaveBeenCalledWith({ expected: 2, received: 5 });

      onGap.mockClear();

      // seq 6 should be normal (no gap since lastSeq is now 5)
      mockWsInstance.simulateMessage({
        type: 'event',
        event: 'tick',
        payload: { ts: 1710403380000 },
        seq: 6,
      });
      expect(onGap).not.toHaveBeenCalled();

      client.disconnect();
    });
  });

  // ─── Reconnect Behavior ─────────────────────────────────────────────

  describe('Reconnect trigger conditions — openclaw/ui/src/ui/gateway.ts:180-211', () => {
    it('does not reconnect on intentional disconnect', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:159-167
      //   stop() { this.closed = true; this.ws?.close(); ... }
      // Our client: client.ts:141-147
      //   disconnect() { this.intentionalClose = true; ... }
      const onStateChange = vi.fn();
      const client = createClient({ onStateChange });
      await completeHandshake(client, mockWsInstance);
      onStateChange.mockClear();

      client.disconnect();

      // No reconnect attempts
      await vi.advanceTimersByTimeAsync(20_000);
      expect(client.connectionState).toBe('disconnected');

      // Verify no 'reconnecting' state was entered
      const states = onStateChange.mock.calls.map((c: any) => c[0]);
      expect(states).not.toContain('reconnecting');
    });

    it('does not reconnect on clean close (code 1000)', async () => {
      // OpenClaw browser client (ui/src/ui/gateway.ts) always reconnects
      // unless explicitly stopped. Our client treats 1000/1001 as intentional.
      // Our client: client.ts:122-125
      //   if (this.intentionalClose || ev.code === 1000 || ev.code === 1001) {
      //     this.setState('disconnected'); return;
      //   }
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      mockWsInstance.simulateClose(1000, 'normal closure');

      await vi.advanceTimersByTimeAsync(20_000);
      expect(client.connectionState).toBe('disconnected');
    });

    it('enters reconnecting state on abnormal close after being connected', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:204-211
      //   if (!isNonRecoverableAuthError(connectError)) {
      //     this.scheduleReconnect();
      //   }
      // Our client: client.ts:128-133
      //   if (wasConnected || this.state === 'reconnecting') {
      //     this.setState('reconnecting');
      //     this.reconnector.schedule(() => this.connect());
      //   }
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      mockWsInstance.simulateClose(1006, 'abnormal closure');

      expect(client.connectionState).toBe('reconnecting');

      client.disconnect(); // Clean up
    });

    it('fires onClose callback with CloseInfo object', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:186
      //   this.opts.onClose?.({ code: ev.code, reason, error: connectError });
      // Our client (aligned): client.ts
      //   this.opts.onClose?.({ code: ev.code, reason: ev.reason ?? '', error: connectError });
      const onClose = vi.fn();
      const client = createClient({ onClose });
      await completeHandshake(client, mockWsInstance);

      mockWsInstance.simulateClose(4008, 'connect failed');

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith({ code: 4008, reason: 'connect failed', error: undefined });

      client.disconnect();
    });

    it('rejects all pending requests on connection close', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:213-218
      //   private flushPending(err: Error) {
      //     for (const [, p] of this.pending) { p.reject(err); }
      //     this.pending.clear();
      //   }
      // Our client: client.ts:116-120
      const client = createClient();
      await completeHandshake(client, mockWsInstance);

      // Capture rejections eagerly to avoid unhandled rejection warnings
      const p1 = client.request('sessions.list');
      const r1 = p1.catch((e: Error) => e);
      const p2 = client.request('config.get');
      const r2 = p2.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(1);

      mockWsInstance.simulateClose(1006, 'lost');

      const e1 = await r1;
      const e2 = await r2;
      expect(e1).toBeInstanceOf(Error);
      expect((e1 as Error).message).toMatch(/closed/i);
      expect(e2).toBeInstanceOf(Error);
      expect((e2 as Error).message).toMatch(/closed/i);

      client.disconnect();
    });
  });

  // ─── Non-recoverable auth errors ───────────────────────────────────

  describe('Non-recoverable auth errors — openclaw/ui/src/ui/gateway.ts:65-78', () => {
    it('stops reconnection on UNAUTHORIZED connect error', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:65-78
      //   isNonRecoverableAuthError — returns true for certain codes
      // Our client: client.ts:45-50 NON_RECOVERABLE_CODES
      //   const NON_RECOVERABLE_CODES = new Set(['UNAUTHORIZED', 'FORBIDDEN', ...])
      // Our client: client.ts:289-293
      //   if (err instanceof GatewayRequestError && NON_RECOVERABLE_CODES.has(err.code)) {
      //     this.reconnector.cancel(); ...
      //   }
      const onStateChange = vi.fn();
      const client = createClient({ onStateChange });
      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();

      // Find connect request
      const connectFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'connect');

      // Server responds with UNAUTHORIZED error
      mockWsInstance.simulateMessage({
        type: 'res',
        id: connectFrame.id,
        ok: false,
        error: ERROR_UNAUTHORIZED,
      });

      // The client should transition to disconnected (not reconnecting)
      await vi.advanceTimersByTimeAsync(20_000);
      expect(client.connectionState).toBe('disconnected');

      const states = onStateChange.mock.calls.map((c: any) => c[0]);
      expect(states).not.toContain('reconnecting');

      client.disconnect();
    });
  });

  // ─── Request-when-disconnected ────────────────────────────────────

  describe('Request guard — openclaw/ui/src/ui/gateway.ts:447-449', () => {
    it('rejects requests when not connected', () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:447-449
      //   if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      //     return Promise.reject(new Error("gateway not connected"));
      //   }
      // Our client: client.ts:150-153
      //   if (!this.ws || this.state !== 'connected') {
      //     throw new Error('Not connected to gateway');
      //   }
      const client = createClient();
      // Not connected yet
      expect(() => client.request('config.get')).rejects.toThrow(/not connected/i);
    });
  });

  // ─── Protocol version constants ───────────────────────────────────

  describe('Protocol version constants — openclaw/src/gateway/protocol/schema/protocol-schemas.ts:301', () => {
    it('MIN_PROTOCOL and MAX_PROTOCOL are both 4 (OC 2026.6.1+)', () => {
      // OpenClaw reference: protocol-schemas.ts — PROTOCOL_VERSION = 4
      expect(MIN_PROTOCOL).toBe(4);
      expect(MAX_PROTOCOL).toBe(4);
    });
  });

  // ─── Connect.challenge is not forwarded to event handlers ─────────

  describe('connect.challenge filtering — openclaw/ui/src/ui/gateway.ts:400-408', () => {
    it('does not forward connect.challenge to onEvent or subscribers', async () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:400-408
      //   if (evt.event === "connect.challenge") {
      //     ... void this.sendConnect(); return;
      //   }
      // Our client: client.ts:101-105
      //   if (frame.event === 'connect.challenge') {
      //     void this.handleChallenge(frame); // returns early, no dispatch
      //   } else { this.handleEvent(frame); }
      const onEvent = vi.fn();
      const challengeHandler = vi.fn();
      const client = createClient({ onEvent });
      client.subscribe('connect.challenge', challengeHandler);

      client.connect();
      mockWsInstance.simulateOpen();
      mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();

      // connect.challenge should NOT be forwarded to onEvent or subscribers
      expect(onEvent).not.toHaveBeenCalled();
      expect(challengeHandler).not.toHaveBeenCalled();

      client.disconnect();
    });
  });

  // ─── Connection state lifecycle ───────────────────────────────────

  describe('Connection state lifecycle — client.ts:336-341', () => {
    it('transitions through connecting -> authenticating -> connected', async () => {
      // Our client extends OpenClaw's implicit state with an explicit state machine:
      //   disconnected -> connecting -> authenticating -> connected
      // OpenClaw browser client has implicit state via this.ws, this.connectSent, etc.
      const states: string[] = [];
      const client = createClient({
        onStateChange: (state) => states.push(state),
      });

      client.connect();
      // Should be 'connecting'
      expect(states).toContain('connecting');

      mockWsInstance.simulateOpen();
      mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();
      // Should transition to 'authenticating'
      expect(states).toContain('authenticating');

      // Complete handshake
      const connectFrame = mockWsInstance.sent
        .map((s) => JSON.parse(s))
        .find((f: any) => f.method === 'connect');
      mockWsInstance.simulateMessage({
        type: 'res',
        id: connectFrame.id,
        ok: true,
        payload: HELLO_OK_PAYLOAD,
      });

      // Should transition to 'connected'
      expect(states).toContain('connected');
      expect(client.connectionState).toBe('connected');

      client.disconnect();
    });

    it('does not emit duplicate state change events', async () => {
      // Our client: client.ts:337
      //   if (this.state === state) return;
      const onStateChange = vi.fn();
      const client = createClient({ onStateChange });

      await completeHandshake(client, mockWsInstance);

      // Each state should appear exactly once in transitions
      const stateTransitions = onStateChange.mock.calls.map((c: any) => c[0]);
      const uniqueConsecutive = stateTransitions.filter(
        (s: string, i: number) => i === 0 || s !== stateTransitions[i - 1]
      );
      expect(stateTransitions).toEqual(uniqueConsecutive);

      client.disconnect();
    });
  });

  // ─── GatewayRequestError shape ────────────────────────────────────

  describe('GatewayRequestError — openclaw/ui/src/ui/gateway.ts:39-49', () => {
    it('has code, message, and optional details', () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:39-49
      //   constructor(error: GatewayErrorInfo) {
      //     super(error.message);
      //     this.name = "GatewayRequestError";
      //     this.gatewayCode = error.code;
      //     this.details = error.details;
      //   }
      // Our client: client.ts:13-23
      const err = new GatewayRequestError(ERROR_UNAUTHORIZED);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GatewayRequestError');
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.message).toBe('Authentication required');
      expect(err.details).toEqual({ code: 'AUTH_TOKEN_MISSING' });
    });

    it('defaults details to undefined when not provided', () => {
      // OpenClaw reference: ui/src/ui/gateway.ts:46
      //   this.details = error.details;
      const err = new GatewayRequestError({
        code: 'UNAVAILABLE',
        message: 'Service down',
      });
      expect(err.details).toBeUndefined();
    });
  });
});
