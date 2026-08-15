import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'test/fixtures/bootstrap-profile-lock-worker.cjs');
const require = createRequire(import.meta.url);
const locks = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

type LockMode = 'shared' | 'reserved' | 'exclusive';
type WorkerMessage = {
  event: string;
  code?: string | null;
  name?: string;
};

type Fixture = {
  root: string;
  configRoot: string;
  configPath: string;
};

type WorkerSpec = {
  lock: {
    rcRoot: string;
    configPath: string;
    operation: 'shared' | 'exclusive';
    runtime?: LockMode | null;
    initialize?: boolean;
  };
  gated?: boolean;
  hold?: boolean;
  releaseOperation?: boolean;
  watchdogMs?: number;
  delayFirstInitializationExclusiveMs?: number;
  pauseBeforeInitializationPublish?: boolean;
  pauseAfterRootAuthorityPublish?: boolean;
  pauseAfterLocksPublish?: boolean;
  initializeAuthority?: boolean;
};

type WorkerHarness = {
  child: ChildProcessWithoutNullStreams;
  next: (timeoutMs?: number) => Promise<WorkerMessage>;
  send: (command: string) => void;
  exit: (timeoutMs?: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop: () => Promise<void>;
};

const fixtures: string[] = [];
const workers = new Set<WorkerHarness>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-lock-contract-'));
  fixtures.push(root);
  const configRoot = path.join(root, 'config');
  fs.mkdirSync(configRoot, { mode: 0o700 });
  const configPath = path.join(configRoot, 'openclaw.json');
  fs.writeFileSync(configPath, '{}\n', { mode: 0o600 });
  return { root, configRoot, configPath };
}

function lockSpec(
  item: Fixture,
  operation: 'shared' | 'exclusive',
  runtime: LockMode | null = null,
  initialize = false,
) {
  return { rcRoot: ROOT, configPath: item.configPath, operation, runtime, initialize };
}

