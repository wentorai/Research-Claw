import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const APPLIER_MODULE = path.join(ROOT, 'scripts/bootstrap-profile/applier.cjs');
const require = createRequire(import.meta.url);
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

const SAFE_CAPSULE_ERROR = 'INVALID_TRANSACTION_CAPSULE';
const FAKE_SECRET = 'RC_TEST_ONLY_FAKE_MODEL_KEY';

type Paths = {
  rcRoot: string;
  configPath: string;
  workspace: string;
  stateDir: string;
  dbPath: string;
  globalConfigPath: string;
};

type Harness = Paths & { root: string };

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stoppedOnFile: boolean;
  payload: null | { ok: boolean; code?: string; state?: string };
};

const temporaryRoots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
}

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-secure-io-'));
  temporaryRoots.push(root);
  const configRoot = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const dataRoot = path.join(root, 'data');
  for (const directory of [configRoot, workspace, stateDir, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  const paths: Harness = {
    root,
    rcRoot: ROOT,
    configPath: path.join(configRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  writeJson(paths.configPath, {
    agents: { defaults: { model: { primary: 'user-provider/user-model' } } },
    models: { mode: 'merge', providers: {
      'user-provider': {
        baseUrl: 'https://user.invalid/v1', api: 'openai-completions', models: [],
      },
    } },
    plugins: { entries: {
      'research-claw-core': { enabled: true, config: { userField: 'preserve' } },
      'dual-model-supervisor': {
        enabled: false,
        config: { enabled: false, supervisorModel: 'user/model', reviewMode: 'off' },
      },
    } },
    tools: { deny: ['user-rule'] },
  });
  writeJson(paths.globalConfigPath, { userGlobal: true });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1,
    profiles: {
      'user-provider:manual': { type: 'api_key', provider: 'user-provider', key: 'USER_KEY' },
    },
  });
  fs.mkdirSync(path.join(workspace, 'skills', 'user-skill'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(workspace, 'skills', 'user-skill', 'SKILL.md'),
    '---\nname: user-skill\ndescription: user owned\n---\n',
    { mode: 0o600 },
  );
  ensureInitialized({ ...paths, externalStopVerified: true });
  return paths;
}

function capsuleBytes(key?: string): Buffer {
  const value = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  if (key !== undefined) value.secrets.modelApiKey = key;
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function stage(paths: Paths, bytes = capsuleBytes()): Promise<any> {
  const result = await applier.stageProfile({
    ...paths,
    capsuleBytes: bytes,
    rcVersion: '0.8.3',
  });
  expect(result).toMatchObject({ state: 'staged', profileId: 'thermoelectric-user-a' });
  return result;
}

function txRoot(paths: Paths, txId: string): string {
  return path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'transactions', txId);
}

function transactionCapsule(paths: Paths, txId: string): string {
  return path.join(txRoot(paths, txId), 'capsule.json');
}

function readManifest(paths: Paths, txId: string): any {
  return JSON.parse(fs.readFileSync(path.join(txRoot(paths, txId), 'manifest.json'), 'utf8'));
}

function hashPath(target: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (current: string, relative: string) => {
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(current);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        hash.update(`${relative}:absent;`);
        return;
      }
      throw error;
    }
    const mode = process.platform === 'win32' ? null : metadata.mode & 0o777;
    if (metadata.isDirectory()) {
      hash.update(`${relative}:directory:${mode};`);
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
    } else if (metadata.isFile()) {
      hash.update(`${relative}:file:${mode}:`);
      hash.update(fs.readFileSync(current));
      hash.update(';');
    } else if (metadata.isSymbolicLink()) {
      hash.update(`${relative}:symlink:${fs.readlinkSync(current)};`);
    } else {
      hash.update(`${relative}:other:${mode};`);
    }
  };
  visit(target, '');
  return hash.digest('hex');
}

