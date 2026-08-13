/**
 * PeriphCaptureListener — dashboard-side execution end for "agent requests a camera frame".
 *
 * App-level, side-effect-only component (renders null). Mirrors the CronEventListener
 * pattern: subscribe to a gateway broadcast via useGatewayStore().client.subscribe.
 *
 * ─── Link ──────────────────────────────────────────────────────────────────
 * gateway agent tool `periph_camera_snap`
 *   → periphBridge.requestCapture() broadcasts
 *      `plugin.rc.periph.captureRequest` { requestId, deviceId, registeredDeviceId?, purposeHint }
 *      Source (broadcast line): extensions/research-claw-core/src/periph/bridge.ts:147
 *        broadcast('plugin.rc.periph.captureRequest', { requestId, deviceId, purposeHint })
 *      (45s timeout — bridge.ts:35 CAPTURE_TIMEOUT_MS)
 *      P2-F1: `deviceId` is the BROWSER mediaDevice id (config.deviceId ?? device.id,
 *      tools.ts:318-319) — it changes across machines/replug and is NOT the stable
 *      registered identity. The plugin bridge additionally carries `registeredDeviceId`
 *      (the rc_periph_devices row uuid = device.id, tools.ts:295) so the upload
 *      destination keys on the STABLE registered uuid, matching the frame_path the
 *      agent-side `periph_camera_snap` / observation timeline expects.
 *   → THIS component captures a frame from the browser camera
 *   → POST /rc/upload  (destination `periph/<registeredDeviceId ?? deviceId>`)  via uploadFileToWorkspace
 *   → replies `rc.periph.captureResult`
 *        { requestId, ok, path?, width?, height?, error? }
 *        (CaptureResult shape: bridge.ts:38-44)
 *
 * ─── Bridge announce ───────────────────────────────────────────────────────
 * On connect it enumerates videoinput devices and calls announceBridge(devices, secure);
 * re-announces every 60s (heartbeat) so the gateway's 90s TTL announce stays fresh
 * (ANNOUNCE_TTL_MS: bridge.ts:36). In an insecure context it announces { [], false }
 * and does not enumerate.
 */

import { useEffect } from 'react';
import { useGatewayStore } from '../stores/gateway';
import { usePeripheralsStore } from '../stores/peripherals';
import { uploadFileToWorkspace } from '../gateway/upload';
import { captureFrameFromCamera } from '../gateway/camera';
import { useProductPolicyStore } from '../stores/product-policy';
import { shouldMountPeripheralsListener } from '../utils/profile-policy';

// Re-export so T14's "take photo" button can import it from either module.
export { captureFrameFromCamera } from '../gateway/camera';

/** Payload of `plugin.rc.periph.captureRequest` (bridge.ts:147). */
interface CaptureRequestPayload {
  requestId: string;
  /** Browser mediaDevice id — used as the getUserMedia capture target. */
  deviceId: string;
  /**
   * P2-F1: stable registered device uuid (rc_periph_devices.id). When present it
   * keys the upload destination directory so frames land under the same
   * `periph/<uuid>/` path the agent tool + observation timeline reference. Absent
   * on older gateways → fall back to `deviceId` (prior behavior).
   */
  registeredDeviceId?: string;
  purposeHint?: string;
}

/** Announce heartbeat interval (< gateway ANNOUNCE_TTL_MS = 90s). */
const ANNOUNCE_HEARTBEAT_MS = 60_000;

/** True when the browser can grant camera access (HTTPS or localhost). */
function isCameraSecureContext(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** Classify a capture/upload failure into a stable `error` string for captureResult. */
function classifyError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'device-not-found';
  // Audit #9: captureFrameFromCamera now bounds the loadedmetadata wait and
  // rejects with a CameraTimeoutError instead of hanging forever.
  if (name === 'CameraTimeoutError') return 'capture-timeout';
  return String(err);
}

/**
 * Enumerate videoinput devices as { deviceId, label } for the bridge announce.
 * Returns [] on any failure (announce is best-effort).
 */
async function enumerateVideoInputs(): Promise<Array<{ deviceId: string; label: string }>> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera' }));
  } catch {
    return [];
  }
}

