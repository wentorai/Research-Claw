/**
 * PlaudManager — mini stdio MCP client (Task 6)
 *
 * Runs against a fake newline-delimited JSON-RPC server (fixtures/fake-mcp-server.cjs)
 * so the suite stays fully offline (never spawns real npx / @plaud-ai/mcp).
 *
 * Covers:
 *  - callTool normal round-trip → {text, isError:false} (init → initialized → call)
 *  - callTool surfaces isError:true from a tool-level error result (Phase2 audit#3)
 *  - callTool timeout → process-group SIGKILL + rejects with 'plaud-mcp timeout'
 *  - callTool tolerates non-JSON noise lines on stdout
 *  - status() tokenPresent=false → no spawn, no account
 *  - status() tokenPresent=true + valid → extracts account, toolsReady
 *  - status() tokenPresent=true + STALE (isError) → explicit failure, toolsReady falsy
 *  - status() swallows spawn errors into lastError (never throws)
 *  - login() four states (Phase2 audit#3): success / stale-token-then-fresh /
 *    timeout(isError) / cancel; success requires isError=false + positive signal,
 *    NOT "token file exists"; spawn-fail; login-in-progress guard
 *  - cancelLogin(): no-op, interrupt in-flight, re-login after cancel
 *  - constants PLAUD_PKG / PLAUD_TOKEN_PATH
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { PlaudManager, PLAUD_PKG, PLAUD_TOKEN_PATH } from '../periph/plaud.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = join(__dirname, 'fixtures', 'fake-mcp-server.cjs');

/** Build a manager wired to the fake server, optionally with extra spawn env / token path. */
function makeManager(opts?: {
  env?: Record<string, string>;
  tokenPath?: string;
}): PlaudManager {
  const args = [FAKE_SERVER];
  // The fake server reads env from process.env; per-call env is threaded via
  // the spawnEnv back-door so each test controls HANG / NOISE independently.
  return new PlaudManager({
    spawnCmd: process.execPath, // node
    spawnArgs: args,
    spawnEnv: opts?.env,
    tokenPath: opts?.tokenPath,
  });
}

describe('PlaudManager constants', () => {
  it('exports the pinned package spec', () => {
    expect(PLAUD_PKG).toBe('@plaud-ai/mcp@0.3.5');
  });

  it('resolves token path under ~/.plaud/tokens-mcp.json', () => {
    expect(PLAUD_TOKEN_PATH).toBe(join(homedir(), '.plaud', 'tokens-mcp.json'));
  });
});

describe('PlaudManager.callTool', () => {
  it('completes a normal round-trip and returns {text, isError:false}', async () => {
    const mgr = makeManager();
    const result = await mgr.callTool('get_current_user', {}, 10_000);
    expect(result.text).toBe('test@wentor.ai');
    expect(result.isError).toBe(false);
  });

  it('returns login tool success text with isError:false', async () => {
    const mgr = makeManager();
    const result = await mgr.callTool('login', {}, 10_000);
    expect(result.text).toBe('Successfully authenticated with Plaud!');
    expect(result.isError).toBe(false);
  });

  // Phase2 audit#3: the tool-level isError flag (sibling of content in the
  // tools/call result) MUST be surfaced — dropping it was the "status errors
  // but re-login succeeds instantly" root cause.
  it('surfaces isError:true from a tool-level error result', async () => {
    const mgr = makeManager({ env: { FAKE_MCP_USER_ERROR: '1' } });
    const result = await mgr.callTool('get_current_user', {}, 10_000);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Failed to get user info/);
  });

  it('tolerates non-JSON noise lines on stdout', async () => {
    const mgr = makeManager({ env: { FAKE_MCP_STDOUT_NOISE: '1' } });
    const result = await mgr.callTool('get_current_user', {}, 10_000);
    expect(result.text).toBe('test@wentor.ai');
    expect(result.isError).toBe(false);
  });

  it('times out and rejects when the server never answers', async () => {
    const mgr = makeManager({ env: { FAKE_MCP_HANG: '1' } });
    await expect(mgr.callTool('get_current_user', {}, 1_500)).rejects.toThrow(/plaud-mcp timeout/);
  });
});

