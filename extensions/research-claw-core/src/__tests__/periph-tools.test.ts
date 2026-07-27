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
 *     - fields: id, name, kind, driver, enabled, last_seen_at, latest_observation, monitor_hint
 *   buildSnapResult:
 *     - inlineImage:false → text content only
 *     - PERIPH_SNAP_INLINE_IMAGE is true (F2)
 *   inline image (F2):
 *     - 帧文件存在且 ≤5MB → content 含 image 块 (OC 形态依据:
 *       openclaw/packages/agent-core/src/types.ts:418-420 content: (TextContent|ImageContent)[],
 *       openclaw/packages/llm-core/src/types.ts:225-229 {type:'image', data:base64, mimeType})
 *     - 帧 >5MB → 跳过内联 (对齐 openclaw/src/agents/image-sanitization.ts:9 DEFAULT_IMAGE_MAX_BYTES)
 *     - 帧在 workspace periph/ 之外 → 跳过内联
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
// Mock the RTSP driver so driver-routing tests are deterministic (no ffmpeg
// spawn). The real ffmpeg/MediaMTX path is covered in periph-rtsp.test.ts.
vi.mock('../periph/rtsp.js', () => ({
  captureRtspFrame: vi.fn(),
}));
// Mock the local-camera driver likewise (no ffmpeg spawn). The real avfoundation
// path is covered in periph-local-camera.test.ts.
vi.mock('../periph/local-camera.js', () => ({
  captureLocalCameraFrame: vi.fn(),
}));

import {
  createPeriphTools,
  PERIPH_SNAP_INLINE_IMAGE,
  PERIPH_SNAP_INLINE_IMAGE_MAX_BYTES,
  buildSnapResult,
  readFrameForInline,
} from '../periph/tools.js';
import { captureRtspFrame } from '../periph/rtsp.js';
import { captureLocalCameraFrame } from '../periph/local-camera.js';
import { WorkspaceService } from '../workspace/service.js';
import type { ToolDefinition } from '../types.js';

