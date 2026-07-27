/**
 * rc.periph.* WS RPC methods (14 个)
 *
 * Methods registered:
 *   rc.periph.devices.list       — list all registered devices
 *   rc.periph.devices.create     — register a new device
 *   rc.periph.devices.update     — update device config/name/enable
 *   rc.periph.devices.delete     — remove device (observations + bound device monitors CASCADE)
 *   rc.periph.observations.list  — paginated observation timeline
 *   rc.periph.observations.create — manual snapshot → timeline (P2-T1)
 *   rc.periph.captureResult      — browser bridge delivers frame capture result
 *   rc.periph.bridge.announce    — dashboard announces camera bridge online + updates last_seen_at
 *   rc.periph.localCameras.list  — enumerate OS-attached cameras (gateway ffmpeg) for the add-device picker
 *   rc.periph.rtspPreview.start  — start (or reuse) an RTSP→HLS transmux session (§15 场景③ H1-H6)
 *   rc.periph.rtspPreview.stop   — stop an RTSP→HLS transmux session
 *   rc.periph.plaud.status       — proxy to PlaudManager.status()
 *   rc.periph.plaud.login        — proxy to PlaudManager.login()
 *   rc.periph.plaud.cancelLogin  — proxy to PlaudManager.cancelLogin() (kill in-flight login)
 */

import * as fs from 'node:fs';
import type { RegisterMethod } from '../types.js';
import type { PeriphService } from './service.js';
import { isValidPeriphDeviceId } from './service.js';
import type { PeriphBridge, CaptureResult } from './bridge.js';
import { listLocalCameras } from './local-camera.js';
import type { RtspPreviewManager } from './rtsp-preview.js';

/**
 * Base HTTP path segment for RTSP→HLS preview playlists/segments (§15 场景③ H3).
 * The full playlist URL is `${RTSP_PREVIEW_ROUTE}/${sessionToken}/index.m3u8`.
 * Kept here so rpc.ts (playlistUrl) and index.ts (the HTTP route) agree on the
 * prefix without a magic string in two places.
 */
export const RTSP_PREVIEW_ROUTE = '/rc/rtsp-preview';

/** Build the credential-free playlist URL a client uses to play the preview. */
export function rtspPreviewPlaylistUrl(sessionToken: string): string {
  return `${RTSP_PREVIEW_ROUTE}/${sessionToken}/index.m3u8`;
}

/**
 * Detect if running inside a Docker container. Mirrors workspace/rpc.ts:24 so the
 * two Docker signals stay consistent. Surfaced on rc.periph.plaud.status so the
 * dashboard can grey out Plaud connect (browser OAuth login cannot work in a
 * container — SPEC :211, P1-U4). Evaluated once at module load; container-ness
 * does not change over a process lifetime.
 */
const isDocker = fs.existsSync('/.dockerenv') || process.env.DOCKER === '1';

// ── PlaudManager interface (T6 will provide the real implementation) ──────────

export interface PlaudStatus {
  configured?: boolean;
  tokenPresent: boolean;
  account?: string;
  toolsReady?: boolean;
  lastError?: string;
  // P1-U4: gateway-side Docker signal. plaud.status() cannot know it (the manager
  // is container-agnostic), so the rc.periph.plaud.status handler stamps it on.
  docker?: boolean;
}

export interface PlaudManager {
  status(): Promise<PlaudStatus>;
  login(): Promise<{ ok: boolean; error?: string }>;
  cancelLogin(): Promise<{ ok: boolean }>;
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
  rtspPreview: RtspPreviewManager,
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
      // A device id doubles as a frame-directory path segment. Reject traversal
      // shapes at the boundary so the client gets a validation error instead of
      // a raw service exception; createDevice enforces the same rule.
      if (id !== undefined && !isValidPeriphDeviceId(id)) {
        throw new RpcValidationError(
          'id 只能包含字母、数字、下划线和连字符,须以字母或数字开头,最长 64 字符',
        );
      }
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
      // R2-I3: monitors bound to this device go with it, but their gateway cron
      // jobs live outside this DB — hand the ids back so the caller can remove
      // them (same contract as rc.monitor.delete's gateway_job_id).
      const { monitors } = service.deleteDevice(id);
      return { ok: true, deleted_monitors: monitors };
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
      const before_cursor = optionalNumber(params.before_cursor, 'before_cursor', 0, Number.MAX_SAFE_INTEGER);

