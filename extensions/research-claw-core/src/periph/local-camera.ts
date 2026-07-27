/**
 * Local-camera single-frame driver (§15 v1.3 场景②「服务端 USB webcam 采集」).
 *
 * Grabs ONE JPEG frame from an OS-attached camera (USB / built-in webcam) **on
 * the gateway side** using `ffmpeg`, with no browser getUserMedia bridge. This
 * is the core value of the local-camera driver: it works while the dashboard is
 * CLOSED, enabling unattended overnight monitoring for a laptop/USB webcam —
 * exactly like the rtsp driver, but for a locally-attached device instead of an
 * IP camera.
 *
 * ── Cross-platform input (process.platform) ──────────────────────────────────
 *   • darwin  → `-f avfoundation -framerate 30 -i <device>`
 *               <device> is a camera INDEX ('0') or 'index:none' for video-only
 *               ('0:none'). avfoundation addresses cameras by numeric index.
 *   • win32   → `-f dshow -i video=<device>`
 *               <device> is a DirectShow device NAME (may contain spaces).
 *   • other   → 'unsupported-platform' (CLAUDE.md: macOS + Windows only).
 *   Followed by `-frames:v 1 -f image2 -y <outPath>`.
 *
 * ── Security (device name/index is user-supplied) ────────────────────────────
 *  • ffmpeg is ALWAYS invoked with an args ARRAY via child_process.spawn
 *    (shell:false). No shell string is ever built, so shell metacharacters in a
 *    device name/index (`;`, `$(...)`, backticks, spaces, `&&`) are passed as ONE
 *    literal argument and can never inject a command. A Windows device name may
 *    contain spaces — as a single array element it is still safe.
 *
 * ── Guards (mirrors rtsp.ts) ─────────────────────────────────────────────────
 *  • Total timeout (default 15s); on timeout/failure the child is SIGTERMed then
 *    SIGKILLed after a grace period.
 *  • Output size cap — oversized frames are rejected (decode/capture failure).
 *  • Output format check — the frame must start with the JPEG magic 0xFFD8.
 *  • Temp file cleanup on EVERY non-success path (failure, timeout, throw).
 *  • Failure classification returns a fixed token (never raw stderr):
 *    timeout | device-not-found | capture-failed | ffmpeg-missing |
 *    unsupported-platform.
 *  • ffprobe reads width/height (non-fatal — {} on any failure).
 *  • Zero console output.
 */

import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { CaptureResult } from './bridge.js';

/** Default total wall-clock timeout for a single-frame grab. */
export const LOCAL_CAMERA_DEFAULT_TIMEOUT_MS = 15_000;

/** Grace period after SIGTERM before we escalate to SIGKILL. */
const LOCAL_CAMERA_SIGKILL_GRACE_MS = 2_000;

/** Maximum accepted frame size (a single JPEG frame is far below this). */
export const LOCAL_CAMERA_FRAME_MAX_BYTES = 15 * 1024 * 1024;

/** Timeout for the device-enumeration ffmpeg probe. */
const LOCAL_CAMERA_LIST_TIMEOUT_MS = 8_000;

/** ffmpeg binary — overridable via env for non-standard installs. Resolved per
 *  call (not at module load) so the path is testable and reflects env changes. */
function ffmpegBin(): string {
  return process.env.RC_FFMPEG_PATH || 'ffmpeg';
}

export type LocalCameraFailure =
  | 'timeout'
  | 'device-not-found'
  | 'capture-failed'
  | 'ffmpeg-missing'
  | 'unsupported-platform';

export interface CaptureLocalCameraOpts {
  /**
   * OS camera address:
   *  - darwin (avfoundation): a video device INDEX ('0') or 'index:none'
   *    ('0:none') for video-only.
   *  - win32 (dshow): a DirectShow device NAME (e.g. 'Integrated Webcam').
   */
  device: string;
  /** Directory the frame is written into (must already exist). */
  outDir: string;
  /** Total timeout in ms (default LOCAL_CAMERA_DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
}

export interface LocalCameraInfo {
  /** The OS address to store in device.config.device (index on darwin, name on win32). */
  device: string;
  /** Human-readable label for the dashboard picker. */
  label: string;
}

