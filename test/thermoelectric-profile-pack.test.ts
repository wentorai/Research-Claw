import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROFILE_ROOT = path.join(ROOT, 'profiles', 'fixtures', 'thermoelectric-user-a');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-profile-pack.mjs');
const PROBE = path.join(ROOT, 'scripts', 'probe-thermoelectric-profile-skills.mjs');

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for probe state');
}

describe('thermoelectric-user-a Profile Pack', () => {
  it('passes the canonical Capsule and Skill source validator', () => {
    const raw = execFileSync(process.execPath, [VALIDATOR, PROFILE_ROOT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const result = JSON.parse(raw) as {
      profileId: string;
      skillCount: number;
      fileCount: number;
      totalContentBytes: number;
      capsuleDigest: string;
      fakeSecretOnly: boolean;
    };

    expect(result).toMatchObject({
      profileId: 'thermoelectric-user-a',
      skillCount: 3,
      fakeSecretOnly: true,
    });
    expect(result.fileCount).toBeGreaterThanOrEqual(12);
    expect(result.fileCount).toBeLessThanOrEqual(100);
    expect(result.totalContentBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.capsuleDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches the strict Capsule v1 invariants shared with the redeem API', () => {
    const capsule = JSON.parse(
      fs.readFileSync(path.join(PROFILE_ROOT, 'capsule.json'), 'utf8'),
    ) as Record<string, any>;
    expect(Object.keys(capsule).sort()).toEqual([
      'model', 'policy', 'profile', 'schemaVersion', 'secrets', 'skills',
    ]);
    expect(capsule.profile).toEqual({
      id: 'thermoelectric-user-a',
      revision: 1,
      requiredRcVersion: '0.8.3',
    });
    const baseUrl = new URL(capsule.model.baseUrl);
    expect(baseUrl.protocol).toBe('https:');
    expect(baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash).toBe('');
    expect(capsule.model.model.input).toEqual(['text']);
    expect(capsule.model.model.maxTokens).toBeLessThanOrEqual(capsule.model.model.contextWindow);
    expect(capsule.policy).toEqual({
      capabilities: {
        peripherals: 'disabled',
        supervisor: 'enabled-hidden',
        settings: 'enabled-hidden',
        extensions: 'enabled-hidden',
      },
      supervisor: { reviewMode: 'correct', inheritPrimaryModel: true },
    });
  });

  it('contains no default-scan copy of the three Profile Skills', () => {
    const slugs = [
      'research-thermoelectric-semiconductors',
      'develop-flexible-bismuth-telluride',
      'engineer-gete-thermoelectrics',
    ];
    for (const root of [path.join(ROOT, 'skills'), path.join(ROOT, 'workspace', 'skills')]) {
      for (const slug of slugs) {
        expect(fs.existsSync(path.join(root, slug))).toBe(false);
      }
    }
  });

  it('is discovered and selected by real OpenClaw 2026.6.1 tasks', () => {
    const raw = execFileSync(process.execPath, [PROBE, PROFILE_ROOT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const result = JSON.parse(raw) as {
      openClawVersion: string;
      ordinaryInventory: string[];
      profileInventory: Array<{ name: string; source: string }>;
      taskSelections: Array<{ expectedSkill: string; readSkill: string; readReference: string }>;
      cleanup: string;
    };

    expect(result.openClawVersion).toBe('2026.6.1');
    expect(result.ordinaryInventory).toEqual([]);
    expect(result.profileInventory).toEqual([
      { name: 'develop-flexible-bismuth-telluride', source: 'openclaw-workspace' },
      { name: 'engineer-gete-thermoelectrics', source: 'openclaw-workspace' },
      { name: 'research-thermoelectric-semiconductors', source: 'openclaw-workspace' },
    ]);
    expect(result.taskSelections.map((item) => item.expectedSkill)).toEqual([
      'research-thermoelectric-semiconductors',
      'develop-flexible-bismuth-telluride',
      'engineer-gete-thermoelectrics',
    ]);
    for (const selection of result.taskSelections) {
      expect(selection.readSkill).toBe(selection.expectedSkill);
      expect(selection.readReference).toMatch(/^references\/[a-z0-9-]+\.md$/);
    }
    expect(result.cleanup).toBe('clean');
  }, 95_000);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`kills active OpenClaw children and removes state on ${signal}`, async () => {
      if (process.platform === 'win32') return;
      const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-t03-signal-test-'));
      const readyFile = path.join(controlRoot, 'ready.json');
      const child = spawn(process.execPath, [PROBE, PROFILE_ROOT], {
        cwd: ROOT,
        env: { ...process.env, RC_T03_PROBE_READY_FILE: readyFile },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      try {
        await waitFor(() => {
          if (!fs.existsSync(readyFile)) return false;
          const state = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as { childPids: number[] };
          return state.childPids.length > 0;
        });
        const before = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as { tempRoot: string; childPids: number[] };
        child.kill(signal);
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
        });
        expect(exit.code).toBe(signal === 'SIGINT' ? 130 : 143);
        expect(exit.signal).toBeNull();
        expect(fs.existsSync(before.tempRoot)).toBe(false);
        expect(before.childPids.some(pidAlive)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        fs.rmSync(controlRoot, { recursive: true, force: true });
      }
      expect(stderr).toBe('');
    }, 30_000);
  }

  it('kills a timed-out OpenClaw child and removes temporary state', () => {
    const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-t03-timeout-test-'));
    const readyFile = path.join(controlRoot, 'ready.json');
    try {
      expect(() => execFileSync(process.execPath, [PROBE, PROFILE_ROOT], {
        cwd: ROOT,
        env: { ...process.env, RC_T03_PROBE_READY_FILE: readyFile, RC_T03_PROBE_CLI_TIMEOUT_MS: '5' },
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })).toThrow(/OpenClaw CLI timed out/);
      const state = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as { tempRoot: string; childPids: number[] };
      expect(fs.existsSync(state.tempRoot)).toBe(false);
      expect(state.childPids.some(pidAlive)).toBe(false);
    } finally {
      fs.rmSync(controlRoot, { recursive: true, force: true });
    }
  }, 35_000);
});