function spawnWorker(spec: WorkerSpec): WorkerHarness {
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
  const child = spawn(process.execPath, [WORKER, encoded], {
    cwd: ROOT,
    env: {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // A child can close stdin between the exit-status check and cleanup's
  // release write. Treat that normal teardown race as already released.
  child.stdin.on('error', () => {});

  const messages: WorkerMessage[] = [];
  const waiters: Array<{
    resolve: (message: WorkerMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  let stdout = '';
  let stderr = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exitWaiters: Array<(value: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];

  const deliver = (message: WorkerMessage) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else messages.push(message);
  };

  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try {
        deliver(JSON.parse(line));
      } catch {
        const error = new Error(`lock worker emitted invalid JSON: ${line}`);
        const waiter = waiters.shift();
        if (waiter) waiter.reject(error);
      }
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.once('exit', (code, signal) => {
    exited = { code, signal };
    for (const resolve of exitWaiters.splice(0)) resolve(exited);
    if (waiters.length) {
      const error = new Error(
        `lock worker exited before its next event (code=${code}, signal=${signal}, stderr=${stderr})`,
      );
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    }
  });

  let harness: WorkerHarness;
  const waitForExit = (timeoutMs = 10_000) => withTimeout(
    exited ? Promise.resolve(exited) : new Promise((resolve) => exitWaiters.push(resolve)),
    timeoutMs,
    'lock worker exit',
  );
  harness = {
    child,
    next(timeoutMs = 10_000) {
      const pending = messages.length
        ? Promise.resolve(messages.shift()!)
        : exited
          ? Promise.reject(new Error(
            `lock worker already exited (code=${exited.code}, signal=${exited.signal}, stderr=${stderr})`,
          ))
          : new Promise<WorkerMessage>((resolve, reject) => waiters.push({ resolve, reject }));
      return withTimeout(pending, timeoutMs, 'lock worker event');
    },
    send(command) {
      if (child.exitCode === null && child.signalCode === null) child.stdin.write(`${command}\n`);
    },
    exit: waitForExit,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.stdin.write('release\n'); } catch {}
        try {
          await waitForExit(750);
        } catch {
          child.kill('SIGTERM');
          try {
            await waitForExit(750);
          } catch {
            child.kill('SIGKILL');
            await waitForExit(5_000);
          }
        }
      }
      workers.delete(harness);
    },
  };
  workers.add(harness);
  return harness;
}

async function expectReady(worker: WorkerHarness) {
  expect(await worker.next()).toMatchObject({ event: 'ready' });
}

async function expectReleased(worker: WorkerHarness) {
  expect(await worker.next()).toMatchObject({ event: 'released' });
  expect(await worker.exit()).toMatchObject({ code: 0, signal: null });
  workers.delete(worker);
}

async function initialize(item: Fixture) {
  const worker = spawnWorker({
    lock: lockSpec(item, 'exclusive', 'exclusive', false),
    initializeAuthority: true,
    hold: false,
  });
  await expectReady(worker);
  await expectReleased(worker);
}

afterEach(async () => {
  await Promise.all([...workers].map((worker) => worker.stop()));
  expect(workers.size).toBe(0);
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.sequential('bootstrap SQLite lock cross-process contract', () => {
  const operationCases: Array<{
    holder: 'shared' | 'exclusive';
    contender: 'shared' | 'exclusive';
    compatible: boolean;
  }> = [
    { holder: 'shared', contender: 'shared', compatible: true },
    { holder: 'shared', contender: 'exclusive', compatible: false },
    { holder: 'exclusive', contender: 'shared', compatible: false },
    { holder: 'exclusive', contender: 'exclusive', compatible: false },
  ];

  it.each(operationCases)(
    'operation $holder + $contender compatibility is $compatible',
    async ({ holder, contender, compatible }) => {
      const item = fixture();
      await initialize(item);
      const owner = spawnWorker({ lock: lockSpec(item, holder), hold: true });
      await expectReady(owner);
      const attempt = spawnWorker({ lock: lockSpec(item, contender), hold: false });
      const result = await attempt.next();
      if (compatible) {
        expect(result).toMatchObject({ event: 'ready' });
        await expectReleased(attempt);
      } else {
        expect(result).toMatchObject({ event: 'error', code: 'OPERATION_LOCK_BUSY' });
        expect(await attempt.exit()).toMatchObject({ code: 2, signal: null });
        workers.delete(attempt);
      }
      owner.send('release');
      await expectReleased(owner);
    },
  );

  const runtimeCases: Array<{
    holder: LockMode;
    contender: LockMode;
    compatible: boolean;
  }> = [
    { holder: 'shared', contender: 'shared', compatible: true },
    { holder: 'shared', contender: 'reserved', compatible: true },
    { holder: 'shared', contender: 'exclusive', compatible: false },
    { holder: 'reserved', contender: 'shared', compatible: true },
    { holder: 'reserved', contender: 'reserved', compatible: false },
    { holder: 'reserved', contender: 'exclusive', compatible: false },
    { holder: 'exclusive', contender: 'shared', compatible: false },
    { holder: 'exclusive', contender: 'reserved', compatible: false },
    { holder: 'exclusive', contender: 'exclusive', compatible: false },
  ];

  it.each(runtimeCases)(
    'runtime $holder + $contender compatibility is $compatible',
    async ({ holder, contender, compatible }) => {
      const item = fixture();
      await initialize(item);
      const owner = spawnWorker({
        lock: lockSpec(item, 'exclusive', holder), hold: true, releaseOperation: true,
      });
      await expectReady(owner);
      const attempt = spawnWorker({
        lock: lockSpec(item, 'exclusive', contender), hold: false, releaseOperation: true,
      });
      const result = await attempt.next();
      if (compatible) {
        expect(result).toMatchObject({ event: 'ready' });
        await expectReleased(attempt);
      } else {
        expect(result).toMatchObject({ event: 'error', code: 'RUNTIME_LOCK_BUSY' });
        expect(await attempt.exit()).toMatchObject({ code: 2, signal: null });
        workers.delete(attempt);
      }
      owner.send('release');
      await expectReleased(owner);
    },
  );

  it('publishes one complete authority across a concurrent first-initialization race', async () => {
    const item = fixture();
    const initializer = spawnWorker({
      lock: lockSpec(item, 'shared', null, false),
      initializeAuthority: true,
      hold: false,
      delayFirstInitializationExclusiveMs: 750,
    });
    expect(await initializer.next()).toMatchObject({ event: 'initialization-exclusive-held' });

    const racer = spawnWorker({
      lock: lockSpec(item, 'shared', null, false), initializeAuthority: true, hold: false,
    });
    const racerFirst = await racer.next();
    const initializerNext = await initializer.next();
    const readyWorkers = [] as WorkerHarness[];
    const errorWorkers = [] as WorkerHarness[];
    for (const [worker, message] of [[racer, racerFirst], [initializer, initializerNext]] as const) {
      if (message.event === 'ready') readyWorkers.push(worker);
      else {
        expect(message).toMatchObject({ event: 'error' });
        errorWorkers.push(worker);
      }
    }
    expect(readyWorkers).toHaveLength(1);
    expect(errorWorkers).toHaveLength(1);
    await expectReleased(readyWorkers[0]);
    expect(await errorWorkers[0].exit()).toMatchObject({ code: 2, signal: null });
    workers.delete(errorWorkers[0]);

    expect(fs.readdirSync(path.join(item.configRoot, '.rc-bootstrap')).sort()).toEqual(['locks']);

    const retry = spawnWorker({ lock: lockSpec(item, 'shared'), hold: false });
    await expectReady(retry);
    await expectReleased(retry);
  });

  it('never publishes partial authority when the initializer is SIGKILLed before the atomic rename', async () => {
    const item = fixture();
    const initializer = spawnWorker({
      lock: lockSpec(item, 'shared', null, false),
      initializeAuthority: true,
      hold: false,
      pauseBeforeInitializationPublish: true,
    });
    expect(await initializer.next()).toMatchObject({ event: 'initialization-ready-to-publish' });
    expect(initializer.child.kill('SIGKILL')).toBe(true);
    expect(await initializer.exit()).toMatchObject({ code: null, signal: 'SIGKILL' });
    workers.delete(initializer);

    const lockRoot = path.join(item.configRoot, '.rc-bootstrap', 'locks');
    expect(fs.existsSync(lockRoot)).toBe(false);
    expect(() => locks.acquireBootstrapLocks(lockSpec(item, 'shared', null, false)))
      .toThrowError(expect.objectContaining({ code: 'LOCK_AUTHORITY_LOST' }));

    await initialize(item);
    const successor = spawnWorker({ lock: lockSpec(item, 'shared'), hold: false });
    await expectReady(successor);
    await expectReleased(successor);
  });

  it('recovers only the exact staged authority after SIGKILL at the durable preparing marker', async () => {
    const item = fixture();
    const initializer = spawnWorker({
      lock: lockSpec(item, 'shared', null, false),
      initializeAuthority: true,
      hold: false,
      pauseAfterRootAuthorityPublish: true,
    });
    expect(await initializer.next()).toMatchObject({ event: 'root-authority-published' });
    expect(initializer.child.kill('SIGKILL')).toBe(true);
    expect(await initializer.exit()).toMatchObject({ code: null, signal: 'SIGKILL' });
    workers.delete(initializer);

    const authorityDirectory = path.join(item.configRoot, '.rc-bootstrap-lock-authority');
    const preparing = JSON.parse(fs.readFileSync(path.join(authorityDirectory, 'authority.json'), 'utf8'));
    expect(preparing).toMatchObject({ state: 'preparing', configBasename: 'openclaw.json' });
    expect(fs.existsSync(path.join(item.configRoot, '.rc-bootstrap', preparing.stagingName))).toBe(true);
    expect(fs.existsSync(path.join(item.configRoot, '.rc-bootstrap', 'locks'))).toBe(false);

    expect(() => locks.ensureInitialized({ rcRoot: ROOT, configPath: item.configPath }))
      .toThrowError(expect.objectContaining({ code: 'EXTERNAL_STOP_PROOF_REQUIRED' }));
    await initialize(item);
    const committed = JSON.parse(fs.readFileSync(path.join(authorityDirectory, 'authority.json'), 'utf8'));
    expect(committed).toMatchObject({ state: 'committed', stagingName: null, rootUuid: preparing.rootUuid });
    const reader = spawnWorker({ lock: lockSpec(item, 'shared', 'shared'), hold: false });
    await expectReady(reader);
    await expectReleased(reader);
  });

  it('commits the same authority after SIGKILL between locks publish and completion marker', async () => {
    const item = fixture();
    const initializer = spawnWorker({
      lock: lockSpec(item, 'shared', null, false),
      initializeAuthority: true,
      hold: false,
      pauseAfterLocksPublish: true,
    });
    expect(await initializer.next()).toMatchObject({ event: 'locks-published' });
    expect(initializer.child.kill('SIGKILL')).toBe(true);
    expect(await initializer.exit()).toMatchObject({ code: null, signal: 'SIGKILL' });
    workers.delete(initializer);

    const authorityFile = path.join(
      item.configRoot, '.rc-bootstrap-lock-authority', 'authority.json',
    );
    const preparing = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
    expect(preparing.state).toBe('preparing');
    expect(fs.existsSync(path.join(item.configRoot, '.rc-bootstrap', 'locks'))).toBe(true);
    expect(fs.existsSync(path.join(
      item.configRoot, '.rc-bootstrap', preparing.stagingName,
    ))).toBe(false);

    await initialize(item);
    const committed = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
    expect(committed).toMatchObject({
      state: 'committed', stagingName: null, rootUuid: preparing.rootUuid,
    });
  });

  it('lets the kernel release operation and runtime authority after SIGKILL', async () => {
    const item = fixture();
    await initialize(item);
    const killed = spawnWorker({ lock: lockSpec(item, 'exclusive', 'exclusive'), hold: true });
    await expectReady(killed);
    expect(killed.child.kill('SIGKILL')).toBe(true);
    expect(await killed.exit()).toMatchObject({ code: null, signal: 'SIGKILL' });
    workers.delete(killed);

    const successor = spawnWorker({ lock: lockSpec(item, 'exclusive', 'exclusive'), hold: false });
    await expectReady(successor);
    await expectReleased(successor);
  });

  it('keeps established shared acquisitions byte- and metadata-read-only without sidecars', async () => {
    const item = fixture();
    await initialize(item);
    const lockRoot = path.join(item.configRoot, '.rc-bootstrap', 'locks');
    const files = ['operation.sqlite', 'runtime.sqlite'].map((name) => path.join(lockRoot, name));
    const before = files.map((file) => ({
      bytes: fs.readFileSync(file),
      mtimeNs: fs.statSync(file, { bigint: true }).mtimeNs,
    }));

    const reader = spawnWorker({ lock: lockSpec(item, 'shared', 'shared'), hold: false });
    await expectReady(reader);
    await expectReleased(reader);

    files.forEach((file, index) => {
      expect(fs.readFileSync(file)).toEqual(before[index].bytes);
      expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(before[index].mtimeNs);
      for (const suffix of ['-journal', '-wal', '-shm']) expect(fs.existsSync(`${file}${suffix}`)).toBe(false);
    });
  });

  it('creates a private permanent authority', async () => {
    const item = fixture();
    await initialize(item);
    const bootstrapRoot = path.join(item.configRoot, '.rc-bootstrap');
    const lockRoot = path.join(bootstrapRoot, 'locks');
    const files = [
      path.join(lockRoot, 'identity.json'),
      path.join(lockRoot, 'authority.json'),
      path.join(lockRoot, 'operation.sqlite'),
      path.join(lockRoot, 'runtime.sqlite'),
      path.join(item.configRoot, '.rc-bootstrap-lock-authority', 'authority.json'),
    ];
    if (process.platform !== 'win32') {
      expect(fs.statSync(bootstrapRoot).mode & 0o777).toBe(0o700);
      expect(fs.statSync(lockRoot).mode & 0o777).toBe(0o700);
      for (const file of files) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    for (const file of files) {
      const metadata = fs.lstatSync(file);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.nlink).toBe(1);
    }
  });

  it('accepts an existing owner-controlled 0755 config root while keeping lock authority private', async () => {
    const item = fixture();
    if (process.platform !== 'win32') fs.chmodSync(item.configRoot, 0o755);
    await initialize(item);
    const lockRoot = path.join(item.configRoot, '.rc-bootstrap', 'locks');
    if (process.platform !== 'win32') {
      expect(fs.statSync(item.configRoot).mode & 0o777).toBe(0o755);
      expect(fs.statSync(path.dirname(lockRoot)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(lockRoot).mode & 0o777).toBe(0o700);
    }
    const reader = spawnWorker({ lock: lockSpec(item, 'shared', 'shared'), hold: false });
    await expectReady(reader);
    await expectReleased(reader);
  });

  it('rejects group- or world-writable config roots', () => {
    if (process.platform === 'win32') return;
    for (const mode of [0o775, 0o777]) {
      const item = fixture();
      fs.chmodSync(item.configRoot, mode);
      expect(() => locks.ensureInitialized({
        rcRoot: ROOT, configPath: item.configPath, externalStopVerified: true,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_LOCK_ROOT' }));
    }
  });
});

describe.sequential('bootstrap SQLite lock fail-closed identity contract', () => {
  it('rejects a corrupt database schema instead of repairing it', async () => {
    const item = fixture();
    await initialize(item);
    const modulePath = require.resolve('better-sqlite3', {
      paths: [path.join(ROOT, 'extensions/research-claw-core'), ROOT],
    });
    const Database = require(modulePath);
    const operation = path.join(item.configRoot, '.rc-bootstrap', 'locks', 'operation.sqlite');
    const database = new Database(operation);
    database.exec('CREATE TABLE injected_schema(value TEXT)');
    database.close();

    expect(() => locks.acquireBootstrapLocks(lockSpec(item, 'shared', null, false)))
      .toThrowError(expect.objectContaining({ code: 'INVALID_LOCK_DATABASE' }));
  });

  it('rejects an unknown runtime schema and releases both acquired transactions', async () => {
    const item = fixture();
    await initialize(item);
    const modulePath = require.resolve('better-sqlite3', {
      paths: [path.join(ROOT, 'extensions/research-claw-core'), ROOT],
    });
    const Database = require(modulePath);
    const runtime = path.join(item.configRoot, '.rc-bootstrap', 'locks', 'runtime.sqlite');
    const corruptor = new Database(runtime);
    corruptor.exec('ALTER TABLE rc_lock_identity ADD COLUMN extra TEXT');
    corruptor.close();

    expect(() => locks.acquireBootstrapLocks(lockSpec(item, 'exclusive', 'shared', false)))
      .toThrowError(expect.objectContaining({ code: 'INVALID_LOCK_DATABASE' }));

    const authorityProbe = new Database(runtime, { fileMustExist: true });
    expect(() => authorityProbe.exec('BEGIN EXCLUSIVE')).not.toThrow();
    expect(authorityProbe.inTransaction).toBe(true);
    authorityProbe.exec('ROLLBACK');
    authorityProbe.close();
  });

  it('never recreates a missing runtime authority while an old-inode gateway remains live', async () => {
    if (process.platform === 'win32') return;
    const item = fixture();
    await initialize(item);
    const runtime = path.join(item.configRoot, '.rc-bootstrap', 'locks', 'runtime.sqlite');
    const gateway = spawnWorker({
      lock: lockSpec(item, 'exclusive', 'reserved'), hold: true, releaseOperation: true,
    });
    await expectReady(gateway);
    const oldInode = fs.statSync(runtime).ino;
    fs.unlinkSync(runtime);

    expect(() => locks.acquireBootstrapLocks(lockSpec(item, 'exclusive', 'exclusive', false)))
      .toThrowError(expect.objectContaining({ code: 'LOCK_AUTHORITY_LOST' }));
    expect(() => locks.ensureInitialized({
      rcRoot: ROOT, configPath: item.configPath, externalStopVerified: true,
    }))
      .toThrowError(expect.objectContaining({ code: 'LOCK_AUTHORITY_LOST' }));
    expect(fs.existsSync(runtime)).toBe(false);
    expect(gateway.child.exitCode).toBeNull();
    expect(oldInode).toBeGreaterThan(0);

    gateway.send('release');
    await expectReleased(gateway);
  });

  it('never creates a second authority when the entire published locks directory is moved', async () => {
    const item = fixture();
    await initialize(item);
    const bootstrapRoot = path.join(item.configRoot, '.rc-bootstrap');
    const locksRoot = path.join(bootstrapRoot, 'locks');
    const detached = path.join(bootstrapRoot, 'locks.detached');
    const gateway = spawnWorker({
      lock: lockSpec(item, 'exclusive', 'reserved'), hold: true, releaseOperation: true,
    });
    await expectReady(gateway);
    fs.renameSync(locksRoot, detached);

    expect(() => locks.ensureInitialized({
      rcRoot: ROOT, configPath: item.configPath, externalStopVerified: true,
    })).toThrowError(expect.objectContaining({ code: 'LOCK_AUTHORITY_LOST' }));
    expect(fs.existsSync(locksRoot)).toBe(false);
    expect(fs.existsSync(detached)).toBe(true);
    expect(gateway.child.exitCode).toBeNull();

    gateway.send('release');
    await expectReleased(gateway);
  });

  it('requires explicit external stop proof for first publication', () => {
    const item = fixture();
    expect(() => locks.ensureInitialized({ rcRoot: ROOT, configPath: item.configPath }))
      .toThrowError(expect.objectContaining({ code: 'EXTERNAL_STOP_PROOF_REQUIRED' }));
    expect(fs.existsSync(path.join(item.configRoot, '.rc-bootstrap-lock-authority'))).toBe(false);
    expect(fs.existsSync(path.join(item.configRoot, '.rc-bootstrap', 'locks'))).toBe(false);
  });

  it('never repairs a published authority with missing files or corrupt operation schema', async () => {
    const item = fixture();
    await initialize(item);
    const lockRoot = path.join(item.configRoot, '.rc-bootstrap', 'locks');
    const operation = path.join(lockRoot, 'operation.sqlite');
    const runtime = path.join(lockRoot, 'runtime.sqlite');
    const modulePath = require.resolve('better-sqlite3', {
      paths: [path.join(ROOT, 'extensions/research-claw-core'), ROOT],
    });
    const Database = require(modulePath);
    fs.unlinkSync(runtime);
    const corruptor = new Database(operation);
    corruptor.exec('DROP TABLE rc_lock_identity');
    corruptor.close();
    const operationBytes = fs.readFileSync(operation);

    expect(() => locks.ensureInitialized({
      rcRoot: ROOT, configPath: item.configPath, externalStopVerified: true,
    }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_LOCK_DATABASE' }));
    expect(fs.existsSync(runtime)).toBe(false);
    expect(fs.readFileSync(operation)).toEqual(operationBytes);
    expect(fs.existsSync(path.join(lockRoot, 'authority.json'))).toBe(true);
  });

  it('treats a missing completion marker as lost authority without repairing databases', async () => {
    const item = fixture();
    await initialize(item);
    const lockRoot = path.join(item.configRoot, '.rc-bootstrap', 'locks');
    const authority = path.join(lockRoot, 'authority.json');
    const operation = path.join(lockRoot, 'operation.sqlite');
    const runtime = path.join(lockRoot, 'runtime.sqlite');
    const before = [fs.readFileSync(operation), fs.readFileSync(runtime)];
    fs.unlinkSync(authority);

    expect(() => locks.ensureInitialized({
      rcRoot: ROOT, configPath: item.configPath, externalStopVerified: true,
    }))
      .toThrowError(expect.objectContaining({ code: 'LOCK_AUTHORITY_LOST' }));
    expect(fs.existsSync(authority)).toBe(false);
    expect(fs.readFileSync(operation)).toEqual(before[0]);
    expect(fs.readFileSync(runtime)).toEqual(before[1]);
  });

  it('rejects corrupt and substituted persistent identities', async () => {
    const malformed = fixture();
    await initialize(malformed);
    const malformedIdentity = path.join(
      malformed.configRoot, '.rc-bootstrap', 'locks', 'identity.json',
    );
    fs.writeFileSync(malformedIdentity, '{not-json}\n');
    expect(() => locks.acquireBootstrapLocks(lockSpec(malformed, 'shared', null, false)))
      .toThrowError(expect.objectContaining({ code: 'LOCK_IDENTITY_MISMATCH' }));

    const substituted = fixture();
    await initialize(substituted);
    const identityPath = path.join(substituted.configRoot, '.rc-bootstrap', 'locks', 'identity.json');
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    fs.writeFileSync(identityPath, `${JSON.stringify({ ...identity, rootUuid: crypto.randomUUID() })}\n`);
    expect(() => locks.acquireBootstrapLocks(lockSpec(substituted, 'shared', null, false)))
      .toThrowError(expect.objectContaining({ code: 'INVALID_LOCK_AUTHORITY' }));
  });

  it('binds an authority to the exact config basename, rejecting a sibling config', async () => {
    const item = fixture();
    await initialize(item);
    const sibling = path.join(item.configRoot, 'sibling.json');
    fs.writeFileSync(sibling, '{}\n', { mode: 0o600 });
    expect(() => locks.acquireBootstrapLocks({
      ...lockSpec(item, 'shared', null, false), configPath: sibling,
    })).toThrowError(expect.objectContaining({ code: 'LOCK_IDENTITY_MISMATCH' }));
  });

  it('rejects a symlink config before consulting or creating authority', () => {
    const item = fixture();
    const linked = path.join(item.configRoot, 'linked.json');
    try {
      fs.symlinkSync(item.configPath, linked, 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    expect(() => locks.acquireBootstrapLocks({
      ...lockSpec(item, 'shared'), configPath: linked,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG_IDENTITY' }));
    expect(fs.existsSync(path.join(item.configRoot, '.rc-bootstrap'))).toBe(false);
  });

  it('rejects hardlink config aliases and the now multiply-linked original', () => {
    const item = fixture();
    const linked = path.join(item.configRoot, 'hardlinked.json');
    fs.linkSync(item.configPath, linked);
    for (const configPath of [item.configPath, linked]) {
      expect(() => locks.acquireBootstrapLocks({
        ...lockSpec(item, 'shared'), configPath,
      })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG_IDENTITY' }));
    }
    expect(fs.existsSync(path.join(item.configRoot, '.rc-bootstrap'))).toBe(false);
  });

  it('reports lost authority with initialize=false and leaves the config root untouched', () => {
    const item = fixture();
    expect(() => locks.acquireBootstrapLocks(lockSpec(item, 'shared', null, false)))
      .toThrowError(expect.objectContaining({ code: 'LOCK_AUTHORITY_LOST' }));
    expect(fs.readdirSync(item.configRoot).sort()).toEqual(['openclaw.json']);
  });
});
