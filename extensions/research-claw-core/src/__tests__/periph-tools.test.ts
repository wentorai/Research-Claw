/**
 * periph-tools.test.ts — TDD test suite for periph_list / periph_camera_snap / periph_observe
 *
 * Uses:
 *   - Real PeriphService backed by in-memory SQLite + runMigrations
 *   - Real PeriphBridge with fake broadcast context (or no context → offline)
 *
 * Covers (per brief Step 2):
 *   periph_camera_snap:
 *     - snap success path: observation recorded + JSON fields present
 *     - bridge offline (no context) → missed observation + error text with 中文提示
 *     - bridge timeout → missed observation + error text with 中文提示
 *     - bridge other error (permission-denied) → 'error' verdict observation
 *     - device_id omitted + 2 cameras → structured error listing ids
 *     - device_id omitted + 0 cameras → structured error
 *     - explicit device_id not found → structured error
 *     - device_id omitted + 1 camera → auto-selects it
 *   periph_observe:
 *     - write + round-trip: id and captured_at returned
 *     - kind validation: 'snapshot' rejected, only 'check'/'note' accepted
 *     - device_id not found → structured error
 *     - verdict defaults to 'info'
 *   periph_list:
 *     - empty → []
 *     - device with no observations → latest_observation null
 *     - device with observation → latest_observation present
 *     - fields: id, name, kind, driver, enabled, last_seen_at, latest_observation
 *   buildSnapResult:
 *     - inlineImage:false → text content only
 *     - PERIPH_SNAP_INLINE_IMAGE is false
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../db/migrations.js';
import { PeriphService } from '../periph/service.js';
import { PeriphBridge } from '../periph/bridge.js';
import { createPeriphTools, PERIPH_SNAP_INLINE_IMAGE, buildSnapResult } from '../periph/tools.js';
import type { ToolDefinition } from '../types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeTmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'periph-tools-test-'));
}

type BroadcastMock = ReturnType<typeof vi.fn>;

function makeBroadcast(): BroadcastMock {
  return vi.fn();
}

function makeCtxWithBroadcast(broadcast: BroadcastMock) {
  return { broadcast };
}

/** Parse text content from a tool return value. */
function getText(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }> };
  const textItem = r.content.find((c) => c.type === 'text');
  return textItem?.text ?? '';
}

