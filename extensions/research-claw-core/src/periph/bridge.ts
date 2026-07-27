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
   *
   * `registeredDeviceId` (audit#8 / P2-F1) is the rc_periph_devices UUID of the
   * device being captured — distinct from `deviceId`, which is the *browser*
   * MediaDevices id used to pick the webcam. The dashboard's PeriphCaptureListener
   * keys the upload target directory on `registeredDeviceId` (fixed cross-agent
   * contract field name), so when provided it rides in the broadcast payload.
   * The caller (periph_camera_snap in tools.ts) has already resolved the
   * registered device and passes its id in.
   *
   * It is the LAST parameter (optional, after timeoutMs) so pre-existing
   * two/three-arg callers keep working while callers opt in by passing it —
   * inserting it earlier would have collided with the positional timeoutMs arg.
   */
  requestCapture(
    deviceId: string,
    purposeHint: string,
    timeoutMs: number = CAPTURE_TIMEOUT_MS,
    registeredDeviceId?: string,
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

      // Payload only carries registeredDeviceId when the caller supplied it, so
      // the dashboard can distinguish "not provided" from an empty string.
      const payload: {
        requestId: string;
        deviceId: string;
        purposeHint: string;
        registeredDeviceId?: string;
      } = { requestId, deviceId, purposeHint };
      if (registeredDeviceId !== undefined) payload.registeredDeviceId = registeredDeviceId;

      // audit#9: a synchronous throw from broadcast() would otherwise leave the
      // pending entry armed for the full timeout (~45s) with no listener ever
      // delivering a result. Reject + clean up immediately instead of dangling.
      try {
        broadcast('plugin.rc.periph.captureRequest', payload);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        resolve({
          ok: false,
          error: `bridge-broadcast-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
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
// P2-A fix: anchor the singleton on globalThis. OC loads plugin modules through
// jiti and may materialize the module graph more than once (tool-discovery pass
// vs gateway pass). A plain module-level singleton then splits into per-graph
// instances: RPC handlers adopt the broadcast fn on one instance while tools
// read another that stays empty → spurious 'bridge-offline'. globalThis is
// process-wide and immune to module-graph duplication.
const BRIDGE_GLOBAL_KEY = '__rcPeriphBridge__';
const globalSlot = globalThis as Record<string, unknown>;
export const periphBridge: PeriphBridge = (globalSlot[BRIDGE_GLOBAL_KEY] as PeriphBridge | undefined) ??
  ((globalSlot[BRIDGE_GLOBAL_KEY] = new PeriphBridge()) as PeriphBridge);