function liveState(paths: Paths): Record<string, string> {
  const bootstrap = path.join(path.dirname(paths.configPath), '.rc-bootstrap');
  return Object.fromEntries([
    ['config', paths.configPath],
    ['global', paths.globalConfigPath],
    ['auth', path.join(paths.stateDir, 'agents/main/agent/auth-profiles.json')],
    ['skills', path.join(paths.workspace, 'skills')],
    ['receipt', path.join(bootstrap, 'receipt.json')],
    ['suspensions', path.join(bootstrap, 'peripheral-suspensions.json')],
    ['monitor', paths.dbPath],
    ['monitor-wal', `${paths.dbPath}-wal`],
    ['monitor-shm', `${paths.dbPath}-shm`],
    ['cron', path.join(paths.stateDir, 'state/openclaw.sqlite')],
    ['cron-wal', path.join(paths.stateDir, 'state/openclaw.sqlite-wal')],
    ['cron-shm', path.join(paths.stateDir, 'state/openclaw.sqlite-shm')],
  ].map(([name, target]) => [name, hashPath(target)]));
}

function expectUnmutatedStagedTransaction(
  paths: Paths,
  txId: string,
  before: Record<string, string>,
): void {
  expect.soft(liveState(paths)).toEqual(before);
  expect.soft(readManifest(paths, txId).state).toBe('staged');
  expect.soft(fs.existsSync(txRoot(paths, txId))).toBe(true);
  for (const root of [
    path.join(paths.workspace, '.rc-bootstrap-transactions', txId),
    path.join(paths.stateDir, '.rc-bootstrap-transactions', txId),
    path.join(path.dirname(paths.dbPath), '.rc-bootstrap-transactions', txId),
  ]) expect.soft(fs.existsSync(root)).toBe(false);
}

const APPLY_RUNNER = String.raw`
'use strict';
const applier = require(process.argv[1]);
const options = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
Promise.resolve(applier.applyProfile(options)).then(
  (result) => {
    process.stdout.write(JSON.stringify({ ok: true, state: result && result.state }) + '\n');
  },
  (error) => {
    process.stdout.write(JSON.stringify({
      ok: false,
      code: typeof (error && error.code) === 'string' ? error.code : 'UNEXPECTED_ERROR',
    }) + '\n');
    process.exitCode = 17;
  },
);
`;

