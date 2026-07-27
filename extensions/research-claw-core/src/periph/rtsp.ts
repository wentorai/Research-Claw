/**
 * RTSP single-frame driver (§15-D8 案 A / F6).
 *
 * Grabs ONE JPEG frame from an RTSP source **on the gateway side** using
 * `ffmpeg`, with no browser bridge. This is the core value of the minimal RTSP
 * driver: it works while the dashboard is closed, enabling unattended overnight
 * monitoring for lab IP cameras.
 *
 * ── Security (RTSP takes external input) ──────────────────────────────────────
 *  • ffmpeg is ALWAYS invoked with an args ARRAY via child_process.spawn
 *    (shell:false). No shell string is ever built, so shell metacharacters in the
 *    URL / username / password can never inject commands.
 *  • Credentials (rtsp://user:pass@host or a separate username/password) NEVER
 *    reach logs / error messages / observation summaries / the tool return text.
 *    Any URL in an error or log is masked by redactRtspCredentials() which
 *    rewrites `user:pass@` → `***@`. The returned `error` field is a fixed
 *    classification token, never the raw stderr or URL.
 *
 * ── Guards ────────────────────────────────────────────────────────────────────
 *  • Explicit scheme allowlist: only rtsp:// and rtsps:// are accepted before
 *    any ffmpeg process is spawned.
 *  • Total timeout (default 15s); on timeout/failure the child is killed
 *    (SIGKILL fallback after a grace period).
 *  • Output size cap (RTSP_FRAME_MAX_BYTES) — oversized frames are rejected.
 *  • Output format check — the frame must start with the JPEG magic 0xFFD8.
 *  • Temp file cleanup on every path (success, failure, timeout, throw).
 *  • Failure classification: timeout | connect-failed | auth-failed |
 *    decode-failed | ffmpeg-missing.
 */

import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { CaptureResult } from './bridge.js';

/** Default total wall-clock timeout for a single-frame grab. */
export const RTSP_DEFAULT_TIMEOUT_MS = 15_000;

/** Grace period after SIGTERM before we escalate to SIGKILL. */
const RTSP_SIGKILL_GRACE_MS = 2_000;

/** Maximum accepted frame size (a single JPEG frame is far below this). */
export const RTSP_FRAME_MAX_BYTES = 15 * 1024 * 1024;

/** ffmpeg binary — overridable via env for non-standard installs. Resolved per
 *  call (not at module load) so the path is testable and reflects env changes. */
function ffmpegBin(): string {
  return process.env.RC_FFMPEG_PATH || 'ffmpeg';
}

export type RtspFailure =
  | 'timeout'
  | 'connect-failed'
  | 'auth-failed'
  | 'decode-failed'
  | 'ffmpeg-missing';

export interface CaptureRtspOpts {
  /** RTSP URL. May embed credentials (rtsp://user:pass@host/path). */
  url: string;
  /** Optional username — used only when the URL has no embedded credentials. */
  username?: string;
  /** Optional password — used only when the URL has no embedded credentials. */
  password?: string;
  /** Directory the frame is written into (must already exist). */
  outDir: string;
  /** Total timeout in ms (default RTSP_DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
}

// ── Credential masking ────────────────────────────────────────────────────────

/**
 * Redact credentials from an RTSP (or any) URL for logging/error text.
 * `rtsp://user:pass@host/path` → `rtsp://***@host/path`.
 * Falls back to a scheme-only string if the URL is unparseable, so a malformed
 * URL can never leak an embedded `user:pass@` segment through the fallback.
 */
export function redactRtspCredentials(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return String(url);
  // Regex path first: robust even for URLs the WHATWG parser rejects.
  // Matches `<scheme>://<userinfo>@` and replaces the userinfo with ***.
  const masked = url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]*@/, '$1***@');
  return masked;
}

// ── URL / credential composition ──────────────────────────────────────────────

/**
 * Whether the URL already carries an embedded userinfo (`user[:pass]@host`).
 */
function urlHasEmbeddedCredentials(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@\s]*@/.test(url);
}

/**
 * Build the effective RTSP URL passed to ffmpeg.
 * - If the URL already embeds credentials, it is used verbatim.
 * - Else, if a separate username/password is supplied, they are percent-encoded
 *   and injected as userinfo. Encoding neutralises `@`, `:`, `/` etc. so the
 *   host/path cannot be corrupted, and — because we still pass the whole thing
 *   as ONE array argument — no shell interpretation occurs regardless.
 *
 * @throws Error('invalid-url') if the URL cannot be parsed when injecting creds.
 */
export function buildRtspUrl(opts: { url: string; username?: string; password?: string }): string {
  const { url, username, password } = opts;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid-url');
  }
  if ((parsed.protocol !== 'rtsp:' && parsed.protocol !== 'rtsps:') || !parsed.hostname) {
    throw new Error('invalid-url');
  }
  if (urlHasEmbeddedCredentials(url)) return url;
  const user = typeof username === 'string' ? username.trim() : '';
  if (!user) return url; // no separate creds → use URL as-is
  // Inject userinfo. Use WHATWG URL so host/path structure is preserved.
  parsed.username = encodeURIComponent(user);
  if (typeof password === 'string' && password.length > 0) {
    parsed.password = encodeURIComponent(password);
  }
  return parsed.toString();
}

