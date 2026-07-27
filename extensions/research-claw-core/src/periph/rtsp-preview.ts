/**
 * RTSP→HLS live-preview transmux manager (§15 v1.3 场景③ / H1-H6).
 *
 * Browsers cannot play RTSP natively. To give the dashboard a *live preview* of
 * an RTSP device (a human watching the picture — distinct from the agent's
 * single-frame evidence grab in rtsp.ts), the gateway runs an on-demand `ffmpeg`
 * process that transmuxes RTSP → HLS. The HLS playlist + segments are written to
 * a per-session temp directory and served over the gateway HTTP surface; the
 * dashboard plays them with hls.js. This module owns the ffmpeg session
 * lifecycle ONLY — HTTP serving and RPC live in index.ts / rpc.ts.
 *
 * ── Transmux, not transcode (H1, low CPU) ────────────────────────────────────
 *  ffmpeg `-c:v copy -c:a copy -f hls` remuxes the existing H.264/H.265 stream
 *  into HLS without re-encoding — near-zero CPU. `-hls_flags
 *  delete_segments+omit_endlist` keeps only a rolling window of `.ts` segments
 *  (live, unbounded playback), so the temp dir never grows without bound.
 *
 * ── Session lifecycle (H1) ───────────────────────────────────────────────────
 *  • start(deviceId, url) is IDEMPOTENT: a second start for the same deviceId
 *    while a session is live reuses it (no second ffmpeg), refreshing
 *    lastAccessAt (H2 idempotent).
 *  • Each session records lastAccessAt; a periodic sweep stops sessions idle for
 *    ≥ IDLE_TIMEOUT_MS (default 60s) — killing ffmpeg (SIGTERM→SIGKILL) and
 *    removing the session dir. touch(sessionToken) refreshes lastAccessAt on
 *    every authenticated HTTP hit, so an actively-watched preview never expires.
 *  • stop(deviceId) stops one session; destroy() stops ALL (gateway shutdown) —
 *    no orphan ffmpeg processes / temp files survive.
 *
 * ── Concurrency isolation (H2) ───────────────────────────────────────────────
 *  Each session gets its OWN random-token temp dir and its OWN ffmpeg process —
 *  multiple rtsp devices preview simultaneously without interference.
 *
 * ── Credential boundary (H4) ─────────────────────────────────────────────────
 *  The RTSP URL (which may embed user:pass@) is built with buildRtspUrl (shared
 *  with rtsp.ts) and passed to ffmpeg as ONE array argument (shell:false) — no
 *  shell, no injection. The credential NEVER appears in:
 *    - the sessionToken (a random UUID, not a deviceId/URL mapping),
 *    - the HLS playlist / segment paths or URLs,
 *    - logs / errors / the manager's public return values.
 *  This module writes NOTHING to console; failures surface only as classification
 *  tokens.
 *
 * ── Failure classification ───────────────────────────────────────────────────
 *  • 'preview-start-failed' — ffmpeg could not spawn / the RTSP source could not
 *    be opened (process exited before producing a playlist).
 *  • 'preview-no-output'    — ffmpeg started but no playlist/segment appeared
 *    within the readiness window.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import { buildRtspUrl } from './rtsp.js';

/** Idle timeout: a session with no HTTP access for this long is auto-stopped (H1). */
export const PREVIEW_IDLE_TIMEOUT_MS = 60_000;

/** How often the sweep checks for idle sessions. */
export const PREVIEW_SWEEP_INTERVAL_MS = 15_000;

/** Grace period after SIGTERM before escalating to SIGKILL. */
const PREVIEW_SIGKILL_GRACE_MS = 2_000;

/** Max wait for the first playlist to appear before start() reports failure. */
export const PREVIEW_READY_TIMEOUT_MS = 12_000;

/** Poll interval while waiting for the playlist to appear. */
const PREVIEW_READY_POLL_MS = 200;

/** The playlist file name ffmpeg writes into the session dir. */
export const PREVIEW_PLAYLIST_NAME = 'index.m3u8';

/** ffmpeg binary — overridable via env; resolved per call (testable). */
function ffmpegBin(): string {
  return process.env.RC_FFMPEG_PATH || 'ffmpeg';
}

export type PreviewFailure = 'preview-start-failed' | 'preview-no-output';

export interface PreviewStartOpts {
  /** RTSP URL. May embed credentials (rtsp://user:pass@host/path). */
  url: string;
  /** Optional username — used only when the URL has no embedded credentials. */
  username?: string;
  /** Optional password — used only when the URL has no embedded credentials. */
  password?: string;
  /** Override the readiness timeout (tests use a short window). */
  readyTimeoutMs?: number;
}

