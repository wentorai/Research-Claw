/**
 * Behavioral parity: a cron failure episode must not survive a break in the
 * event stream.
 *
 * The pure classifier tests
 * (`cron-failure-notification.parity.test.ts`) pass the epoch in by hand, so
 * they prove the rule but not the wiring. These two drive the real chain —
 * MockWebSocket -> GatewayClient -> useGatewayStore -> CronEventListener — to
 * prove that the epoch actually changes, and changes early enough, on the two
 * ways a stream can break:
 *
 *   T1  a detected sequence gap  (GatewayClient.handleEvent -> onGap)
 *   T2  a reconnect              (no gap is detectable at all — see T2's note)
 *
 * The failure they guard against is silence, which no assertion on a happy
 * path can catch: the user stops being told their scheduled job is broken and
 * nothing anywhere reports an error.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRON_AUTH_FIRST, CRON_AUTH_SECOND } from '../../__fixtures__/gateway-payloads/cron-events';
import { CONNECT_CHALLENGE, HELLO_OK_PAYLOAD } from '../../__fixtures__/gateway-payloads/protocol-frames';

const notification = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const MockApp = Object.assign(actual.App, {
    useApp: () => ({ notification }),
  });
  return { ...actual, App: MockApp };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      return `${key}:${Object.values(params).join(':')}`;
    },
  }),
}));

/**
 * Real Ed25519 signing is available under happy-dom, but it resolves on its own
 * schedule. Stubbing it keeps the handshake to a bounded number of microtasks,
 * which is what lets the tests below deliver frames with no `await` in between —
 * the property T1 actually measures. Everything downstream of the handshake is
 * the real implementation.
 */
vi.mock('../../gateway/device-identity', () => ({
  getDeviceIdentity: vi.fn().mockResolvedValue({
    deviceId: 'mock-device-id-sha256hex64chars0000000000000000000000000000000000',
    publicKey: 'mock-public-key-base64url',
    sign: vi.fn().mockResolvedValue('mock-signature-base64url'),
  }),
  buildV3Payload: vi.fn().mockReturnValue('v3|mock-payload'),
}));

import CronEventListener from '../../components/CronEventListener';
import { useCronStore } from '../../stores/cron';
import { useGatewayStore } from '../../stores/gateway';
import { useMonitorStore } from '../../stores/monitor';
import { useUiStore } from '../../stores/ui';

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }

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

let ws: MockWebSocket;
const OrigWebSocket = globalThis.WebSocket;
let warnSpy: ReturnType<typeof vi.spyOn>;

/** Drain the handshake's chained promise resolutions under fake timers. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Answer the pending `connect` request with hello-ok, completing the handshake. */
function completeHandshake(): void {
  const connectFrame = ws.sent
    .map((s) => JSON.parse(s))
    .reverse()
    .find((f: { method?: string }) => f.method === 'connect');
  expect(connectFrame).toBeDefined();
  ws.simulateMessage({ type: 'res', id: connectFrame.id, ok: true, payload: HELLO_OK_PAYLOAD });
}

/** A gateway event frame carrying a cron completion payload. */
function cronFrame(payload: unknown, seq: number) {
  return { type: 'event', event: 'cron', payload, seq };
}

/** Bring the store's real GatewayClient all the way to 'connected'. */
async function connectStore(): Promise<void> {
  await act(async () => {
    useGatewayStore.getState().connect('ws://127.0.0.1:28789');
    ws.simulateOpen();
    ws.simulateMessage(CONNECT_CHALLENGE);
    await flushMicrotasks();
    completeHandshake();
    await flushMicrotasks();
  });
  expect(useGatewayStore.getState().state).toBe('connected');
}

/** Did the sequence-gap branch of the store's onGap run? */
function sawGapWarning(): boolean {
  return warnSpy.mock.calls.some((c) => String(c[0]).includes('Event sequence gap'));
}

