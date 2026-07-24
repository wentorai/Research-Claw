/**
 * rc.periph.* WS RPC methods (9 个)
 *
 * Methods registered:
 *   rc.periph.devices.list       — list all registered devices
 *   rc.periph.devices.create     — register a new device
 *   rc.periph.devices.update     — update device config/name/enable
 *   rc.periph.devices.delete     — remove device (observations CASCADE)
 *   rc.periph.observations.list  — paginated observation timeline
 *   rc.periph.captureResult      — browser bridge delivers frame capture result
 *   rc.periph.bridge.announce    — dashboard announces camera bridge online + updates last_seen_at
 *   rc.periph.plaud.status       — proxy to PlaudManager.status()
 *   rc.periph.plaud.login        — proxy to PlaudManager.login()
 */

import type { RegisterMethod } from '../types.js';
import type { PeriphService } from './service.js';
import type { PeriphBridge, CaptureResult } from './bridge.js';

// ── PlaudManager interface (T6 will provide the real implementation) ──────────

export interface PlaudStatus {
  configured?: boolean;
  tokenPresent: boolean;
  account?: string;
  toolsReady?: boolean;
  lastError?: string;
}

export interface PlaudManager {
  status(): Promise<PlaudStatus>;
  login(): Promise<{ ok: boolean; error?: string }>;
}

// ── Validation helpers ────────────────────────────────────────────────────────

class RpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcValidationError';
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcValidationError(`${field} 是必填项,必须为非空字符串`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RpcValidationError(`${field} 必须为字符串`);
  return value;
}

function optionalNumber(value: unknown, field: string, min?: number, max?: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcValidationError(`${field} 必须为有效数字`);
  }
  if (min !== undefined && value < min) throw new RpcValidationError(`${field} 必须 >= ${min}`);
  if (max !== undefined && value > max) throw new RpcValidationError(`${field} 必须 <= ${max}`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new RpcValidationError(`${field} 必须为布尔值`);
  return value;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcValidationError(`${field} 必须为对象`);
  }
  return value as Record<string, unknown>;
}

// ── RPC registration ──────────────────────────────────────────────────────────

export function registerPeriphRpc(
  registerMethod: RegisterMethod,
  service: PeriphService,
  bridge: PeriphBridge,
  plaud: PlaudManager,
): void {
  // ── rc.periph.devices.list ───────────────────────────────────────────────
  registerMethod('rc.periph.devices.list', async (_params: Record<string, unknown>) => {
    return { devices: service.listDevices() };
  });

  // ── rc.periph.devices.create ─────────────────────────────────────────────
  registerMethod('rc.periph.devices.create', async (params: Record<string, unknown>) => {
    try {
      const name = requireString(params.name, 'name');
      const kind = requireString(params.kind, 'kind');
      const driver = requireString(params.driver, 'driver');
      const id = optionalString(params.id, 'id');
      const config = optionalObject(params.config, 'config');
      const check_prompt = optionalString(params.check_prompt, 'check_prompt');

      // kind / driver enum validity is enforced by the DB CHECK constraint;
      // type-cast satisfies TypeScript (invalid values produce a clear DB error).
      const device = service.createDevice({
        id,
        name,
        kind: kind as import('./types.js').PeriphKind,
        driver: driver as import('./types.js').PeriphDriver,
        config,
        check_prompt,
      });

      return { device };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.periph.devices.update ─────────────────────────────────────────────
  registerMethod('rc.periph.devices.update', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');

      // SPEC §5.1: update surface is name / enabled / config / check_prompt only.
      // last_seen_at is maintained by rc.periph.bridge.announce and the tool
      // layer; last_error is internal state — neither is client-patchable here.
      const patch: Parameters<typeof service.updateDevice>[1] = {};
      if (params.name !== undefined) patch.name = requireString(params.name, 'name');
      if (params.enabled !== undefined) patch.enabled = optionalBoolean(params.enabled, 'enabled');
      if (params.config !== undefined) patch.config = optionalObject(params.config, 'config');
      if (params.check_prompt !== undefined) {
        patch.check_prompt = optionalString(params.check_prompt, 'check_prompt');
      }

      const device = service.updateDevice(id, patch);
      return { device };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.periph.devices.delete ─────────────────────────────────────────────
  registerMethod('rc.periph.devices.delete', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      service.deleteDevice(id);
      return { ok: true };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.periph.observations.list ──────────────────────────────────────────
  registerMethod('rc.periph.observations.list', async (params: Record<string, unknown>) => {
    try {
      const device_id = optionalString(params.device_id, 'device_id');
      const limit = optionalNumber(params.limit, 'limit', 1, 200);
      const before = optionalString(params.before, 'before');

      const observations = service.listObservations({ device_id, limit, before });
      return { observations };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.periph.captureResult ──────────────────────────────────────────────
  // Dashboard delivers a frame capture result back to the gateway bridge.
  // Returns {ok: boolean} where ok = whether the requestId was pending
  // (first delivery wins; late/duplicate deliveries return false).
  // NOTE: does NOT write last_seen_at — that is maintained by bridge.announce
  // and the agent tool layer to avoid double-writes.
  registerMethod('rc.periph.captureResult', async (params: Record<string, unknown>) => {
    try {
      const requestId = requireString(params.requestId, 'requestId');
      const ok = params.ok;
      if (typeof ok !== 'boolean') {
        throw new RpcValidationError('ok 是必填项,必须为布尔值');
      }

      const result: CaptureResult = {
        ok,
        path: optionalString(params.path, 'path'),
        width: optionalNumber(params.width, 'width', 0),
        height: optionalNumber(params.height, 'height', 0),
        error: optionalString(params.error, 'error'),
      };

      const resolved = bridge.resolveCapture(requestId, result);
      return { ok: resolved };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.periph.bridge.announce ────────────────────────────────────────────
  // Dashboard announces that the camera bridge is online and provides the
  // list of available browser media devices. For each browser-camera device
  // whose config.deviceId matches an announced entry, update last_seen_at.
  registerMethod('rc.periph.bridge.announce', async (params: Record<string, unknown>) => {
    try {
      const rawDevices = params.devices;
      if (!Array.isArray(rawDevices)) {
        throw new RpcValidationError('devices 必须为数组');
      }
      const devices = rawDevices as Array<{ deviceId: string; label: string }>;

      const secureContext = params.secureContext;
      if (typeof secureContext !== 'boolean') {
        throw new RpcValidationError('secureContext 是必填项,必须为布尔值');
      }

      bridge.announce({ devices, secureContext });

      // Update last_seen_at for registered browser-camera devices that appear
      // in the announced device list (matched by config.deviceId).
      const announcedIds = new Set(devices.map((d) => d.deviceId));
      const allDevices = service.listDevices();
      const now = new Date().toISOString();

      for (const dev of allDevices) {
        if (dev.driver === 'browser-camera') {
          const configDeviceId = dev.config.deviceId;
          if (typeof configDeviceId === 'string' && announcedIds.has(configDeviceId)) {
            service.updateDevice(dev.id, { last_seen_at: now });
          }
        }
      }

      return { ok: true };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.periph.plaud.status ───────────────────────────────────────────────
  registerMethod('rc.periph.plaud.status', async (_params: Record<string, unknown>) => {
    return plaud.status();
  });

  // ── rc.periph.plaud.login ────────────────────────────────────────────────
  registerMethod('rc.periph.plaud.login', async (_params: Record<string, unknown>) => {
    return plaud.login();
  });
}
