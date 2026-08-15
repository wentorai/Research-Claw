import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const MAINTENANCE_LEASE = path.join(ROOT, 'scripts/bootstrap-profile/maintenance-lease.cjs');
const require = createRequire(import.meta.url);
const maintenanceLease: {
  ensureInitialized(options: Paths & { externalStopVerified?: boolean }): unknown;
  initializeAfterConfigVolumeLoss(options: Paths & { externalStopVerified?: boolean }): {
    created: boolean;
    identity: { rootUuid: string };
  };
} = require('../scripts/bootstrap-profile/maintenance-lease.cjs');
const applier: {
  stageProfile(options: Paths & { capsuleBytes: Buffer; rcVersion: string }): Promise<any>;
  applyProfile(options: Paths & { txId: string }): Promise<any>;
  recoverProfiles(options: Paths): Promise<any>;
} = require('../scripts/bootstrap-profile/applier.cjs');

type Paths = {
  rcRoot: string;
  configPath: string;
  workspace: string;
  stateDir: string;
  dbPath: string;
  globalConfigPath: string;
};

type Harness = Paths & { root: string; configRoot: string };

const temporaryRoots: string[] = [];

const PAUSED_RECOVERY_WORKER = String.raw`
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const spec = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
const send = (value) => fs.writeSync(1, JSON.stringify(value) + '\n');
let paused = false;
let raceInjected = false;
const pause = (event) => {
  if (paused || spec.pause !== event) return;
  paused = true;
  send({ event });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
};
const originalMkdirSync = fs.mkdirSync;
fs.mkdirSync = function patchedMkdirSync(target, options) {
  const basename = path.basename(String(target));
  const mkdirRaces = {
    'recovery-stage-empty': '.rc-bootstrap-volume-loss-recovery-stage-v1-',
    'recovery-stage-extra': '.rc-bootstrap-volume-loss-recovery-stage-v1-',
    'locks-stage-empty': '.locks-init-',
    'locks-stage-extra': '.locks-init-',
    'root-authority-stage-empty': '.lock-authority-init-',
    'root-authority-stage-extra': '.lock-authority-init-',
  };
  if (!raceInjected && mkdirRaces[spec.race]
      && basename.startsWith(mkdirRaces[spec.race])) {
    raceInjected = true;
    originalMkdirSync.call(this, target, { mode: 0o700 });
    if (String(spec.race).endsWith('-extra')) {
      fs.writeFileSync(
        path.join(String(target), 'user-owned.txt'), 'preserve me\n', { mode: 0o600 },
      );
    }
  }
  const result = originalMkdirSync.call(this, target, options);
  if (basename.startsWith('.rc-bootstrap-volume-loss-recovery-stage-v1-')) {
    pause('recovery-stage-mkdir');
  }
  if (basename.startsWith('.locks-init-')) pause('staging-directory');
  return result;
};
const recoveryDescriptors = new Map();
const originalOpenSync = fs.openSync;
fs.openSync = function patchedOpenSync(target, flags, mode) {
  const basename = path.basename(String(target));
  const parentBasename = path.basename(path.dirname(String(target)));
  const exclusive = String(flags).includes('x');
  const injectFile = (bytes) => {
    const injected = originalOpenSync.call(this, target, 'wx', 0o600);
    if (bytes.length > 0) fs.writeSync(injected, bytes);
    fs.fsyncSync(injected);
    fs.closeSync(injected);
  };
  if (!raceInjected && spec.race === 'recovery-record-empty'
      && basename === 'recovery.json' && exclusive) {
    raceInjected = true;
    injectFile(Buffer.alloc(0));
  }
  if (!raceInjected && spec.race === 'recovery-record-bad-bytes'
      && basename === 'recovery.json' && exclusive) {
    raceInjected = true;
    injectFile(Buffer.from('not-json\n'));
  }
  if (!raceInjected && ['identity-empty', 'identity-wrong-root'].includes(spec.race)
      && basename === 'identity.json' && parentBasename.startsWith('.locks-init-') && exclusive) {
    raceInjected = true;
    const rootUuid = parentBasename.slice('.locks-init-'.length);
    injectFile(spec.race === 'identity-empty' ? Buffer.alloc(0) : Buffer.from(JSON.stringify({
      version: 1,
      rootUuid: crypto.randomUUID(),
      configBasename: path.basename(spec.configPath),
    }, null, 2) + '\n'));
  }
  if (!raceInjected && ['operation-db-empty', 'operation-db-bad-bytes'].includes(spec.race)
      && basename === 'operation.sqlite' && parentBasename.startsWith('.locks-init-') && exclusive) {
    raceInjected = true;
    injectFile(spec.race === 'operation-db-empty' ? Buffer.alloc(0) : Buffer.from('not-sqlite\n'));
  }
  if (!raceInjected && ['lock-authority-empty', 'lock-authority-wrong-root'].includes(spec.race)
      && basename === 'authority.json' && parentBasename.startsWith('.locks-init-') && exclusive) {
    raceInjected = true;
    const rootUuid = parentBasename.slice('.locks-init-'.length);
    injectFile(spec.race === 'lock-authority-empty' ? Buffer.alloc(0) : Buffer.from(JSON.stringify({
      version: 1,
      rootUuid: crypto.randomUUID(),
      configBasename: path.basename(spec.configPath),
    }, null, 2) + '\n'));
  }
  if (!raceInjected
      && ['outer-authority-next-empty', 'outer-authority-next-bad-bytes'].includes(spec.race)
      && basename === '.authority-next.json' && exclusive) {
    raceInjected = true;
    injectFile(spec.race === 'outer-authority-next-empty'
      ? Buffer.alloc(0) : Buffer.from('not-json\n'));
  }
  if (!raceInjected
      && ['outer-authority-file-empty', 'outer-authority-file-bad-bytes'].includes(spec.race)
      && basename === 'authority.json' && parentBasename.startsWith('.lock-authority-init-')
      && exclusive) {
    raceInjected = true;
    injectFile(spec.race === 'outer-authority-file-empty'
      ? Buffer.alloc(0) : Buffer.from('not-json\n'));
  }
  if (!raceInjected && spec.race === 'placeholder-stage-symlink'
      && basename.startsWith('.config-placeholder-') && String(flags).includes('x')) {
    raceInjected = true;
    fs.symlinkSync(spec.configPath, String(target));
  }
  const descriptor = originalOpenSync.call(this, target, flags, mode);
  if (basename === 'recovery.json') pause('recovery-record-opened');
  if (basename === 'recovery.json') recoveryDescriptors.set(descriptor, 'recovery-record-fsynced');
  if (basename === '.authority-next.json' || /^\.authority-.*\.tmp$/.test(basename)) {
    recoveryDescriptors.set(descriptor, 'outer-authority-next-fsynced');
  }
  return descriptor;
};
const originalFsyncSync = fs.fsyncSync;
fs.fsyncSync = function patchedFsyncSync(descriptor) {
  const result = originalFsyncSync.call(this, descriptor);
  const event = recoveryDescriptors.get(descriptor);
  if (event) pause(event);
  return result;
};
const originalCloseSync = fs.closeSync;
fs.closeSync = function patchedCloseSync(descriptor) {
  recoveryDescriptors.delete(descriptor);
  return originalCloseSync.call(this, descriptor);
};
const originalRenameSync = fs.renameSync;
fs.renameSync = function patchedRenameSync(source, destination) {
  const sourceBasename = path.basename(String(source));
  const destinationBasename = path.basename(String(destination));
  if (!raceInjected && spec.race === 'recovery-marker-rename-self'
      && sourceBasename.startsWith('.rc-bootstrap-volume-loss-recovery-stage-v1-')
      && destinationBasename.startsWith('.rc-bootstrap-volume-loss-recovery-v1-')) {
    raceInjected = true;
    originalRenameSync.call(this, source, destination);
  }
  if (!raceInjected && spec.race === 'recovery-marker-rename-unknown'
      && sourceBasename.startsWith('.rc-bootstrap-volume-loss-recovery-stage-v1-')
      && destinationBasename.startsWith('.rc-bootstrap-volume-loss-recovery-v1-')) {
    raceInjected = true;
    originalMkdirSync.call(fs, destination, { mode: 0o700 });
    fs.writeFileSync(path.join(String(destination), 'user-owned.txt'), 'preserve me\n', { mode: 0o600 });
  }
  if (!raceInjected && spec.race === 'locks-publish-self'
      && sourceBasename.startsWith('.locks-init-') && destinationBasename === 'locks') {
    raceInjected = true;
    originalRenameSync.call(this, source, destination);
  }
  if (!raceInjected && spec.race === 'locks-publish-extra'
      && sourceBasename.startsWith('.locks-init-') && destinationBasename === 'locks') {
    raceInjected = true;
    originalMkdirSync.call(fs, destination, { mode: 0o700 });
    fs.writeFileSync(path.join(String(destination), 'user-owned.txt'), 'preserve me\n', { mode: 0o600 });
  }
  if (!raceInjected && spec.race === 'outer-authority-next-rename-self'
      && sourceBasename === '.authority-next.json' && destinationBasename === 'authority.json') {
    raceInjected = true;
    originalRenameSync.call(this, source, destination);
  }
  if (!raceInjected && spec.race === 'outer-authority-next-rename-bad-bytes'
      && sourceBasename === '.authority-next.json' && destinationBasename === 'authority.json') {
    raceInjected = true;
    fs.unlinkSync(source);
    fs.writeFileSync(source, 'not-json\n', { mode: 0o600 });
  }
  if (!raceInjected && spec.race === 'root-authority-publish-self'
      && destinationBasename === '.rc-bootstrap-lock-authority') {
    raceInjected = true;
    originalRenameSync.call(this, source, destination);
  }
  if (!raceInjected && spec.race === 'root-authority-publish-unknown'
      && destinationBasename === '.rc-bootstrap-lock-authority') {
    raceInjected = true;
    originalMkdirSync.call(fs, destination, { mode: 0o700 });
    fs.writeFileSync(path.join(String(destination), 'user-owned.txt'), 'preserve me\n', { mode: 0o600 });
  }
  if (sourceBasename.startsWith('.rc-bootstrap-volume-loss-recovery-stage-v1-')
      && destinationBasename.startsWith('.rc-bootstrap-volume-loss-recovery-v1-')) {
    pause('before-recovery-marker-rename');
  }
  if ((sourceBasename === '.authority-next.json' || /^\.authority-.*\.tmp$/.test(sourceBasename))
      && destinationBasename === 'authority.json') {
    pause('before-outer-authority-next-rename');
  }
  if (path.basename(String(destination)) === '.rc-bootstrap-lock-authority') {
    pause('before-root-authority');
  }
  if (spec.fault === 'locks-publish-eio'
      && sourceBasename.startsWith('.locks-init-')
      && destinationBasename === 'locks') {
    const error = new Error('injected locks publish failure');
    error.code = 'EIO';
    throw error;
  }
  const result = originalRenameSync.call(this, source, destination);
  if (destinationBasename.startsWith('.rc-bootstrap-volume-loss-recovery-v1-')) {
    pause('recovery-marker');
  }
  if (destinationBasename === 'authority.json'
      && path.basename(path.dirname(String(destination))) === '.rc-bootstrap-lock-authority') {
    try {
      if (JSON.parse(fs.readFileSync(String(destination), 'utf8')).state === 'committed') {
        pause('after-authority-committed');
      }
    } catch {}
  }
  if (destinationBasename === path.basename(spec.configPath)) {
    pause('after-placeholder-publish');
  }
  return result;
};
const originalUnlinkSync = fs.unlinkSync;
fs.unlinkSync = function patchedUnlinkSync(target) {
  const basename = path.basename(String(target));
  if (!raceInjected && spec.race === 'outer-authority-anchor-unlink-self'
      && basename === '.authority-next.anchor') {
    raceInjected = true;
    originalUnlinkSync.call(this, target);
  }
  if (!raceInjected && spec.race === 'outer-authority-anchor-unlink-extra'
      && basename === '.authority-next.anchor') {
    raceInjected = true;
    fs.writeFileSync(
      path.join(path.dirname(String(target)), 'user-owned.txt'), 'preserve me\n', { mode: 0o600 },
    );
  }
  return originalUnlinkSync.call(this, target);
};
try {
  if (Number.isSafeInteger(spec.startAt)) {
    const remaining = spec.startAt - Date.now();
    if (remaining > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
  }
  const lease = require(spec.module);
  lease.initializeAfterConfigVolumeLoss({
    rcRoot: spec.rcRoot,
    configPath: spec.configPath,
    externalStopVerified: true,
  });
  send({ event: 'completed' });
} catch (error) {
  send({ event: 'error', code: error && error.code || null });
  process.exitCode = 2;
}
`;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-config-loss-'));
  temporaryRoots.push(root);
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  const configRoot = path.join(root, 'config-volume');
  const workspace = path.join(root, 'workspace-volume');
  const stateDir = path.join(root, 'state-volume');
  const dataRoot = path.join(root, 'data-volume');
  for (const directory of [configRoot, workspace, stateDir, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  const paths = {
    root,
    configRoot,
    rcRoot: ROOT,
    configPath: path.join(configRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  writeJson(paths.configPath, {
    agents: { defaults: { model: { primary: 'user-provider/user-model' } } },
    models: {
      mode: 'merge',
      providers: {
        'user-provider': {
          baseUrl: 'https://user.invalid/v1',
          api: 'openai-completions',
          models: [],
        },
      },
    },
    plugins: {
      entries: {
        'research-claw-core': { enabled: true, config: { preserve: true } },
        'dual-model-supervisor': {
          enabled: false,
          config: { enabled: false, supervisorModel: 'user/model', reviewMode: 'off' },
        },
      },
    },
    tools: { deny: ['user-rule'] },
  });
  writeJson(paths.globalConfigPath, { userGlobal: true });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1,
    profiles: {
      'user-provider:manual': {
        type: 'api_key',
        provider: 'user-provider',
        key: 'USER_FAKE_KEY',
      },
    },
  });
  fs.mkdirSync(path.join(workspace, 'skills', 'user-skill'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(workspace, 'skills', 'user-skill', 'SKILL.md'),
    '---\nname: user-skill\ndescription: user owned\n---\n',
    { mode: 0o600 },
  );
  maintenanceLease.ensureInitialized({ ...paths, externalStopVerified: true });
  return paths;
}

function treeDigest(target: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (current: string, relative: string): void => {
    if (!fs.existsSync(current)) {
      hash.update(`${relative}:absent;`);
      return;
    }
    const metadata = fs.lstatSync(current);
    const type = metadata.isDirectory() ? 'directory'
      : metadata.isFile() ? 'file'
        : metadata.isSymbolicLink() ? 'symlink' : 'other';
    hash.update(`${relative}:${type}:${metadata.mode & 0o777};`);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), path.join(relative, name));
      }
    } else if (metadata.isFile()) {
      hash.update(fs.readFileSync(current));
    } else if (metadata.isSymbolicLink()) {
      hash.update(fs.readlinkSync(current));
    }
  };
  visit(target, '.');
  return hash.digest('hex');
}

