import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const EXAMPLE_CONFIG = path.join(ROOT, 'config', 'openclaw.example.json');
const GITIGNORE = path.join(ROOT, '.gitignore');

const roots: string[] = [];
const children = new Set<ChildProcess>();

const CRASH_BEFORE_TARGET_RENAME = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [ensureFile, targetRaw, ready, ...ensureArgs] = process.argv.slice(1);
const target = path.resolve(targetRaw);
const originalRenameSync = fs.renameSync;
fs.renameSync = function patchedRenameSync(source, destination) {
  if (path.resolve(String(destination)) === target) {
    fs.writeFileSync(ready, JSON.stringify({
      source: path.resolve(String(source)),
      destination: target,
    }) + '\n', { flag: 'wx', mode: 0o600 });
    const signal = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(signal, 0, 0, 1_000);
  }
  return originalRenameSync.apply(fs, arguments);
};
process.argv = [process.execPath, ensureFile, ...ensureArgs];
require(ensureFile);
`;

const CRASH_ENSURE_INTENT_PHASE = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [stagingRaw, phase, ready, ensureFile, ...ensureArgs] = process.argv.slice(1);
const staging = path.resolve(stagingRaw);
const originalOpenSync = fs.openSync;
const originalWriteFileSync = fs.writeFileSync;
const originalWriteSync = fs.writeSync;
const originalFsyncSync = fs.fsyncSync;
let intentFd;
const pause = (actualPhase) => {
  originalWriteFileSync.call(fs, ready, JSON.stringify({ phase: actualPhase, staging }) + '\n', {
    flag: 'wx', mode: 0o600,
  });
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(signal, 0, 0, 1_000);
};
fs.openSync = function patchedOpenSync(candidate, ...args) {
  if (typeof candidate !== 'string' || path.resolve(candidate) !== staging) {
    return originalOpenSync.call(fs, candidate, ...args);
  }
  const descriptor = originalOpenSync.call(fs, candidate, ...args);
  intentFd = descriptor;
  if (phase === 'create') pause('create');
  return descriptor;
};
fs.writeFileSync = function patchedWriteFileSync(destination, data, ...args) {
  if (destination === intentFd && phase === 'partial') {
    const bytes = Buffer.from(data);
    originalWriteSync.call(fs, destination, bytes, 0, Math.max(1, Math.floor(bytes.length / 2)), null);
    pause('partial');
  }
  return originalWriteFileSync.call(fs, destination, data, ...args);
};
fs.fsyncSync = function patchedFsyncSync(descriptor) {
  const result = originalFsyncSync.call(fs, descriptor);
  if (descriptor === intentFd && phase === 'fsync') pause('fsync');
  return result;
};
process.argv = [process.execPath, ensureFile, ...ensureArgs];
require(ensureFile);
`;

type Fixture = ReturnType<typeof makeFixture>;

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  try {
    await Promise.all([...children].map((child) => waitForClose(child, 5_000)));
  } finally {
    children.clear();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture(): {
  root: string;
  configRoot: string;
  project: string;
  global: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ensure-config-crash-'));
  roots.push(root);
  const configRoot = path.join(root, 'config');
  fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(root, 0o700);
    fs.chmodSync(configRoot, 0o700);
  }
  const project = path.join(configRoot, 'openclaw.json');
  const global = path.join(root, 'global-openclaw.json');
  writeJson(project, {
    agents: { defaults: { timeoutSeconds: 300 } },
    gateway: { auth: { token: 'RC_TEST_ENSURE_CRASH_TOKEN' } },
  });
  writeJson(global, {
    agents: { defaults: { compaction: { customInstructions: 'GLOBAL_OPERATOR_INSTRUCTIONS' } } },
  });
  return { root, configRoot, project, global };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function intentPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.ensure-config-intent.json`);
}

function intentStagingPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.ensure-config-intent.staging`);
}

function runArgs(fixture: Fixture, writer: 'migration' | 'inherit'): string[] {
  return writer === 'migration'
    ? [fixture.project]
    : ['--inherit-global-compaction', fixture.project, fixture.global];
}

function runEnsure(fixture: Fixture, writer: 'migration' | 'inherit') {
  return spawnSync(process.execPath, [ENSURE_CONFIG, ...runArgs(fixture, writer)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: {
      PATH: process.env.PATH ?? '',
      RC_CONFIG_TEMPLATE_PATH: EXAMPLE_CONFIG,
    },
  });
}

