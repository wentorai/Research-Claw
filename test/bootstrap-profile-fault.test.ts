import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts/apply-bootstrap-profile.cjs');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const require = createRequire(import.meta.url);
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness(initializeAuthority = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-fault-'));
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
  fs.mkdirSync(path.dirname(path.join(stateDir, 'agents/main/agent/auth-profiles.json')), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'agents/main/agent/auth-profiles.json'),
    JSON.stringify({ version: 1, profiles: {} }), { mode: 0o600 });
  fs.writeFileSync(paths.globalConfigPath, '{}\n', { mode: 0o600 });
  if (initializeAuthority) ensureInitialized({ ...paths, externalStopVerified: true });
  return { root, paths };
}

function args(command: string, h: ReturnType<typeof harness>, txId?: string): string[] {
  return [
    ENTRY, command,
    '--rc-root', ROOT,
    '--config', h.paths.configPath,
    '--workspace', h.paths.workspace,
    '--state-dir', h.paths.stateDir,
    '--db', h.paths.dbPath,
    '--global-config', h.paths.globalConfigPath,
    ...(txId ? ['--tx-id', txId] : []),
  ];
}

function run(command: string, h: ReturnType<typeof harness>, txId?: string, extraEnv = {}) {
  return spawnSync(process.execPath, args(command, h, txId), {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...extraEnv },
    input: command === 'stage' ? fs.readFileSync(FIXTURE) : undefined,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function parse(result: ReturnType<typeof run>) {
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function pathDigest(target: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (current: string, relative: string) => {
    if (!fs.existsSync(current)) {
      hash.update(`${relative}:absent;`);
      return;
    }
    const stat = fs.lstatSync(current);
    hash.update(`${relative}:${stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'}:${stat.mode & 0o777};`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), path.join(relative, name));
    } else if (stat.isFile()) {
      hash.update(fs.readFileSync(current));
    } else if (stat.isSymbolicLink()) {
      hash.update(fs.readlinkSync(current));
    }
  };
  visit(target, '.');
  return hash.digest('hex');
}

function managedAssetsDigest(h: ReturnType<typeof harness>): string {
  const configRoot = path.join(path.dirname(h.paths.configPath), '.rc-bootstrap');
  const assets = [
    h.paths.configPath,
    path.join(configRoot, 'receipt.json'),
    path.join(configRoot, 'peripheral-suspensions.json'),
    path.join(h.paths.workspace, 'skills'),
    path.join(h.paths.stateDir, 'agents/main/agent/auth-profiles.json'),
    h.paths.globalConfigPath,
    path.join(h.paths.stateDir, 'state/openclaw.sqlite'),
    path.join(h.paths.stateDir, 'state/openclaw.sqlite-wal'),
    path.join(h.paths.stateDir, 'state/openclaw.sqlite-shm'),
    h.paths.dbPath,
    `${h.paths.dbPath}-wal`,
    `${h.paths.dbPath}-shm`,
  ];
  return crypto.createHash('sha256')
    .update(JSON.stringify(assets.map((asset) => [path.basename(asset), pathDigest(asset)])))
    .digest('hex');
}

function managedAssetDigests(h: ReturnType<typeof harness>): Record<string, string> {
  const configRoot = path.join(path.dirname(h.paths.configPath), '.rc-bootstrap');
  return Object.fromEntries([
    h.paths.configPath,
    path.join(configRoot, 'receipt.json'),
    path.join(configRoot, 'peripheral-suspensions.json'),
    path.join(h.paths.workspace, 'skills'),
    path.join(h.paths.stateDir, 'agents/main/agent/auth-profiles.json'),
    h.paths.globalConfigPath,
    path.join(h.paths.stateDir, 'state/openclaw.sqlite'),
    path.join(h.paths.stateDir, 'state/openclaw.sqlite-wal'),
    path.join(h.paths.stateDir, 'state/openclaw.sqlite-shm'),
    h.paths.dbPath,
    `${h.paths.dbPath}-wal`,
    `${h.paths.dbPath}-shm`,
  ].map((asset, index) => [`${index}:${path.basename(asset)}`, pathDigest(asset)]));
}

function recoveryRoots(h: ReturnType<typeof harness>, txId: string): string[] {
  return [
    path.join(path.dirname(h.paths.configPath), '.rc-bootstrap', 'transactions', txId),
    path.join(h.paths.workspace, '.rc-bootstrap-transactions', txId),
    path.join(h.paths.stateDir, '.rc-bootstrap-transactions', txId),
    path.join(path.dirname(h.paths.dbPath), '.rc-bootstrap-transactions', txId),
  ];
}

describe('applier process, secret, and crash contract', () => {
  it('initializes lock authority explicitly and idempotently before any profile command', () => {
    const h = harness(false);
    const first = parse(run('initialize-locks', h));
    const second = parse(run('initialize-locks', h));
    expect(first).toEqual({ state: 'initialized', created: true });
    expect(second).toEqual({ state: 'initialized', created: false });
  });

  it('CLI requires every explicit path, reads Capsule from stdin, and emits only non-secret JSON', () => {
    const h = harness();
    const missing = spawnSync(process.execPath, [ENTRY, 'stage'], {
      cwd: ROOT, input: fs.readFileSync(FIXTURE), encoding: 'utf8',
    });
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).not.toContain('RC_TEST_ONLY_FAKE_MODEL_KEY');

    const staged = run('stage', h);
    const output = parse(staged);
    expect(output).toMatchObject({ state: 'staged', profileId: 'thermoelectric-user-a' });
    expect(`${staged.stdout}${staged.stderr}`).not.toContain('RC_TEST_ONLY_FAKE_MODEL_KEY');
    expect(`${staged.stdout}${staged.stderr}`).not.toContain(FIXTURE);
  });

  it('bounds Capsule stdin and files before parsing and rejects non-regular local sources', () => {
    const h = harness();
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x78);
    const stdin = spawnSync(process.execPath, args('stage', h), {
      cwd: ROOT, input: oversized, encoding: 'utf8', timeout: 30_000,
    });
    expect(stdin.status).not.toBe(0);
    expect(`${stdin.stdout}${stdin.stderr}`).not.toContain(oversized.subarray(0, 32).toString());

    const file = path.join(h.root, 'capsule-too-large.json');
    fs.writeFileSync(file, oversized, { mode: 0o600 });
    const fileResult = spawnSync(process.execPath, [...args('stage', h), '--capsule-file', file], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
    expect(fileResult.status).not.toBe(0);
    const symlink = path.join(h.root, 'capsule-link.json');
    fs.symlinkSync(FIXTURE, symlink);
    const symlinkResult = spawnSync(process.execPath, [...args('stage', h), '--capsule-file', symlink], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
    expect(symlinkResult.status).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'kills the active cron worker on its deadline or parent signal and removes every private clone',
    async () => {
      const h = harness();
      const staged = await applier.stageProfile({
        ...h.paths,
        capsuleBytes: fs.readFileSync(FIXTURE),
        rcVersion: '0.8.3',
      });
      const stateRoot = path.join(h.paths.stateDir, 'state');
      const liveBefore = Object.fromEntries(['', '-wal', '-shm'].map((suffix) => [
        suffix,
        pathDigest(path.join(stateRoot, `openclaw.sqlite${suffix}`)),
      ]));
      const hangingWorker = path.join(ROOT, 'test/fixtures/bootstrap-profile-hanging-worker.mjs');
      await expect(applier.__testing.inspectCronState(h.paths, staged.txId, {
        workerFile: hangingWorker,
        timeoutMs: 50,
      })).rejects.toMatchObject({ code: 'CRON_WORKER_FAILED' });
      expect(applier.__testing.activeCronWorkerPids()).toEqual([]);
      expect(fs.existsSync(path.join(
        path.dirname(h.paths.configPath), '.rc-bootstrap', 'transactions', staged.txId, 'cron-clone',
      ))).toBe(false);
      expect(Object.fromEntries(['', '-wal', '-shm'].map((suffix) => [
        suffix,
        pathDigest(path.join(stateRoot, `openclaw.sqlite${suffix}`)),
      ]))).toEqual(liveBefore);

      const runner = path.join(ROOT, 'test/fixtures/bootstrap-profile-worker-runner.cjs');
      const child = spawn(process.execPath, [
        runner,
        path.join(ROOT, 'scripts/bootstrap-profile/applier.cjs'),
        JSON.stringify(h.paths),
        staged.txId,
        hangingWorker,
      ], {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const cloneRoot = path.join(
        path.dirname(h.paths.configPath), '.rc-bootstrap', 'transactions', staged.txId, 'cron-clone',
      );
      const ready = path.join(cloneRoot, '.worker-ready');
      const started = Date.now();
      while (!fs.existsSync(ready) && Date.now() - started < 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(ready)).toBe(true);
      const workerPid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid as number;
      child.kill('SIGTERM');
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      expect(exit).toEqual({ code: 143, signal: null });
      const workerStoppedAt = Date.now() + 5_000;
      while (Date.now() < workerStoppedAt) {
        try {
          process.kill(workerPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          break;
        }
      }
      expect(() => process.kill(workerPid, 0)).toThrow();
      expect(fs.existsSync(cloneRoot)).toBe(false);
      expect(Object.fromEntries(['', '-wal', '-shm'].map((suffix) => [
        suffix,
        pathDigest(path.join(stateRoot, `openclaw.sqlite${suffix}`)),
      ]))).toEqual(liveBefore);
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'preserves a rebound clone path during identity-scoped parent signal cleanup',
    async () => {
      const h = harness();
      const staged = await applier.stageProfile({
        ...h.paths,
        capsuleBytes: fs.readFileSync(FIXTURE),
        rcVersion: '0.8.3',
      });
      const runner = path.join(ROOT, 'test/fixtures/bootstrap-profile-worker-runner.cjs');
      const hangingWorker = path.join(ROOT, 'test/fixtures/bootstrap-profile-hanging-worker.mjs');
      const child = spawn(process.execPath, [
        runner,
        path.join(ROOT, 'scripts/bootstrap-profile/applier.cjs'),
        JSON.stringify(h.paths),
        staged.txId,
        hangingWorker,
      ], {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
      );
      const cloneRoot = path.join(
        path.dirname(h.paths.configPath), '.rc-bootstrap', 'transactions', staged.txId, 'cron-clone',
      );
      const heldRoot = `${cloneRoot}.held-${child.pid}`;
      const ready = path.join(cloneRoot, '.worker-ready');
      let workerPid: number | undefined;
      const boundedExit = async () => Promise.race([
        childExit,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('parent signal cleanup deadline')), 10_000);
          timer.unref();
        }),
      ]);
      try {
        const readyDeadline = Date.now() + 10_000;
        while (!fs.existsSync(ready) && Date.now() < readyDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(fs.existsSync(ready), stderr).toBe(true);
        workerPid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid as number;
        const originalIdentity = fs.lstatSync(cloneRoot);
        fs.renameSync(cloneRoot, heldRoot);
        fs.mkdirSync(cloneRoot, { mode: 0o700 });
        fs.chmodSync(cloneRoot, 0o700);
        const replacementSentinel = path.join(cloneRoot, 'replacement-sentinel');
        fs.writeFileSync(replacementSentinel, 'PRESERVE_SIGNAL_REPLACEMENT\n', {
          flag: 'wx', mode: 0o600,
        });
        const replacementIdentity = fs.lstatSync(cloneRoot);
        expect(originalIdentity.dev === replacementIdentity.dev
          && originalIdentity.ino === replacementIdentity.ino).toBe(false);
        child.kill('SIGTERM');
        expect(await boundedExit()).toEqual({ code: 143, signal: null });

        const workerDeadline = Date.now() + 5_000;
        while (Date.now() < workerDeadline) {
          try {
            process.kill(workerPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 20));
          } catch {
            break;
          }
        }
        expect(() => process.kill(workerPid!, 0)).toThrow();
        const heldIdentity = fs.lstatSync(heldRoot);
        expect({ dev: heldIdentity.dev, ino: heldIdentity.ino }).toEqual({
          dev: originalIdentity.dev, ino: originalIdentity.ino,
        });
        expect(fs.existsSync(replacementSentinel)).toBe(true);
        expect(fs.readFileSync(replacementSentinel, 'utf8'))
          .toBe('PRESERVE_SIGNAL_REPLACEMENT\n');
        await expect(applier.rollbackProfile({ ...h.paths, txId: staged.txId }))
          .rejects.toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
        expect(fs.readFileSync(replacementSentinel, 'utf8'))
          .toBe('PRESERVE_SIGNAL_REPLACEMENT\n');
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        try { await boundedExit(); } catch {}
        if (workerPid !== undefined) {
          try { process.kill(workerPid, 'SIGKILL'); } catch {}
        }
      }
    },
    30_000,
  );

  it('SIGKILL at each durable swap is recovered to the complete preimage', async () => {
    for (const fault of ['skills', 'auth', 'config', 'monitor', 'cron', 'suspensions', 'receipt']) {
      const h = harness();
      const original = managedAssetsDigest(h);
      const originalAssets = managedAssetDigests(h);
      const staged = parse(run('stage', h));
      const ready = path.join(h.root, `${fault}.ready`);
      const child = spawn(process.execPath, args('apply', h, staged.txId), {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'test',
          RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
          RC_BOOTSTRAP_FAULT_PAUSE_AFTER: fault,
          RC_BOOTSTRAP_FAULT_READY: ready,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const started = Date.now();
      while (!fs.existsSync(ready) && Date.now() - started < 15_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(ready), `fault ${fault} never reached`).toBe(true);
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
      for (const marker of recoveryRoots(h, staged.txId)) expect(fs.existsSync(marker)).toBe(true);

      const recoveredResult = run('recover', h);
      const recovered = parse(recoveredResult);
      expect(recovered.recovered).toContain(staged.txId);
      expect(managedAssetDigests(h), `fault ${fault}`).toEqual(originalAssets);
      expect(managedAssetsDigest(h), `fault ${fault}`).toBe(original);
      for (const marker of recoveryRoots(h, staged.txId)) expect(fs.existsSync(marker)).toBe(false);
      expect(`${recoveredResult.stdout}${recoveredResult.stderr}`).not.toContain('RC_TEST_ONLY_FAKE_MODEL_KEY');
    }
  }, 120_000);

  it.each(['workspace', 'state', 'data', 'config'] as const)(
    'SIGKILL in the middle of committed %s tombstone deletion only finishes cleanup',
    async (volume) => {
      const h = harness();
      const staged = parse(run('stage', h));
      parse(run('apply', h, staged.txId));
      parse(run('verify', h, staged.txId));
      const committedAssets = managedAssetDigests(h);
      const committed = managedAssetsDigest(h);
      const ready = path.join(h.root, `cleanup-${volume}.ready`);
      const child = spawn(process.execPath, args('commit', h, staged.txId), {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'test',
          RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
          RC_BOOTSTRAP_FAULT_PAUSE_AFTER: `cleanup-${volume}-entry`,
          RC_BOOTSTRAP_FAULT_READY: ready,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const started = Date.now();
      while (!fs.existsSync(ready) && Date.now() - started < 15_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(ready), `cleanup ${volume} never reached`).toBe(true);
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('close', () => resolve()));

      const intent = path.join(
        path.dirname(h.paths.configPath), '.rc-bootstrap', 'committed-cleanup',
        `${staged.txId}.json`,
      );
      expect(fs.existsSync(intent)).toBe(true);
      const recoveredResult = run('recover', h);
      expect(parse(recoveredResult).recovered).toContain(staged.txId);
      expect(managedAssetDigests(h)).toEqual(committedAssets);
      expect(managedAssetsDigest(h)).toBe(committed);
      expect(fs.existsSync(intent)).toBe(false);
      for (const marker of recoveryRoots(h, staged.txId)) expect(fs.existsSync(marker)).toBe(false);
      expect(`${recoveredResult.stdout}${recoveredResult.stderr}`)
        .not.toContain('RC_TEST_ONLY_FAKE_MODEL_KEY');
    },
    60_000,
  );

  it.each([
    {
      fault: 'cleanup-intent-prepared-temp',
      expectedManifestState: 'verified',
      expectedAuthority: 'prepared-temp',
      expectedOutcome: 'rolled-back',
    },
    {
      fault: 'cleanup-intent-committed',
      expectedManifestState: 'committed',
      expectedAuthority: 'prepared',
      expectedOutcome: 'committed',
    },
    {
      fault: 'cleanup-intent-published',
      expectedManifestState: 'committed',
      expectedAuthority: 'final',
      expectedOutcome: 'committed',
    },
  ] as const)(
    'SIGKILL at $expectedAuthority cleanup authority publication recovers $expectedOutcome state',
    async ({ fault, expectedManifestState, expectedAuthority, expectedOutcome }) => {
      const h = harness();
      const originalAssets = managedAssetDigests(h);
      const original = managedAssetsDigest(h);
      const staged = parse(run('stage', h));
      parse(run('apply', h, staged.txId));
      parse(run('verify', h, staged.txId));
      const committedAssets = managedAssetDigests(h);
      const committed = managedAssetsDigest(h);
      const ready = path.join(h.root, `${fault}.ready`);
      const child = spawn(process.execPath, args('commit', h, staged.txId), {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'test',
          RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
          RC_BOOTSTRAP_FAULT_PAUSE_AFTER: fault,
          RC_BOOTSTRAP_FAULT_READY: ready,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const started = Date.now();
      while (!fs.existsSync(ready) && Date.now() - started < 15_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(ready), `cleanup authority fault ${fault} never reached`).toBe(true);
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('close', () => resolve()));

      const configTransactionRoot = recoveryRoots(h, staged.txId)[0];
      const manifest = JSON.parse(fs.readFileSync(
        path.join(configTransactionRoot, 'manifest.json'), 'utf8',
      ));
      expect(manifest.state).toBe(expectedManifestState);
      const prepared = path.join(
        configTransactionRoot, `committed-cleanup-intent-${staged.txId}.json`,
      );
      const temporary = fs.readdirSync(configTransactionRoot).filter(
        (name) => name.startsWith(`.committed-cleanup-intent-${staged.txId}.json.`)
          && name.endsWith('.tmp'),
      );
      const final = path.join(
        path.dirname(h.paths.configPath), '.rc-bootstrap', 'committed-cleanup',
        `${staged.txId}.json`,
      );
      expect({
        prepared: fs.existsSync(prepared),
        temporary: temporary.length,
        final: fs.existsSync(final),
      }).toEqual(expectedAuthority === 'prepared-temp'
        ? { prepared: false, temporary: 1, final: false }
        : expectedAuthority === 'prepared'
          ? { prepared: true, temporary: 0, final: false }
          : { prepared: false, temporary: 0, final: true });
      if (temporary.length === 1) {
        const metadata = fs.statSync(path.join(configTransactionRoot, temporary[0]));
        expect(metadata.isFile()).toBe(true);
        expect(metadata.nlink).toBe(1);
        expect(metadata.mode & 0o777).toBe(0o600);
      }

      const recoveredResult = run('recover', h);
      expect(parse(recoveredResult).recovered).toContain(staged.txId);
      expect(managedAssetDigests(h)).toEqual(
        expectedOutcome === 'committed' ? committedAssets : originalAssets,
      );
      expect(managedAssetsDigest(h)).toBe(expectedOutcome === 'committed' ? committed : original);
      expect(fs.existsSync(final)).toBe(false);
      for (const marker of recoveryRoots(h, staged.txId)) expect(fs.existsSync(marker)).toBe(false);
    },
    60_000,
  );

  it('receipt, manifest, markers, stdout, and stderr never contain the model key', async () => {
    const h = harness();
    const staged = parse(run('stage', h));
    parse(run('apply', h, staged.txId));
    parse(run('verify', h, staged.txId));
    parse(run('commit', h, staged.txId));
    const root = path.join(path.dirname(h.paths.configPath), '.rc-bootstrap');
    const forbidden = 'RC_TEST_ONLY_FAKE_MODEL_KEY';
    const scan = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) scan(target);
        else if (entry.isFile() && !target.endsWith('auth-profiles.json')) {
          expect(fs.readFileSync(target).includes(forbidden), target).toBe(false);
        }
      }
    };
    scan(root);
    const auth = path.join(h.paths.stateDir, 'agents/main/agent/auth-profiles.json');
    expect(fs.readFileSync(auth, 'utf8').match(new RegExp(forbidden, 'g'))).toHaveLength(1);
  });

  it('unknown journal state fails closed and preserves recovery material', async () => {
    const h = harness();
    const staged = await applier.stageProfile({
      ...h.paths,
      capsuleBytes: fs.readFileSync(FIXTURE),
      rcVersion: '0.8.3',
    });
    const manifestPath = path.join(
      path.dirname(h.paths.configPath), '.rc-bootstrap', 'transactions', staged.txId, 'manifest.json',
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.state = 'mystery';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(applier.recoverProfiles({ ...h.paths }))
      .rejects.toMatchObject({ code: 'UNKNOWN_TRANSACTION_STATE' });
    expect(fs.existsSync(path.dirname(manifestPath))).toBe(true);
  });
});
