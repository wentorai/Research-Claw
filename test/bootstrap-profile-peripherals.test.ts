import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const CRON_WORKER = path.join(ROOT, 'scripts/bootstrap-profile/cron-worker.mjs');
const ENTRY = path.join(ROOT, 'scripts/apply-bootstrap-profile.cjs');
const APPLIER_MODULE = path.join(ROOT, 'scripts/bootstrap-profile/applier.cjs');
const require = createRequire(import.meta.url);
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(ROOT, 'extensions/research-claw-core'), ROOT],
}));
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');
process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS = '1';

type Harness = ReturnType<typeof makeHarness>;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function job(id: string, sessionKey?: string) {
  return {
    id,
    ...(sessionKey ? { sessionKey } : {}),
    name: id,
    enabled: true,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    schedule: { kind: 'cron', expr: '0 8 * * *' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: `fixture ${id}` },
    delivery: { mode: 'none' },
    state: {},
  };
}

function worker(stateDir: string, action: string, payload: unknown = {}): any {
  const result = spawnSync(process.execPath, [CRON_WORKER, action, '--state-dir', stateDir], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: path.join(path.dirname(stateDir), 'worker-home'),
      USERPROFILE: path.join(path.dirname(stateDir), 'worker-home'),
    },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-periph-'));
  roots.push(root);
  const configRoot = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const dataRoot = path.join(root, 'data');
  for (const directory of [configRoot, workspace, stateDir, dataRoot, path.join(root, 'worker-home')]) {
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
  writeJson(paths.configPath, {
    agents: { defaults: { model: { primary: 'user/model' } } },
    models: { mode: 'merge', providers: {} },
    plugins: { entries: {
      'research-claw-core': { enabled: true, config: {} },
      'dual-model-supervisor': { enabled: false, config: { enabled: false, reviewMode: 'off' } },
    } },
    tools: { deny: ['user-rule'] },
    mcp: { servers: {
      plaud: {
        command: 'npx', args: ['-y', '@plaud-ai/mcp@0.3.5'],
        env: { PLAUD_FIXTURE_SECRET: 'PLAUD_TEST_ONLY_FAKE_SECRET' },
        headers: { Authorization: 'Bearer PLAUD_TEST_ONLY_FAKE_HEADER' },
      },
      'user-server': { command: 'user-mcp', args: ['--preserve'] },
    } },
  });
  writeJson(paths.globalConfigPath, {});
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), { version: 1, profiles: {} });

  const db = new Database(paths.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(`
    CREATE TABLE rc_monitors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      filters TEXT NOT NULL DEFAULT '{}',
      schedule TEXT NOT NULL DEFAULT '0 8 * * *',
      enabled INTEGER NOT NULL DEFAULT 1,
      notify INTEGER NOT NULL DEFAULT 1,
      agent_prompt TEXT NOT NULL DEFAULT '',
      gateway_job_id TEXT,
      last_check_at TEXT,
      last_results TEXT,
      last_error TEXT,
      check_count INTEGER NOT NULL DEFAULT 0,
      finding_count INTEGER NOT NULL DEFAULT 0,
      memory TEXT NOT NULL DEFAULT '{"v":1,"seen":[],"runs":[],"notes":""}',
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z'
    )
  `);
  const insert = db.prepare(
    'INSERT INTO rc_monitors (id,name,source_type,target,enabled,gateway_job_id) VALUES (?,?,?,?,?,?)',
  );
  insert.run('device-bound', 'Camera', 'device', 'camera-1', 1, 'job-device-bound');
  insert.run('device-session', 'Recorder', 'device', 'recorder-1', 1, null);
  insert.run('device-whitespace', 'Legacy Device', '\tDeViCe\n\u00a0', 'legacy-1', 1, null);
  insert.run('feed-monitor', 'Feed', 'feed', 'https://example.invalid', 1, 'job-feed');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  const jobs = [
    job('job-device-bound', 'agent:main:cron:legacy'),
    job('job-device-session', 'cron:rc-monitor:device-session'),
    job('job-device-session-duplicate', 'cron:rc-monitor:device-session'),
    job('job-device-whitespace', 'cron:rc-monitor:device-whitespace'),
    job('job-feed', 'cron:rc-monitor:feed-monitor'),
    job('prefix-trap', 'cron:rc-monitor:device-session:suffix'),
    job('name-trap', undefined),
  ];
  worker(stateDir, 'seed', { version: 1, jobs });
  ensureInitialized({ ...paths, externalStopVerified: true });
  return { root, paths, jobs };
}

function capsule(overrides: {
  profileId?: string;
  revision?: number;
  peripherals?: 'disabled' | 'enabled' | 'enabled-hidden';
} = {}): Buffer {
  const value = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  if (overrides.profileId) {
    value.profile.id = overrides.profileId;
    value.model.providerId = `custom-rc-profile-${overrides.profileId}`;
  }
  if (overrides.revision !== undefined) value.profile.revision = overrides.revision;
  if (overrides.peripherals) value.policy.capabilities.peripherals = overrides.peripherals;
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function install(harness: Harness, raw: Buffer): Promise<any> {
  const staged = await applier.stageProfile({
    ...harness.paths,
    capsuleBytes: raw,
    rcVersion: '0.8.3',
  });
  const applied = await applier.applyProfile({
    ...harness.paths,
    txId: staged.txId,
  });
  await applier.verifyProfile({ ...harness.paths, txId: staged.txId });
  await applier.commitProfile({ ...harness.paths, txId: staged.txId });
  return applied;
}

function monitorRows(harness: Harness): any[] {
  const db = new Database(harness.paths.dbPath, { readonly: true });
  const rows = db.prepare(
    'SELECT id,source_type,target,enabled,gateway_job_id FROM rc_monitors ORDER BY id',
  ).all();
  db.close();
  return rows;
}

function ledger(harness: Harness): any {
  return JSON.parse(fs.readFileSync(
    path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap', 'peripheral-suspensions.json'),
    'utf8',
  ));
}

function config(harness: Harness): any {
  return JSON.parse(fs.readFileSync(harness.paths.configPath, 'utf8'));
}

function cliArgs(command: string, harness: Harness, txId?: string): string[] {
  return [
    ENTRY, command,
    '--rc-root', ROOT,
    '--config', harness.paths.configPath,
    '--workspace', harness.paths.workspace,
    '--state-dir', harness.paths.stateDir,
    '--db', harness.paths.dbPath,
    '--global-config', harness.paths.globalConfigPath,
    ...(txId ? ['--tx-id', txId] : []),
  ];
}

function byteDigest(target: string): string {
  return fs.existsSync(target)
    ? crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') : 'absent';
}

function managedByteState(harness: Harness): Record<string, string> {
  const bootstrap = path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap');
  return Object.fromEntries([
    harness.paths.configPath,
    path.join(bootstrap, 'receipt.json'),
    path.join(bootstrap, 'peripheral-suspensions.json'),
    path.join(harness.paths.stateDir, 'agents/main/agent/auth-profiles.json'),
    harness.paths.globalConfigPath,
    path.join(harness.paths.stateDir, 'state/openclaw.sqlite'),
    path.join(harness.paths.stateDir, 'state/openclaw.sqlite-wal'),
    path.join(harness.paths.stateDir, 'state/openclaw.sqlite-shm'),
    harness.paths.dbPath,
    `${harness.paths.dbPath}-wal`,
    `${harness.paths.dbPath}-shm`,
  ].map((target) => [target, byteDigest(target)]));
}

function cronLifecyclePath(harness: Harness, txId: string): string {
  return path.join(
    harness.paths.stateDir,
    '.rc-bootstrap-transactions',
    txId,
    'cron-worker-lifecycle.sqlite',
  );
}

function cronLifecycleState(harness: Harness, txId: string): string {
  const lifecycle = cronLifecyclePath(harness, txId);
  if (!fs.existsSync(lifecycle)) return 'absent';
  const database = new Database(lifecycle, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(
      'SELECT state FROM rc_cron_worker_epoch WHERE singleton = 1',
    ).get().state;
  } finally {
    database.close();
  }
}

function cronCleanupQuarantineRoot(harness: Harness): string {
  return path.join(
    path.dirname(harness.paths.configPath),
    '.rc-bootstrap',
    'cron-worker-cleanup-quarantine',
  );
}

function cronCleanupAuthorityFile(harness: Harness, txId: string, epoch: string): string {
  return path.join(
    path.dirname(harness.paths.configPath),
    '.rc-bootstrap',
    'transactions',
    txId,
    `cron-worker-cleanup-authority-scratch-${epoch}.json`,
  );
}

function pathTreeIdentity(root: string): unknown {
  if (!fs.existsSync(root)) return null;
  const entries: Array<Record<string, unknown>> = [];
  const visit = (target: string, relative = ''): void => {
    const metadata = fs.lstatSync(target);
    const record: Record<string, unknown> = {
      relative,
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      mode: process.platform === 'win32' ? null : metadata.mode & 0o7777,
      type: metadata.isSymbolicLink() ? 'symlink'
        : metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other',
    };
    if (metadata.isSymbolicLink()) record.target = fs.readlinkSync(target);
    if (metadata.isFile()) {
      record.bytes = metadata.size;
      record.sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    }
    entries.push(record);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) {
        visit(path.join(target, name), relative ? `${relative}/${name}` : name);
      }
    }
  };
  visit(root);
  return entries;
}

