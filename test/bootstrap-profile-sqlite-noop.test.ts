import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const CRON_WORKER = path.join(ROOT, 'scripts/bootstrap-profile/cron-worker.mjs');
const require = createRequire(import.meta.url);
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(ROOT, 'extensions/research-claw-core'), ROOT],
}));
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

type Paths = {
  rcRoot: string;
  configPath: string;
  workspace: string;
  stateDir: string;
  dbPath: string;
  globalConfigPath: string;
};

type Harness = {
  root: string;
  paths: Paths;
  cronDbPath: string;
};

type Triplet = Record<'db' | 'wal' | 'shm', Buffer>;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function job(id: string, sessionKey: string) {
  return {
    id,
    sessionKey,
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

function runCronWorker(stateDir: string, action: string, payload: unknown): any {
  const home = path.join(path.dirname(stateDir), 'cron-worker-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const result = spawnSync(process.execPath, [
    CRON_WORKER,
    action,
    '--state-dir',
    stateDir,
    '--store-path',
    path.join(stateDir, 'cron/jobs.json'),
  ], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_PATH: process.env.NODE_PATH ?? path.join(ROOT, 'node_modules'),
      HOME: home,
      USERPROFILE: home,
      TMPDIR: path.join(home, 'tmp'),
      TMP: path.join(home, 'tmp'),
      TEMP: path.join(home, 'tmp'),
    },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}

function makeHarness({ device = false, jobSessionKey = true } = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-sqlite-noop-'));
  roots.push(root);
  const configRoot = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const dataRoot = path.join(root, 'data');
  for (const directory of [configRoot, workspace, stateDir, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const paths: Paths = {
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
  });
  writeJson(paths.globalConfigPath, {});
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), { version: 1, profiles: {} });

  const monitor = new Database(paths.dbPath);
  monitor.pragma('journal_mode = WAL');
  monitor.pragma('synchronous = FULL');
  monitor.exec(`
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
  const monitorId = device ? 'device-monitor' : 'feed-monitor';
  monitor.prepare(
    'INSERT INTO rc_monitors (id,name,source_type,target,enabled,gateway_job_id) VALUES (?,?,?,?,?,?)',
  ).run(
    monitorId,
    device ? 'Device' : 'Feed',
    device ? 'device' : 'feed',
    device ? 'camera-1' : 'https://example.invalid',
    1,
    device ? 'job-device' : 'job-feed',
  );
  monitor.pragma('wal_checkpoint(TRUNCATE)');
  monitor.close();

  const cronJob = device
    ? job('job-device', jobSessionKey ? 'cron:rc-monitor:device-monitor' : 'agent:main:cron:legacy')
    : job('job-feed', 'cron:rc-monitor:feed-monitor');
  runCronWorker(stateDir, 'seed', { version: 1, jobs: [cronJob] });
  const cronDbPath = path.join(stateDir, 'state/openclaw.sqlite');
  expect(fs.existsSync(cronDbPath)).toBe(true);
  ensureInitialized({ ...paths, externalStopVerified: true });
  return { root, paths, cronDbPath };
}

async function install(paths: Paths, capsuleBytes: Buffer): Promise<any> {
  const staged = await applier.stageProfile({
    ...paths,
    capsuleBytes,
    rcVersion: '0.8.3',
  });
  const applied = await applier.applyProfile({ ...paths, txId: staged.txId });
  await applier.verifyProfile({ ...paths, txId: staged.txId });
  await applier.commitProfile({ ...paths, txId: staged.txId });
  return applied;
}

function tripletPaths(databasePath: string): Record<keyof Triplet, string> {
  return {
    db: databasePath,
    wal: `${databasePath}-wal`,
    shm: `${databasePath}-shm`,
  };
}

function readTriplet(databasePath: string): Triplet {
  const files = tripletPaths(databasePath);
  for (const file of Object.values(files)) {
    expect(fs.existsSync(file), `missing persistent SQLite member ${file}`).toBe(true);
    expect(fs.statSync(file).size, `empty persistent SQLite member ${file}`).toBeGreaterThan(0);
  }
  return {
    db: fs.readFileSync(files.db),
    wal: fs.readFileSync(files.wal),
    shm: fs.readFileSync(files.shm),
  };
}

function compareTriplets(after: Triplet, before: Triplet): Record<keyof Triplet, boolean> {
  return {
    db: after.db.equals(before.db),
    wal: after.wal.equals(before.wal),
    shm: after.shm.equals(before.shm),
  };
}

function writeTriplet(databasePath: string, bytes: Triplet): void {
  const files = tripletPaths(databasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  for (const file of Object.values(files)) fs.rmSync(file, { force: true });
  for (const key of ['db', 'wal', 'shm'] as const) {
    fs.writeFileSync(files[key], bytes[key], { mode: 0o600 });
  }
}

function copyTriplet(source: string, target: string): void {
  const bytes = readTriplet(source);
  writeTriplet(target, bytes);
}

function assertReadableClone(databasePath: string, expectedTable: string, fixtureTag: string): void {
  const validationPath = path.join(
    path.dirname(databasePath),
    `validation-${path.basename(databasePath)}-${fixtureTag}.sqlite`,
  );
  copyTriplet(databasePath, validationPath);
  const validation = new Database(validationPath, { readonly: true, fileMustExist: true });
  try {
    expect(validation.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
    expect(validation.prepare(
      'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
    ).get('table', expectedTable)).toEqual({ name: expectedTable });
    expect(validation.prepare(
      'SELECT payload FROM rc_bootstrap_noop_fixture WHERE tag = ?',
    ).get(fixtureTag)).toEqual({ payload: `pending-${fixtureTag}` });
  } finally {
    validation.close();
    for (const file of Object.values(tripletPaths(validationPath))) fs.rmSync(file, { force: true });
  }
}

function makeCrashStyleTriplet(databasePath: string, expectedTable: string, fixtureTag: string): Triplet {
  // First make the closed main file self-contained. The final crash fixture is
  // produced from a distinct source connection below, before that connection
  // is closed, so its pending commit remains exclusively in WAL.
  const live = new Database(databasePath);
  try {
    expect(live.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
    live.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    live.close();
  }

  const fixtureRoot = path.join(path.dirname(databasePath), `.crash-fixture-${fixtureTag}`);
  fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(fixtureRoot, path.basename(databasePath));
  fs.copyFileSync(databasePath, sourcePath);
  const source = new Database(sourcePath);
  source.pragma('journal_mode = WAL');
  source.pragma('synchronous = FULL');
  source.pragma('wal_autocheckpoint = 0');
  source.exec(`
    CREATE TABLE IF NOT EXISTS rc_bootstrap_noop_fixture (
      tag TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
  `);
  source.prepare(
    'INSERT OR REPLACE INTO rc_bootstrap_noop_fixture (tag, payload) VALUES (?, ?)',
  ).run(fixtureTag, `pending-${fixtureTag}`);

  const crashPath = path.join(fixtureRoot, `crash-${path.basename(databasePath)}`);
  // This is deliberately copied while the writer is still open. It models a
  // process crash that leaves a coherent main/WAL/SHM byte set on disk.
  copyTriplet(sourcePath, crashPath);
  source.close();
  assertReadableClone(crashPath, expectedTable, fixtureTag);
  const crashBytes = readTriplet(crashPath);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  return crashBytes;
}

describe('Bootstrap Profile SQLite byte-level no-op contract', () => {
  it('preserves persistent RC monitor and OpenClaw Cron DB/WAL/SHM bytes on an exact same-digest rerun', async () => {
    const harness = makeHarness();
    const capsuleBytes = fs.readFileSync(FIXTURE);
    const first = await install(harness.paths, capsuleBytes);
    expect(first.noop).toBe(false);

    const rcCrash = makeCrashStyleTriplet(harness.paths.dbPath, 'rc_monitors', 'rc-monitor');
    const cronCrash = makeCrashStyleTriplet(harness.cronDbPath, 'cron_jobs', 'openclaw-cron');
    writeTriplet(harness.paths.dbPath, rcCrash);
    writeTriplet(harness.cronDbPath, cronCrash);
    assertReadableClone(harness.paths.dbPath, 'rc_monitors', 'rc-monitor');
    assertReadableClone(harness.cronDbPath, 'cron_jobs', 'openclaw-cron');

    const before = {
      monitor: readTriplet(harness.paths.dbPath),
      cron: readTriplet(harness.cronDbPath),
    };
    const staged = await applier.stageProfile({
      ...harness.paths,
      capsuleBytes,
      rcVersion: '0.8.3',
    });
    const applied = await applier.applyProfile({ ...harness.paths, txId: staged.txId });
    expect(applied).toMatchObject({ state: 'applied', noop: true });
    await applier.verifyProfile({ ...harness.paths, txId: staged.txId });
    await applier.commitProfile({ ...harness.paths, txId: staged.txId });

    expect.soft(compareTriplets(readTriplet(harness.paths.dbPath), before.monitor), 'RC monitor triplet')
      .toEqual({ db: true, wal: true, shm: true });
    expect.soft(compareTriplets(readTriplet(harness.cronDbPath), before.cron), 'OpenClaw Cron triplet')
      .toEqual({ db: true, wal: true, shm: true });
  }, 60_000);

  it('finishes a live Cron CAS write with an integrity check and a truncated WAL', () => {
    const harness = makeHarness();
    const seededJobs = runCronWorker(harness.paths.stateDir, 'inspect', {}).jobs;
    expect(seededJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'job-feed' }),
    ]));
    // The worker must perform a non-busy TRUNCATE checkpoint before it reports
    // success. Its own SDK write guarantees a WAL exists before that boundary.
    {
      const walPath = `${harness.cronDbPath}-wal`;

      const nextJobs = seededJobs.map((item: any) => item.id === 'job-feed'
        ? { ...item, name: 'job-feed-updated', updatedAtMs: item.updatedAtMs + 1 }
        : item);
      const replaced = runCronWorker(harness.paths.stateDir, 'compare-and-replace', {
        expectedDigest: require('../scripts/bootstrap-profile/cron-digest.cjs').jobsDigest(seededJobs),
        jobs: nextJobs,
      });
      expect(replaced.jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'job-feed', name: 'job-feed-updated' }),
      ]));
      const checked = new Database(harness.cronDbPath, { readonly: true, fileMustExist: true });
      try {
        expect(checked.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
      } finally {
        checked.close();
      }
      expect.soft(
        fs.existsSync(walPath) ? fs.statSync(walPath).size : 0,
        'Cron WAL after successful live write',
      ).toBe(0);

      // WAL truncation is observable, but SQLite has no durable flag proving a
      // prior quick_check. The standalone worker's successful stdout is the
      // observable CAS completion boundary, so it must check and checkpoint
      // before reporting success to its parent.
      const source = fs.readFileSync(CRON_WORKER, 'utf8');
      const branch = source.indexOf("action === 'compare-and-replace'");
      const save = source.indexOf('await saveCronStore', branch);
      const validation = source.indexOf('verifyAndCheckpointStateDatabase(stateDir)', save);
      const helper = source.indexOf('function verifyAndCheckpointStateDatabase');
      const quickCheck = source.indexOf("database.pragma('quick_check')", helper);
      const checkpoint = source.indexOf("database.pragma('wal_checkpoint(TRUNCATE)')", quickCheck);
      const response = source.indexOf('process.stdout.write', save);
      expect.soft(branch, 'Cron CAS branch').toBeGreaterThanOrEqual(0);
      expect.soft(save, 'Cron official SDK save').toBeGreaterThan(branch);
      expect.soft(helper, 'Cron validation helper').toBeGreaterThanOrEqual(0);
      expect.soft(quickCheck, 'Cron quick_check in helper').toBeGreaterThan(helper);
      expect.soft(checkpoint, 'Cron checkpoint after quick_check').toBeGreaterThan(quickCheck);
      expect.soft(validation, 'Cron validation after save').toBeGreaterThan(save);
      expect.soft(response, 'Cron success after validation').toBeGreaterThan(validation);
    }
  }, 60_000);
});
