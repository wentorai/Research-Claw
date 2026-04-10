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
import { RC_VERSION } from '../version';
import { getDeviceIdentity, buildV3Payload } from './device-identity';
import {
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  clearDeviceAuthToken,
} from './device-auth';

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

/** Close info passed to onClose callback (aligned with OC app-gateway.ts). */
export interface CloseInfo {
  code: number;
  reason: string;
  error?: GatewayErrorInfo;
}

/** Gap info passed to onGap callback (aligned with OC GatewayBrowserClientOptions). */
export interface GapInfo {
  expected: number;
  received: number;
}

export interface GatewayClientOptions {
  url: string;
  token?: string;
  password?: string;
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  instanceId?: string;
  onHello?: (hello: HelloOk) => void;
  onEvent?: (event: EventFrame) => void;
  onClose?: (info: CloseInfo) => void;
  onStateChange?: (state: ConnectionState) => void;
  onGap?: (info: GapInfo) => void;
  onConnectError?: (code: string, message: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

// Application-defined close code for connect failures.
// Browser rejects 1008 "Policy Violation"; 4008 is in the app-defined range (4000-4999).
// Aligned with OC gateway.ts CONNECT_FAILED_CLOSE_CODE.
const CONNECT_FAILED_CLOSE_CODE = 4008;

// Top-level error codes that are definitely non-recoverable (legacy check)
const NON_RECOVERABLE_CODES = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_PAIRED',
  'DEVICE_AUTH_PUBLIC_KEY_INVALID',
  'DEVICE_AUTH_DEVICE_ID_MISMATCH',
  'CONTROL_UI_ORIGIN_NOT_ALLOWED',
]);

// Structured detail codes from OC v2026.3.12+ (error.details.code).
// Auth errors that won't resolve without user action — don't auto-reconnect.
// Aligned with OC's isNonRecoverableAuthError() in gateway.ts.
//
// NOTE: AUTH_TOKEN_MISMATCH is intentionally NOT included here because the
// client supports a bounded one-time retry with a cached device token
// when the endpoint is trusted. Reconnect suppression for mismatch is handled
// via deviceTokenRetryBudgetUsed (after retry budget is exhausted).
const NON_RECOVERABLE_DETAIL_CODES = new Set([
  'AUTH_TOKEN_MISSING',
  'AUTH_BOOTSTRAP_TOKEN_INVALID',
  'AUTH_PASSWORD_MISSING',
  'AUTH_PASSWORD_MISMATCH',
  'AUTH_RATE_LIMITED',
  'PAIRING_REQUIRED',
  'CONTROL_UI_DEVICE_IDENTITY_REQUIRED',
  'CONTROL_UI_ORIGIN_NOT_ALLOWED',
  'DEVICE_IDENTITY_REQUIRED',
]);

/** Extract structured detail code from gateway error. */
function resolveDetailCode(err: { details?: unknown }): string | undefined {
  if (!err.details || typeof err.details !== 'object' || Array.isArray(err.details)) return undefined;
  return (err.details as { code?: string }).code;
}

/** Check both legacy top-level code and structured details.code */
function isNonRecoverableError(err: GatewayRequestError): boolean {
  if (NON_RECOVERABLE_CODES.has(err.code)) return true;
  const detailCode = resolveDetailCode(err);
  if (detailCode && NON_RECOVERABLE_DETAIL_CODES.has(detailCode)) return true;
  if (err.code === 'INVALID_REQUEST' && err.message.includes('token')) return true;
  return false;
}

/** Check if the gateway URL is a trusted loopback endpoint (safe for device token retry). */
function isTrustedRetryEndpoint(url: string): boolean {
  try {
    const gatewayUrl = new URL(url, window.location.href);
    const host = gatewayUrl.hostname.trim().toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.')) {
      return true;
    }
    const pageUrl = new URL(window.location.href);
    return gatewayUrl.host === pageUrl.host;
  } catch {
    return false;
  }
}