      const observations = service.listObservations({ device_id, limit, before, before_cursor });
      return { observations };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.periph.observations.create ────────────────────────────────────────
  // P2-T1: manual dashboard snapshots write an observation so they appear in the
  // device timeline (previously only agent-side periph_camera_snap recorded).
  // Forwards to service.recordObservation (FK to rc_periph_devices rejects an
  // unknown device_id). Returns { observation } (with the keyset cursor).
  registerMethod('rc.periph.observations.create', async (params: Record<string, unknown>) => {
    try {
      const device_id = requireString(params.device_id, 'device_id');
      const kindRaw = optionalString(params.kind, 'kind') ?? 'snapshot';
      if (kindRaw !== 'snapshot' && kindRaw !== 'check' && kindRaw !== 'note') {
        throw new RpcValidationError("kind 必须为 'snapshot' | 'check' | 'note'");
      }
      const verdict = optionalString(params.verdict, 'verdict');
      const summary = optionalString(params.summary, 'summary');
      const frame_path = optionalString(params.frame_path, 'frame_path') ?? null;
      const monitor_id = optionalString(params.monitor_id, 'monitor_id');

      const observation = service.recordObservation({
        device_id,
        kind: kindRaw,
        verdict: verdict as never,
        summary,
        frame_path,
        monitor_id,
      });
      return { observation };
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

  // ── rc.periph.localCameras.list ──────────────────────────────────────────
  // Enumerate OS-attached cameras (USB / built-in webcam) via gateway-side
  // ffmpeg (-list_devices), so the add-device flow can offer a "local camera
  // (server-side)" source. Returns { cameras: [{device, label}] }. On any
  // failure (ffmpeg missing, unsupported platform, no devices, parse error) the
  // driver returns [] — the dashboard then degrades to a manual device-index
  // input. Never throws.
  registerMethod('rc.periph.localCameras.list', async (_params: Record<string, unknown>) => {
    const cameras = await listLocalCameras();
    return { cameras };
  });

  // ── rc.periph.rtspPreview.start ──────────────────────────────────────────
  // Start (or idempotently reuse) an RTSP→HLS transmux session for an rtsp
  // device so the dashboard can show a *live preview* (§15 场景③ H1-H6). Reads
  // device.config.{url,username,password} and hands them to the preview manager,
  // which builds the effective RTSP URL in memory (buildRtspUrl, shared with the
  // single-frame driver). The credential NEVER leaves the gateway: the returned
  // playlistUrl carries only the random sessionToken (H4).
  //   → { sessionToken, playlistUrl }  (playlistUrl = /rc/rtsp-preview/<token>/index.m3u8)
  registerMethod('rc.periph.rtspPreview.start', async (params: Record<string, unknown>) => {
    try {
      const deviceId = requireString(params.device_id, 'device_id');
      const device = service.getDevice(deviceId);
      if (!device) {
        throw new RpcValidationError('设备不存在');
      }
      if (device.driver !== 'rtsp') {
        // Live HLS preview only applies to rtsp devices; browser/local cameras
        // use getUserMedia / their own preview paths (H5).
        throw new RpcValidationError('该设备不是 RTSP 设备,不支持 HLS 预览');
      }
      const cfg = device.config as { url?: unknown; username?: unknown; password?: unknown };
      const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
      if (!url) {
        throw new RpcValidationError('RTSP 设备缺少 url 配置');
      }

      // The manager builds the effective (credentialed) URL internally; only the
      // token-based playlist URL comes back — no credential in the response.
      const session = await rtspPreview.start(deviceId, {
        url,
        username: typeof cfg.username === 'string' ? cfg.username : undefined,
        password: typeof cfg.password === 'string' ? cfg.password : undefined,
      });

      return {
        sessionToken: session.sessionToken,
        playlistUrl: rtspPreviewPlaylistUrl(session.sessionToken),
      };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.periph.rtspPreview.stop ───────────────────────────────────────────
  // Explicitly stop a device's live preview session (dashboard "stop preview" /
  // component unmount). Kills ffmpeg + removes the temp dir (H1). Idempotent:
  // stopping an already-stopped / never-started device returns { ok: false }.
  registerMethod('rc.periph.rtspPreview.stop', async (params: Record<string, unknown>) => {
    try {
      const deviceId = requireString(params.device_id, 'device_id');
      const stopped = await rtspPreview.stop(deviceId);
      return { ok: stopped };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.periph.plaud.status ───────────────────────────────────────────────
  // Stamp the gateway-side Docker signal (P1-U4): plaud.status() is
  // container-agnostic, so isDocker is folded in here (not inside the manager).
  registerMethod('rc.periph.plaud.status', async (_params: Record<string, unknown>) => {
    return { ...(await plaud.status()), docker: isDocker };
  });

  // ── rc.periph.plaud.login ────────────────────────────────────────────────
  registerMethod('rc.periph.plaud.login', async (_params: Record<string, unknown>) => {
    return plaud.login();
  });

  // ── rc.periph.plaud.cancelLogin ──────────────────────────────────────────
  // Kill an in-flight login (frees the 8199 OAuth callback port) so the user can
  // retry without hitting "port 8199 is in use". No-op if nothing is running.
  registerMethod('rc.periph.plaud.cancelLogin', async (_params: Record<string, unknown>) => {
    return plaud.cancelLogin();
  });
}