/** Public start() result — NEVER carries credentials. */
export interface PreviewSession {
  /** Random opaque token; also the temp-dir name and the HTTP path segment. */
  sessionToken: string;
  /** Registered device id this session previews (safe: no credential). */
  deviceId: string;
  /** Absolute session temp directory (server-side only; not returned to clients). */
  dir: string;
}

/** Internal session record. */
interface SessionRecord {
  sessionToken: string;
  deviceId: string;
  dir: string;
  child: ChildProcess;
  lastAccessAt: number;
  /** Set once stop() begins so double-stop / sweep races are no-ops. */
  stopping: boolean;
}

/** Build the ffmpeg transmux args (array — shell:false). Exported for tests. */
export function buildTransmuxArgs(url: string, playlistPath: string): string[] {
  return [
    '-nostdin',
    '-rtsp_transport', 'tcp',
    '-i', url,
    // Transmux: copy both streams (no re-encode → low CPU, H1).
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '4',
    // delete_segments: rolling window (temp dir bounded). omit_endlist: live
    // (never signals VOD end), so the player keeps requesting fresh segments.
    '-hls_flags', 'delete_segments+omit_endlist',
    playlistPath,
  ];
}

async function safeRmDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * RtspPreviewManager — owns all live HLS transmux sessions for the gateway.
 *
 * One instance per gateway process. Wire the sweep on construction; call
 * destroy() at gateway shutdown to guarantee no orphan ffmpeg / temp dirs.
 */
