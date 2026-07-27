/**
 * periph-three-scenario-e2e.test.ts — SPEC §15 [v1.3 三场景扩展] 真实端到端验收 harness
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────────
 * 既有的 periph-rtsp / periph-local-camera / periph-rtsp-preview 测试只验到
 * **driver 函数层**(captureRtspFrame / captureLocalCameraFrame /
 * RtspPreviewManager),而 §15 v1.3 的验收口径是「场景可用」。本文件把三条链路
 * 各跑一次 **贯穿全链路** 的真路径:
 *
 *   场景① IP 摄像头(RTSP):真 MediaMTX(docker)+ 真 ffmpeg 推流
 *          → **periph_camera_snap 工具本身**(不是直接调 driver)
 *          → 真 PeriphService → 真 SQLite 文件库 → 真 JPEG 帧文件
 *   场景② USB webcam(local-camera):真 ffmpeg 设备枚举(avfoundation)
 *          → periph_camera_snap(driver='local-camera')全链路
 *          (macOS TCC 未授权时**默认失败**;只有 token 恰为 timeout 且跑测者显式
 *           带上 RC_PERIPH_E2E_ALLOW_BLOCKED=1,才按「零残留 + 零孤儿进程」验收并
 *           标记为外部条件阻塞。device-not-found / capture-failed /
 *           unsupported-platform / ffmpeg-missing 都是实现缺陷,不许洗成阻塞)
 *   场景③ 浏览器播放(RTSP→HLS):RtspPreviewManager 真 ffmpeg transmux
 *          → 真 http.Server 挂 createRtspPreviewRouteHandler(index.ts 同一工厂)
 *          → Bearer 取 playlist / segment → ffprobe 断言 segment 里真有 h264
 *          → stop() 后进程消失 + 目录删除;H6 预览与单帧抓证解耦
 *
 * ── 门控 ─────────────────────────────────────────────────────────────────────
 * 仅当 RC_PERIPH_E2E==='1' 时真跑(需要 docker + ffmpeg/ffprobe)。默认套件里
 * 整体 skip,不拖慢也不污染常规回归。一键入口:scripts/periph-e2e.sh
 *
 * ── 凭据纪律 ─────────────────────────────────────────────────────────────────
 * RTSP 账号/口令在 beforeAll 里**随机生成**,永不打印、永不写进 fixture/日志。
 * 断言口径:凭据只允许出现在 rc_periph_devices.config(SPEC §15-D8 裁决要点(3)
 * 明确「rtsp url + 凭据入 rc_periph_devices.config」),其余一切位置——工具返回
 * 值、console 输出、rc_periph_observations 全部行、帧文件路径、HLS 播放列表/
 * 段路径/HTTP URL——都不得出现。
 */

import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../db/migrations.js';
import { PeriphService } from '../periph/service.js';
import { PeriphBridge } from '../periph/bridge.js';
import { createPeriphTools } from '../periph/tools.js';
import { listLocalCameras } from '../periph/local-camera.js';
import { RtspPreviewManager, PREVIEW_PLAYLIST_NAME } from '../periph/rtsp-preview.js';
import { RTSP_PREVIEW_ROUTE } from '../periph/rpc.js';
import { createRtspPreviewRouteHandler } from '../../index.js';
import type { ToolDefinition } from '../types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

// ── Gate ──────────────────────────────────────────────────────────────────────

const E2E = process.env.RC_PERIPH_E2E === '1';
const describeE2E = E2E ? describe : describe.skip;

/**
 * 场景②「外部条件阻塞」分支的显式 opt-in 开关。
 *
 * 默认(未设置)口径下,只要 local-camera 抓帧没走到 GRANTED 全链路,用例一律
 * **失败**。理由:一个把非成功路径自动记成「外部阻塞」并仍然 PASS 的 harness,
 * 会把实现缺陷洗成环境问题,给不出可信结论。
 *
 * 只有跑测的人**先确认过**本机确实缺 macOS TCC 相机授权(或没有摄像头),才用
 * `RC_PERIPH_E2E_ALLOW_BLOCKED=1` 重跑;此时用例 PASS,但会打印 `[E2E-S2] BLOCKED`
 * 证据行,由 scripts/periph-e2e.sh 收敛为退出码 3 =「外部条件阻塞」——与「通过」
 * 的退出码 0 严格区分。
 */
const ALLOW_BLOCKED = process.env.RC_PERIPH_E2E_ALLOW_BLOCKED === '1';

