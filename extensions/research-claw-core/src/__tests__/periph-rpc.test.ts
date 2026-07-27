/**
 * rc.periph.* WS RPC — TDD test suite (Task 5)
 *
 * Covers:
 *  - fakeRegister collects handlers into Map<method, handler>
 *  - rc.periph.devices.list — returns all devices from service
 *  - rc.periph.devices.create — round-trip with valid params
 *  - rc.periph.devices.create — throws on missing name (validation)
 *  - rc.periph.devices.create — throws on missing kind (validation)
 *  - rc.periph.devices.create — throws on missing driver (validation)
 *  - rc.periph.devices.update — updates and returns device
 *  - rc.periph.devices.delete — removes device, returns {ok:true}
 *  - rc.periph.observations.list — returns observations (with device_id filter)
 *  - rc.periph.captureResult — linked to bridge.resolveCapture (pending request)
 *  - rc.periph.captureResult — returns {ok:false} for unknown requestId
 *  - rc.periph.bridge.announce — calls bridge.announce + updates last_seen_at for matching devices
 *  - rc.periph.bridge.announce — does NOT update last_seen_at for non-matching devices
 *  - rc.periph.plaud.status — proxies to fakePlaud.status()
 *  - rc.periph.plaud.login  — proxies to fakePlaud.login()
 */

import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../db/migrations.js';
import { PeriphService } from '../periph/service.js';
import { MonitorService } from '../monitor/service.js';
import { PeriphBridge } from '../periph/bridge.js';
// Mock the local-camera enumerator so rc.periph.localCameras.list is deterministic
// (no real ffmpeg spawn). The driver itself is unit-tested in periph-local-camera.test.ts.
vi.mock('../periph/local-camera.js', () => ({
  listLocalCameras: vi.fn(async () => [{ device: '0', label: 'FaceTime HD Camera' }]),
}));
import {
  registerPeriphRpc,
  rtspPreviewPlaylistUrl,
  type PlaudManager,
  type PlaudStatus,
} from '../periph/rpc.js';
import { listLocalCameras } from '../periph/local-camera.js';
import { RtspPreviewManager } from '../periph/rtsp-preview.js';
import type { PreviewSession } from '../periph/rtsp-preview.js';
import type { RegisterMethod } from '../types.js';

const mockListLocalCameras = vi.mocked(listLocalCameras);

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeTmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'periph-rpc-test-'));
}

/** Collects registered handlers into a Map for direct invocation in tests. */
function makeFakeRegister(): {
  registerMethod: RegisterMethod;
  handlers: Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>;
} {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>();
  const registerMethod: RegisterMethod = (method, handler) => {
    handlers.set(method, handler);
  };
  return { registerMethod, handlers };
}

/** Call a registered handler and await the result. */
async function call(
  handlers: Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`No handler registered for ${method}`);
  return handler(params);
}

function makeFakePlaud(): PlaudManager {
  return {
    status: vi.fn(async (): Promise<PlaudStatus> => ({
      configured: true,
      tokenPresent: true,
      account: 'test@example.com',
      toolsReady: true,
    })),
    login: vi.fn(async () => ({ ok: true })),
    cancelLogin: vi.fn(async () => ({ ok: true })),
  };
}

/**
 * Fake RtspPreviewManager: records start/stop calls with a deterministic token so
 * the RPC surface is tested WITHOUT spawning real ffmpeg (the manager itself is
 * unit-tested with a fake ffmpeg in periph-rtsp-preview.test.ts). Typed as the
 * real class so the registration signature stays honest.
 */
