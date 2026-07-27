/**
 * RTSP→HLS live-preview transmux manager tests (§15 v1.3 场景③ / H1-H6).
 *
 * Tiers:
 *  1. Pure-function units (buildTransmuxArgs) — always run.
 *  2. Deterministic session lifecycle — a FAKE ffmpeg (a small node script wired
 *     via RC_FFMPEG_PATH) writes a rolling HLS playlist + fake .ts segments so we
 *     can exercise start/idempotency/idle-sweep/concurrency-isolation/dispose
 *     WITHOUT a real RTSP source or real ffmpeg. Deterministic + fast.
 *  3. Full MediaMTX end-to-end — gated on RC_RTSP_E2E=1 && docker+ffmpeg. Drives a
 *     real transmux against a real RTSP source; the controller runs it locally
 *     (see e2eEvidence).
 *
 * Credential-boundary (H4) is asserted here too: the sessionToken and all public
 * return values are checked to never contain the URL credentials.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  RtspPreviewManager,
  buildTransmuxArgs,
  PREVIEW_PLAYLIST_NAME,
} from '../periph/rtsp-preview.js';
import { createRtspPreviewRouteHandler } from '../../index.js';
import { RTSP_PREVIEW_ROUTE } from '../periph/rpc.js';

// ── Fake ffmpeg ────────────────────────────────────────────────────────────────
// A tiny node script that impersonates `ffmpeg -f hls … <playlist>`. It parses the
// output playlist path from argv (last arg), then writes a playlist referencing a
// growing set of `.ts` segments every ~150ms until killed. It also creates the
// dummy .ts files so a "GET segment" test can read them. It NEVER exits on its own
// (a live transmux runs until SIGTERM), so the SIGTERM→SIGKILL + cleanup path is
// exercised by disposeSession/stop/destroy.
const FAKE_FFMPEG_SRC = `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const playlist = argv[argv.length - 1];
const dir = path.dirname(playlist);
// A "bad url" simulation: if the args include RC_FAKE_FAIL the process exits early.
if (argv.join(' ').includes('RC_FAKE_FAIL')) { process.exit(1); }
let n = 0;
function tick() {
  n++;
  const idx = Math.max(0, n - 4);
  let body = '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:2\\n#EXT-X-MEDIA-SEQUENCE:' + idx + '\\n';
  for (let i = idx; i < n; i++) {
    const seg = 'seg' + i + '.ts';
    try { fs.writeFileSync(path.join(dir, seg), 'FAKE-TS-' + i); } catch {}
    body += '#EXTINF:2.000,\\n' + seg + '\\n';
  }
  try { fs.writeFileSync(playlist, body); } catch {}
}
tick();
const timer = setInterval(tick, 150);
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
process.stdin.resume();
`;

function writeFakeFfmpeg(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ffmpeg-'));
  const script = path.join(dir, 'fake-ffmpeg.js');
  fs.writeFileSync(script, FAKE_FFMPEG_SRC);
  // A shebang-free wrapper: RC_FFMPEG_PATH must be an executable. Use a shell
  // wrapper that execs node on the script so spawn(ffmpegBin, args) works.
  const wrapper = path.join(dir, 'fake-ffmpeg');
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  return wrapper;
}

function makeBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-rtsp-preview-test-'));
}

// ── Real-ffmpeg probes (E2E only) ───────────────────────────────────────────────
function hasFfmpeg(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
const describeE2E = process.env.RC_RTSP_E2E === '1' && hasFfmpeg() ? describe : describe.skip;

// ── Cleanup registry ────────────────────────────────────────────────────────────
const managers: RtspPreviewManager[] = [];
const tmpDirs: string[] = [];
afterEach(async () => {
  while (managers.length) {
    const m = managers.pop()!;
    await m.destroy();
  }
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

function newManager(): RtspPreviewManager {
  const baseDir = makeBaseDir();
  tmpDirs.push(baseDir);
  // Very frequent sweep so idle-timeout tests do not wait 15s. The idle timeout
  // itself is driven by lastAccessAt manipulation via a short readyTimeout.
  const m = new RtspPreviewManager({ baseDir, sweepIntervalMs: 50 });
  managers.push(m);
  return m;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 1: pure functions
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildTransmuxArgs (H1 transmux, H4 injection)', () => {
  it('uses -c:v copy -c:a copy -f hls with a rolling delete_segments window', () => {
    const args = buildTransmuxArgs('rtsp://host/s', '/tmp/x/index.m3u8');
    expect(args).toContain('copy');
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('hls');
    const flags = args[args.indexOf('-hls_flags') + 1];
    expect(flags).toContain('delete_segments');
    expect(flags).toContain('omit_endlist');
    // -rtsp_transport tcp for reliable grab.
    expect(args[args.indexOf('-rtsp_transport') + 1]).toBe('tcp');
    // The URL is a single array element (shell:false → no injection, H4).
    expect(args).toContain('rtsp://host/s');
    // The playlist path is the LAST arg.
    expect(args[args.length - 1]).toBe('/tmp/x/index.m3u8');
  });

  it('passes a credential-embedding URL as ONE array element (no shell split)', () => {
    const url = 'rtsp://user:p@ss;rm -rf@host/s';
    const args = buildTransmuxArgs(url, '/tmp/x/index.m3u8');
    expect(args).toContain(url); // exactly one element, verbatim
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 2: deterministic session lifecycle (fake ffmpeg)
// ═══════════════════════════════════════════════════════════════════════════════

describe('RtspPreviewManager lifecycle (H1/H2/H4, fake ffmpeg)', () => {
  const CREDS_URL = 'rtsp://alice:s3cr3t@cam.local/stream';

  function withFakeFfmpeg(): () => void {
    const bin = writeFakeFfmpeg();
    const prev = process.env.RC_FFMPEG_PATH;
    process.env.RC_FFMPEG_PATH = bin;
    return () => {
      if (prev === undefined) delete process.env.RC_FFMPEG_PATH;
      else process.env.RC_FFMPEG_PATH = prev;
    };
  }

  it('rejects a non-RTSP URL before spawning ffmpeg', async () => {
    const dir = makeBaseDir();
    tmpDirs.push(dir);
    const marker = path.join(dir, 'spawned.marker');
    const fake = path.join(dir, 'fake-ffmpeg-marker');
    fs.writeFileSync(fake, `#!/bin/sh\n: > "${marker}"\nexit 1\n`, { mode: 0o755 });
    const previous = process.env.RC_FFMPEG_PATH;
    process.env.RC_FFMPEG_PATH = fake;
    try {
      const manager = newManager();
      await expect(
        manager.start('dev-invalid-scheme', {
          url: 'http://127.0.0.1/private',
          readyTimeoutMs: 500,
        }),
      ).rejects.toThrow('preview-start-failed');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RC_FFMPEG_PATH;
      else process.env.RC_FFMPEG_PATH = previous;
    }
  });

  it('start() produces a playlist referencing a .ts segment and a random token', async () => {
    const restore = withFakeFfmpeg();
    try {
      const m = newManager();
      const s = await m.start('dev-1', { url: CREDS_URL, readyTimeoutMs: 4000 });
      expect(s.sessionToken).toMatch(/^[0-9a-f-]{36}$/); // random UUID
      expect(s.deviceId).toBe('dev-1');
      // Playlist exists and references a .ts segment.
      const playlist = await fsp.readFile(path.join(s.dir, PREVIEW_PLAYLIST_NAME), 'utf8');
      expect(playlist).toMatch(/\.ts/);
    } finally {
      restore();
    }
  });

  it('H4: sessionToken + public result NEVER contain the URL credentials', async () => {
    const restore = withFakeFfmpeg();
    try {
      const m = newManager();
      const s = await m.start('dev-cred', { url: CREDS_URL, readyTimeoutMs: 4000 });
      const serialized = JSON.stringify({ token: s.sessionToken, deviceId: s.deviceId });
      expect(serialized).not.toContain('alice');
      expect(serialized).not.toContain('s3cr3t');
      // The playlist body must not carry credentials either.
      const playlist = await fsp.readFile(path.join(s.dir, PREVIEW_PLAYLIST_NAME), 'utf8');
      expect(playlist).not.toContain('alice');
      expect(playlist).not.toContain('s3cr3t');
    } finally {
      restore();
    }
  });

  it('H2: start() is idempotent — repeat start for same device reuses the session', async () => {
    const restore = withFakeFfmpeg();
    try {
      const m = newManager();
      const s1 = await m.start('dev-idem', { url: CREDS_URL, readyTimeoutMs: 4000 });
      const s2 = await m.start('dev-idem', { url: CREDS_URL, readyTimeoutMs: 4000 });
      expect(s2.sessionToken).toBe(s1.sessionToken);
      expect(s2.dir).toBe(s1.dir);
      expect(m.sessionCount).toBe(1); // no second ffmpeg
    } finally {
      restore();
    }
  });

  it('H2: two devices get isolated sessions (independent tokens + dirs)', async () => {
    const restore = withFakeFfmpeg();
    try {
      const m = newManager();
      const a = await m.start('dev-a', { url: 'rtsp://host/a', readyTimeoutMs: 4000 });
      const b = await m.start('dev-b', { url: 'rtsp://host/b', readyTimeoutMs: 4000 });
      expect(a.sessionToken).not.toBe(b.sessionToken);
      expect(a.dir).not.toBe(b.dir);
      expect(m.sessionCount).toBe(2);
      // Each dir is independent — a's playlist is not b's.
      expect(fs.existsSync(path.join(a.dir, PREVIEW_PLAYLIST_NAME))).toBe(true);
      expect(fs.existsSync(path.join(b.dir, PREVIEW_PLAYLIST_NAME))).toBe(true);
    } finally {
      restore();
    }
  });

  it('H1: stop() kills ffmpeg and removes the session dir', async () => {
    const restore = withFakeFfmpeg();
    try {
      const m = newManager();
      const s = await m.start('dev-stop', { url: CREDS_URL, readyTimeoutMs: 4000 });
      expect(fs.existsSync(s.dir)).toBe(true);
      const stopped = await m.stop('dev-stop');
      expect(stopped).toBe(true);
      expect(m.sessionCount).toBe(0);
      expect(fs.existsSync(s.dir)).toBe(false); // temp dir cleaned
      expect(m.getByToken(s.sessionToken)).toBeNull();
    } finally {
      restore();
    }
  });

  it('H1: idle sweep auto-stops a session with no access for the timeout window', async () => {
    const restore = withFakeFfmpeg();
    try {
      // Tiny idle window via a manager whose sweep runs often; we force staleness
      // by NOT touching + waiting past the timeout. Use a short-timeout manager.
      const baseDir = makeBaseDir();
      tmpDirs.push(baseDir);
      const m = new RtspPreviewManager({ baseDir, sweepIntervalMs: 30 });
      managers.push(m);
      const s = await m.start('dev-idle', { url: CREDS_URL, readyTimeoutMs: 4000 });
      expect(m.sessionCount).toBe(1);
      // Age the session past the idle timeout by rewinding lastAccessAt via a
      // second-hand path: sweep() compares against PREVIEW_IDLE_TIMEOUT_MS. We
      // simulate elapsed time by monkeypatching Date.now for the sweep call.
      const realNow = Date.now;
      Date.now = () => realNow() + 61_000;
      try {
        await m.sweep();
      } finally {
        Date.now = realNow;
      }
      expect(m.sessionCount).toBe(0);
      expect(fs.existsSync(s.dir)).toBe(false);
    } finally {
      restore();
    }
  });

  it('H1: touch() refreshes lastAccessAt so an active preview is NOT swept', async () => {
    const restore = withFakeFfmpeg();
    try {
      const m = newManager();
      const s = await m.start('dev-active', { url: CREDS_URL, readyTimeoutMs: 4000 });
      // A touch right now keeps it fresh; a sweep at "now" should not stop it.
      expect(m.touch(s.sessionToken)).toBe(true);
      await m.sweep();
      expect(m.sessionCount).toBe(1);
      // Unknown token → touch returns false.
      expect(m.touch('not-a-token')).toBe(false);
    } finally {
      restore();
    }
  });

  it('H1: destroy() stops ALL sessions + cleans all dirs (gateway shutdown)', async () => {
    const restore = withFakeFfmpeg();
    try {
      const m = newManager();
      const a = await m.start('dev-1', { url: 'rtsp://host/a', readyTimeoutMs: 4000 });
      const b = await m.start('dev-2', { url: 'rtsp://host/b', readyTimeoutMs: 4000 });
      await m.destroy();
      expect(m.sessionCount).toBe(0);
      expect(fs.existsSync(a.dir)).toBe(false);
      expect(fs.existsSync(b.dir)).toBe(false);
      // After destroy, start() is refused.
      await expect(m.start('dev-3', { url: 'rtsp://host/c', readyTimeoutMs: 500 })).rejects.toThrow(
        'preview-start-failed',
      );
    } finally {
      restore();
    }
  });

  it('classifies an ffmpeg that exits immediately as preview-start-failed', async () => {
    const restore = withFakeFfmpeg();
    try {
      const m = newManager();
      // The fake exits early when the URL contains RC_FAKE_FAIL.
      await expect(
        m.start('dev-bad', { url: 'rtsp://host/RC_FAKE_FAIL', readyTimeoutMs: 3000 }),
      ).rejects.toThrow('preview-start-failed');
      expect(m.sessionCount).toBe(0);
    } finally {
      restore();
    }
  });

  it('classifies ffmpeg-missing (bad binary path) as preview-start-failed', async () => {
    const prev = process.env.RC_FFMPEG_PATH;
    process.env.RC_FFMPEG_PATH = '/nonexistent/ffmpeg-binary-xyz';
    try {
      const m = newManager();
      await expect(
        m.start('dev-nobin', { url: 'rtsp://host/s', readyTimeoutMs: 1500 }),
      ).rejects.toThrow('preview-start-failed');
      expect(m.sessionCount).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.RC_FFMPEG_PATH;
      else process.env.RC_FFMPEG_PATH = prev;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3: full MediaMTX end-to-end (gated)
// ═══════════════════════════════════════════════════════════════════════════════

describeE2E('RtspPreviewManager E2E against a real RTSP source (RC_RTSP_E2E=1)', () => {
  const RTSP_URL = process.env.RC_RTSP_E2E_URL || 'rtsp://localhost:8554/test';

  it('transmuxes RTSP→HLS, playlist appears with .ts segments, then cleans up', async () => {
    const m = newManager();
    const s = await m.start('e2e-dev', { url: RTSP_URL, readyTimeoutMs: 15000 });
    const playlist = await fsp.readFile(path.join(s.dir, PREVIEW_PLAYLIST_NAME), 'utf8');
    expect(playlist).toMatch(/\.ts/);
    // A real segment file exists and is a valid MPEG-TS (starts with 0x47 sync).
    const segMatch = playlist.match(/^([^#\r\n]+\.ts)/m);
    expect(segMatch).toBeTruthy();
    const segPath = path.join(s.dir, segMatch![1].trim());
    const buf = await fsp.readFile(segPath);
    expect(buf[0]).toBe(0x47); // MPEG-TS sync byte
    await m.stop('e2e-dev');
    expect(fs.existsSync(s.dir)).toBe(false);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 4: real HTTP end-to-end over the ACTUAL route handler (H3 path guard +
// gateway auth 401/200, §15 v1.3 场景③).
//
// This mounts createRtspPreviewRouteHandler (the EXACT closure index.ts registers
// on GET /rc/rtsp-preview) behind a real http.Server, in front of a gateway-auth
// gate that reproduces OpenClaw's `auth:'gateway'` check (Bearer / x-openclaw-
// password), backed by a REAL RtspPreviewManager session (fake ffmpeg writes a
// real playlist + real .ts segments into the session temp dir). We then drive it
// with the platform `fetch`:
//   • no token           → 401 (auth gate rejects before the handler runs)
//   • valid token + m3u8 → 200 application/vnd.apple.mpegurl (real playlist body)
//   • valid token + .ts  → 200 video/mp2t (real bytes)
//   • ../ traversal      → guard rejects (400/404 — never escapes the session dir)
//   • bad extension .env → 403 FORBIDDEN_EXT
// So H3 (path guard + auth) is proven end-to-end over real HTTP, not just unit.
// This tier is deterministic (fake ffmpeg) so it runs in the default suite.
// ═══════════════════════════════════════════════════════════════════════════════

/** The gateway password the harness auth gate enforces (mirrors OC gateway). */
const E2E_GATEWAY_PASSWORD = 'e2e-secret-password';

