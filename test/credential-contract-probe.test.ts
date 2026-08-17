import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'probe-credential-contract.mjs');
const REAL_SMOKE = path.join(ROOT, 'scripts', 'probe-real-provider-smoke.mjs');
const SYNC = path.join(ROOT, 'scripts', 'sync-global-config.cjs');
const OPENCLAW_PACKAGE = path.join(ROOT, 'node_modules', 'openclaw', 'package.json');
const OPENCLAW_PATCH = path.join(ROOT, 'patches', 'openclaw@2026.6.1.patch');
const TEMP_PREFIX = 'rc-credential-contract-';
const REAL_TEMP_PREFIX = 'rc-real-provider-smoke-';

function isolatedTempEnv(tempRoot: string, extra: NodeJS.ProcessEnv = {}) {
  return {
    PATH: process.env.PATH,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    ...extra,
  };
}

function probeTempEntries(tempRoot: string) {
  return fs.readdirSync(tempRoot).filter(name => name.startsWith(TEMP_PREFIX));
}

async function waitForTempEntry(tempRoot: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeTempEntries(tempRoot).length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('probe did not create its temporary root before the test deadline');
}

async function waitForReadyMarker(tempRoot: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const roots = fs.readdirSync(tempRoot).filter(name => name.startsWith(REAL_TEMP_PREFIX));
    if (roots.some(name => fs.existsSync(path.join(tempRoot, name, '.signal-test-ready')))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('real smoke did not reach its pre-provider signal checkpoint');
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

describe('OpenClaw 2026.6.1 credential contract probe', () => {
  it('never downgrades a user-locked auth profile to literal provider config', () => {
    const patch = fs.readFileSync(OPENCLAW_PATCH, 'utf8');
    expect(patch).toContain(
      'if (requestedProfileIsUserLocked && !preferredProfileId) throw new Error(`USER_LOCKED_AUTH_PROFILE_NOT_FORWARDABLE:${provider}`);',
    );
    expect(patch).toContain(
      'if (!lockedProfile || !lockedProfileProvider || lockedProfileProvider !== runProvider) throw new Error(`USER_LOCKED_AUTH_PROFILE_PROVIDER_MISMATCH:${provider}`);',
    );
    expect(patch).not.toContain(
      '\n+\t\t\t\tif (!lockedProfile || !lockedProfileProvider || lockedProfileProvider !== runProvider) lockedProfileId = void 0;',
    );
  });

  it('uses the same credential for models status --probe and a real embedded agent turn', () => {
    const output = execFileSync(process.execPath, [PROBE], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        PATH: process.env.PATH,
      },
    });
    const result = JSON.parse(output);
    const installedOpenClaw = JSON.parse(fs.readFileSync(OPENCLAW_PACKAGE, 'utf8'));

    expect(result.schema).toBe('research-claw.credential-contract-probe.v1');
    expect(installedOpenClaw.version).toBe('2026.6.1');
    expect(result.openclawVersion).toBe(installedOpenClaw.version);
    if (process.platform === 'win32') {
      expect(result.authStore.permissions).toEqual(expect.objectContaining({
        model: 'windows-acl',
        verified: false,
      }));
      expect(result.authStore.permissions).not.toHaveProperty('mode');
    } else {
      expect(result.authStore.permissions).toEqual({
        model: 'posix-mode',
        verified: true,
        mode: '0600',
      });
    }
    expect(result.results).toEqual([
      expect.objectContaining({ scenario: 'config-only', status: 'ok', statusCredential: 'provider-config' }),
      expect.objectContaining({ scenario: 'profile-only', status: 'ok', statusCredential: 'auth-profile' }),
      expect.objectContaining({ scenario: 'conflict', status: 'ok', statusCredential: 'auth-profile', agentCredential: 'auth-profile' }),
    ]);
    expect(result.failureProbe).toEqual({
      status: expect.not.stringMatching(/^ok$/),
      requestCount: 3,
      retryCounts: [0, 1, 2],
      credential: 'auth-profile',
    });
  }, 90_000);

  it('fails closed when either probe is run against a different OpenClaw version', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-credential-version-gate-'));
    try {
      const scriptsDir = path.join(sandbox, 'scripts');
      const packageDir = path.join(sandbox, 'node_modules', 'openclaw');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), '{"version":"2026.6.2"}\n');

      for (const source of [PROBE, REAL_SMOKE]) {
        const copiedProbe = path.join(scriptsDir, path.basename(source));
        fs.copyFileSync(source, copiedProbe);
        const result = spawnSync(process.execPath, [copiedProbe], {
          cwd: sandbox,
          encoding: 'utf8',
          timeout: 5_000,
          env: { PATH: process.env.PATH },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'OpenClaw version mismatch: expected 2026.6.1, found 2026.6.2',
        );
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('cleans its temp root after SIGTERM and SIGINT', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-credential-signal-test-'));
      const child = spawn(process.execPath, [PROBE], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: isolatedTempEnv(sandbox),
      });
      const stderr: Buffer[] = [];
      child.stderr.on('data', chunk => stderr.push(chunk));
      const exit = waitForExit(child);
      try {
        await waitForTempEntry(sandbox);
        expect(child.kill(signal)).toBe(true);
        const result = await exit;
        expect(result.signal).toBeNull();
        expect(result.code).toBe(signal === 'SIGTERM' ? 143 : 130);
        expect(Buffer.concat(stderr).toString('utf8')).toContain('temporary state cleaned');
        expect(probeTempEntries(sandbox)).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it.skipIf(process.platform === 'win32')(
    'cleans a written synthetic credential after SIGTERM and SIGINT without provider traffic',
    async () => {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-real-smoke-signal-test-'));
        const sourceConfig = path.join(sandbox, 'source-openclaw.json');
        const sourceAuth = path.join(sandbox, 'source-auth-profiles.json');
        const syntheticSecret = 'rc-synthetic-signal-key';
        fs.writeFileSync(sourceConfig, JSON.stringify({
          agents: { defaults: { model: { primary: 'fixture/synthetic' } } },
          models: {
            providers: {
              fixture: {
                baseUrl: 'http://127.0.0.1:1/v1',
                api: 'openai-completions',
                models: [{ id: 'synthetic', name: 'Synthetic signal fixture' }],
              },
            },
          },
          auth: { order: { fixture: ['fixture:managed'] } },
        }));
        fs.writeFileSync(sourceAuth, JSON.stringify({
          version: 1,
          profiles: {
            'fixture:managed': { type: 'api_key', provider: 'fixture', key: syntheticSecret },
          },
        }), { mode: 0o600 });
        fs.chmodSync(sourceAuth, 0o600);

        const child = spawn(process.execPath, [
          REAL_SMOKE,
          '--source-config', sourceConfig,
          '--source-auth-store', sourceAuth,
        ], {
          cwd: ROOT,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: isolatedTempEnv(sandbox, {
            NODE_ENV: 'test',
            RC_REAL_PROVIDER_SMOKE_PAUSE_AFTER_AUTH_WRITE: '1',
          }),
        });
        const stderr: Buffer[] = [];
        child.stderr.on('data', chunk => stderr.push(chunk));
        const exit = waitForExit(child);
        try {
          await waitForReadyMarker(sandbox);
          expect(child.kill(signal)).toBe(true);
          const result = await exit;
          const errorOutput = Buffer.concat(stderr).toString('utf8');
          expect(result.signal).toBeNull();
          expect(result.code).toBe(signal === 'SIGTERM' ? 143 : 130);
          expect(errorOutput).toContain('temporary state cleaned');
          expect(errorOutput).not.toContain(syntheticSecret);
          expect(fs.readdirSync(sandbox).filter(name => name.startsWith(REAL_TEMP_PREFIX))).toEqual([]);
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          fs.rmSync(sandbox, { recursive: true, force: true });
        }
      }
    },
    20_000,
  );

  it('cleans its temp root after an internal CLI timeout', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-credential-timeout-test-'));
    try {
      const result = spawnSync(process.execPath, [PROBE], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 10_000,
        env: isolatedTempEnv(sandbox, { RC_CREDENTIAL_PROBE_CLI_TIMEOUT_MS: '100' }),
      });
      expect(result.status).not.toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.stderr).toContain('models status --probe failed');
      expect(probeTempEntries(sandbox)).toEqual([]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  it('cleans its temp root after an ordinary thrown failure', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-credential-failure-test-'));
    try {
      const result = spawnSync(process.execPath, [PROBE], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 5_000,
        env: isolatedTempEnv(sandbox, {
          NODE_ENV: 'test',
          RC_CREDENTIAL_PROBE_FAULT: 'after-temp-root',
        }),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('injected failure after temporary root creation');
      expect(probeTempEntries(sandbox)).toEqual([]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('pins the current global sync hazard as a transaction asset decision', () => {
    const source = fs.readFileSync(SYNC, 'utf8');
    expect(source).toContain('const overlay = JSON.parse(JSON.stringify(project))');
    expect(source).not.toMatch(/delete\s+[^;\n]*apiKey/);
    expect(source).toContain('const merged = merge(global, overlay)');
  });
});
