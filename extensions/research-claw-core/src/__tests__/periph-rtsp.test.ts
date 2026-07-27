/**
 * RTSP single-frame driver tests (§15-D8 案 A / F6).
 *
 * Three tiers:
 *  1. Pure-function units (redact / buildRtspUrl / classify / isJpegMagic /
 *     credential non-leak) — always run, no external deps.
 *  2. Deterministic ffmpeg subset — gated on `ffmpeg` presence. Exercises the
 *     real spawn/timeout/cleanup/JPEG-magic paths against a controllable source
 *     (an unroutable RTSP port for the failure+cleanup+timeout assertions).
 *  3. Full MediaMTX end-to-end — gated on docker+ffmpeg. Skipped in CI without
 *     docker; the controller runs it locally (see e2eEvidence). It is ALSO
 *     driveable here via RC_RTSP_E2E=1 once a MediaMTX server + push stream are
 *     up on rtsp://localhost:8554/test.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  captureRtspFrame,
  redactRtspCredentials,
  buildRtspUrl,
  classifyRtspFailure,
  isJpegMagic,
  RTSP_DEFAULT_TIMEOUT_MS,
  RTSP_FRAME_MAX_BYTES,
} from '../periph/rtsp.js';

// ── Environment probes ────────────────────────────────────────────────────────

function hasFfmpeg(): boolean {
  const bin = process.env.RC_FFMPEG_PATH || 'ffmpeg';
  try {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

const FFMPEG = hasFfmpeg();
const describeFfmpeg = FFMPEG ? describe : describe.skip;
// Full MediaMTX E2E is opt-in (needs docker + a running server + push stream).
const describeE2E = process.env.RC_RTSP_E2E === '1' && FFMPEG ? describe : describe.skip;

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'periph-rtsp-test-'));
}

async function listJpegs(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir);
  return entries.filter((e) => e.endsWith('.jpg'));
}

// ── Tier 1: pure functions ────────────────────────────────────────────────────

describe('redactRtspCredentials', () => {
  it('masks user:pass@ → ***@', () => {
    expect(redactRtspCredentials('rtsp://alice:s3cr3t@cam.lan:554/stream')).toBe(
      'rtsp://***@cam.lan:554/stream',
    );
  });

  it('masks user-only (no password) userinfo', () => {
    expect(redactRtspCredentials('rtsp://alice@cam.lan/stream')).toBe('rtsp://***@cam.lan/stream');
  });

  it('leaves a credential-free URL unchanged', () => {
    expect(redactRtspCredentials('rtsp://cam.lan:554/stream')).toBe('rtsp://cam.lan:554/stream');
  });

  it('never leaks the password even for a weird/malformed URL', () => {
    const masked = redactRtspCredentials('rtsp://u:PASSW0RD@host/a?x=1');
    expect(masked).not.toContain('PASSW0RD');
    expect(masked).toContain('***@');
  });

  it('handles percent-encoded credentials without leaking the raw secret', () => {
    // encoded pass 'p@ss' → 'p%40ss'
    const masked = redactRtspCredentials('rtsp://u:p%40ss@host/s');
    expect(masked).toBe('rtsp://***@host/s');
    expect(masked).not.toContain('p%40ss');
  });
});

describe('buildRtspUrl', () => {
  it('uses the URL verbatim when it already embeds credentials', () => {
    const url = 'rtsp://embedded:pw@host/s';
    expect(buildRtspUrl({ url, username: 'other', password: 'other' })).toBe(url);
  });

  it('returns the URL unchanged when no separate username is given', () => {
    const url = 'rtsp://host/s';
    expect(buildRtspUrl({ url })).toBe(url);
  });

  it('injects percent-encoded username/password as userinfo', () => {
    const out = buildRtspUrl({ url: 'rtsp://host:554/s', username: 'user@x', password: 'p@ss/word' });
    // '@' → %40, '/' → %2F — host/path stay intact.
    expect(out).toContain('user%40x');
    expect(out).toContain('p%40ss%2Fword');
    expect(out).toContain('@host:554/s');
  });

  it('encoded credentials neutralise injection of a fake host', () => {
    // A malicious username trying to smuggle a host must be encoded, not routed.
    const out = buildRtspUrl({ url: 'rtsp://real.host/s', username: 'a@evil.host', password: 'x' });
    expect(out).toContain('@real.host/s');
    expect(out).not.toContain('@evil.host');
  });

  it.each([
    'file:///etc/passwd',
    'http://127.0.0.1/private',
    'concat:rtsp://cam/one|file:///etc/passwd',
  ])('rejects non-RTSP input before ffmpeg: %s', (url) => {
    expect(() => buildRtspUrl({ url })).toThrow('invalid-url');
  });
});

describe('captureRtspFrame — protocol allowlist', () => {
  it('rejects non-RTSP input before spawning the configured binary', async () => {
    const dir = mkTmp();
    const marker = path.join(dir, 'spawned.marker');
    const fake = path.join(dir, 'fake-ffmpeg');
    fs.writeFileSync(fake, `#!/bin/sh\n: > "${marker}"\nexit 1\n`, { mode: 0o755 });
    const previous = process.env.RC_FFMPEG_PATH;
    process.env.RC_FFMPEG_PATH = fake;
    try {
      const result = await captureRtspFrame({
        url: 'file:///etc/passwd',
        outDir: dir,
        timeoutMs: 1_000,
      });
      expect(result).toEqual({ ok: false, error: 'connect-failed' });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RC_FFMPEG_PATH;
      else process.env.RC_FFMPEG_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('classifyRtspFailure', () => {
  it('classifies 401 as auth-failed', () => {
    expect(classifyRtspFailure('...401 Unauthorized...')).toBe('auth-failed');
  });

  it('classifies connection refused as connect-failed', () => {
    expect(classifyRtspFailure('Connection refused')).toBe('connect-failed');
  });

  it('classifies DNS failure as connect-failed', () => {
    expect(classifyRtspFailure('Failed to resolve hostname nope.invalid')).toBe('connect-failed');
  });

  it('classifies unknown stderr as decode-failed', () => {
    expect(classifyRtspFailure('some other ffmpeg noise')).toBe('decode-failed');
  });

  it('never returns the raw stderr text (only a fixed token)', () => {
    const tokens = ['timeout', 'connect-failed', 'auth-failed', 'decode-failed', 'ffmpeg-missing'];
    const out = classifyRtspFailure('secret-looking-stderr blah');
    expect(tokens).toContain(out);
    expect(out).not.toContain('secret-looking-stderr');
  });
});

describe('isJpegMagic', () => {
  it('true for 0xFFD8 prefix', () => {
    expect(isJpegMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  });
  it('false for PNG magic', () => {
    expect(isJpegMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });
  it('false for a too-short buffer', () => {
    expect(isJpegMagic(Buffer.from([0xff]))).toBe(false);
  });
});

describe('constants', () => {
  it('default timeout is ≤ 15s (guardrail)', () => {
    expect(RTSP_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
  it('frame size cap is a sane positive bound', () => {
    expect(RTSP_FRAME_MAX_BYTES).toBeGreaterThan(0);
  });
});

// ── R2-I2: synchronous spawn failure must SETTLE, never hang ──────────────────
//
// `finish()` clears the hard timeout, so it captures `hardTimer`. When that
// timer was declared with `const` AFTER the spawn try/catch, the catch branch's
// `void finish(...)` hit the temporal dead zone: the ReferenceError became an
// unhandled rejection, the outer Promise never settled (the agent tool hung
// forever), and OpenClaw's unhandled-rejection handler treats a non-transient
// ReferenceError as fatal — process.exit(1) on the gateway.
//
// An argument containing NUL makes child_process.spawn throw SYNCHRONOUSLY
// (ERR_INVALID_ARG_VALUE) — exactly the branch that catch claims to handle.
// No ffmpeg binary is needed: the throw happens in Node's own arg validation.

describe('captureRtspFrame — synchronous spawn failure (R2-I2)', () => {
  const NUL = String.fromCharCode(0);

  it('settles with ffmpeg-missing instead of hanging, and emits no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);

    const dir = mkTmp();
    try {
      const HUNG = Symbol('hung');
      const settled = await Promise.race([
        captureRtspFrame({ url: 'rtsp://host/stream', outDir: `${dir}${NUL}`, timeoutMs: 5_000 }),
        new Promise<symbol>((r) => setTimeout(() => r(HUNG), 2_000)),
      ]);

      expect(settled).not.toBe(HUNG);
      expect(settled).toEqual({ ok: false, error: 'ffmpeg-missing' });

      // Let any deferred rejection surface before asserting on it.
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).toEqual([]);

      // No half-written frame left behind.
      expect(await listJpegs(dir)).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Tier 2: deterministic ffmpeg subset (real spawn, no server) ────────────────

describeFfmpeg('captureRtspFrame — real ffmpeg, failure/timeout/cleanup', () => {
  it('ffmpeg-missing when the ffmpeg binary path does not exist (ENOENT)', async () => {
    const tmp = mkTmp();
    const prev = process.env.RC_FFMPEG_PATH;
    process.env.RC_FFMPEG_PATH = path.join(tmp, 'definitely-not-ffmpeg-xyz');
    try {
      const res = await captureRtspFrame({
        url: 'rtsp://192.0.2.1:8554/x',
        outDir: tmp,
        timeoutMs: 4_000,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('ffmpeg-missing');
      // No frame left behind.
      expect(await listJpegs(tmp)).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.RC_FFMPEG_PATH;
      else process.env.RC_FFMPEG_PATH = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it('enforces the total timeout and cleans up (no residual frame/process)', async () => {
    const tmp = mkTmp();
    try {
      // A likely-unreachable public-ish RTSP-looking host on a discard port so
      // the connect hangs until our hard timer fires. Use a very short timeout.
      const start = Date.now();
      const res = await captureRtspFrame({
        url: 'rtsp://198.51.100.1:9/hang', // TEST-NET-2, discard-ish port
        outDir: tmp,
        timeoutMs: 2_000,
      });
      const elapsed = Date.now() - start;
      expect(res.ok).toBe(false);
      // Must resolve within a small margin of the timeout (not hang for default 15s).
      expect(elapsed).toBeLessThan(8_000);
      expect(['timeout', 'connect-failed']).toContain(res.error);
      expect(await listJpegs(tmp)).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it('credential masking: failure error is a token and never contains the password', async () => {
    const tmp = mkTmp();
    try {
      const res = await captureRtspFrame({
        url: 'rtsp://joe:SUPERSECRET@192.0.2.2:8554/cam',
        outDir: tmp,
        timeoutMs: 3_000,
      });
      expect(res.ok).toBe(false);
      // The returned error must be a fixed classification token, never the URL.
      expect(res.error).not.toContain('SUPERSECRET');
      expect(res.error).not.toContain('joe');
      expect(res.error).not.toContain('192.0.2.2');
      expect(['connect-failed', 'timeout', 'auth-failed', 'decode-failed']).toContain(res.error);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});

// ── Tier 3: full MediaMTX end-to-end (opt-in via RC_RTSP_E2E=1) ────────────────

describeE2E('captureRtspFrame — MediaMTX end-to-end', () => {
  const URL = process.env.RC_RTSP_E2E_URL || 'rtsp://localhost:8554/test';

  it('grabs a valid JPEG frame from a live RTSP stream', async () => {
    const tmp = mkTmp();
    try {
      const res = await captureRtspFrame({ url: URL, outDir: tmp, timeoutMs: 12_000 });
      expect(res.ok).toBe(true);
      expect(res.path).toBeTruthy();
      const buf = await fsp.readFile(res.path!);
      expect(buf.length).toBeGreaterThan(0);
      expect(isJpegMagic(buf)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 25_000);

  it('fails with a classified error on a nonexistent path (no residual frame)', async () => {
    const tmp = mkTmp();
    try {
      const res = await captureRtspFrame({
        url: 'rtsp://localhost:8554/nonexistent',
        outDir: tmp,
        timeoutMs: 8_000,
      });
      expect(res.ok).toBe(false);
      expect(['connect-failed', 'timeout', 'decode-failed', 'auth-failed']).toContain(res.error);
      expect(await listJpegs(tmp)).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 25_000);
});