// ── ffmpeg input args per platform ──────────────────────────────────────────

/**
 * Build the platform-specific ffmpeg INPUT args for a single-frame grab.
 * Returns null for unsupported platforms. The device value is always a single
 * array element (never concatenated into a shell string).
 */
export function buildLocalCameraInputArgs(platform: NodeJS.Platform, device: string): string[] | null {
  if (platform === 'darwin') {
    // avfoundation addresses cameras by numeric index; '-i "0"' or '-i "0:none"'
    // (video:audio; ':none' = video only). device is passed verbatim as ONE arg.
    return ['-f', 'avfoundation', '-framerate', '30', '-i', device];
  }
  if (platform === 'win32') {
    // dshow addresses cameras by NAME. `video=<name>` is a SINGLE array element,
    // so a name containing spaces stays intact and no shell parsing occurs.
    return ['-f', 'dshow', '-i', `video=${device}`];
  }
  return null;
}

// ── Failure classification ──────────────────────────────────────────────────

/**
 * Classify a local-camera ffmpeg failure from its stderr text.
 * Never returns the raw stderr — only a fixed token.
 *  - device-not-found: the requested index/name does not exist or is invalid.
 *  - capture-failed: anything else that produced no valid frame (permission
 *    denied, device busy, decode error, empty output, etc.).
 */
export function classifyLocalCameraFailure(stderr: string): 'device-not-found' | 'capture-failed' {
  const s = (stderr || '').toLowerCase();
  if (
    s.includes('does not exist') ||
    s.includes('no such device') ||
    s.includes('not found') ||
    s.includes('invalid device') ||
    s.includes('could not find video device') ||
    s.includes('device not found') ||
    s.includes('could not open') ||
    s.includes('unknown input format')
  ) {
    return 'device-not-found';
  }
  return 'capture-failed';
}

// ── Frame validation ────────────────────────────────────────────────────────

/** JPEG SOI magic = 0xFF 0xD8. */
export function isJpegMagic(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

// ── Temp cleanup ────────────────────────────────────────────────────────────

async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    /* already gone / unreadable — cleanup is best-effort */
  }
}

// ── ffprobe (optional, non-fatal) ───────────────────────────────────────────

/**
 * Read frame width/height via ffprobe. Never throws; returns {} on any failure
 * (ffprobe missing, parse error, timeout). Uses an args array (shell:false).
 */
async function probeDimensions(framePath: string): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { width?: number; height?: number }) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = spawn(
        process.env.RC_FFPROBE_PATH || 'ffprobe',
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height',
          '-of', 'json',
          framePath,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      done({});
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
      done({});
    }, 4_000);
    let out = '';
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => {
      clearTimeout(killTimer);
      done({});
    });
    child.on('close', () => {
      clearTimeout(killTimer);
      try {
        const parsed = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }> };
        const s = parsed.streams?.[0];
        if (s && typeof s.width === 'number' && typeof s.height === 'number') {
          done({ width: s.width, height: s.height });
          return;
        }
      } catch {
        /* fall through */
      }
      done({});
    });
  });
}

// ── captureLocalCameraFrame ─────────────────────────────────────────────────

/**
 * Grab a single JPEG frame from a locally-attached OS camera via gateway-side
 * ffmpeg. Returns the shared CaptureResult shape ({ok, path?, width?, height?,
 * error?}). On failure `error` is a classification token (never raw stderr).
 * On success `path` is the absolute JPEG path under `outDir`.
 *
 * Guarantees:
 *  - args-array spawn (shell:false) — no command injection via the device name.
 *  - unsupported platform → {ok:false, error:'unsupported-platform'} (no spawn).
 *  - total timeout → child SIGKILLed, temp file removed, error='timeout'.
 *  - output validated: exists, non-empty, ≤ LOCAL_CAMERA_FRAME_MAX_BYTES, JPEG magic.
 *  - temp file removed on EVERY non-success path.
 */