// ── Binaries / knobs ──────────────────────────────────────────────────────────

const FFMPEG = process.env.RC_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.RC_FFPROBE_PATH || 'ffprobe';
const DOCKER = process.env.RC_DOCKER_PATH || 'docker';
const MTX_IMAGE = process.env.RC_PERIPH_E2E_MTX_IMAGE || 'bluenviron/mediamtx:latest';
const MTX_CONTAINER = process.env.RC_PERIPH_E2E_MTX_NAME || 'rc-periph-e2e-mtx';
/** 18554 (not the 8554 default) so a developer's own MediaMTX cannot collide. */
const MTX_PORT = Number(process.env.RC_PERIPH_E2E_RTSP_PORT || 18554);
const MTX_PATH = 'e2e';

/** Ephemeral, per-run RTSP credentials. NEVER logged. */
const RTSP_USER = `u${randomUUID().slice(0, 8)}`;
const RTSP_PASS = `p${randomUUID().replace(/-/g, '').slice(0, 16)}`;

function rtspUrlWithCreds(): string {
  return `rtsp://${RTSP_USER}:${RTSP_PASS}@127.0.0.1:${MTX_PORT}/${MTX_PATH}`;
}

// ── Small process helpers ─────────────────────────────────────────────────────

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], timeoutMs = 30_000): RunResult {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when a process whose full command line contains `pattern` is alive. */
function processAlive(pattern: string): boolean {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout ?? '').trim().length > 0;
}

/** Wait until a TCP port accepts connections (MediaMTX readiness). */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        resolve(false);
      });
      sock.setTimeout(1_000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

/** ffprobe a media file → the first video stream's {width,height,codec}. */
function probeVideo(file: string): { width: number; height: number; codec: string } | null {
  const r = run(
    FFPROBE,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name',
      '-of', 'json',
      file,
    ],
    15_000,
  );
  try {
    const parsed = JSON.parse(r.stdout) as {
      streams?: Array<{ width?: number; height?: number; codec_name?: string }>;
    };
    const s = parsed.streams?.[0];
    if (!s || typeof s.width !== 'number' || typeof s.height !== 'number') return null;
    return { width: s.width, height: s.height, codec: s.codec_name ?? '' };
  } catch {
    return null;
  }
}

/** Capture everything written to console during `fn` (credential-leak assertions). */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const chunks: string[] = [];
  const sink = (...a: unknown[]) => {
    chunks.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  };
  const orig = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  console.log = sink as typeof console.log;
  console.error = sink as typeof console.error;
  console.warn = sink as typeof console.warn;
  console.info = sink as typeof console.info;
  console.debug = sink as typeof console.debug;
  try {
    const value = await fn();
    return { value, logs: chunks.join('\n') };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
    console.info = orig.info;
    console.debug = orig.debug;
  }
}

// ── Tool-result shape helpers (OC ToolDefinition contract) ────────────────────

interface ToolContentText {
  type: 'text';
  text: string;
}
interface ToolContentImage {
  type: 'image';
  data: string;
  mimeType: string;
}
type ToolContent = ToolContentText | ToolContentImage;
interface ToolResult {
  content: ToolContent[];
  details?: unknown;
}

function asToolResult(v: unknown): ToolResult {
  return v as ToolResult;
}
function textOf(v: unknown): string {
  const r = asToolResult(v);
  const t = r.content.find((c): c is ToolContentText => c.type === 'text');
  return t?.text ?? '';
}
function imageOf(v: unknown): ToolContentImage | undefined {
  const r = asToolResult(v);
  return r.content.find((c): c is ToolContentImage => c.type === 'image');
}
function getTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

// ── SQLite helpers ────────────────────────────────────────────────────────────

interface Harness {
  ws: string;
  dbFile: string;
  db: BetterSqlite3.Database;
  service: PeriphService;
  bridge: PeriphBridge;
  tools: ToolDefinition[];
  dispose: () => void;
}

/** A real on-disk SQLite database + a real workspace dir (no in-memory shortcut). */
function makeHarness(tag: string): Harness {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `rc-periph-e2e-${tag}-`));
  const dbFile = path.join(ws, 'rc.sqlite3');
  const db = new Database(dbFile);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const service = new PeriphService(db, { workspaceRoot: ws });
  const bridge = new PeriphBridge();
  const tools = createPeriphTools(service, bridge, { workspaceRoot: ws });
  return {
    ws,
    dbFile,
    db,
    service,
    bridge,
    tools,
    dispose: () => {
      try {
        db.close();
      } catch {
        /* noop */
      }
      fs.rmSync(ws, { recursive: true, force: true });
    },
  };
}

