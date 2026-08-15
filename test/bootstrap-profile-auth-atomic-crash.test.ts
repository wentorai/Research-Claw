import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts/apply-bootstrap-profile.cjs');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const FAKE_SECRET = 'RC_TEST_ONLY_FAKE_MODEL_KEY';
const require = createRequire(import.meta.url);
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');
const roots: string[] = [];

const AUTH_BEFORE_CREATE_RUNNER = String.raw`
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const [prefix, ready, entry, ...entryArgs] = process.argv.slice(1);
const originalOpenSync = fs.openSync;
const originalWriteFileSync = fs.writeFileSync;
const originalPromiseWriteFile = fsp.writeFile;
const isCandidate = (candidate) => typeof candidate === 'string'
  && path.basename(candidate).startsWith(prefix + '.')
  && path.basename(candidate).endsWith('.tmp');
const pause = (tempPath) => {
  originalWriteFileSync.call(fs, ready, JSON.stringify({ tempPath: path.resolve(tempPath) }) + '\n', {
    flag: 'wx', mode: 0o600,
  });
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(signal, 0, 0, 1_000);
};
fs.openSync = function patchedOpenSync(candidate, ...args) {
  if (isCandidate(candidate)) pause(candidate);
  return originalOpenSync.call(fs, candidate, ...args);
};
fsp.writeFile = async function patchedPromiseWriteFile(candidate, ...args) {
  if (isCandidate(candidate)) pause(candidate);
  return originalPromiseWriteFile.call(fsp, candidate, ...args);
};
process.argv = [process.execPath, entry, ...entryArgs];
require(entry);
`;

const AUTH_INTENT_PHASE_RUNNER = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [finalRaw, stagingRaw, phase, ready, entry, ...entryArgs] = process.argv.slice(1);
const canonical = (candidate) => {
  const absolute = path.resolve(candidate);
  const missing = [path.basename(absolute)];
  let existing = path.dirname(absolute);
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...missing);
};
const final = canonical(finalRaw);
const staging = canonical(stagingRaw);
const originalOpenSync = fs.openSync;
const originalWriteFileSync = fs.writeFileSync;
const originalWriteSync = fs.writeSync;
const originalFsyncSync = fs.fsyncSync;
let intentFd;
let intentPath;
const isIntent = (candidate) => typeof candidate === 'string'
  && [final, staging].includes(path.resolve(candidate));