export async function captureLocalCameraFrame(opts: CaptureLocalCameraOpts): Promise<CaptureResult> {
  const inputArgs = buildLocalCameraInputArgs(process.platform, opts.device);
  if (inputArgs === null) {
    // macOS + Windows only (CLAUDE.md). No spawn on unsupported platforms.
    return { ok: false, error: 'unsupported-platform' };
  }

  const timeoutMs = opts.timeoutMs ?? LOCAL_CAMERA_DEFAULT_TIMEOUT_MS;
  const outPath = path.join(opts.outDir, `${randomUUID()}.jpg`);

  // ffmpeg args — ALWAYS an array, shell:false. `-nostdin` avoids blocking on a
  // tty; input args are platform-specific; `-frames:v 1` grabs one frame; `-y`
  // overwrites. A hard JS timer also enforces the wall-clock timeout.
  const args = [
    '-nostdin',
    ...inputArgs,
    '-frames:v', '1',
    '-f', 'image2',
    '-y', outPath,
  ];

  return new Promise<CaptureResult>((resolve) => {
    let settled = false;
    let stderr = '';
    let timedOut = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    // Declared BEFORE `finish` and assigned after spawn: the synchronous-throw
    // path below calls finish() before the timer exists, and a `const` declared
    // later would make that call hit the temporal dead zone — the ReferenceError
    // escapes through `void`, the outer Promise never settles (tool hangs
    // forever) and the gateway's unhandled-rejection handler exits the process.
    let hardTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = async (result: CaptureResult) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (!result.ok) {
        // Remove any half-written temp frame on every failure path.
        await safeUnlink(outPath);
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      // spawn threw synchronously (e.g. an invalid arg such as an embedded NUL)
      // — treat as ffmpeg-missing (ENOENT-like).
      void finish({ ok: false, error: 'ffmpeg-missing' });
      return;
    }

    hardTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* noop */
      }
      // Escalate to SIGKILL if it does not exit promptly.
      sigkillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* noop */
        }
      }, LOCAL_CAMERA_SIGKILL_GRACE_MS);
    }, timeoutMs);

    // Cap stderr accumulation so a chatty ffmpeg can't balloon memory; the tail
    // is enough for classification.
    child.stderr?.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err && err.code === 'ENOENT') {
        void finish({ ok: false, error: 'ffmpeg-missing' });
        return;
      }
      void finish({ ok: false, error: 'capture-failed' });
    });

    child.on('close', (code) => {
      void (async () => {
        if (timedOut) {
          await finish({ ok: false, error: 'timeout' });
          return;
        }

        // Validate output regardless of exit code (ffmpeg may exit 0 yet write
        // nothing on some devices; or exit non-zero after a partial write).
        let buf: Buffer | null = null;
        try {
          const stat = await fsp.stat(outPath);
          if (stat.size === 0) {
            await finish({ ok: false, error: classifyLocalCameraFailure(stderr) });
            return;
          }
          if (stat.size > LOCAL_CAMERA_FRAME_MAX_BYTES) {
            await finish({ ok: false, error: 'capture-failed' });
            return;
          }
          buf = await fsp.readFile(outPath);
        } catch {
          // No output file at all → classify from stderr (device-not-found/capture).
          await finish({
            ok: false,
            error: code === 0 ? 'capture-failed' : classifyLocalCameraFailure(stderr),
          });
          return;
        }

        if (!isJpegMagic(buf)) {
          await finish({ ok: false, error: 'capture-failed' });
          return;
        }

        // Success — optional (non-fatal) dimension probe.
        const dims = await probeDimensions(outPath);
        // Do NOT unlink on success; the caller owns the frame lifecycle.
        settled = true;
        clearTimeout(hardTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve({ ok: true, path: outPath, width: dims.width, height: dims.height });
      })();
    });
  });
}

// ── Device enumeration ──────────────────────────────────────────────────────