/** Every user table's rows, keyed by table name (credential-scan surface). */
function dumpAllTables(db: BetterSqlite3.Database): Record<string, unknown[]> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    out[t.name] = db.prepare(`SELECT * FROM "${t.name}"`).all() as unknown[];
  }
  return out;
}

/**
 * Assert the RTSP credentials appear **only** in `rc_periph_devices.config`
 * (SPEC §15-D8 裁决要点(3): 凭据入 rc_periph_devices.config). The exemption is
 * that ONE column — not the whole device row: a credential echoed into
 * `last_error`, `name` or any sibling column is still a leak, and skipping the
 * row wholesale would hide exactly that.
 */
function assertCredentialsOnlyInDeviceConfig(db: BetterSqlite3.Database): void {
  const dump = dumpAllTables(db);
  for (const [table, rows] of Object.entries(dump)) {
    const scanned =
      table === 'rc_periph_devices'
        ? rows.map((row) => {
            const { config: _exempt, ...rest } = row as Record<string, unknown>;
            return rest;
          })
        : rows;
    const json = JSON.stringify(scanned);
    for (const [label, secret] of [
      ['password', RTSP_PASS],
      ['username', RTSP_USER],
    ] as const) {
      expect(
        json.includes(secret),
        `credential (${label}) leaked into SQLite table ${table}` +
          (table === 'rc_periph_devices' ? ' outside the exempt config column' : ''),
      ).toBe(false);
    }
  }
}

/** The frame path recorded by the tool, resolved to an absolute on-disk path. */
function resolveFrame(ws: string, framePath: string): string {
  return path.isAbsolute(framePath) ? framePath : path.resolve(ws, framePath);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared real RTSP source: MediaMTX (docker) + a looped H264 push.
//
// Recipe note (verified): pushing `-f lavfi testsrc` straight into RTSP makes the
// consumer fail with "Could not find codec parameters". Recording a stable H264
// file with a 2s GOP first and then `-stream_loop -1 -c copy` pushing it produces
// a source every RTSP client can open on the first DESCRIBE.
// ═══════════════════════════════════════════════════════════════════════════════

let srcDir = '';
let pushProc: ChildProcess | null = null;
let sourceReady = false;

function dockerRmMtx(): void {
  run(DOCKER, ['rm', '-f', MTX_CONTAINER], 30_000);
}

async function startRtspSource(): Promise<void> {
  sourceReady = false;
  // Idempotent: drop any container left behind by an aborted run.
  dockerRmMtx();

  const runRes = run(
    DOCKER,
    [
      'run', '-d', '--rm',
      '--name', MTX_CONTAINER,
      '-p', `${MTX_PORT}:8554`,
      '-e', 'MTX_RTSPADDRESS=:8554',
      // Internal auth ON: an anonymous DESCRIBE must get 401, so the credential
      // path is genuinely exercised (not a no-op against an open server).
      '-e', `MTX_AUTHINTERNALUSERS_0_USER=${RTSP_USER}`,
      '-e', `MTX_AUTHINTERNALUSERS_0_PASS=${RTSP_PASS}`,
      '-e', 'MTX_AUTHINTERNALUSERS_0_IPS=',
      '-e', 'MTX_AUTHINTERNALUSERS_0_PERMISSIONS_0_ACTION=publish',
      '-e', 'MTX_AUTHINTERNALUSERS_0_PERMISSIONS_1_ACTION=read',
      MTX_IMAGE,
    ],
    120_000,
  );
  if (runRes.status !== 0) {
    throw new Error(`docker run mediamtx failed (status=${runRes.status})`);
  }

  const up = await waitForPort(MTX_PORT, 30_000);
  if (!up) throw new Error(`MediaMTX did not open port ${MTX_PORT}`);

  // 1) Record a stable H264 file (2s GOP) — see recipe note above.
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-periph-e2e-src-'));
  const srcFile = path.join(srcDir, 'src.mp4');
  const rec = run(
    FFMPEG,
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30',
      '-t', '8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-g', '60', '-keyint_min', '60', '-pix_fmt', 'yuv420p',
      '-y', srcFile,
    ],
    120_000,
  );
  if (rec.status !== 0 || !fs.existsSync(srcFile)) {
    throw new Error(`ffmpeg could not record the H264 source (status=${rec.status})`);
  }

  // 2) Loop-push it (copy, no re-encode) into MediaMTX.
  pushProc = spawn(
    FFMPEG,
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-re', '-stream_loop', '-1', '-i', srcFile,
      '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp',
      rtspUrlWithCreds(),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  pushProc.stderr?.on('data', () => {
    /* discarded — the push URL carries credentials, never echo it */
  });

  // 3) Wait until a plain ffmpeg client can actually pull a frame.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-periph-e2e-probe-'));
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const out = path.join(probeDir, `${randomUUID()}.jpg`);
      const p = run(
        FFMPEG,
        [
          '-nostdin', '-hide_banner', '-loglevel', 'error',
          '-rtsp_transport', 'tcp', '-i', rtspUrlWithCreds(),
          '-frames:v', '1', '-f', 'image2', '-y', out,
        ],
        20_000,
      );
      if (p.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
        sourceReady = true;
        break;
      }
      await sleep(1_000);
    }
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
  if (!sourceReady) throw new Error('RTSP source never became readable');
}

