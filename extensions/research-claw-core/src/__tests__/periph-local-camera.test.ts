/**
 * periph-local-camera.test.ts — local-camera driver (§15 v1.3 场景②).
 *
 * Deterministic subset (no real webcam needed):
 *  - buildLocalCameraInputArgs: platform branching + injection safety (device
 *    with shell metacharacters stays ONE array element, never a shell string).
 *  - classifyLocalCameraFailure: device-not-found vs capture-failed tokens.
 *  - isJpegMagic: SOI 0xFFD8.
 *  - parseLocalCameraList: real avfoundation/dshow stderr fixtures, stops at the
 *    audio section (never lists mics/screens as cameras).
 *  - captureLocalCameraFrame:
 *      · unsupported platform → 'unsupported-platform', NO ffmpeg spawn.
 *      · ffmpeg-missing (RC_FFMPEG_PATH → nonexistent binary).
 *      · timeout → 'timeout' + temp file cleaned up.
 *      · failure classification + temp cleanup with a fake ffmpeg that writes
 *        nothing / an empty file / a non-JPEG.
 *  - listLocalCameras: parses a fake ffmpeg's stderr; [] when ffmpeg missing.
 *
 * Real-webcam E2E (gated on RC_LOCALCAM_E2E=1 && darwin && ffmpeg present):
 *  - captureLocalCameraFrame({device:'0'}) grabs a real frame → ok + JPEG magic.
 *    Skips gracefully if the camera is absent / permission is denied.
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  captureLocalCameraFrame,
  listLocalCameras,
  buildLocalCameraInputArgs,
  classifyLocalCameraFailure,
  parseLocalCameraList,
  isJpegMagic,
  LOCAL_CAMERA_DEFAULT_TIMEOUT_MS,
} from '../periph/local-camera.js';

// ── Fixtures: real ffmpeg -list_devices stderr ───────────────────────────────

// Captured verbatim from `ffmpeg -f avfoundation -list_devices true -i ""`
// (ffmpeg 8.1.1, macOS). Note the audio section MUST NOT leak into the camera
// list, and "Capture screen 0" IS a legitimate avfoundation video device.
const AVFOUNDATION_STDERR = [
  '[AVFoundation indev @ 0xa3d010140] AVFoundation video devices:',
  '[AVFoundation indev @ 0xa3d010140] [0] FaceTime HD Camera',
  '[AVFoundation indev @ 0xa3d010140] [1] Capture screen 0',
  '[AVFoundation indev @ 0xa3d010140] AVFoundation audio devices:',
  '[AVFoundation indev @ 0xa3d010140] [0] MacBook Pro Microphone',
  '[AVFoundation indev @ 0xa3d010140] [1] Microsoft Teams Audio',
  '[in#0 @ 0xa3d010000] Error opening input: Input/output error',
].join('\n');

// Representative dshow -list_devices stderr (Windows). Friendly name in quotes,
// followed by an "Alternative name" companion line we must skip.
const DSHOW_STDERR = [
  '[dshow @ 000001] DirectShow video devices (some may be both video and audio devices)',
  '[dshow @ 000001]  "Integrated Webcam"',
  '[dshow @ 000001]     Alternative name "@device_pnp_\\\\?\\usb#vid_0000"',
  '[dshow @ 000001]  "USB Video Device"',
  '[dshow @ 000001]     Alternative name "@device_pnp_\\\\?\\usb#vid_1111"',
  '[dshow @ 000001] DirectShow audio devices',
  '[dshow @ 000001]  "Microphone (Realtek Audio)"',
  '[dshow @ 000001]     Alternative name "@device_cm_{guid}"',
].join('\n');

// ── A fake ffmpeg helper: a tiny node script we spawn as RC_FFMPEG_PATH ──────
// Because captureLocalCameraFrame only spawns on darwin/win32, the fake-ffmpeg
// spawn tests run on those platforms. On other CI platforms they self-skip.

const runnablePlatform = process.platform === 'darwin' || process.platform === 'win32';

/** Write a fake-ffmpeg node script that, given -y <outPath> as its last two
 *  args, performs `behavior` (write jpeg / write empty / write garbage / nothing)
 *  and exits with `exitCode`, printing `stderr` to stderr. */
