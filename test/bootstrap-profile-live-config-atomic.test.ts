import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts/apply-bootstrap-profile.cjs');
const APPLIER_MODULE = path.join(ROOT, 'scripts/bootstrap-profile/applier.cjs');
const CAPSULE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const require = createRequire(import.meta.url);
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

type Harness = ReturnType<typeof makeHarness>;
type ConfigKind = 'project' | 'global';

const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  try {
    await Promise.all([...children].map((child) => waitForChildClose(child, 5_000)));
  } finally {
    children.clear();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  }
});

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('child close deadline exceeded')), timeoutMs);
    child.once('close', () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-live-config-'));
  roots.push(root);
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  const configRoot = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const dataRoot = path.join(root, 'data');
  for (const directory of [configRoot, workspace, stateDir, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  const paths = {
    rcRoot: ROOT,
    configPath: path.join(configRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  writeJson(paths.configPath, {
    agents: { defaults: { model: { primary: 'user/model' } } },
    models: { mode: 'merge', providers: {} },
    plugins: { entries: {
      'research-claw-core': { enabled: true, config: { userBait: 'PROJECT_PRIVATE_BAIT' } },
      'dual-model-supervisor': {
        enabled: false, config: { enabled: false, reviewMode: 'off' },
      },
    } },
    tools: { deny: [] },
  });
  writeJson(paths.globalConfigPath, { userGlobalBait: 'GLOBAL_PRIVATE_BAIT' });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1, profiles: {},
  });
  ensureInitialized({ ...paths, externalStopVerified: true });
  return { root, paths };
}

async function stage(harness: Harness): Promise<any> {
  return applier.stageProfile({
    ...harness.paths,
    capsuleBytes: fs.readFileSync(CAPSULE),
    rcVersion: '0.8.3',
  });
}

function cliArgs(harness: Harness, txId: string): string[] {
  return [
    ENTRY, 'apply',
    '--rc-root', ROOT,
    '--config', harness.paths.configPath,
    '--workspace', harness.paths.workspace,
    '--state-dir', harness.paths.stateDir,
    '--db', harness.paths.dbPath,
    '--global-config', harness.paths.globalConfigPath,
    '--tx-id', txId,
  ];
}

function markerRoot(harness: Harness, txId: string, kind: ConfigKind): string {
  return kind === 'project'
    ? path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap/transactions', txId)
    : path.join(harness.paths.stateDir, '.rc-bootstrap-transactions', txId);
}

function targetFor(harness: Harness, kind: ConfigKind): string {
  return kind === 'project' ? harness.paths.configPath : harness.paths.globalConfigPath;
}

function configTempPrefix(txId: string, kind: ConfigKind): string {
  return `.rc-bootstrap-live-config-${txId}-${kind}`;
}

function configTemps(harness: Harness, txId: string, kind: ConfigKind): string[] {
  const prefix = `${configTempPrefix(txId, kind)}.`;
  const directory = path.dirname(targetFor(harness, kind));
  return fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
    .map((name) => path.join(directory, name));
}

const LIVE_CONFIG_PHASE_RUNNER = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [targetRaw, prefix, phase, ready, entry, ...entryArgs] = process.argv.slice(1);
const targetParent = fs.realpathSync(path.dirname(path.resolve(targetRaw)));
const target = path.join(targetParent, path.basename(targetRaw));
const originalOpenSync = fs.openSync;
const originalWriteFileSync = fs.writeFileSync;
const originalWriteSync = fs.writeSync;
const originalFsyncSync = fs.fsyncSync;
const originalRenameSync = fs.renameSync;
let tempFd;
let tempPath;
const isCandidate = (candidate) => {
  if (typeof candidate !== 'string') return false;
  const name = path.basename(candidate);
  const candidateParent = fs.realpathSync(path.dirname(path.resolve(candidate)));
  return candidateParent === targetParent
    && name.startsWith(prefix + '.') && name.endsWith('.tmp');
};
const pause = (actualPhase) => {
  const readyTemp = ready + '.tmp';
  originalWriteFileSync.call(fs, readyTemp, JSON.stringify({
    phase: actualPhase,
    tempPath,
    target,
  }) + '\n', { flag: 'wx', mode: 0o600 });
  originalRenameSync.call(fs, readyTemp, ready);
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(signal, 0, 0, 1_000);
};
fs.openSync = function patchedOpenSync(candidate, ...args) {
  if (!isCandidate(candidate)) return originalOpenSync.call(fs, candidate, ...args);
  tempPath = path.resolve(candidate);
  if (phase === 'before-create') pause('before-create');
  const descriptor = originalOpenSync.call(fs, candidate, ...args);
  tempFd = descriptor;
  if (phase === 'zero') pause('zero');
  return descriptor;
};
fs.writeFileSync = function patchedWriteFileSync(destination, data, ...args) {
  if (destination === tempFd && phase === 'partial') {
    const bytes = Buffer.from(data);
    const count = Math.max(1, Math.floor(bytes.length / 2));
    originalWriteSync.call(fs, destination, bytes, 0, count, null);
    pause('partial');
  }
  return originalWriteFileSync.call(fs, destination, data, ...args);
};
fs.fsyncSync = function patchedFsyncSync(descriptor) {
  const result = originalFsyncSync.call(fs, descriptor);
  if (descriptor === tempFd && phase === 'fsync') pause('fsync');
  return result;
};
fs.renameSync = function patchedRenameSync(source, destination) {
  const matches = tempPath && path.resolve(String(source)) === tempPath
    && path.resolve(String(destination)) === target;
  const result = originalRenameSync.call(fs, source, destination);
  if (matches && phase === 'rename') pause('rename');
  return result;
};
process.argv = [process.execPath, entry, ...entryArgs];
require(entry);
`;

type AtomicPhase = 'before-create' | 'zero' | 'partial' | 'fsync' | 'rename';

const LIVE_INTENT_PHASE_RUNNER = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [finalRaw, stagingRaw, phase, ready, entry, ...entryArgs] = process.argv.slice(1);
const canonical = (candidate) => path.join(
  fs.realpathSync(path.dirname(path.resolve(candidate))), path.basename(candidate),
);
const final = canonical(finalRaw);
const staging = canonical(stagingRaw);
const originalOpenSync = fs.openSync;
const originalWriteFileSync = fs.writeFileSync;
const originalWriteSync = fs.writeSync;
const originalFsyncSync = fs.fsyncSync;
const originalRenameSync = fs.renameSync;
let intentFd;
let intentPath;
const isIntent = (candidate) => typeof candidate === 'string'
  && [final, staging].includes(path.resolve(candidate));
const pause = (actualPhase) => {
  const readyTemp = ready + '.tmp';
  originalWriteFileSync.call(fs, readyTemp, JSON.stringify({
    phase: actualPhase,
    intentPath,
    final,
    staging,
  }) + '\n', { flag: 'wx', mode: 0o600 });
  originalRenameSync.call(fs, readyTemp, ready);
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

type IntentPhase = 'create' | 'partial' | 'fsync';

async function killAtLiveIntentPhase(
  harness: Harness,
  txId: string,
  phase: IntentPhase,
): Promise<void> {
  const marker = markerRoot(harness, txId, 'project');
  const final = path.join(marker, 'live-config-project-intent.json');
  const staging = path.join(marker, 'live-config-project-intent.staging');
  const ready = path.join(harness.root, `live-intent-${phase}-${crypto.randomUUID()}.ready`);
  const args = cliArgs(harness, txId);
  const child = spawn(process.execPath, [
    '-e', LIVE_INTENT_PHASE_RUNNER, final, staging, phase, ready, ...args,
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '' },
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
    expect(fs.existsSync(ready), `live intent ${phase} syscall barrier not reached: ${output}`).toBe(true);
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
    await waitForChildClose(child, 5_000);
    children.delete(child);
  }
}

async function killAtLiveConfigPhase(
  harness: Harness,
  txId: string,
  phase: AtomicPhase,
): Promise<{ intent: any; temp: string }> {
  const ready = path.join(harness.root, `project-${phase}-${crypto.randomUUID()}.ready`);
  const args = cliArgs(harness, txId);
  const child = spawn(process.execPath, [
    '-e', LIVE_CONFIG_PHASE_RUNNER,
    harness.paths.configPath, configTempPrefix(txId, 'project'), phase, ready,
    ...args,
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '' },
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
    expect(fs.existsSync(ready), `live-config ${phase} syscall barrier not reached: ${output}`).toBe(true);
    const observation = JSON.parse(fs.readFileSync(ready, 'utf8'));
    expect(observation.phase).toBe(phase);
    const temp = path.resolve(observation.tempPath);
    const intentFile = path.join(
      markerRoot(harness, txId, 'project'), 'live-config-project-intent.json',
    );
    const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
    expect(intent).toEqual({
      version: 1,
      txId,
      kind: 'project',
      target: 'openclaw.json',
      tempPrefix: configTempPrefix(txId, 'project'),
      tempName: path.basename(temp),
      payloadBytes: expect.any(Number),
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    if (phase === 'before-create') {
      expect(fs.existsSync(temp)).toBe(false);
    } else if (phase === 'zero') {
      expect(fs.statSync(temp).size).toBe(0);
    } else if (phase === 'partial') {
      expect(fs.statSync(temp).size).toBeGreaterThan(0);
      expect(fs.statSync(temp).size).toBeLessThan(intent.payloadBytes);
    } else if (phase === 'fsync') {
      const bytes = fs.readFileSync(temp);
      expect(bytes.length).toBe(intent.payloadBytes);
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(intent.payloadSha256);
    } else {
      expect(fs.existsSync(temp)).toBe(false);
      const bytes = fs.readFileSync(harness.paths.configPath);
      expect(bytes.length).toBe(intent.payloadBytes);
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(intent.payloadSha256);
    }
    return { intent, temp };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForChildClose(child, 5_000);
    children.delete(child);
  }
}

async function killAtConfigTemp(harness: Harness, txId: string, kind: ConfigKind): Promise<string> {
  const ready = path.join(harness.root, `${kind}-${crypto.randomUUID()}.ready`);
  const child = spawn(process.execPath, cliArgs(harness, txId), {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
      RC_BOOTSTRAP_FAULT_PAUSE_AFTER: `live-config-${kind}-temp`,
      RC_BOOTSTRAP_FAULT_READY: ready,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });
  child.stderr?.on('data', (chunk) => { output += chunk; });
  let temp = '';
  try {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null
        && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(ready), `live-config midpoint not reached: ${output}`).toBe(true);
    const temps = configTemps(harness, txId, kind);
    expect(temps).toHaveLength(1);
    [temp] = temps;
    const tempBytes = fs.readFileSync(temp);
    const intentFile = path.join(markerRoot(harness, txId, kind), `live-config-${kind}-intent.json`);
    const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
    expect(intent).toMatchObject({
      version: 1,
      txId,
      kind,
      target: 'openclaw.json',
      tempPrefix: configTempPrefix(txId, kind),
      tempName: path.basename(temp),
      payloadBytes: tempBytes.length,
      payloadSha256: crypto.createHash('sha256').update(tempBytes).digest('hex'),
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(temp).mode & 0o777).toBe(0o600);
      expect(fs.statSync(intentFile).mode & 0o777).toBe(0o600);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForChildClose(child, 5_000);
    children.delete(child);
  }
  return temp;
}

describe.skipIf(process.platform === 'win32')('transaction-bound live config atomic writes', () => {
  it.each(['create', 'partial', 'fsync'] as const)(
    'recovers a private tx-bound project intent staging crash at %s before final publication',
    async (phase) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const before = fs.readFileSync(harness.paths.configPath);

      await killAtLiveIntentPhase(harness, staged.txId, phase);

      await expect(applier.rollbackProfile({ ...harness.paths, txId: staged.txId }))
        .resolves.toMatchObject({ state: 'rolled-back' });
      expect(fs.readFileSync(harness.paths.configPath)).toEqual(before);
    },
    45_000,
  );

  it.each([
    'before-create', 'zero', 'partial', 'fsync', 'rename',
  ] as const)('binds the exact project temp durably across the real %s crash phase', async (phase) => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const before = fs.readFileSync(harness.paths.configPath);

    await killAtLiveConfigPhase(harness, staged.txId, phase);

    await expect(applier.rollbackProfile({ ...harness.paths, txId: staged.txId }))
      .resolves.toMatchObject({ state: 'rolled-back' });
    expect(fs.readFileSync(harness.paths.configPath)).toEqual(before);
    expect(configTemps(harness, staged.txId, 'project')).toEqual([]);
  }, 45_000);

  it.each([
    ['project', 'rollback'],
    ['global', 'recover'],
  ] as const)('recovers only the authenticated %s temp through %s', async (kind, operation) => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const target = targetFor(harness, kind);
    const before = fs.readFileSync(target);
    const unrelated = path.join(path.dirname(target), '.rc-bootstrap-live-config-unrelated.tmp');
    fs.writeFileSync(unrelated, 'PRESERVE_UNRELATED\n', { mode: 0o600 });
    const temp = await killAtConfigTemp(harness, staged.txId, kind);

    if (operation === 'rollback') {
      await expect(applier.rollbackProfile({ ...harness.paths, txId: staged.txId }))
        .resolves.toMatchObject({ state: 'rolled-back' });
    } else {
      await expect(applier.recoverProfiles(harness.paths)).resolves.toMatchObject({
        recovered: expect.arrayContaining([staged.txId]),
      });
    }
    expect(fs.existsSync(temp)).toBe(false);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('PRESERVE_UNRELATED\n');
  }, 45_000);

  it('fails closed and retains evidence when a bound project temp is weakened', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const temp = await killAtConfigTemp(harness, staged.txId, 'project');
    fs.chmodSync(temp, 0o644);
    await expect(applier.rollbackProfile({ ...harness.paths, txId: staged.txId }))
      .rejects.toMatchObject({ code: 'INVALID_LIVE_CONFIG_TEMP' });
    expect(fs.existsSync(temp)).toBe(true);
    expect(fs.existsSync(markerRoot(harness, staged.txId, 'project'))).toBe(true);
  }, 30_000);

  it('keeps every possible hidden project live-config temp ignored by Git', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toContain('config/.rc-bootstrap-live-config-*.tmp');
  });
});

const FSYNC_RUNNER = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [applierFile, optionsBase64, skillsRootRaw, workspaceRaw] = process.argv.slice(1);
const workspace = fs.realpathSync(workspaceRaw);
const skillsParent = fs.realpathSync(path.dirname(skillsRootRaw));
if (skillsParent !== workspace) throw new Error('skills root is outside workspace');
const skillsRoot = path.join(workspace, path.basename(skillsRootRaw));
const descriptorPaths = new Map();
let tracking = false;
let workspaceFsyncedAfterCreation = false;
const originalMkdirSync = fs.mkdirSync;
const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
const originalFsyncSync = fs.fsyncSync;
fs.mkdirSync = function patchedMkdirSync(target, options) {
  const resolved = path.resolve(String(target));
  const result = originalMkdirSync.call(fs, target, options);
  if (resolved === skillsRoot) tracking = true;
  return result;
};
fs.openSync = function patchedOpenSync(target, ...args) {
  const descriptor = originalOpenSync.call(fs, target, ...args);
  if (tracking && typeof target === 'string') descriptorPaths.set(descriptor, path.resolve(target));
  return descriptor;
};
fs.fsyncSync = function patchedFsyncSync(descriptor) {
  if (tracking && descriptorPaths.get(descriptor) === workspace) workspaceFsyncedAfterCreation = true;
  return originalFsyncSync.call(fs, descriptor);
};
fs.closeSync = function patchedCloseSync(descriptor) {
  try { return originalCloseSync.call(fs, descriptor); }
  finally { descriptorPaths.delete(descriptor); }
};
const applier = require(applierFile);
const options = JSON.parse(Buffer.from(optionsBase64, 'base64').toString('utf8'));
Promise.resolve(applier.applyProfile(options)).then(
  (result) => process.stdout.write(JSON.stringify({
    ok: true,
    state: result.state,
    workspaceFsyncedAfterCreation,
  }) + '\n'),
  (error) => {
    process.stdout.write(JSON.stringify({ ok: false, code: error && error.code }) + '\n');
    process.exitCode = 1;
  },
);
`;

describe('fresh workspace Skills durability', () => {
  it('fsyncs the workspace parent after publishing a newly created skills directory entry', async () => {
    const harness = makeHarness();
    const skillsRoot = path.join(harness.paths.workspace, 'skills');
    expect(fs.existsSync(skillsRoot)).toBe(false);
    const staged = await stage(harness);
    const encoded = Buffer.from(JSON.stringify({ ...harness.paths, txId: staged.txId })).toString('base64');
    const result = spawnSync(process.execPath, [
      '-e', FSYNC_RUNNER, APPLIER_MODULE, encoded, skillsRoot, harness.paths.workspace,
    ], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(payload).toEqual({ ok: true, state: 'applied', workspaceFsyncedAfterCreation: true });
    await applier.rollbackProfile({ ...harness.paths, txId: staged.txId });
  }, 45_000);
});
