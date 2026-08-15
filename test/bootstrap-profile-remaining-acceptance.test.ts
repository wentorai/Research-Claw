import crypto from 'node:crypto';
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
process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS = '1';
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

type Harness = ReturnType<typeof makeHarness>;
type Triplet = Record<'db' | 'wal' | 'shm', Buffer>;

const roots: string[] = [];
const LIVE_SWAP_FAULTS = [
  'skills', 'auth', 'config', 'monitor', 'cron', 'suspensions', 'receipt',
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cronJob(id: string, sessionKey: string) {
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

function runCronWorker(stateDir: string, action: string, payload: unknown = {}): any {
  const home = path.join(path.dirname(stateDir), 'cron-worker-home');
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true, mode: 0o700 });
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
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

function chmodPrivateTriplet(databasePath: string): void {
  if (process.platform === 'win32') return;
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${databasePath}${suffix}`;
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-remaining-'));
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
  const paths: Paths = {
    rcRoot: ROOT,
    configPath: path.join(configRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  writeJson(paths.configPath, {
    agents: {
      defaults: {
        model: { primary: 'user-provider/user-model', fallbacks: ['user-fallback/model'] },
        userAgentBait: 'preserve-agent',
      },
    },
    models: {
      mode: 'merge',
      providers: {
        'user-provider': {
          baseUrl: 'https://user.invalid/v1',
          api: 'openai-completions',
          models: [{
            id: 'user-model', name: 'User model', input: ['text'], contextWindow: 4096, maxTokens: 512,
          }],
          userProviderBait: true,
        },
      },
    },
    plugins: {
      entries: {
        'research-claw-core': { enabled: true, config: { userCoreBait: 'preserve-core' } },
        'dual-model-supervisor': {
          enabled: false,
          config: {
            enabled: false,
            supervisorModel: 'user-reviewer/model',
            reviewMode: 'off',
            userDmsBait: 'preserve-dms',
          },
        },
      },
    },
    tools: { deny: ['user-deny-bait'] },
    mcp: {
      servers: {
        plaud: {
          command: 'user-plaud-command',
          args: ['--user-bait'],
          headers: { Authorization: 'Bearer USER_PLAUD_BAIT' },
        },
        'user-server': { command: 'user-server', args: ['--preserve'] },
      },
    },
    userConfigBait: { preserve: true },
  });
  writeJson(paths.globalConfigPath, {
    agents: { defaults: { model: { primary: 'user-global/user-model' } } },
    models: { providers: { 'user-global-provider': { preserve: true } } },
    userGlobalBait: { preserve: true },
  });
  const authPath = path.join(stateDir, 'agents/main/agent/auth-profiles.json');
  writeJson(authPath, {
    version: 1,
    profiles: {
      'user-provider:manual': {
        type: 'api_key', provider: 'user-provider', key: 'USER_AUTH_BAIT', preserve: true,
      },
    },
    userAuthStoreBait: { preserve: true },
  });

  const userSkill = path.join(workspace, 'skills/user-skill');
  fs.mkdirSync(userSkill, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(userSkill, 'SKILL.md'), [
    '---', 'name: user-skill', 'description: user owned', '---', '', 'PRESERVE_USER_SKILL', '',
  ].join('\n'), { mode: 0o600 });

  const baitFiles = [
    [path.join(workspace, 'sessions/user-session.jsonl'), '{"session":"workspace-bait"}\n'],
    [path.join(workspace, 'audit/user-audit.jsonl'), '{"audit":"workspace-bait"}\n'],
    [path.join(workspace, 'cache/user-cache.bin'), 'WORKSPACE_CACHE_BAIT\u0000\u0001'],
    [path.join(stateDir, 'sessions/main/user-session.jsonl'), '{"session":"state-bait"}\n'],
    [path.join(stateDir, 'audit/user-audit.jsonl'), '{"audit":"state-bait"}\n'],
    [path.join(stateDir, 'cache/user-cache.bin'), 'STATE_CACHE_BAIT\u0000\u0001'],
  ] as const;
  for (const [file, content] of baitFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }

  const database = new Database(paths.dbPath);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.exec(`
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
    );
    CREATE TABLE user_records (
      id TEXT PRIMARY KEY,
      payload BLOB NOT NULL,
      note TEXT NOT NULL
    );
  `);
  const insertMonitor = database.prepare(
    'INSERT INTO rc_monitors (id,name,source_type,target,enabled,gateway_job_id) VALUES (?,?,?,?,?,?)',
  );
  insertMonitor.run('device-bait', 'Device bait', 'device', 'camera-bait', 1, 'job-device-bait');
  insertMonitor.run('feed-bait', 'Feed bait', 'feed', 'https://feed.invalid', 1, 'job-feed-bait');
  database.prepare('INSERT INTO user_records (id,payload,note) VALUES (?,?,?)')
    .run('user-row', Buffer.from([0, 1, 2, 3, 254, 255]), 'PRESERVE_USER_DB_ROW');
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.close();
  chmodPrivateTriplet(paths.dbPath);

  const jobs = [
    cronJob('job-device-bait', 'cron:rc-monitor:device-bait'),
    cronJob('job-feed-bait', 'cron:rc-monitor:feed-bait'),
  ];
  runCronWorker(stateDir, 'seed', { version: 1, jobs });
  const cronDbPath = path.join(stateDir, 'state/openclaw.sqlite');
  chmodPrivateTriplet(cronDbPath);
  ensureInitialized({ ...paths, externalStopVerified: true });
  return { root, paths, authPath, baitFiles: baitFiles.map(([file]) => file), cronDbPath };
}

function capsule(overrides: {
  profileId?: string;
  revision?: number;
  key?: string;
  peripherals?: 'disabled' | 'enabled' | 'enabled-hidden';
} = {}): Buffer {
  const value = readJson(FIXTURE);
  if (overrides.profileId !== undefined) {
    value.profile.id = overrides.profileId;
    value.model.providerId = `custom-rc-profile-${overrides.profileId}`;
  }
  if (overrides.revision !== undefined) value.profile.revision = overrides.revision;
  if (overrides.key !== undefined) value.secrets.modelApiKey = overrides.key;
  if (overrides.peripherals !== undefined) {
    value.policy.capabilities.peripherals = overrides.peripherals;
  }
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function stage(harness: Harness, raw: Buffer, rcVersion = '0.8.3'): Promise<any> {
  return applier.stageProfile({
    ...harness.paths,
    capsuleBytes: raw,
    rcVersion,
  });
}

async function install(harness: Harness, raw: Buffer): Promise<any> {
  const staged = await stage(harness, raw);
  const applied = await applier.applyProfile({ ...harness.paths, txId: staged.txId });
  await applier.verifyProfile({ ...harness.paths, txId: staged.txId });
  await applier.commitProfile({ ...harness.paths, txId: staged.txId });
  return applied;
}

function receiptPath(harness: Harness): string {
  return path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap/receipt.json');
}

function ledgerPath(harness: Harness): string {
  return path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap/peripheral-suspensions.json');
}

function transactionRoots(harness: Harness, txId: string): string[] {
  return [
    path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap/transactions', txId),
    path.join(harness.paths.workspace, '.rc-bootstrap-transactions', txId),
    path.join(harness.paths.stateDir, '.rc-bootstrap-transactions', txId),
    path.join(path.dirname(harness.paths.dbPath), '.rc-bootstrap-transactions', txId),
  ];
}

function pathBytesAndMode(target: string): any {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(target);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { type: 'absent' };
    throw error;
  }
  const mode = process.platform === 'win32' ? null : metadata.mode & 0o777;
  if (metadata.isDirectory()) {
    return {
      type: 'directory',
      mode,
      children: Object.fromEntries(fs.readdirSync(target).sort().map(
        (name) => [name, pathBytesAndMode(path.join(target, name))],
      )),
    };
  }
  if (metadata.isFile()) {
    const bytes = fs.readFileSync(target);
    return {
      type: 'file', mode, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
  if (metadata.isSymbolicLink()) return { type: 'symlink', mode, target: fs.readlinkSync(target) };
  return { type: 'other', mode };
}

function pathBytesModeMtime(target: string): any {
  let metadata: fs.BigIntStats;
  try {
    metadata = fs.statSync(target, { bigint: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { type: 'absent' };
    throw error;
  }
  const mode = process.platform === 'win32' ? null : Number(metadata.mode & 0o777n);
  if (metadata.isDirectory()) {
    return {
      type: 'directory',
      mode,
      mtimeNs: metadata.mtimeNs.toString(),
      children: Object.fromEntries(fs.readdirSync(target).sort().map(
        (name) => [name, pathBytesModeMtime(path.join(target, name))],
      )),
    };
  }
  if (metadata.isFile()) {
    const bytes = fs.readFileSync(target);
    return {
      type: 'file',
      mode,
      mtimeNs: metadata.mtimeNs.toString(),
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
  return { type: 'other', mode, mtimeNs: metadata.mtimeNs.toString() };
}

function managedLiveState(harness: Harness): Record<string, any> {
  const paths = harness.paths;
  return Object.fromEntries([
    ['config', paths.configPath],
    ['auth', harness.authPath],
    ['global', paths.globalConfigPath],
    ['skills', path.join(paths.workspace, 'skills')],
    ['receipt', receiptPath(harness)],
    ['ledger', ledgerPath(harness)],
    ['rc-db', paths.dbPath],
    ['rc-wal', `${paths.dbPath}-wal`],
    ['rc-shm', `${paths.dbPath}-shm`],
    ['oc-db', harness.cronDbPath],
    ['oc-wal', `${harness.cronDbPath}-wal`],
    ['oc-shm', `${harness.cronDbPath}-shm`],
    ...harness.baitFiles.map((file) => [`bait:${path.relative(harness.root, file)}`, file]),
  ].map(([name, target]) => [name, pathBytesAndMode(target)]));
}

function prepareUserBaitBaseline(harness: Harness, targetFieldsAbsent: boolean): void {
  const providerId = 'custom-rc-profile-thermoelectric-user-a';
  const authProfileId = `${providerId}:managed`;
  const config = readJson(harness.paths.configPath);
  config.agents.defaults.model.primary = 'user-bait-primary/user-model';
  config.agents.defaults.model.fallbacks = ['user-fallback/model'];
  config.agents.defaults.userAgentBait = 'preserve-agent';
  config.models.providers['user-provider'].userProviderBait = true;
  config.plugins.entries['research-claw-core'].config.userCoreBait = 'preserve-core';
  config.plugins.entries['dual-model-supervisor'].config = {
    enabled: false,
    supervisorModel: 'user-reviewer/model',
    reviewMode: 'off',
    userDmsBait: 'preserve-dms',
  };
  config.tools.deny = ['user-deny-bait', 'periph_*', 'plaud__*'];
  config.userConfigBait = { preserve: true };

  const global = readJson(harness.paths.globalConfigPath);
  global.agents.defaults.model.primary = 'user-global-bait/user-model';
  global.userGlobalBait = { preserve: true };
  const auth = readJson(harness.authPath);
  auth.profiles['user-provider:manual'] = {
    type: 'api_key', provider: 'user-provider', key: 'USER_AUTH_BAIT', preserve: true,
  };
  auth.userAuthStoreBait = { preserve: true };

  if (targetFieldsAbsent) {
    delete config.models.providers[providerId];
    delete config.auth.profiles[authProfileId];
    delete config.auth.order[providerId];
    delete config.plugins.entries['research-claw-core'].config.productPolicy;
    delete config.plugins.entries['dual-model-supervisor'].config.enabled;
    delete config.plugins.entries['dual-model-supervisor'].config.supervisorModel;
    delete config.plugins.entries['dual-model-supervisor'].config.reviewMode;
    config.tools.deny = ['user-deny-bait'];
    delete global.models.providers[providerId];
    delete global.auth.profiles[authProfileId];
    delete global.auth.order[providerId];
    delete auth.profiles[authProfileId];
  }
  writeJson(harness.paths.configPath, config);
  writeJson(harness.paths.globalConfigPath, global);
  writeJson(harness.authPath, auth);
}

function assertUserBaits(harness: Harness): void {
  const config = readJson(harness.paths.configPath);
  expect(config.agents.defaults.userAgentBait).toBe('preserve-agent');
  expect(config.models.providers['user-provider'].userProviderBait).toBe(true);
  expect(config.plugins.entries['research-claw-core'].config.userCoreBait).toBe('preserve-core');
  expect(config.plugins.entries['dual-model-supervisor'].config.userDmsBait).toBe('preserve-dms');
  expect(config.userConfigBait).toEqual({ preserve: true });
  expect(readJson(harness.paths.globalConfigPath).userGlobalBait).toEqual({ preserve: true });
  expect(readJson(harness.authPath).profiles['user-provider:manual']).toMatchObject({
    key: 'USER_AUTH_BAIT', preserve: true,
  });
  expect(fs.readFileSync(
    path.join(harness.paths.workspace, 'skills/user-skill/SKILL.md'), 'utf8',
  )).toContain('PRESERVE_USER_SKILL');
}

function assertTargetFieldsAbsent(harness: Harness): void {
  const providerId = 'custom-rc-profile-thermoelectric-user-a';
  const authProfileId = `${providerId}:managed`;
  const config = readJson(harness.paths.configPath);
  expect(config.models.providers).not.toHaveProperty(providerId);
  expect(config.auth.profiles).not.toHaveProperty(authProfileId);
  expect(config.auth.order).not.toHaveProperty(providerId);
  expect(config.plugins.entries['research-claw-core'].config).not.toHaveProperty('productPolicy');
  expect(config.plugins.entries['dual-model-supervisor'].config).not.toHaveProperty('reviewMode');
  expect(config.tools.deny).toEqual(['user-deny-bait']);
  expect(readJson(harness.authPath).profiles).not.toHaveProperty(authProfileId);
}

const faultCases = (['update', 'switch'] as const).flatMap((operation) =>
  LIVE_SWAP_FAULTS.map((fault, index) => ({
    operation,
    fault,
    targetFieldsAbsent: index % 2 === (operation === 'update' ? 1 : 0),
  })));

describe('remaining T04 rollback acceptance matrix', () => {
  it.each(faultCases)(
    '$operation rollback is byte-for-byte at $fault (target fields absent=$targetFieldsAbsent)',
    async ({ operation, fault, targetFieldsAbsent }) => {
      const harness = makeHarness();
      await install(harness, capsule());
      prepareUserBaitBaseline(harness, targetFieldsAbsent);
      assertUserBaits(harness);
      if (targetFieldsAbsent) assertTargetFieldsAbsent(harness);
      const before = managedLiveState(harness);
      const raw = operation === 'update'
        ? capsule({ revision: 2, key: 'RC_TEST_ONLY_ROTATED_ACCEPTANCE_KEY', peripherals: 'enabled' })
        : capsule({
          profileId: 'thermoelectric-user-b',
          key: 'RC_TEST_ONLY_SWITCH_ACCEPTANCE_KEY',
          peripherals: 'enabled',
        });
      const staged = await stage(harness, raw);
      await expect(applier.applyProfile({
        ...harness.paths,
        txId: staged.txId,
        fault,
      })).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
      await expect(applier.rollbackProfile({
        ...harness.paths,
        txId: staged.txId,
      })).resolves.toMatchObject({ state: 'rolled-back' });

      expect(managedLiveState(harness)).toEqual(before);
      assertUserBaits(harness);
      if (targetFieldsAbsent) assertTargetFieldsAbsent(harness);
      if (operation === 'switch') {
        const config = readJson(harness.paths.configPath);
        const auth = readJson(harness.authPath);
        expect(config.models.providers).not.toHaveProperty('custom-rc-profile-thermoelectric-user-b');
        expect(auth.profiles).not.toHaveProperty('custom-rc-profile-thermoelectric-user-b:managed');
      }
      for (const root of transactionRoots(harness, staged.txId)) expect(fs.existsSync(root)).toBe(false);
    },
    60_000,
  );
});

function tripletPaths(databasePath: string): Record<keyof Triplet, string> {
  return { db: databasePath, wal: `${databasePath}-wal`, shm: `${databasePath}-shm` };
}

function readTriplet(databasePath: string): Triplet {
  const files = tripletPaths(databasePath);
  for (const file of Object.values(files)) {
    expect(fs.existsSync(file), `missing SQLite member ${file}`).toBe(true);
    expect(fs.statSync(file).size, `empty SQLite member ${file}`).toBeGreaterThan(0);
  }
  return {
    db: fs.readFileSync(files.db),
    wal: fs.readFileSync(files.wal),
    shm: fs.readFileSync(files.shm),
  };
}

function writeTriplet(databasePath: string, bytes: Triplet): void {
  const files = tripletPaths(databasePath);
  for (const file of Object.values(files)) fs.rmSync(file, { force: true });
  for (const key of ['db', 'wal', 'shm'] as const) {
    fs.writeFileSync(files[key], bytes[key], { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(files[key], 0o600);
  }
}

function copyTriplet(source: string, target: string): void {
  writeTriplet(target, readTriplet(source));
}

function makeCrashStyleTriplet(databasePath: string, fixtureTag: string): Triplet {
  const live = new Database(databasePath);
  live.pragma('wal_checkpoint(TRUNCATE)');
  live.close();
  const fixtureRoot = path.join(path.dirname(databasePath), `.remaining-crash-${fixtureTag}`);
  fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  const source = path.join(fixtureRoot, path.basename(databasePath));
  fs.copyFileSync(databasePath, source);
  const database = new Database(source);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('wal_autocheckpoint = 0');
  database.exec('CREATE TABLE rc_remaining_noop_bait (tag TEXT PRIMARY KEY, payload BLOB NOT NULL)');
  database.prepare('INSERT INTO rc_remaining_noop_bait (tag,payload) VALUES (?,?)')
    .run(fixtureTag, Buffer.from(`PENDING_${fixtureTag}`));
  const crash = path.join(fixtureRoot, `crash-${path.basename(databasePath)}`);
  copyTriplet(source, crash);
  database.close();
  const validation = new Database(crash, { readonly: true, fileMustExist: true });
  expect(validation.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
  expect(validation.prepare('SELECT payload FROM rc_remaining_noop_bait WHERE tag=?').get(fixtureTag).payload)
    .toEqual(Buffer.from(`PENDING_${fixtureTag}`));
  validation.close();
  const result = readTriplet(crash);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  return result;
}

function touchTree(target: string, timestamp: Date): void {
  const metadata = fs.lstatSync(target);
  if (metadata.isDirectory()) {
    for (const name of fs.readdirSync(target)) touchTree(path.join(target, name), timestamp);
  }
  fs.utimesSync(target, timestamp, timestamp);
}

describe('remaining T04 no-op and private-mode acceptance', () => {
  it('keeps every converged same-digest asset byte, mode, and mtime stable, including both SQLite triplets', async () => {
    const harness = makeHarness();
    const raw = capsule();
    await install(harness, raw);
    writeTriplet(harness.paths.dbPath, makeCrashStyleTriplet(harness.paths.dbPath, 'rc-db'));
    writeTriplet(harness.cronDbPath, makeCrashStyleTriplet(harness.cronDbPath, 'oc-db'));

    const targets = {
      config: harness.paths.configPath,
      auth: harness.authPath,
      global: harness.paths.globalConfigPath,
      skills: path.join(harness.paths.workspace, 'skills'),
      receipt: receiptPath(harness),
      ledger: ledgerPath(harness),
      rcDb: harness.paths.dbPath,
      rcWal: `${harness.paths.dbPath}-wal`,
      rcShm: `${harness.paths.dbPath}-shm`,
      ocDb: harness.cronDbPath,
      ocWal: `${harness.cronDbPath}-wal`,
      ocShm: `${harness.cronDbPath}-shm`,
    };
    const fixedTime = new Date('2020-01-02T03:04:05.000Z');
    for (const target of Object.values(targets)) touchTree(target, fixedTime);
    const before = Object.fromEntries(Object.entries(targets).map(
      ([name, target]) => [name, pathBytesModeMtime(target)],
    ));

    const staged = await stage(harness, raw);
    const applied = await applier.applyProfile({ ...harness.paths, txId: staged.txId });
    expect(applied).toMatchObject({ state: 'applied', noop: true });
    await applier.verifyProfile({ ...harness.paths, txId: staged.txId });
    await applier.commitProfile({ ...harness.paths, txId: staged.txId });

    expect(Object.fromEntries(Object.entries(targets).map(
      ([name, target]) => [name, pathBytesModeMtime(target)],
    ))).toEqual(before);
    for (const root of transactionRoots(harness, staged.txId)) expect(fs.existsSync(root)).toBe(false);
  }, 90_000);

  it.skipIf(process.platform === 'win32')(
    'keeps applied transaction material private and commits 0700/0600 managed artifacts',
    async () => {
      const harness = makeHarness();
      const staged = await stage(harness, capsule());
      await applier.applyProfile({ ...harness.paths, txId: staged.txId });

      const assertPrivateTree = (target: string): void => {
        const metadata = fs.lstatSync(target);
        expect(metadata.isSymbolicLink(), target).toBe(false);
        if (metadata.isDirectory()) {
          expect(metadata.mode & 0o777, target).toBe(0o700);
          for (const name of fs.readdirSync(target)) assertPrivateTree(path.join(target, name));
        } else if (metadata.isFile()) {
          expect(metadata.mode & 0o777, target).toBe(0o600);
        } else {
          throw new Error(`unexpected private transaction entry: ${target}`);
        }
      };
      for (const root of transactionRoots(harness, staged.txId)) assertPrivateTree(root);
      expect(fs.statSync(receiptPath(harness)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(ledgerPath(harness)).mode & 0o777).toBe(0o600);
      const receipt = readJson(receiptPath(harness));
      for (const skill of receipt.skills) {
        assertPrivateTree(path.join(harness.paths.workspace, 'skills', skill.directory));
      }

      await applier.verifyProfile({ ...harness.paths, txId: staged.txId });
      await applier.commitProfile({ ...harness.paths, txId: staged.txId });
      expect(fs.statSync(receiptPath(harness)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(ledgerPath(harness)).mode & 0o777).toBe(0o600);
      for (const skill of receipt.skills) {
        assertPrivateTree(path.join(harness.paths.workspace, 'skills', skill.directory));
      }
      for (const root of transactionRoots(harness, staged.txId)) expect(fs.existsSync(root)).toBe(false);
    },
    60_000,
  );
});

function unrelatedState(harness: Harness): any {
  const database = new Database(harness.paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    const record = database.prepare('SELECT id,payload,note FROM user_records WHERE id=?').get('user-row');
    const feed = database.prepare('SELECT * FROM rc_monitors WHERE id=?').get('feed-bait');
    return {
      files: Object.fromEntries(harness.baitFiles.map(
        (file) => [path.relative(harness.root, file), pathBytesModeMtime(file)],
      )),
      userSkill: pathBytesModeMtime(path.join(harness.paths.workspace, 'skills/user-skill')),
      record: { ...record, payload: Buffer.from(record.payload).toString('hex') },
      feed,
    };
  } finally {
    database.close();
  }
}

const preservationCases = (['fresh', 'update', 'switch'] as const).flatMap((operation) =>
  (['commit', 'rollback'] as const).map((outcome) => ({ operation, outcome })));

describe('unrelated workspace, state, and RC database preservation', () => {
  it.each(preservationCases)(
    'keeps session/audit/cache files and unrelated RC rows unchanged on $operation $outcome',
    async ({ operation, outcome }) => {
      const harness = makeHarness();
      if (operation !== 'fresh') await install(harness, capsule());
      const before = unrelatedState(harness);
      const raw = operation === 'fresh' ? capsule()
        : operation === 'update'
          ? capsule({ revision: 2, key: 'RC_TEST_ONLY_PRESERVATION_ROTATED_KEY', peripherals: 'enabled' })
          : capsule({
            profileId: 'thermoelectric-user-b',
            key: 'RC_TEST_ONLY_PRESERVATION_SWITCH_KEY',
            peripherals: 'enabled',
          });
      const staged = await stage(harness, raw);
      if (outcome === 'commit') {
        await applier.applyProfile({ ...harness.paths, txId: staged.txId });
        await applier.verifyProfile({ ...harness.paths, txId: staged.txId });
        await applier.commitProfile({ ...harness.paths, txId: staged.txId });
      } else {
        await expect(applier.applyProfile({
          ...harness.paths, txId: staged.txId, fault: 'receipt',
        })).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
        await applier.rollbackProfile({ ...harness.paths, txId: staged.txId });
      }
      expect(unrelatedState(harness)).toEqual(before);
    },
    60_000,
  );
});

describe('candidate runtime version gate', () => {
  it('rcVersion 0.8.2 runtime rejects the canonical requiredRcVersion 0.8.3 Capsule before mutation', async () => {
    const harness = makeHarness();
    const before = managedLiveState(harness);
    await expect(stage(harness, capsule(), '0.8.2'))
      .rejects.toMatchObject({ code: 'RC_VERSION_MISMATCH' });
    expect(managedLiveState(harness)).toEqual(before);
    const transactions = path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap/transactions');
    expect(fs.existsSync(transactions) ? fs.readdirSync(transactions) : []).toEqual([]);
  });
});