function writeFakeFfmpeg(
  dir: string,
  opts: { behavior: 'jpeg' | 'empty' | 'garbage' | 'nothing'; exitCode: number; stderr?: string },
): string {
  const scriptPath = path.join(dir, 'fake-ffmpeg.mjs');
  const script = `
import * as fs from 'node:fs';
const argv = process.argv.slice(2);
const yi = argv.lastIndexOf('-y');
const out = yi >= 0 ? argv[yi + 1] : null;
if (${JSON.stringify(opts.stderr ?? '')}) process.stderr.write(${JSON.stringify(opts.stderr ?? '')});
const behavior = ${JSON.stringify(opts.behavior)};
if (out) {
  if (behavior === 'jpeg') fs.writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  else if (behavior === 'empty') fs.writeFileSync(out, Buffer.alloc(0));
  else if (behavior === 'garbage') fs.writeFileSync(out, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  // 'nothing' → write no file at all
}
process.exit(${opts.exitCode});
`;
  fs.writeFileSync(scriptPath, script, 'utf8');
  return scriptPath;
}

/** A shell wrapper so RC_FFMPEG_PATH is a single executable that runs node on
 *  our script. On darwin we write a chmod+x shell shim; captureLocalCameraFrame
 *  spawns it with shell:false but an executable shim works fine. */