async function runApplyChild(
  paths: Paths,
  txId: string,
  options: {
    deadlineMs?: number;
    env?: Record<string, string | undefined>;
    stopWhenFileExists?: string;
  } = {},
): Promise<ChildResult> {
  const encoded = Buffer.from(JSON.stringify({ ...paths, txId })).toString('base64');
  const env = Object.fromEntries(Object.entries({
    PATH: process.env.PATH ?? '',
    ...options.env,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const child = spawn(process.execPath, ['-e', APPLY_RUNNER, APPLIER_MODULE, encoded], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  let timedOut = false;
  let stoppedOnFile = false;
  const watch = options.stopWhenFileExists ? setInterval(() => {
    if (fs.existsSync(options.stopWhenFileExists!)) {
      stoppedOnFile = true;
      child.kill('SIGKILL');
    }
  }, 20) : null;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.deadlineMs ?? 2_000);
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(deadline);
  if (watch) clearInterval(watch);
  children.delete(child);
  const lastLine = stdout.trim().split('\n').filter(Boolean).at(-1);
  let payload: ChildResult['payload'] = null;
  if (lastLine) {
    try { payload = JSON.parse(lastLine); } catch { payload = null; }
  }
  return { ...closed, stdout, stderr, timedOut, stoppedOnFile, payload };
}

async function expectSafeCapsuleRejection(
  paths: Paths,
  txId: string,
  before: Record<string, string>,
): Promise<ChildResult> {
  const result = await runApplyChild(paths, txId, { deadlineMs: 3_000 });
  expect.soft(result.timedOut, `child output: ${result.stdout}${result.stderr}`).toBe(false);
  expect.soft(result.payload).toEqual({ ok: false, code: SAFE_CAPSULE_ERROR });
  expect.soft(result.code).not.toBe(0);
  expect.soft(`${result.stdout}${result.stderr}`).not.toContain(FAKE_SECRET);
  expectUnmutatedStagedTransaction(paths, txId, before);
  return result;
}

async function expectDirectSafeCapsuleRejection(
  paths: Paths,
  txId: string,
  before: Record<string, string>,
): Promise<void> {
  let caught: any = null;
  try {
    await applier.applyProfile({ ...paths, txId });
  } catch (error) {
    caught = error;
  }
  expect.soft(caught?.code).toBe(SAFE_CAPSULE_ERROR);
  expectUnmutatedStagedTransaction(paths, txId, before);
}

describe('secure transaction Capsule reads', () => {
  it('proves the secure fixture can complete stage, apply, and verify', async () => {
    const paths = makeHarness();
    const staged = await stage(paths);
    await expect(applier.applyProfile({ ...paths, txId: staged.txId }))
      .resolves.toMatchObject({ state: 'applied' });
    await expect(applier.verifyProfile({ ...paths, txId: staged.txId }))
      .resolves.toMatchObject({ state: 'verified' });
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'rejects a staged Capsule replaced by a symlink without following its outside FIFO target',
    async () => {
      const paths = makeHarness();
      const staged = await stage(paths);
      const before = liveState(paths);
      const outsideRoot = path.join(paths.root, 'outside');
      fs.mkdirSync(outsideRoot, { mode: 0o700 });
      const outsideFifo = path.join(outsideRoot, 'do-not-read');
      execFileSync('mkfifo', [outsideFifo]);
      fs.rmSync(transactionCapsule(paths, staged.txId));
      fs.symlinkSync(outsideFifo, transactionCapsule(paths, staged.txId));

      await expectSafeCapsuleRejection(paths, staged.txId, before);
      expect(fs.lstatSync(transactionCapsule(paths, staged.txId)).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(outsideFifo).isFIFO()).toBe(true);
    },
    15_000,
  );

  it('rejects a staged Capsule replaced by a hardlink and leaves the outside inode unchanged', async () => {
    const paths = makeHarness();
    const staged = await stage(paths);
    const before = liveState(paths);
    const outside = path.join(paths.root, 'outside-capsule.json');
    fs.writeFileSync(outside, capsuleBytes(), { mode: 0o600 });
    const outsideBefore = fs.readFileSync(outside);
    fs.rmSync(transactionCapsule(paths, staged.txId));
    fs.linkSync(outside, transactionCapsule(paths, staged.txId));
    expect(fs.statSync(outside).nlink).toBe(2);

    await expectDirectSafeCapsuleRejection(paths, staged.txId, before);
    expect(fs.readFileSync(outside)).toEqual(outsideBefore);
    expect(fs.statSync(outside).nlink).toBe(2);
  }, 15_000);

  it.skipIf(process.platform === 'win32')(
    'rejects a staged Capsule replaced by a FIFO within a bounded deadline',
    async () => {
      const paths = makeHarness();
      const staged = await stage(paths);
      const before = liveState(paths);
      fs.rmSync(transactionCapsule(paths, staged.txId));
      execFileSync('mkfifo', [transactionCapsule(paths, staged.txId)]);

      await expectSafeCapsuleRejection(paths, staged.txId, before);
      expect(fs.lstatSync(transactionCapsule(paths, staged.txId)).isFIFO()).toBe(true);
    },
    15_000,
  );

  it('rejects a staged Capsule replaced by a regular file larger than 2 MiB quickly and consistently', async () => {
    const paths = makeHarness();
    const staged = await stage(paths);
    const before = liveState(paths);
    fs.rmSync(transactionCapsule(paths, staged.txId));
    fs.writeFileSync(transactionCapsule(paths, staged.txId), Buffer.alloc(2 * 1024 * 1024 + 1, 0x78), {
      mode: 0o600,
    });

    await expectDirectSafeCapsuleRejection(paths, staged.txId, before);
  }, 15_000);
});

describe.skipIf(process.platform === 'win32')('POSIX private-state permissions', () => {
  it.each([
    ['existing auth store file', (paths: Harness, txId: string) => {
      void txId;
      fs.chmodSync(path.join(paths.stateDir, 'agents/main/agent/auth-profiles.json'), 0o644);
    }],
    ['bootstrap metadata directory', (paths: Harness, txId: string) => {
      void txId;
      fs.chmodSync(path.join(path.dirname(paths.configPath), '.rc-bootstrap'), 0o755);
    }],
    ['transactions directory', (paths: Harness, txId: string) => {
      void txId;
      fs.chmodSync(path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'transactions'), 0o755);
    }],
    ['transaction directory', (paths: Harness, txId: string) => {
      fs.chmodSync(txRoot(paths, txId), 0o755);
    }],
    ['transaction manifest', (paths: Harness, txId: string) => {
      fs.chmodSync(path.join(txRoot(paths, txId), 'manifest.json'), 0o644);
    }],
    ['transaction Capsule', (paths: Harness, txId: string) => {
      fs.chmodSync(transactionCapsule(paths, txId), 0o644);
    }],
  ] as const)('fails closed on weak permissions for the %s before any mutation', async (_label, weaken) => {
    const paths = makeHarness();
    const staged = await stage(paths);
    weaken(paths, staged.txId);
    const before = liveState(paths);

    let caught: any = null;
    try {
      await applier.applyProfile({ ...paths, txId: staged.txId });
    } catch (error) {
      caught = error;
    }
    expect.soft(caught).toBeTruthy();
    expect.soft(typeof caught?.code).toBe('string');
    expect.soft(caught?.code).not.toBe('INJECTED_FAULT');
    expectUnmutatedStagedTransaction(paths, staged.txId, before);
  }, 30_000);
});

describe('structured secret-copy verification', () => {
  it('accepts a minimum-length key without substring false positives', async () => {
    const paths = makeHarness();
    const staged = await stage(paths, capsuleBytes('RC_TEST_MINIMUM1'));
    await applier.applyProfile({ ...paths, txId: staged.txId });
    await expect(applier.verifyProfile({ ...paths, txId: staged.txId }))
      .resolves.toMatchObject({ state: 'verified' });
  }, 30_000);

  it('accepts an unchanged preexisting manual profile that uses the managed API key', async () => {
    const duplicate = makeHarness();
    const duplicateKey = 'RC_TEST_ONLY_DUPLICATE_STRUCTURED_SECRET_987654321';
    const authFile = path.join(duplicate.stateDir, 'agents/main/agent/auth-profiles.json');
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    auth.profiles['deepseek:manual'] = {
      type: 'api_key', provider: 'deepseek', key: duplicateKey,
    };
    writeJson(authFile, auth);
    const duplicateStage = await stage(duplicate, capsuleBytes(duplicateKey));
    await applier.applyProfile({ ...duplicate, txId: duplicateStage.txId });
    await expect(applier.verifyProfile({ ...duplicate, txId: duplicateStage.txId }))
      .resolves.toMatchObject({ state: 'verified' });
    expect(JSON.parse(fs.readFileSync(authFile, 'utf8')).profiles['deepseek:manual'])
      .toEqual({ type: 'api_key', provider: 'deepseek', key: duplicateKey });
  }, 60_000);
});

describe('production fault-hook isolation', () => {
  it('honors the pause hook only with the explicit test environment gate', async () => {
    const paths = makeHarness();
    const staged = await stage(paths);
    const ready = path.join(paths.root, 'test-fault.ready');
    const result = await runApplyChild(paths, staged.txId, {
      deadlineMs: 15_000,
      stopWhenFileExists: ready,
      env: {
        NODE_ENV: 'test',
        RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
        RC_BOOTSTRAP_FAULT_PAUSE_AFTER: 'skills',
        RC_BOOTSTRAP_FAULT_READY: ready,
      },
    });

    expect(result.timedOut).toBe(false);
    expect(result.stoppedOnFile).toBe(true);
    expect(fs.existsSync(ready)).toBe(true);
    expect(readManifest(paths, staged.txId)).toMatchObject({
      state: 'applying',
      lastCompletedStep: 'skills',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(FAKE_SECRET);
  }, 15_000);

  it.each([
    ['production', 'production'],
    ['an unset NODE_ENV', undefined],
    ['test without the private fault gate', 'test'],
  ] as const)('ignores pause variables under %s and never writes the ready file', async (_label, nodeEnv) => {
    const paths = makeHarness();
    const staged = await stage(paths);
    const ready = path.join(paths.root, 'production-fault.ready');
    const result = await runApplyChild(paths, staged.txId, {
      deadlineMs: 15_000,
      stopWhenFileExists: ready,
      env: {
        NODE_ENV: nodeEnv,
        RC_BOOTSTRAP_FAULT_PAUSE_AFTER: 'skills',
        RC_BOOTSTRAP_FAULT_READY: ready,
      },
    });

    expect.soft(result.timedOut, `child output: ${result.stdout}${result.stderr}`).toBe(false);
    expect.soft(result.stoppedOnFile, 'production must not enter the fault pause').toBe(false);
    expect.soft(fs.existsSync(ready), 'production must not acknowledge the fault hook').toBe(false);
    expect.soft(result.payload).toEqual({ ok: true, state: 'applied' });
    expect.soft(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(FAKE_SECRET);
  }, 30_000);
});