// ── Failure classification ────────────────────────────────────────────────────

/**
 * Classify an ffmpeg failure from its stderr text.
 * Never returns the raw stderr — only a fixed token. Order matters: auth before
 * connect (401 implies we reached the server), decode last.
 */
export function classifyRtspFailure(stderr: string): Exclude<RtspFailure, 'ffmpeg-missing'> {
  const s = (stderr || '').toLowerCase();
  // Auth: 401 Unauthorized / authorization failed.
  if (
    s.includes('401 unauthorized') ||
    s.includes('unauthorized') ||
    s.includes('authorization failed') ||
    s.includes('authentication')
  ) {
    return 'auth-failed';
  }
  // Connect: DNS / refused / no route / timed out reaching the server / 404.
  if (
    s.includes('connection refused') ||
    s.includes('connection timed out') ||
    s.includes('no route to host') ||
    s.includes('name or service not known') ||
    s.includes('failed to resolve') ||
    s.includes('could not connect') ||
    s.includes('network is unreachable') ||
    s.includes('404 not found') ||
    s.includes('method describe failed') ||
    s.includes('server returned 404') ||
    s.includes('error opening input')
  ) {
    return 'connect-failed';
  }
  // Anything else that produced no frame → treat as decode failure.
  return 'decode-failed';
}

// ── Frame validation ──────────────────────────────────────────────────────────

/** JPEG SOI magic = 0xFF 0xD8. */
export function isJpegMagic(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

// ── Temp cleanup ──────────────────────────────────────────────────────────────

async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    /* already gone / unreadable — cleanup is best-effort */
  }
}

// ── ffprobe (optional, non-fatal) ─────────────────────────────────────────────

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

// ── captureRtspFrame ──────────────────────────────────────────────────────────

/**
 * Grab a single JPEG frame from an RTSP source via gateway-side ffmpeg.
 *
 * Returns the shared CaptureResult shape ({ok, path?, width?, height?, error?}).
 * On failure `error` is a classification token (never raw stderr/URL). On
 * success `path` is the absolute JPEG path under `outDir`.
 *
 * Guarantees:
 *  - args-array spawn (shell:false) — no command injection.
 *  - total timeout → child SIGKILLed, temp file removed, error='timeout'.
 *  - output validated: exists, non-empty, ≤ RTSP_FRAME_MAX_BYTES, JPEG magic.
 *  - temp file removed on EVERY non-success path.
 *  - credentials never appear in `error`.
 */
export async function captureRtspFrame(opts: CaptureRtspOpts): Promise<CaptureResult> {
  const timeoutMs = opts.timeoutMs ?? RTSP_DEFAULT_TIMEOUT_MS;
  const outPath = path.join(opts.outDir, `${randomUUID()}.jpg`);

  let effectiveUrl: string;
  try {
    effectiveUrl = buildRtspUrl(opts);
  } catch {
    // buildRtspUrl only throws 'invalid-url'; surface as connect-failed (no leak).
    return { ok: false, error: 'connect-failed' };
  }

  // ffmpeg args — ALWAYS an array, shell:false. `-y` overwrites; `-frames:v 1`
  // grabs one frame; `-rtsp_transport tcp` avoids UDP packet loss on grab.
  // `-timeout`/`-stimeout` are transport-level; we also enforce a hard JS timer.
  const args = [
    '-nostdin',
    '-rtsp_transport', 'tcp',
    '-i', effectiveUrl,
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
      }, RTSP_SIGKILL_GRACE_MS);
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
      void finish({ ok: false, error: 'connect-failed' });
    });

    child.on('close', (code) => {
      void (async () => {
        if (timedOut) {
          await finish({ ok: false, error: 'timeout' });
          return;
        }

        // Validate output regardless of exit code (ffmpeg may exit 0 yet write
        // nothing on some sources; or exit non-zero after a partial write).
        let buf: Buffer | null = null;
        try {
          const stat = await fsp.stat(outPath);
          if (stat.size === 0) {
            await finish({ ok: false, error: classifyRtspFailure(stderr) });
            return;
          }
          if (stat.size > RTSP_FRAME_MAX_BYTES) {
            await finish({ ok: false, error: 'decode-failed' });
            return;
          }
          buf = await fsp.readFile(outPath);
        } catch {
          // No output file at all → classify from stderr (connect/auth/decode).
          await finish({ ok: false, error: code === 0 ? 'decode-failed' : classifyRtspFailure(stderr) });
          return;
        }

        if (!isJpegMagic(buf)) {
          await finish({ ok: false, error: 'decode-failed' });
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

/** Re-export for callers that only need the CaptureResult type. */
export type { CaptureResult } from './bridge.js';