beforeEach(() => {
  vi.useFakeTimers();
  notification.info.mockReset();
  notification.error.mockReset();
  notification.destroy.mockReset();
  localStorage.clear();

  ws = new MockWebSocket();
  const MockWsCtor: unknown = Object.assign(
    vi.fn().mockImplementation(() => ws),
    { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 },
  );
  (globalThis as { WebSocket: unknown }).WebSocket = MockWsCtor;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  useUiStore.setState({
    notifications: [],
    unreadCount: 0,
    notificationSoundEnabled: false,
    rightPanelTab: 'library',
    rightPanelOpen: false,
  });
  useCronStore.setState({ presets: [], presetsLoaded: true });
  useMonitorStore.setState({ monitors: [], loaded: true, loading: false });
  useGatewayStore.setState({ eventEpoch: 0 });
});

afterEach(async () => {
  cleanup();
  /**
   * The real post-hello hydration (config, presets, monitors, sessions) is
   * still in flight on the mock socket, and closing it rejects every one of
   * them at once. Each store handles its own rejection; only the logging
   * reaches here, and unmuted it buries a real failure under a screen of
   * teardown stack traces. Muted across the disconnect and the microtasks its
   * rejections land in — console stays live for the test bodies above.
   */
  const quiet = (['error', 'info', 'log'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  await act(async () => {
    useGatewayStore.getState().disconnect();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  quiet.forEach((s) => s.mockRestore());
  vi.useRealTimers();
  // clearAllMocks, not restoreAllMocks: the latter would undo the vi.mock
  // factories above. console.warn is restored explicitly.
  warnSpy.mockRestore();
  vi.clearAllMocks();
  (globalThis as { WebSocket: unknown }).WebSocket = OrigWebSocket;
});

describe('cron failure episode invalidation — real gateway link', () => {
  /**
   * The reported sequence: an episode is reported at count 1; the success that
   * ends it is dropped; the next episode's first run is dropped too; the first
   * run we see is count 2. On the counters alone that is exactly the shape of
   * the reported episode's next run, and it used to be read as one — silently,
   * for the rest of that episode.
   *
   * The gap in the sequence numbers is the evidence that the reading is unsafe,
   * and it arrives on the very frame in question.
   */
  it('re-reports the first visible run of a new episode when a gap hid the runs before it', async () => {
    await connectStore();
    render(<CronEventListener />);

    act(() => {
      ws.simulateMessage(cronFrame(CRON_AUTH_FIRST, 1));
    });
    expect(notification.error).toHaveBeenCalledTimes(1);
    const epochBefore = useGatewayStore.getState().eventEpoch;

    /**
     * seq 5 after seq 1: three frames are unaccounted for, among them the
     * success and the new episode's first failure.
     *
     * There is deliberately no `await` inside this act(). GatewayClient.handleEvent
     * calls onGap and then fans this same frame out to subscribers in one
     * synchronous turn, so an invalidation that landed a microtask later would
     * arrive after the decision it was supposed to inform — and the test would
     * still pass if it were written with an await here.
     */
    act(() => {
      ws.simulateMessage(cronFrame(CRON_AUTH_SECOND, 5));
    });

    expect(sawGapWarning()).toBe(true);
    expect(useGatewayStore.getState().eventEpoch).toBeGreaterThan(epochBefore);
    expect(notification.error).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().notifications).toHaveLength(2);
  });

  /**
   * The same hole, reached the other way. Sequence numbers are per connection
   * (the server keys clientSeq off the socket), so after a reconnect the stream
   * restarts at 1 and the client zeroes lastSeq: no gap is detectable, however
   * long the dashboard was away or however many runs completed meanwhile. If
   * invalidation hung off onGap alone, this path would stay silent.
   */
  it('re-reports after a reconnect, where no sequence gap is observable at all', async () => {
    await connectStore();
    render(<CronEventListener />);

    act(() => {
      ws.simulateMessage(cronFrame(CRON_AUTH_FIRST, 1));
    });
    expect(notification.error).toHaveBeenCalledTimes(1);
    const epochBefore = useGatewayStore.getState().eventEpoch;

    // Drop the socket, then let the backoff timer drive the real reconnect.
    await act(async () => {
      ws.simulateClose(1006, 'lost');
      await vi.advanceTimersByTimeAsync(2_000);
      ws.simulateOpen();
      ws.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();
      completeHandshake();
      await flushMicrotasks();
    });
    expect(useGatewayStore.getState().state).toBe('connected');

    // Same job, count 2, back at seq 1 on the fresh connection.
    act(() => {
      ws.simulateMessage(cronFrame(CRON_AUTH_SECOND, 1));
    });

    // The point of the case: nothing here looked like a gap, and it still spoke up.
    expect(sawGapWarning()).toBe(false);
    expect(useGatewayStore.getState().eventEpoch).toBeGreaterThan(epochBefore);
    expect(notification.error).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().notifications).toHaveLength(2);
  });

  /**
   * Why the invalidation hangs off leaving 'connected' and not off onHello alone.
   *
   * The server registers a connection for broadcasts before it answers the
   * connect request — `clients.add(next)` in
   * openclaw/src/gateway/server/ws-connection.ts:528 (via setClient), called
   * from message-handler.ts:1726, while the hello-ok is only written at
   * message-handler.ts:1899. At least one branch awaits in between (bootstrap
   * token redemption, :1874). Events broadcast inside that window reach the
   * socket ahead of hello-ok.
   *
   * On this side nothing stops them: handleEvent has no connection-state gate,
   * and eventHandlers is never cleared on close, so they are delivered to the
   * subscriber registered on the previous connection. Leaving 'connected' is
   * the last moment guaranteed to precede every frame of the next connection.
   */
  it('re-reports a frame that arrives after the reconnect but before hello-ok', async () => {
    await connectStore();
    render(<CronEventListener />);

    act(() => {
      ws.simulateMessage(cronFrame(CRON_AUTH_FIRST, 1));
    });
    expect(notification.error).toHaveBeenCalledTimes(1);
    const epochBefore = useGatewayStore.getState().eventEpoch;

    // Reconnect as far as the challenge, and stop short of answering connect.
    await act(async () => {
      ws.simulateClose(1006, 'lost');
      await vi.advanceTimersByTimeAsync(2_000);
      ws.simulateOpen();
      ws.simulateMessage(CONNECT_CHALLENGE);
      await flushMicrotasks();
    });
    expect(useGatewayStore.getState().state).toBe('authenticating');

    act(() => {
      ws.simulateMessage(cronFrame(CRON_AUTH_SECOND, 1));
    });

    // lastSeq is not zeroed until the connect resolves, so seq 1 here is below
    // the watermark and reads as ordinary: no gap, and no hello yet either.
    expect(sawGapWarning()).toBe(false);
    expect(useGatewayStore.getState().eventEpoch).toBeGreaterThan(epochBefore);
    expect(notification.error).toHaveBeenCalledTimes(2);

    // Finish the handshake so teardown closes a settled connection.
    await act(async () => {
      completeHandshake();
      await flushMicrotasks();
    });
  });

  /**
   * The counterweight. Invalidation that fired on anything else would turn every
   * later run of a known-broken job back into a toast, which is the failure mode
   * users actually punish. Same episode, same unbroken stream, no repeat.
   */
  it('stays silent for the next run of a reported episode while the stream is unbroken', async () => {
    await connectStore();
    render(<CronEventListener />);

    act(() => {
      ws.simulateMessage(cronFrame(CRON_AUTH_FIRST, 1));
    });
    expect(notification.error).toHaveBeenCalledTimes(1);
    const epochBefore = useGatewayStore.getState().eventEpoch;

    act(() => {
      ws.simulateMessage(cronFrame(CRON_AUTH_SECOND, 2));
    });

    expect(sawGapWarning()).toBe(false);
    expect(useGatewayStore.getState().eventEpoch).toBe(epochBefore);
    expect(notification.error).toHaveBeenCalledTimes(1);
  });
});