function makeFakeRtspPreview() {
  const starts: Array<{ deviceId: string; url: string; username?: string; password?: string }> = [];
  const stops: string[] = [];
  const fake = {
    start: vi.fn(async (deviceId: string, opts: { url: string; username?: string; password?: string }): Promise<PreviewSession> => {
      starts.push({ deviceId, url: opts.url, username: opts.username, password: opts.password });
      return { sessionToken: `tok-${deviceId}`, deviceId, dir: `/tmp/${deviceId}` };
    }),
    stop: vi.fn(async (deviceId: string): Promise<boolean> => {
      stops.push(deviceId);
      return true;
    }),
  } as unknown as RtspPreviewManager;
  return { fake, starts, stops };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('rc.periph.* WS RPC', () => {
  let db: BetterSqlite3.Database;
  let tmpWs: string;
  let svc: PeriphService;
  let bridge: PeriphBridge;
  let fakePlaud: PlaudManager;
  let fakePreview: ReturnType<typeof makeFakeRtspPreview>;
  let handlers: Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>;

  beforeEach(() => {
    db = makeDb();
    tmpWs = makeTmpWs();
    svc = new PeriphService(db, { workspaceRoot: tmpWs });
    bridge = new PeriphBridge();
    fakePlaud = makeFakePlaud();
    fakePreview = makeFakeRtspPreview();

    mockListLocalCameras.mockReset();
    mockListLocalCameras.mockResolvedValue([{ device: '0', label: 'FaceTime HD Camera' }]);

    const { registerMethod, handlers: h } = makeFakeRegister();
    handlers = h;
    registerPeriphRpc(registerMethod, svc, bridge, fakePlaud, fakePreview.fake);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  // ── Handler registration ─────────────────────────────────────────────────

  it('registers exactly 14 methods', () => {
    const methods = [
      'rc.periph.devices.list',
      'rc.periph.devices.create',
      'rc.periph.devices.update',
      'rc.periph.devices.delete',
      'rc.periph.observations.list',
      'rc.periph.observations.create', // P2-T1: manual snapshot → timeline
      'rc.periph.captureResult',
      'rc.periph.bridge.announce',
      'rc.periph.localCameras.list', // §15 v1.3 场景②: OS camera enumeration
      'rc.periph.rtspPreview.start', // §15 v1.3 场景③: RTSP→HLS live preview
      'rc.periph.rtspPreview.stop',  // §15 v1.3 场景③: stop preview session
      'rc.periph.plaud.status',
      'rc.periph.plaud.login',
      'rc.periph.plaud.cancelLogin',
    ];
    for (const m of methods) {
      expect(handlers.has(m), `missing handler: ${m}`).toBe(true);
    }
    expect(handlers.size).toBe(14);
  });

  // ── rc.periph.devices.list ───────────────────────────────────────────────

  it('devices.list returns empty array when no devices', async () => {
    const result = await call(handlers, 'rc.periph.devices.list') as { devices: unknown[] };
    expect(result).toEqual({ devices: [] });
  });

  it('devices.list returns all registered devices', async () => {
    svc.createDevice({ name: 'Cam A', kind: 'camera', driver: 'browser-camera' });
    svc.createDevice({ name: 'Cam B', kind: 'camera', driver: 'browser-camera' });
    const result = await call(handlers, 'rc.periph.devices.list') as { devices: unknown[] };
    expect(result.devices).toHaveLength(2);
  });

  // ── rc.periph.devices.create ─────────────────────────────────────────────

  it('devices.create round-trip: basic params', async () => {
    const result = await call(handlers, 'rc.periph.devices.create', {
      name: 'My Camera',
      kind: 'camera',
      driver: 'browser-camera',
    }) as { device: { name: string; kind: string; driver: string; enabled: boolean } };

    expect(result.device.name).toBe('My Camera');
    expect(result.device.kind).toBe('camera');
    expect(result.device.driver).toBe('browser-camera');
    expect(result.device.enabled).toBe(true);
  });

  it('devices.create passes through config and check_prompt', async () => {
    const result = await call(handlers, 'rc.periph.devices.create', {
      name: 'Lab Cam',
      kind: 'camera',
      driver: 'browser-camera',
      config: { deviceId: 'abc123', label: 'Built-in Camera' },
      check_prompt: 'Is the flask green?',
    }) as { device: { config: Record<string, unknown>; check_prompt: string } };

    expect(result.device.config).toEqual({ deviceId: 'abc123', label: 'Built-in Camera' });
    expect(result.device.check_prompt).toBe('Is the flask green?');
  });

  it('devices.create passes through semantic id (e.g. "plaud") as device.id', async () => {
    const result = await call(handlers, 'rc.periph.devices.create', {
      id: 'plaud',
      name: 'Plaud 录音笔',
      kind: 'audio-recorder',
      driver: 'mcp-plaud',
    }) as { device: { id: string; name: string } };

    expect(result.device.id).toBe('plaud');
    expect(result.device.name).toBe('Plaud 录音笔');
  });

  it('devices.create throws validation error if name is missing', async () => {
    await expect(
      call(handlers, 'rc.periph.devices.create', { kind: 'camera', driver: 'browser-camera' }),
    ).rejects.toThrow(/name/);
  });

  it('devices.create throws validation error if name is empty string', async () => {
    await expect(
      call(handlers, 'rc.periph.devices.create', { name: '  ', kind: 'camera', driver: 'browser-camera' }),
    ).rejects.toThrow(/name/);
  });

  it('devices.create throws validation error if kind is missing', async () => {
    await expect(
      call(handlers, 'rc.periph.devices.create', { name: 'Camera', driver: 'browser-camera' }),
    ).rejects.toThrow(/kind/);
  });

  it('devices.create throws validation error if driver is missing', async () => {
    await expect(
      call(handlers, 'rc.periph.devices.create', { name: 'Camera', kind: 'camera' }),
    ).rejects.toThrow(/driver/);
  });

  // ── rc.periph.devices.update ─────────────────────────────────────────────

  it('devices.update returns updated device', async () => {
    const dev = svc.createDevice({ name: 'Old Name', kind: 'camera', driver: 'browser-camera' });

    const result = await call(handlers, 'rc.periph.devices.update', {
      id: dev.id,
      name: 'New Name',
      enabled: false,
    }) as { device: { id: string; name: string; enabled: boolean } };

    expect(result.device.id).toBe(dev.id);
    expect(result.device.name).toBe('New Name');
    expect(result.device.enabled).toBe(false);
  });

  it('devices.update throws validation error if id is missing', async () => {
    await expect(
      call(handlers, 'rc.periph.devices.update', { name: 'X' }),
    ).rejects.toThrow(/id/);
  });

  it('devices.update ignores last_seen_at and last_error (not client-patchable per SPEC §5.1)', async () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

    const result = await call(handlers, 'rc.periph.devices.update', {
      id: dev.id,
      last_seen_at: '2020-01-01T00:00:00.000Z',
      last_error: 'client-injected error',
    }) as { device: { last_seen_at: string | null; last_error: string | null } };

    // The spec restricts the update surface to name/enabled/config/check_prompt;
    // last_seen_at is owned by bridge.announce, last_error by internal error paths.
    expect(result.device.last_seen_at).toBeNull();
    expect(result.device.last_error).toBeNull();

    const fromDb = svc.getDevice(dev.id)!;
    expect(fromDb.last_seen_at).toBeNull();
    expect(fromDb.last_error).toBeNull();
  });

  // ── rc.periph.devices.delete ─────────────────────────────────────────────

  it('devices.delete removes device and returns {ok:true}', async () => {
    const dev = svc.createDevice({ name: 'To Delete', kind: 'camera', driver: 'browser-camera' });

    const result = await call(handlers, 'rc.periph.devices.delete', { id: dev.id });
    expect(result).toEqual({ ok: true, deleted_monitors: [] });

    expect(svc.getDevice(dev.id)).toBeNull();
  });

  // R2-I3: the cron job for a bound device monitor lives in the gateway, not in
  // this DB — the handler must hand its id back so the dashboard can remove it.
  it('devices.delete reports the cascaded device monitors and their cron job ids', async () => {
    const dev = svc.createDevice({ name: 'Bench', kind: 'camera', driver: 'rtsp' });
    const monitors = new MonitorService(db);
    const mon = monitors.create({ name: 'Bench watch', source_type: 'device', target: dev.id });
    monitors.toggle(mon.id, true);
    monitors.setGatewayJobId(mon.id, 'gw-job-7');

    const result = await call(handlers, 'rc.periph.devices.delete', { id: dev.id });

    expect(result).toEqual({
      ok: true,
      deleted_monitors: [{ id: mon.id, gateway_job_id: 'gw-job-7' }],
    });
    expect(() => monitors.get(mon.id)).toThrow(/not found/i);
  });

  it('devices.delete throws validation error if id is missing', async () => {
    await expect(call(handlers, 'rc.periph.devices.delete', {})).rejects.toThrow(/id/);
  });

  // ── rc.periph.observations.list ──────────────────────────────────────────

  it('observations.list returns empty array when no observations', async () => {
    const result = await call(handlers, 'rc.periph.observations.list') as { observations: unknown[] };
    expect(result).toEqual({ observations: [] });
  });

  it('observations.list filters by device_id', async () => {
    const devA = svc.createDevice({ name: 'A', kind: 'camera', driver: 'browser-camera' });
    const devB = svc.createDevice({ name: 'B', kind: 'camera', driver: 'browser-camera' });

    svc.recordObservation({ device_id: devA.id, kind: 'snapshot', summary: 'obs-A' });
    svc.recordObservation({ device_id: devB.id, kind: 'snapshot', summary: 'obs-B' });

    const result = await call(handlers, 'rc.periph.observations.list', {
      device_id: devA.id,
    }) as { observations: Array<{ device_id: string }> };

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].device_id).toBe(devA.id);
  });

  it('observations.list respects limit param', async () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    for (let i = 0; i < 5; i++) {
      svc.recordObservation({ device_id: dev.id, kind: 'snapshot', summary: `obs-${i}` });
    }

    const result = await call(handlers, 'rc.periph.observations.list', {
      device_id: dev.id,
      limit: 2,
    }) as { observations: unknown[] };

    expect(result.observations).toHaveLength(2);
  });

  // ── rc.periph.observations.create (P2-T1: manual snapshot → timeline) ─────
  it('observations.create records an observation and returns it (manual snapshot)', async () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    const result = await call(handlers, 'rc.periph.observations.create', {
      device_id: dev.id,
      kind: 'snapshot',
      verdict: 'info',
      summary: 'Manual snapshot from the dashboard',
      frame_path: `periph/${dev.id}/manual.jpg`,
    }) as { observation: { id: string; device_id: string; kind: string; cursor: number } };

    expect(result.observation.device_id).toBe(dev.id);
    expect(result.observation.kind).toBe('snapshot');
    expect(typeof result.observation.cursor).toBe('number');
    // It appears in the device's timeline.
    expect(svc.listObservations({ device_id: dev.id })).toHaveLength(1);
  });

  it('observations.create rejects unknown device_id (FK)', async () => {
    await expect(
      call(handlers, 'rc.periph.observations.create', { device_id: 'no-such', kind: 'snapshot' }),
    ).rejects.toThrow();
  });

  it('observations.create rejects an invalid kind', async () => {
    const dev = svc.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
    await expect(
      call(handlers, 'rc.periph.observations.create', { device_id: dev.id, kind: 'bogus' }),
    ).rejects.toThrow(/kind/);
  });

  // ── rc.periph.captureResult ──────────────────────────────────────────────

  it('captureResult → bridge.resolveCapture: resolves a pending request', async () => {
    // Arm the bridge with a broadcast handle so requestCapture works.
    const broadcast = vi.fn();
    bridge.adoptContext({ broadcast });

    // Kick off a requestCapture (creates a pending entry). The 4th arg is the
    // registered device UUID (audit#8): distinct from the browser deviceId and
    // carried in the broadcast payload for the dashboard's upload-dir key. The
    // 3rd arg is the explicit timeout (default) so the id lands in slot 4.
    const capturePromise = bridge.requestCapture('dev-1', 'test', undefined, 'reg-uuid-1');

    // Extract the requestId + registeredDeviceId from the broadcast call.
    expect(broadcast).toHaveBeenCalledOnce();
    const [, payload] = broadcast.mock.calls[0] as [
      string,
      { requestId: string; registeredDeviceId: string },
    ];
    const requestId = payload.requestId;
    expect(typeof requestId).toBe('string');
    expect(payload.registeredDeviceId).toBe('reg-uuid-1');

    // Deliver the result via RPC.
    const rpcResult = await call(handlers, 'rc.periph.captureResult', {
      requestId,
      ok: true,
      path: 'periph/dev-1/frame.jpg',
      width: 640,
      height: 480,
    }) as { ok: boolean };

    // The RPC should report that it hit a pending entry.
    expect(rpcResult.ok).toBe(true);

    // The pending promise should now resolve with the frame data.
    const captureResult = await capturePromise;
    expect(captureResult.ok).toBe(true);
    expect(captureResult.path).toBe('periph/dev-1/frame.jpg');
    expect(captureResult.width).toBe(640);
    expect(captureResult.height).toBe(480);
  });

  it('captureResult → bridge.resolveCapture: returns {ok:false} for unknown requestId', async () => {
    const result = await call(handlers, 'rc.periph.captureResult', {
      requestId: 'no-such-id',
      ok: false,
      error: 'permission-denied',
    }) as { ok: boolean };

    expect(result.ok).toBe(false);
  });

  it('captureResult throws validation error if requestId is missing', async () => {
    await expect(
      call(handlers, 'rc.periph.captureResult', { ok: true }),
    ).rejects.toThrow(/requestId/);
  });

  it('captureResult throws validation error if ok is missing', async () => {
    await expect(
      call(handlers, 'rc.periph.captureResult', { requestId: 'abc' }),
    ).rejects.toThrow(/ok/);
  });

  // ── rc.periph.bridge.announce ────────────────────────────────────────────

  it('bridge.announce calls bridge.announce() and returns {ok:true}', async () => {
    const announceSpy = vi.spyOn(bridge, 'announce');

    const result = await call(handlers, 'rc.periph.bridge.announce', {
      devices: [{ deviceId: 'browser-cam-1', label: 'Built-in Camera' }],
      secureContext: true,
    });

    expect(result).toEqual({ ok: true });
    expect(announceSpy).toHaveBeenCalledOnce();
    expect(announceSpy).toHaveBeenCalledWith({
      devices: [{ deviceId: 'browser-cam-1', label: 'Built-in Camera' }],
      secureContext: true,
    });
  });

  it('bridge.announce updates last_seen_at for matching browser-camera devices', async () => {
    // Register a browser-camera device with a known deviceId in config.
    const dev = svc.createDevice({
      name: 'Built-in Cam',
      kind: 'camera',
      driver: 'browser-camera',
      config: { deviceId: 'browser-cam-42' },
    });

    // Verify last_seen_at is initially null.
    expect(dev.last_seen_at).toBeNull();

    await call(handlers, 'rc.periph.bridge.announce', {
      devices: [{ deviceId: 'browser-cam-42', label: 'Built-in Webcam' }],
      secureContext: true,
    });

    const updated = svc.getDevice(dev.id)!;
    expect(updated.last_seen_at).not.toBeNull();
    // Should be a recent ISO timestamp.
    const diff = Date.now() - new Date(updated.last_seen_at!).getTime();
    expect(diff).toBeLessThan(5000);
  });

  it('bridge.announce does NOT update last_seen_at for non-matching devices', async () => {
    const dev = svc.createDevice({
      name: 'External Cam',
      kind: 'camera',
      driver: 'browser-camera',
      config: { deviceId: 'browser-cam-99' },
    });

    // Announce a different deviceId.
    await call(handlers, 'rc.periph.bridge.announce', {
      devices: [{ deviceId: 'browser-cam-different', label: 'Some Camera' }],
      secureContext: false,
    });

    const unchanged = svc.getDevice(dev.id)!;
    expect(unchanged.last_seen_at).toBeNull();
  });

  it('bridge.announce does NOT update last_seen_at for mcp-plaud devices', async () => {
    const dev = svc.createDevice({
      name: 'Plaud Note',
      kind: 'audio-recorder',
      driver: 'mcp-plaud',
      config: { deviceId: 'browser-cam-42' }, // same id but wrong driver
    });

    await call(handlers, 'rc.periph.bridge.announce', {
      devices: [{ deviceId: 'browser-cam-42', label: 'Something' }],
      secureContext: true,
    });

    const unchanged = svc.getDevice(dev.id)!;
    expect(unchanged.last_seen_at).toBeNull();
  });

  it('bridge.announce throws validation error if devices is not an array', async () => {
    await expect(
      call(handlers, 'rc.periph.bridge.announce', { devices: 'bad', secureContext: true }),
    ).rejects.toThrow(/devices/);
  });

  it('bridge.announce throws validation error if secureContext is missing', async () => {
    await expect(
      call(handlers, 'rc.periph.bridge.announce', { devices: [] }),
    ).rejects.toThrow(/secureContext/);
  });

  // ── rc.periph.localCameras.list ──────────────────────────────────────────

  it('localCameras.list proxies to listLocalCameras() and wraps in {cameras}', async () => {
    mockListLocalCameras.mockResolvedValueOnce([
      { device: '0', label: 'FaceTime HD Camera' },
      { device: '1', label: 'USB Webcam' },
    ]);
    const result = (await call(handlers, 'rc.periph.localCameras.list')) as {
      cameras: Array<{ device: string; label: string }>;
    };
    expect(mockListLocalCameras).toHaveBeenCalledOnce();
    expect(result.cameras).toEqual([
      { device: '0', label: 'FaceTime HD Camera' },
      { device: '1', label: 'USB Webcam' },
    ]);
  });

  it('localCameras.list returns {cameras: []} when no cameras are detected', async () => {
    mockListLocalCameras.mockResolvedValueOnce([]);
    const result = (await call(handlers, 'rc.periph.localCameras.list')) as { cameras: unknown[] };
    expect(result).toEqual({ cameras: [] });
  });

  // ── rc.periph.rtspPreview.start / .stop (§15 场景③ H1-H6) ─────────────────

  function makeRtspDevice(config: Record<string, unknown> = { url: 'rtsp://cam.local/stream' }) {
    return svc.createDevice({ name: 'IP Cam', kind: 'camera', driver: 'rtsp', config });
  }

  it('rtspPreview.start reads config.{url,username,password} and returns a credential-free playlistUrl', async () => {
    const dev = makeRtspDevice({ url: 'rtsp://cam.local/stream', username: 'alice', password: 's3cr3t' });
    const result = (await call(handlers, 'rc.periph.rtspPreview.start', { device_id: dev.id })) as {
      sessionToken: string;
      playlistUrl: string;
    };
    // The manager received the raw url + creds (built in-memory into the effective URL).
    expect(fakePreview.starts).toHaveLength(1);
    expect(fakePreview.starts[0]).toMatchObject({
      deviceId: dev.id,
      url: 'rtsp://cam.local/stream',
      username: 'alice',
      password: 's3cr3t',
    });
    // The response carries ONLY the token — no credential anywhere (H4).
    expect(result.sessionToken).toBe(`tok-${dev.id}`);
    expect(result.playlistUrl).toBe(rtspPreviewPlaylistUrl(`tok-${dev.id}`));
    expect(result.playlistUrl).toBe(`/rc/rtsp-preview/tok-${dev.id}/index.m3u8`);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('s3cr3t');
  });

  it('rtspPreview.start rejects a device_id that does not exist', async () => {
    await expect(
      call(handlers, 'rc.periph.rtspPreview.start', { device_id: 'nope' }),
    ).rejects.toThrow(/不存在/);
    expect(fakePreview.starts).toHaveLength(0);
  });

  it('rtspPreview.start rejects a non-rtsp device (browser-camera has no HLS preview)', async () => {
    const browser = svc.createDevice({
      name: 'Webcam',
      kind: 'camera',
      driver: 'browser-camera',
      config: { deviceId: 'cam-a' },
    });
    await expect(
      call(handlers, 'rc.periph.rtspPreview.start', { device_id: browser.id }),
    ).rejects.toThrow(/RTSP/);
    expect(fakePreview.starts).toHaveLength(0);
  });

  it('rtspPreview.start rejects an rtsp device with no url in config', async () => {
    const dev = makeRtspDevice({});
    await expect(
      call(handlers, 'rc.periph.rtspPreview.start', { device_id: dev.id }),
    ).rejects.toThrow(/url/);
    expect(fakePreview.starts).toHaveLength(0);
  });

  it('rtspPreview.start throws validation error if device_id missing', async () => {
    await expect(call(handlers, 'rc.periph.rtspPreview.start', {})).rejects.toThrow(/device_id/);
  });

  it('rtspPreview.stop forwards to the manager and returns {ok}', async () => {
    const dev = makeRtspDevice();
    const result = (await call(handlers, 'rc.periph.rtspPreview.stop', { device_id: dev.id })) as {
      ok: boolean;
    };
    expect(fakePreview.stops).toEqual([dev.id]);
    expect(result).toEqual({ ok: true });
  });

  it('rtspPreview.stop throws validation error if device_id missing', async () => {
    await expect(call(handlers, 'rc.periph.rtspPreview.stop', {})).rejects.toThrow(/device_id/);
  });

  // ── rc.periph.plaud.status ───────────────────────────────────────────────

  it('plaud.status proxies to fakePlaud.status()', async () => {
    const result = await call(handlers, 'rc.periph.plaud.status') as PlaudStatus;

    expect(fakePlaud.status).toHaveBeenCalledOnce();
    expect(result.configured).toBe(true);
    expect(result.tokenPresent).toBe(true);
    expect(result.account).toBe('test@example.com');
    expect(result.toolsReady).toBe(true);
  });

  it('plaud.status returns the exact shape from PlaudManager', async () => {
    (fakePlaud.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      configured: false,
      tokenPresent: false,
      lastError: 'not configured',
    });

    const result = await call(handlers, 'rc.periph.plaud.status') as PlaudStatus;
    expect(result.configured).toBe(false);
    expect(result.tokenPresent).toBe(false);
    expect(result.lastError).toBe('not configured');
  });

  it('plaud.status stamps docker on the HANDLER, not the manager (P1-U4)', async () => {
    // The manager is container-agnostic — it never returns `docker`.
    (fakePlaud.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      configured: true,
      tokenPresent: true,
    });
    const result = await call(handlers, 'rc.periph.plaud.status') as PlaudStatus;
    // The handler folds in isDocker (fs.existsSync('/.dockerenv') || DOCKER==='1',
    // mirrors workspace/rpc.ts:24). On the CI/dev host that is false, but the key
    // MUST be present — its absence was the P1-U4 dead-code root cause.
    expect(result).toHaveProperty('docker');
    expect(typeof result.docker).toBe('boolean');
    expect(result.docker).toBe(false); // test host is not a container
  });

  // ── rc.periph.plaud.login ────────────────────────────────────────────────

  it('plaud.login proxies to fakePlaud.login()', async () => {
    const result = await call(handlers, 'rc.periph.plaud.login') as { ok: boolean };

    expect(fakePlaud.login).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it('plaud.login forwards error response from PlaudManager', async () => {
    (fakePlaud.login as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: 'browser-unavailable',
    });

    const result = await call(handlers, 'rc.periph.plaud.login') as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('browser-unavailable');
  });

  // ── rc.periph.plaud.cancelLogin ──────────────────────────────────────────

  it('plaud.cancelLogin proxies to fakePlaud.cancelLogin()', async () => {
    const result = await call(handlers, 'rc.periph.plaud.cancelLogin') as { ok: boolean };

    expect(fakePlaud.cancelLogin).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it('plaud.cancelLogin forwards {ok:false} from PlaudManager', async () => {
    (fakePlaud.cancelLogin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false });

    const result = await call(handlers, 'rc.periph.plaud.cancelLogin') as { ok: boolean };
    expect(result.ok).toBe(false);
  });
});