async function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('ensure-config child close deadline exceeded')), timeoutMs);
    child.once('close', () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

async function crashBeforeTargetRename(
  fixture: Fixture,
  writer: 'migration' | 'inherit',
): Promise<{ intent: any; temp: string }> {
  const ready = path.join(fixture.root, `ready-${crypto.randomUUID()}.json`);
  const child = spawn(process.execPath, [
    '-e', CRASH_BEFORE_TARGET_RENAME,
    ENSURE_CONFIG, fixture.project, ready, ...runArgs(fixture, writer),
  ], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      RC_CONFIG_TEMPLATE_PATH: EXAMPLE_CONFIG,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });
  child.stderr?.on('data', (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null
        && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(ready), `target rename barrier not reached: ${output}`).toBe(true);
    const intentFile = intentPath(fixture.project);
    expect(fs.existsSync(intentFile), 'durable ensure-config intent must precede target temp creation').toBe(true);
    const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
    const temp = path.join(fixture.configRoot, intent.tempName);
    expect(intent).toEqual({
      version: 1,
      target: path.basename(fixture.project),
      tempName: expect.stringMatching(/^\.openclaw[.]json[.][0-9a-f-]{36}[.]tmp$/u),
      payloadBytes: expect.any(Number),
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(fs.existsSync(temp)).toBe(true);
    const bytes = fs.readFileSync(temp);
    expect(bytes.length).toBe(intent.payloadBytes);
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(intent.payloadSha256);
    expect(fs.readFileSync(intentFile).includes(Buffer.from('RC_TEST_ENSURE_CRASH_TOKEN'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(intentFile).mode & 0o7777).toBe(0o600);
      expect(fs.statSync(temp).mode & 0o7777).toBe(0o600);
    }
    return { intent, temp };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForClose(child, 5_000);
    children.delete(child);
  }
}

async function crashAtIntentStaging(
  fixture: Fixture,
  phase: 'create' | 'partial' | 'fsync',
): Promise<void> {
  const ready = path.join(fixture.root, `intent-${phase}-${crypto.randomUUID()}.ready`);
  const staging = intentStagingPath(fixture.project);
  const child = spawn(process.execPath, [
    '-e', CRASH_ENSURE_INTENT_PHASE, staging, phase, ready,
    ENSURE_CONFIG, ...runArgs(fixture, 'migration'),
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', RC_CONFIG_TEMPLATE_PATH: EXAMPLE_CONFIG },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });
  child.stderr?.on('data', (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null
        && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(ready), `ensure intent ${phase} syscall barrier not reached: ${output}`).toBe(true);
    const observation = JSON.parse(fs.readFileSync(ready, 'utf8'));
    expect(observation.phase).toBe(phase);
    expect(path.resolve(observation.staging)).toBe(path.resolve(staging));
    const size = fs.statSync(staging).size;
    if (phase === 'create') expect(size).toBe(0);
    if (phase === 'partial') expect(size).toBeGreaterThan(0);
    if (phase === 'fsync') expect(() => JSON.parse(fs.readFileSync(staging, 'utf8'))).not.toThrow();
    expect(fs.existsSync(intentPath(fixture.project))).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForClose(child, 5_000);
    children.delete(child);
  }
}

describe.skipIf(process.platform === 'win32')('ensure-config authenticated crash residue', () => {
  it.each(['create', 'partial', 'fsync'] as const)(
    'recovers the exact private intent staging residue after a %s crash',
    async (phase) => {
      const fixture = makeFixture();
      const before = fs.readFileSync(fixture.project);
      await crashAtIntentStaging(fixture, phase);
      expect(fs.readFileSync(fixture.project)).toEqual(before);

      const result = runEnsure(fixture, 'migration');
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(intentPath(fixture.project))).toBe(false);
      expect(fs.existsSync(intentStagingPath(fixture.project))).toBe(false);
    },
    30_000,
  );

  it.each(['migration', 'inherit'] as const)(
    'reconciles only the exact durable temp left by the %s writer',
    async (writer) => {
      const fixture = makeFixture();
      const before = fs.readFileSync(fixture.project);
      const unrelated = path.join(fixture.configRoot, '.openclaw.json.unrelated.tmp');
      fs.writeFileSync(unrelated, 'PRESERVE_UNRELATED\n', { mode: 0o600 });

      const { temp } = await crashBeforeTargetRename(fixture, writer);
      expect(fs.readFileSync(fixture.project)).toEqual(before);

      const result = runEnsure(fixture, writer);
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(temp)).toBe(false);
      expect(fs.existsSync(intentPath(fixture.project))).toBe(false);
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('PRESERVE_UNRELATED\n');
      expect(fs.readFileSync(fixture.project)).not.toEqual(before);
      expect(fs.statSync(fixture.project).mode & 0o7777).toBe(0o600);
    },
    45_000,
  );

  it('fails closed and retains a bound temp whose content changed after the crash', async () => {
    const fixture = makeFixture();
    const before = fs.readFileSync(fixture.project);
    const { temp } = await crashBeforeTargetRename(fixture, 'migration');
    const bytes = fs.readFileSync(temp);
    fs.writeFileSync(temp, Buffer.alloc(bytes.length, 0x78), { mode: 0o600 });

    const result = runEnsure(fixture, 'migration');
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(temp)).toBe(true);
    expect(fs.existsSync(intentPath(fixture.project))).toBe(true);
    expect(fs.readFileSync(fixture.project)).toEqual(before);
  }, 30_000);

  it('ignores the default hidden temp and its metadata-only intent in the project config root', () => {
    const ignore = fs.readFileSync(GITIGNORE, 'utf8');
    expect(ignore).toContain('config/.openclaw.json.*.tmp');
    expect(ignore).toContain('config/.openclaw.json.ensure-config-intent.json');
    expect(ignore).toContain('config/.openclaw.json.ensure-config-intent.staging');
  });
});
