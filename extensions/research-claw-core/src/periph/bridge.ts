/**
 * PeriphBridge — gateway-side reverse bridge for "agent requests a camera frame".
 *
 * ─── Broadcast signature (source) ─────────────────────────────────────────
 * File: openclaw/src/gateway/server-broadcast-types.ts:11-15
 *
 *   export type GatewayBroadcastFn = (
 *     event: string,
 *     payload: unknown,
 *     opts?: GatewayBroadcastOpts,
 *   ) => void;
 *
 * The `broadcast` field on GatewayRequestContext is typed as GatewayBroadcastFn:
 *   openclaw/src/gateway/server-methods/shared-types.ts:67
 *
 *   broadcast: GatewayBroadcastFn;
 *
 * ─── plugin.* scope guard (source) ────────────────────────────────────────
 * File: openclaw/src/gateway/server-broadcast.ts:62-73
 *
 *   if (!required && event.startsWith("plugin.")) {
 *     const role = client.connect.role ?? "operator";
 *     if (role !== "operator") { return false; }
 *     const scopes = ...; // from client.connect.scopes
 *     return scopes.includes(WRITE_SCOPE) || scopes.includes(ADMIN_SCOPE);
 *   }
 *
 * → Events under "plugin.*" not explicitly listed in EVENT_SCOPE_GUARDS are
 *   forwarded to operator clients with write or admin scope. Our event name
 *   "plugin.rc.periph.captureRequest" passes this guard.
 */

import { randomUUID } from 'node:crypto';

export const CAPTURE_TIMEOUT_MS = 45_000;
export const ANNOUNCE_TTL_MS = 90_000;

export interface CaptureResult {
  ok: boolean;
  path?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface BridgeAnnounce {
  devices: Array<{ deviceId: string; label: string }>;
  secureContext: boolean;
  at: string;
}

type BroadcastFn = (event: string, payload: unknown, opts?: unknown) => void;

interface PendingCapture {
  resolve: (result: CaptureResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PeriphBridge {
  private _broadcast: BroadcastFn | null = null;
  private _announce: BridgeAnnounce | null = null;
  private _pending = new Map<string, PendingCapture>();

  /**
   * Capture the gateway context from any RPC call.
   * Idempotent: the first valid context wins; subsequent calls are no-ops.
   * Defensive: only adopts if the object has a `broadcast` function.
   */
  adoptContext(ctx: unknown): void {
    if (this._broadcast !== null) return;
    if (
      ctx !== null &&
      typeof ctx === 'object' &&
      'broadcast' in ctx &&
      typeof (ctx as Record<string, unknown>)['broadcast'] === 'function'
    ) {
      this._broadcast = (ctx as { broadcast: BroadcastFn }).broadcast;
    }
  }

  hasBroadcast(): boolean {
    return this._broadcast !== null;
  }

  /**
   * Record a dashboard camera-bridge announcement (in-memory only).
   * `at` is set to the current ISO timestamp.
   */
  announce(a: Omit<BridgeAnnounce, 'at'>): void {
    this._announce = { ...a, at: new Date().toISOString() };
  }

  /**
   * Return the most recent announce, or null if it is older than ANNOUNCE_TTL_MS.
   */
  getAnnounce(): BridgeAnnounce | null {
    if (this._announce === null) return null;
    const age = Date.now() - new Date(this._announce.at).getTime();
    if (age > ANNOUNCE_TTL_MS) return null;
    return this._announce;
  }

  /**
   * Ask the dashboard to capture a frame from `deviceId`.
   * - If no broadcast handle: immediately resolves {ok:false, error:'bridge-offline'}.
   * - Otherwise: broadcasts `plugin.rc.periph.captureRequest` and waits for
   *   resolveCapture() to be called, or times out after `timeoutMs` ms.
   */
  requestCapture(
    deviceId: string,
    purposeHint: string,
    timeoutMs: number = CAPTURE_TIMEOUT_MS,
  ): Promise<CaptureResult> {
    if (this._broadcast === null) {
      return Promise.resolve({ ok: false, error: 'bridge-offline' });
    }

    const requestId = randomUUID();
    const broadcast = this._broadcast;

    return new Promise<CaptureResult>((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        resolve({ ok: false, error: 'bridge-timeout' });
      }, timeoutMs);

      this._pending.set(requestId, { resolve, timer });

      broadcast('plugin.rc.periph.captureRequest', { requestId, deviceId, purposeHint });
    });
  }

  /**
   * Called by the RPC handler (T5) when the dashboard delivers a capture result.
   * Returns true if the requestId was pending (first delivery wins).
   * Returns false if the request already timed out or was already resolved.
   */
  resolveCapture(requestId: string, result: CaptureResult): boolean {
    const pending = this._pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pending.delete(requestId);
    pending.resolve(result);
    return true;
  }
}

/** Module-level singleton — shared across all RPC calls in the same process. */
export const periphBridge = new PeriphBridge();