function writeFfmpegShim(dir: string, scriptPath: string): string {
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'fake-ffmpeg.cmd');
    fs.writeFileSync(shim, `@echo off\r\nnode "${scriptPath}" %*\r\n`, 'utf8');
    return shim;
  }
  const shim = path.join(dir, 'fake-ffmpeg.sh');
  fs.writeFileSync(shim, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, 'utf8');
  fs.chmodSync(shim, 0o755);
  return shim;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('local-camera driver', () => {
  let tmpDir: string;
  const savedFfmpeg = process.env.RC_FFMPEG_PATH;
  const savedFfprobe = process.env.RC_FFPROBE_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'periph-localcam-'));
  });

  afterEach(() => {
    if (savedFfmpeg === undefined) delete process.env.RC_FFMPEG_PATH;
    else process.env.RC_FFMPEG_PATH = savedFfmpeg;
    if (savedFfprobe === undefined) delete process.env.RC_FFPROBE_PATH;
    else process.env.RC_FFPROBE_PATH = savedFfprobe;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── buildLocalCameraInputArgs ────────────────────────────────────────────

  describe('buildLocalCameraInputArgs', () => {
    it('darwin → avfoundation input with device as a single arg', () => {
      expect(buildLocalCameraInputArgs('darwin', '0')).toEqual([
        '-f', 'avfoundation', '-framerate', '30', '-i', '0',
      ]);
    });

    it("darwin → supports 'index:none' (video-only) verbatim", () => {
      const args = buildLocalCameraInputArgs('darwin', '0:none');
      expect(args).toEqual(['-f', 'avfoundation', '-framerate', '30', '-i', '0:none']);
    });

    it('win32 → dshow input with video=<name> as a single arg', () => {
      expect(buildLocalCameraInputArgs('win32', 'Integrated Webcam')).toEqual([
        '-f', 'dshow', '-i', 'video=Integrated Webcam',
      ]);
    });

    it('other platform → null (unsupported)', () => {
      expect(buildLocalCameraInputArgs('linux', '0')).toBeNull();
    });

    it('SECURITY: shell metacharacters in device stay ONE literal arg (no split)', () => {
      const evil = '0; rm -rf ~ && echo $(whoami)`id`';
      const dar = buildLocalCameraInputArgs('darwin', evil)!;
      // The device is exactly one element; nothing is split on ; & $ ` spaces.
      expect(dar[dar.length - 1]).toBe(evil);
      expect(dar.filter((a) => a === evil)).toHaveLength(1);

      const win = buildLocalCameraInputArgs('win32', evil)!;
      // dshow prefixes video=, still ONE element carrying the whole payload.
      expect(win[win.length - 1]).toBe(`video=${evil}`);
    });
  });

  // ── classifyLocalCameraFailure ───────────────────────────────────────────

  describe('classifyLocalCameraFailure', () => {
    it("maps 'does not exist' → device-not-found", () => {
      expect(classifyLocalCameraFailure('Selected video device does not exist')).toBe('device-not-found');
    });

    it("maps 'no such device' → device-not-found", () => {
      expect(classifyLocalCameraFailure('avfoundation: no such device index 9')).toBe('device-not-found');
    });

    it('maps unknown/permission/other stderr → capture-failed', () => {
      expect(classifyLocalCameraFailure('Operation not permitted')).toBe('capture-failed');
      expect(classifyLocalCameraFailure('')).toBe('capture-failed');
      expect(classifyLocalCameraFailure('some decode blah')).toBe('capture-failed');
    });
  });

  // ── isJpegMagic ──────────────────────────────────────────────────────────

  describe('isJpegMagic', () => {
    it('accepts 0xFFD8 SOI', () => {
      expect(isJpegMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    });
    it('rejects non-JPEG / too-short buffers', () => {
      expect(isJpegMagic(Buffer.from([0x89, 0x50]))).toBe(false);
      expect(isJpegMagic(Buffer.from([0xff]))).toBe(false);
      expect(isJpegMagic(Buffer.alloc(0))).toBe(false);
    });
  });

  // ── parseLocalCameraList ─────────────────────────────────────────────────

  describe('parseLocalCameraList', () => {
    it('darwin: lists video devices with index+label, stops at the audio section', () => {
      const cams = parseLocalCameraList('darwin', AVFOUNDATION_STDERR);
      expect(cams).toEqual([
        { device: '0', label: 'FaceTime HD Camera' },
        { device: '1', label: 'Capture screen 0' },
      ]);
      // Microphones from the audio section must NOT appear.
      expect(cams.some((c) => /Microphone/i.test(c.label))).toBe(false);
    });

    it('win32: lists dshow friendly names, skips "Alternative name" + audio', () => {
      const cams = parseLocalCameraList('win32', DSHOW_STDERR);
      expect(cams).toEqual([
        { device: 'Integrated Webcam', label: 'Integrated Webcam' },
        { device: 'USB Video Device', label: 'USB Video Device' },
      ]);
      expect(cams.some((c) => /Realtek|Microphone/i.test(c.label))).toBe(false);
    });

    it('returns [] for empty / unparseable / unsupported-platform stderr', () => {
      expect(parseLocalCameraList('darwin', '')).toEqual([]);
      expect(parseLocalCameraList('darwin', 'garbage with no sections')).toEqual([]);
      expect(parseLocalCameraList('linux', AVFOUNDATION_STDERR)).toEqual([]);
    });
  });

  // ── captureLocalCameraFrame — unsupported platform (any host) ─────────────

  it('unsupported platform → error=unsupported-platform (no spawn)', async () => {
    // Force the platform to an unsupported value for this call only.
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const res = await captureLocalCameraFrame({ device: '0', outDir: tmpDir });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('unsupported-platform');
      // No temp file should have been created.
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
  });

  // ── captureLocalCameraFrame — ffmpeg-missing (any darwin/win host) ─────────

  it.runIf(runnablePlatform)('ffmpeg-missing when the binary does not exist', async () => {
    process.env.RC_FFMPEG_PATH = path.join(tmpDir, 'definitely-not-ffmpeg-xyz');
    const res = await captureLocalCameraFrame({ device: '0', outDir: tmpDir });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ffmpeg-missing');
  });

  // ── captureLocalCameraFrame — fake ffmpeg behaviors (darwin/win) ───────────

  it.runIf(runnablePlatform)('success: fake ffmpeg writes JPEG → ok + path under outDir', async () => {
    const script = writeFakeFfmpeg(tmpDir, { behavior: 'jpeg', exitCode: 0 });
    process.env.RC_FFMPEG_PATH = writeFfmpegShim(tmpDir, script);
    process.env.RC_FFPROBE_PATH = path.join(tmpDir, 'no-ffprobe'); // probe non-fatal

    const res = await captureLocalCameraFrame({ device: '0', outDir: tmpDir });
    expect(res.ok).toBe(true);
    expect(res.path).toBeTruthy();
    expect(res.path!.startsWith(tmpDir)).toBe(true);
    // The frame file exists and starts with JPEG magic; success does NOT unlink.
    const buf = await fsp.readFile(res.path!);
    expect(isJpegMagic(buf)).toBe(true);
  });

  it.runIf(runnablePlatform)('empty output + nonzero exit → classified failure + temp cleaned up', async () => {
    const script = writeFakeFfmpeg(tmpDir, {
      behavior: 'empty',
      exitCode: 1,
      stderr: 'Selected video device does not exist',
    });
    process.env.RC_FFMPEG_PATH = writeFfmpegShim(tmpDir, script);

    const res = await captureLocalCameraFrame({ device: '99', outDir: tmpDir });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('device-not-found');
    // The empty temp frame must be removed.
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jpg'))).toHaveLength(0);
  });

  it.runIf(runnablePlatform)('non-JPEG output → capture-failed + temp cleaned up', async () => {
    const script = writeFakeFfmpeg(tmpDir, { behavior: 'garbage', exitCode: 0 });
    process.env.RC_FFMPEG_PATH = writeFfmpegShim(tmpDir, script);

    const res = await captureLocalCameraFrame({ device: '0', outDir: tmpDir });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('capture-failed');
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jpg'))).toHaveLength(0);
  });

  it.runIf(runnablePlatform)('timeout: a hanging ffmpeg is killed → timeout + temp cleaned up', async () => {
    // A fake ffmpeg that never exits (sleeps well past the tiny timeout).
    const script = path.join(tmpDir, 'hang.mjs');
    fs.writeFileSync(script, `setTimeout(() => process.exit(0), 60000);\n`, 'utf8');
    process.env.RC_FFMPEG_PATH = writeFfmpegShim(tmpDir, script);

    const res = await captureLocalCameraFrame({ device: '0', outDir: tmpDir, timeoutMs: 200 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('timeout');
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jpg'))).toHaveLength(0);
  });

  it('default timeout constant is 15s', () => {
    expect(LOCAL_CAMERA_DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  // ── listLocalCameras ─────────────────────────────────────────────────────

  it.runIf(runnablePlatform)('listLocalCameras: [] when ffmpeg binary is missing', async () => {
    process.env.RC_FFMPEG_PATH = path.join(tmpDir, 'nope-not-ffmpeg');
    const cams = await listLocalCameras();
    expect(cams).toEqual([]);
  });

  it.runIf(runnablePlatform)('listLocalCameras: parses a fake ffmpeg that emits the device list to stderr', async () => {
    // Fake ffmpeg that echoes platform-appropriate device stderr then exits 1
    // (real -list_devices always errors out because there is no input to open).
    const stderr = process.platform === 'darwin' ? AVFOUNDATION_STDERR : DSHOW_STDERR;
    const script = path.join(tmpDir, 'list.mjs');
    fs.writeFileSync(script, `process.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(1);\n`, 'utf8');
    process.env.RC_FFMPEG_PATH = writeFfmpegShim(tmpDir, script);

    const cams = await listLocalCameras();
    expect(cams.length).toBeGreaterThan(0);
    if (process.platform === 'darwin') {
      expect(cams[0]).toEqual({ device: '0', label: 'FaceTime HD Camera' });
    } else {
      expect(cams[0]).toEqual({ device: 'Integrated Webcam', label: 'Integrated Webcam' });
    }
  });

  // ── R2-I2: synchronous spawn failure must SETTLE, never hang ─────────────
  //
  // Byte-for-byte the same defect as rtsp.ts: `finish()` clears the hard
  // timeout, and when that timer was a `const` declared AFTER the spawn
  // try/catch, the catch branch's `void finish(...)` hit the temporal dead
  // zone — ReferenceError → unhandled rejection → the Promise never settles
  // (agent tool hangs forever) → OpenClaw's handler exits the gateway process.
  //
  // A device string containing NUL makes child_process.spawn throw
  // SYNCHRONOUSLY (ERR_INVALID_ARG_VALUE). Gated on darwin/win32 because
  // captureLocalCameraFrame short-circuits to 'unsupported-platform' before it
  // ever spawns anywhere else (CLAUDE.md: macOS + Windows only).

  it.runIf(runnablePlatform)(
    'R2-I2: synchronous spawn throw settles as ffmpeg-missing (no hang, no unhandled rejection)',
    async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => unhandled.push(e);
      process.on('unhandledRejection', onUnhandled);

      try {
        const NUL = String.fromCharCode(0);
        const HUNG = Symbol('hung');
        const settled = await Promise.race([
          captureLocalCameraFrame({ device: `0${NUL}bad`, outDir: tmpDir, timeoutMs: 5_000 }),
          new Promise<symbol>((r) => setTimeout(() => r(HUNG), 2_000)),
        ]);

        expect(settled).not.toBe(HUNG);
        expect(settled).toEqual({ ok: false, error: 'ffmpeg-missing' });

        await new Promise((r) => setTimeout(r, 100));
        expect(unhandled).toEqual([]);

        // No half-written frame left behind.
        expect((await fsp.readdir(tmpDir)).filter((f) => f.endsWith('.jpg'))).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );

  // ── Real-webcam E2E (gated) ──────────────────────────────────────────────
  // Gate: RC_LOCALCAM_E2E=1 && darwin && real ffmpeg. Uses device '0' (default
  // camera). Skips its assertion if the camera is absent or permission denied.

  const e2eGated =
    process.env.RC_LOCALCAM_E2E === '1' && process.platform === 'darwin';

  it.runIf(e2eGated)(
    'E2E: grabs a real frame from the default camera (device 0)',
    async () => {
      // Ensure the REAL ffmpeg is used (clear any fake shim from other tests).
      delete process.env.RC_FFMPEG_PATH;
      delete process.env.RC_FFPROBE_PATH;
      const res = await captureLocalCameraFrame({ device: '0', outDir: tmpDir, timeoutMs: 20_000 });
      if (!res.ok) {
        // Camera absent / permission denied / busy — record but do not fail the
        // suite (the harness reports this as an external blocker).
        // eslint-disable-next-line no-console
        expect(['device-not-found', 'capture-failed', 'timeout']).toContain(res.error);
        return;
      }
      expect(res.path).toBeTruthy();
      const buf = await fsp.readFile(res.path!);
      expect(isJpegMagic(buf)).toBe(true);
    },
    30_000,
  );
});