function externalTrees(harness: Harness): Record<string, string> {
  return {
    workspace: treeDigest(harness.workspace),
    state: treeDigest(harness.stateDir),
    data: treeDigest(path.dirname(harness.dbPath)),
  };
}

function liveSatelliteDigest(harness: Harness): string {
  const targets = [
    path.join(harness.workspace, 'skills'),
    path.join(harness.stateDir, 'agents'),
    harness.globalConfigPath,
    path.join(harness.stateDir, 'state/openclaw.sqlite'),
    path.join(harness.stateDir, 'state/openclaw.sqlite-wal'),
    path.join(harness.stateDir, 'state/openclaw.sqlite-shm'),
    harness.dbPath,
    `${harness.dbPath}-wal`,
    `${harness.dbPath}-shm`,
  ];
  return crypto.createHash('sha256')
    .update(JSON.stringify(targets.map((target) => [target, treeDigest(target)])))
    .digest('hex');
}

function transactionRoots(harness: Harness, txId: string): Record<'workspace' | 'state' | 'data', string> {
  return {
    workspace: path.join(harness.workspace, '.rc-bootstrap-transactions', txId),
    state: path.join(harness.stateDir, '.rc-bootstrap-transactions', txId),
    data: path.join(path.dirname(harness.dbPath), '.rc-bootstrap-transactions', txId),
  };
}