describe('PlaudManager.status', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'plaud-status-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports tokenPresent=false without spawning when no token file exists', async () => {
    const mgr = makeManager({ tokenPath: join(tmpDir, 'tokens-mcp.json') });
    const st = await mgr.status();
    expect(st.tokenPresent).toBe(false);
    expect(st.account).toBeUndefined();
    expect(st.lastError).toBeUndefined();
  });

  it('reports tokenPresent=true and extracts account when token file exists', async () => {
    const tokenPath = join(tmpDir, 'tokens-mcp.json');
    fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'x' }));
    const mgr = makeManager({ tokenPath });
    const st = await mgr.status();
    expect(st.tokenPresent).toBe(true);
    expect(st.account).toBe('test@wentor.ai');
    expect(st.toolsReady).toBe(true);
    expect(st.lastError).toBeUndefined();
  });

  // Phase2 audit#3: a token file that exists but is stale/invalid makes upstream
  // get_current_user return isError:true. status() must report an explicit
  // failure (toolsReady falsy, lastError set) so the UI forces a real re-login —
  // not the old "any tool answer counts as ready" false-positive.
  it('reports explicit failure when the token is present but STALE (isError)', async () => {
    const tokenPath = join(tmpDir, 'tokens-mcp.json');
    fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'stale' }));
    const mgr = makeManager({ tokenPath, env: { FAKE_MCP_USER_ERROR: '1' } });
    const st = await mgr.status();
    expect(st.tokenPresent).toBe(true);
    expect(st.account).toBeUndefined();
    expect(st.toolsReady).toBeFalsy();
    expect(st.lastError).toMatch(/Failed to get user info/);
  });

  it('swallows tool errors into lastError and never throws (token present, server hangs)', async () => {
    const tokenPath = join(tmpDir, 'tokens-mcp.json');
    fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'x' }));
    // Short timeout via env is not enough — status uses a fixed 15s. Instead we
    // point at a spawn command that fails immediately so callTool rejects fast.
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: ['-e', 'process.exit(1)'],
      tokenPath,
    });
    const st = await mgr.status();
    expect(st.tokenPresent).toBe(true);
    expect(st.account).toBeUndefined();
    expect(typeof st.lastError).toBe('string');
    expect(st.lastError!.length).toBeGreaterThan(0);
  });
});