export class RtspPreviewManager {
  /** deviceId → session (one live session per device; idempotent start). */
  private readonly byDevice = new Map<string, SessionRecord>();
  /** sessionToken → session (HTTP path lookup + touch). */
  private readonly byToken = new Map<string, SessionRecord>();
  private readonly baseDir: string;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(opts?: { baseDir?: string; sweepIntervalMs?: number }) {
    // Sessions live under a manager-scoped temp root, isolated from workspace.
    this.baseDir =
      opts?.baseDir ?? path.join(os.tmpdir(), 'rc-rtsp-preview');
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
    } catch {
      /* creation retried per-session */
    }
    const interval = opts?.sweepIntervalMs ?? PREVIEW_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, interval);
    // Never keep the process alive for the sweep alone.
    this.sweepTimer.unref?.();
  }

  /** Number of live sessions (tests / diagnostics). */
  get sessionCount(): number {
    return this.byDevice.size;
  }

  /** Look up a live session by its HTTP token (index.ts route). */
  getByToken(sessionToken: string): PreviewSession | null {
    const rec = this.byToken.get(sessionToken);
    if (!rec) return null;
    return { sessionToken: rec.sessionToken, deviceId: rec.deviceId, dir: rec.dir };
  }

  /**
   * Refresh lastAccessAt for a session (called on every authenticated HTTP hit)
   * so an actively-watched preview never idles out. Returns true if the token
   * mapped to a live session.
   */
  touch(sessionToken: string): boolean {
    const rec = this.byToken.get(sessionToken);
    if (!rec || rec.stopping) return false;
    rec.lastAccessAt = Date.now();
    return true;
  }

  /**
   * Start (or idempotently reuse) a transmux session for a device.
   *
   * Returns a PreviewSession with a random sessionToken. On failure throws an
   * Error whose message is a classification token ('preview-start-failed' /
   * 'preview-no-output') — never the URL or ffmpeg stderr.
   */
  async start(deviceId: string, opts: PreviewStartOpts): Promise<PreviewSession> {
    if (this.destroyed) throw new Error('preview-start-failed');

    // Idempotent (H2): reuse a live session for the same device.
    const existing = this.byDevice.get(deviceId);
    if (existing && !existing.stopping && existing.child.exitCode === null) {
      existing.lastAccessAt = Date.now();
      return {
        sessionToken: existing.sessionToken,
        deviceId: existing.deviceId,
        dir: existing.dir,
      };
    }

    // Build the effective URL (credentials embedded/injected here, in-memory
    // only). buildRtspUrl throws 'invalid-url' on an unparseable URL when
    // injecting creds — surface as start-failed, no leak.
    let effectiveUrl: string;
    try {
      effectiveUrl = buildRtspUrl({
        url: opts.url,
        username: opts.username,
        password: opts.password,
      });
    } catch {
      throw new Error('preview-start-failed');
    }

    const sessionToken = randomUUID();
    const dir = path.join(this.baseDir, sessionToken);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      throw new Error('preview-start-failed');
    }

    const playlistPath = path.join(dir, PREVIEW_PLAYLIST_NAME);
    const args = buildTransmuxArgs(effectiveUrl, playlistPath);

    let child: ChildProcess;
    try {
      child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      await safeRmDir(dir);
      throw new Error('preview-start-failed');
    }

    // Drain stderr so a chatty ffmpeg cannot fill the pipe buffer and stall.
    child.stderr?.on('data', () => {
      /* discarded — never logged (credential boundary, H4) */
    });

    const rec: SessionRecord = {
      sessionToken,
      deviceId,
      dir,
      child,
      lastAccessAt: Date.now(),
      stopping: false,
    };
    // Register BEFORE awaiting readiness so a concurrent start for the same
    // device reuses this session rather than spawning a second ffmpeg.
    this.byDevice.set(deviceId, rec);
    this.byToken.set(sessionToken, rec);

    // If ffmpeg dies before we see a playlist, mark that so the readiness wait
    // classifies it as a start failure (bad URL / auth / connect).
    let earlyExit = false;
    const onEarlyExit = () => {
      earlyExit = true;
    };
    child.once('exit', onEarlyExit);
    child.once('error', onEarlyExit);

    const readyTimeoutMs = opts.readyTimeoutMs ?? PREVIEW_READY_TIMEOUT_MS;
    const deadline = Date.now() + readyTimeoutMs;

    // Wait for the first playlist AND at least one segment reference to appear.
    let ready = false;
    while (Date.now() < deadline) {
      if (earlyExit) break;
      if (await this.playlistHasSegment(playlistPath)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, PREVIEW_READY_POLL_MS));
    }

    child.removeListener('exit', onEarlyExit);
    child.removeListener('error', onEarlyExit);

    if (!ready) {
      // Tear the session down; classify by whether ffmpeg died early.
      await this.disposeSession(rec);
      throw new Error(earlyExit ? 'preview-start-failed' : 'preview-no-output');
    }

    // Re-arm a persistent exit handler: if ffmpeg dies later, drop the session
    // so a stale token cannot serve a dead preview.
    child.once('exit', () => {
      if (!rec.stopping) void this.disposeSession(rec);
    });

    rec.lastAccessAt = Date.now();
    return { sessionToken, deviceId, dir };
  }

  /** Stop a device's live session (explicit dashboard "stop preview"). */
  async stop(deviceId: string): Promise<boolean> {
    const rec = this.byDevice.get(deviceId);
    if (!rec) return false;
    await this.disposeSession(rec);
    return true;
  }

  /** Stop ALL sessions (gateway shutdown / manager destroy). */
  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const all = [...this.byDevice.values()];
    await Promise.all(all.map((rec) => this.disposeSession(rec)));
  }

  /** Idle sweep: stop + clean any session unused for ≥ PREVIEW_IDLE_TIMEOUT_MS. */
  async sweep(): Promise<void> {
    const now = Date.now();
    const stale: SessionRecord[] = [];
    for (const rec of this.byDevice.values()) {
      if (!rec.stopping && now - rec.lastAccessAt >= PREVIEW_IDLE_TIMEOUT_MS) {
        stale.push(rec);
      }
    }
    for (const rec of stale) {
      await this.disposeSession(rec);
    }
  }

  /**
   * Kill a session's ffmpeg (SIGTERM→SIGKILL) and remove its temp dir. Idempotent
   * and never throws. Unregisters the session from both maps.
   */
  private async disposeSession(rec: SessionRecord): Promise<void> {
    if (rec.stopping) return;
    rec.stopping = true;
    // Unregister first so no new HTTP hit / start reuses a dying session.
    if (this.byDevice.get(rec.deviceId) === rec) this.byDevice.delete(rec.deviceId);
    this.byToken.delete(rec.sessionToken);

    const child = rec.child;
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          if (killTimer) clearTimeout(killTimer);
          resolve();
        };
        child.once('exit', done);
        try {
          child.kill('SIGTERM');
        } catch {
          done();
          return;
        }
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          // Give the OS a moment to reap; resolve regardless.
          setTimeout(done, 200);
        }, PREVIEW_SIGKILL_GRACE_MS);
      });
    }

    await safeRmDir(rec.dir);
  }

  /**
   * True once the playlist file exists AND references at least one `.ts`
   * segment — the point at which the browser player can actually start.
   */
  private async playlistHasSegment(playlistPath: string): Promise<boolean> {
    let text: string;
    try {
      text = await fsp.readFile(playlistPath, 'utf8');
    } catch {
      return false;
    }
    // A live HLS playlist lists segment files (…N.ts). Require an actual segment
    // reference (a `.ts` URI line) — a header-only playlist is not yet playable.
    return /^[^#\r\n]*\.ts(\?[^\r\n]*)?\s*$/m.test(text);
  }
}
