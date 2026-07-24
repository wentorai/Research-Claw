/**
 * Behavioral Parity Tests: Peripherals Store RPC Handling
 *
 * Verifies that usePeripheralsStore correctly consumes rc.periph.* RPC responses
 * from the Research-Claw Core plugin gateway.
 *
 * Source references:
 *   - Periph RPC:   extensions/research-claw-core/src/periph/rpc.ts
 *   - Periph types: extensions/research-claw-core/src/periph/types.ts
 *
 * Each test cites the rpc.ts handler line and verifies field-by-field parity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePeripheralsStore } from '../../stores/peripherals';

import {
  RC_PERIPH_DEVICES_LIST_RESPONSE,
  RC_PERIPH_DEVICES_CREATE_RESPONSE,
  RC_PERIPH_DEVICES_UPDATE_RESPONSE,
  RC_PERIPH_DEVICES_DELETE_RESPONSE,
  RC_PERIPH_OBSERVATIONS_LIST_RESPONSE,
  RC_PERIPH_OBSERVATIONS_LIST_EMPTY_RESPONSE,
  RC_PERIPH_BRIDGE_ANNOUNCE_RESPONSE,
  RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE,
  RC_PERIPH_PLAUD_STATUS_LOGGED_OUT_RESPONSE,
  RC_PERIPH_PLAUD_STATUS_ERROR_RESPONSE,
  RC_PERIPH_PLAUD_LOGIN_OK_RESPONSE,
  RC_PERIPH_PLAUD_LOGIN_FAIL_RESPONSE,
} from '../../__fixtures__/gateway-payloads/periph';

// ── Mock gateway store ──────────────────────────────────────────────────
const mockGatewayClient = {
  isConnected: true,
  request: vi.fn(),
};

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: mockGatewayClient, state: 'connected' }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// ── Helper: throw a GatewayRequestError-like error with a code property ──
function makeMethodNotFoundError(): Error & { code: string } {
  const err = new Error('Method not found: rc.periph.devices.list') as Error & { code: string };
  err.name = 'GatewayRequestError';
  err.code = 'METHOD_NOT_FOUND';
  return err;
}

// ══════════════════════════════════════════════════════════════════════════
// Peripherals Store — rc.periph.* RPC parity
// ══════════════════════════════════════════════════════════════════════════

describe('Peripherals store RPC parity (rc.periph.*)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    usePeripheralsStore.setState({
      devices: [],
      observations: {},
      loading: false,
      error: null,
      unavailable: false,
    });
  });

  // ── loadDevices → rc.periph.devices.list ────────────────────────────────

  describe('loadDevices → rc.periph.devices.list', () => {
    it('correctly parses rc.periph.devices.list response with all PeriphDevice fields', async () => {
      // Source: rpc.ts:90-92  → { devices: service.listDevices() }
      // PeriphDevice shape: types.ts:12-24
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_DEVICES_LIST_RESPONSE);

      await usePeripheralsStore.getState().loadDevices();

      const state = usePeripheralsStore.getState();
      expect(state.devices).toHaveLength(2);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.unavailable).toBe(false);

      // Field-by-field parity on first device (camera)
      // Ref: types.ts:12-24 (PeriphDevice interface)
      const cam = state.devices[0];
      expect(cam.id).toBe('dev-cam-001');
      expect(cam.name).toBe('Lab Camera Front');
      expect(cam.kind).toBe('camera');
      expect(cam.driver).toBe('browser-camera');
      expect(cam.enabled).toBe(true);
      expect(cam.config).toEqual({ deviceId: 'media-device-abc123', width: 1280, height: 720 });
      expect(cam.check_prompt).toBe('Is the lab bench clear and equipment properly arranged?');
      expect(cam.last_seen_at).toBe('2026-07-20T10:30:00.000Z');
      expect(cam.last_error).toBeNull();
      expect(cam.created_at).toBe('2026-07-01T08:00:00.000Z');
      expect(cam.updated_at).toBe('2026-07-20T10:30:00.000Z');

      // Second device (plaud)
      const plaud = state.devices[1];
      expect(plaud.id).toBe('dev-plaud-001');
      expect(plaud.kind).toBe('audio-recorder');
      expect(plaud.driver).toBe('mcp-plaud');
      expect(plaud.last_seen_at).toBeNull();
    });

    it('sends correct RPC method name', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_DEVICES_LIST_RESPONSE);

      await usePeripheralsStore.getState().loadDevices();

      expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.periph.devices.list', {});
    });

    it('handles empty devices list', async () => {
      mockGatewayClient.request.mockResolvedValueOnce({ devices: [] });

      await usePeripheralsStore.getState().loadDevices();

      expect(usePeripheralsStore.getState().devices).toEqual([]);
      expect(usePeripheralsStore.getState().loading).toBe(false);
    });

    it('sets unavailable=true on METHOD_NOT_FOUND', async () => {
      // Semantics: plugin too old → rc.periph.* not registered → METHOD_NOT_FOUND
      // The store should set unavailable=true so the panel can show a warning.
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      await usePeripheralsStore.getState().loadDevices();

      const state = usePeripheralsStore.getState();
      expect(state.unavailable).toBe(true);
      expect(state.devices).toEqual([]);
      expect(state.loading).toBe(false);
    });

    it('sets error (not unavailable) on non-METHOD_NOT_FOUND failure', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('Internal plugin error'));

      await usePeripheralsStore.getState().loadDevices();

      const state = usePeripheralsStore.getState();
      expect(state.unavailable).toBe(false);
      expect(state.error).toBeTruthy();
      expect(state.loading).toBe(false);
    });

    it('skips when gateway is disconnected', async () => {
      mockGatewayClient.isConnected = false;

      await usePeripheralsStore.getState().loadDevices();

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
      expect(usePeripheralsStore.getState().loading).toBe(false);
    });
  });

  // ── createDevice → rc.periph.devices.create ─────────────────────────────

  describe('createDevice → rc.periph.devices.create', () => {
    it('sends correct RPC method and input params', async () => {
      // Source: rpc.ts:95-117 → { name, kind, driver, config?, check_prompt? }
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_DEVICES_CREATE_RESPONSE);

      const input = {
        name: 'Microscope Camera',
        kind: 'camera' as const,
        driver: 'browser-camera' as const,
        config: { deviceId: 'media-device-xyz789' },
        check_prompt: 'Is the microscope slide properly centered?',
      };

      await usePeripheralsStore.getState().createDevice(input);

      expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.periph.devices.create', input);
    });

    it('returns the created device and appends it to state', async () => {
      // Source: rpc.ts:105-111 → returns { device: PeriphDevice }
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_DEVICES_CREATE_RESPONSE);

      const result = await usePeripheralsStore.getState().createDevice({
        name: 'Microscope Camera',
        kind: 'camera',
        driver: 'browser-camera',
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe('dev-cam-002');
      expect(result!.name).toBe('Microscope Camera');
      expect(result!.kind).toBe('camera');
      expect(result!.driver).toBe('browser-camera');
      expect(result!.enabled).toBe(true);
      expect(result!.last_seen_at).toBeNull();

      // Device should be appended to state
      expect(usePeripheralsStore.getState().devices).toHaveLength(1);
      expect(usePeripheralsStore.getState().devices[0].id).toBe('dev-cam-002');
    });

    it('returns null on failure', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('name is required'));

      const result = await usePeripheralsStore.getState().createDevice({
        name: '',
        kind: 'camera',
        driver: 'browser-camera',
      });

      expect(result).toBeNull();
    });

    it('sets unavailable=true on METHOD_NOT_FOUND', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      await usePeripheralsStore.getState().createDevice({ name: 'X', kind: 'camera', driver: 'browser-camera' });

      expect(usePeripheralsStore.getState().unavailable).toBe(true);
    });
  });

  // ── updateDevice → rc.periph.devices.update ─────────────────────────────

  describe('updateDevice → rc.periph.devices.update', () => {
    it('sends correct RPC params with id and patch fields', async () => {
      // Source: rpc.ts:120-140 → { id, name?, enabled?, config?, check_prompt? }
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_DEVICES_UPDATE_RESPONSE);

      await usePeripheralsStore.getState().updateDevice('dev-cam-001', { name: 'Lab Camera Front (Renamed)', enabled: false });

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.periph.devices.update',
        { id: 'dev-cam-001', name: 'Lab Camera Front (Renamed)', enabled: false },
      );
    });

    it('updates the device in local state after successful RPC', async () => {
      // Source: rpc.ts:135 → returns { device: PeriphDevice }
      usePeripheralsStore.setState({ devices: [RC_PERIPH_DEVICES_LIST_RESPONSE.devices[0]] });
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_DEVICES_UPDATE_RESPONSE);

      await usePeripheralsStore.getState().updateDevice('dev-cam-001', { enabled: false });

      const updated = usePeripheralsStore.getState().devices.find((d) => d.id === 'dev-cam-001');
      expect(updated).toBeDefined();
      expect(updated!.enabled).toBe(false);
      expect(updated!.name).toBe('Lab Camera Front (Renamed)');
    });

    it('sets unavailable=true on METHOD_NOT_FOUND', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      await usePeripheralsStore.getState().updateDevice('dev-cam-001', { enabled: false });

      expect(usePeripheralsStore.getState().unavailable).toBe(true);
    });
  });

  // ── deleteDevice → rc.periph.devices.delete ─────────────────────────────

  describe('deleteDevice → rc.periph.devices.delete', () => {
    it('sends correct RPC method and id param', async () => {
      // Source: rpc.ts:143-151 → { id } → { ok: true }
      usePeripheralsStore.setState({ devices: RC_PERIPH_DEVICES_LIST_RESPONSE.devices });
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_DEVICES_DELETE_RESPONSE);

      await usePeripheralsStore.getState().deleteDevice('dev-cam-001');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.periph.devices.delete',
        { id: 'dev-cam-001' },
      );
    });

    it('removes device from local state after successful RPC', async () => {
      usePeripheralsStore.setState({ devices: RC_PERIPH_DEVICES_LIST_RESPONSE.devices });
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_DEVICES_DELETE_RESPONSE);

      await usePeripheralsStore.getState().deleteDevice('dev-cam-001');

      const state = usePeripheralsStore.getState();
      expect(state.devices).toHaveLength(1);
      expect(state.devices.find((d) => d.id === 'dev-cam-001')).toBeUndefined();
    });

    it('clears device observations when device is deleted', async () => {
      // Verify that deleteDevice cleans up observations for the deleted device
      // while preserving observations for other devices
      usePeripheralsStore.setState({
        devices: RC_PERIPH_DEVICES_LIST_RESPONSE.devices,
        observations: {
          'dev-cam-001': RC_PERIPH_OBSERVATIONS_LIST_RESPONSE.observations,
          'dev-plaud-001': [], // Plaud device exists but has no observations yet
        },
      });
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_DEVICES_DELETE_RESPONSE);

      await usePeripheralsStore.getState().deleteDevice('dev-cam-001');

      const state = usePeripheralsStore.getState();
      // Deleted device observations should be cleared
      expect(state.observations['dev-cam-001']).toBeUndefined();
      // Other device's observations should remain
      expect(state.observations['dev-plaud-001']).toBeDefined();
    });

    it('sets unavailable=true on METHOD_NOT_FOUND', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      await usePeripheralsStore.getState().deleteDevice('dev-cam-001');

      expect(usePeripheralsStore.getState().unavailable).toBe(true);
    });
  });

  // ── loadObservations → rc.periph.observations.list ──────────────────────

  describe('loadObservations → rc.periph.observations.list', () => {
    it('correctly parses rc.periph.observations.list response with all PeriphObservation fields', async () => {
      // Source: rpc.ts:154-165 → { device_id?, limit?, before? } → { observations }
      // PeriphObservation shape: types.ts:26-36
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      await usePeripheralsStore.getState().loadObservations('dev-cam-001');

      const state = usePeripheralsStore.getState();
      expect(state.observations['dev-cam-001']).toHaveLength(3);

      // Field-by-field parity on first observation (ok verdict)
      const obs = state.observations['dev-cam-001'][0];
      expect(obs.id).toBe('obs-001');
      expect(obs.device_id).toBe('dev-cam-001');
      expect(obs.monitor_id).toBe('mon-001');
      expect(obs.kind).toBe('check');
      expect(obs.verdict).toBe('ok');
      expect(obs.summary).toBe('Lab bench is clear. All equipment in proper positions.');
      expect(obs.frame_path).toBe('periph/dev-cam-001/2026-07-20T10-30-00.jpg');
      expect(obs.result_json).toEqual({ confidence: 0.97, items_detected: ['beaker', 'microscope'] });
      expect(obs.captured_at).toBe('2026-07-20 10:30:00');

      // Second observation (alert)
      const obsAlert = state.observations['dev-cam-001'][1];
      expect(obsAlert.verdict).toBe('alert');
      expect(obsAlert.summary).toBe('Chemical spill detected on left bench area.');

      // Third observation (missed — null frame_path)
      const obsMissed = state.observations['dev-cam-001'][2];
      expect(obsMissed.verdict).toBe('missed');
      expect(obsMissed.frame_path).toBeNull();
      expect(obsMissed.monitor_id).toBeNull();
    });

    it('sends correct RPC params without before (fresh load)', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      await usePeripheralsStore.getState().loadObservations('dev-cam-001');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.periph.observations.list',
        { device_id: 'dev-cam-001' },
      );
    });

    it('replaces existing observations on fresh load (no before)', async () => {
      // Without before: replaces, not appends
      usePeripheralsStore.setState({
        observations: { 'dev-cam-001': [RC_PERIPH_OBSERVATIONS_LIST_RESPONSE.observations[0]] },
      });
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      await usePeripheralsStore.getState().loadObservations('dev-cam-001');

      expect(usePeripheralsStore.getState().observations['dev-cam-001']).toHaveLength(3);
    });

    it('sends before param for pagination and appends results', async () => {
      // Source: rpc.ts:157 — before is passed through as cursor
      // Pagination: with before → append to existing array
      usePeripheralsStore.setState({
        observations: { 'dev-cam-001': [RC_PERIPH_OBSERVATIONS_LIST_RESPONSE.observations[0]] },
      });
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_EMPTY_RESPONSE);

      await usePeripheralsStore.getState().loadObservations('dev-cam-001', { before: '2026-07-20T10:00:00.000Z' });

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.periph.observations.list',
        { device_id: 'dev-cam-001', before: '2026-07-20T10:00:00.000Z' },
      );
      // Appended: existing 1 + empty 0 = still 1
      expect(usePeripheralsStore.getState().observations['dev-cam-001']).toHaveLength(1);
    });

    it('appends new observations when before is provided', async () => {
      // With before: older page appended to existing (newer) rows
      usePeripheralsStore.setState({
        observations: {
          'dev-cam-001': [RC_PERIPH_OBSERVATIONS_LIST_RESPONSE.observations[0]],
        },
      });
      mockGatewayClient.request.mockResolvedValueOnce({
        observations: [RC_PERIPH_OBSERVATIONS_LIST_RESPONSE.observations[1]],
      });

      await usePeripheralsStore.getState().loadObservations('dev-cam-001', { before: '2026-07-20T10:00:00.000Z' });

      expect(usePeripheralsStore.getState().observations['dev-cam-001']).toHaveLength(2);
    });

    it('sets unavailable=true on METHOD_NOT_FOUND', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      await usePeripheralsStore.getState().loadObservations('dev-cam-001');

      expect(usePeripheralsStore.getState().unavailable).toBe(true);
    });
  });

  // ── plaudStatus → rc.periph.plaud.status ────────────────────────────────

  describe('plaudStatus → rc.periph.plaud.status', () => {
    it('returns tokenPresent=true, account, toolsReady when logged in', async () => {
      // Source: rpc.ts:237-239 → plaud.status() → PlaudStatus (rpc.ts:22-28)
      // NOTE: no 'configured' field — that is derived from config.get (T15)
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE);

      const result = await usePeripheralsStore.getState().plaudStatus();

      expect(result).not.toBeNull();
      expect(result!.tokenPresent).toBe(true);
      expect(result!.account).toBe('researcher@lab.edu');
      expect(result!.toolsReady).toBe(true);
      expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.periph.plaud.status', {});
    });

    it('returns tokenPresent=false and no lastError when cleanly logged out', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_PLAUD_STATUS_LOGGED_OUT_RESPONSE);

      const result = await usePeripheralsStore.getState().plaudStatus();

      expect(result!.tokenPresent).toBe(false);
      expect(result!.lastError).toBeUndefined();
    });

    it('returns tokenPresent=false and lastError when in error state', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_PLAUD_STATUS_ERROR_RESPONSE);

      const result = await usePeripheralsStore.getState().plaudStatus();

      expect(result!.tokenPresent).toBe(false);
      expect(result!.lastError).toBe('Authentication token expired');
    });

    it('returns null on failure', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('plaud manager not ready'));

      const result = await usePeripheralsStore.getState().plaudStatus();

      expect(result).toBeNull();
    });

    it('sets unavailable=true on METHOD_NOT_FOUND', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      const result = await usePeripheralsStore.getState().plaudStatus();

      expect(result).toBeNull();
      expect(usePeripheralsStore.getState().unavailable).toBe(true);
    });
  });

  // ── plaudLogin → rc.periph.plaud.login ──────────────────────────────────

  describe('plaudLogin → rc.periph.plaud.login', () => {
    it('returns { ok: true } on successful login', async () => {
      // Source: rpc.ts:242-244 → plaud.login() → { ok: boolean; error?: string }
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_PLAUD_LOGIN_OK_RESPONSE);

      const result = await usePeripheralsStore.getState().plaudLogin();

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      // Plaud login blocks on a browser OAuth flow → request timeout is bumped
      // well past the default so slow human sign-in isn't a transport failure.
      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.periph.plaud.login',
        {},
        { timeoutMs: 190_000 },
      );
    });

    it('returns { ok: false, error } on failed login', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_PLAUD_LOGIN_FAIL_RESPONSE);

      const result = await usePeripheralsStore.getState().plaudLogin();

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Invalid credentials — please check Plaud account settings');
    });

    it('returns { ok: false, error } on RPC failure', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('plaud login timeout'));

      const result = await usePeripheralsStore.getState().plaudLogin();

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('sets unavailable=true on METHOD_NOT_FOUND', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      await usePeripheralsStore.getState().plaudLogin();

      expect(usePeripheralsStore.getState().unavailable).toBe(true);
    });
  });

  // ── announceBridge → rc.periph.bridge.announce ──────────────────────────

  describe('announceBridge → rc.periph.bridge.announce', () => {
    it('sends correct RPC params with devices array and secureContext', async () => {
      // Source: rpc.ts:200-233 → { devices: Array<{deviceId, label}>, secureContext }
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_BRIDGE_ANNOUNCE_RESPONSE);

      const devices = [
        { deviceId: 'media-device-abc123', label: 'Built-in Camera' },
        { deviceId: 'media-device-xyz789', label: 'USB Webcam HD' },
      ];

      await usePeripheralsStore.getState().announceBridge(devices, true);

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.periph.bridge.announce',
        { devices, secureContext: true },
      );
    });

    it('sends secureContext=false in insecure context', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(RC_PERIPH_BRIDGE_ANNOUNCE_RESPONSE);

      await usePeripheralsStore.getState().announceBridge([], false);

      const call = mockGatewayClient.request.mock.calls[0];
      expect(call[1]).toEqual({ devices: [], secureContext: false });
    });

    it('sets unavailable=true on METHOD_NOT_FOUND', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      await usePeripheralsStore.getState().announceBridge([], true);

      expect(usePeripheralsStore.getState().unavailable).toBe(true);
    });

    it('does not throw on generic RPC failure', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('bridge not ready'));

      // Should not throw — bridge announce failures are non-critical
      await expect(usePeripheralsStore.getState().announceBridge([], true)).resolves.toBeUndefined();
    });
  });

  // ── METHOD_NOT_FOUND → unavailable=true (canonical case) ────────────────

  describe('METHOD_NOT_FOUND → unavailable flag (plugin too old)', () => {
    it('unavailable is false by default', () => {
      expect(usePeripheralsStore.getState().unavailable).toBe(false);
    });

    it('loadDevices METHOD_NOT_FOUND marks store unavailable', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      await usePeripheralsStore.getState().loadDevices();

      expect(usePeripheralsStore.getState().unavailable).toBe(true);
      expect(usePeripheralsStore.getState().error).toBeNull();
    });

    it('loadObservations METHOD_NOT_FOUND marks store unavailable', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(makeMethodNotFoundError());

      await usePeripheralsStore.getState().loadObservations('dev-cam-001');

      expect(usePeripheralsStore.getState().unavailable).toBe(true);
    });

    it('generic error sets error field, NOT unavailable', async () => {
      const genericErr = new Error('database locked') as Error & { code?: string };
      mockGatewayClient.request.mockRejectedValueOnce(genericErr);

      await usePeripheralsStore.getState().loadDevices();

      const state = usePeripheralsStore.getState();
      expect(state.unavailable).toBe(false);
      expect(state.error).toBe('database locked');
    });
  });
});