/**
 * Reproduce OpenClaw's `auth: 'gateway'` gate: a request is authenticated iff it
 * carries the gateway password as `Authorization: Bearer <pw>` OR the
 * `x-openclaw-password` header. Anything else → 401 before the route handler.
 */
function gatewayAuthOk(req: http.IncomingMessage): boolean {
  const bearer = req.headers['authorization'];
  if (typeof bearer === 'string' && bearer === `Bearer ${E2E_GATEWAY_PASSWORD}`) return true;
  const pw = req.headers['x-openclaw-password'];
  if (typeof pw === 'string' && pw === E2E_GATEWAY_PASSWORD) return true;
  return false;
}

interface HttpHarness {
  base: string;
  close: () => Promise<void>;
}

async function startHttpHarness(manager: RtspPreviewManager): Promise<HttpHarness> {
  const handler = createRtspPreviewRouteHandler({
    getByToken: (token) => manager.getByToken(token),
    touch: (token) => manager.touch(token),
  });
  const server = http.createServer((req, res) => {
    // Gateway auth gate (auth:'gateway') runs BEFORE the plugin route handler.
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('RTSP→HLS HTTP route E2E (H3 path guard + gateway auth, fake ffmpeg)', () => {
  const CREDS_URL = 'rtsp://bob:t0psecret@cam.local/stream';
  let restoreFfmpeg: (() => void) | null = null;
  let harness: HttpHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = null;
    }
    if (restoreFfmpeg) {
      restoreFfmpeg();
      restoreFfmpeg = null;
    }
  });

  async function bootSession(): Promise<{ token: string; base: string; m: RtspPreviewManager }> {
    const bin = writeFakeFfmpeg();
    const prev = process.env.RC_FFMPEG_PATH;
    process.env.RC_FFMPEG_PATH = bin;
    restoreFfmpeg = () => {
      if (prev === undefined) delete process.env.RC_FFMPEG_PATH;
      else process.env.RC_FFMPEG_PATH = prev;
    };
    const m = newManager();
    const s = await m.start('http-e2e', { url: CREDS_URL, readyTimeoutMs: 4000 });
    harness = await startHttpHarness(m);
    return { token: s.sessionToken, base: harness.base, m };
  }

  const authHeaders = { authorization: `Bearer ${E2E_GATEWAY_PASSWORD}` };

  it('no token → 401 (gateway auth rejects before the handler)', async () => {
    const { token, base } = await bootSession();
    const res = await fetch(`${base}${RTSP_PREVIEW_ROUTE}/${token}/${PREVIEW_PLAYLIST_NAME}`);
    expect(res.status).toBe(401);
  });

  it('valid token → 200 serves the real playlist (application/vnd.apple.mpegurl)', async () => {
    const { token, base } = await bootSession();
    const res = await fetch(`${base}${RTSP_PREVIEW_ROUTE}/${token}/${PREVIEW_PLAYLIST_NAME}`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const body = await res.text();
    expect(body).toContain('#EXTM3U');
    expect(body).toMatch(/\.ts/);
    // H4: the served playlist must never carry the URL credentials.
    expect(body).not.toContain('bob');
    expect(body).not.toContain('t0psecret');
  });

  it('valid token → 200 serves a real .ts segment (video/mp2t)', async () => {
    const { token, base } = await bootSession();
    // Discover a real segment name from the playlist the fake ffmpeg wrote.
    const pl = await (
      await fetch(`${base}${RTSP_PREVIEW_ROUTE}/${token}/${PREVIEW_PLAYLIST_NAME}`, { headers: authHeaders })
    ).text();
    const seg = pl.match(/^([^#\r\n]+\.ts)/m)?.[1]?.trim();
    expect(seg).toBeTruthy();
    const res = await fetch(`${base}${RTSP_PREVIEW_ROUTE}/${token}/${seg}`, { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp2t');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('../ traversal to an extension-less file is rejected by the ext allowlist (403)', async () => {
    const { token, base } = await bootSession();
    // Encoded ../ so it survives to the handler rather than being collapsed by the
    // client; target a file that exists outside the session dir.
    const evil = `${base}${RTSP_PREVIEW_ROUTE}/${token}/${encodeURIComponent('../../../../etc/hosts')}`;
    const res = await fetch(evil, { headers: authHeaders });
    expect(res.status).not.toBe(200);
    // /etc/hosts carries no extension, so the allowlist is deterministically the
    // layer that fires — asserting the exact layer keeps this from silently
    // degrading into "some 4xx happened".
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN_EXT');
  });

  it('../ traversal to a REAL .ts outside the session dir is rejected by the path guard (400) and leaks nothing', async () => {
    const { token, base, m } = await bootSession();
    // A whitelisted extension gets past the allowlist, so resolveWithinRoot is
    // the ONLY thing standing between the request and this file. Plant a real
    // one — a probe pointing at a non-existent path could be "rejected" by ENOENT
    // and look identical.
    const sessionDir = m.getByToken(token)?.dir;
    expect(sessionDir).toBeTruthy();
    const secret = 'RC-TRAVERSAL-CANARY-9f3a1c';
    const planted = path.join(path.dirname(sessionDir as string), 'evil.ts');
    fs.writeFileSync(planted, secret);
    try {
      const evil = `${base}${RTSP_PREVIEW_ROUTE}/${token}/${encodeURIComponent('../evil.ts')}`;
      const res = await fetch(evil, { headers: authHeaders });
      expect(res.status).toBe(400);
      const raw = await res.text();
      expect(JSON.parse(raw).error.code).toBe('PATH_ESCAPE');
      expect(raw).not.toContain(secret);
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });

  it('non-whitelisted extension → 403 FORBIDDEN_EXT', async () => {
    const { token, base } = await bootSession();
    const res = await fetch(`${base}${RTSP_PREVIEW_ROUTE}/${token}/secrets.env`, { headers: authHeaders });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN_EXT');
  });

  it('unknown session token → 404 NO_SESSION', async () => {
    const { base } = await bootSession();
    const res = await fetch(`${base}${RTSP_PREVIEW_ROUTE}/not-a-real-token/${PREVIEW_PLAYLIST_NAME}`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NO_SESSION');
  });
});

// ── Tier 4b: real ffmpeg + real HTTP (gated) — the full 401/200 evidence layer ──
describeE2E('RTSP→HLS HTTP route E2E against a REAL transmux (RC_RTSP_E2E=1)', () => {
  const RTSP_URL = process.env.RC_RTSP_E2E_URL || 'rtsp://localhost:8554/test';

  it('real transmux → HTTP 401 (no token) then 200 playlist + real MPEG-TS segment', async () => {
    const m = newManager();
    const s = await m.start('http-real-e2e', { url: RTSP_URL, readyTimeoutMs: 15000 });
    const harness = await startHttpHarness(m);
    try {
      // No token → 401.
      const unauth = await fetch(`${harness.base}${RTSP_PREVIEW_ROUTE}/${s.sessionToken}/${PREVIEW_PLAYLIST_NAME}`);
      expect(unauth.status).toBe(401);

      // Authenticated playlist → 200 with a real HLS body.
      const auth = { authorization: `Bearer ${E2E_GATEWAY_PASSWORD}` };
      const plRes = await fetch(
        `${harness.base}${RTSP_PREVIEW_ROUTE}/${s.sessionToken}/${PREVIEW_PLAYLIST_NAME}`,
        { headers: auth },
      );
      expect(plRes.status).toBe(200);
      const pl = await plRes.text();
      expect(pl).toContain('#EXTM3U');

      // Fetch a real segment → 200 with the MPEG-TS sync byte 0x47 at offset 0.
      const seg = pl.match(/^([^#\r\n]+\.ts)/m)?.[1]?.trim();
      expect(seg).toBeTruthy();
      const segRes = await fetch(`${harness.base}${RTSP_PREVIEW_ROUTE}/${s.sessionToken}/${seg}`, {
        headers: auth,
      });
      expect(segRes.status).toBe(200);
      expect(segRes.headers.get('content-type')).toBe('video/mp2t');
      const buf = Buffer.from(await segRes.arrayBuffer());
      expect(buf[0]).toBe(0x47);

      // ../ traversal over real HTTP is still rejected.
      const evil = await fetch(
        `${harness.base}${RTSP_PREVIEW_ROUTE}/${s.sessionToken}/${encodeURIComponent('../evil.ts')}`,
        { headers: auth },
      );
      expect(evil.status).toBe(400);
    } finally {
      await harness.close();
      await m.stop('http-real-e2e');
    }
  }, 30000);
});