function incidentFiles(harness: Harness, txId: string): string[] {
  return [
    path.join(harness.configRoot, '.rc-bootstrap', 'recovery-incidents', `${txId}.json`),
    path.join(harness.workspace, '.rc-bootstrap-recovery-incidents', `${txId}.json`),
    path.join(harness.stateDir, '.rc-bootstrap-recovery-incidents', `${txId}.json`),
    path.join(path.dirname(harness.dbPath), '.rc-bootstrap-recovery-incidents', `${txId}.json`),
  ];
}

function readOuterAuthority(harness: Harness): any {
  return JSON.parse(fs.readFileSync(path.join(
    harness.configRoot,
    '.rc-bootstrap-lock-authority',
    'authority.json',
  ), 'utf8'));
}

function resetToMountedEmptyConfigRoot(harness: Harness): void {
  fs.rmSync(harness.configRoot, { recursive: true, force: true });
  fs.mkdirSync(harness.configRoot, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(harness.configRoot, 0o700);
  expect(fs.readdirSync(harness.configRoot)).toEqual([]);
  expect(fs.existsSync(harness.configPath)).toBe(false);
}

async function createAppliedOrphans(harness: Harness): Promise<{
  txId: string;
  oldRootUuid: string;
  roots: ReturnType<typeof transactionRoots>;
  beforeLive: string;
}> {
  const oldRootUuid = readOuterAuthority(harness).rootUuid as string;
  const beforeLive = liveSatelliteDigest(harness);
  const staged = await applier.stageProfile({
    ...harness,
    capsuleBytes: fs.readFileSync(FIXTURE),
    rcVersion: '0.8.3',
  });
  await applier.applyProfile({ ...harness, txId: staged.txId });
  const roots = transactionRoots(harness, staged.txId);
  for (const root of Object.values(roots)) expect(fs.existsSync(root)).toBe(true);
  resetToMountedEmptyConfigRoot(harness);
  return { txId: staged.txId, oldRootUuid, roots, beforeLive };
}

function initializeRecoveryAuthority(harness: Harness): ReturnType<
  typeof maintenanceLease.initializeAfterConfigVolumeLoss
> {
  return maintenanceLease.initializeAfterConfigVolumeLoss({
    ...harness,
    externalStopVerified: true,
  });
}

function recoveryOwnedEntries(harness: Harness): string[] {
  if (!fs.existsSync(harness.configRoot)) return [];
  return fs.readdirSync(harness.configRoot).sort();
}

async function killPausedRecovery(
  harness: Harness,
  pause: 'recovery-stage-mkdir' | 'recovery-record-fsynced'
    | 'recovery-record-opened'
    | 'before-recovery-marker-rename' | 'recovery-marker'
    | 'after-placeholder-publish' | 'staging-directory'
    | 'before-root-authority' | 'outer-authority-next-fsynced'
    | 'before-outer-authority-next-rename' | 'after-authority-committed',
): Promise<void> {
  const specification = Buffer.from(JSON.stringify({
    module: MAINTENANCE_LEASE,
    rcRoot: harness.rcRoot,
    configPath: harness.configPath,
    pause,
  }), 'utf8').toString('base64url');
  const child = spawn(process.execPath, ['-e', PAUSED_RECOVERY_WORKER, specification], {
    cwd: ROOT,
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `recovery worker did not pause at ${pause}; stdout=${stdout}; stderr=${stderr}`,
    )), 10_000);
    const inspect = () => {
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        try {
          if (JSON.parse(line).event === pause) {
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch {}
      }
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(
        `recovery worker exited before ${pause}; code=${code}; signal=${signal}; stdout=${stdout}; stderr=${stderr}`,
      ));
    });
  });
  expect(child.kill('SIGKILL')).toBe(true);
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  expect(child.signalCode).toBe('SIGKILL');
}