/** Get tool by name from array. */
function getTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('periph tools', () => {
  let db: BetterSqlite3.Database;
  let tmpWs: string;
  let service: PeriphService;
  let bridge: PeriphBridge;
  let tools: ToolDefinition[];

  beforeEach(() => {
    db = makeDb();
    tmpWs = makeTmpWs();
    service = new PeriphService(db, { workspaceRoot: tmpWs });
    bridge = new PeriphBridge();
    tools = createPeriphTools(service, bridge);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  // ── PERIPH_SNAP_INLINE_IMAGE constant ────────────────────────────────────────

  it('PERIPH_SNAP_INLINE_IMAGE is false (T19 gate)', () => {
    expect(PERIPH_SNAP_INLINE_IMAGE).toBe(false);
  });

  // ── buildSnapResult ──────────────────────────────────────────────────────────

  it('buildSnapResult with inlineImage:false returns text content only', () => {
    const payload = { frame_path: '/tmp/a.jpg', width: 640, height: 480, captured_at: '2026-01-01T00:00:00.000Z' };
    const result = buildSnapResult(payload, { inlineImage: false }) as {
      content: Array<{ type: string; text: string }>;
      details: unknown;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.frame_path).toBe('/tmp/a.jpg');
    expect(parsed.width).toBe(640);
  });

  it('buildSnapResult inlineImage:true + imageBase64 → content 两项且 image 项形状正确', () => {
    const payload = {
      frame_path: '/tmp/b.jpg',
      width: 1280,
      height: 720,
      captured_at: '2026-01-01T00:00:00.000Z',
      imageBase64: 'abc123==',
      imageMimeType: 'image/png',
    };
    const result = buildSnapResult(payload, { inlineImage: true }) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      details: unknown;
    };
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('text');
    expect(result.content[1].type).toBe('image');
    expect(result.content[1].data).toBe('abc123==');
    expect(result.content[1].mimeType).toBe('image/png');
  });

  it('buildSnapResult inlineImage:true + imageBase64 with default mimeType → image/jpeg', () => {
    const payload = {
      frame_path: '/tmp/c.jpg',
      width: 640,
      height: 480,
      captured_at: '2026-01-01T00:00:00.000Z',
      imageBase64: 'xyz==',
    };
    const result = buildSnapResult(payload, { inlineImage: true }) as {
      content: Array<{ type: string; mimeType?: string }>;
    };
    expect(result.content).toHaveLength(2);
    expect(result.content[1].mimeType).toBe('image/jpeg');
  });

  it('buildSnapResult inlineImage:true 无 imageBase64 → 单 text 项', () => {
    const payload = { frame_path: '/tmp/d.jpg', width: 320, height: 240, captured_at: '2026-01-01T00:00:00.000Z' };
    const result = buildSnapResult(payload, { inlineImage: true }) as {
      content: Array<{ type: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  // ── periph_list ─────────────────────────────────────────────────────────────

  describe('periph_list', () => {
    it('returns empty array when no devices', async () => {
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const text = getText(result);
      expect(JSON.parse(text)).toEqual([]);
    });

    it('returns device with latest_observation null when no observations', async () => {
      service.createDevice({ name: 'Cam A', kind: 'camera', driver: 'browser-camera' });
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const arr = JSON.parse(getText(result)) as Array<{
        id: string;
        name: string;
        kind: string;
        driver: string;
        enabled: boolean;
        last_seen_at: string | null;
        latest_observation: unknown;
      }>;
      expect(arr).toHaveLength(1);
      expect(arr[0].name).toBe('Cam A');
      expect(arr[0].kind).toBe('camera');
      expect(arr[0].driver).toBe('browser-camera');
      expect(arr[0].enabled).toBe(true);
      expect(arr[0].latest_observation).toBeNull();
    });

    it('returns device with latest_observation when observation exists', async () => {
      const dev = service.createDevice({ name: 'Cam B', kind: 'camera', driver: 'browser-camera' });
      service.recordObservation({ device_id: dev.id, kind: 'check', verdict: 'ok', summary: 'all good' });
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const arr = JSON.parse(getText(result)) as Array<{
        latest_observation: { verdict: string; summary: string; captured_at: string } | null;
      }>;
      expect(arr).toHaveLength(1);
      expect(arr[0].latest_observation).not.toBeNull();
      expect(arr[0].latest_observation?.verdict).toBe('ok');
      expect(arr[0].latest_observation?.summary).toBe('all good');
      expect(typeof arr[0].latest_observation?.captured_at).toBe('string');
    });

    it('has all required fields on each device entry', async () => {
      service.createDevice({ name: 'Cam C', kind: 'camera', driver: 'browser-camera' });
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const arr = JSON.parse(getText(result)) as Array<Record<string, unknown>>;
      const entry = arr[0];
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.kind).toBe('string');
      expect(typeof entry.driver).toBe('string');
      expect(typeof entry.enabled).toBe('boolean');
      expect('last_seen_at' in entry).toBe(true);
      expect('latest_observation' in entry).toBe(true);
    });
  });

  // ── periph_camera_snap ──────────────────────────────────────────────────────

  describe('periph_camera_snap', () => {
    it('bridge offline (no context): returns missed observation + error text with 中文提示', async () => {
      const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
      const tool = getTool(tools, 'periph_camera_snap');
      // bridge has no context — offline
      const result = await tool.execute('t1', { device_id: dev.id, purpose: 'test' });
      const text = getText(result);
      expect(text).toContain('dashboard');
      expect(text).toContain('摄像头');
      expect(text).toContain('bridge-offline');

      // Verify missed observation recorded
      const obs = service.listObservations({ device_id: dev.id });
      expect(obs).toHaveLength(1);
      expect(obs[0].kind).toBe('snapshot');
      expect(obs[0].verdict).toBe('missed');
      // summary 无双前缀: 应以 'bridge-offline:' 开头,不应含 'bridge-bridge-'
      expect(obs[0].summary).toMatch(/^bridge-offline:/);
      expect(obs[0].summary).not.toContain('bridge-bridge-');
    });

    it('bridge timeout: returns missed observation + error text with 中文提示', async () => {
      vi.useFakeTimers();
      try {
        const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

        // Set up bridge with broadcast context but never resolve
        const broadcast = makeBroadcast();
        bridge.adoptContext(makeCtxWithBroadcast(broadcast));

        const tool = getTool(tools, 'periph_camera_snap');
        const snapPromise = tool.execute('t1', { device_id: dev.id });

        // Advance timers past timeout
        await vi.runAllTimersAsync();
        const result = await snapPromise;

        const text = getText(result);
        expect(text).toContain('bridge-timeout');
        expect(text).toContain('摄像头');

        const obs = service.listObservations({ device_id: dev.id });
        expect(obs).toHaveLength(1);
        expect(obs[0].verdict).toBe('missed');
        // summary 无双前缀: 应以 'bridge-timeout:' 开头,不应含 'bridge-bridge-'
        expect(obs[0].summary).toMatch(/^bridge-timeout:/);
        expect(obs[0].summary).not.toContain('bridge-bridge-');
      } finally {
        vi.useRealTimers();
      }
    });

    it('bridge permission-denied: records error verdict observation', async () => {
      const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));

      const tool = getTool(tools, 'periph_camera_snap');
      const snapPromise = tool.execute('t1', { device_id: dev.id });

      // Simulate dashboard responding with permission-denied
      await Promise.resolve(); // let the requestCapture promise chain set up
      const requestId = broadcast.mock.calls[0]?.[1]?.requestId as string;
      expect(requestId).toBeTruthy();
      bridge.resolveCapture(requestId, { ok: false, error: 'permission-denied' });

      const result = await snapPromise;
      const text = getText(result);
      expect(text).toContain('permission-denied');

      const obs = service.listObservations({ device_id: dev.id });
      expect(obs).toHaveLength(1);
      expect(obs[0].verdict).toBe('error');
    });

    it('snap success path: observation recorded + JSON fields present', async () => {
      const dev = service.createDevice({
        name: 'Cam',
        kind: 'camera',
        driver: 'browser-camera',
        config: { deviceId: 'browser-device-abc' },
      });

      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));

      const tool = getTool(tools, 'periph_camera_snap');
      const snapPromise = tool.execute('t1', { device_id: dev.id, purpose: 'lab check' });

      // Simulate successful capture from dashboard
      await Promise.resolve();
      const requestId = broadcast.mock.calls[0]?.[1]?.requestId as string;
      const capturedPath = '/ws/periph/device-1/frame-001.jpg';
      bridge.resolveCapture(requestId, { ok: true, path: capturedPath, width: 1280, height: 720 });

      const result = await snapPromise;
      const text = getText(result);
      const parsed = JSON.parse(text) as {
        frame_path: string;
        width: number;
        height: number;
        captured_at: string;
      };
      expect(parsed.frame_path).toBe(capturedPath);
      expect(parsed.width).toBe(1280);
      expect(parsed.height).toBe(720);
      expect(typeof parsed.captured_at).toBe('string');

      // Verify broadcast used browserDeviceId from config
      const broadcastPayload = broadcast.mock.calls[0]?.[1] as { deviceId: string };
      expect(broadcastPayload.deviceId).toBe('browser-device-abc');

      // Verify snapshot observation recorded
      const obs = service.listObservations({ device_id: dev.id });
      expect(obs).toHaveLength(1);
      expect(obs[0].kind).toBe('snapshot');
      expect(obs[0].verdict).toBe('info');
      expect(obs[0].frame_path).toBe(capturedPath);
      expect(obs[0].summary).toBe('lab check');

      // Verify last_seen_at updated
      const updated = service.getDevice(dev.id);
      expect(updated?.last_seen_at).toBeTruthy();
    });

    it('snap success falls back to device.id when config.deviceId absent', async () => {
      const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));

      const tool = getTool(tools, 'periph_camera_snap');
      const snapPromise = tool.execute('t1', { device_id: dev.id });

      await Promise.resolve();
      const broadcastPayload = broadcast.mock.calls[0]?.[1] as { deviceId: string; requestId: string };
      // Should use device.id since no config.deviceId
      expect(broadcastPayload.deviceId).toBe(dev.id);

      // Clean up (resolve to avoid unhandled promise)
      const requestId = broadcastPayload.requestId;
      bridge.resolveCapture(requestId, { ok: true, path: '/tmp/x.jpg', width: 640, height: 480 });
      await snapPromise;
    });

    it('device_id omitted + 0 enabled cameras → structured error', async () => {
      // No devices registered
      const tool = getTool(tools, 'periph_camera_snap');
      const result = await tool.execute('t1', {});
      const text = getText(result);
      expect(text).toContain('no-enabled-camera');
    });

    it('device_id omitted + 2 cameras → structured error listing ids', async () => {
      const cam1 = service.createDevice({ name: 'Cam 1', kind: 'camera', driver: 'browser-camera' });
      const cam2 = service.createDevice({ name: 'Cam 2', kind: 'camera', driver: 'browser-camera' });

      const tool = getTool(tools, 'periph_camera_snap');
      const result = await tool.execute('t1', {});
      const text = getText(result);
      expect(text).toContain('multiple-cameras');
      const parsed = JSON.parse(text.replace(/^Error: /, '')) as { device_ids: string[] };
      expect(parsed.device_ids).toContain(cam1.id);
      expect(parsed.device_ids).toContain(cam2.id);
    });

    it('device_id omitted + 1 camera → auto-selects it', async () => {
      const cam = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));

      const tool = getTool(tools, 'periph_camera_snap');
      const snapPromise = tool.execute('t1', {});

      await Promise.resolve();
      const payload = broadcast.mock.calls[0]?.[1] as { deviceId: string; requestId: string };
      // Auto-selected device's id used as browserDeviceId fallback
      expect(payload.deviceId).toBe(cam.id);
      bridge.resolveCapture(payload.requestId, { ok: true, path: '/tmp/auto.jpg', width: 320, height: 240 });
      const result = await snapPromise;
      const text = getText(result);
      expect(JSON.parse(text).frame_path).toBe('/tmp/auto.jpg');
    });

    it('explicit device_id not found → structured error', async () => {
      const tool = getTool(tools, 'periph_camera_snap');
      const result = await tool.execute('t1', { device_id: 'does-not-exist' });
      const text = getText(result);
      expect(text).toContain('device-not-found');
    });

    it('disabled camera not auto-selected', async () => {
      const cam = service.createDevice({ name: 'Disabled Cam', kind: 'camera', driver: 'browser-camera' });
      service.updateDevice(cam.id, { enabled: false });

      const tool = getTool(tools, 'periph_camera_snap');
      const result = await tool.execute('t1', {});
      const text = getText(result);
      expect(text).toContain('no-enabled-camera');
    });
  });

  // ── periph_observe ───────────────────────────────────────────────────────────

  describe('periph_observe', () => {
    it('write + round-trip: id and captured_at returned', async () => {
      const dev = service.createDevice({ name: 'Sensor', kind: 'lab-instrument', driver: 'oc-node' });
      const tool = getTool(tools, 'periph_observe');
      const result = await tool.execute('t1', {
        device_id: dev.id,
        kind: 'check',
        verdict: 'ok',
        summary: 'all nominal',
      });
      const text = getText(result);
      const parsed = JSON.parse(text) as { id: string; captured_at: string };
      expect(typeof parsed.id).toBe('string');
      expect(parsed.id).toBeTruthy();
      expect(typeof parsed.captured_at).toBe('string');

      // Verify stored in DB
      const obs = service.listObservations({ device_id: dev.id });
      expect(obs).toHaveLength(1);
      expect(obs[0].id).toBe(parsed.id);
      expect(obs[0].kind).toBe('check');
      expect(obs[0].verdict).toBe('ok');
      expect(obs[0].summary).toBe('all nominal');
    });

    it("kind='note' accepted", async () => {
      const dev = service.createDevice({ name: 'Sensor', kind: 'lab-instrument', driver: 'oc-node' });
      const tool = getTool(tools, 'periph_observe');
      const result = await tool.execute('t1', { device_id: dev.id, kind: 'note', summary: 'note text' });
      const text = getText(result);
      expect(() => JSON.parse(text)).not.toThrow();
      const obs = service.listObservations({ device_id: dev.id });
      expect(obs[0].kind).toBe('note');
    });

    it("kind='snapshot' rejected", async () => {
      const dev = service.createDevice({ name: 'Sensor', kind: 'lab-instrument', driver: 'oc-node' });
      const tool = getTool(tools, 'periph_observe');
      const result = await tool.execute('t1', { device_id: dev.id, kind: 'snapshot' });
      const text = getText(result);
      expect(text).toContain("kind must be 'check' or 'note'");
    });

    it('device_id not found → structured error', async () => {
      const tool = getTool(tools, 'periph_observe');
      const result = await tool.execute('t1', { device_id: 'ghost', kind: 'check' });
      const text = getText(result);
      expect(text).toContain('device-not-found');
    });

    it("verdict defaults to 'info' when omitted", async () => {
      const dev = service.createDevice({ name: 'Sensor', kind: 'lab-instrument', driver: 'oc-node' });
      const tool = getTool(tools, 'periph_observe');
      await tool.execute('t1', { device_id: dev.id, kind: 'check' });
      const obs = service.listObservations({ device_id: dev.id });
      expect(obs[0].verdict).toBe('info');
    });

    it('optional data stored as result_json', async () => {
      const dev = service.createDevice({ name: 'Sensor', kind: 'lab-instrument', driver: 'oc-node' });
      const tool = getTool(tools, 'periph_observe');
      await tool.execute('t1', {
        device_id: dev.id,
        kind: 'check',
        data: { temperature: 36.5, unit: 'C' },
      });
      const obs = service.listObservations({ device_id: dev.id });
      expect(obs[0].result_json).toEqual({ temperature: 36.5, unit: 'C' });
    });

    it('device_id required — empty string returns error', async () => {
      const tool = getTool(tools, 'periph_observe');
      const result = await tool.execute('t1', { device_id: '', kind: 'check' });
      const text = getText(result);
      expect(text).toContain('device_id is required');
    });
  });

  // ── tool descriptor shape ───────────────────────────────────────────────────

  describe('tool descriptor shape', () => {
    it('createPeriphTools returns exactly 3 tools', () => {
      expect(tools).toHaveLength(3);
    });

    it('all tools have name, description, parameters, execute', () => {
      for (const tool of tools) {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.parameters).toBe('object');
        expect(typeof tool.execute).toBe('function');
      }
    });

    it('tool names are periph_list, periph_camera_snap, periph_observe', () => {
      const names = tools.map((t) => t.name);
      expect(names).toContain('periph_list');
      expect(names).toContain('periph_camera_snap');
      expect(names).toContain('periph_observe');
    });

    it('periph_camera_snap parameters has no required fields', () => {
      const tool = getTool(tools, 'periph_camera_snap');
      const params = tool.parameters as { required?: string[] };
      expect(params.required ?? []).toHaveLength(0);
    });

    it('periph_observe requires device_id and kind', () => {
      const tool = getTool(tools, 'periph_observe');
      const params = tool.parameters as { required: string[] };
      expect(params.required).toContain('device_id');
      expect(params.required).toContain('kind');
    });
  });
});