const mockCaptureRtspFrame = vi.mocked(captureRtspFrame);
const mockCaptureLocalCameraFrame = vi.mocked(captureLocalCameraFrame);

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
    tools = createPeriphTools(service, bridge, { workspaceRoot: tmpWs });
    mockCaptureRtspFrame.mockReset();
    mockCaptureLocalCameraFrame.mockReset();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  // ── PERIPH_SNAP_INLINE_IMAGE constant ────────────────────────────────────────

  it('PERIPH_SNAP_INLINE_IMAGE is true (F2 inline enabled)', () => {
    expect(PERIPH_SNAP_INLINE_IMAGE).toBe(true);
  });

  it('PERIPH_SNAP_INLINE_IMAGE_MAX_BYTES matches OC DEFAULT_IMAGE_MAX_BYTES (5MB)', () => {
    // openclaw/src/agents/image-sanitization.ts:9 — DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
    expect(PERIPH_SNAP_INLINE_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
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

  it('buildSnapResult 的 text JSON 与 details 不含 imageBase64(base64 只进 image 块)', () => {
    const payload = {
      frame_path: '/tmp/e.jpg',
      width: 640,
      height: 480,
      captured_at: '2026-01-01T00:00:00.000Z',
      imageBase64: 'SECRETBASE64==',
      imageMimeType: 'image/jpeg',
    };
    const result = buildSnapResult(payload, { inlineImage: true }) as {
      content: Array<{ type: string; text?: string }>;
      details: Record<string, unknown>;
    };
    expect(result.content[0].text).not.toContain('SECRETBASE64');
    expect('imageBase64' in result.details).toBe(false);
    expect('imageMimeType' in result.details).toBe(false);
  });

  // ── readFrameForInline 路径护栏 ──────────────────────────────────────────────

  describe('readFrameForInline path guard', () => {
    it('reads a frame under <ws>/periph/ back as base64', () => {
      const dir = path.join(tmpWs, 'periph', 'dev1');
      fs.mkdirSync(dir, { recursive: true });
      const bytes = Buffer.from([0x10, 0x20, 0x30]);
      fs.writeFileSync(path.join(dir, 'f.jpg'), bytes);

      const res = readFrameForInline(tmpWs, 'periph/dev1/f.jpg');
      expect(res).not.toBeNull();
      expect(res!.base64).toBe(bytes.toString('base64'));
      expect(res!.mimeType).toBe('image/jpeg');
    });

    it('绝对路径 + .. 段解析到 periph/ 之外 → null(目录穿越护栏)', () => {
      // tools.ts:136 用 path.resolve 对绝对路径亦规范化 .. 段;此前用
      // path.isAbsolute 短路取原值,原样绝对路径通过前缀比对但 readFileSync
      // 解析出 periph/ 之外的真实文件(目录穿越读)。
      const parentDir = path.dirname(tmpWs);
      const secretPath = path.join(parentDir, 'secret-frame.jpg');
      fs.writeFileSync(secretPath, Buffer.from([0xaa, 0xbb]));

      // 绝对且含 .. — 规范化后 = parentDir/secret-frame.jpg,在 periph/ 之外
      const traversal = path.join(tmpWs, 'periph', '..', '..', 'secret-frame.jpg');
      expect(path.isAbsolute(traversal)).toBe(true);

      expect(readFrameForInline(tmpWs, traversal)).toBeNull();

      fs.rmSync(secretPath, { force: true });
    });

    it('绝对路径直指 periph/ 之外(无 .. )→ null', () => {
      const parentDir = path.dirname(tmpWs);
      const secretPath = path.join(parentDir, 'plain-secret.jpg');
      fs.writeFileSync(secretPath, Buffer.from([0x01]));
      expect(readFrameForInline(tmpWs, secretPath)).toBeNull();
      fs.rmSync(secretPath, { force: true });
    });

    it('相对路径含 .. 穿越 periph/ 之外 → null', () => {
      const secretPath = path.join(tmpWs, 'ws-secret.jpg');
      fs.writeFileSync(secretPath, Buffer.from([0x02]));
      // periph/../ws-secret.jpg 规范化后在 periph/ 之外
      expect(readFrameForInline(tmpWs, 'periph/../ws-secret.jpg')).toBeNull();
      fs.rmSync(secretPath, { force: true });
    });

    // Audit #5: a frame path that is a SYMLINK to an external file must not be
    // read. Lexical path.resolve + startsWith passes (the link lives under
    // periph/), but realpath resolves outside the workspace.
    it('symlink under periph/ pointing to an external file → null (no escape read)', () => {
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'periph-ext-read-'));
      const externalFile = path.join(externalDir, 'secret.jpg');
      fs.writeFileSync(externalFile, Buffer.from([0xff, 0xd8, 0xff])); // jpeg magic
      const periphDir = path.join(tmpWs, 'periph');
      fs.mkdirSync(periphDir, { recursive: true });
      const link = path.join(periphDir, 'link.jpg');
      fs.symlinkSync(externalFile, link);

      expect(readFrameForInline(tmpWs, 'periph/link.jpg')).toBeNull();

      fs.rmSync(externalDir, { recursive: true, force: true });
    });

    // A symlinked intermediate directory must also be refused.
    it('symlinked intermediate dir under periph/ → null (no escape read)', () => {
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'periph-ext-dir-'));
      fs.writeFileSync(path.join(externalDir, 'f.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
      const periphDir = path.join(tmpWs, 'periph');
      fs.mkdirSync(periphDir, { recursive: true });
      fs.symlinkSync(externalDir, path.join(periphDir, 'outdir'));

      expect(readFrameForInline(tmpWs, 'periph/outdir/f.jpg')).toBeNull();

      fs.rmSync(externalDir, { recursive: true, force: true });
    });

    // A legitimate real frame under periph/ must still be readable (no regression).
    it('real frame under periph/ still reads (no false positive)', () => {
      const periphDir = path.join(tmpWs, 'periph', 'dev1');
      fs.mkdirSync(periphDir, { recursive: true });
      fs.writeFileSync(path.join(periphDir, 'ok.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
      const res = readFrameForInline(tmpWs, 'periph/dev1/ok.jpg');
      expect(res).not.toBeNull();
      expect(res!.mimeType).toBe('image/jpeg');
    });
  });

  // ── periph_list ─────────────────────────────────────────────────────────────

  describe('periph_list', () => {
    it('returns object with empty devices array and bridge offline when no devices/announce', async () => {
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const parsed = JSON.parse(getText(result)) as { devices: unknown[]; camera_bridge: { online: boolean; last_announce_at: string | null; browser_devices: unknown[] } };
      expect(parsed.devices).toEqual([]);
      expect(parsed.camera_bridge.online).toBe(false);
      expect(parsed.camera_bridge.last_announce_at).toBeNull();
      expect(parsed.camera_bridge.browser_devices).toEqual([]);
    });

    it('camera_bridge.online=true when bridge has a fresh announce', async () => {
      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));
      bridge.announce({ devices: [{ deviceId: 'bd-001', label: 'Built-in Camera' }], secureContext: true });

      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const parsed = JSON.parse(getText(result)) as { devices: unknown[]; camera_bridge: { online: boolean; last_announce_at: string; browser_devices: Array<{ deviceId: string; label: string }> } };
      expect(parsed.camera_bridge.online).toBe(true);
      expect(typeof parsed.camera_bridge.last_announce_at).toBe('string');
      expect(parsed.camera_bridge.browser_devices).toHaveLength(1);
      expect(parsed.camera_bridge.browser_devices[0].deviceId).toBe('bd-001');
      expect(parsed.camera_bridge.browser_devices[0].label).toBe('Built-in Camera');
    });

    it('returns device with latest_observation null when no observations', async () => {
      service.createDevice({ name: 'Cam A', kind: 'camera', driver: 'browser-camera' });
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const parsed = JSON.parse(getText(result)) as { devices: Array<{ id: string; name: string; kind: string; driver: string; enabled: boolean; last_seen_at: string | null; latest_observation: unknown }> };
      expect(parsed.devices).toHaveLength(1);
      expect(parsed.devices[0].name).toBe('Cam A');
      expect(parsed.devices[0].kind).toBe('camera');
      expect(parsed.devices[0].driver).toBe('browser-camera');
      expect(parsed.devices[0].enabled).toBe(true);
      expect(parsed.devices[0].latest_observation).toBeNull();
    });

    it('returns device with latest_observation when observation exists', async () => {
      const dev = service.createDevice({ name: 'Cam B', kind: 'camera', driver: 'browser-camera' });
      service.recordObservation({ device_id: dev.id, kind: 'check', verdict: 'ok', summary: 'all good' });
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const parsed = JSON.parse(getText(result)) as { devices: Array<{ latest_observation: { verdict: string; summary: string; captured_at: string } | null }> };
      expect(parsed.devices).toHaveLength(1);
      expect(parsed.devices[0].latest_observation).not.toBeNull();
      expect(parsed.devices[0].latest_observation?.verdict).toBe('ok');
      expect(parsed.devices[0].latest_observation?.summary).toBe('all good');
      expect(typeof parsed.devices[0].latest_observation?.captured_at).toBe('string');
    });

    it('has all required fields on each device entry', async () => {
      service.createDevice({ name: 'Cam C', kind: 'camera', driver: 'browser-camera' });
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const parsed = JSON.parse(getText(result)) as { devices: Array<Record<string, unknown>> };
      const entry = parsed.devices[0];
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.kind).toBe('string');
      expect(typeof entry.driver).toBe('string');
      expect(typeof entry.enabled).toBe('boolean');
      expect('last_seen_at' in entry).toBe(true);
      expect('latest_observation' in entry).toBe(true);
    });

    it('top-level result has devices and camera_bridge fields', async () => {
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const parsed = JSON.parse(getText(result)) as Record<string, unknown>;
      expect('devices' in parsed).toBe(true);
      expect('camera_bridge' in parsed).toBe(true);
    });

    // §13.3 (SPEC:409-410): 每设备携带机器可读的 monitor_create 指引
    it('each device entry carries monitor_hint with its own id (§13.3)', async () => {
      const dev = service.createDevice({ name: 'Cam H', kind: 'camera', driver: 'browser-camera' });
      const tool = getTool(tools, 'periph_list');
      const result = await tool.execute('t1', {});
      const parsed = JSON.parse(getText(result)) as { devices: Array<{ monitor_hint: string }> };
      expect(parsed.devices[0].monitor_hint).toBe(
        `创建定时查证请用 monitor_create(source_type='device', target='${dev.id}')`,
      );
    });

    it('periph_list description mentions monitor_hint', () => {
      const tool = getTool(tools, 'periph_list');
      expect(tool.description).toContain('monitor_hint');
      expect(tool.description).toContain('monitor_create');
    });
  });

  // ── periph_camera_snap ──────────────────────────────────────────────────────

  describe('periph_camera_snap', () => {
    it('bridge offline (no context): returns missed observation + error text with 中文提示 + periph_list hint', async () => {
      const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });
      const tool = getTool(tools, 'periph_camera_snap');
      // bridge has no context — offline
      const result = await tool.execute('t1', { device_id: dev.id, purpose: 'test' });
      const text = getText(result);
      expect(text).toContain('dashboard');
      expect(text).toContain('摄像头');
      expect(text).toContain('bridge-offline');
      expect(text).toContain('periph_list');
      expect(text).toContain('camera_bridge.online');

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
        expect(text).toContain('periph_list');
        expect(text).toContain('camera_bridge.online');

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

    // ── RTSP driver routing (§15-D8 案 A / F6) ─────────────────────────────────
    describe('rtsp driver routing', () => {
      // Write a real JPEG at the path captureRtspFrame "returns" so the success
      // path's inline read-back has a valid file to read.
      function writeJpeg(absPath: string): void {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        // Minimal JPEG: SOI + EOI (magic 0xFFD8 ... 0xFFD9).
        fs.writeFileSync(absPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }

      it('routes rtsp device to captureRtspFrame (NOT the bridge) and records observation', async () => {
        const dev = service.createDevice({
          name: 'Lab IP Cam',
          kind: 'camera',
          driver: 'rtsp',
          config: { url: 'rtsp://cam.lan:554/stream' },
        });
        // Bridge WOULD be online, but rtsp must never use it.
        const broadcast = makeBroadcast();
        bridge.adoptContext(makeCtxWithBroadcast(broadcast));

        const framePath = path.join(service.frameDirFor(dev.id), 'shot.jpg');
        writeJpeg(framePath);
        mockCaptureRtspFrame.mockResolvedValue({ ok: true, path: framePath, width: 640, height: 480 });

        const tool = getTool(tools, 'periph_camera_snap');
        const result = await tool.execute('t1', { device_id: dev.id, purpose: 'incubator' });

        // captureRtspFrame called with the device's config url + the per-device outDir.
        expect(mockCaptureRtspFrame).toHaveBeenCalledTimes(1);
        const arg = mockCaptureRtspFrame.mock.calls[0][0];
        expect(arg.url).toBe('rtsp://cam.lan:554/stream');
        expect(arg.outDir).toBe(service.frameDirFor(dev.id));
        // The bridge was never asked to broadcast a capture request.
        expect(broadcast).not.toHaveBeenCalled();

        // Return payload carries the frame + dimensions. Gateway-side drivers
        // return an ABSOLUTE path; the tool normalises it to the
        // WORKSPACE-RELATIVE form (tools.ts toWorkspaceRelativeFramePath) that
        // the path guard accepts — an absolute path makes readFrameForInline AND
        // GET /rc/download?path= both reject it (resolveWithinRoot bans absolute).
        const relPath = path.relative(tmpWs, framePath);
        const text = getText(result);
        const parsed = JSON.parse(text) as { frame_path: string; width: number; height: number };
        expect(parsed.frame_path).toBe(relPath);
        expect(parsed.width).toBe(640);
        expect(parsed.height).toBe(480);

        // Observation recorded + last_seen_at updated.
        const obs = service.listObservations({ device_id: dev.id });
        expect(obs).toHaveLength(1);
        expect(obs[0].kind).toBe('snapshot');
        expect(obs[0].verdict).toBe('info');
        expect(obs[0].frame_path).toBe(relPath);
        expect(service.getDevice(dev.id)?.last_seen_at).toBeTruthy();
      });

      // The dashboard thumbnail (ObservationTimeline.tsx) renders a frame by
      // GET /rc/download?path=<frame_path>, and that route resolves the param
      // through WorkspaceService.resolvePath. Every other test here asserts the
      // path STRING; none proved the download side can actually open it. Close
      // the loop on the real resolver — a regression that re-emits absolute
      // paths keeps all the string assertions green while every thumbnail 400s.
      it('recorded frame_path is openable through the SAME resolver GET /rc/download uses', async () => {
        const dev = service.createDevice({
          name: 'Thumb Cam',
          kind: 'camera',
          driver: 'rtsp',
          config: { url: 'rtsp://cam.lan/stream' },
        });
        const framePath = path.join(service.frameDirFor(dev.id), 'thumb.jpg');
        fs.mkdirSync(path.dirname(framePath), { recursive: true });
        const bytes = Buffer.from([0xff, 0xd8, 0x52, 0x43, 0x54, 0x48, 0xff, 0xd9]);
        fs.writeFileSync(framePath, bytes);
        mockCaptureRtspFrame.mockResolvedValue({ ok: true, path: framePath, width: 640, height: 480 });

        const tool = getTool(tools, 'periph_camera_snap');
        const result = await tool.execute('t1', { device_id: dev.id });
        const recorded = JSON.parse(getText(result)).frame_path as string;

        const ws = new WorkspaceService({
          root: tmpWs,
          autoTrackGit: false,
          commitDebounceMs: 0,
          maxGitFileSize: 1_000_000,
          maxUploadSize: 1_000_000,
          gitAuthorName: 'rc',
          gitAuthorEmail: 'rc@example.com',
        });
        const served = ws.resolvePath(recorded);
        expect(fs.readFileSync(served).equals(bytes)).toBe(true);

        // And the un-normalised absolute form — what the driver hands back — is
        // exactly what that resolver refuses. This is the failure the
        // normalisation exists to prevent, asserted rather than asserted-about.
        expect(() => ws.resolvePath(framePath)).toThrow();
      });

      it('passes separate username/password from config to the rtsp driver', async () => {
        const dev = service.createDevice({
          name: 'Auth Cam',
          kind: 'camera',
          driver: 'rtsp',
          config: { url: 'rtsp://cam.lan/stream', username: 'alice', password: 's3cr3t' },
        });
        const framePath = path.join(service.frameDirFor(dev.id), 'a.jpg');
        writeJpeg(framePath);
        mockCaptureRtspFrame.mockResolvedValue({ ok: true, path: framePath });

        const tool = getTool(tools, 'periph_camera_snap');
        await tool.execute('t1', { device_id: dev.id });

        const arg = mockCaptureRtspFrame.mock.calls[0][0];
        expect(arg.username).toBe('alice');
        expect(arg.password).toBe('s3cr3t');
      });

      it('rtsp failure records error observation and does NOT leak credentials', async () => {
        const dev = service.createDevice({
          name: 'Auth Cam',
          kind: 'camera',
          driver: 'rtsp',
          config: { url: 'rtsp://bob:TOPSECRET@cam.lan/stream' },
        });
        // Driver returns a classification token only (never the URL/password).
        mockCaptureRtspFrame.mockResolvedValue({ ok: false, error: 'auth-failed' });

        const tool = getTool(tools, 'periph_camera_snap');
        const result = await tool.execute('t1', { device_id: dev.id });
        const text = getText(result);

        expect(text).toContain('auth-failed');
        // The tool's return text must never echo the embedded password/user/url.
        expect(text).not.toContain('TOPSECRET');
        expect(text).not.toContain('bob');

        const obs = service.listObservations({ device_id: dev.id });
        expect(obs).toHaveLength(1);
        expect(obs[0].verdict).toBe('error');
        // Observation summary/frame must not carry credentials either.
        expect(obs[0].summary).not.toContain('TOPSECRET');
        expect(obs[0].summary).not.toContain('bob');
      });

      it('rtsp device with no url in config → rtsp-url-missing error, driver not called', async () => {
        const dev = service.createDevice({
          name: 'Broken Cam',
          kind: 'camera',
          driver: 'rtsp',
          config: {},
        });
        const tool = getTool(tools, 'periph_camera_snap');
        const result = await tool.execute('t1', { device_id: dev.id });
        const text = getText(result);
        expect(text).toContain('rtsp-url-missing');
        expect(mockCaptureRtspFrame).not.toHaveBeenCalled();

        const obs = service.listObservations({ device_id: dev.id });
        expect(obs).toHaveLength(1);
        expect(obs[0].verdict).toBe('error');
      });

      it('auto-select counts an rtsp camera as a camera (single enabled → picked)', async () => {
        const dev = service.createDevice({
          name: 'Only Cam',
          kind: 'camera',
          driver: 'rtsp',
          config: { url: 'rtsp://cam.lan/s' },
        });
        const framePath = path.join(service.frameDirFor(dev.id), 'auto.jpg');
        writeJpeg(framePath);
        mockCaptureRtspFrame.mockResolvedValue({ ok: true, path: framePath });

        const tool = getTool(tools, 'periph_camera_snap');
        // No device_id → must auto-select the single enabled (rtsp) camera.
        const result = await tool.execute('t1', {});
        expect(mockCaptureRtspFrame).toHaveBeenCalledTimes(1);
        const text = getText(result);
        expect(JSON.parse(text).frame_path).toBe(path.relative(tmpWs, framePath));
      });

      it('rtsp snap passes monitor_id through to the observation', async () => {
        const dev = service.createDevice({
          name: 'Cam',
          kind: 'camera',
          driver: 'rtsp',
          config: { url: 'rtsp://cam.lan/s' },
        });
        const framePath = path.join(service.frameDirFor(dev.id), 'm.jpg');
        writeJpeg(framePath);
        mockCaptureRtspFrame.mockResolvedValue({ ok: true, path: framePath });

        const tool = getTool(tools, 'periph_camera_snap');
        await tool.execute('t1', { device_id: dev.id, monitor_id: 'mon-123' });
        const obs = service.listObservations({ device_id: dev.id });
        expect(obs[0].monitor_id).toBe('mon-123');
      });
    });

    // ── local-camera driver routing (§15 v1.3 场景②) ───────────────────────────
    describe('local-camera driver routing', () => {
      function writeJpeg(absPath: string): void {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }

      it('routes local-camera device to captureLocalCameraFrame (NOT the bridge/rtsp) and records observation', async () => {
        const dev = service.createDevice({
          name: 'USB Webcam',
          kind: 'camera',
          driver: 'local-camera',
          config: { device: '0' },
        });
        // Bridge WOULD be online, but local-camera must never use it.
        const broadcast = makeBroadcast();
        bridge.adoptContext(makeCtxWithBroadcast(broadcast));

        const framePath = path.join(service.frameDirFor(dev.id), 'shot.jpg');
        writeJpeg(framePath);
        mockCaptureLocalCameraFrame.mockResolvedValue({ ok: true, path: framePath, width: 1280, height: 720 });

        const tool = getTool(tools, 'periph_camera_snap');
        const result = await tool.execute('t1', { device_id: dev.id, purpose: 'bench check' });

        // captureLocalCameraFrame called with config.device + the per-device outDir.
        expect(mockCaptureLocalCameraFrame).toHaveBeenCalledTimes(1);
        const arg = mockCaptureLocalCameraFrame.mock.calls[0][0];
        expect(arg.device).toBe('0');
        expect(arg.outDir).toBe(service.frameDirFor(dev.id));
        // Neither the bridge nor the rtsp driver was used.
        expect(broadcast).not.toHaveBeenCalled();
        expect(mockCaptureRtspFrame).not.toHaveBeenCalled();

        // Gateway drivers return an ABSOLUTE path; the tool normalises it to the
        // WORKSPACE-RELATIVE form the path guard accepts (see tools.ts
        // toWorkspaceRelativeFramePath) — otherwise readFrameForInline and
        // GET /rc/download?path= both reject it.
        const relPath = path.relative(tmpWs, framePath);
        const text = getText(result);
        const parsed = JSON.parse(text) as { frame_path: string; width: number; height: number };
        expect(parsed.frame_path).toBe(relPath);
        expect(parsed.width).toBe(1280);
        expect(parsed.height).toBe(720);

        const obs = service.listObservations({ device_id: dev.id });
        expect(obs).toHaveLength(1);
        expect(obs[0].kind).toBe('snapshot');
        expect(obs[0].verdict).toBe('info');
        expect(obs[0].frame_path).toBe(relPath);
        expect(service.getDevice(dev.id)?.last_seen_at).toBeTruthy();
      });

      it('local-camera device with no device in config → local-camera-device-missing, driver not called', async () => {
        const dev = service.createDevice({
          name: 'Broken Local Cam',
          kind: 'camera',
          driver: 'local-camera',
          config: {},
        });
        const tool = getTool(tools, 'periph_camera_snap');
        const result = await tool.execute('t1', { device_id: dev.id });
        const text = getText(result);
        expect(text).toContain('local-camera-device-missing');
        expect(mockCaptureLocalCameraFrame).not.toHaveBeenCalled();

        const obs = service.listObservations({ device_id: dev.id });
        expect(obs).toHaveLength(1);
        expect(obs[0].verdict).toBe('error');
      });

      it('local-camera capture failure records an error observation (token only)', async () => {
        const dev = service.createDevice({
          name: 'Local Cam',
          kind: 'camera',
          driver: 'local-camera',
          config: { device: '9' },
        });
        mockCaptureLocalCameraFrame.mockResolvedValue({ ok: false, error: 'device-not-found' });

        const tool = getTool(tools, 'periph_camera_snap');
        const result = await tool.execute('t1', { device_id: dev.id });
        const text = getText(result);
        expect(text).toContain('device-not-found');

        const obs = service.listObservations({ device_id: dev.id });
        expect(obs).toHaveLength(1);
        expect(obs[0].verdict).toBe('error');
      });

      it('auto-select counts a local-camera as a camera (single enabled → picked)', async () => {
        const dev = service.createDevice({
          name: 'Only Local Cam',
          kind: 'camera',
          driver: 'local-camera',
          config: { device: '0' },
        });
        const framePath = path.join(service.frameDirFor(dev.id), 'auto.jpg');
        writeJpeg(framePath);
        mockCaptureLocalCameraFrame.mockResolvedValue({ ok: true, path: framePath });

        const tool = getTool(tools, 'periph_camera_snap');
        // No device_id → must auto-select the single enabled (local-camera) camera.
        const result = await tool.execute('t1', {});
        expect(mockCaptureLocalCameraFrame).toHaveBeenCalledTimes(1);
        const text = getText(result);
        expect(JSON.parse(text).frame_path).toBe(path.relative(tmpWs, framePath));
      });

      it('local-camera snap passes monitor_id through to the observation', async () => {
        const dev = service.createDevice({
          name: 'Cam',
          kind: 'camera',
          driver: 'local-camera',
          config: { device: '0' },
        });
        const framePath = path.join(service.frameDirFor(dev.id), 'm.jpg');
        writeJpeg(framePath);
        mockCaptureLocalCameraFrame.mockResolvedValue({ ok: true, path: framePath });

        const tool = getTool(tools, 'periph_camera_snap');
        await tool.execute('t1', { device_id: dev.id, monitor_id: 'mon-local-9' });
        const obs = service.listObservations({ device_id: dev.id });
        expect(obs[0].monitor_id).toBe('mon-local-9');
      });
    });

    // ── F2 inline image (snap 成功后读帧回填 image content) ─────────────────
    // OC 工具结果 content 类型 (TextContent|ImageContent)[]:
    //   openclaw/packages/agent-core/src/types.ts:418-420
    // ImageContent 形态 {type:'image', data:<base64>, mimeType}:
    //   openclaw/packages/llm-core/src/types.ts:225-229
    // 插件工具带 content[] 的结果被原样透传:
    //   openclaw/src/agents/agent-tool-definition-adapter.ts:225-234

    it('snap success + 帧文件在 workspace periph/ 内 → content 含 image 块(base64 与文件一致)', async () => {
      const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

      // 真实帧文件: workspace-relative periph/<id>/frame.jpg(dashboard 上传目录约定)
      const relPath = `periph/${dev.id}/frame-inline.jpg`;
      const absDir = path.join(tmpWs, 'periph', dev.id);
      fs.mkdirSync(absDir, { recursive: true });
      const frameBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0xff, 0xd9]);
      fs.writeFileSync(path.join(absDir, 'frame-inline.jpg'), frameBytes);

      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));

      const tool = getTool(tools, 'periph_camera_snap');
      const snapPromise = tool.execute('t1', { device_id: dev.id, purpose: 'inline check' });

      await Promise.resolve();
      const requestId = broadcast.mock.calls[0]?.[1]?.requestId as string;
      bridge.resolveCapture(requestId, { ok: true, path: relPath, width: 640, height: 480 });

      const result = (await snapPromise) as {
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      };
      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe('text');
      expect(result.content[1].type).toBe('image');
      expect(result.content[1].data).toBe(frameBytes.toString('base64'));
      expect(result.content[1].mimeType).toBe('image/jpeg');
      // text JSON 不携带 base64
      expect(result.content[0].text).not.toContain(frameBytes.toString('base64'));
    });

    it('snap success + 帧 >5MB → 跳过内联仅留 text(护栏)', async () => {
      // 护栏值对齐 openclaw/src/agents/image-sanitization.ts:9 DEFAULT_IMAGE_MAX_BYTES
      const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

      const relPath = `periph/${dev.id}/frame-huge.jpg`;
      const absDir = path.join(tmpWs, 'periph', dev.id);
      fs.mkdirSync(absDir, { recursive: true });
      fs.writeFileSync(path.join(absDir, 'frame-huge.jpg'), Buffer.alloc(PERIPH_SNAP_INLINE_IMAGE_MAX_BYTES + 1));

      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));

      const tool = getTool(tools, 'periph_camera_snap');
      const snapPromise = tool.execute('t1', { device_id: dev.id });

      await Promise.resolve();
      const requestId = broadcast.mock.calls[0]?.[1]?.requestId as string;
      bridge.resolveCapture(requestId, { ok: true, path: relPath, width: 4000, height: 3000 });

      const result = (await snapPromise) as { content: Array<{ type: string }> };
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });

    it('snap success + 帧文件在 periph/ 之外 → 跳过内联(路径护栏)', async () => {
      const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

      // workspace 内但不在 periph/ 下 — 前缀护栏拒绝读回
      fs.writeFileSync(path.join(tmpWs, 'outside.jpg'), Buffer.from([0x01, 0x02]));

      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));

      const tool = getTool(tools, 'periph_camera_snap');
      const snapPromise = tool.execute('t1', { device_id: dev.id });

      await Promise.resolve();
      const requestId = broadcast.mock.calls[0]?.[1]?.requestId as string;
      bridge.resolveCapture(requestId, { ok: true, path: 'outside.jpg', width: 10, height: 10 });

      const result = (await snapPromise) as { content: Array<{ type: string }> };
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });

    it('snap success + 绝对路径含 .. 段穿越 periph/ 之外 → 跳过内联(目录穿越护栏)', async () => {
      // 护栏契约:path.resolve 对绝对路径亦规范化 .. 段(tools.ts:136),
      // 否则 '<ws>/periph/../../../<secret>' 会以原样通过前缀比对却在
      // readFileSync 时解析到 periph/ 之外(目录穿越读)。
      const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

      // 在 workspace 父目录放一个 periph/ 之外的"敏感"文件
      const parentDir = path.dirname(tmpWs);
      const secretPath = path.join(parentDir, `secret-${dev.id}.jpg`);
      fs.writeFileSync(secretPath, Buffer.from([0x99, 0x98]));

      // 绝对路径 + .. 段:规范化后 = parentDir/secret-*.jpg,在 periph/ 之外
      const traversalPath = path.join(tmpWs, 'periph', '..', '..', path.basename(secretPath));

      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));

      const tool = getTool(tools, 'periph_camera_snap');
      const snapPromise = tool.execute('t1', { device_id: dev.id });

      await Promise.resolve();
      const requestId = broadcast.mock.calls[0]?.[1]?.requestId as string;
      bridge.resolveCapture(requestId, { ok: true, path: traversalPath, width: 10, height: 10 });

      const result = (await snapPromise) as { content: Array<{ type: string }> };
      // 护栏拒读 → 仅 text,secret 文件的 base64 绝不进上下文
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      fs.rmSync(secretPath, { force: true });
    });

    it('snap success + 帧文件缺失 → 退化为纯 text(不算失败)', async () => {
      const dev = service.createDevice({ name: 'Cam', kind: 'camera', driver: 'browser-camera' });

      const broadcast = makeBroadcast();
      bridge.adoptContext(makeCtxWithBroadcast(broadcast));

      const tool = getTool(tools, 'periph_camera_snap');
      const snapPromise = tool.execute('t1', { device_id: dev.id });

      await Promise.resolve();
      const requestId = broadcast.mock.calls[0]?.[1]?.requestId as string;
      bridge.resolveCapture(requestId, { ok: true, path: `periph/${dev.id}/missing.jpg`, width: 640, height: 480 });

      const result = (await snapPromise) as { content: Array<{ type: string; text?: string }> };
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text!).frame_path).toBe(`periph/${dev.id}/missing.jpg`);
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
