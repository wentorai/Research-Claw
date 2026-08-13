import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'probe-peripherals-policy-runtime.mjs');
const TEMP_PREFIX = 'rc-t07-peripherals-';
const execFileAsync = promisify(execFile);

function isolatedTempEnv(tempRoot: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = path.join(tempRoot, 'host-home');
  const state = path.join(tempRoot, 'host-state');
  const tmp = path.join(tempRoot, 'host-tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(tempRoot, 'host-xdg-cache'),
    XDG_CONFIG_HOME: path.join(tempRoot, 'host-xdg-config'),
    XDG_DATA_HOME: path.join(tempRoot, 'host-xdg-data'),
    XDG_STATE_HOME: path.join(tempRoot, 'host-xdg-state'),
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    ...extra,
  };
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot',
    'WINDIR', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function probeRoots(tempRoot: string) {
  const tempParent = path.join(tempRoot, 'host-tmp');
  return fs.readdirSync(tempParent).filter((name) => name.startsWith(TEMP_PREFIX));
}

async function waitForReadyMarker(tempRoot: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const roots = probeRoots(tempRoot);
    for (const name of roots) {
      const marker = path.join(tempRoot, 'host-tmp', name, '.signal-test-ready');
      if (!fs.existsSync(marker)) continue;
      const payload = JSON.parse(fs.readFileSync(marker, 'utf8')) as { pid: number };
      return { root: path.join(tempRoot, 'host-tmp', name), workerPid: payload.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('peripherals probe did not reach its post-auth-write checkpoint');
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

describe('OpenClaw 2026.6.1 peripherals policy cold-start contract', () => {
  it('removes and restores peripheral runtime surfaces across complete restarts', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-t07-full-probe-test-'));
    let raw: string;
    try {
      const env = isolatedTempEnv(sandbox);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.HTTPS_PROXY).toBeUndefined();
      const result = await execFileAsync(
        process.execPath,
        [PROBE],
        { cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 10 * 1024 * 1024, env },
      );
      raw = result.stdout;
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
    const result = JSON.parse(raw) as {
      openClawVersion: string;
      coldRestartSequence: string[];
      results: Array<{
        state: string;
        toolInventory: {
          coreCount: number;
          peripheralCount: number;
          allExpectedPresent: boolean;
          plaudMcpTools: string[];
        };
        rpcInventory: { coreCount: number; peripheralCount: number; staleRpc: string };
        prompt: { preservedBefore: boolean; preservedAfter: boolean; peripheralSectionPresent: boolean };
        nonDeviceMonitorRpc: boolean;
        pluginHealthy: boolean;
        rtspTempRootObserved: boolean;
        hlsRoute: string;
        credentialSecretCopies: number;
        authStoreMode: string;
        runtimeBoundary: {
          gateway: string;
          provider: string;
          plaudMcp: string;
          workerUnexpectedEnvNames: string[];
          workerForwardedCredentialOrProxyEnvNames: string[];
          gatewayForwardedCredentialOrProxyEnvNames: string[];
          homeStateAndTmpUnderMkdtemp: boolean;
        };
      }>;
    };

    expect(result.openClawVersion).toBe('2026.6.1');
    expect(result.coldRestartSequence).toEqual(['enabled', 'disabled', 'enabled-hidden']);
    const [enabled, disabled, reenabled] = result.results;
    expect(enabled).toMatchObject({
      state: 'enabled', toolInventory: { coreCount: 57, peripheralCount: 3, allExpectedPresent: true },
      rpcInventory: { coreCount: 151, peripheralCount: 14, staleRpc: 'available' },
      prompt: { preservedBefore: true, preservedAfter: true, peripheralSectionPresent: true },
      nonDeviceMonitorRpc: true, pluginHealthy: true, rtspTempRootObserved: true,
      hlsRoute: 'registered', credentialSecretCopies: 1,
    });
    expect(disabled).toMatchObject({
      state: 'disabled', toolInventory: { coreCount: 54, peripheralCount: 0, allExpectedPresent: false },
      rpcInventory: { coreCount: 137, peripheralCount: 0, staleRpc: 'feature-unavailable' },
      prompt: { preservedBefore: true, preservedAfter: true, peripheralSectionPresent: false },
      nonDeviceMonitorRpc: true, pluginHealthy: true, rtspTempRootObserved: false,
      hlsRoute: 'absent', credentialSecretCopies: 1,
    });
    expect(reenabled).toMatchObject({
      state: 'enabled-hidden', toolInventory: { coreCount: 57, peripheralCount: 3, allExpectedPresent: true },
      rpcInventory: { coreCount: 151, peripheralCount: 14, staleRpc: 'available' },
      prompt: { preservedBefore: true, preservedAfter: true, peripheralSectionPresent: true },
      nonDeviceMonitorRpc: true, pluginHealthy: true, rtspTempRootObserved: true,
      hlsRoute: 'registered', credentialSecretCopies: 1,
    });
    if (process.platform !== 'win32') {
      expect(result.results.every((entry) => entry.authStoreMode === '0600')).toBe(true);
    }
    expect(result.results.map((entry) => entry.runtimeBoundary)).toEqual([
      {
        gateway: 'loopback-websocket', provider: 'loopback-http', plaudMcp: 'absent',
        workerUnexpectedEnvNames: [],
        workerForwardedCredentialOrProxyEnvNames: [],
        gatewayForwardedCredentialOrProxyEnvNames: [], homeStateAndTmpUnderMkdtemp: true,
      },
      {
        gateway: 'loopback-websocket', provider: 'loopback-http', plaudMcp: 'absent',
        workerUnexpectedEnvNames: [],
        workerForwardedCredentialOrProxyEnvNames: [],
        gatewayForwardedCredentialOrProxyEnvNames: [], homeStateAndTmpUnderMkdtemp: true,
      },
      {
        gateway: 'loopback-websocket', provider: 'loopback-http', plaudMcp: 'absent',
        workerUnexpectedEnvNames: [],
        workerForwardedCredentialOrProxyEnvNames: [],
        gatewayForwardedCredentialOrProxyEnvNames: [], homeStateAndTmpUnderMkdtemp: true,
      },
    ]);
  }, 310_000);

  it('documents that Core policy alone cannot suppress OpenClaw bundled Plaud MCP tools', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-t07-plaud-boundary-test-'));
    try {
      const result = await execFileAsync(
        process.execPath,
        [PROBE, '--worker', 'disabled'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 90_000,
          maxBuffer: 10 * 1024 * 1024,
          env: isolatedTempEnv(sandbox, { RC_T07_PROBE_INCLUDE_PLAUD_MCP: '1' }),
        },
      );
      const payload = JSON.parse(result.stdout) as {
        toolInventory: { peripheralCount: number; plaudMcpTools: string[] };
        runtimeBoundary: {
          gateway: string;
          provider: string;
          plaudMcp: string;
          workerUnexpectedEnvNames: string[];
          workerForwardedCredentialOrProxyEnvNames: string[];
          gatewayForwardedCredentialOrProxyEnvNames: string[];
          homeStateAndTmpUnderMkdtemp: boolean;
        };
      };
      expect(payload.toolInventory.peripheralCount).toBe(0);
      expect(payload.toolInventory.plaudMcpTools).toEqual([
        'plaud__get_transcript',
        'plaud__list_files',
      ]);
      expect(payload.runtimeBoundary).toEqual({
        gateway: 'loopback-websocket',
        provider: 'loopback-http',
        plaudMcp: 'local-stdio-fixture',
        workerUnexpectedEnvNames: [],
        workerForwardedCredentialOrProxyEnvNames: [],
        gatewayForwardedCredentialOrProxyEnvNames: [],
        homeStateAndTmpUnderMkdtemp: true,
      });
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 100_000);

  it.skipIf(process.platform === 'win32')('cleans Gateway/provider/state after SIGINT and SIGTERM', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-t07-signal-test-'));
      const child = spawn(process.execPath, [PROBE, '--worker', 'disabled'], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: isolatedTempEnv(sandbox, {
          NODE_ENV: 'test',
          RC_T07_PROBE_PAUSE_AFTER_AUTH_WRITE: '1',
        }),
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      const exit = waitForExit(child);
      try {
        await waitForReadyMarker(sandbox);
        expect(child.kill(signal)).toBe(true);
        expect(await exit).toEqual({ code: signal === 'SIGINT' ? 130 : 143, signal: null });
        expect(stderr).toContain(`interrupted by ${signal}; temporary state cleaned`);
        expect(stderr).not.toContain('t07-explicit-fake-secret');
        expect(probeRoots(sandbox)).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('parent signals terminate the active worker before removing state', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-t07-parent-signal-test-'));
      const child = spawn(process.execPath, [PROBE], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: isolatedTempEnv(sandbox, {
          NODE_ENV: 'test',
          RC_T07_PROBE_PAUSE_AFTER_AUTH_WRITE: '1',
        }),
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      const exit = waitForExit(child);
      try {
        const ready = await waitForReadyMarker(sandbox);
        expect(ready.workerPid).not.toBe(child.pid);
        expect(child.kill(signal)).toBe(true);
        expect(await exit).toEqual({ code: signal === 'SIGINT' ? 130 : 143, signal: null });
        expect(stderr).toContain(`interrupted by ${signal}; temporary state cleaned`);
        expect(probeRoots(sandbox)).toEqual([]);
        expect(() => process.kill(ready.workerPid, 0)).toThrow();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('cleans worker state after the parent timeout boundary', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-t07-timeout-test-'));
    try {
      const result = spawnSync(process.execPath, [PROBE], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 20_000,
        env: isolatedTempEnv(sandbox, {
          NODE_ENV: 'test',
          RC_T07_PROBE_PAUSE_AFTER_AUTH_WRITE: '1',
          RC_T07_PROBE_WORKER_TIMEOUT_MS: '500',
        }),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain('t07-explicit-fake-secret');
      expect(probeRoots(sandbox)).toEqual([]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 25_000);

  it.skipIf(process.platform === 'win32')('cleans credential/state after an ordinary worker failure', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-t07-failure-test-'));
    try {
      const result = spawnSync(process.execPath, [PROBE, '--worker', 'disabled'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 10_000,
        env: isolatedTempEnv(sandbox, {
          NODE_ENV: 'test',
          RC_T07_PROBE_FAULT: 'after-auth-write',
        }),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('injected failure after auth store write');
      expect(result.stderr).not.toContain('t07-explicit-fake-secret');
      expect(probeRoots(sandbox)).toEqual([]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('waits for worker cleanup before surfacing a parent nonzero', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-t07-parent-failure-test-'));
    try {
      const result = spawnSync(process.execPath, [PROBE], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 10_000,
        env: isolatedTempEnv(sandbox, {
          NODE_ENV: 'test',
          RC_T07_PROBE_FAULT: 'after-auth-write',
        }),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain('t07-explicit-fake-secret');
      expect(probeRoots(sandbox)).toEqual([]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