describe('PlaudManager.login (terminal-result semantics, Phase2 audit#3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'plaud-login-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // State 1 — success: the login tool returns "Successfully authenticated…"
  // (isError:false). With the token file present, the settle-wait returns
  // immediately and login resolves {ok:true}.
  it('returns {ok:true} on a positive success terminal result', async () => {
    const tokenPath = join(tmpDir, 'tokens-mcp.json');
    fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'x' }));
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: [FAKE_SERVER],
      tokenPath,
    });
    const res = await mgr.login();
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  // A positive MCP result is necessary but not sufficient: the dashboard writes
  // mcp.servers.plaud only after ok=true, so reporting success without the token
  // would strand the card in a configured-but-not-authenticated state.
  it('returns {ok:false} when MCP reports success but the token never lands', async () => {
    const tokenPath = join(tmpDir, 'tokens-mcp.json'); // never written
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: [FAKE_SERVER],
      tokenPath,
      tokenSettleTimeoutMs: 150, // tiny window so the test doesn't stall
    });
    const res = await mgr.login();
    expect(res).toEqual({ ok: false, error: 'token-not-persisted' });
    expect(fs.existsSync(tokenPath)).toBe(false);
  });

  // State 2 — stale token then a fresh successful login: upstream login clears
  // the stale token internally (index.js:43-58) and re-runs OAuth, so from the
  // client's view this is just a success terminal result → {ok:true}.
  it('returns {ok:true} for a fresh login after a stale token (no file fast-path)', async () => {
    const tokenPath = join(tmpDir, 'tokens-mcp.json');
    // A stale token file exists up front; login must NOT short-circuit on it and
    // must instead act on the login tool's (success) terminal result.
    fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'stale' }));
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: [FAKE_SERVER],
      tokenPath,
    });
    const res = await mgr.login();
    expect(res.ok).toBe(true);
  });

  // State 3 — timeout: the login tool returns the auth-timeout text with
  // isError:true. That text contains NO error keyword, so this proves the client
  // keys on isError, not on text matching. Must resolve {ok:false}.
  it('returns {ok:false} on an isError timeout terminal result (no error keyword)', async () => {
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: [FAKE_SERVER],
      spawnEnv: { FAKE_MCP_LOGIN_TIMEOUT: '1' },
      tokenPath: join(tmpDir, 'tokens-mcp.json'),
    });
    const res = await mgr.login();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/i);
  });

  it('returns {ok:false,error} on a denied/error terminal result', async () => {
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: [FAKE_SERVER],
      spawnEnv: { FAKE_MCP_LOGIN_FAIL: '1' },
      tokenPath: join(tmpDir, 'tokens-mcp.json'),
    });
    const res = await mgr.login();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/denied/i);
  });

  it('returns {ok:false,error} when callTool throws (spawn fails)', async () => {
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: ['-e', 'process.exit(1)'],
      tokenPath: join(tmpDir, 'tokens-mcp.json'),
    });
    const res = await mgr.login();
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });

  it('refuses a concurrent login with {ok:false,error:"login-in-progress"}', async () => {
    const tokenPath = join(tmpDir, 'tokens-mcp.json');
    // First login hangs (server never answers) so it stays in-flight; a generous
    // loginTimeoutMs keeps it pending long enough for the concurrent probe.
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: [FAKE_SERVER],
      spawnEnv: { FAKE_MCP_HANG: '1' },
      tokenPath,
      loginTimeoutMs: 5_000,
    });
    const first = mgr.login();
    // Give the first login a tick to register _activeLogin.
    await new Promise((r) => setTimeout(r, 30));
    const second = await mgr.login();
    expect(second.ok).toBe(false);
    expect(second.error).toBe('login-in-progress');

    // Cancel the first so it resolves cleanly and frees the lock.
    await mgr.cancelLogin();
    const firstRes = await first;
    expect(firstRes.ok).toBe(false);
    expect(firstRes.error).toBe('login-cancelled');
  });
});

describe('PlaudManager.cancelLogin (Phase2 audit#3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'plaud-cancel-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns {ok:true} when no login is in flight (no-op)', async () => {
    const mgr = makeManager({ tokenPath: join(tmpDir, 'tokens-mcp.json') });
    const res = await mgr.cancelLogin();
    expect(res.ok).toBe(true);
  });

  // State 4 — cancel: the login tool hangs (server never answers) so login is
  // in-flight; cancelLogin() SIGKILLs the child, callTool rejects, and login
  // maps the cancel to {ok:false,error:"login-cancelled"}.
  it('interrupts an in-flight login → login resolves {ok:false,error:"login-cancelled"}', async () => {
    const tokenPath = join(tmpDir, 'tokens-mcp.json');
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: [FAKE_SERVER],
      spawnEnv: { FAKE_MCP_HANG: '1' },
      tokenPath,
      loginTimeoutMs: 5_000,
    });
    const loginPromise = mgr.login();
    // Let the login tool spawn, then cancel while it's still blocked.
    await new Promise((r) => setTimeout(r, 30));
    const cancelRes = await mgr.cancelLogin();
    expect(cancelRes.ok).toBe(true);

    const res = await loginPromise;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('login-cancelled');
  });

  it('after cancel, a fresh login is accepted (no login-in-progress lock-up)', async () => {
    const tokenPath = join(tmpDir, 'tokens-mcp.json');
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: [FAKE_SERVER],
      spawnEnv: { FAKE_MCP_HANG: '1' },
      tokenPath,
      loginTimeoutMs: 5_000,
    });
    const first = mgr.login();
    await new Promise((r) => setTimeout(r, 30));
    await mgr.cancelLogin();
    const firstRes = await first;
    expect(firstRes.error).toBe('login-cancelled');

    // A new login must not be blocked by a stale _activeLogin. Fresh manager
    // config (no HANG) so the second attempt reaches a success terminal result.
    fs.writeFileSync(tokenPath, JSON.stringify({ access_token: 'x' }));
    const mgr2 = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: [FAKE_SERVER],
      tokenPath,
    });
    const second = await mgr2.login();
    expect(second.ok).toBe(true);
  });
});
