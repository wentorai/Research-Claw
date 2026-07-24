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
import { PeriphBridge } from '../periph/bridge.js';
import { registerPeriphRpc, type PlaudManager, type PlaudStatus } from '../periph/rpc.js';
import type { RegisterMethod } from '../types.js';

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
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('rc.periph.* WS RPC', () => {
  let db: BetterSqlite3.Database;
  let tmpWs: string;
  let svc: PeriphService;
  let bridge: PeriphBridge;
  let fakePlaud: PlaudManager;
  let handlers: Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>;

  beforeEach(() => {
    db = makeDb();
    tmpWs = makeTmpWs();
    svc = new PeriphService(db, { workspaceRoot: tmpWs });
    bridge = new PeriphBridge();
    fakePlaud = makeFakePlaud();

    const { registerMethod, handlers: h } = makeFakeRegister();
    handlers = h;
    registerPeriphRpc(registerMethod, svc, bridge, fakePlaud);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  // ── Handler registration ─────────────────────────────────────────────────

  it('registers exactly 9 methods', () => {
    const methods = [
      'rc.periph.devices.list',
      'rc.periph.devices.create',
      'rc.periph.devices.update',
      'rc.periph.devices.delete',
      'rc.periph.observations.list',
      'rc.periph.captureResult',
      'rc.periph.bridge.announce',
      'rc.periph.plaud.status',
      'rc.periph.plaud.login',
    ];
    for (const m of methods) {
      expect(handlers.has(m), `missing handler: ${m}`).toBe(true);
    }
    expect(handlers.size).toBe(9);
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
    expect(result).toEqual({ ok: true });

    expect(svc.getDevice(dev.id)).toBeNull();
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

  // ── rc.periph.captureResult ──────────────────────────────────────────────

  it('captureResult → bridge.resolveCapture: resolves a pending request', async () => {
    // Arm the bridge with a broadcast handle so requestCapture works.
    const broadcast = vi.fn();
    bridge.adoptContext({ broadcast });

    // Kick off a requestCapture (creates a pending entry).
    const capturePromise = bridge.requestCapture('dev-1', 'test');

    // Extract the requestId from the broadcast call.
    expect(broadcast).toHaveBeenCalledOnce();
    const [, payload] = broadcast.mock.calls[0] as [string, { requestId: string }];
    const requestId = payload.requestId;
    expect(typeof requestId).toBe('string');

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
});
