/**
 * Behavioral Parity Tests: Device Auth Fallback to Token-Only
 *
 * Verifies that the Dashboard client falls back to token-only authentication
 * when Web Crypto API (crypto.subtle) is unavailable — e.g., when accessing
 * the Dashboard via a LAN IP over HTTP (non-secure context).
 *
 * Reference files:
 *   - openclaw/dist/gateway-cli-CbAOelvx.js:22431-22439 (evaluateMissingDeviceIdentity)
 *   - openclaw/dist/gateway-cli-CbAOelvx.js:8589-8590 (roleCanSkipDeviceIdentity)
 *   - openclaw/dist/plugin-sdk/gateway/protocol/schema/frames.d.ts:8-41 (device is TOptional)
 *   - openclaw/dist/auth-ztX1XT7i.js:362-382 (token validation)
 *
 * Server behavior (verified from OpenClaw source):
 *   When dangerouslyDisableDeviceAuth=true AND role="operator" AND valid token:
 *     → evaluateMissingDeviceIdentity returns { kind: "allow" }
 *     → shouldSkipControlUiPairing returns true
 *     → Connection accepted WITHOUT device field
 *
 * Each test cites the OpenClaw source file and line number it verifies parity with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayClient } from '../../gateway/client';
import { MIN_PROTOCOL, MAX_PROTOCOL } from '../../gateway/types';
import {
  CONNECT_CHALLENGE,
  HELLO_OK_PAYLOAD,
} from '../../__fixtures__/gateway-payloads/protocol-frames';

// ---------------------------------------------------------------------------
// Mock WebSocket (same as gateway-protocol.parity.test.ts)
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
    if (this.onclose) {
      this.onclose({ code: code ?? 1000, reason: reason ?? '' });
    }
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

let mockWsInstance: MockWebSocket;
const OrigWebSocket = globalThis.WebSocket;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

// ---------------------------------------------------------------------------
// Tests: Device identity returns null in insecure context
// ---------------------------------------------------------------------------

describe('Device auth fallback — crypto.subtle unavailable (insecure context)', () => {
  // Mock getDeviceIdentity to return null — simulates insecure context where
  // crypto.subtle is undefined. The actual getDeviceIdentity change is tested
  // separately; here we test handleChallenge's reaction to a null identity.
  vi.mock('../../gateway/device-identity', () => ({
    getDeviceIdentity: vi.fn().mockResolvedValue(null),
    buildV3Payload: vi.fn().mockReturnValue('v3|mock-payload'),
  }));

  beforeEach(() => {
    vi.useFakeTimers();
    mockWsInstance = new MockWebSocket();
    const MockWsCtor: any = vi.fn().mockImplementation(() => mockWsInstance);
    MockWsCtor.OPEN = 1;
    MockWsCtor.CONNECTING = 0;
    MockWsCtor.CLOSING = 2;
    MockWsCtor.CLOSED = 3;
    (globalThis as any).WebSocket = MockWsCtor;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    (globalThis as any).WebSocket = OrigWebSocket;
  });

  it('sends connect frame WITHOUT device field when identity is null and token is present', async () => {
    // OpenClaw server reference: gateway-cli-CbAOelvx.js:22431-22439
    //   evaluateMissingDeviceIdentity: if hasDeviceIdentity=false AND
    //   roleCanSkipDeviceIdentity(role, sharedAuthOk) → { kind: "allow" }
    // OpenClaw server reference: gateway-cli-CbAOelvx.js:8589-8590
    //   roleCanSkipDeviceIdentity: role === "operator" && sharedAuthOk → true
    // OpenClaw schema: frames.d.ts:8-41
    //   device field is TOptional — server accepts connect without it
    const onStateChange = vi.fn();
    const client = new GatewayClient({
      url: 'ws://192.168.1.101:28789',
      token: 'research-claw',
      onStateChange,
    });

    client.connect();
    mockWsInstance.simulateOpen();
    mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
    await flushMicrotasks();

    // Client should have sent a connect frame
    const connectFrame = mockWsInstance.sent
      .map((s) => JSON.parse(s))
      .find((f: any) => f.method === 'connect');

    expect(connectFrame).toBeDefined();

    // Token auth MUST be included
    expect(connectFrame.params.auth).toEqual({ token: 'research-claw' });

    // Device field MUST be absent (not null, not empty — absent)
    expect(connectFrame.params.device).toBeUndefined();

    // Required fields still present
    expect(connectFrame.params.minProtocol).toBe(MIN_PROTOCOL);
    expect(connectFrame.params.maxProtocol).toBe(MAX_PROTOCOL);
    expect(connectFrame.params.client).toBeDefined();
    expect(connectFrame.params.role).toBe('operator');
    expect(Array.isArray(connectFrame.params.scopes)).toBe(true);

    client.disconnect();
  });

  it('completes full handshake with token-only auth when server responds hello-ok', async () => {
    // Verifies the happy path: token-only connect → server accepts → connected state
    const onHello = vi.fn();
    const client = new GatewayClient({
      url: 'ws://192.168.1.101:28789',
      token: 'research-claw',
      onHello,
    });

    client.connect();
    mockWsInstance.simulateOpen();
    mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
    await flushMicrotasks();

    const connectFrame = mockWsInstance.sent
      .map((s) => JSON.parse(s))
      .find((f: any) => f.method === 'connect');

    // Server responds with hello-ok
    mockWsInstance.simulateMessage({
      type: 'res',
      id: connectFrame.id,
      ok: true,
      payload: HELLO_OK_PAYLOAD,
    });

    expect(client.isConnected).toBe(true);
    expect(client.connectionState).toBe('connected');
    expect(onHello).toHaveBeenCalledWith(HELLO_OK_PAYLOAD);

    client.disconnect();
  });

  it('disconnects gracefully when identity is null AND no token available', async () => {
    // When there's no device identity AND no token, authentication is impossible.
    // Client should close the connection cleanly, not crash or infinite-retry.
    const onStateChange = vi.fn();
    const client = new GatewayClient({
      url: 'ws://192.168.1.101:28789',
      // No token!
      onStateChange,
    });

    client.connect();
    mockWsInstance.simulateOpen();
    mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
    await flushMicrotasks();

    // Should have closed the WebSocket
    expect(mockWsInstance.closed).toBe(true);
    // Should NOT have sent a connect frame (can't authenticate)
    const connectFrame = mockWsInstance.sent
      .map((s) => JSON.parse(s))
      .find((f: any) => f.method === 'connect');
    expect(connectFrame).toBeUndefined();

    // Should be in disconnected state (not reconnecting)
    expect(client.connectionState).toBe('disconnected');

    client.disconnect();
  });

  it('does not attempt to sign payload when identity is null', async () => {
    // When identity is null, the client must NOT try to call identity.sign()
    // or access identity.deviceId — these would throw TypeError.
    const client = new GatewayClient({
      url: 'ws://192.168.1.101:28789',
      token: 'research-claw',
    });

    // This should NOT throw
    client.connect();
    mockWsInstance.simulateOpen();
    mockWsInstance.simulateMessage(CONNECT_CHALLENGE);
    await flushMicrotasks();

    // Verify no TypeError thrown — connection reached the point of sending
    const connectFrame = mockWsInstance.sent
      .map((s) => JSON.parse(s))
      .find((f: any) => f.method === 'connect');
    expect(connectFrame).toBeDefined();

    client.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Tests: getDeviceIdentity behavior in insecure context
// ---------------------------------------------------------------------------

describe('getDeviceIdentity — insecure context handling', () => {
  // These tests import the REAL getDeviceIdentity (not mocked)
  // and verify it handles missing crypto.subtle gracefully.

  // We need to clear the module mock from the previous describe block
  // and test the real implementation.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when crypto.subtle is unavailable', async () => {
    // Simulates an insecure context (HTTP on non-localhost)
    // where crypto.subtle is undefined.
    //
    // Reference: MDN Web Crypto API
    //   "This interface is only available in a secure context (HTTPS / localhost)."
    const originalSubtle = globalThis.crypto?.subtle;
    try {
      // Remove crypto.subtle to simulate insecure context
      if (globalThis.crypto) {
        Object.defineProperty(globalThis.crypto, 'subtle', {
          value: undefined,
          configurable: true,
          writable: true,
        });
      }

      // Import the real module (bypass the vi.mock in the other describe)
      const { getDeviceIdentity: realGetDeviceIdentity } =
        await vi.importActual<typeof import('../../gateway/device-identity')>(
          '../../gateway/device-identity'
        );

      // Clear any cached identity from previous calls
      // (the module caches identity in a `let cached` variable)
      // We need a fresh module to test this properly.

      const result = await realGetDeviceIdentity();
      expect(result).toBeNull();
    } finally {
      // Restore crypto.subtle
      if (globalThis.crypto && originalSubtle) {
        Object.defineProperty(globalThis.crypto, 'subtle', {
          value: originalSubtle,
          configurable: true,
          writable: true,
        });
      }
    }
  });
});
