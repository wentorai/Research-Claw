/**
 * Peripherals Store — data layer for rc.periph.* RPC methods (14 total).
 *
 * Communicates with the Research-Claw Core plugin gateway via:
 *   rc.periph.devices.list / .create / .update / .delete
 *   rc.periph.observations.list / .create
 *   rc.periph.captureResult
 *   rc.periph.bridge.announce
 *   rc.periph.localCameras.list
 *   rc.periph.rtspPreview.start / .stop   (§15 v1.3 场景③ RTSP→HLS live preview)
 *   rc.periph.plaud.status / .login / .cancelLogin
 *
 * Pattern: mirrors stores/monitor.ts (zustand + useGatewayStore.getState().client.request)
 *
 * Type declarations are intentionally inline (not imported from the plugin) because
 * dashboard and plugin are separate packages — shape parity is maintained via
 * fixture annotations in __fixtures__/gateway-payloads/periph.ts.
 */

import { create } from 'zustand';
import { useGatewayStore } from './gateway';
import { useMonitorStore } from './monitor';

/**
 * Observation page size for the timeline "load earlier" pager. Must match the
 * `limit` sent to rc.periph.observations.list. A page that comes back FULL
 * (=== this size) means there may be older rows → keep the pager; a short/empty
 * page means we've reached the oldest observation → hide the pager. Without this
 * signal the pager rendered unconditionally and clicking it at the end fetched
 * nothing (the "load earlier does nothing / never disappears" bug).
 */
export const PERIPH_OBS_PAGE_SIZE = 50;

// ── Type declarations (same shape as plugin types.ts — no import) ─────────

export type PeriphKind = 'camera' | 'audio-recorder' | 'lab-instrument' | 'embodied';
export type PeriphDriver = 'browser-camera' | 'mcp-plaud' | 'rtsp' | 'local-camera' | 'oc-node';
export type PeriphVerdict = 'ok' | 'alert' | 'info' | 'unverified' | 'missed' | 'error';

/** Mirror of PeriphDevice (types.ts:12-24) */
export interface PeriphDeviceRow {
  id: string;
  name: string;
  kind: PeriphKind;
  driver: PeriphDriver;
  enabled: boolean;
  config: Record<string, unknown>;
  check_prompt: string;
  last_seen_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Mirror of PeriphObservation (types.ts:26-36) */
export interface PeriphObservationRow {
  id: string;
  device_id: string;
  monitor_id: string | null;
  kind: 'snapshot' | 'check' | 'note';
  verdict: PeriphVerdict;
  summary: string;
  frame_path: string | null;
  result_json: Record<string, unknown>;
  captured_at: string;
  /** Opaque keyset pagination cursor (SQLite rowid). Tiebreaks same-second rows. */
  cursor: number;
}

// ── Input types for createDevice ──────────────────────────────────────────

export interface CreateDeviceInput {
  id?: string;
  name: string;
  kind: PeriphKind;
  driver: PeriphDriver;
  config?: Record<string, unknown>;
  check_prompt?: string;
}

export interface UpdateDevicePatch {
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  check_prompt?: string;
}

/**
 * Mirror of the rc.periph.devices.delete response (periph/rpc.ts).
 *
 * `deleted_monitors` lists the `source_type='device'` monitors the plugin
 * cascaded away with the device. Each still names the OpenClaw cron job it had
 * registered — that job lives outside the plugin DB and only the client can
 * remove it (R2-I3). `deleted_monitors` is optional so a dashboard talking to a
 * plugin from before the cascade landed still deletes the device cleanly.
 */
export interface PeriphDeviceDeleteResult {
  ok: boolean;
  deleted_monitors?: Array<{ id: string; gateway_job_id: string | null }>;
}

/**
 * A locally-attached OS camera enumerated by the gateway (rc.periph.localCameras.list).
 * `device` is the platform address stored in device.config.device: an avfoundation
 * INDEX ('0') on macOS, a DirectShow device NAME on Windows. `label` is human-readable.
 */
export interface LocalCameraOption {
  device: string;
  label: string;
}

// ── Store interface ───────────────────────────────────────────────────────

interface PeripheralsState {
  devices: PeriphDeviceRow[];
  /** Observations keyed by deviceId; rows are ordered newest-first (gateway order). */
  observations: Record<string, PeriphObservationRow[]>;
  /**
   * Per-device flag: does the last page suggest there are older observations to
   * load? True only when the most recent load returned a FULL page. The timeline
   * pager renders iff this is true. Absent key (never loaded) is treated as false.
   */
  observationsHasMore: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  /** true when any rc.periph.* call returns METHOD_NOT_FOUND (plugin too old). */
  unavailable: boolean;