export default function PeriphCaptureListener() {
  const client = useGatewayStore((s) => s.client);
  const state = useGatewayStore((s) => s.state);
  const peripheralsRuntimeEnabled = useProductPolicyStore((s) => (
    s.status === 'ready' && s.policy
      ? shouldMountPeripheralsListener(s.policy)
      : false
  ));

  // ── (a) subscribe to capture requests ────────────────────────────────────
  useEffect(() => {
    if (!client || !peripheralsRuntimeEnabled) return;

    // Dedup guard: gateway may redeliver the same event; process a requestId once.
    const seen = new Set<string>();

    const unsub = client.subscribe('plugin.rc.periph.captureRequest', (payload) => {
      const evt = payload as CaptureRequestPayload;
      if (!evt || typeof evt.requestId !== 'string' || typeof evt.deviceId !== 'string') return;
      if (seen.has(evt.requestId)) return;
      seen.add(evt.requestId);

      void handleCaptureRequest(client, evt);
    });

    return unsub;
  }, [client, peripheralsRuntimeEnabled]);

  // ── (c) announce bridge on connect + 60s heartbeat ───────────────────────
  useEffect(() => {
    if (!client || state !== 'connected' || !peripheralsRuntimeEnabled) return;

    let cancelled = false;

    // Hydrate both registered devices and their latest verdicts on (re)connect.
    // The latter is required even before the panel is opened so P2-S1 can lift
    // an alert dot onto the global peripherals navigation tab.
    const hydrateDevices = async () => {
      await usePeripheralsStore.getState().loadDevices();
      if (cancelled) return;
      const { devices, loadObservations } = usePeripheralsStore.getState();
      await Promise.all(devices.map((device) => loadObservations(device.id)));
    };
    void hydrateDevices();

    const announce = async () => {
      const secure = isCameraSecureContext();
      const devices = secure ? await enumerateVideoInputs() : [];
      if (cancelled) return;
      await usePeripheralsStore.getState().announceBridge(devices, secure);
      if (cancelled) return;
      // Refresh verdicts with the existing 60-second bridge heartbeat so alerts
      // raised by unattended monitor runs reach the left navigation promptly.
      const store = usePeripheralsStore.getState();
      await Promise.all(store.devices.map((device) => store.loadObservations(device.id)));
    };

    void announce();
    const timer = setInterval(() => void announce(), ANNOUNCE_HEARTBEAT_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, peripheralsRuntimeEnabled, state]);

  return null;
}

/**
 * Run the full capture → upload → reply pipeline for one request.
 * Every terminal path replies with a captureResult (ok:true or ok:false + error);
 * failures are never silently swallowed.
 */
async function handleCaptureRequest(
  client: NonNullable<ReturnType<typeof useGatewayStore.getState>['client']>,
  evt: CaptureRequestPayload,
): Promise<void> {
  const { requestId, deviceId } = evt;
  // P2-F1: capture from the browser device, but key the upload directory on the
  // STABLE registered uuid when the gateway supplies it. Falls back to the
  // browser deviceId for older bridges that omit registeredDeviceId.
  const destinationKey = evt.registeredDeviceId || deviceId;

  // Guard: no camera access at all → classify before touching getUserMedia.
  if (!isCameraSecureContext()) {
    await reply(client, { requestId, ok: false, error: 'insecure-context' });
    return;
  }

  let frame: { blob: Blob; width: number; height: number };
  try {
    frame = await captureFrameFromCamera(deviceId);
  } catch (err) {
    await reply(client, { requestId, ok: false, error: classifyError(err) });
    return;
  }

  let path: string;
  try {
    const file = new File([frame.blob], `${Date.now()}.jpg`, { type: 'image/jpeg' });
    const uploaded = await uploadFileToWorkspace(file, `periph/${destinationKey}`);
    path = uploaded.path;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(client, { requestId, ok: false, error: `upload-failed: ${msg}` });
    return;
  }

  await reply(client, {
    requestId,
    ok: true,
    path,
    width: frame.width,
    height: frame.height,
  });
}

/** Send rc.periph.captureResult; swallow transport errors (nothing left to report). */
async function reply(
  client: NonNullable<ReturnType<typeof useGatewayStore.getState>['client']>,
  result:
    | { requestId: string; ok: true; path: string; width: number; height: number }
    | { requestId: string; ok: false; error: string },
): Promise<void> {
  try {
    await client.request('rc.periph.captureResult', result);
  } catch {
    // The gateway request itself failed (e.g. late/disconnected) — nothing more to do.
  }
}