function stopRtspSource(): void {
  if (pushProc) {
    try {
      pushProc.kill('SIGKILL');
    } catch {
      /* noop */
    }
    pushProc = null;
  }
  dockerRmMtx();
  if (srcDir) {
    fs.rmSync(srcDir, { recursive: true, force: true });
    srcDir = '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 场景① IP 摄像头(RTSP)全链路
// ═══════════════════════════════════════════════════════════════════════════════

describeE2E('[E2E-S1] 场景① IP 摄像头(RTSP)— 工具→服务→SQLite→帧文件 全链路', () => {
  let h: Harness;

  beforeAll(async () => {
    await startRtspSource();
    h = makeHarness('s1');
  }, 240_000);

  afterAll(() => {
    h?.dispose();
    stopRtspSource();
  });

  it(
    'periph_camera_snap(driver=rtsp) 返回 ImageContent + 落库 + 帧文件是真 JPEG(ffprobe 可解真实分辨率)',
    async () => {
      const dev = h.service.createDevice({
        name: 'E2E IP Camera',
        kind: 'camera',
        driver: 'rtsp',
        // SPEC §15-D8(3): rtsp url + 凭据入 rc_periph_devices.config
        config: { url: rtspUrlWithCreds() },
      });

      const snap = getTool(h.tools, 'periph_camera_snap');
      const { value: result, logs } = await captureConsole(() =>
        snap.execute('e2e-s1', { device_id: dev.id, purpose: 'e2e scenario 1' }) as Promise<unknown>,
      );

      const text = textOf(result);
      expect(text, `snap failed: ${text}`).not.toContain('Error:');

      // (a) OC 工具结果契约:content 数组里有 ImageContent
      const img = imageOf(result);
      expect(img, 'periph_camera_snap 未返回 ImageContent(模型看不到画面)').toBeDefined();
      expect(img!.type).toBe('image');
      expect(img!.mimeType).toBe('image/jpeg');
      expect(img!.data.length).toBeGreaterThan(0);
      // base64 且解码后即是 JPEG(不是占位/空串)
      const decoded = Buffer.from(img!.data, 'base64');
      expect(decoded[0]).toBe(0xff);
      expect(decoded[1]).toBe(0xd8);

      // (b) SQLite 真多出一行,frame_path 指向真实存在的文件
      const rows = h.db
        .prepare('SELECT * FROM rc_periph_observations WHERE device_id = ?')
        .all(dev.id) as Array<{ frame_path: string | null; kind: string; verdict: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('snapshot');
      expect(rows[0].verdict).toBe('info');
      expect(rows[0].frame_path).toBeTruthy();
      const abs = resolveFrame(h.ws, rows[0].frame_path!);
      expect(fs.existsSync(abs), `frame file missing: ${abs}`).toBe(true);

      // (c) JPEG magic + ffprobe 真实分辨率
      const fd = fs.openSync(abs, 'r');
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      expect(head[0]).toBe(0xff);
      expect(head[1]).toBe(0xd8);

      const probed = probeVideo(abs);
      expect(probed, 'ffprobe could not parse the frame').not.toBeNull();
      expect(probed!.width).toBeGreaterThan(0);
      expect(probed!.height).toBeGreaterThan(0);

      // (d) 凭据边界:结果 / console / 观测行 / 帧路径都不含凭据
      const resultJson = JSON.stringify(result);
      expect(resultJson.includes(RTSP_PASS)).toBe(false);
      expect(resultJson.includes(RTSP_USER)).toBe(false);
      expect(logs.includes(RTSP_PASS)).toBe(false);
      expect(logs.includes(RTSP_USER)).toBe(false);
      expect(rows[0].frame_path!.includes(RTSP_PASS)).toBe(false);
      assertCredentialsOnlyInDeviceConfig(h.db);

      const bytes = fs.statSync(abs).size;
      // eslint-disable-next-line no-console
      console.log(
        `[E2E-S1] frame=${abs} bytes=${bytes} res=${probed!.width}x${probed!.height} ` +
          `codec=${probed!.codec} inlineB64=${img!.data.length} obsRows=${rows.length}`,
      );
    },
    120_000,
  );

  it(
    '错误口令 → 分类 token(不泄露凭据/stderr),观测记 error,无残留帧',
    async () => {
      const badUrl = `rtsp://${RTSP_USER}:wrong-${RTSP_PASS}@127.0.0.1:${MTX_PORT}/${MTX_PATH}`;
      const dev = h.service.createDevice({
        name: 'E2E IP Camera (bad creds)',
        kind: 'camera',
        driver: 'rtsp',
        config: { url: badUrl },
      });

      const snap = getTool(h.tools, 'periph_camera_snap');
      const { value: result, logs } = await captureConsole(() =>
        snap.execute('e2e-s1b', { device_id: dev.id }) as Promise<unknown>,
      );

      const text = textOf(result);
      expect(text).toContain('Error:');
      // 固定分类 token,不是原始 stderr
      const payload = JSON.parse(text.replace(/^Error:\s*/, '')) as { error: string };
      expect(['auth-failed', 'connect-failed', 'timeout', 'decode-failed']).toContain(payload.error);

      const rows = h.db
        .prepare('SELECT * FROM rc_periph_observations WHERE device_id = ?')
        .all(dev.id) as Array<{ verdict: string; frame_path: string | null; summary: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].verdict).toBe('error');
      expect(rows[0].frame_path).toBeNull();
      expect(rows[0].summary.includes(RTSP_PASS)).toBe(false);

      // 失败路径不留半截帧
      const frameDir = h.service.frameDirFor(dev.id);
      const residue = fs.existsSync(frameDir)
        ? fs.readdirSync(frameDir).filter((f) => f.endsWith('.jpg'))
        : [];
      expect(residue).toHaveLength(0);

      expect(JSON.stringify(result).includes(RTSP_PASS)).toBe(false);
      expect(logs.includes(RTSP_PASS)).toBe(false);

      // eslint-disable-next-line no-console
      console.log(
        `[E2E-S1] authFailure token=${payload.error} verdict=${rows[0].verdict} residueFrames=${residue.length}`,
      );
    },
    120_000,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 场景② USB webcam(local-camera)全链路
// ═══════════════════════════════════════════════════════════════════════════════

describeE2E('[E2E-S2] 场景② USB webcam(local-camera)— 真实枚举 + 工具全链路', () => {
  let h: Harness;

  beforeAll(() => {
    h = makeHarness('s2');
  });

  afterAll(() => {
    h?.dispose();
  });

  it(
    '真实 ffmpeg 设备枚举(darwin: avfoundation)返回可用设备数组',
    async () => {
      const cams = await listLocalCameras();
      expect(Array.isArray(cams)).toBe(true);
      for (const c of cams) {
        expect(typeof c.device).toBe('string');
        expect(typeof c.label).toBe('string');
        expect(c.label.length).toBeGreaterThan(0);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[E2E-S2] enumerate platform=${process.platform} count=${cams.length} ` +
          `devices=${JSON.stringify(cams)}`,
      );
    },
    60_000,
  );

  it(
    'periph_camera_snap(driver=local-camera) 全链路 — 已授权则验帧,被 TCC 阻塞则验超时回收/零残留/零孤儿',
    async () => {
      const cams = await listLocalCameras();
      const target = cams[0]?.device ?? '0';

      const dev = h.service.createDevice({
        name: 'E2E USB Webcam',
        kind: 'camera',
        driver: 'local-camera',
        config: { device: target },
      });

      const snap = getTool(h.tools, 'periph_camera_snap');
      const started = Date.now();
      const { value: result, logs } = await captureConsole(() =>
        snap.execute('e2e-s2', { device_id: dev.id, purpose: 'e2e scenario 2' }) as Promise<unknown>,
      );
      const elapsed = Date.now() - started;

      const text = textOf(result);
      const rows = h.db
        .prepare('SELECT * FROM rc_periph_observations WHERE device_id = ?')
        .all(dev.id) as Array<{ frame_path: string | null; kind: string; verdict: string }>;
      expect(rows).toHaveLength(1);

      // 无论走哪条分支,都不得留下孤儿 ffmpeg(用本 workspace 的唯一目录名匹配)
      const wsMarker = path.basename(h.ws);
      expect(processAlive(wsMarker), 'orphan ffmpeg still holding the camera').toBe(false);

      if (!text.startsWith('Error:')) {
        // ── 已授权:与场景① 同样的 a/b/c 全链路断言 ──
        const img = imageOf(result);
        expect(img, 'local-camera snap 未返回 ImageContent').toBeDefined();
        expect(img!.mimeType).toBe('image/jpeg');
        const decoded = Buffer.from(img!.data, 'base64');
        expect(decoded[0]).toBe(0xff);
        expect(decoded[1]).toBe(0xd8);

        expect(rows[0].kind).toBe('snapshot');
        expect(rows[0].verdict).toBe('info');
        expect(rows[0].frame_path).toBeTruthy();
        const abs = resolveFrame(h.ws, rows[0].frame_path!);
        expect(fs.existsSync(abs)).toBe(true);

        const head = fs.readFileSync(abs).subarray(0, 2);
        expect(head[0]).toBe(0xff);
        expect(head[1]).toBe(0xd8);

        const probed = probeVideo(abs);
        expect(probed).not.toBeNull();
        expect(probed!.width).toBeGreaterThan(0);
        expect(probed!.height).toBeGreaterThan(0);

        // eslint-disable-next-line no-console
        console.log(
          `[E2E-S2] GRANTED device=${target} frame=${abs} bytes=${fs.statSync(abs).size} ` +
            `res=${probed!.width}x${probed!.height} inlineB64=${img!.data.length} obsRows=${rows.length} elapsedMs=${elapsed}`,
        );
      } else {
        // ── 非 GRANTED 路径 ────────────────────────────────────────────────
        // 这是整个 harness 最容易「把实现缺陷洗成外部阻塞」的地方,所以口径收紧
        // 到两道闸,任一不过即判失败:
        //
        //  (1) token 白名单只留 `timeout`。macOS TCC 未授权的真实表现是 ffmpeg
        //      拿不到画面、挂起到看门狗超时。而
        //        device-not-found     → config.device 解析/枚举错(实现缺陷)
        //        capture-failed       → ffmpeg 参数写错(实现缺陷)
        //        ffmpeg-missing       → 前置条件检查漏了(harness 缺陷)
        //        unsupported-platform → 平台分支漏写(实现缺陷)
        //      这四类一个都不许冒充 TCC 阻塞。
        //
        //  (2) 即使拿到 timeout,也必须由跑测的人显式 opt-in
        //      (RC_PERIPH_E2E_ALLOW_BLOCKED=1)才承认为外部条件阻塞。默认口径
        //      下直接失败,杜绝「静默降级为阻塞、场景照样报通过」。
        const payload = JSON.parse(text.replace(/^Error:\s*/, '')) as { error: string };

        expect(
          payload.error,
          `local-camera 抓帧返回 '${payload.error}',这是实现缺陷的特征token` +
            `(device 解析 / ffmpeg 参数 / 平台分支 / 前置检查),不是 macOS TCC 授权阻塞;` +
            `TCC 阻塞只会表现为 'timeout'`,
        ).toBe('timeout');

        expect(
          ALLOW_BLOCKED,
          '摄像头抓帧超时,疑似 macOS TCC 相机授权缺失。请先人工确认确属外部条件' +
            '(系统设置未授权 / 无摄像头),再用 RC_PERIPH_E2E_ALLOW_BLOCKED=1 重跑;' +
            '届时结论口径为「外部条件阻塞」(脚本退出码 3),不是「通过」',
        ).toBe(true);

        // 分类 token,不泄露原始 stderr/路径
        expect(text).not.toContain('avfoundation');
        expect(text).not.toContain(h.ws);
        expect(logs).not.toContain(h.ws);

        expect(rows[0].verdict).toBe('error');
        expect(rows[0].frame_path).toBeNull();

        const frameDir = h.service.frameDirFor(dev.id);
        const residue = fs.existsSync(frameDir)
          ? fs.readdirSync(frameDir).filter((f) => f.endsWith('.jpg'))
          : [];
        expect(residue, 'timeout/failure left a temp frame behind').toHaveLength(0);

        // eslint-disable-next-line no-console
        console.log(
          `[E2E-S2] BLOCKED device=${target} token=${payload.error} verdict=${rows[0].verdict} ` +
            `residueFrames=${residue.length} orphanFfmpeg=false elapsedMs=${elapsed} ` +
            `(external blocker: macOS TCC camera authorization)`,
        );
      }
    },
    120_000,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 场景③ 浏览器播放(RTSP→HLS)全链路
// ═══════════════════════════════════════════════════════════════════════════════

const E2E_GATEWAY_PASSWORD = `gw-${randomUUID().slice(0, 12)}`;

function gatewayAuthOk(req: http.IncomingMessage): boolean {
  const bearer = req.headers['authorization'];
  return typeof bearer === 'string' && bearer === `Bearer ${E2E_GATEWAY_PASSWORD}`;
}

describeE2E('[E2E-S3] 场景③ 浏览器播放(RTSP→HLS)— transmux→真 HTTP→ffprobe 真视频', () => {
  let h: Harness;
  let manager: RtspPreviewManager | null = null;
  let server: http.Server | null = null;
  let base = '';
  let previewBaseDir = '';

  beforeAll(async () => {
    await startRtspSource();
    h = makeHarness('s3');
    previewBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-periph-e2e-preview-'));
    manager = new RtspPreviewManager({ baseDir: previewBaseDir, sweepIntervalMs: 60_000 });

    // 真 http.Server + index.ts 用的同一个路由工厂 + gateway Bearer 门
    const handler = createRtspPreviewRouteHandler({
      getByToken: (token) => manager!.getByToken(token),
      touch: (token) => manager!.touch(token),
    });
    server = http.createServer((req, res) => {
      if (!gatewayAuthOk(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED' } }));
        return;
      }
      if ((req.url ?? '').startsWith(RTSP_PREVIEW_ROUTE)) {
        void handler(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server!.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  }, 240_000);

  afterAll(async () => {
    if (manager) await manager.destroy();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (previewBaseDir) fs.rmSync(previewBaseDir, { recursive: true, force: true });
    h?.dispose();
    stopRtspSource();
  });

  it(
    'start→真 ffmpeg transmux→Bearer 取 playlist/segment→ffprobe 解出 h264;H6 预览期间单帧抓证仍成功;stop 后进程与目录都消失',
    async () => {
      const dev = h.service.createDevice({
        name: 'E2E Preview Camera',
        kind: 'camera',
        driver: 'rtsp',
        config: { url: rtspUrlWithCreds() },
      });

      const session = await manager!.start(dev.id, {
        url: rtspUrlWithCreds(),
        readyTimeoutMs: 30_000,
      });
      expect(session.sessionToken).toBeTruthy();
      // H4: token 不是 URL 映射,绝不含凭据
      expect(session.sessionToken.includes(RTSP_PASS)).toBe(false);
      expect(session.dir.includes(RTSP_PASS)).toBe(false);

      const authHeaders = { authorization: `Bearer ${E2E_GATEWAY_PASSWORD}` };
      const playlistUrl = `${base}${RTSP_PREVIEW_ROUTE}/${session.sessionToken}/${PREVIEW_PLAYLIST_NAME}`;

      // H3: 未鉴权拒绝
      const anon = await fetch(playlistUrl);
      expect(anon.status).toBe(401);

      // playlist 是真 #EXTM3U 且引用真 .ts
      const plRes = await fetch(playlistUrl, { headers: authHeaders });
      expect(plRes.status).toBe(200);
      expect(plRes.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
      const playlist = await plRes.text();
      expect(playlist.startsWith('#EXTM3U')).toBe(true);
      const segNames = playlist
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#') && l.endsWith('.ts'));
      expect(segNames.length).toBeGreaterThan(0);
      // H4: 播放列表里不得出现凭据
      expect(playlist.includes(RTSP_PASS)).toBe(false);
      expect(playlist.includes(RTSP_USER)).toBe(false);

      // segment: 首字节 0x47(MPEG-TS sync) + ffprobe 解出真 h264 视频流
      const segUrl = `${base}${RTSP_PREVIEW_ROUTE}/${session.sessionToken}/${segNames[0]}`;
      const segRes = await fetch(segUrl, { headers: authHeaders });
      expect(segRes.status).toBe(200);
      expect(segRes.headers.get('content-type')).toBe('video/mp2t');
      const segBuf = Buffer.from(await segRes.arrayBuffer());
      expect(segBuf.length).toBeGreaterThan(0);
      expect(segBuf[0]).toBe(0x47);

      const segTmp = path.join(previewBaseDir, `probe-${randomUUID()}.ts`);
      fs.writeFileSync(segTmp, segBuf);
      const segProbe = probeVideo(segTmp);
      fs.rmSync(segTmp, { force: true });
      expect(segProbe, 'ffprobe found no video stream in the HLS segment').not.toBeNull();
      expect(segProbe!.codec).toBe('h264');
      expect(segProbe!.width).toBeGreaterThan(0);
      expect(segProbe!.height).toBeGreaterThan(0);

      // H3: 目录穿越 / 非白名单扩展被拒
      const traversal = await fetch(
        `${base}${RTSP_PREVIEW_ROUTE}/${session.sessionToken}/${encodeURIComponent('../../etc/passwd')}`,
        { headers: authHeaders },
      );
      expect([400, 403, 404]).toContain(traversal.status);
      const badExt = await fetch(
        `${base}${RTSP_PREVIEW_ROUTE}/${session.sessionToken}/.env`,
        { headers: authHeaders },
      );
      expect(badExt.status).toBe(403);

      // ── H6:预览 session 活跃期间,单帧抓证仍成功且互不影响 ──
      const snap = getTool(h.tools, 'periph_camera_snap');
      const snapResult = await snap.execute('e2e-s3-h6', {
        device_id: dev.id,
        purpose: 'h6 decoupling',
      });
      const snapText = textOf(snapResult);
      expect(snapText, `H6 snap failed while preview live: ${snapText}`).not.toContain('Error:');
      const snapImg = imageOf(snapResult);
      expect(snapImg, 'H6 snap 未返回 ImageContent').toBeDefined();

      const obsRows = h.db
        .prepare('SELECT * FROM rc_periph_observations WHERE device_id = ?')
        .all(dev.id) as Array<{ frame_path: string | null }>;
      expect(obsRows).toHaveLength(1);
      const snapAbs = resolveFrame(h.ws, obsRows[0].frame_path!);
      expect(fs.existsSync(snapAbs)).toBe(true);

      // 预览仍然活着(抓证没有把它踢掉)
      expect(manager!.sessionCount).toBe(1);
      const afterPl = await fetch(playlistUrl, { headers: authHeaders });
      expect(afterPl.status).toBe(200);

      // 凭据只在 device config
      assertCredentialsOnlyInDeviceConfig(h.db);

      const sessionDir = session.dir;
      const ffmpegAliveBefore = processAlive(session.sessionToken);
      expect(ffmpegAliveBefore, 'transmux ffmpeg should be running while previewing').toBe(true);

      // eslint-disable-next-line no-console
      console.log(
        `[E2E-S3] playlistBytes=${playlist.length} segments=${segNames.length} ` +
          `segBytes=${segBuf.length} segFirstByte=0x${segBuf[0].toString(16)} ` +
          `segCodec=${segProbe!.codec} res=${segProbe!.width}x${segProbe!.height} ` +
          `h6SnapFrame=${snapAbs} h6ObsRows=${obsRows.length} ffmpegAlive=${ffmpegAliveBefore}`,
      );

      // ── stop:ffmpeg 消失 + session 目录删除 ──
      const stopped = await manager!.stop(dev.id);
      expect(stopped).toBe(true);

      // 给 OS 一点时间回收
      for (let i = 0; i < 20 && processAlive(session.sessionToken); i++) {
        await sleep(250);
      }
      const ffmpegAliveAfter = processAlive(session.sessionToken);
      expect(ffmpegAliveAfter, 'orphan transmux ffmpeg survived stop()').toBe(false);
      expect(fs.existsSync(sessionDir), 'session temp dir survived stop()').toBe(false);
      expect(manager!.sessionCount).toBe(0);

      // stop 后旧 token 不再可用
      const afterStop = await fetch(playlistUrl, { headers: authHeaders });
      expect(afterStop.status).toBe(404);

      // eslint-disable-next-line no-console
      console.log(
        `[E2E-S3] afterStop ffmpegAlive=${ffmpegAliveAfter} sessionDirExists=${fs.existsSync(sessionDir)} ` +
          `sessionCount=${manager!.sessionCount} staleTokenStatus=${afterStop.status}`,
      );
    },
    240_000,
  );
});
