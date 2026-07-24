/**
 * PlaudManager — mini stdio MCP client (Task 6)
 *
 * Runs against a fake newline-delimited JSON-RPC server (fixtures/fake-mcp-server.cjs)
 * so the suite stays fully offline (never spawns real npx / @plaud-ai/mcp).
 *
 * Covers:
 *  - callTool normal round-trip (initialize → initialized → tools/call → text)
 *  - callTool timeout → SIGKILL + rejects with 'plaud-mcp timeout'
 *  - callTool tolerates non-JSON noise lines on stdout
 *  - status() tokenPresent=false → no spawn, no account
 *  - status() tokenPresent=true → spawns, extracts account
 *  - status() swallows tool errors into lastError (never throws)
 *  - login() ok / error text / thrown-error paths
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
  it('completes a normal round-trip and returns the text content', async () => {
    const mgr = makeManager();
    const text = await mgr.callTool('get_current_user', {}, 10_000);
    expect(text).toBe('test@wentor.ai');
  });

  it('returns login tool text', async () => {
    const mgr = makeManager();
    const text = await mgr.callTool('login', {}, 10_000);
    expect(text).toBe('Logged in as test@wentor.ai');
  });

  it('tolerates non-JSON noise lines on stdout', async () => {
    const mgr = makeManager({ env: { FAKE_MCP_STDOUT_NOISE: '1' } });
    const text = await mgr.callTool('get_current_user', {}, 10_000);
    expect(text).toBe('test@wentor.ai');
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
    expect(st.lastError).toBeUndefined();
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

describe('PlaudManager.login', () => {
  it('returns {ok:true} on a clean login', async () => {
    const mgr = makeManager();
    const res = await mgr.login();
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('returns {ok:false,error} when the login tool text signals an error', async () => {
    // FAKE_MCP_LOGIN_FAIL makes the login tool return error text; the client
    // must map "Error: ..." semantics to {ok:false}.
    const mgr = makeManager({ env: { FAKE_MCP_LOGIN_FAIL: '1' } });
    const res = await mgr.login();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/login failed/i);
  });

  it('returns {ok:false,error} when callTool throws (spawn fails)', async () => {
    const mgr = new PlaudManager({
      spawnCmd: process.execPath,
      spawnArgs: ['-e', 'process.exit(1)'],
    });
    const res = await mgr.login();
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});