async function runRecoveryWorker(
  harness: Harness,
  startAt: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const specification = Buffer.from(JSON.stringify({
    module: MAINTENANCE_LEASE,
    rcRoot: harness.rcRoot,
    configPath: harness.configPath,
    pause: null,
    startAt,
  }), 'utf8').toString('base64url');
  const child = spawn(process.execPath, ['-e', PAUSED_RECOVERY_WORKER, specification], {
    cwd: ROOT,
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`concurrent recovery worker timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 15_000);
    child.once('exit', (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

async function runFaultedRecovery(
  harness: Harness,
  fault: 'locks-publish-eio',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const specification = Buffer.from(JSON.stringify({
    module: MAINTENANCE_LEASE,
    rcRoot: harness.rcRoot,
    configPath: harness.configPath,
    pause: null,
    fault,
  }), 'utf8').toString('base64url');
  const child = spawn(process.execPath, ['-e', PAUSED_RECOVERY_WORKER, specification], {
    cwd: ROOT,
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`faulted recovery worker timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 10_000);
    child.once('exit', (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

async function runRacedRecovery(
  harness: Harness,
  race: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const specification = Buffer.from(JSON.stringify({
    module: MAINTENANCE_LEASE,
    rcRoot: harness.rcRoot,
    configPath: harness.configPath,
    pause: null,
    race,
  }), 'utf8').toString('base64url');
  const child = spawn(process.execPath, ['-e', PAUSED_RECOVERY_WORKER, specification], {
    cwd: ROOT,
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`raced recovery worker timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 10_000);
    child.once('exit', (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

describe('config-volume loss lock authority boundary', () => {
  it('ordinary recover reports LOCK_AUTHORITY_LOST and leaves all satellite bytes untouched', async () => {
    const harness = makeHarness();
    const { roots } = await createAppliedOrphans(harness);
    const before = externalTrees(harness);

    await expect(applier.recoverProfiles(harness))
      .rejects.toMatchObject({ code: 'LOCK_AUTHORITY_LOST' });

    expect(externalTrees(harness)).toEqual(before);
    for (const root of Object.values(roots)) expect(fs.existsSync(root)).toBe(true);
    expect(fs.readdirSync(harness.configRoot)).toEqual([]);
  });

  it('requires an external stop proof before it creates any replacement authority', async () => {
    const harness = makeHarness();
    const { roots } = await createAppliedOrphans(harness);
    const before = externalTrees(harness);

    expect(() => maintenanceLease.initializeAfterConfigVolumeLoss(harness))
      .toThrowError(expect.objectContaining({ code: 'EXTERNAL_STOP_PROOF_REQUIRED' }));

    expect(fs.readdirSync(harness.configRoot)).toEqual([]);
    expect(externalTrees(harness)).toEqual(before);
    for (const root of Object.values(roots)) expect(fs.existsSync(root)).toBe(true);
  });

  it('does not create a missing config mount as part of authority recovery', () => {
    const harness = makeHarness();
    fs.rmSync(harness.configRoot, { recursive: true, force: true });

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'INVALID_LOCK_ROOT' }));
    expect(fs.existsSync(harness.configRoot)).toBe(false);
  });

  it('rejects the recovery ABI while the old lock authority still exists', () => {
    const harness = makeHarness();
    const before = treeDigest(harness.configRoot);
    const oldAuthority = readOuterAuthority(harness);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'LOCK_AUTHORITY_NOT_LOST' }));

    expect(treeDigest(harness.configRoot)).toBe(before);
    expect(readOuterAuthority(harness)).toEqual(oldAuthority);
  });

  it.each([
    ['a replacement config file', 'file', 'openclaw.json'],
    ['an unknown file', 'file', 'unknown-entry'],
    ['an unknown directory', 'directory', '.rc-bootstrap'],
  ] as const)('rejects a non-empty recovery mount containing %s', (_label, kind, name) => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    const target = path.join(harness.configRoot, name);
    if (kind === 'directory') fs.mkdirSync(target, { mode: 0o700 });
    else fs.writeFileSync(target, '{}\n', { mode: 0o600 });
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));
    expect(treeDigest(harness.configRoot)).toBe(before);
  });

  it.skipIf(process.platform === 'win32')(
    'requires the externally mounted empty config root itself to be private 0700',
    () => {
      const harness = makeHarness();
      resetToMountedEmptyConfigRoot(harness);
      fs.chmodSync(harness.configRoot, 0o755);

      expect(() => initializeRecoveryAuthority(harness))
        .toThrowError(expect.objectContaining({ code: 'INVALID_LOCK_ROOT' }));
      expect(fs.readdirSync(harness.configRoot)).toEqual([]);
    },
  );

  it('cleans its own unpublished artifacts after an ordinary initialization error and retries', () => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);

    expect(() => maintenanceLease.initializeAfterConfigVolumeLoss({
      ...harness,
      rcRoot: null as unknown as string,
      externalStopVerified: true,
    })).toThrowError(expect.objectContaining({ code: 'SQLITE_RUNTIME_UNAVAILABLE' }));
    expect(recoveryOwnedEntries(harness)).toEqual([]);

    expect(initializeRecoveryAuthority(harness)).toMatchObject({ created: true });
    expect(fs.existsSync(harness.configPath)).toBe(false);
  });

  it.each([
    'recovery-marker',
    'after-placeholder-publish',
    'staging-directory',
    'before-root-authority',
  ] as const)('retries safely after SIGKILL at the unpublished %s window', async (pause) => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);

    await killPausedRecovery(harness, pause);
    expect(fs.existsSync(path.join(
      harness.configRoot, '.rc-bootstrap-lock-authority', 'authority.json',
    ))).toBe(false);

    expect(initializeRecoveryAuthority(harness)).toMatchObject({ created: true });
    expect(fs.existsSync(harness.configPath)).toBe(false);
    expect(recoveryOwnedEntries(harness).sort()).toEqual([
      '.rc-bootstrap',
      '.rc-bootstrap-lock-authority',
    ]);
  }, 30_000);

  it.each([
    'recovery-stage-mkdir',
    'recovery-record-opened',
    'recovery-record-fsynced',
    'before-recovery-marker-rename',
  ] as const)('resumes the canonical election identity after SIGKILL at %s', async (pause) => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);

    await killPausedRecovery(harness, pause);
    const staged = fs.readdirSync(harness.configRoot)
      .find((name) => name.startsWith('.rc-bootstrap-volume-loss-recovery-stage-v1-'))!;
    expect(staged).toBeTruthy();
    const initUuid = staged.slice('.rc-bootstrap-volume-loss-recovery-stage-v1-'.length);
    const recordPath = path.join(harness.configRoot, staged, 'recovery.json');
    const recordedRootUuid = fs.existsSync(recordPath) && fs.statSync(recordPath).size > 0
      ? JSON.parse(fs.readFileSync(recordPath, 'utf8')).rootUuid as string
      : null;

    const initialized = initializeRecoveryAuthority(harness);
    expect(initialized.identity.rootUuid).toBe(recordedRootUuid ?? initUuid);
    expect(recoveryOwnedEntries(harness).sort()).toEqual([
      '.rc-bootstrap',
      '.rc-bootstrap-lock-authority',
    ]);
  }, 30_000);

  it.each([
    'outer-authority-next-fsynced',
    'before-outer-authority-next-rename',
  ] as const)('resumes an exact durable outer-authority next record after SIGKILL at %s', async (pause) => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);

    await killPausedRecovery(harness, pause);
    const finalAuthority = path.join(
      harness.configRoot, '.rc-bootstrap-lock-authority', 'authority.json',
    );
    const authorityStage = fs.readdirSync(harness.configRoot)
      .find((name) => name.startsWith('.lock-authority-init-'));
    const preparingFile = fs.existsSync(finalAuthority)
      ? finalAuthority
      : path.join(harness.configRoot, authorityStage!, 'authority.json');
    const preparing = fs.existsSync(preparingFile)
      ? JSON.parse(fs.readFileSync(preparingFile, 'utf8'))
      : JSON.parse(fs.readFileSync(path.join(
        harness.configRoot, authorityStage!, '.authority-next.json',
      ), 'utf8'));
    expect(preparing).toMatchObject({ rootUuid: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const initialized = initializeRecoveryAuthority(harness);
    expect(initialized.identity.rootUuid).toBe(preparing.rootUuid);
    expect(readOuterAuthority(harness)).toMatchObject({
      state: 'committed', rootUuid: preparing.rootUuid, stagingName: null,
    });
    expect(fs.readdirSync(path.join(
      harness.configRoot, '.rc-bootstrap-lock-authority',
    ))).toEqual(['authority.json']);
  }, 30_000);

  it.each([
    ['forged next record', (directory: string, next: string) => {
      const value = JSON.parse(fs.readFileSync(next, 'utf8'));
      value.rootUuid = crypto.randomUUID();
      writeJson(next, value);
    }],
    ['unknown extra entry', (directory: string) => {
      fs.writeFileSync(path.join(directory, 'user-owned.txt'), 'preserve me\n', { mode: 0o600 });
    }],
    ['next-record inode substitution', (_directory: string, next: string) => {
      const bytes = fs.readFileSync(next);
      fs.unlinkSync(next);
      fs.writeFileSync(next, bytes, { mode: 0o600 });
    }],
  ] as const)('does zero cleanup for a %s in an interrupted authority transition', async (_label, mutate) => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    await killPausedRecovery(harness, 'before-outer-authority-next-rename');
    const directory = path.join(harness.configRoot, '.rc-bootstrap-lock-authority');
    const next = fs.readdirSync(directory)
      .map((name) => path.join(directory, name))
      .find((file) => path.basename(file) === '.authority-next.json')!;
    expect(next).toBeTruthy();
    mutate(directory, next);
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));
    expect(treeDigest(harness.configRoot)).toBe(before);
  }, 30_000);

  it.each([
    ['an extra entry winning the canonical root-authority stage mkdir race', 'root-authority-stage-extra'],
    ['bad bytes winning the canonical outer-authority next-record open race', 'outer-authority-next-bad-bytes'],
    ['a symlink winning the canonical placeholder stage open race', 'placeholder-stage-symlink'],
  ] as const)('classifies %s as tamper, never same-election BUSY', async (_label, race) => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);

    const raced = await runRacedRecovery(harness, race);
    expect(raced.code).toBe(2);
    expect(raced.stdout).toContain('"code":"RECOVERY_CONFIG_ROOT_NOT_EMPTY"');
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));
    expect(treeDigest(harness.configRoot)).toBe(before);
  }, 30_000);

  it.each([
    ['recovery staging mkdir', 'recovery-stage-empty', 'recovery-stage-extra'],
    ['recovery record open', 'recovery-record-empty', 'recovery-record-bad-bytes', 'RECOVERY_CONFIG_ROOT_NOT_EMPTY'],
    ['placeholder staging open', 'placeholder-stage-empty', 'placeholder-stage-symlink'],
    ['canonical locks staging mkdir', 'locks-stage-empty', 'locks-stage-extra'],
    ['canonical identity open', 'identity-empty', 'identity-wrong-root', 'RECOVERY_CONFIG_ROOT_NOT_EMPTY'],
    ['operation database open', 'operation-db-empty', 'operation-db-bad-bytes', 'RECOVERY_CONFIG_ROOT_NOT_EMPTY'],
    ['lock authority open', 'lock-authority-empty', 'lock-authority-wrong-root'],
    ['locks publication rename', 'locks-publish-self', 'locks-publish-extra'],
    ['root-authority staging mkdir', 'root-authority-stage-empty', 'root-authority-stage-extra'],
    ['root-authority publication rename', 'root-authority-publish-self', 'root-authority-publish-unknown'],
    ['outer-authority next open', 'outer-authority-next-empty', 'outer-authority-next-bad-bytes'],
    ['outer-authority file open', 'outer-authority-file-empty', 'outer-authority-file-bad-bytes'],
    ['outer-authority next rename', 'outer-authority-next-rename-self', 'outer-authority-next-rename-bad-bytes'],
    ['outer-authority anchor unlink', 'outer-authority-anchor-unlink-self', 'outer-authority-anchor-unlink-extra'],
    ['recovery marker rename', 'recovery-marker-rename-self', 'recovery-marker-rename-unknown', 'RECOVERY_CONFIG_ROOT_NOT_EMPTY'],
  ] as const)(
    're-observes exact same-election %s races but rejects tampered twins',
    async (_branch, exactRace, tamperedRace, tamperedCode = 'RECOVERY_CONFIG_ROOT_NOT_EMPTY') => {
      const exact = makeHarness();
      resetToMountedEmptyConfigRoot(exact);
      const exactResult = await runRacedRecovery(exact, exactRace);
      if (exactResult.code !== 0) {
        expect(exactResult.code).toBe(2);
        expect(exactResult.stdout).toContain('"code":"LOCK_INITIALIZATION_BUSY"');
        let converged = false;
        for (let attempt = 0; attempt < 2 && !converged; attempt += 1) {
          try {
            initializeRecoveryAuthority(exact);
            converged = true;
          } catch (error: any) {
            if (error?.code !== 'LOCK_INITIALIZATION_BUSY') throw error;
          }
        }
        expect(converged).toBe(true);
      }
      expect(readOuterAuthority(exact)).toMatchObject({
        state: 'committed', stagingName: null,
      });
      expect(recoveryOwnedEntries(exact).sort()).toEqual([
        '.rc-bootstrap', '.rc-bootstrap-lock-authority',
      ]);

      const tampered = makeHarness();
      resetToMountedEmptyConfigRoot(tampered);
      const tamperedResult = await runRacedRecovery(tampered, tamperedRace);
      expect(tamperedResult.code).toBe(2);
      expect(tamperedResult.stdout).toContain(`"code":"${tamperedCode}"`);
      const before = treeDigest(tampered.configRoot);
      expect(() => initializeRecoveryAuthority(tampered))
        .toThrowError(expect.objectContaining({ code: tamperedCode }));
      expect(treeDigest(tampered.configRoot)).toBe(before);
    },
    30_000,
  );

  it('elects one canonical authority across simultaneous config-volume recovery calls', async () => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    const startAt = Date.now() + 500;

    const results = await Promise.all([
      runRecoveryWorker(harness, startAt),
      runRecoveryWorker(harness, startAt),
    ]);
    expect(results.some((result) => result.code === 0)).toBe(true);
    for (const result of results.filter((candidate) => candidate.code !== 0)) {
      expect(result.stdout).toMatch(
        /"code":"(?:LOCK_AUTHORITY_NOT_LOST|LOCK_INITIALIZATION_BUSY|RECOVERY_CONFIG_ROOT_NOT_EMPTY)"/,
      );
    }
    const authority = readOuterAuthority(harness);
    expect(authority).toMatchObject({ state: 'committed', stagingName: null });
    expect(fs.readdirSync(harness.configRoot).sort()).toEqual([
      '.rc-bootstrap',
      '.rc-bootstrap-lock-authority',
    ]);
    expect(fs.readdirSync(path.join(harness.configRoot, '.rc-bootstrap')).sort()).toEqual(['locks']);
    expect(fs.readdirSync(path.join(
      harness.configRoot, '.rc-bootstrap-lock-authority',
    ))).toEqual(['authority.json']);
  }, 30_000);

  it('resumes the exact preparing authority after locks publish returns EIO', async () => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);

    const faulted = await runFaultedRecovery(harness, 'locks-publish-eio');
    expect(faulted.code).toBe(2);
    expect(faulted.stdout).toContain('"event":"error"');
    expect(readOuterAuthority(harness)).toMatchObject({
      state: 'preparing',
      stagingName: expect.stringMatching(/^\.locks-init-/),
    });

    expect(initializeRecoveryAuthority(harness)).toMatchObject({ created: true });
    expect(readOuterAuthority(harness)).toMatchObject({ state: 'committed', stagingName: null });
    expect(fs.existsSync(harness.configPath)).toBe(false);
    expect(recoveryOwnedEntries(harness).sort()).toEqual([
      '.rc-bootstrap',
      '.rc-bootstrap-lock-authority',
    ]);

    const cleanDigest = treeDigest(harness.configRoot);
    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'LOCK_AUTHORITY_NOT_LOST' }));
    expect(treeDigest(harness.configRoot)).toBe(cleanDigest);
  }, 30_000);

  it('finishes exact placeholder cleanup after SIGKILL with a committed authority', async () => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);

    await killPausedRecovery(harness, 'after-authority-committed');
    expect(readOuterAuthority(harness)).toMatchObject({ state: 'committed', stagingName: null });
    expect(fs.existsSync(harness.configPath)).toBe(true);

    expect(initializeRecoveryAuthority(harness)).toMatchObject({ created: true });
    expect(fs.existsSync(harness.configPath)).toBe(false);
    expect(recoveryOwnedEntries(harness).sort()).toEqual([
      '.rc-bootstrap',
      '.rc-bootstrap-lock-authority',
    ]);

    const cleanDigest = treeDigest(harness.configRoot);
    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'LOCK_AUTHORITY_NOT_LOST' }));
    expect(treeDigest(harness.configRoot)).toBe(cleanDigest);
  }, 30_000);

  it.each([
    ['non-empty replacement', Buffer.from('{"user":true}\n')],
    ['zero-byte replacement with a different inode', Buffer.alloc(0)],
  ] as const)('preserves and rejects a user %s after committed SIGKILL', async (_label, bytes) => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    await killPausedRecovery(harness, 'after-authority-committed');

    fs.unlinkSync(harness.configPath);
    fs.writeFileSync(harness.configPath, bytes, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(harness.configPath, 0o600);
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));
    expect(treeDigest(harness.configRoot)).toBe(before);
    expect(fs.readFileSync(harness.configPath)).toEqual(bytes);
  }, 30_000);

  it('does zero cleanup when a committed recovery has an unknown extra path', async () => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    await killPausedRecovery(harness, 'after-authority-committed');
    const userFile = path.join(harness.configRoot, 'user-owned.txt');
    fs.writeFileSync(userFile, 'preserve me\n', { mode: 0o600 });
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));
    expect(treeDigest(harness.configRoot)).toBe(before);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('preserve me\n');
  }, 30_000);

  it('does zero cleanup when a committed lock set has an unknown extra path', async () => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    await killPausedRecovery(harness, 'after-authority-committed');
    const userFile = path.join(
      harness.configRoot, '.rc-bootstrap', 'locks', 'user-owned.txt',
    );
    fs.writeFileSync(userFile, 'preserve me\n', { mode: 0o600 });
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));
    expect(treeDigest(harness.configRoot)).toBe(before);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('preserve me\n');
  }, 30_000);

  it.each([
    ['root UUID', (record: any) => { record.rootUuid = crypto.randomUUID(); }],
    ['config basename', (record: any) => { record.configBasename = 'other.json'; }],
    ['initialization UUID', (record: any) => { record.initUuid = crypto.randomUUID(); }],
  ] as const)('does zero cleanup when the recovery record %s is tampered', async (_label, mutate) => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    await killPausedRecovery(harness, 'after-authority-committed');
    const marker = fs.readdirSync(harness.configRoot)
      .find((name) => name.startsWith('.rc-bootstrap-volume-loss-recovery-v1-'))!;
    const recordFile = path.join(harness.configRoot, marker, 'recovery.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    mutate(record);
    writeJson(recordFile, record);
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));
    expect(treeDigest(harness.configRoot)).toBe(before);
    expect(fs.existsSync(harness.configPath)).toBe(true);
  }, 30_000);

  it('does zero cleanup when the placeholder identity record is tampered', async () => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    await killPausedRecovery(harness, 'after-authority-committed');
    const marker = fs.readdirSync(harness.configRoot)
      .find((name) => name.startsWith('.rc-bootstrap-volume-loss-recovery-v1-'))!;
    const recordFile = path.join(harness.configRoot, marker, 'placeholder.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    record.ino += 1;
    writeJson(recordFile, record);
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));
    expect(treeDigest(harness.configRoot)).toBe(before);
    expect(fs.existsSync(harness.configPath)).toBe(true);
  }, 30_000);

  it('never cleans an unknown entry mixed into unpublished recovery artifacts', async () => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    await killPausedRecovery(harness, 'staging-directory');
    const userFile = path.join(harness.configRoot, 'user-owned.txt');
    fs.writeFileSync(userFile, 'preserve me\n', { mode: 0o600 });
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));

    expect(treeDigest(harness.configRoot)).toBe(before);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('preserve me\n');
  }, 30_000);

  it.each([
    ['an unrecorded staging directory', '.rc-bootstrap/.locks-init-11111111-1111-4111-8111-111111111111'],
    ['an unrecorded root-authority staging directory', '.lock-authority-init-11111111-1111-4111-8111-111111111111'],
  ] as const)('never cleans %s', async (_label, relative) => {
    const harness = makeHarness();
    resetToMountedEmptyConfigRoot(harness);
    await killPausedRecovery(harness, 'recovery-marker');
    const injected = path.join(harness.configRoot, relative);
    fs.mkdirSync(injected, { recursive: true, mode: 0o700 });
    const before = treeDigest(harness.configRoot);

    expect(() => initializeRecoveryAuthority(harness))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' }));

    expect(treeDigest(harness.configRoot)).toBe(before);
    expect(fs.existsSync(injected)).toBe(true);
  }, 30_000);
});

describe('config-volume loss satellite recovery', () => {
  it('rebuilds a new authority only after proof, then durably records four incidents before rollback', async () => {
    const harness = makeHarness();
    const { txId, oldRootUuid, roots, beforeLive } = await createAppliedOrphans(harness);

    const initialized = initializeRecoveryAuthority(harness);
    expect(initialized).toMatchObject({ created: true });
    expect(initialized.identity.rootUuid).not.toBe(oldRootUuid);
    expect(readOuterAuthority(harness)).toMatchObject({
      rootUuid: initialized.identity.rootUuid,
      state: 'committed',
      stagingName: null,
    });
    expect(fs.readdirSync(harness.configRoot).sort()).toEqual([
      '.rc-bootstrap',
      '.rc-bootstrap-lock-authority',
    ]);
    expect(fs.readdirSync(path.join(harness.configRoot, '.rc-bootstrap')).sort()).toEqual(['locks']);
    expect(fs.readdirSync(path.join(harness.configRoot, '.rc-bootstrap', 'locks')).sort()).toEqual([
      'authority.json',
      'identity.json',
      'operation.sqlite',
      'runtime.sqlite',
    ]);
    expect(fs.existsSync(harness.configPath)).toBe(false);

    await expect(applier.recoverProfiles(harness))
      .rejects.toMatchObject({ code: 'CONFIG_VOLUME_LOST' });

    expect(liveSatelliteDigest(harness)).toBe(beforeLive);
    for (const root of Object.values(roots)) expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(harness.configPath)).toBe(false);
    const incidents = incidentFiles(harness, txId);
    const incidentBytes = incidents.map((file) => fs.readFileSync(file, 'utf8'));
    expect(new Set(incidentBytes).size).toBe(1);
    for (const [index, file] of incidents.entries()) {
      expect(JSON.parse(incidentBytes[index])).toEqual({
        version: 1,
        txId,
        code: 'CONFIG_VOLUME_LOST',
        recoveredState: 'applied',
        restoredVolumes: ['data', 'state', 'workspace'],
      });
      expect(incidentBytes[index]).not.toContain('RC_TEST_ONLY_FAKE_MODEL_KEY');
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    }
  }, 30_000);

  it('allows authority replacement but preserves every satellite byte when a preimage is tampered', async () => {
    const harness = makeHarness();
    const { txId, roots } = await createAppliedOrphans(harness);
    const marker = JSON.parse(fs.readFileSync(path.join(roots.state, 'volume-marker.json'), 'utf8'));
    const auth = marker.assets.find((asset: any) => asset.id === 'auth');
    expect(auth).toBeTruthy();
    fs.appendFileSync(path.join(roots.state, auth.snapshot, 'content', '__root_file__'), 'tampered');
    initializeRecoveryAuthority(harness);
    const before = externalTrees(harness);

    await expect(applier.recoverProfiles(harness))
      .rejects.toMatchObject({ code: 'INVALID_TRANSACTION_PREIMAGE' });

    expect(externalTrees(harness)).toEqual(before);
    for (const root of Object.values(roots)) expect(fs.existsSync(root)).toBe(true);
    for (const incident of incidentFiles(harness, txId)) expect(fs.existsSync(incident)).toBe(false);
  }, 30_000);

  it('does not begin satellite rollback until all four incident copies are durable', async () => {
    const harness = makeHarness();
    const { txId, roots } = await createAppliedOrphans(harness);
    initializeRecoveryAuthority(harness);
    const blockedIncidentRoot = path.join(harness.stateDir, '.rc-bootstrap-recovery-incidents');
    fs.writeFileSync(blockedIncidentRoot, 'not-a-directory\n', { mode: 0o600 });
    const beforeLive = liveSatelliteDigest(harness);
    const beforeEvidence = Object.fromEntries(
      Object.entries(roots).map(([volume, root]) => [volume, treeDigest(root)]),
    );

    await expect(applier.recoverProfiles(harness)).rejects.toBeTruthy();

    expect(liveSatelliteDigest(harness)).toBe(beforeLive);
    for (const root of Object.values(roots)) expect(fs.existsSync(root)).toBe(true);
    expect(Object.fromEntries(
      Object.entries(roots).map(([volume, root]) => [volume, treeDigest(root)]),
    )).toEqual(beforeEvidence);
    expect(fs.readFileSync(blockedIncidentRoot, 'utf8')).toBe('not-a-directory\n');
    for (const file of incidentFiles(harness, txId)) {
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
        txId,
        code: 'CONFIG_VOLUME_LOST',
      });
    }
  }, 30_000);

  it('requires all three satellite roots and preserves the remaining evidence when one is missing', async () => {
    const harness = makeHarness();
    const { txId, roots } = await createAppliedOrphans(harness);
    fs.rmSync(roots.workspace, { recursive: true, force: true });
    initializeRecoveryAuthority(harness);
    const before = externalTrees(harness);

    await expect(applier.recoverProfiles(harness))
      .rejects.toMatchObject({ code: 'INCOMPLETE_TRANSACTION_PREIMAGE' });

    expect(externalTrees(harness)).toEqual(before);
    expect(fs.existsSync(roots.state)).toBe(true);
    expect(fs.existsSync(roots.data)).toBe(true);
    for (const incident of incidentFiles(harness, txId)) expect(fs.existsSync(incident)).toBe(false);
  }, 30_000);
});