/**
 * Parse the video devices out of `ffmpeg -list_devices true` stderr.
 *
 * darwin (avfoundation) format:
 *   [AVFoundation indev @ 0x..] AVFoundation video devices:
 *   [AVFoundation indev @ 0x..] [0] FaceTime HD Camera
 *   [AVFoundation indev @ 0x..] [1] Capture screen 0
 *   [AVFoundation indev @ 0x..] AVFoundation audio devices:   ← stop here
 *   [AVFoundation indev @ 0x..] [0] MacBook Pro Microphone
 * → device = the numeric index; label = the device name.
 *
 * win32 (dshow) format:
 *   [dshow @ ...] DirectShow video devices ...
 *   [dshow @ ...]  "Integrated Webcam"
 *   [dshow @ ...]     Alternative name "@device_pnp_..."
 *   [dshow @ ...] DirectShow audio devices ...   ← stop here
 * → device = the quoted friendly name; label = the same name.
 *
 * Exported for unit testing against captured real ffmpeg output.
 */
export function parseLocalCameraList(platform: NodeJS.Platform, stderr: string): LocalCameraInfo[] {
  const lines = (stderr || '').split(/\r?\n/);
  const out: LocalCameraInfo[] = [];

  if (platform === 'darwin') {
    let inVideo = false;
    for (const line of lines) {
      // Section markers. Video section starts at "video devices", any other
      // "... devices:" header (audio) ends it.
      if (/AVFoundation video devices/i.test(line)) {
        inVideo = true;
        continue;
      }
      if (/AVFoundation audio devices/i.test(line)) {
        inVideo = false;
        continue;
      }
      if (!inVideo) continue;
      // "[AVFoundation indev @ 0x..] [0] FaceTime HD Camera"
      const m = line.match(/\]\s*\[(\d+)\]\s+(.+?)\s*$/);
      if (m) {
        const index = m[1];
        const name = m[2].trim();
        if (name) out.push({ device: index, label: name });
      }
    }
    return out;
  }

  if (platform === 'win32') {
    let inVideo = false;
    for (const line of lines) {
      if (/DirectShow video devices/i.test(line)) {
        inVideo = true;
        continue;
      }
      if (/DirectShow audio devices/i.test(line)) {
        inVideo = false;
        continue;
      }
      if (!inVideo) continue;
      // Skip the "Alternative name" companion lines; take only the friendly name.
      if (/Alternative name/i.test(line)) continue;
      // "[dshow @ ...]  "Integrated Webcam""  → capture the first quoted token.
      const m = line.match(/"([^"]+)"/);
      if (m) {
        const name = m[1].trim();
        if (name) out.push({ device: name, label: name });
      }
    }
    return out;
  }

  return out;
}

/**
 * Enumerate OS-attached cameras via `ffmpeg -list_devices true`.
 * Returns [] on any failure (ffmpeg missing, unsupported platform, timeout,
 * unparseable output, no devices). Never throws, never writes to console — the
 * dashboard degrades to a manual device-index input when this is empty.
 *
 * The enumeration ffmpeg command deliberately exits with an error (there is no
 * real input to open), so we ignore the exit code and only parse stderr.
 */
export async function listLocalCameras(): Promise<LocalCameraInfo[]> {
  const platform = process.platform;
  let listArgs: string[] | null = null;
  if (platform === 'darwin') {
    listArgs = ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
  } else if (platform === 'win32') {
    listArgs = ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'];
  }
  if (listArgs === null) return [];

  return new Promise<LocalCameraInfo[]>((resolve) => {
    let settled = false;
    let stderr = '';
    const done = (v: LocalCameraInfo[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(v);
    };

    let child;
    try {
      child = spawn(ffmpegBin(), ['-nostdin', ...listArgs], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      resolve([]);
      return;
    }

    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
      // Still parse whatever stderr we collected before the timeout.
      done(safeParse(platform, stderr));
    }, LOCAL_CAMERA_LIST_TIMEOUT_MS);

    child.stderr?.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024);
    });

    child.on('error', () => {
      // ffmpeg missing / spawn failure → empty list (dashboard falls back).
      done([]);
    });

    child.on('close', () => {
      done(safeParse(platform, stderr));
    });
  });
}

/** parseLocalCameraList wrapper that can never throw (defensive for listLocalCameras). */
function safeParse(platform: NodeJS.Platform, stderr: string): LocalCameraInfo[] {
  try {
    return parseLocalCameraList(platform, stderr);
  } catch {
    return [];
  }
}

/** Re-export for callers that only need the CaptureResult type. */
export type { CaptureResult } from './bridge.js';
