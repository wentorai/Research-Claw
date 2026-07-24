/**
 * Peripherals Store — data layer for rc.periph.* RPC methods (9 total).
 *
 * Communicates with the Research-Claw Core plugin gateway via:
 *   rc.periph.devices.list / .create / .update / .delete
 *   rc.periph.observations.list
 *   rc.periph.captureResult
 *   rc.periph.bridge.announce
 *   rc.periph.plaud.status / .login
 *
 * Pattern: mirrors stores/monitor.ts (zustand + useGatewayStore.getState().client.request)
 *
 * Type declarations are intentionally inline (not imported from the plugin) because
 * dashboard and plugin are separate packages — shape parity is maintained via
 * fixture annotations in __fixtures__/gateway-payloads/periph.ts.
 */

import { create } from 'zustand';
import { useGatewayStore } from './gateway';

// ── Type declarations (same shape as plugin types.ts — no import) ─────────

export type PeriphKind = 'camera' | 'audio-recorder' | 'lab-instrument' | 'embodied';
export type PeriphDriver = 'browser-camera' | 'mcp-plaud' | 'rtsp' | 'oc-node';
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

// ── Store interface ───────────────────────────────────────────────────────

interface PeripheralsState {
  devices: PeriphDeviceRow[];
  /** Observations keyed by deviceId; rows are ordered newest-first (gateway order). */
  observations: Record<string, PeriphObservationRow[]>;
  loading: boolean;
  error: string | null;
  /** true when any rc.periph.* call returns METHOD_NOT_FOUND (plugin too old). */
  unavailable: boolean;

  loadDevices(): Promise<void>;
  createDevice(input: CreateDeviceInput): Promise<PeriphDeviceRow | null>;
  updateDevice(id: string, patch: UpdateDevicePatch): Promise<void>;
  deleteDevice(id: string): Promise<void>;
  loadObservations(deviceId: string, opts?: { before?: string }): Promise<void>;
  plaudStatus(): Promise<{ tokenPresent: boolean; account?: string; toolsReady?: boolean; lastError?: string } | null>;
  plaudLogin(): Promise<{ ok: boolean; error?: string }>;
  announceBridge(devices: Array<{ deviceId: string; label: string }>, secureContext: boolean): Promise<void>;
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

    try {
      await client.request('rc.periph.devices.delete', { id });
      set((s) => ({
        devices: s.devices.filter((d) => d.id !== id),
        // Also clear any observations for this device
        observations: Object.fromEntries(
          Object.entries(s.observations).filter(([k]) => k !== id),
        ),
      }));
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      } else {
        set({ error: errorMessage(err) });
      }
    }
  },

  loadObservations: async (deviceId: string, opts?: { before?: string }) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    const params: Record<string, unknown> = { device_id: deviceId };
    if (opts?.before) params.before = opts.before;

    try {
      const result = await client.request<{ observations: PeriphObservationRow[] }>(
        'rc.periph.observations.list',
        params,
      );

      set((s) => {
        const existing = s.observations[deviceId] ?? [];
        const next = opts?.before
          ? [...existing, ...result.observations]   // append for pagination
          : result.observations;                     // replace for fresh load
        return { observations: { ...s.observations, [deviceId]: next } };
      });
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      } else {
        set({ error: errorMessage(err) });
      }
    }
  },

  plaudStatus: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    try {
      return await client.request<{
        tokenPresent: boolean;
        account?: string;
        toolsReady?: boolean;
        lastError?: string;
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
      // Plaud login opens a browser OAuth flow — the gateway blocks until the
      // user completes it. Bump the request timeout well past the default so a
      // slow human sign-in isn't reported as a transport failure.
      return await client.request<{ ok: boolean; error?: string }>(
        'rc.periph.plaud.login',
        {},
        { timeoutMs: 190_000 },
      );
    } catch (err) {
      if (isMethodNotFound(err)) {
        set({ unavailable: true });
      }
      return { ok: false, error: errorMessage(err) };
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
}));