  loadDevices(): Promise<void>;
  createDevice(input: CreateDeviceInput): Promise<PeriphDeviceRow | null>;
  updateDevice(id: string, patch: UpdateDevicePatch): Promise<void>;
  deleteDevice(id: string): Promise<void>;
  loadObservations(deviceId: string, opts?: { before?: string; before_cursor?: number }): Promise<void>;
  /** True when the last observations page for this device came back full (maybe more). */
  hasMoreObservations(deviceId: string): boolean;
  plaudStatus(): Promise<{ tokenPresent: boolean; account?: string; toolsReady?: boolean; lastError?: string; docker?: boolean } | null>;
  plaudLogin(): Promise<{ ok: boolean; error?: string }>;
  plaudCancelLogin(): Promise<{ ok: boolean }>;
  announceBridge(devices: Array<{ deviceId: string; label: string }>, secureContext: boolean): Promise<void>;
  /**
   * Enumerate OS-attached cameras via the gateway (rc.periph.localCameras.list).
   * Returns [] on any failure / unavailable plugin — the caller then degrades to a
   * manual device-index input. Never throws.
   */
  loadLocalCameras(): Promise<LocalCameraOption[]>;
  /**
   * Start (or idempotently reuse) an RTSP→HLS live-preview session for an rtsp
   * device (§15 v1.3 场景③ H1-H6). Returns { sessionToken, playlistUrl } on
   * success — playlistUrl is a credential-free gateway-relative path
   * (/rc/rtsp-preview/<token>/index.m3u8). Returns null on any failure /
   * unavailable plugin; the caller then degrades to a snapshot / error message.
   */
  rtspPreviewStart(deviceId: string): Promise<{ sessionToken: string; playlistUrl: string } | null>;
  /** Stop a device's live-preview session (component unmount / stop button). Best-effort. */
  rtspPreviewStop(deviceId: string): Promise<void>;
}

// ── METHOD_NOT_FOUND detection ────────────────────────────────────────────

function isMethodNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  // Gateway sends code as string 'METHOD_NOT_FOUND' (GatewayErrorInfo.code: string)
  return code === 'METHOD_NOT_FOUND';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Store implementation ──────────────────────────────────────────────────

export const usePeripheralsStore = create<PeripheralsState>()((set, get) => ({
  devices: [],
  observations: {},
  observationsHasMore: {},
  loading: false,
  error: null,
  unavailable: false,

  loadDevices: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    set({ loading: true, error: null });
    try {
      const result = await client.request<{ devices: PeriphDeviceRow[] }>('rc.periph.devices.list', {});
      set({ devices: result.devices, loading: false });
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ loading: false, unavailable: true });
      } else {
        set({ loading: false, error: errorMessage(err) });
      }
    }
  },

  createDevice: async (input: CreateDeviceInput) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    try {
      const result = await client.request<{ device: PeriphDeviceRow }>('rc.periph.devices.create', input);
      set((s) => ({ devices: [...s.devices, result.device] }));
      return result.device;
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      } else {
        set({ error: errorMessage(err) });
      }
      return null;
    }
  },

  updateDevice: async (id: string, patch: UpdateDevicePatch) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      const result = await client.request<{ device: PeriphDeviceRow }>(
        'rc.periph.devices.update',
        { id, ...patch },
      );
      set((s) => ({
        devices: s.devices.map((d) => (d.id === id ? result.device : d)),
      }));
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      } else {
        set({ error: errorMessage(err) });
      }
    }
  },

  deleteDevice: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    // Clear first: callers read `error` back to decide what to report, so a
    // stale message from an earlier operation must not be attributed to this one.
    set({ error: null });
    try {
      const result = await client.request<PeriphDeviceDeleteResult>(
        'rc.periph.devices.delete',
        { id },
      );
      set((s) => ({
        devices: s.devices.filter((d) => d.id !== id),
        // Also clear any observations (and their pager flag) for this device
        observations: Object.fromEntries(
          Object.entries(s.observations).filter(([k]) => k !== id),
        ),
        observationsHasMore: Object.fromEntries(
          Object.entries(s.observationsHasMore).filter(([k]) => k !== id),
        ),
      }));

      // R2-I3: the plugin cascaded the device's monitors out of its own DB, but
      // their gateway cron jobs live in OpenClaw and would keep firing against
      // a device that no longer exists. Remove them here — the same client-side
      // division of labour as deleteMonitor (stores/monitor.ts).
      const cascaded = result?.deleted_monitors ?? [];
      const stranded: string[] = [];
      for (const m of cascaded) {
        if (!m.gateway_job_id) continue;
        try {
          await client.request('cron.remove', { id: m.gateway_job_id });
        } catch {
          // A job that is already gone is fine; anything else leaves a cron job
          // firing for a deleted device, which the user must be told about
          // rather than have it swallowed as success.
          stranded.push(m.gateway_job_id);
        }
      }
      if (cascaded.length > 0) {
        // The monitor list still shows the cascaded rows until it reloads.
        await useMonitorStore.getState().loadMonitors();
      }
      if (stranded.length > 0) {
        set({
          error: `Device deleted, but these gateway cron jobs could not be removed: ${stranded.join(', ')}`,
        });
      }
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      } else {
        set({ error: errorMessage(err) });
      }
    }
  },

  loadObservations: async (deviceId: string, opts?: { before?: string; before_cursor?: number }) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    const params: Record<string, unknown> = { device_id: deviceId, limit: PERIPH_OBS_PAGE_SIZE };
    if (opts?.before) params.before = opts.before;
    if (typeof opts?.before_cursor === 'number') params.before_cursor = opts.before_cursor;

    try {
      const result = await client.request<{ observations: PeriphObservationRow[] }>(
        'rc.periph.observations.list',
        params,
      );

      // A full page means older rows may remain; a short/empty page is the end.
      const hasMore = result.observations.length === PERIPH_OBS_PAGE_SIZE;
      set((s) => {
        const existing = s.observations[deviceId] ?? [];
        const next = opts?.before
          ? [...existing, ...result.observations]   // append for pagination
          : result.observations;                     // replace for fresh load
        return {
          observations: { ...s.observations, [deviceId]: next },
          observationsHasMore: { ...s.observationsHasMore, [deviceId]: hasMore },
        };
      });
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      } else {
        set({ error: errorMessage(err) });
      }
    }
  },

  hasMoreObservations: (deviceId: string) => get().observationsHasMore[deviceId] === true,

  plaudStatus: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    try {
      return await client.request<{
        tokenPresent: boolean;
        account?: string;
        toolsReady?: boolean;
        lastError?: string;
        // P1-U4: gateway-side Docker detection (mirrors workspace/rpc.ts:24
        // fs.existsSync('/.dockerenv') || process.env.DOCKER==='1'), surfaced on
        // the status response the same way rc.ws.openExternal returns
        // {fallback:'docker'}. Absent → non-Docker (browser/Electron), the
        // dominant path; the card only degrades when the gateway reports true.
        docker?: boolean;
      }>('rc.periph.plaud.status', {});
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      }
      return null;
    }
  },

  plaudLogin: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return { ok: false, error: 'Not connected' };

    try {
      // Plaud login opens a browser OAuth flow — the gateway blocks while it
      // polls for the token file (up to 150s). Bump the request timeout past
      // that poll window so a slow human sign-in isn't reported as a transport
      // failure before the gateway's own auth-timeout fires.
      return await client.request<{ ok: boolean; error?: string }>(
        'rc.periph.plaud.login',
        {},
        { timeoutMs: 200_000 },
      );
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      }
      return { ok: false, error: errorMessage(err) };
    }
  },

  plaudCancelLogin: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return { ok: false };

    try {
      return await client.request<{ ok: boolean }>('rc.periph.plaud.cancelLogin', {});
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      }
      // cancelLogin failures are best-effort — the user can still retry.
      return { ok: false };
    }
  },

  announceBridge: async (
    devices: Array<{ deviceId: string; label: string }>,
    secureContext: boolean,
  ) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      await client.request('rc.periph.bridge.announce', { devices, secureContext });
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      }
      // bridge announce failures are non-critical — do not set error
    }
  },

  loadLocalCameras: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return [];

    try {
      const result = await client.request<{ cameras: LocalCameraOption[] }>(
        'rc.periph.localCameras.list',
        {},
      );
      return Array.isArray(result?.cameras) ? result.cameras : [];
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      }
      // Enumeration failures are non-critical — the AddDeviceFlow degrades to a
      // manual device-index input. Do not set a global error.
      return [];
    }
  },

  rtspPreviewStart: async (deviceId: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    try {
      const result = await client.request<{ sessionToken: string; playlistUrl: string }>(
        'rc.periph.rtspPreview.start',
        { device_id: deviceId },
      );
      if (result && typeof result.playlistUrl === 'string' && typeof result.sessionToken === 'string') {
        return result;
      }
      return null;
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      }
      // Preview-start failures (ffmpeg/RTSP unreachable) degrade to a snapshot /
      // error message in the player — do not set a global error.
      return null;
    }
  },

  rtspPreviewStop: async (deviceId: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      await client.request('rc.periph.rtspPreview.stop', { device_id: deviceId });
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      }
      // Stop failures are best-effort — the gateway idle-sweep reclaims the
      // session anyway. Do not surface an error.
    }
  },
}));
