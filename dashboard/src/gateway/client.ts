import type {
  ConnectionState,
  EventFrame,
  GatewayErrorInfo,
  HelloOk,
  RequestFrame,
  ResponseFrame,
} from './types';
import { MIN_PROTOCOL, MAX_PROTOCOL } from './types';
import { ReconnectScheduler } from './reconnect';
import { getDeviceIdentity, buildV3Payload } from './device-identity';

export class GatewayRequestError extends Error {
  code: string;
  details?: unknown;

  constructor(info: GatewayErrorInfo) {
    super(info.message);
    this.name = 'GatewayRequestError';
    this.code = info.code;
    this.details = info.details;
  }
}

export interface GatewayClientOptions {
  url: string;
  token?: string;
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  onHello?: (hello: HelloOk) => void;
  onEvent?: (event: EventFrame) => void;
  onClose?: (code: number, reason: string) => void;
  onStateChange?: (state: ConnectionState) => void;
  onGap?: (expected: number, actual: number) => void;
  onConnectError?: (code: string, message: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const NON_RECOVERABLE_CODES = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_PAIRED',
  'DEVICE_AUTH_PUBLIC_KEY_INVALID',
  'DEVICE_AUTH_DEVICE_ID_MISMATCH',
]);

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private lastSeq = 0;
  private state: ConnectionState = 'disconnected';
  private opts: GatewayClientOptions;
  private reconnector = new ReconnectScheduler();
  private intentionalClose = false;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.intentionalClose = false;
    // Preserve 'reconnecting' state so the close handler continues the retry loop
    if (this.state !== 'reconnecting') {
      this.setState('connecting');
    }

    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      // Wait for connect.challenge event from server
    };

    ws.onmessage = (ev: MessageEvent) => {
      let frame: ResponseFrame | EventFrame;
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      if (frame.type === 'event') {
        if (frame.event === 'connect.challenge') {
          void this.handleChallenge(frame);
        } else {
          this.handleEvent(frame);
        }
      } else if (frame.type === 'res') {
        this.handleResponse(frame);
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      console.warn(`[GatewayClient] WebSocket closed: code=${ev.code} reason="${ev.reason}" state=${this.state}`);
      const wasConnected = this.state === 'connected';
      this.opts.onClose?.(ev.code, ev.reason);

      // Reject all pending requests
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Connection closed'));
        this.pending.delete(id);
      }

      if (this.intentionalClose || ev.code === 1000 || ev.code === 1001) {
        this.setState('disconnected');
        return;
      }

      // Schedule reconnect
      if (wasConnected || this.state === 'reconnecting') {
        this.setState('reconnecting');
        this.reconnector.schedule(() => this.connect());
      } else {
        this.setState('disconnected');
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.reconnector.cancel();
    this.ws?.close(1000, 'client disconnect');
    this.ws = null;
    this.setState('disconnected');
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.state !== 'connected') {
      console.warn(`[GatewayClient] request(${method}) rejected: state=${this.state}, ws=${!!this.ws}`);
      throw new Error('Not connected to gateway');
    }
    console.log(`[GatewayClient] → ${method}`, params ?? '');

    const id = crypto.randomUUID();
    const frame: RequestFrame = { type: 'req', id, method };
    if (params !== undefined) {
      frame.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method} (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  subscribe(event: string, handler: (payload: unknown) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  // ---------------------------------------------------------------------------
  // Handshake with Ed25519 device identity (protocol v3)
  // ---------------------------------------------------------------------------

  private async handleChallenge(frame: EventFrame): Promise<void> {
    this.setState('authenticating');
    const challengePayload = frame.payload as { nonce?: string; ts?: number } | undefined;
    const nonce = challengePayload?.nonce ?? '';

    // Obtain (or generate) a stable Ed25519 device identity.
    // Returns null in insecure contexts (HTTP on non-localhost) where crypto.subtle
    // is unavailable. In that case, fall back to token-only auth if a token exists.
    let identity;
    try {
      identity = await getDeviceIdentity();
    } catch (e) {
      console.warn('[GatewayClient] Device identity generation failed:', e);
      identity = null;
    }

    // No device identity AND no token → cannot authenticate at all
    if (!identity && !this.opts.token) {
      console.error('[GatewayClient] No device identity and no token — cannot authenticate. '
        + 'Access via https:// or http://localhost to enable device auth, or provide a token.');
      this.reconnector.cancel();
      this.ws?.close(1000, 'device identity unavailable');
      this.setState('disconnected');
      return;
    }

    // Bail out if the socket closed while we were generating keys
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const signedAt = Date.now();
    const clientId = 'openclaw-control-ui';
    const clientMode = 'ui';
    const role = 'operator';
    const scopes = ['operator.read', 'operator.write', 'operator.admin'];
    const token = this.opts.token ?? '';
    const platform = this.opts.platform ?? 'browser';

    // Build device auth fields only when identity is available
    let deviceField: Record<string, unknown> | undefined;
    if (identity) {
      const sigPayload = buildV3Payload({
        deviceId: identity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAt,
        token,
        nonce,
        platform,
        deviceFamily: '',
      });

      let signature: string;
      try {
        signature = await identity.sign(sigPayload);
      } catch {
        this.reconnector.cancel();
        this.ws?.close(1000, 'device signature failed');
        this.setState('disconnected');
        return;
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      deviceField = {
        id: identity.deviceId,
        publicKey: identity.publicKey,
        signature,
        signedAt,
        nonce,
      };
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const id = crypto.randomUUID();
    const connectFrame: RequestFrame = {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: MIN_PROTOCOL,
        maxProtocol: MAX_PROTOCOL,
        client: {
          id: clientId,
          version: this.opts.clientVersion ?? '0.4.1',
          platform,
          mode: clientMode,
          displayName: this.opts.clientName ?? 'Research-Claw Dashboard',
        },
        role,
        scopes,
        ...(token ? { auth: { token } } : {}),
        ...(deviceField ? { device: deviceField } : {}),
      },
    };

    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.ws?.close();
      this.setState('disconnected');
    }, REQUEST_TIMEOUT_MS);

    this.pending.set(id, {
      resolve: (payload) => {
        const hello = payload as HelloOk;
        this.setState('connected');
        this.reconnector.reset();
        this.lastSeq = 0;
        this.opts.onHello?.(hello);
      },
      reject: (err) => {
        console.error('[GatewayClient] Connect handshake rejected:', err instanceof GatewayRequestError ? `${err.code}: ${err.message}` : err);
        if (err instanceof GatewayRequestError) {
          this.opts.onConnectError?.(err.code, err.message);
          const isNonRecoverable = NON_RECOVERABLE_CODES.has(err.code) ||
            (err.code === 'INVALID_REQUEST' && err.message.includes('token'));
          if (isNonRecoverable) {
            this.reconnector.cancel();
            this.ws?.close();
            this.setState('disconnected');
          }
        }
      },
      timer,
    });

    this.ws.send(JSON.stringify(connectFrame));
  }

  // ---------------------------------------------------------------------------

  private handleResponse(frame: ResponseFrame): void {
    const entry = this.pending.get(frame.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(frame.id);

    if (frame.ok) {
      console.log(`[GatewayClient] ← ${frame.id.slice(0, 8)} OK`, typeof frame.payload === 'object' ? frame.payload : '');
      entry.resolve(frame.payload);
    } else {
      console.warn(`[GatewayClient] ← ${frame.id.slice(0, 8)} ERR`, frame.error);
      entry.reject(new GatewayRequestError(frame.error ?? { code: 'UNKNOWN', message: 'Unknown error' }));
    }
  }

  private handleEvent(frame: EventFrame): void {
    if (frame.seq !== undefined) {
      if (this.lastSeq > 0 && frame.seq > this.lastSeq + 1) {
        this.opts.onGap?.(this.lastSeq + 1, frame.seq);
      }
      this.lastSeq = frame.seq;
    }

    const handlers = this.eventHandlers.get(frame.event);
    if (handlers) {
      for (const h of handlers) {
        h(frame.payload);
      }
    }
    this.opts.onEvent?.(frame);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    console.log(`[GatewayClient] ${this.state} → ${state}`);
    this.state = state;
    this.opts.onStateChange?.(state);
  }
}