const pause = (actualPhase) => {
  originalWriteFileSync.call(fs, ready, JSON.stringify({ phase: actualPhase, intentPath }) + '\n', {
    flag: 'wx', mode: 0o600,
  });
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(signal, 0, 0, 1_000);
};
fs.openSync = function patchedOpenSync(candidate, ...args) {
  if (!isIntent(candidate)) return originalOpenSync.call(fs, candidate, ...args);
  intentPath = path.resolve(candidate);
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
process.argv = [process.execPath, entry, ...entryArgs];
require(entry);
`;

type Harness = ReturnType<typeof harness>;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-auth-crash-'));
  roots.push(root);
  const configRoot = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const dataRoot = path.join(root, 'data');
  for (const directory of [configRoot, workspace, stateDir, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const paths = {
    rcRoot: ROOT,
    configPath: path.join(configRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  fs.writeFileSync(paths.configPath, JSON.stringify({
    agents: { defaults: { model: { primary: 'before/model' } } },
    models: { mode: 'merge', providers: {} },
    plugins: { entries: {
      'research-claw-core': { enabled: true, config: {} },
      'dual-model-supervisor': { enabled: false, config: { enabled: false, reviewMode: 'off' } },
    } },
    tools: { deny: [] },
  }), { mode: 0o600 });
  const authPath = path.join(stateDir, 'agents/main/agent/auth-profiles.json');
  fs.mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(authPath, `${JSON.stringify({ version: 1, profiles: {} }, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(paths.globalConfigPath, '{}\n', { mode: 0o600 });
  ensureInitialized({ ...paths, externalStopVerified: true });
  return { root, paths, authPath };
}

function cliArgs(command: string, h: Harness, txId: string): string[] {
  return [
    ENTRY, command,
    '--rc-root', ROOT,
    '--config', h.paths.configPath,
    '--workspace', h.paths.workspace,
    '--state-dir', h.paths.stateDir,
    '--db', h.paths.dbPath,
    '--global-config', h.paths.globalConfigPath,
    '--tx-id', txId,
  ];
}

function stateTransactionRoot(h: Harness, txId: string): string {
  return path.join(h.paths.stateDir, '.rc-bootstrap-transactions', txId);
}

function authTempPrefix(txId: string): string {
  return `.rc-bootstrap-auth-${txId}`;
}

function authTemps(h: Harness, txId: string): string[] {
  const prefix = authTempPrefix(txId);
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`
    + '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$');
  return fs.readdirSync(path.dirname(h.authPath))
    .filter((name) => pattern.test(name))
    .map((name) => path.join(path.dirname(h.authPath), name));
}

function allSecretFiles(root: string): string[] {
  const matches: string[] = [];
  const visit = (target: string) => {
    const metadata = fs.lstatSync(target);
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
      return;
    }
    if (metadata.isFile() && fs.readFileSync(target).includes(FAKE_SECRET)) matches.push(target);
  };
  visit(root);
  return matches.sort();
}

async function stage(h: Harness): Promise<any> {
  return applier.stageProfile({
    ...h.paths,
    capsuleBytes: fs.readFileSync(FIXTURE),
    rcVersion: '0.8.3',
  });
}

async function killAtAuthTemp(h: Harness, txId: string): Promise<string> {
  const ready = path.join(h.root, `auth-temp-${crypto.randomUUID()}.ready`);
  const child = spawn(process.execPath, cliArgs('apply', h, txId), {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
      RC_BOOTSTRAP_FAULT_PAUSE_AFTER: 'auth-temp',
      RC_BOOTSTRAP_FAULT_READY: ready,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const started = Date.now();
  while (!fs.existsSync(ready) && Date.now() - started < 15_000 && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(fs.existsSync(ready), `midpoint not reached: ${stdout}${stderr}`).toBe(true);
  const candidates = authTemps(h, txId);
  expect(candidates).toHaveLength(1);
  const orphan = candidates[0];
  expect(fs.readFileSync(orphan).includes(FAKE_SECRET)).toBe(true);
  if (process.platform !== 'win32') expect(fs.statSync(orphan).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(h.authPath, 'utf8')).not.toContain(FAKE_SECRET);
  const intent = path.join(stateTransactionRoot(h, txId), 'auth-intent.json');
  const intentValue = JSON.parse(fs.readFileSync(intent, 'utf8'));
  const orphanBytes = fs.readFileSync(orphan);
  expect(intentValue).toMatchObject({
    version: 1,
    txId,
    target: 'agents/main/agent/auth-profiles.json',
    tempPrefix: authTempPrefix(txId),
    tempName: path.basename(orphan),
    payloadBytes: orphanBytes.length,
    payloadSha256: crypto.createHash('sha256').update(orphanBytes).digest('hex'),
  });
  expect(fs.readFileSync(intent).includes(FAKE_SECRET)).toBe(false);
  if (process.platform !== 'win32') expect(fs.statSync(intent).mode & 0o777).toBe(0o600);

  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  return orphan;
}

async function killBeforeAuthTempCreate(h: Harness, txId: string): Promise<string> {
  const ready = path.join(h.root, `auth-before-create-${crypto.randomUUID()}.ready`);
  const args = cliArgs('apply', h, txId);
  const child = spawn(process.execPath, [
    '-e', AUTH_BEFORE_CREATE_RUNNER, authTempPrefix(txId), ready, ...args,
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null
        && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(ready), `auth before-create syscall barrier not reached: ${output}`).toBe(true);
    const observation = JSON.parse(fs.readFileSync(ready, 'utf8'));
    const temp = path.resolve(observation.tempPath);
    expect(fs.existsSync(temp)).toBe(false);
    const intentFile = path.join(stateTransactionRoot(h, txId), 'auth-intent.json');
    const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
    expect(intent).toEqual({
      version: 1,
      txId,
      target: 'agents/main/agent/auth-profiles.json',
      tempPrefix: authTempPrefix(txId),
      tempName: path.basename(temp),
      payloadBytes: expect.any(Number),
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    return temp;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('auth child close deadline exceeded')), 5_000);
        child.once('close', () => {
          clearTimeout(deadline);
          resolve();
        });
      });
    }
  }
}

async function killAtAuthIntentPhase(
  h: Harness,
  txId: string,
  phase: 'create' | 'partial' | 'fsync',
): Promise<void> {
  const root = stateTransactionRoot(h, txId);
  const final = path.join(root, 'auth-intent.json');
  const staging = path.join(root, 'auth-intent.staging');
  const ready = path.join(h.root, `auth-intent-${phase}-${crypto.randomUUID()}.ready`);
  const args = cliArgs('apply', h, txId);
  const child = spawn(process.execPath, [
    '-e', AUTH_INTENT_PHASE_RUNNER, final, staging, phase, ready, ...args,
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null
        && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(ready), `auth intent ${phase} syscall barrier not reached: ${output}`).toBe(true);
    const observation = JSON.parse(fs.readFileSync(ready, 'utf8'));
    expect(observation.phase).toBe(phase);
    const actual = path.resolve(observation.intentPath);
    const size = fs.statSync(actual).size;
    if (phase === 'create') expect(size).toBe(0);
    if (phase === 'partial') expect(size).toBeGreaterThan(0);
    if (phase === 'fsync') expect(() => JSON.parse(fs.readFileSync(actual, 'utf8'))).not.toThrow();
    expect(actual).toBe(path.join(fs.realpathSync(path.dirname(staging)), path.basename(staging)));
    expect(fs.existsSync(final)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('auth intent child close deadline exceeded')), 5_000);
        child.once('close', () => {
          clearTimeout(deadline);
          resolve();
        });
      });
    }
  }
}

describe.skipIf(process.platform === 'win32')('OpenClaw auth atomic-writer crash recovery', () => {
  it.each(['create', 'partial', 'fsync'] as const)(
    'recovers a private tx-bound auth intent staging crash at %s before final publication',
    async (phase) => {
      const h = harness();
      const staged = await stage(h);
      const before = fs.readFileSync(h.authPath);

      await killAtAuthIntentPhase(h, staged.txId, phase);

      await expect(applier.rollbackProfile({ ...h.paths, txId: staged.txId }))
        .resolves.toMatchObject({ state: 'rolled-back' });
      expect(fs.readFileSync(h.authPath)).toEqual(before);
    },
    45_000,
  );

  it('durably binds the exact random auth temp before its exclusive create', async () => {
    const h = harness();
    const staged = await stage(h);
    const before = fs.readFileSync(h.authPath);

    const temp = await killBeforeAuthTempCreate(h, staged.txId);

    await expect(applier.rollbackProfile({ ...h.paths, txId: staged.txId }))
      .resolves.toMatchObject({ state: 'rolled-back' });
    expect(fs.existsSync(temp)).toBe(false);
    expect(fs.readFileSync(h.authPath)).toEqual(before);
  }, 30_000);

  it.each(['recover', 'rollback'] as const)(
    'removes only the transaction-bound verified secret temp during %s',
    async (operation) => {
      const h = harness();
      const unrelated = path.join(path.dirname(h.authPath), '.unrelated-user-file.tmp');
      fs.writeFileSync(unrelated, 'preserve me\n', { mode: 0o600 });
      const staged = await stage(h);
      const orphan = await killAtAuthTemp(h, staged.txId);

      if (operation === 'recover') {
        await expect(applier.recoverProfiles(h.paths)).resolves.toMatchObject({
          recovered: expect.arrayContaining([staged.txId]),
        });
      } else {
        await expect(applier.rollbackProfile({ ...h.paths, txId: staged.txId }))
          .resolves.toMatchObject({ state: 'rolled-back' });
      }

      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('preserve me\n');
      expect(allSecretFiles(h.root)).toEqual([]);
      expect(fs.existsSync(stateTransactionRoot(h, staged.txId))).toBe(false);
    },
    30_000,
  );

  it('fails closed without unlinking a transaction temp whose private identity is weakened', async () => {
    const h = harness();
    const staged = await stage(h);
    const orphan = await killAtAuthTemp(h, staged.txId);
    fs.chmodSync(orphan, 0o644);

    await expect(applier.rollbackProfile({ ...h.paths, txId: staged.txId }))
      .rejects.toMatchObject({ code: 'INVALID_AUTH_TEMP' });
    expect(fs.existsSync(orphan)).toBe(true);
    expect(fs.existsSync(stateTransactionRoot(h, staged.txId))).toBe(true);
    expect(fs.readFileSync(h.authPath, 'utf8')).not.toContain(FAKE_SECRET);
  }, 30_000);

  it('leaves exactly one canonical key copy after crash recovery and a successful retry commit', async () => {
    const h = harness();
    const interrupted = await stage(h);
    await killAtAuthTemp(h, interrupted.txId);
    await applier.recoverProfiles(h.paths);

    const retry = await stage(h);
    await applier.applyProfile({ ...h.paths, txId: retry.txId });
    await applier.verifyProfile({ ...h.paths, txId: retry.txId });
    await applier.commitProfile({ ...h.paths, txId: retry.txId });

    expect(authTemps(h, retry.txId)).toEqual([]);
    expect(allSecretFiles(h.root)).toEqual([h.authPath]);
    expect(fs.readFileSync(h.authPath, 'utf8').match(new RegExp(FAKE_SECRET, 'g'))).toHaveLength(1);
  }, 60_000);

  it('does not expose the auth midpoint pause in production mode', async () => {
    const h = harness();
    const staged = await stage(h);
    const ready = path.join(h.root, 'production-auth-temp.ready');
    const child = spawn(process.execPath, cliArgs('apply', h, staged.txId), {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
        RC_BOOTSTRAP_FAULT_PAUSE_AFTER: 'auth-temp',
        RC_BOOTSTRAP_FAULT_READY: ready,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    expect(exit.code, `${exit.stdout}${exit.stderr}`).toBe(0);
    expect(fs.existsSync(ready)).toBe(false);
    expect(authTemps(h, staged.txId)).toEqual([]);
  }, 30_000);
});