/** Generate a UUID with fallback for insecure contexts. */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: crypto.getRandomValues is available in all modern browsers
  // including insecure contexts, unlike crypto.randomUUID.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private lastSeq = 0;
  private state: ConnectionState = 'disconnected';
  private opts: GatewayClientOptions;
  private reconnector = new ReconnectScheduler();
  private intentionalClose = false;
  // Pending connect error: captured during handshake reject, consumed in onclose.
  // Aligned with OC gateway.ts pendingConnectError pattern.
  private pendingConnectError: GatewayErrorInfo | undefined;
  // Device token retry: bounded one-time retry with cached device token on mismatch.
  // Aligned with OC gateway.ts deviceTokenRetryBudgetUsed pattern.
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  // Tick-based connection liveness detection (aligned with OC client.ts:137-140).
  // Gateway broadcasts 'tick' events every tickIntervalMs. If none arrive within
  // 2x the interval, the connection is presumed dead (zombie) and closed.
  private lastTick: number | null = null;
  private tickIntervalMs = 30_000;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Check tick liveness and close if stale. Call on page visibility resume
   * to catch zombie connections that the throttled tick watchdog interval
   * (Chrome backgrounds tabs to 1min+) cannot detect in time.
   *
   * Returns true if the connection was closed due to stale tick.
   */
  checkTickLiveness(): boolean {
    if (!this.lastTick || this.state !== 'connected') return false;
    const gap = Date.now() - this.lastTick;
    if (gap > this.tickIntervalMs * 2) {
      console.warn(
        `[GatewayClient] Visibility resume tick check: ${gap}ms since last tick — forcing reconnect`,
      );
      this.ws?.close(4000, 'tick timeout');
      return true;
    }
    return false;
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.intentionalClose = false;
    this.stopTickWatch();
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
      const connectError = this.pendingConnectError;
      this.pendingConnectError = undefined;
      this.ws = null;
      this.stopTickWatch();

      // Reject all pending requests
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Connection closed'));
        this.pending.delete(id);
      }

      // Pass error info to onClose so the store can distinguish error types
      this.opts.onClose?.({ code: ev.code, reason: ev.reason ?? '', error: connectError });

      if (this.intentionalClose || ev.code === 1000) {
        this.setState('disconnected');
        return;
      }

      // Suppress reconnect when AUTH_TOKEN_MISMATCH retry budget is exhausted
      // (aligned with OC gateway.ts close handler logic).
      const connectErrorCode = resolveDetailCode(connectError ?? {});
      if (
        connectErrorCode === 'AUTH_TOKEN_MISMATCH' &&
        this.deviceTokenRetryBudgetUsed &&
        !this.pendingDeviceTokenRetry
      ) {
        this.setState('disconnected');
        return;
      }

      // Don't reconnect on non-recoverable auth errors
      if (connectError && isNonRecoverableError(
        new GatewayRequestError(connectError),
      )) {
        this.setState('disconnected');
        return;
      }

      // Always schedule reconnect on abnormal close (including first connect failure).
      this.setState('reconnecting');
      this.reconnector.schedule(() => this.connect());
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.reconnector.cancel();
    this.stopTickWatch();
    this.pendingConnectError = undefined;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.ws?.close(1000, 'client disconnect');
    this.ws = null;
    this.setState('disconnected');
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.ws || this.state !== 'connected') {
      console.warn(`[GatewayClient] request(${method}) rejected: state=${this.state}, ws=${!!this.ws}`);
      throw new Error('Not connected to gateway');
    }
    console.log(`[GatewayClient] → ${method}`, params ?? '');

    const id = generateUUID();
    // Always include params field (aligned with OC — gateway always sends `params`).
    const frame: RequestFrame = { type: 'req', id, method, params: params ?? {} };
    const timeout = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method} (${timeout}ms)`));
      }, timeout);

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
    const clientMode = 'webchat';
    const role = 'operator';
    const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing'];
    const explicitToken = this.opts.token?.trim() || undefined;
    const explicitPassword = this.opts.password?.trim() || undefined;
    const platform = this.opts.platform ?? 'browser';

    // --- Device token selection (aligned with OC selectConnectAuth) ---
    // Priority: explicit token > stored device token > no auth
    let authToken = explicitToken;
    let authDeviceToken: string | undefined;
    const storedToken = identity
      ? loadDeviceAuthToken({ deviceId: identity.deviceId, role })?.token
      : undefined;

    if (this.pendingDeviceTokenRetry && explicitToken && storedToken && isTrustedRetryEndpoint(this.opts.url)) {
      // Retry with device token after mismatch (bounded, one-time)
      authDeviceToken = storedToken;
      this.pendingDeviceTokenRetry = false;
    } else if (!explicitToken && storedToken) {
      // No explicit token — use stored device token as auth
      authToken = storedToken;
    }

    const tokenForAuth = authToken ?? '';

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
        token: tokenForAuth,
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

    // Build auth field (aligned with OC gateway.ts:268-275)
    const auth = tokenForAuth || authDeviceToken || explicitPassword
      ? {
          token: tokenForAuth || undefined,
          deviceToken: authDeviceToken,
          password: explicitPassword,
        }
      : undefined;

    const id = generateUUID();
    const connectFrame: RequestFrame = {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: MIN_PROTOCOL,
        maxProtocol: MAX_PROTOCOL,
        client: {
          id: clientId,
          version: this.opts.clientVersion ?? RC_VERSION,
          platform,
          mode: clientMode,
          displayName: this.opts.clientName ?? 'Research-Claw Dashboard',
          instanceId: this.opts.instanceId,
        },
        caps: ['tool-events'],
        role,
        scopes,
        ...(auth ? { auth } : {}),
        ...(deviceField ? { device: deviceField } : {}),
        // Send userAgent and locale (aligned with OC connect params)
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
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
        // Tick-based liveness detection (aligned with OC client.ts:404-409)
        this.tickIntervalMs = typeof hello.policy?.tickIntervalMs === 'number'
          ? hello.policy.tickIntervalMs : 30_000;
        this.lastTick = Date.now();
        this.startTickWatch();
        // Reset retry state on successful connect
        this.pendingDeviceTokenRetry = false;
        this.deviceTokenRetryBudgetUsed = false;

        // Store device token from hello response for future reconnects
        // (aligned with OC gateway.ts hello handler: storeDeviceAuthToken)
        if (hello?.auth?.deviceToken && identity) {
          storeDeviceAuthToken({
            deviceId: identity.deviceId,
            role: hello.auth.role ?? role,
            token: hello.auth.deviceToken,
            scopes: hello.auth.scopes ?? [],
          });
        }

        this.opts.onHello?.(hello);
      },
      reject: (err) => {
        console.error('[GatewayClient] Connect handshake rejected:', err instanceof GatewayRequestError ? `${err.code}: ${err.message}` : err);
        if (err instanceof GatewayRequestError) {
          const errDetailCode = resolveDetailCode(err);

          // Determine if we should retry with a cached device token
          // (aligned with OC gateway.ts catch handler logic)
          const recoveryAdvice = err.details && typeof err.details === 'object'
            ? err.details as { canRetryWithDeviceToken?: boolean; recommendedNextStep?: string }
            : {};
          const canRetryWithDeviceToken =
            errDetailCode === 'AUTH_TOKEN_MISMATCH' ||
            recoveryAdvice.canRetryWithDeviceToken === true ||
            recoveryAdvice.recommendedNextStep === 'retry_with_device_token';
          const shouldRetry =
            !this.deviceTokenRetryBudgetUsed &&
            !authDeviceToken &&
            Boolean(explicitToken) &&
            Boolean(identity) &&
            Boolean(storedToken) &&
            canRetryWithDeviceToken &&
            isTrustedRetryEndpoint(this.opts.url);

          if (shouldRetry) {
            this.pendingDeviceTokenRetry = true;
            this.deviceTokenRetryBudgetUsed = true;
          }

          // Store error for onclose handler to pass to onClose callback
          this.pendingConnectError = {
            code: err.code,
            message: err.message,
            details: err.details,
          };

          // Clear stale device token on mismatch
          if (
            identity &&
            storedToken &&
            explicitToken &&
            errDetailCode === 'AUTH_DEVICE_TOKEN_MISMATCH'
          ) {
            clearDeviceAuthToken({ deviceId: identity.deviceId, role });
          }

          this.opts.onConnectError?.(err.code, err.message);

          if (isNonRecoverableError(err) && !shouldRetry) {
            this.reconnector.cancel();
            this.intentionalClose = true;
          }
        } else {
          // Non-GatewayRequestError: clear pendingConnectError so onclose
          // doesn't carry stale error info (aligned with OC gateway.ts:372-374).
          this.pendingConnectError = undefined;
        }

        // Always close the socket on connect failure, regardless of error type.
        // OC does this unconditionally (gateway.ts:382).
        this.ws?.close(CONNECT_FAILED_CLOSE_CODE, 'connect failed');
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
        // Object form aligned with OC GatewayBrowserClientOptions.onGap
        this.opts.onGap?.({ expected: this.lastSeq + 1, received: frame.seq });
      }
      this.lastSeq = frame.seq;
    }
    // Update tick liveness timestamp (aligned with OC client.ts:578-580)
    if (frame.event === 'tick') {
      this.lastTick = Date.now();
    }

    const handlers = this.eventHandlers.get(frame.event);
    if (handlers) {
      for (const h of handlers) {
        h(frame.payload);
      }
    }
    this.opts.onEvent?.(frame);
  }

  // ---- Tick watchdog (aligned with OC client.ts:659-681) ----
  // Gateway broadcasts 'tick' events every tickIntervalMs (default 30s).
  // If no tick arrives within 2x the interval, the connection is presumed
  // dead (zombie) and closed with code 4000 to trigger automatic reconnect.

  private startTickWatch(): void {
    this.stopTickWatch();
    const interval = Math.max(this.tickIntervalMs, 1000);
    this.tickTimer = setInterval(() => {
      if (!this.lastTick) return;
      const gap = Date.now() - this.lastTick;
      if (gap > this.tickIntervalMs * 2) {
        console.warn(
          `[GatewayClient] Tick timeout: ${gap}ms since last tick (threshold: ${this.tickIntervalMs * 2}ms)`,
        );
        this.ws?.close(4000, 'tick timeout');
      }
    }, interval);
  }

  private stopTickWatch(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    console.log(`[GatewayClient] ${this.state} → ${state}`);
    this.state = state;
    this.opts.onStateChange?.(state);
  }
}