async function crashScratchCleanupAtPhase(
  harness: Harness,
  txId: string,
  epoch: string,
  phase: string,
): Promise<any> {
  const ready = path.join(harness.root, `q-cleanup-${phase}-${epoch}.ready`);
  const runner = path.join(ROOT, 'test/fixtures/bootstrap-profile-q-cleanup-runner.cjs');
  const child = spawn(process.execPath, [
    runner,
    APPLIER_MODULE,
    Buffer.from(JSON.stringify(harness.paths)).toString('base64url'),
    txId,
    epoch,
    phase,
    ready,
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(ready), stderr).toBe(true);
    const observed = JSON.parse(fs.readFileSync(ready, 'utf8'));
    expect(observed).toMatchObject({
      version: 1, pid: child.pid, txId, epoch, phase,
    });
    expect(observed.created).toBeTruthy();
    expect(observed.context).toBeTruthy();
    child.kill('SIGKILL');
    await closed;
    return observed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

async function capturedFailure(callback: () => unknown | Promise<unknown>): Promise<any> {
  try {
    await callback();
    return undefined;
  } catch (error) {
    return error;
  }
}

const ADMISSION_RUNNER = String.raw`
'use strict';
const [mode, applierFile, optionsBase64] = process.argv.slice(1);
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const options = JSON.parse(Buffer.from(optionsBase64, 'base64').toString('utf8'));
const originalSpawn = childProcess.spawn;
let spawnCalls = 0;
const workerHomes = [];
let lifecycleRebind = null;
function directoryIdentity(directory) {
  const metadata = fs.lstatSync(directory);
  return {
    path: directory,
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mode: process.platform === 'win32' ? null : metadata.mode & 0o7777,
    uid: metadata.uid,
  };
}
function workerHomeState(home) {
  const tmp = path.join(home, 'tmp');
  return {
    home,
    tmp,
    homeIdentity: directoryIdentity(home),
    tmpIdentity: directoryIdentity(tmp),
  };
}
function completedWorkerHomes() {
  return workerHomes.map((record) => ({
    ...record,
    homeExistsAfter: fs.existsSync(record.home),
    heldExistsAfter: record.held ? fs.existsSync(record.held) : null,
    replacementSentinelExists: record.replacementSentinel
      ? fs.existsSync(record.replacementSentinel) : null,
  }));
}
childProcess.spawn = function patchedSpawn(...args) {
  spawnCalls += 1;
  const spawnOptions = args[2];
  const home = spawnOptions && spawnOptions.env && spawnOptions.env.HOME;
  const observation = typeof home === 'string' ? workerHomeState(home) : null;
  if (observation) workerHomes.push(observation);
  if (mode === 'lifecycle-rebind' && spawnCalls === 2) {
    const workerArgs = args[1];
    const lifecycleIndex = Array.isArray(workerArgs) ? workerArgs.indexOf('--lifecycle') : -1;
    if (lifecycleIndex < 0) throw new Error('missing lifecycle argument');
    const lifecycle = workerArgs[lifecycleIndex + 1];
    const held = lifecycle + '.held-' + process.pid;
    const before = fs.lstatSync(lifecycle);
    fs.renameSync(lifecycle, held);
    fs.copyFileSync(held, lifecycle, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(lifecycle, 0o600);
    const replacement = fs.lstatSync(lifecycle);
    lifecycleRebind = {
      lifecycle,
      held,
      before: { dev: String(before.dev), ino: String(before.ino) },
      replacement: { dev: String(replacement.dev), ino: String(replacement.ino) },
    };
  }
  if (mode === 'home-rebind' && spawnCalls === 2 && observation) {
    const held = home + '.held-' + process.pid;
    fs.renameSync(home, held);
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(path.join(home, 'tmp'), { mode: 0o700 });
    if (process.platform !== 'win32') {
      fs.chmodSync(home, 0o700);
      fs.chmodSync(path.join(home, 'tmp'), 0o700);
    }
    const replacementSentinel = path.join(home, 'replacement-sentinel');
    fs.writeFileSync(replacementSentinel, 'PRESERVE_REPLACEMENT\n', {
      flag: 'wx', mode: 0o600,
    });
    observation.held = held;
    observation.heldIdentity = directoryIdentity(held);
    observation.replacementIdentity = directoryIdentity(home);
    observation.replacementSentinel = replacementSentinel;
  }
  if (mode === 'spawn-throw' && spawnCalls === 2) {
    throw new Error('synthetic synchronous spawn failure');
  }
  return originalSpawn.apply(this, args);
};
const applier = require(applierFile);
Promise.resolve(applier.applyProfile(options)).then(
  (result) => process.stdout.write(JSON.stringify({
    ok: true,
    state: result.state,
    spawnCalls,
    cronWorkers: result.cronWorkers,
    workerHomes: completedWorkerHomes(),
    lifecycleRebind,
  }) + '\n'),
  (error) => {
    process.stdout.write(JSON.stringify({
      ok: false,
      code: error && error.code,
      spawnCalls,
      workerHomes: completedWorkerHomes(),
      lifecycleRebind,
    }) + '\n');
    process.exitCode = 17;
  },
);
`;

function runAdmissionApply(
  harness: Harness,
  txId: string,
  mode: 'normal' | 'spawn-throw' | 'home-rebind' | 'lifecycle-rebind',
) {
  const encoded = Buffer.from(JSON.stringify({ ...harness.paths, txId })).toString('base64');
  return spawnSync(process.execPath, [
    '-e', ADMISSION_RUNNER, mode, APPLIER_MODULE, encoded,
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
}

function admissionResult(result: ReturnType<typeof runAdmissionApply>): any {
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  expect(line, `${result.stdout}\n${result.stderr}`).toBeTruthy();
  return JSON.parse(line!);
}

describe('device monitor and canonical cron suspension', () => {
  it.each(['pre-cas', 'post-write'] as const)(
    'retires the exact live worker epoch before byte-exact recovery after parent SIGKILL at %s',
    async (phase) => {
      const harness = makeHarness();
      const before = managedByteState(harness);
      const staged = await applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      });
      const ready = path.join(harness.root, `worker-${phase}.ready`);
      const child = spawn(process.execPath, cliArgs('apply', harness, staged.txId), {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'bootstrap-worker-test',
          RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
          RC_BOOTSTRAP_WORKER_PAUSE_AT: phase,
          RC_BOOTSTRAP_WORKER_READY: ready,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      let output = '';
      child.stdout?.on('data', (chunk) => { output += chunk; });
      child.stderr?.on('data', (chunk) => { output += chunk; });
      try {
        const started = Date.now();
        while (!fs.existsSync(ready) && Date.now() - started < 20_000) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(fs.existsSync(ready), output).toBe(true);
        const identity = JSON.parse(fs.readFileSync(ready, 'utf8'));
        expect(identity).toMatchObject({ version: 1, txId: staged.txId, phase });
        expect(identity.epoch).toMatch(/^[0-9a-f-]{36}$/);
        expect(identity.scratch).toMatchObject({
          homeIdentity: { mode: 0o700 },
          tmpIdentity: { mode: 0o700 },
        });
        expect(identity.scratch.tmpdir).toBe(path.join(identity.scratch.home, 'tmp'));
        const scratchBefore = fs.lstatSync(identity.scratch.home);
        expect({ dev: String(scratchBefore.dev), ino: String(scratchBefore.ino) }).toEqual({
          dev: identity.scratch.homeIdentity.dev,
          ino: identity.scratch.homeIdentity.ino,
        });

        child.kill('SIGKILL');
        await childClosed;
        const recoveredProcess = spawnSync(process.execPath, cliArgs('recover', harness), {
          cwd: ROOT,
          env: { PATH: process.env.PATH ?? '' },
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(recoveredProcess.error, recoveredProcess.stderr).toBeUndefined();
        expect(recoveredProcess.status, `${recoveredProcess.stdout}\n${recoveredProcess.stderr}`).toBe(0);
        const recoveredLine = recoveredProcess.stdout.trim().split('\n').filter(Boolean).at(-1);
        expect(recoveredLine, recoveredProcess.stderr).toBeTruthy();
        expect(JSON.parse(recoveredLine!).recovered).toContain(staged.txId);
        expect(managedByteState(harness)).toEqual(before);
        const scratchResidueAfterRecovery = fs.existsSync(identity.scratch.home);
        const retried = await applier.stageProfile({
          ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
        });
        await applier.applyProfile({ ...harness.paths, txId: retried.txId });
        await applier.rollbackProfile({ ...harness.paths, txId: retried.txId });
        expect(managedByteState(harness)).toEqual(before);
        expect(scratchResidueAfterRecovery).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(managedByteState(harness)).toEqual(before);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await childClosed;
      }
    },
    60_000,
  );

  it.skipIf(process.platform === 'win32').each([
    'symlink', 'hardlink', 'public-mode', 'foreign-schema',
  ] as const)(
    'fails closed without mutating a hostile %s cron lifecycle authority',
    async (kind) => {
      const harness = makeHarness();
      const staged = await applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      });
      const lifecycle = cronLifecyclePath(harness, staged.txId);
      fs.mkdirSync(path.dirname(lifecycle), { recursive: true, mode: 0o700 });
      const external = path.join(harness.root, `lifecycle-${kind}-external.sqlite`);
      const databasePath = ['public-mode', 'foreign-schema'].includes(kind)
        ? lifecycle : external;
      const database = new Database(databasePath);
      database.exec('CREATE TABLE preserve_exact_bytes (value TEXT NOT NULL)');
      database.prepare('INSERT INTO preserve_exact_bytes (value) VALUES (?)')
        .run('PRESERVE_LIFECYCLE_TARGET');
      database.close();
      fs.chmodSync(databasePath, kind === 'public-mode' ? 0o644 : 0o600);
      if (kind === 'symlink') fs.symlinkSync(external, lifecycle);
      if (kind === 'hardlink') fs.linkSync(external, lifecycle);

      const protectedPath = ['public-mode', 'foreign-schema'].includes(kind)
        ? lifecycle : external;
      const protectedBefore = fs.lstatSync(protectedPath);
      const bytesBefore = fs.readFileSync(protectedPath);
      let failure: any;
      try {
        applier.__testing.openCronWorkerLifecycleProbe(harness.paths, staged.txId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      const protectedAfter = fs.lstatSync(protectedPath);
      expect({
        dev: protectedAfter.dev,
        ino: protectedAfter.ino,
        mode: protectedAfter.mode & 0o7777,
        nlink: protectedAfter.nlink,
      }).toEqual({
        dev: protectedBefore.dev,
        ino: protectedBefore.ino,
        mode: protectedBefore.mode & 0o7777,
        nlink: protectedBefore.nlink,
      });
      expect(fs.readFileSync(protectedPath)).toEqual(bytesBefore);
      const preserved = new Database(protectedPath, { readonly: true, fileMustExist: true });
      try {
        expect(preserved.prepare('SELECT value FROM preserve_exact_bytes').get())
          .toEqual({ value: 'PRESERVE_LIFECYCLE_TARGET' });
        expect(preserved.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rc_cron_worker_epoch'",
        ).get()).toBeUndefined();
      } finally {
        preserved.close();
      }
    },
    30_000,
  );

  it('uses fresh transaction-bound private scratch without adopting the legacy worker home', async () => {
    const harness = makeHarness();
    const staged = await applier.stageProfile({
      ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
    });
    const legacyHome = path.join(harness.paths.stateDir, '.rc-bootstrap-worker-home');
    fs.mkdirSync(legacyHome, { mode: 0o700 });
    const legacySentinel = path.join(legacyHome, 'legacy-sentinel');
    fs.writeFileSync(legacySentinel, 'PRESERVE_LEGACY\n', { mode: 0o600 });
    const legacyIdentity = fs.lstatSync(legacyHome);
    try {
      const result = runAdmissionApply(harness, staged.txId, 'normal');
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const admission = admissionResult(result);
      expect(admission).toMatchObject({ ok: true, spawnCalls: 2 });
      expect(admission.workerHomes).toHaveLength(2);
      for (const record of admission.workerHomes) {
        expect(record.homeIdentity).toMatchObject({ mode: 0o700 });
        expect(record.tmpIdentity).toMatchObject({ mode: 0o700 });
        if (typeof process.getuid === 'function') {
          expect(record.homeIdentity.uid).toBe(process.getuid());
          expect(record.tmpIdentity.uid).toBe(process.getuid());
        }
      }
      expect(fs.existsSync(legacySentinel)).toBe(true);
      const legacyAfter = fs.lstatSync(legacyHome);
      expect({ dev: legacyAfter.dev, ino: legacyAfter.ino }).toEqual({
        dev: legacyIdentity.dev, ino: legacyIdentity.ino,
      });
      expect(new Set(admission.workerHomes.map((record: any) => record.home)).size).toBe(2);
      for (const record of admission.workerHomes) {
        expect(record.home).not.toBe(legacyHome);
        expect(record.home).toContain(staged.txId);
        expect(record.tmp).toBe(path.join(record.home, 'tmp'));
        expect(record.homeExistsAfter).toBe(false);
      }
    } finally {
      await applier.rollbackProfile({ ...harness.paths, txId: staged.txId });
    }
  }, 45_000);

  it('fails closed and preserves a rebound scratch path during identity-scoped cleanup', async () => {
    const harness = makeHarness();
    const staged = await applier.stageProfile({
      ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
    });
    const result = runAdmissionApply(harness, staged.txId, 'home-rebind');
    expect(result.error).toBeUndefined();
    const admission = admissionResult(result);
    expect(admission.spawnCalls).toBe(2);
    expect(admission.workerHomes).toHaveLength(2);
    const live = admission.workerHomes[1];
    expect({
      dev: live.heldIdentity.dev,
      ino: live.heldIdentity.ino,
      mode: live.heldIdentity.mode,
      uid: live.heldIdentity.uid,
    }).toEqual({
      dev: live.homeIdentity.dev,
      ino: live.homeIdentity.ino,
      mode: live.homeIdentity.mode,
      uid: live.homeIdentity.uid,
    });
    expect(live.replacementIdentity).toBeTruthy();
    expect(live.replacementIdentity.dev === live.homeIdentity.dev
      && live.replacementIdentity.ino === live.homeIdentity.ino).toBe(false);
    expect(live.heldExistsAfter).toBe(true);
    expect(live.replacementSentinelExists).toBe(true);
    expect(fs.readFileSync(live.replacementSentinel, 'utf8')).toBe('PRESERVE_REPLACEMENT\n');
    expect(result.status).not.toBe(0);
    expect(admission).toMatchObject({
      ok: false,
      code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    await expect(applier.rollbackProfile({ ...harness.paths, txId: staged.txId }))
      .rejects.toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(fs.readFileSync(live.replacementSentinel, 'utf8')).toBe('PRESERVE_REPLACEMENT\n');
  }, 45_000);

  it.skipIf(process.platform === 'win32')(
    'binds the worker lease to the exact lifecycle inode before canonical cron mutation',
    async () => {
      const harness = makeHarness();
      const beforeJobs = worker(harness.paths.stateDir, 'inspect').jobs;
      const staged = await applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      });
      const result = runAdmissionApply(harness, staged.txId, 'lifecycle-rebind');
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      const admission = admissionResult(result);
      expect(admission).toMatchObject({
        ok: false,
        code: 'CRON_WORKER_LIFECYCLE_INVALID',
        spawnCalls: 2,
      });
      expect(admission.lifecycleRebind.before).not.toEqual(
        admission.lifecycleRebind.replacement,
      );
      expect(fs.existsSync(admission.lifecycleRebind.held)).toBe(true);
      expect(fs.existsSync(admission.lifecycleRebind.lifecycle)).toBe(true);
      expect(worker(harness.paths.stateDir, 'inspect').jobs).toEqual(beforeJobs);
    },
    45_000,
  );

  it.skipIf(process.platform === 'win32').each(['file', 'symlink'] as const)(
    'production scratch helper preserves an existing exact %s candidate',
    async (kind) => {
      const harness = makeHarness();
      const staged = await applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      });
      const nonce = '11111111-1111-4111-8111-111111111111';
      const candidate = applier.__testing.cronWorkerScratchCandidate(
        harness.paths, staged.txId, nonce,
      );
      let target = '';
      let targetSentinel = '';
      if (kind === 'file') {
        fs.writeFileSync(candidate, 'PRESERVE_EXACT_FILE\n', { flag: 'wx', mode: 0o600 });
      } else {
        target = path.join(harness.root, 'scratch-collision-target');
        fs.mkdirSync(target, { mode: 0o700 });
        targetSentinel = path.join(target, 'target-sentinel');
        fs.writeFileSync(targetSentinel, 'PRESERVE_EXACT_TARGET\n', {
          flag: 'wx', mode: 0o600,
        });
        fs.symlinkSync(target, candidate);
      }
      const before = fs.lstatSync(candidate);
      const targetBefore = target ? fs.lstatSync(target) : null;
      let failure: any;
      try {
        applier.__testing.createCronWorkerScratchProbe(harness.paths, staged.txId, nonce);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'CRON_WORKER_FAILED' });
      const after = fs.lstatSync(candidate);
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
      if (kind === 'file') {
        expect(after.isFile()).toBe(true);
        expect(fs.readFileSync(candidate, 'utf8')).toBe('PRESERVE_EXACT_FILE\n');
      } else {
        expect(after.isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(candidate)).toBe(target);
        const targetAfter = fs.lstatSync(target);
        expect({ dev: targetAfter.dev, ino: targetAfter.ino }).toEqual({
          dev: targetBefore!.dev, ino: targetBefore!.ino,
        });
        expect(fs.readFileSync(targetSentinel, 'utf8')).toBe('PRESERVE_EXACT_TARGET\n');
      }
      await expect(applier.rollbackProfile({ ...harness.paths, txId: staged.txId }))
        .rejects.toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      const preserved = fs.lstatSync(candidate);
      expect({ dev: preserved.dev, ino: preserved.ino })
        .toEqual({ dev: before.dev, ino: before.ino });
      if (kind === 'file') {
        expect(fs.readFileSync(candidate, 'utf8')).toBe('PRESERVE_EXACT_FILE\n');
      } else {
        expect(fs.readlinkSync(candidate)).toBe(target);
        expect(fs.readFileSync(targetSentinel, 'utf8')).toBe('PRESERVE_EXACT_TARGET\n');
      }
    },
    30_000,
  );

  it('quarantines identity-bound scratch before ordinary cleanup and leaves no residue', async () => {
    const harness = makeHarness();
    const staged = await applier.stageProfile({
      ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
    });
    const epoch = crypto.randomUUID();
    const phases: string[] = [];
    try {
      const result = applier.__testing.runCronScratchCleanupProbe(
        harness.paths,
        staged.txId,
        epoch,
        (phase: string) => { phases.push(phase); },
      );
      expect(phases).toContain('identity-checked');
      expect(fs.existsSync(result.home)).toBe(false);
      const quarantineRoot = cronCleanupQuarantineRoot(harness);
      expect(!fs.existsSync(quarantineRoot) || fs.readdirSync(quarantineRoot).length === 0)
        .toBe(true);

      const ignored = spawnSync('git', [
        'check-ignore', '-q', '--',
        'config/.rc-bootstrap/cron-worker-cleanup-quarantine/probe/payload',
      ], { cwd: ROOT, encoding: 'utf8' });
      expect(ignored.error, ignored.stderr).toBeUndefined();
      expect(ignored.status, ignored.stderr).toBe(0);
      expect(fs.readFileSync(
        path.join(ROOT, 'scripts/bootstrap-profile/secret-copy-scan.cjs'), 'utf8',
      )).not.toContain('cron-worker-cleanup-quarantine');
      expect(phases).toContain('quarantined');
      expect(phases.at(-1)).toBe('removed');
    } finally {
      await applier.rollbackProfile({ ...harness.paths, txId: staged.txId });
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'preserves a HOME rebound after the cleanup identity check across rollback and recovery',
    async () => {
      const harness = makeHarness();
      const staged = await applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      });
      const epoch = crypto.randomUUID();
      const home = applier.__testing.cronWorkerScratchCandidate(
        harness.paths, staged.txId, epoch,
      );
      const held = `${home}.held-home-rebind`;
      const replacementSentinel = path.join(home, 'replacement-sentinel');
      const phases: string[] = [];
      let injected = false;
      let created: any;
      let heldIdentity: ReturnType<typeof fs.lstatSync> | undefined;
      let replacementIdentity: ReturnType<typeof fs.lstatSync> | undefined;
      const cleanupFailure = await capturedFailure(() => {
        applier.__testing.runCronScratchCleanupProbe(
          harness.paths,
          staged.txId,
          epoch,
          (phase: string, context: any) => {
            phases.push(phase);
            if (phase === 'created') created = context;
            if (phase !== 'identity-checked' || injected) return;
            injected = true;
            expect(context.path).toBe(home);
            fs.renameSync(home, held);
            heldIdentity = fs.lstatSync(held);
            fs.mkdirSync(home, { mode: 0o700 });
            fs.mkdirSync(path.join(home, 'tmp'), { mode: 0o700 });
            fs.chmodSync(home, 0o700);
            fs.chmodSync(path.join(home, 'tmp'), 0o700);
            fs.writeFileSync(replacementSentinel, 'PRESERVE_HOME_REPLACEMENT\n', {
              flag: 'wx', mode: 0o600,
            });
            replacementIdentity = fs.lstatSync(home);
          },
        );
      });
      const statusFailure = await capturedFailure(
        () => applier.profileStatus(harness.paths),
      );
      const stageFailure = await capturedFailure(() => applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      }));
      const applyFailure = await capturedFailure(
        () => applier.applyProfile({ ...harness.paths, txId: staged.txId }),
      );
      const rollbackFailure = await capturedFailure(
        () => applier.rollbackProfile({ ...harness.paths, txId: staged.txId }),
      );
      const recoveryFailure = await capturedFailure(
        () => applier.recoverProfiles(harness.paths),
      );

      expect(phases).toContain('identity-checked');
      expect(injected).toBe(true);
      expect(created).toBeTruthy();
      expect({ dev: String(heldIdentity!.dev), ino: String(heldIdentity!.ino) }).toEqual({
        dev: created.homeIdentity.dev,
        ino: created.homeIdentity.ino,
      });
      expect({ dev: String(replacementIdentity!.dev), ino: String(replacementIdentity!.ino) })
        .not.toEqual({ dev: created.homeIdentity.dev, ino: created.homeIdentity.ino });
      expect(cleanupFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(statusFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(stageFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(applyFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(rollbackFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(recoveryFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      const heldAfter = fs.lstatSync(held);
      expect({ dev: heldAfter.dev, ino: heldAfter.ino }).toEqual({
        dev: heldIdentity!.dev, ino: heldIdentity!.ino,
      });
      expect(fs.readFileSync(replacementSentinel, 'utf8')).toBe('PRESERVE_HOME_REPLACEMENT\n');
      const quarantineRoot = cronCleanupQuarantineRoot(harness);
      expect(fs.existsSync(quarantineRoot)).toBe(true);
      expect(fs.readdirSync(quarantineRoot).length).toBeGreaterThan(0);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'preserves a TMP rebound after the cleanup identity check across rollback and recovery',
    async () => {
      const harness = makeHarness();
      const staged = await applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      });
      const epoch = crypto.randomUUID();
      const home = applier.__testing.cronWorkerScratchCandidate(
        harness.paths, staged.txId, epoch,
      );
      const tmp = path.join(home, 'tmp');
      const heldTmp = path.join(home, 'tmp-held-rebind');
      const replacementSentinel = path.join(tmp, 'replacement-sentinel');
      const phases: string[] = [];
      let injected = false;
      let created: any;
      let heldIdentity: ReturnType<typeof fs.lstatSync> | undefined;
      let replacementIdentity: ReturnType<typeof fs.lstatSync> | undefined;
      const cleanupFailure = await capturedFailure(() => {
        applier.__testing.runCronScratchCleanupProbe(
          harness.paths,
          staged.txId,
          epoch,
          (phase: string, context: any) => {
            phases.push(phase);
            if (phase === 'created') created = context;
            if (phase !== 'identity-checked' || injected) return;
            injected = true;
            expect(context.path).toBe(home);
            fs.renameSync(tmp, heldTmp);
            heldIdentity = fs.lstatSync(heldTmp);
            fs.mkdirSync(tmp, { mode: 0o700 });
            fs.chmodSync(tmp, 0o700);
            fs.writeFileSync(replacementSentinel, 'PRESERVE_TMP_REPLACEMENT\n', {
              flag: 'wx', mode: 0o600,
            });
            replacementIdentity = fs.lstatSync(tmp);
          },
        );
      });
      const rollbackFailure = await capturedFailure(
        () => applier.rollbackProfile({ ...harness.paths, txId: staged.txId }),
      );
      const recoveryFailure = await capturedFailure(
        () => applier.recoverProfiles(harness.paths),
      );

      expect(phases).toContain('identity-checked');
      expect(injected).toBe(true);
      expect(created).toBeTruthy();
      expect({ dev: String(heldIdentity!.dev), ino: String(heldIdentity!.ino) }).toEqual({
        dev: created.tmpIdentity.dev,
        ino: created.tmpIdentity.ino,
      });
      expect({ dev: String(replacementIdentity!.dev), ino: String(replacementIdentity!.ino) })
        .not.toEqual({ dev: created.tmpIdentity.dev, ino: created.tmpIdentity.ino });
      expect(cleanupFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(rollbackFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(recoveryFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      const homeAfter = fs.lstatSync(home);
      expect({ dev: String(homeAfter.dev), ino: String(homeAfter.ino) }).toEqual({
        dev: created.homeIdentity.dev,
        ino: created.homeIdentity.ino,
      });
      const heldAfter = fs.lstatSync(heldTmp);
      expect({ dev: heldAfter.dev, ino: heldAfter.ino }).toEqual({
        dev: heldIdentity!.dev, ino: heldIdentity!.ino,
      });
      expect(fs.readFileSync(replacementSentinel, 'utf8')).toBe('PRESERVE_TMP_REPLACEMENT\n');
      const quarantineRoot = cronCleanupQuarantineRoot(harness);
      expect(fs.existsSync(quarantineRoot)).toBe(true);
      expect(fs.readdirSync(quarantineRoot).length).toBeGreaterThan(0);
    },
    30_000,
  );

  it('preserves an unknown cleanup quarantine across status and recovery', async () => {
    const harness = makeHarness();
    const staged = await applier.stageProfile({
      ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
    });
    const quarantineRoot = cronCleanupQuarantineRoot(harness);
    fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(quarantineRoot, 0o700);
    const unknownResidue = path.join(quarantineRoot, 'unknown-residue');
    fs.writeFileSync(unknownResidue, 'PRESERVE_UNKNOWN_QUARANTINE\n', {
      flag: 'wx', mode: 0o600,
    });
    const unknownIdentity = fs.lstatSync(unknownResidue);
    const transactionRoot = path.join(
      path.dirname(harness.paths.configPath), '.rc-bootstrap', 'transactions', staged.txId,
    );

    const statusFailure = await capturedFailure(
      () => applier.profileStatus(harness.paths),
    );
    const recoveryFailure = await capturedFailure(
      () => applier.recoverProfiles(harness.paths),
    );

    expect(statusFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(recoveryFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(fs.existsSync(transactionRoot)).toBe(true);
    const unknownAfter = fs.lstatSync(unknownResidue);
    expect({ dev: unknownAfter.dev, ino: unknownAfter.ino }).toEqual({
      dev: unknownIdentity.dev, ino: unknownIdentity.ino,
    });
    expect(fs.readFileSync(unknownResidue, 'utf8')).toBe('PRESERVE_UNKNOWN_QUARANTINE\n');
  }, 30_000);

  it.each([
    'intent-container-created',
    'source-renamed',
    'quarantined',
  ] as const)(
    'recovers an authenticated cleanup crash at %s without status-side deletion',
    async (phase) => {
      const harness = makeHarness();
      const staged = await applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      });
      const epoch = crypto.randomUUID();
      const observed = await crashScratchCleanupAtPhase(harness, staged.txId, epoch, phase);
      const source = observed.created.home as string;
      const payload = observed.context.payload as string;
      const quarantine = observed.context.quarantine as string;
      const quarantineRoot = cronCleanupQuarantineRoot(harness);
      expect(observed.context.path).toBe(source);
      expect(fs.realpathSync(path.dirname(quarantine))).toBe(fs.realpathSync(quarantineRoot));
      expect(fs.existsSync(quarantine)).toBe(true);
      if (phase === 'intent-container-created') {
        expect(fs.existsSync(source)).toBe(true);
        expect(fs.existsSync(payload)).toBe(false);
        expect(fs.readdirSync(quarantine)).toEqual([]);
      } else {
        expect(fs.existsSync(source)).toBe(false);
        expect(fs.existsSync(payload)).toBe(true);
      }

      const authorityFile = cronCleanupAuthorityFile(harness, staged.txId, epoch);
      const authorityBefore = fs.existsSync(authorityFile)
        ? {
            metadata: fs.lstatSync(authorityFile),
            value: JSON.parse(fs.readFileSync(authorityFile, 'utf8')),
          } : null;
      const qBeforeStatus = pathTreeIdentity(quarantineRoot);
      const statusFailure = await capturedFailure(
        () => applier.profileStatus(harness.paths),
      );
      const qAfterStatus = pathTreeIdentity(quarantineRoot);
      let recoveryResult: any;
      const recoveryFailure = await capturedFailure(async () => {
        recoveryResult = await applier.recoverProfiles(harness.paths);
      });

      expect(statusFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(qAfterStatus).toEqual(qBeforeStatus);
      expect(recoveryFailure).toBeUndefined();
      expect(authorityBefore).toBeTruthy();
      expect(authorityBefore!.metadata.isFile()).toBe(true);
      expect(authorityBefore!.metadata.nlink).toBe(1);
      if (process.platform !== 'win32') {
        expect(authorityBefore!.metadata.mode & 0o7777).toBe(0o600);
      }
      expect(authorityBefore!.value).toMatchObject({
        version: 1,
        txId: staged.txId,
        kind: 'scratch',
        epoch,
        container: path.basename(quarantine),
      });
      expect(recoveryResult.recovered).toContain(staged.txId);
      expect(!fs.existsSync(quarantineRoot) || fs.readdirSync(quarantineRoot).length === 0)
        .toBe(true);
      expect(fs.existsSync(path.join(
        path.dirname(harness.paths.configPath), '.rc-bootstrap', 'transactions', staged.txId,
      ))).toBe(false);
    },
    30_000,
  );

  it('fails closed if canonical scratch is recreated after quarantine verification', async () => {
    const harness = makeHarness();
    const staged = await applier.stageProfile({
      ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
    });
    const epoch = crypto.randomUUID();
    let created: any;
    let quarantined: any;
    let injected = false;
    const cleanupFailure = await capturedFailure(() => {
      applier.__testing.runCronScratchCleanupProbe(
        harness.paths, staged.txId, epoch, (phase: string, context: any) => {
          if (phase === 'created') {
            created = context;
            fs.writeFileSync(path.join(context.home, 'original-sentinel'), 'ORIGINAL_SCRATCH\n', {
              flag: 'wx', mode: 0o600,
            });
          }
          if (phase !== 'quarantined' || injected) return;
          injected = true;
          quarantined = context;
          fs.mkdirSync(context.path, { mode: 0o700 });
          fs.mkdirSync(path.join(context.path, 'tmp'), { mode: 0o700 });
          if (process.platform !== 'win32') {
            fs.chmodSync(context.path, 0o700);
            fs.chmodSync(path.join(context.path, 'tmp'), 0o700);
          }
          fs.writeFileSync(path.join(context.path, 'replacement-sentinel'), 'RECREATED_CANONICAL\n', {
            flag: 'wx', mode: 0o600,
          });
        },
      );
    });
    const rollbackFailure = await capturedFailure(
      () => applier.rollbackProfile({ ...harness.paths, txId: staged.txId }),
    );
    const recoveryFailure = await capturedFailure(
      () => applier.recoverProfiles(harness.paths),
    );

    expect(injected).toBe(true);
    expect(created).toBeTruthy();
    expect(quarantined).toBeTruthy();
    expect(cleanupFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(rollbackFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(recoveryFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(fs.readFileSync(path.join(created.home, 'replacement-sentinel'), 'utf8'))
      .toBe('RECREATED_CANONICAL\n');
    expect(fs.readFileSync(path.join(quarantined.payload, 'original-sentinel'), 'utf8'))
      .toBe('ORIGINAL_SCRATCH\n');
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'fails closed before source rename if the cleanup container identity changes',
    async () => {
      const harness = makeHarness();
      const staged = await applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      });
      const epoch = crypto.randomUUID();
      let created: any;
      let checked: any;
      let held = '';
      let heldIdentity: ReturnType<typeof fs.lstatSync> | undefined;
      let replacementIdentity: ReturnType<typeof fs.lstatSync> | undefined;
      const cleanupFailure = await capturedFailure(() => {
        applier.__testing.runCronScratchCleanupProbe(
          harness.paths, staged.txId, epoch, (phase: string, context: any) => {
            if (phase === 'created') {
              created = context;
              fs.writeFileSync(path.join(context.home, 'source-sentinel'), 'PRESERVE_SOURCE\n', {
                flag: 'wx', mode: 0o600,
              });
            }
            if (phase !== 'identity-checked' || held) return;
            checked = context;
            held = `${context.quarantine}.held`;
            fs.renameSync(context.quarantine, held);
            heldIdentity = fs.lstatSync(held);
            fs.mkdirSync(context.quarantine, { mode: 0o700 });
            fs.chmodSync(context.quarantine, 0o700);
            replacementIdentity = fs.lstatSync(context.quarantine);
          },
        );
      });
      const rollbackFailure = await capturedFailure(
        () => applier.rollbackProfile({ ...harness.paths, txId: staged.txId }),
      );

      expect(created).toBeTruthy();
      expect(checked).toBeTruthy();
      expect({ dev: String(heldIdentity!.dev), ino: String(heldIdentity!.ino) })
        .not.toEqual({ dev: String(replacementIdentity!.dev), ino: String(replacementIdentity!.ino) });
      expect(cleanupFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(rollbackFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(fs.readFileSync(path.join(created.home, 'source-sentinel'), 'utf8'))
        .toBe('PRESERVE_SOURCE\n');
      expect(fs.lstatSync(held).ino).toBe(heldIdentity!.ino);
      expect(fs.lstatSync(checked.quarantine).ino).toBe(replacementIdentity!.ino);
    },
    30_000,
  );

  it('fails closed before source rename if the cleanup intent is tampered', async () => {
    const harness = makeHarness();
    const staged = await applier.stageProfile({
      ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
    });
    const epoch = crypto.randomUUID();
    let created: any;
    let checked: any;
    const cleanupFailure = await capturedFailure(() => {
      applier.__testing.runCronScratchCleanupProbe(
        harness.paths, staged.txId, epoch, (phase: string, context: any) => {
          if (phase === 'created') {
            created = context;
            fs.writeFileSync(path.join(context.home, 'source-sentinel'), 'PRESERVE_SOURCE\n', {
              flag: 'wx', mode: 0o600,
            });
          }
          if (phase !== 'identity-checked' || checked) return;
          checked = context;
          fs.writeFileSync(context.intentFile, 'tampered cleanup intent\n', { flag: 'w' });
        },
      );
    });
    const rollbackFailure = await capturedFailure(
      () => applier.rollbackProfile({ ...harness.paths, txId: staged.txId }),
    );

    expect(created).toBeTruthy();
    expect(checked).toBeTruthy();
    expect(cleanupFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(rollbackFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(fs.readFileSync(path.join(created.home, 'source-sentinel'), 'utf8'))
      .toBe('PRESERVE_SOURCE\n');
    expect(fs.readFileSync(checked.intentFile, 'utf8')).toBe('tampered cleanup intent\n');
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'preserves both payload identities if the quarantined payload is rebound',
    async () => {
      const harness = makeHarness();
      const staged = await applier.stageProfile({
        ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
      });
      const epoch = crypto.randomUUID();
      let checked: any;
      let quarantined: any;
      let heldPayload = '';
      let intentBefore = Buffer.alloc(0);
      const cleanupFailure = await capturedFailure(() => {
        applier.__testing.runCronScratchCleanupProbe(
          harness.paths, staged.txId, epoch, (phase: string, context: any) => {
            if (phase === 'created') {
              fs.writeFileSync(path.join(context.home, 'source-sentinel'), 'ORIGINAL_PAYLOAD\n', {
                flag: 'wx', mode: 0o600,
              });
            }
            if (phase === 'identity-checked') {
              checked = context;
              intentBefore = fs.readFileSync(context.intentFile);
            }
            if (phase !== 'quarantined' || heldPayload) return;
            quarantined = context;
            heldPayload = `${context.payload}.held`;
            fs.renameSync(context.payload, heldPayload);
            fs.mkdirSync(context.payload, { mode: 0o700 });
            fs.mkdirSync(path.join(context.payload, 'tmp'), { mode: 0o700 });
            fs.chmodSync(context.payload, 0o700);
            fs.chmodSync(path.join(context.payload, 'tmp'), 0o700);
            fs.writeFileSync(path.join(context.payload, 'replacement-sentinel'), 'REPLACEMENT_PAYLOAD\n', {
              flag: 'wx', mode: 0o600,
            });
          },
        );
      });
      const rollbackFailure = await capturedFailure(
        () => applier.rollbackProfile({ ...harness.paths, txId: staged.txId }),
      );

      expect(checked).toBeTruthy();
      expect(quarantined).toBeTruthy();
      expect(cleanupFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(rollbackFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(fs.readFileSync(path.join(heldPayload, 'source-sentinel'), 'utf8'))
        .toBe('ORIGINAL_PAYLOAD\n');
      expect(fs.readFileSync(path.join(quarantined.payload, 'replacement-sentinel'), 'utf8'))
        .toBe('REPLACEMENT_PAYLOAD\n');
      expect(fs.readFileSync(checked.intentFile)).toEqual(intentBefore);
    },
    30_000,
  );

  it('assigns distinct transaction-bound scratch roots to concurrent workers', async () => {
    const harness = makeHarness();
    const staged = await applier.stageProfile({
      ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
    });
    const workerFile = path.join(ROOT, 'test/fixtures/bootstrap-profile-scratch-worker.mjs');
    const ready = path.join(harness.paths.stateDir, '.scratch-workers-ready');
    const controls = { workerFile, timeoutMs: 500 };
    const first = applier.__testing.runCronScratchProbe(harness.paths, staged.txId, controls);
    const second = applier.__testing.runCronScratchProbe(harness.paths, staged.txId, controls);
    const settlement = Promise.allSettled([first, second]);
    let records: any[] = [];
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (fs.existsSync(ready)) {
          records = fs.readFileSync(ready, 'utf8').trim().split('\n')
            .filter(Boolean).map((line) => JSON.parse(line));
          if (records.length >= 2) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const settled = await settlement;
      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => record.pid)).size).toBe(2);
      for (const record of records) {
        expect(record.homeIdentity).toMatchObject({ mode: 0o700 });
        expect(record.tmpIdentity).toMatchObject({ mode: 0o700 });
        expect(record.tmpdir).toBe(path.join(record.home, 'tmp'));
      }
      expect(settled.every((result) => result.status === 'rejected')).toBe(true);
      expect(applier.__testing.activeCronWorkerPids()).toEqual([]);
      expect(new Set(records.map((record) => record.home)).size).toBe(2);
      for (const record of records) {
        expect(record.home).toContain(staged.txId);
        expect(fs.existsSync(record.home)).toBe(false);
      }
    } finally {
      await settlement;
      await applier.rollbackProfile({ ...harness.paths, txId: staged.txId });
    }
  }, 15_000);

  it('retires the exact live epoch when the second worker spawn throws synchronously', async () => {
    const harness = makeHarness();
    const staged = await applier.stageProfile({
      ...harness.paths, capsuleBytes: capsule(), rcVersion: '0.8.3',
    });
    try {
      const result = runAdmissionApply(harness, staged.txId, 'spawn-throw');
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(admissionResult(result)).toMatchObject({
        ok: false,
        spawnCalls: 2,
      });
      expect(cronLifecycleState(harness, staged.txId)).toBe('idle');
    } finally {
      await applier.rollbackProfile({ ...harness.paths, txId: staged.txId });
    }
  }, 45_000);

  it('uses the official OC SDK in a short worker and removes only exact device jobs', async () => {
    const harness = makeHarness();
    const result = await install(harness, capsule());
    const rows = monitorRows(harness);
    expect(rows.find((row) => row.id === 'device-bound')).toMatchObject({ enabled: 0, gateway_job_id: null });
    expect(rows.find((row) => row.id === 'device-session')).toMatchObject({ enabled: 0, gateway_job_id: null });
    expect(rows.find((row) => row.id === 'device-whitespace')).toMatchObject({ enabled: 0, gateway_job_id: null });
    expect(rows.find((row) => row.id === 'feed-monitor')).toMatchObject({ enabled: 1, gateway_job_id: 'job-feed' });

    const currentJobs = worker(harness.paths.stateDir, 'inspect').jobs.map((item: any) => item.id);
    expect(currentJobs).toEqual(['job-feed', 'prefix-trap', 'name-trap']);
    expect(result.cronWorkers).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'inspect', target: 'clone', exited: true }),
      expect.objectContaining({ action: 'compare-and-replace', target: 'live', exited: true }),
    ]));
    for (const record of result.cronWorkers) expect(record.pid).not.toBe(process.pid);

    const source = fs.readFileSync(CRON_WORKER, 'utf8');
    expect(source).toContain('openclaw/plugin-sdk/cron-store-runtime');
    expect(source).not.toMatch(/cron_jobs|INSERT INTO|DELETE FROM|UPDATE\s+cron/i);
  });

  it('persists the original baseline once and transfers ownership across disabled profiles', async () => {
    const harness = makeHarness();
    await install(harness, capsule());
    const first = ledger(harness);
    const firstEntries = structuredClone(first.entries);
    expect(first.entries['device-bound'].ownerProfileId).toBe('thermoelectric-user-a');
    expect(first.entries['device-bound'].baselineRowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.entries['device-bound'].jobs.map((item: any) => item.id)).toEqual(['job-device-bound']);

    await install(harness, capsule({ profileId: 'thermoelectric-user-b' }));
    const second = ledger(harness);
    for (const id of ['device-bound', 'device-session']) {
      expect(second.entries[id].ownerProfileId).toBe('thermoelectric-user-b');
      expect({ ...second.entries[id], ownerProfileId: firstEntries[id].ownerProfileId })
        .toEqual(firstEntries[id]);
    }
    expect(second.mcp.plaud.ownerProfileId).toBe('thermoelectric-user-b');
    expect({ ...second.mcp.plaud, ownerProfileId: first.mcp.plaud.ownerProfileId })
      .toEqual(first.mcp.plaud);
  });

  it('fails closed if a new exact device cron job appears while the durable suspension is owned', async () => {
    const harness = makeHarness();
    await install(harness, capsule());
    const current = worker(harness.paths.stateDir, 'inspect').jobs;
    current.push(job('new-device-job', 'cron:rc-monitor:device-session'));
    worker(harness.paths.stateDir, 'seed', { version: 1, jobs: current });

    const staged = await applier.stageProfile({
      ...harness.paths, capsuleBytes: capsule({ revision: 2 }), rcVersion: '0.8.3',
    });
    await expect(applier.applyProfile({
      ...harness.paths, txId: staged.txId,
    })).rejects.toMatchObject({ code: 'SUSPENSION_CONFLICT' });
    expect(worker(harness.paths.stateDir, 'inspect').jobs.map((item: any) => item.id))
      .toContain('new-device-job');
  });

  it('restores and consumes the durable ledger for enabled policy without claiming full uninstall', async () => {
    const harness = makeHarness();
    const originalRows = monitorRows(harness);
    await install(harness, capsule());
    await install(harness, capsule({ revision: 2, peripherals: 'enabled' }));

    expect(monitorRows(harness)).toEqual(originalRows);
    expect(worker(harness.paths.stateDir, 'inspect').jobs).toEqual(harness.jobs);
    expect(ledger(harness).entries).toEqual({});
    const restoredConfig = config(harness);
    expect(restoredConfig.tools.deny).toEqual(['user-rule']);
    expect(Object.hasOwn(restoredConfig.mcp.servers.plaud, 'enabled')).toBe(false);
    expect(restoredConfig.mcp.servers.plaud.env.PLAUD_FIXTURE_SECRET)
      .toBe('PLAUD_TEST_ONLY_FAKE_SECRET');
    expect(restoredConfig.mcp.servers['user-server'])
      .toEqual({ command: 'user-mcp', args: ['--preserve'] });
    const receipt = JSON.parse(fs.readFileSync(
      path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap', 'receipt.json'),
      'utf8',
    ));
    expect(receipt).not.toHaveProperty('uninstallPreimage');
  });


  it.each([
    ['absent', undefined],
    ['true', true],
    ['false', false],
  ] as const)('suspends exact Plaud MCP enabled=%s without copying secrets to the durable ledger', async (_label, initial) => {
    const harness = makeHarness();
    const before = config(harness);
    if (initial !== undefined) before.mcp.servers.plaud.enabled = initial;
    writeJson(harness.paths.configPath, before);

    await install(harness, capsule());
    const disabled = config(harness);
    expect(disabled.mcp.servers.plaud).toMatchObject({
      ...before.mcp.servers.plaud,
      enabled: false,
    });
    expect(disabled.mcp.servers['user-server']).toEqual(before.mcp.servers['user-server']);
    expect(disabled.tools.deny).toEqual(['user-rule', 'periph_*', 'plaud__*']);
    const durable = ledger(harness);
    expect(durable.mcp.plaud).toMatchObject({
      ownerProfileId: 'thermoelectric-user-a',
      baseline: { enabledPresent: initial !== undefined, enabledValue: initial ?? null },
    });
    expect(durable.mcp.plaud.expectedEnabledValue).toBe(false);
    expect(JSON.stringify(durable)).not.toContain('PLAUD_TEST_ONLY_FAKE');

    await install(harness, capsule({ revision: 2, peripherals: 'enabled' }));
    const restored = config(harness);
    if (initial === undefined) expect(Object.hasOwn(restored.mcp.servers.plaud, 'enabled')).toBe(false);
    else expect(restored.mcp.servers.plaud.enabled).toBe(initial);
    expect({ ...restored.mcp.servers.plaud, ...(initial === undefined ? { enabled: undefined } : {}) })
      .toMatchObject(initial === undefined ? before.mcp.servers.plaud : { ...before.mcp.servers.plaud, enabled: initial });
    expect(ledger(harness).mcp).toEqual({});
  });

  it('does nothing when Plaud is absent, preserves non-owned edits, and conflicts only on the owned field', async () => {
    const absent = makeHarness();
    const absentConfig = config(absent);
    delete absentConfig.mcp.servers.plaud;
    writeJson(absent.paths.configPath, absentConfig);
    await install(absent, capsule());
    expect(config(absent).mcp.servers).toEqual({
      'user-server': { command: 'user-mcp', args: ['--preserve'] },
    });
    expect(ledger(absent).mcp).toEqual({});

    const editedHarness = makeHarness();
    await install(editedHarness, capsule());
    const edited = config(editedHarness);
    edited.mcp.servers.plaud.args.push('--operator-edit');
    writeJson(editedHarness.paths.configPath, edited);
    await applier.restorePeripherals({
      ...editedHarness.paths,
    });
    const explicitlyRestored = config(editedHarness);
    expect(explicitlyRestored.mcp.servers.plaud.args).toContain('--operator-edit');
    expect(explicitlyRestored.plugins.entries['research-claw-core'].config.productPolicy.capabilities.peripherals)
      .toBe('enabled');
    expect(ledger(editedHarness).mcp).toEqual({});
    const restoredReceipt = JSON.parse(fs.readFileSync(
      path.join(path.dirname(editedHarness.paths.configPath), '.rc-bootstrap', 'receipt.json'), 'utf8',
    ));
    expect(restoredReceipt.peripheralOverride).toEqual({
      source: 'explicit-restore', value: 'enabled',
    });

    // A later explicit rerun of the same remote Capsule remains authoritative.
    await install(editedHarness, capsule());
    expect(config(editedHarness).plugins.entries['research-claw-core'].config
      .productPolicy.capabilities.peripherals).toBe('disabled');
    expect(JSON.parse(fs.readFileSync(
      path.join(path.dirname(editedHarness.paths.configPath), '.rc-bootstrap', 'receipt.json'), 'utf8',
    ))).not.toHaveProperty('peripheralOverride');

    const conflict = makeHarness();
    await install(conflict, capsule());
    const enabledEdit = config(conflict);
    enabledEdit.mcp.servers.plaud.enabled = true;
    writeJson(conflict.paths.configPath, enabledEdit);
    await expect(applier.restorePeripherals({
      ...conflict.paths,
    })).rejects.toMatchObject({ code: 'SUSPENSION_CONFLICT' });
    expect(config(conflict).mcp.servers.plaud.enabled).toBe(true);
    expect(ledger(conflict).mcp.plaud).toBeTruthy();

    const removed = makeHarness();
    await install(removed, capsule());
    const removedConfig = config(removed);
    delete removedConfig.mcp.servers.plaud;
    writeJson(removed.paths.configPath, removedConfig);
    await expect(applier.restorePeripherals({
      ...removed.paths,
    })).rejects.toMatchObject({ code: 'SUSPENSION_CONFLICT' });
    expect(ledger(removed).mcp.plaud).toBeTruthy();
  });

  it('supports explicit peripheral restore but fails closed on local monitor conflicts', async () => {
    const harness = makeHarness();
    await install(harness, capsule());
    const db = new Database(harness.paths.dbPath);
    db.prepare("UPDATE rc_monitors SET target='operator-edit' WHERE id='device-bound'").run();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const jobsBefore = worker(harness.paths.stateDir, 'inspect').jobs;

    await expect(applier.restorePeripherals({
      ...harness.paths,
    })).rejects.toMatchObject({ code: 'SUSPENSION_CONFLICT' });
    expect(worker(harness.paths.stateDir, 'inspect').jobs).toEqual(jobsBefore);
    expect(Object.keys(ledger(harness).entries)).toContain('device-bound');
  });

  it('rolls back an interrupted explicit restore as one four-volume transaction', async () => {
    const harness = makeHarness();
    await install(harness, capsule());
    const configBefore = fs.readFileSync(harness.paths.configPath);
    const ledgerBefore = fs.readFileSync(path.join(
      path.dirname(harness.paths.configPath), '.rc-bootstrap', 'peripheral-suspensions.json',
    ));
    const receiptBefore = fs.readFileSync(path.join(
      path.dirname(harness.paths.configPath), '.rc-bootstrap', 'receipt.json',
    ));
    const rowsBefore = monitorRows(harness);
    const jobsBefore = worker(harness.paths.stateDir, 'inspect').jobs;

    await expect(applier.restorePeripherals({
      ...harness.paths, fault: 'cron',
    })).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    expect(fs.readFileSync(harness.paths.configPath)).toEqual(configBefore);
    expect(fs.readFileSync(path.join(
      path.dirname(harness.paths.configPath), '.rc-bootstrap', 'peripheral-suspensions.json',
    ))).toEqual(ledgerBefore);
    expect(fs.readFileSync(path.join(
      path.dirname(harness.paths.configPath), '.rc-bootstrap', 'receipt.json',
    ))).toEqual(receiptBefore);
    expect(monitorRows(harness)).toEqual(rowsBefore);
    expect(worker(harness.paths.stateDir, 'inspect').jobs).toEqual(jobsBefore);
    expect(fs.readdirSync(path.join(
      path.dirname(harness.paths.configPath), '.rc-bootstrap', 'transactions',
    ))).toEqual([]);
  });

  it('same-digest no-op inspects only an isolated cron clone and leaves live DB bytes unchanged', async () => {
    const harness = makeHarness();
    await install(harness, capsule());
    const byteState = (files: string[]) => files.map((file) => ({
      file: path.basename(file),
      present: fs.existsSync(file),
      bytes: fs.existsSync(file)
        ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null,
    }));
    const files = [
      path.join(harness.paths.stateDir, 'state', 'openclaw.sqlite'),
      path.join(harness.paths.stateDir, 'state', 'openclaw.sqlite-wal'),
      path.join(harness.paths.stateDir, 'state', 'openclaw.sqlite-shm'),
      harness.paths.dbPath,
      `${harness.paths.dbPath}-wal`,
      `${harness.paths.dbPath}-shm`,
    ];
    const before = byteState(files);
    const staged = await applier.stageProfile({
      ...harness.paths,
      capsuleBytes: capsule(),
      rcVersion: '0.8.3',
    });
    const applied = await applier.applyProfile({
      ...harness.paths,
      txId: staged.txId,
    });
    await applier.verifyProfile({ ...harness.paths, txId: staged.txId });
    await applier.commitProfile({ ...harness.paths, txId: staged.txId });
    const after = byteState(files);

    expect(applied.noop).toBe(true);
    expect(applied.cronWorkers).toEqual([
      expect.objectContaining({ action: 'inspect', target: 'clone', exited: true }),
    ]);
    expect(after).toEqual(before);
  });
});
