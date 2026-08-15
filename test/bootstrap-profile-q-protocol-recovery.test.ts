import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const APPLIER_MODULE = path.join(ROOT, 'scripts/bootstrap-profile/applier.cjs');
const CRON_WORKER = path.join(ROOT, 'scripts/bootstrap-profile/cron-worker.mjs');
const Q_PHASE_RUNNER = path.join(ROOT, 'test/fixtures/bootstrap-profile-q-cleanup-runner.cjs');
const Q_PROTOCOL_RUNNER = path.join(ROOT, 'test/fixtures/bootstrap-profile-q-protocol-runner.cjs');
const require = createRequire(import.meta.url);
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(ROOT, 'extensions/research-claw-core'), ROOT],
}));
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS = '1';

type Harness = ReturnType<typeof makeHarness>;
type Layer = 'inventory' | 'reservation' | 'authority' | 'intent' | 'delete-authority' | 'done';

const PUBLICATION_CRASH_CASES = (['inventory', 'reservation', 'authority', 'intent',
  'delete-authority', 'done'] as const).flatMap((layer) => ([
  { layer, stage: 'created-durable' as const, shape: 'staging' as const },
  { layer, stage: 'linked-durable' as const, shape: 'pair' as const },
  { layer, stage: 'normalized-durable' as const, shape: 'final' as const },
]));

const ZERO_WATCH_COUNTS = {
  accessSync: 0,
  existsSync: 0,
  lstatSync: 0,
  openSync: 0,
  opendirSync: 0,
  readFileSync: 0,
  readdirSync: 0,
  readlinkSync: 0,
  readSync: 0,
  realpathSync: 0,
  statSync: 0,
} as const;

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-q-protocol-'));
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
  insert.run('feed-monitor', 'Feed', 'feed', 'https://example.invalid', 1, 'job-feed');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  worker(stateDir, 'seed', {
    version: 1,
    jobs: [
      job('job-device-bound', 'agent:main:cron:legacy'),
      job('job-device-session', 'cron:rc-monitor:device-session'),
      job('job-feed', 'cron:rc-monitor:feed-monitor'),
    ],
  });
  ensureInitialized({ ...paths, externalStopVerified: true });
  return { root, paths };
}

function capsule(): Buffer {
  return Buffer.from(`${JSON.stringify(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))}\n`);
}

async function stage(harness: Harness): Promise<any> {
  return applier.stageProfile({
    ...harness.paths,
    capsuleBytes: capsule(),
    rcVersion: '0.8.3',
  });
}

async function install(harness: Harness): Promise<any> {
  const staged = await stage(harness);
  await applier.applyProfile({ ...harness.paths, txId: staged.txId });
  await applier.verifyProfile({ ...harness.paths, txId: staged.txId });
  await applier.commitProfile({ ...harness.paths, txId: staged.txId });
  return staged;
}

function qPaths(harness: Harness, txId: string, epoch: string) {
  const bootstrap = path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap');
  const transaction = path.join(bootstrap, 'transactions', txId);
  const suffix = `scratch-${epoch}`;
  const discoverInventory = (): { final: string; staging: string; anchor: string | null } | null => {
    if (!fs.existsSync(transaction)) return null;
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `^cron-worker-cleanup-inventory-${escaped}(?:-([0-9a-f]{64}))?\\.(json|staging)$`,
    );
    const matches = fs.readdirSync(transaction).map((name) => ({ name, match: pattern.exec(name) }))
      .filter((item): item is { name: string; match: RegExpExecArray } => Boolean(item.match));
    if (matches.length === 0) return null;
    const anchors = [...new Set(matches.map((item) => item.match[1] ?? null))];
    if (anchors.length !== 1) throw new Error('ambiguous test inventory anchor');
    const anchor = anchors[0];
    const stem = path.join(
      transaction,
      `cron-worker-cleanup-inventory-${suffix}${anchor ? `-${anchor}` : ''}`,
    );
    return { final: `${stem}.json`, staging: `${stem}.staging`, anchor };
  };
  return {
    bootstrap,
    transaction,
    transactions: path.dirname(transaction),
    quarantine: path.join(bootstrap, 'cron-worker-cleanup-quarantine'),
    source: path.join(transaction, `.rc-bootstrap-worker-${txId}-${epoch}`),
    get inventory() { return discoverInventory()?.final ?? null; },
    get inventoryStaging() { return discoverInventory()?.staging ?? null; },
    get inventoryAnchor() { return discoverInventory()?.anchor ?? null; },
    reservation: path.join(transaction, `cron-worker-cleanup-reservation-${suffix}.json`),
    reservationStaging: path.join(transaction, `cron-worker-cleanup-reservation-${suffix}.staging`),
    authority: path.join(transaction, `cron-worker-cleanup-authority-${suffix}.json`),
    authorityStaging: path.join(transaction, `cron-worker-cleanup-authority-${suffix}.staging`),
    deleteAuthority: path.join(
      transaction, `cron-worker-cleanup-delete-authority-${suffix}.json`,
    ),
    deleteAuthorityStaging: path.join(
      transaction, `cron-worker-cleanup-delete-authority-${suffix}.staging`,
    ),
    done: path.join(transaction, `cron-worker-cleanup-done-${suffix}.json`),
    doneStaging: path.join(transaction, `cron-worker-cleanup-done-${suffix}.staging`),
  };
}

function requiredPath(value: string | null, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function canonicalTestPath(target: string): string {
  const resolved = path.resolve(target);
  let parent = path.dirname(resolved);
  const suffixes = [path.basename(resolved)];
  for (;;) {
    try {
      const canonicalParent = fs.realpathSync.native(parent);
      return path.join(canonicalParent, ...suffixes);
    } catch (error: any) {
      if (!error || !['ENOENT', 'ENOTDIR'].includes(error.code)) return resolved;
      const next = path.dirname(parent);
      if (next === parent) return resolved;
      suffixes.unshift(path.basename(parent));
      parent = next;
    }
  }
}

function invalidInventoryArtifact(
  harness: Harness,
  txId: string,
  epoch: string,
  publication: 'json' | 'staging' = 'json',
): string {
  const files = qPaths(harness, txId, epoch);
  const anchor = sha256(`invalid-inventory-anchor\0${txId}\0${epoch}`);
  return path.join(
    files.transaction,
    `cron-worker-cleanup-inventory-scratch-${epoch}-${anchor}.${publication}`,
  );
}

function serialDirectoryMetadata(target: string) {
  const metadata = fs.lstatSync(target, { bigint: true });
  expect(metadata.isDirectory()).toBe(true);
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: process.platform === 'win32' ? null : Number(metadata.mode & 0o7777n),
    uid: Number(metadata.uid),
  };
}

function writeSyntheticInventory(
  harness: Harness, txId: string, epoch: string, bytes: number,
): string {
  const files = qPaths(harness, txId, epoch);
  fs.mkdirSync(files.source, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(files.source, 0o700);
  const memberName = 'projected-cross-artifact.bin';
  const member = path.join(files.source, memberName);
  fs.writeFileSync(member, Buffer.alloc(bytes, 0x71), { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(member, 0o600);
  const rootIdentity = serialDirectoryMetadata(files.source);
  const memberMetadata = fs.lstatSync(member, { bigint: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(files.transaction, 'manifest.json'), 'utf8'));
  const body = {
    version: 1,
    txId,
    kind: 'scratch',
    epoch,
    pathsHash: manifest.pathsHash,
    source: path.join(txId, path.basename(files.source)),
    sourceParentIdentity: serialDirectoryMetadata(files.transaction),
    entries: [
      { relative: '', ...rootIdentity, type: 'directory' },
      {
        relative: memberName,
        dev: memberMetadata.dev.toString(),
        ino: memberMetadata.ino.toString(),
        mode: process.platform === 'win32' ? null : Number(memberMetadata.mode & 0o7777n),
        uid: Number(memberMetadata.uid),
        type: 'file',
        nlink: 1,
        size: bytes,
        sha256: sha256(fs.readFileSync(member)),
      },
    ],
    totalBytes: bytes,
    pathBytes: Buffer.byteLength(memberName),
  };
  const value = { ...body, digest: valueHash(body) };
  const publication = canonicalBytes(value);
  const anchor = sha256(publication);
  const target = path.join(
    files.transaction,
    `cron-worker-cleanup-inventory-scratch-${epoch}-${anchor}.json`,
  );
  fs.writeFileSync(target, publication, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return target;
}

function writeLongControlInventory(
  harness: Harness,
  txId: string,
  epoch: string,
): { target: string; inventoryBytes: number; entries: number; pathBytes: number } {
  const files = qPaths(harness, txId, epoch);
  const parentIdentity = serialDirectoryMetadata(files.transaction);
  const manifest = JSON.parse(fs.readFileSync(path.join(files.transaction, 'manifest.json'), 'utf8'));
  const emptySha256 = sha256(Buffer.alloc(0));
  const directories = Array.from({ length: 4 }, (_, index) => (
    `directory-${index}-${'d'.repeat(168)}`
  ));
  const directoryEntries = directories.map((relative, index) => ({
    relative,
    dev: '1',
    ino: String(2_000 + index),
    mode: process.platform === 'win32' ? null : 0o700,
    uid: parentIdentity.uid,
    type: 'directory',
  }));
  const fileEntries = Array.from({ length: 95 }, (_, index) => {
    const directory = directories[index % directories.length];
    const prefix = `file-${String(index).padStart(3, '0')}-`;
    const member = `${prefix}${'x'.repeat(200 - prefix.length)}`;
    return {
      relative: path.join(directory, member),
      dev: '1',
      ino: String(10_000 + index),
      mode: process.platform === 'win32' ? null : 0o600,
      uid: parentIdentity.uid,
      type: 'file',
      nlink: 1,
      size: 0,
      sha256: emptySha256,
    };
  });
  const entries = [
    {
      relative: '', dev: '1', ino: '1000',
      mode: process.platform === 'win32' ? null : 0o700,
      uid: parentIdentity.uid, type: 'directory',
    },
    ...directoryEntries,
    ...fileEntries,
  ];
  const pathBytes = [...directoryEntries, ...fileEntries].reduce(
    (sum, entry) => sum + Buffer.byteLength(entry.relative), 0,
  );
  const body = {
    version: 1,
    txId,
    kind: 'scratch',
    epoch,
    pathsHash: manifest.pathsHash,
    source: path.join(txId, path.basename(files.source)),
    sourceParentIdentity: parentIdentity,
    entries,
    totalBytes: 0,
    pathBytes,
  };
  const value = { ...body, digest: valueHash(body) };
  const bytes = canonicalBytes(value);
  const anchor = sha256(bytes);
  const target = path.join(
    files.transaction,
    `cron-worker-cleanup-inventory-scratch-${epoch}-${anchor}.json`,
  );
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return { target, inventoryBytes: bytes.length, entries: entries.length, pathBytes };
}

function layerFile(harness: Harness, txId: string, epoch: string, layer: Layer): string {
  const files = qPaths(harness, txId, epoch);
  if (layer === 'intent') {
    const reservation = JSON.parse(fs.readFileSync(files.reservation, 'utf8'));
    return path.join(files.quarantine, reservation.container, 'intent.json');
  }
  const target = layer === 'delete-authority' ? files.deleteAuthority : files[layer];
  return requiredPath(target, `${layer} final`);
}

function layerPublicationFiles(
  harness: Harness,
  txId: string,
  epoch: string,
  layer: Layer,
): { final: string; staging: string } {
  const final = layerFile(harness, txId, epoch, layer);
  if (layer === 'intent') return { final, staging: path.join(path.dirname(final), 'intent.staging') };
  const files = qPaths(harness, txId, epoch);
  if (layer === 'delete-authority') {
    return { final, staging: files.deleteAuthorityStaging };
  }
  return {
    final,
    staging: requiredPath(
      files[`${layer}Staging` as keyof typeof files] as string | null,
      `${layer} staging`,
    ),
  };
}

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valueHash(value: any): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function withoutDigest(value: any): any {
  const body = structuredClone(value);
  delete body.digest;
  return body;
}

function redigest(value: any): any {
  value.digest = valueHash(withoutDigest(value));
  return value;
}

function readCanonicalRecord(file: string): { value: any; bytes: Buffer; metadata: fs.Stats } {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString('utf8'));
  expect(bytes.equals(canonicalBytes(value))).toBe(true);
  const metadata = fs.lstatSync(file);
  expect(metadata.isFile()).toBe(true);
  expect(metadata.nlink).toBe(1);
  if (process.platform !== 'win32') expect(metadata.mode & 0o7777).toBe(0o600);
  return { value, bytes, metadata };
}

function treeSnapshot(target: string): any {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(target);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const common = {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mode: process.platform === 'win32' ? null : metadata.mode & 0o7777,
    nlink: metadata.nlink,
    type: metadata.isSymbolicLink() ? 'symlink'
      : metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other',
  };
  if (metadata.isSymbolicLink()) return { ...common, target: fs.readlinkSync(target) };
  if (metadata.isFile()) {
    const bytes = fs.readFileSync(target);
    return { ...common, size: bytes.length, sha256: sha256(bytes) };
  }
  if (!metadata.isDirectory()) return common;
  return {
    ...common,
    entries: Object.fromEntries(
      fs.readdirSync(target).sort().map((name) => [name, treeSnapshot(path.join(target, name))]),
    ),
  };
}

function writeSparseFixture(file: string, size: number, marker: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    const head = Buffer.from(`HEAD:${marker}`);
    const tail = Buffer.from(`TAIL:${marker}`);
    fs.writeSync(descriptor, head, 0, head.length, 0);
    fs.writeSync(descriptor, tail, 0, tail.length, size - tail.length);
    fs.ftruncateSync(descriptor, size);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function sparseFixtureSnapshot(file: string): any {
  const metadata = fs.lstatSync(file);
  const sample = Buffer.alloc(64);
  const descriptor = fs.openSync(file, 'r');
  try {
    fs.readSync(descriptor, sample, 0, 32, 0);
    fs.readSync(descriptor, sample, 32, 32, Math.max(0, metadata.size - 32));
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    nlink: metadata.nlink,
    size: metadata.size,
    mode: process.platform === 'win32' ? null : metadata.mode & 0o7777,
    sample: sample.toString('base64'),
  };
}

function qWorld(harness: Harness, txId: string, extra: string[] = []): any {
  const bootstrap = path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap');
  return {
    transaction: treeSnapshot(path.join(bootstrap, 'transactions', txId)),
    quarantine: treeSnapshot(path.join(bootstrap, 'cron-worker-cleanup-quarantine')),
    extra: extra.map((target) => [target, treeSnapshot(target)]),
  };
}

function qArtifacts(harness: Harness): string[] {
  const bootstrap = path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap');
  const found: string[] = [];
  const visit = (target: string): void => {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(target); } catch { return; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    for (const name of fs.readdirSync(target).sort()) {
      const child = path.join(target, name);
      if ((name.startsWith('cron-worker-cleanup-')
          && name !== 'cron-worker-cleanup-quarantine')
          || name.startsWith('.cleanup-')) {
        found.push(child);
      }
      visit(child);
    }
  };
  visit(bootstrap);
  return found;
}

function cleanupArtifactsUnder(target: string): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(current); } catch { return; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    for (const name of fs.readdirSync(current).sort()) {
      const child = path.join(current, name);
      if (name.startsWith('cron-worker-cleanup-') || name.startsWith('.cleanup-')) {
        found.push(child);
      }
      visit(child);
    }
  };
  visit(target);
  return found;
}

async function capturedFailure(callback: () => unknown | Promise<unknown>): Promise<any> {
  try {
    await callback();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function assertStatusRejectsZeroWrite(
  harness: Harness,
  txId: string,
  extra: string[] = [],
  code = 'CRON_WORKER_LIFECYCLE_INVALID',
): Promise<void> {
  const before = qWorld(harness, txId, extra);
  const failure = await capturedFailure(() => applier.profileStatus(harness.paths));
  expect(failure).toMatchObject({ code });
  expect(qWorld(harness, txId, extra)).toEqual(before);
}

async function assertStatusAndRecoveryRejectZeroWrite(
  harness: Harness,
  txId: string,
  extra: string[] = [],
  code = 'CRON_WORKER_LIFECYCLE_INVALID',
): Promise<void> {
  const before = qWorld(harness, txId, extra);
  const statusFailure = await capturedFailure(() => applier.profileStatus(harness.paths));
  expect(statusFailure).toMatchObject({ code });
  expect(qWorld(harness, txId, extra)).toEqual(before);
  const recoveryFailure = await capturedFailure(() => applier.recoverProfiles(harness.paths));
  expect(recoveryFailure).toMatchObject({ code });
  expect(recoveryFailure.code).toBe(statusFailure.code);
  expect(qWorld(harness, txId, extra)).toEqual(before);
}

type RunningProtocol = {
  child: ChildProcess;
  ready: string;
  closed: Promise<void>;
  stderr: () => string;
};

async function waitForReady(running: RunningProtocol): Promise<any> {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(running.ready) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(fs.existsSync(running.ready), running.stderr()).toBe(true);
  return JSON.parse(fs.readFileSync(running.ready, 'utf8'));
}

function startProtocol(
  harness: Harness,
  txId: string,
  epoch: string | null,
  plan: Record<string, unknown>,
): RunningProtocol {
  const ready = path.join(harness.root, `q-protocol-${crypto.randomUUID()}.ready`);
  const child = spawn(process.execPath, [
    Q_PROTOCOL_RUNNER,
    APPLIER_MODULE,
    Buffer.from(JSON.stringify(harness.paths)).toString('base64url'),
    txId,
    epoch ?? '-',
    Buffer.from(JSON.stringify(plan)).toString('base64url'),
    ready,
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  return { child, ready, closed, stderr: () => stderr };
}

async function stopProtocol(running: RunningProtocol): Promise<void> {
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill('SIGKILL');
  }
  await running.closed;
}

async function pauseAtPhase(
  harness: Harness,
  txId: string,
  epoch: string,
  phase: string,
): Promise<{ running: RunningProtocol; observed: any }> {
  const ready = path.join(harness.root, `q-phase-${phase}-${crypto.randomUUID()}.ready`);
  const child = spawn(process.execPath, [
    Q_PHASE_RUNNER,
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
  const running = { child, ready, closed, stderr: () => stderr };
  return { running, observed: await waitForReady(running) };
}

async function runProtocol(
  harness: Harness,
  txId: string,
  epoch: string | null,
  plan: Record<string, unknown>,
): Promise<any> {
  const running = startProtocol(harness, txId, epoch, plan);
  const observed = await waitForReady(running);
  await running.closed;
  expect(running.child.exitCode, running.stderr()).toBe(0);
  return observed;
}

async function createDoneResidue(harness: Harness, txId: string, epoch: string): Promise<void> {
  const running = startProtocol(harness, txId, epoch, {
    action: 'cleanup',
    pausePublication: { layer: 'done', stage: 'normalized-durable' },
  });
  try {
    const observed = await waitForReady(running);
    expect(observed).toMatchObject({
      event: 'publication-normalized-durable',
      layer: 'done',
    });
  } finally {
    await stopProtocol(running);
  }
}

function assertCanonicalBindings(harness: Harness, txId: string, epoch: string, layer: Layer): void {
  const files = qPaths(harness, txId, epoch);
  const inventoryPath = files.inventory;
  const inventory = inventoryPath && fs.existsSync(inventoryPath)
    ? readCanonicalRecord(inventoryPath) : null;
  const reservation = fs.existsSync(files.reservation) ? readCanonicalRecord(files.reservation) : null;
  const authority = fs.existsSync(files.authority) ? readCanonicalRecord(files.authority) : null;
  const deletion = fs.existsSync(files.deleteAuthority)
    ? readCanonicalRecord(files.deleteAuthority) : null;
  const done = fs.existsSync(files.done) ? readCanonicalRecord(files.done) : null;
  if (inventory?.value.digest) expect(inventory.value.digest).toBe(valueHash(withoutDigest(inventory.value)));
  if (reservation) {
    expect(reservation.value.inventorySha256).toBe(sha256(inventory!.bytes));
    expect(reservation.value.inventoryDigest).toBe(inventory!.value.digest);
    expect(reservation.value.digest).toBe(valueHash(withoutDigest(reservation.value)));
  }
  if (authority) {
    expect(authority.value.reservationDigest).toBe(reservation!.value.digest);
    expect(authority.value.digest).toBe(valueHash(withoutDigest(authority.value)));
  }
  if (['intent', 'delete-authority'].includes(layer)) {
    const intent = readCanonicalRecord(layerFile(harness, txId, epoch, 'intent'));
    expect(intent.value.authorityDigest).toBe(authority!.value.digest);
    if (deletion) {
      expect(deletion.value.intentSha256).toBe(sha256(intent.bytes));
      expect(deletion.value.intentDigest).toBe(valueHash(intent.value));
    }
  }
  if (deletion) {
    expect(deletion.value.inventorySha256).toBe(sha256(inventory!.bytes));
    expect(deletion.value.inventoryDigest).toBe(inventory!.value.digest);
    expect(deletion.value.reservationDigest).toBe(reservation!.value.digest);
    expect(deletion.value.authorityDigest).toBe(authority!.value.digest);
    expect(deletion.value.digest).toBe(valueHash(withoutDigest(deletion.value)));
  }
  if (done) {
    expect(done.value.inventory).toEqual(inventory!.value);
    expect(done.value.reservation).toEqual(reservation!.value);
    expect(done.value.authority).toEqual(authority!.value);
    expect(done.value.deleteAuthority).toEqual(deletion!.value);
    expect(done.value.digest).toBe(valueHash(withoutDigest(done.value)));
  }
}

describe('bootstrap profile Q protocol durable recovery', () => {
  it.each([
    'inventory', 'reservation', 'authority', 'intent', 'delete-authority', 'done',
  ] as const)(
    'requires canonical, bound %s bytes and rejects an equivalent non-canonical final without mutation',
    async (layer) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const epoch = crypto.randomUUID();
      const running = startProtocol(harness, staged.txId, epoch, {
        action: 'cleanup',
        pausePublication: { layer, stage: 'normalized-durable' },
      });
      try {
        const observed = await waitForReady(running);
        expect(observed).toMatchObject({
          event: 'publication-normalized-durable', layer,
        });
      } finally {
        await stopProtocol(running);
      }

      assertCanonicalBindings(harness, staged.txId, epoch, layer);
      const target = layerFile(harness, staged.txId, epoch, layer);
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      const reordered = Object.fromEntries(Object.entries(value).reverse());
      const equivalent = Buffer.from(`${JSON.stringify(reordered)}\n`);
      expect(equivalent.equals(canonicalBytes(value))).toBe(false);
      fs.writeFileSync(target, equivalent, { flag: 'w' });
      if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
      expect(JSON.parse(equivalent.toString('utf8'))).toEqual(value);

      await assertStatusAndRecoveryRejectZeroWrite(harness, staged.txId);
    },
    30_000,
  );

  it('performs a fresh full-batch scan between first Q-root mkdir and R staging create', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const observed = await runProtocol(harness, staged.txId, epoch, {
      action: 'audit-cleanup',
    });
    expect(observed.result).toEqual({ ok: true });
    const rootCreate = observed.namespaceEvents.filter(
      (event: any) => event.operation === 'mkdir-quarantine-root',
    );
    const reservationCreate = observed.namespaceEvents.filter(
      (event: any) => event.layer === 'reservation' && event.operation === 'create-staging',
    );
    expect(rootCreate).toHaveLength(1);
    expect(reservationCreate).toHaveLength(1);
    expect(rootCreate[0].target).toBe(canonicalTestPath(
      qPaths(harness, staged.txId, epoch).quarantine,
    ));
    expect(reservationCreate[0].generation).toBeGreaterThan(rootCreate[0].generation);
    expect(qArtifacts(harness)).toEqual([]);
  }, 30_000);

  it('rescans after inventory capture and rejects an injected unknown Q before I staging', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const observed = await runProtocol(harness, staged.txId, epoch, {
      action: 'cleanup', injectUnknownAtPhase: 'inventory-captured-before-preflight',
    });
    expect(observed.attacked).toBe(true);
    expect(observed.attackDetails).toMatchObject({
      kind: 'unknown-q-artifact',
      phase: 'inventory-captured-before-preflight',
    });
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    expect(fs.existsSync(files.source)).toBe(true);
    expect(files.inventory).toBeNull();
    expect(files.inventoryStaging).toBeNull();
    expect(fs.existsSync(files.reservation)).toBe(false);
    expect(fs.existsSync(files.reservationStaging)).toBe(false);
    await assertStatusAndRecoveryRejectZeroWrite(harness, staged.txId);
  }, 30_000);

  it('rescans a pre-existing empty Q root after source validation and rejects unknown Q before R', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    fs.mkdirSync(files.quarantine, { mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(files.quarantine, 0o700);
    const observed = await runProtocol(harness, staged.txId, epoch, {
      action: 'cleanup',
      injectUnknownAtPhase: 'inventory-only-source-validated-before-q-refresh',
    });
    expect(observed.attacked).toBe(true);
    expect(observed.attackDetails).toMatchObject({
      kind: 'unknown-q-artifact',
      phase: 'inventory-only-source-validated-before-q-refresh',
    });
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    expect(fs.existsSync(files.source)).toBe(true);
    expect(files.inventory && fs.existsSync(files.inventory)).toBe(true);
    expect(files.inventoryStaging && fs.existsSync(files.inventoryStaging)).toBeFalsy();
    expect(fs.existsSync(files.reservation)).toBe(false);
    expect(fs.existsSync(files.reservationStaging)).toBe(false);
    expect(fs.readdirSync(files.quarantine)).toEqual([]);
    await assertStatusAndRecoveryRejectZeroWrite(harness, staged.txId);
  }, 30_000);

  it('rejects an escaping done container without any outside namespace or content syscall', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    await createDoneResidue(harness, staged.txId, epoch);
    const files = qPaths(harness, staged.txId, epoch);
    const done = readCanonicalRecord(files.done).value;

    for (const file of [
      requiredPath(files.inventory, 'inventory final'),
      files.reservation,
      files.authority,
      files.deleteAuthority,
    ]) {
      fs.unlinkSync(file);
    }
    const outside = path.join(harness.root, 'outside-done-container');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.writeFileSync(path.join(outside, 'sentinel'), 'NEVER_STAT_THROUGH_DONE\n', { mode: 0o600 });
    const escaping = path.relative(files.quarantine, outside);

    done.reservation.container = escaping;
    redigest(done.reservation);
    done.authority.container = escaping;
    done.authority.reservationDigest = done.reservation.digest;
    redigest(done.authority);
    const expectedIntent = {
      version: 1,
      authorityDigest: done.authority.digest,
      cleanupId: done.authority.cleanupId,
      txId: done.authority.txId,
      kind: done.authority.kind,
      epoch: done.authority.epoch,
      container: escaping,
      containerIdentity: done.authority.containerIdentity,
      state: 'prepared',
      reason: null,
      observed: null,
    };
    done.deleteAuthority.container = escaping;
    done.deleteAuthority.reservationDigest = done.reservation.digest;
    done.deleteAuthority.authorityDigest = done.authority.digest;
    done.deleteAuthority.intentSha256 = sha256(canonicalBytes(expectedIntent));
    done.deleteAuthority.intentDigest = valueHash(expectedIntent);
    redigest(done.deleteAuthority);
    redigest(done);
    fs.writeFileSync(files.done, canonicalBytes(done), { flag: 'w' });
    if (process.platform !== 'win32') fs.chmodSync(files.done, 0o600);

    const before = qWorld(harness, staged.txId, [outside]);
    for (const action of ['status', 'recover'] as const) {
      const observed = await runProtocol(harness, staged.txId, epoch, {
        action,
        watchPath: outside,
      });
      expect(observed.result).toMatchObject({
        ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
      });
      expect(observed.watchCounts).toEqual(ZERO_WATCH_COUNTS);
      expect(qWorld(harness, staged.txId, [outside])).toEqual(before);
    }
  }, 30_000);

  it('does not mutate an empty bound container when canonical scratch is absent before D', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const { running, observed } = await pauseAtPhase(
      harness, staged.txId, epoch, 'intent-container-created',
    );
    try {
      expect(observed.phase).toBe('intent-container-created');
    } finally {
      await stopProtocol(running);
    }
    const held = path.join(harness.root, 'held-pre-d-source');
    fs.renameSync(observed.context.path, held);
    expect(fs.readdirSync(observed.context.quarantine)).toEqual([]);
    await assertStatusAndRecoveryRejectZeroWrite(harness, staged.txId, [held]);
  }, 30_000);

  it.each([
    {
      lowerLayer: 'inventory-final',
      prematureLayer: 'delete-authority',
      inventoryStage: 'normalized-durable',
    },
    {
      lowerLayer: 'inventory-staging-only',
      prematureLayer: 'done',
      inventoryStage: 'created-durable',
    },
  ] as const)(
    'globally gates minimal $lowerLayer + premature $prematureLayer staging before lower-layer repair',
    async ({ lowerLayer, prematureLayer, inventoryStage }) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const epoch = crypto.randomUUID();
      const files = qPaths(harness, staged.txId, epoch);
      const running = startProtocol(harness, staged.txId, epoch, {
        action: 'cleanup',
        pausePublication: { layer: 'inventory', stage: inventoryStage },
      });
      try {
        const observedPublication = await waitForReady(running);
        expect(observedPublication).toMatchObject({
          event: `publication-${inventoryStage}`,
          layer: 'inventory',
        });
      } finally {
        await stopProtocol(running);
      }
      const premature = prematureLayer === 'delete-authority'
        ? files.deleteAuthorityStaging : files.doneStaging;
      fs.writeFileSync(premature, canonicalBytes({ version: 1, premature: true }), {
        flag: 'wx', mode: 0o600,
      });
      expect(Boolean(files.inventory && fs.existsSync(files.inventory)))
        .toBe(lowerLayer === 'inventory-final');
      expect(Boolean(files.inventoryStaging && fs.existsSync(files.inventoryStaging)))
        .toBe(lowerLayer === 'inventory-staging-only');
      expect(fs.existsSync(files.reservation)).toBe(false);
      expect(fs.existsSync(files.reservationStaging)).toBe(false);
      expect(fs.existsSync(files.quarantine)).toBe(false);
      await assertStatusAndRecoveryRejectZeroWrite(harness, staged.txId);
    },
    30_000,
  );

  it('keeps a discoverable I anchor while repairing a durable partial-I prefix', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const first = startProtocol(harness, staged.txId, epoch, {
      action: 'cleanup', partialInventoryBytes: 512,
    });
    let partialPublication: any;
    try {
      partialPublication = await waitForReady(first);
      expect(partialPublication).toMatchObject({
        event: 'partial-publication-durable', layer: 'inventory', bytes: 512,
      });
    } finally {
      await stopProtocol(first);
    }
    expect(files.inventory && fs.existsSync(files.inventory)).toBeFalsy();
    expect(fs.lstatSync(requiredPath(files.inventoryStaging, 'inventory staging')).size).toBe(512);
    expect(partialPublication.filenameAnchor).toMatch(/^[0-9a-f]{64}$/);
    expect(partialPublication.filenameAnchor).toBe(partialPublication.fullCanonicalSha256);
    expect(files.inventoryAnchor).toBe(partialPublication.fullCanonicalSha256);
    expect(canonicalTestPath(partialPublication.stagingPath))
      .toBe(canonicalTestPath(requiredPath(files.inventoryStaging, 'inventory staging')));
    await assertStatusRejectsZeroWrite(harness, staged.txId);

    const second = startProtocol(harness, staged.txId, epoch, {
      action: 'recover', observePartialRepair: true,
    });
    const observed = await waitForReady(second);
    if (observed.event === 'partial-inventory-old-anchor-unlinked') {
      await stopProtocol(second);
      expect(observed.anchors.final || observed.anchors.staging).toBe(true);
      await applier.recoverProfiles(harness.paths);
    } else {
      await second.closed;
      expect(observed).toMatchObject({ event: 'completed', result: { ok: true } });
    }
    expect(qArtifacts(harness)).toEqual([]);
  }, 30_000);

  it('rejects a non-prefix partial-I repair without changing its source or anchor', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const running = startProtocol(harness, staged.txId, epoch, {
      action: 'cleanup', partialInventoryBytes: 512,
    });
    const partial = await waitForReady(running);
    expect(partial).toMatchObject({
      event: 'partial-publication-durable', layer: 'inventory', bytes: 512,
    });
    await stopProtocol(running);
    const inventoryStaging = requiredPath(files.inventoryStaging, 'inventory staging');
    const bytes = fs.readFileSync(inventoryStaging);
    bytes[Math.min(255, bytes.length - 1)] ^= 0xff;
    fs.writeFileSync(inventoryStaging, bytes, { flag: 'w' });
    await assertStatusAndRecoveryRejectZeroWrite(harness, staged.txId);
  }, 30_000);

  it('rejects scratch cleanup after captured source is reparented under a replacement tx root', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const heldSource = path.join(harness.root, 'held-captured-scratch');
    const heldParent = path.join(harness.root, 'held-captured-scratch-parent');
    let barrier: any;
    const failure = await capturedFailure(() => {
      applier.__testing.runCronScratchCleanupProbe(
        harness.paths,
        staged.txId,
        epoch,
        (phase: string, context: any) => {
          if (phase !== 'created' || barrier) return;
          const sourceBefore = fs.lstatSync(context.home);
          const parentBefore = fs.lstatSync(files.transaction);
          fs.renameSync(context.home, heldSource);
          fs.renameSync(files.transaction, heldParent);
          fs.mkdirSync(files.transaction, { mode: 0o700 });
          if (process.platform !== 'win32') fs.chmodSync(files.transaction, 0o700);
          fs.renameSync(heldSource, context.home);
          fs.writeFileSync(path.join(files.transaction, 'attacker-parent-sentinel'),
            'CAPTURED_PARENT_REBOUND\n', { flag: 'wx', mode: 0o600 });
          const sourceAfter = fs.lstatSync(context.home);
          const parentAfter = fs.lstatSync(files.transaction);
          barrier = {
            sourceBefore: { dev: String(sourceBefore.dev), ino: String(sourceBefore.ino) },
            sourceAfter: { dev: String(sourceAfter.dev), ino: String(sourceAfter.ino) },
            parentBefore: { dev: String(parentBefore.dev), ino: String(parentBefore.ino) },
            parentAfter: { dev: String(parentAfter.dev), ino: String(parentAfter.ino) },
          };
        },
      );
    });
    expect(barrier).toBeTruthy();
    expect(barrier.sourceAfter).toEqual(barrier.sourceBefore);
    expect(barrier.parentAfter).not.toEqual(barrier.parentBefore);
    expect(failure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(fs.existsSync(heldParent)).toBe(true);
    expect(fs.existsSync(files.source)).toBe(true);
    expect(fs.readFileSync(path.join(files.transaction, 'attacker-parent-sentinel'), 'utf8'))
      .toBe('CAPTURED_PARENT_REBOUND\n');
  }, 30_000);

  it('rejects aggregate live DB/WAL/SHM size before creating any clone namespace', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const databasePath = path.join(harness.paths.stateDir, 'state/openclaw.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const database = new Database(databasePath);
    database.exec('CREATE TABLE size_admission_fixture (id INTEGER PRIMARY KEY)');
    database.close();
    if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);
    const walPath = `${databasePath}-wal`;
    const shmPath = `${databasePath}-shm`;
    writeSparseFixture(walPath, 33 * 1024 * 1024, 'wal');
    writeSparseFixture(shmPath, 33 * 1024 * 1024, 'shm');
    const liveFiles = [databasePath, walPath, shmPath];
    expect(liveFiles.reduce((sum, file) => sum + fs.lstatSync(file).size, 0))
      .toBeGreaterThan(64 * 1024 * 1024);
    const before = liveFiles.map(sparseFixtureSnapshot);

    const observed = await runProtocol(harness, staged.txId, null, {
      action: 'clone', auditCloneNamespace: true,
    });
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    expect(observed.cloneNamespaceEvents).toEqual([]);
    const clone = path.join(
      qPaths(harness, staged.txId, crypto.randomUUID()).transaction,
      'cron-clone',
    );
    expect(fs.existsSync(clone)).toBe(false);
    expect(liveFiles.map(sparseFixtureSnapshot)).toEqual(before);
    expect(qArtifacts(harness)).toEqual([]);
  }, 45_000);

  it.each([
    { phase: 'plan-to-copy', plan: { attack: 'tamper-clone-source-after-plan' } },
    { phase: 'copy-to-final-plan-check', plan: { tamperCloneSourceOnCloseNumber: 4 } },
  ] as const)(
    'rejects same-inode same-size live DB mutation in the $phase window',
    async ({ phase, plan }) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const databasePath = path.join(harness.paths.stateDir, 'state/openclaw.sqlite');
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      const database = new Database(databasePath);
      database.exec(`
        CREATE TABLE clone_hash_fixture (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
        INSERT INTO clone_hash_fixture (payload) VALUES (zeroblob(8192));
      `);
      database.close();
      if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);

      const observed = await runProtocol(harness, staged.txId, null, {
        action: 'clone', ...plan,
      });
      expect(observed.attacked).toBe(true);
      expect(observed.attackDetails).toMatchObject({
        kind: 'same-inode-clone-source-tamper',
      });
      expect(observed.attackDetails.beforeIdentity).toEqual(
        observed.attackDetails.afterIdentity,
      );
      expect(observed.attackDetails.beforeSha256).not.toBe(
        observed.attackDetails.afterSha256,
      );
      expect(observed.result).toMatchObject({
        ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
      });
      if (phase === 'copy-to-final-plan-check') {
        expect(observed.cloneSourceOpenCount).toBeGreaterThanOrEqual(4);
      }
      expect(fs.readFileSync(databasePath)).toEqual(
        Buffer.from(observed.attackDetails.bytes, 'base64'),
      );
      const transaction = qPaths(harness, staged.txId, crypto.randomUUID()).transaction;
      expect(fs.existsSync(path.join(transaction, 'cron-clone'))).toBe(false);
      expect(qArtifacts(harness)).toEqual([]);
      const rollback = await runProtocol(harness, staged.txId, null, { action: 'rollback' });
      expect(rollback.result).toEqual({ ok: true });
      expect(fs.existsSync(transaction)).toBe(false);
      expect(fs.readFileSync(databasePath)).toEqual(
        Buffer.from(observed.attackDetails.bytes, 'base64'),
      );
    },
    60_000,
  );

  it.each([{ label: '0620', mode: 0o620 }, { label: '0602', mode: 0o602 }])(
    'rejects a POSIX-writable live clone source mode $label before clone namespace creation',
    async ({ mode }) => {
      if (process.platform === 'win32') return;
      const harness = makeHarness();
      const staged = await stage(harness);
      const databasePath = path.join(harness.paths.stateDir, 'state/openclaw.sqlite');
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      const database = new Database(databasePath);
      database.exec('CREATE TABLE clone_mode_fixture (id INTEGER PRIMARY KEY)');
      database.close();
      fs.chmodSync(databasePath, mode);
      const before = treeSnapshot(databasePath);

      const observed = await runProtocol(harness, staged.txId, null, {
        action: 'clone', auditCloneNamespace: true,
      });
      expect(observed.result).toMatchObject({
        ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
      });
      expect(observed.cloneNamespaceEvents).toEqual([]);
      expect(treeSnapshot(databasePath)).toEqual(before);
      const transaction = qPaths(harness, staged.txId, crypto.randomUUID()).transaction;
      expect(fs.existsSync(path.join(transaction, 'cron-clone'))).toBe(false);
      expect(qArtifacts(harness)).toEqual([]);
    },
    30_000,
  );

  it('cleans only the exact partial clone destination after a midpoint ENOSPC short write', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const databasePath = path.join(harness.paths.stateDir, 'state/openclaw.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE clone_copy_fixture (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
      INSERT INTO clone_copy_fixture (payload) VALUES (zeroblob(8192));
    `);
    database.close();
    if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);
    const liveBefore = treeSnapshot(databasePath);

    const observed = await runProtocol(harness, staged.txId, null, {
      action: 'apply', cloneWriteFaultAfterBytes: 128,
    });
    expect(observed.attacked).toBe(true);
    expect(observed.attackDetails).toMatchObject({
      kind: 'clone-mid-write-enospc', partialBytes: 128,
    });
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    expect(fs.existsSync(observed.attackDetails.partialTarget)).toBe(false);
    expect(treeSnapshot(databasePath)).toEqual(liveBefore);
    const transaction = qPaths(harness, staged.txId, crypto.randomUUID()).transaction;
    expect(fs.existsSync(transaction)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(transaction, 'manifest.json'), 'utf8')).state)
      .toBe('preparing');
    expect(qArtifacts(harness)).toEqual([]);

    const rollback = await runProtocol(harness, staged.txId, null, { action: 'rollback' });
    expect(rollback.result).toEqual({ ok: true });
    expect(fs.existsSync(transaction)).toBe(false);
    expect(treeSnapshot(databasePath)).toEqual(liveBefore);
    expect(qArtifacts(harness)).toEqual([]);
  }, 60_000);

  it('preserves a replacement clone destination and blocks every broad cleanup entry', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const databasePath = path.join(harness.paths.stateDir, 'state/openclaw.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE clone_destination_rebind_fixture (
        id INTEGER PRIMARY KEY, payload BLOB NOT NULL
      );
      INSERT INTO clone_destination_rebind_fixture (payload) VALUES (zeroblob(8192));
    `);
    database.close();
    if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);

    const observed = await runProtocol(harness, staged.txId, null, {
      action: 'apply', cloneWriteFaultAfterBytes: 128, replaceClonePartialOnFault: true,
    });
    expect(observed.attacked).toBe(true);
    expect(observed.attackDetails).toMatchObject({
      kind: 'clone-mid-write-replacement', partialBytes: 128,
    });
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    const held = observed.attackDetails.heldPartial as string;
    const replacement = observed.attackDetails.replacement as string;
    expect(fs.existsSync(held)).toBe(true);
    expect(fs.readFileSync(replacement, 'utf8')).toBe('ATTACKER_CLONE_REPLACEMENT\n');
    expect(treeSnapshot(replacement)).toMatchObject(observed.attackDetails.replacementIdentity);
    expect(qArtifacts(harness)).toEqual([]);

    const stableWorld = qWorld(harness, staged.txId, [held]);
    const operations: Array<() => unknown | Promise<unknown>> = [
      () => applier.profileStatus(harness.paths),
      () => stage(harness),
      () => applier.applyProfile({ ...harness.paths, txId: staged.txId }),
      () => applier.rollbackProfile({ ...harness.paths, txId: staged.txId }),
      () => applier.recoverProfiles(harness.paths),
    ];
    for (const operation of operations) {
      const failure = await capturedFailure(operation);
      expect(failure).toMatchObject({ code: observed.result.code });
      expect(qWorld(harness, staged.txId, [held])).toEqual(stableWorld);
      expect(fs.readFileSync(replacement, 'utf8')).toBe('ATTACKER_CLONE_REPLACEMENT\n');
    }
  }, 60_000);

  it.each(['root', 'state'] as const)(
    'never broad-removes a rebound clone %s after a copy fault',
    async (scope) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const databasePath = path.join(harness.paths.stateDir, 'state/openclaw.sqlite');
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      const database = new Database(databasePath);
      database.exec(`
        CREATE TABLE clone_rebind_fixture (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
        INSERT INTO clone_rebind_fixture (payload) VALUES (zeroblob(8192));
      `);
      database.close();
      if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);
      const liveBefore = treeSnapshot(databasePath);

      const observed = await runProtocol(harness, staged.txId, null, {
        action: 'apply',
        cloneWriteFaultAfterBytes: 128,
        rebindCloneHierarchyOnFault: scope,
      });
      expect(observed.attacked).toBe(true);
      expect(observed.attackDetails).toMatchObject({
        kind: `clone-${scope}-rebind-after-copy-fault`, scope,
      });
      expect(observed.result).toMatchObject({
        ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
      });
      expect(treeSnapshot(databasePath)).toEqual(liveBefore);
      const held = observed.attackDetails.held as string;
      const replacementTarget = observed.attackDetails.replacementTarget as string;
      expect(fs.readFileSync(replacementTarget, 'utf8'))
        .toBe('ATTACKER_CLONE_HIERARCHY_REPLACEMENT\n');
      expect(fs.existsSync(observed.attackDetails.heldPartial)).toBe(true);
      if (scope === 'root') {
        expect(observed.attackDetails.replacementRootIdentity)
          .not.toEqual(observed.attackDetails.originalRootIdentity);
      } else {
        expect(observed.attackDetails.replacementRootIdentity)
          .toEqual(observed.attackDetails.originalRootIdentity);
        expect(observed.attackDetails.replacementStateIdentity)
          .not.toEqual(observed.attackDetails.originalStateIdentity);
      }
      const transaction = qPaths(harness, staged.txId, crypto.randomUUID()).transaction;
      expect(JSON.parse(fs.readFileSync(path.join(transaction, 'manifest.json'), 'utf8')).state)
        .toBe('preparing');
      expect(qArtifacts(harness)).toEqual([]);

      const stableWorld = qWorld(harness, staged.txId, [held]);
      const operations: Array<() => unknown | Promise<unknown>> = [
        () => applier.profileStatus(harness.paths),
        () => stage(harness),
        () => applier.applyProfile({ ...harness.paths, txId: staged.txId }),
        () => applier.rollbackProfile({ ...harness.paths, txId: staged.txId }),
        () => applier.recoverProfiles(harness.paths),
      ];
      for (const operation of operations) {
        const failure = await capturedFailure(operation);
        expect(failure).toMatchObject({ code: observed.result.code });
        expect(qWorld(harness, staged.txId, [held])).toEqual(stableWorld);
        expect(fs.readFileSync(replacementTarget, 'utf8'))
          .toBe('ATTACKER_CLONE_HIERARCHY_REPLACEMENT\n');
        expect(qArtifacts(harness)).toEqual([]);
      }
    },
    60_000,
  );

  it.each(['directory', 'file', 'symlink'] as const)(
    'preserves a pre-existing clone %s collision and its external sentinel',
    async (kind) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const clone = path.join(
        qPaths(harness, staged.txId, crypto.randomUUID()).transaction,
        'cron-clone',
      );
      const external = path.join(harness.root, `clone-collision-external-${kind}`);
      fs.mkdirSync(external, { mode: 0o700 });
      fs.writeFileSync(path.join(external, 'external-sentinel'), 'PRESERVE_EXTERNAL\n', {
        flag: 'wx', mode: 0o600,
      });
      if (kind === 'directory') {
        fs.mkdirSync(clone, { mode: 0o700 });
        fs.writeFileSync(path.join(clone, 'collision-sentinel'), 'PRESERVE_DIRECTORY\n', {
          flag: 'wx', mode: 0o600,
        });
      } else if (kind === 'file') {
        fs.writeFileSync(clone, 'PRESERVE_FILE_COLLISION\n', { flag: 'wx', mode: 0o600 });
      } else {
        fs.symlinkSync(external, clone, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const beforeClone = treeSnapshot(clone);
      const beforeExternal = treeSnapshot(external);
      const failure = await capturedFailure(
        () => applier.__testing.inspectCronState(harness.paths, staged.txId),
      );
      expect(failure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
      expect(treeSnapshot(clone)).toEqual(beforeClone);
      expect(treeSnapshot(external)).toEqual(beforeExternal);
      expect(qArtifacts(harness)).toEqual([]);
    },
    30_000,
  );

  it('preserves held and replacement clone roots when the captured root is rebound after state mkdir', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const observed = await runProtocol(harness, staged.txId, null, {
      action: 'clone', attack: 'rebind-clone-root-after-state-mkdir',
    });
    expect(observed.attacked).toBe(true);
    expect(observed.attackDetails).toMatchObject({ kind: 'clone-root-rebind' });
    expect(observed.attackDetails.sourceAfter).not.toEqual(observed.attackDetails.sourceBefore);
    expect(observed.attackDetails.stateAfter).not.toEqual(observed.attackDetails.stateBefore);
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    const heldRoot = observed.attackDetails.heldRoot as string;
    const replacementRoot = observed.attackDetails.replacementRoot as string;
    expect(fs.readFileSync(path.join(replacementRoot, 'openclaw.json'), 'utf8'))
      .toBe('ATTACKER_OPENCLAW_SENTINEL\n');
    expect(treeSnapshot(heldRoot)).not.toBeNull();
    expect(treeSnapshot(replacementRoot)).not.toBeNull();
    expect(cleanupArtifactsUnder(heldRoot)).toEqual([]);
    expect(qArtifacts(harness)).toEqual([]);

    await assertStatusAndRecoveryRejectZeroWrite(
      harness, staged.txId, [heldRoot], 'CRON_WORKER_LIFECYCLE_INVALID',
    );
    expect(cleanupArtifactsUnder(heldRoot)).toEqual([]);
    expect(qArtifacts(harness)).toEqual([]);
  }, 45_000);

  it('rejects clone cleanup after captured clone is reparented under a replacement tx root', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const transaction = qPaths(harness, staged.txId, crypto.randomUUID()).transaction;
    const clone = path.join(transaction, 'cron-clone');
    const observed = await runProtocol(harness, staged.txId, null, {
      action: 'clone', attack: 'reparent-clone-after-capture',
    });
    expect(observed.attacked).toBe(true);
    expect(observed.capturedReparent.sourceAfter).toEqual(
      observed.capturedReparent.sourceBefore,
    );
    expect(observed.capturedReparent.parentAfter).not.toEqual(
      observed.capturedReparent.parentBefore,
    );
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    expect(fs.existsSync(observed.capturedReparent.heldParent)).toBe(true);
    expect(fs.existsSync(clone)).toBe(true);
    expect(fs.readFileSync(path.join(transaction, 'attacker-parent-sentinel'), 'utf8'))
      .toBe('CAPTURED_PARENT_REBOUND\n');
    expect(qArtifacts(harness)).toEqual([]);
    expect(cleanupArtifactsUnder(observed.capturedReparent.heldParent)).toEqual([]);
    await assertStatusAndRecoveryRejectZeroWrite(
      harness,
      staged.txId,
      [observed.capturedReparent.heldParent],
      'CRON_WORKER_LIFECYCLE_INVALID',
    );
  }, 45_000);

  it('rescans the full batch after A and makes no next mutation when a second artifact turns stale', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const staleEpoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const stale = invalidInventoryArtifact(harness, staged.txId, staleEpoch);
    let injected = false;
    let atBarrier: any;
    const failure = await capturedFailure(() => {
      applier.__testing.runCronScratchCleanupProbe(
        harness.paths,
        staged.txId,
        epoch,
        (phase: string) => {
          if (phase !== 'intent-container-created' || injected) return;
          injected = true;
          fs.writeFileSync(stale, '{}\n', { flag: 'wx', mode: 0o600 });
          atBarrier = qWorld(harness, staged.txId);
        },
      );
    });
    expect(injected).toBe(true);
    expect(failure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(fs.existsSync(files.authority)).toBe(true);
    expect(fs.existsSync(layerFile(harness, staged.txId, epoch, 'intent'))).toBe(false);
    expect(qWorld(harness, staged.txId)).toEqual(atBarrier);
    const recoveryFailure = await capturedFailure(() => applier.recoverProfiles(harness.paths));
    expect(recoveryFailure).toMatchObject({ code: 'CRON_WORKER_LIFECYCLE_INVALID' });
    expect(qWorld(harness, staged.txId)).toEqual(atBarrier);
  }, 30_000);

  it('keeps exact transaction-parent and Q entries at every public cleanup barrier', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const baseline = fs.readdirSync(files.transaction).sort();
    const transactionNames = (extra: string[]) => [...baseline, ...extra].sort();
    const publicPhases = new Set([
      'created', 'intent-container-created', 'identity-checked',
      'source-renamed', 'quarantined', 'removed',
    ]);
    const seen: string[] = [];
    applier.__testing.runCronScratchCleanupProbe(
      harness.paths,
      staged.txId,
      epoch,
      (phase: string, context: any) => {
        if (!publicPhases.has(phase)) return;
        seen.push(phase);
        const r = path.basename(files.reservation);
        const a = path.basename(files.authority);
        const sourceName = path.basename(files.source);
        if (phase === 'created') {
          expect(fs.readdirSync(files.transaction).sort()).toEqual(transactionNames([sourceName]));
          expect(fs.existsSync(files.quarantine)).toBe(false);
        } else if (['intent-container-created', 'identity-checked'].includes(phase)) {
          const i = path.basename(requiredPath(files.inventory, 'inventory final'));
          expect(fs.readdirSync(files.transaction).sort()).toEqual(
            transactionNames([sourceName, i, r, a]),
          );
          expect(fs.readdirSync(files.quarantine)).toEqual([path.basename(context.quarantine)]);
          expect(fs.readdirSync(context.quarantine).sort()).toEqual(
            phase === 'intent-container-created' ? [] : ['intent.json'],
          );
        } else if (['source-renamed', 'quarantined'].includes(phase)) {
          const i = path.basename(requiredPath(files.inventory, 'inventory final'));
          expect(fs.readdirSync(files.transaction).sort()).toEqual(transactionNames([i, r, a]));
          expect(fs.readdirSync(context.quarantine).sort()).toEqual(['intent.json', 'payload']);
        } else if (phase === 'removed') {
          expect(fs.readdirSync(files.transaction).sort()).toEqual(baseline);
          expect(fs.readdirSync(files.quarantine)).toEqual([]);
        }
      },
    );
    expect(seen).toEqual([
      'created', 'intent-container-created', 'identity-checked',
      'source-renamed', 'quarantined', 'removed',
    ]);
  }, 30_000);

  it('rejects the exact 701-entry nonlinear-validation counterexample before I publication', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const running = startProtocol(harness, staged.txId, epoch, {
      action: 'cleanup', reviewerCounterexample701: true,
    });
    const startedAt = Date.now();
    let observed: any;
    try {
      observed = await waitForReady(running);
    } finally {
      await stopProtocol(running);
    }
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(observed).toMatchObject({
      populatedFiles: 699,
      populatedBytes: 0,
      result: { ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID' },
    });
    expect(fs.existsSync(files.source)).toBe(true);
    expect(fs.readdirSync(files.source).filter((name) => name.startsWith('review-root-')))
      .toHaveLength(350);
    expect(fs.readdirSync(path.join(files.source, 'tmp'))
      .filter((name) => name.startsWith('review-child-'))).toHaveLength(349);
    expect(files.inventory).toBeNull();
    expect(files.inventoryStaging).toBeNull();
    expect(observed.namespaceEvents.filter((event: any) => event.layer === 'inventory'))
      .toEqual([]);
    expect(qArtifacts(harness)).toEqual([]);
  }, 30_000);

  it.each([
    { boundary: 'hashBytes', files: 31, bytes: 2 * 1024 * 1024 },
  ])(
    'rejects projected $boundary work before publishing I or moving scratch',
    async ({ files: count, bytes }) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const epoch = crypto.randomUUID();
      const q = qPaths(harness, staged.txId, epoch);
      const observed = await runProtocol(harness, staged.txId, epoch, {
        action: 'cleanup', populateFiles: count, populateBytes: bytes,
      });
      expect(observed).toMatchObject({
        populatedFiles: count,
        populatedBytes: count * bytes,
      });
      expect(observed.result).toMatchObject({
        ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
      });
      expect(fs.existsSync(q.source)).toBe(true);
      expect(q.inventory).toBeNull();
      expect(q.inventoryStaging).toBeNull();
      expect(qArtifacts(harness)).toEqual([]);
    },
    45_000,
  );

  it('charges long canonical inventory control bytes before any source topology syscall', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const synthetic = writeLongControlInventory(harness, staged.txId, epoch);
    expect(synthetic.entries).toBe(100);
    expect(synthetic.inventoryBytes).toBeGreaterThan(46_080);
    expect(synthetic.inventoryBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(synthetic.pathBytes).toBeLessThanOrEqual(1024 * 1024);
    const ownScanWeight = 3 * synthetic.entries + 64;
    expect(synthetic.inventoryBytes * ownScanWeight * 64).toBeGreaterThan(1024 ** 3);
    expect(fs.existsSync(files.source)).toBe(false);
    const before = qWorld(harness, staged.txId);
    let expectedCode: string | undefined;
    for (const action of ['status', 'recover'] as const) {
      const observed = await runProtocol(harness, staged.txId, epoch, {
        action, watchPath: files.source,
      });
      expect(observed.result).toMatchObject({
        ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
      });
      expectedCode ??= observed.result.code;
      expect(observed.result.code).toBe(expectedCode);
      expect(observed.watchCounts).toEqual(ZERO_WATCH_COUNTS);
      expect(observed.namespaceEvents).toEqual([]);
      expect(fs.existsSync(files.reservation)).toBe(false);
      expect(fs.existsSync(files.reservationStaging)).toBe(false);
      expect(fs.existsSync(files.quarantine)).toBe(false);
      expect(qWorld(harness, staged.txId)).toEqual(before);
    }
  }, 45_000);

  it('accounts for cross-artifact rescans before either cleanup can mutate', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const bytesPerArtifact = 8 * 1024 * 1024;
    const firstEpoch = crypto.randomUUID();
    const secondEpoch = crypto.randomUUID();
    const first = writeSyntheticInventory(
      harness, staged.txId, firstEpoch, bytesPerArtifact,
    );
    const second = writeSyntheticInventory(
      harness, staged.txId, secondEpoch, bytesPerArtifact,
    );
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
    const ownFileVisits = 1 * 3 + 64;
    const ownScanWeight = 2 * 3 + 64;
    expect(bytesPerArtifact * ownFileVisits).toBeLessThan(1024 ** 3);
    expect(2 * bytesPerArtifact * (ownFileVisits + ownScanWeight))
      .toBeGreaterThan(2 * 1024 ** 3);
    const before = qWorld(harness, staged.txId);
    let expectedCode: string | undefined;
    for (const action of ['status', 'recover'] as const) {
      const observed = await runProtocol(harness, staged.txId, firstEpoch, { action });
      expect(observed.result).toMatchObject({
        ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
      });
      expectedCode ??= observed.result.code;
      expect(observed.result.code).toBe(expectedCode);
      expect(observed.namespaceEvents).toEqual([]);
      expect(qWorld(harness, staged.txId)).toEqual(before);
    }
  }, 45_000);

  it('streams the shared transaction-root budget and stops exactly at top-level name 8193', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const transaction = qPaths(harness, staged.txId, crypto.randomUUID()).transaction;
    for (let index = 0; index < 8_300; index += 1) {
      fs.writeFileSync(
        path.join(transaction, `non-q-entry-${String(index).padStart(5, '0')}`),
        '',
        { flag: 'wx', mode: 0o600 },
      );
    }
    const before = qWorld(harness, staged.txId);
    const observed = await runProtocol(harness, staged.txId, null, {
      action: 'status', auditArtifactEnumeration: true,
    });
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    expect(observed.batchTopLevelNamesEnumerated).toBe(8_193);
    expect(observed.batchReaddirNamesEnumerated).toBe(0);
    expect(qWorld(harness, staged.txId)).toEqual(before);
    const recoveryFailure = await capturedFailure(() => applier.recoverProfiles(harness.paths));
    expect(recoveryFailure).toMatchObject({ code: observed.result.code });
    expect(qWorld(harness, staged.txId)).toEqual(before);
  }, 60_000);

  it('streams source names and stops on node 4097 without materializing the directory', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const observed = await runProtocol(harness, staged.txId, epoch, {
      action: 'cleanup', populateSourceNames: 5_000,
    });
    expect(observed).toMatchObject({
      populatedFiles: 5_000,
      populatedBytes: 0,
      result: { ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID' },
    });
    expect(observed.sourceNamesEnumerated).toBe(4_096);
    expect(observed.sourceReaddirNamesEnumerated).toBe(0);
    expect(fs.existsSync(files.source)).toBe(true);
    expect(fs.readdirSync(files.source).filter((name) => name.startsWith('stream-')))
      .toHaveLength(5_000);
    expect(files.inventory).toBeNull();
    expect(files.inventoryStaging).toBeNull();
    expect(qArtifacts(harness)).toEqual([]);
  }, 60_000);

  it('stops streamed artifact discovery at the third unique cleanup group', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const files = qPaths(harness, staged.txId, crypto.randomUUID());
    for (let index = 0; index < 64; index += 1) {
      const epoch = crypto.randomUUID();
      const bytes = canonicalBytes({ index });
      const anchor = sha256(bytes);
      fs.writeFileSync(path.join(
        files.transaction,
        `cron-worker-cleanup-inventory-scratch-${epoch}-${anchor}.json`,
      ), bytes, { flag: 'wx', mode: 0o600 });
    }
    const before = qWorld(harness, staged.txId);
    const observed = await runProtocol(harness, staged.txId, null, {
      action: 'status', auditArtifactEnumeration: true,
    });
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    expect(observed.cleanupNamesEnumerated).toBe(3);
    expect(observed.transactionReaddirCleanupNames).toBe(0);
    expect(qWorld(harness, staged.txId)).toEqual(before);
  }, 30_000);

  it('rejects an unknown direct sibling injected at before-entry-delete without deleting the target', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const observed = await runProtocol(harness, staged.txId, epoch, {
      action: 'cleanup',
      populateFiles: 1,
      attack: 'inject-unknown-sibling-before-entry-delete',
    });
    expect(observed.attacked).toBe(true);
    expect(observed.attackDetails).toMatchObject({ kind: 'unknown-payload-sibling' });
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    const target = observed.attackDetails.target as string;
    const unknown = observed.attackDetails.unknown as string;
    const targetMetadata = fs.lstatSync(target);
    expect({
      dev: String(targetMetadata.dev),
      ino: String(targetMetadata.ino),
      nlink: targetMetadata.nlink,
      size: targetMetadata.size,
    }).toEqual(observed.attackDetails.targetIdentity);
    expect(fs.readFileSync(unknown, 'utf8')).toBe('ATTACKER_UNKNOWN_SIBLING\n');
    const container = path.dirname(path.dirname(target));
    expect(fs.readdirSync(container).filter((name) => name.includes('incident'))).toEqual([]);
    await assertStatusAndRecoveryRejectZeroWrite(harness, staged.txId);
  }, 45_000);

  it('continues safely after a payload unlink crash before its parent fsync', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const running = startProtocol(harness, staged.txId, epoch, {
      action: 'cleanup', populateFiles: 1, pauseAfterEntryDeleteBeforeFsync: true,
    });
    let observed: any;
    try {
      observed = await waitForReady(running);
    } finally {
      await stopProtocol(running);
    }
    expect(observed).toMatchObject({
      event: 'after-entry-delete-before-fsync',
      targetPresent: false,
    });
    expect(fs.existsSync(observed.target)).toBe(false);
    await assertStatusRejectsZeroWrite(harness, staged.txId);
    await applier.recoverProfiles(harness.paths);
    expect(fs.existsSync(observed.target)).toBe(false);
    expect(qArtifacts(harness)).toEqual([]);
  }, 45_000);

  it.each([
    { cut: 1, prefix: ['rename'] },
    { cut: 2, prefix: ['rename', 'destination-container-fsync'] },
    { cut: 3, prefix: ['rename', 'destination-container-fsync', 'source-parent-fsync'] },
  ])(
    'recovers rename durability cut $cut with exact destination-before-source fsync prefix',
    async ({ cut, prefix }) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const epoch = crypto.randomUUID();
      const files = qPaths(harness, staged.txId, epoch);
      const running = startProtocol(harness, staged.txId, epoch, {
        action: 'cleanup', renameCut: cut,
      });
      let observed: any;
      try {
        observed = await waitForReady(running);
      } finally {
        await stopProtocol(running);
      }
      expect(observed.eventPrefix).toEqual(prefix);
      const reservation = JSON.parse(fs.readFileSync(files.reservation, 'utf8'));
      const payload = path.join(files.quarantine, reservation.container, 'payload');
      expect(fs.existsSync(files.source)).toBe(false);
      expect(fs.existsSync(payload)).toBe(true);
      expect(fs.existsSync(files.deleteAuthority)).toBe(false);
      await assertStatusRejectsZeroWrite(harness, staged.txId);
      const recovery = startProtocol(harness, staged.txId, epoch, {
        action: 'recover',
        auditRecoveryBeforeDelete: true,
        pauseBeforeDeleteStaging: true,
      });
      let recoveryBarrier: any;
      try {
        recoveryBarrier = await waitForReady(recovery);
      } finally {
        await stopProtocol(recovery);
      }
      expect(recoveryBarrier).toMatchObject({
        event: 'before-delete-staging-create',
        target: canonicalTestPath(files.deleteAuthorityStaging),
      });
      expect(recoveryBarrier.recoveryDurabilityEvents).toEqual([
        'destination-container-fsync', 'source-parent-fsync',
      ]);
      expect(fs.existsSync(files.deleteAuthorityStaging)).toBe(false);
      await applier.recoverProfiles(harness.paths);
      expect(qArtifacts(harness)).toEqual([]);
    },
    30_000,
  );

  it('rejects same-inode same-length pair tamper before normalize can unlink staging', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const files = qPaths(harness, staged.txId, epoch);
    const crash = startProtocol(harness, staged.txId, epoch, {
      action: 'cleanup',
      pausePublication: { layer: 'authority', stage: 'linked-durable' },
    });
    try {
      expect(await waitForReady(crash)).toMatchObject({
        event: 'publication-linked-durable', layer: 'authority',
      });
    } finally {
      await stopProtocol(crash);
    }
    const beforeIdentity = fs.lstatSync(files.authority);
    expect({ dev: beforeIdentity.dev, ino: beforeIdentity.ino, nlink: beforeIdentity.nlink })
      .toEqual({
        dev: fs.lstatSync(files.authorityStaging).dev,
        ino: fs.lstatSync(files.authorityStaging).ino,
        nlink: 2,
      });

    const observed = await runProtocol(harness, staged.txId, epoch, {
      action: 'recover',
      attack: 'tamper-pair-before-normalize-read',
      tamperPairLayer: 'authority',
    });
    expect(observed.attacked).toBe(true);
    expect(observed.attackDetails).toMatchObject({
      kind: 'same-inode-pair-tamper', layer: 'authority',
    });
    expect(observed.attackDetails.beforeIdentity).toEqual(observed.attackDetails.afterIdentity);
    expect(observed.attackDetails.beforeSha256).not.toBe(observed.attackDetails.afterSha256);
    const tamperedPairBytes = Buffer.from(observed.attackDetails.bytes, 'base64');
    expect(tamperedPairBytes).toHaveLength(observed.attackDetails.beforeIdentity.size);
    expect(tamperedPairBytes).toEqual(
      canonicalBytes(JSON.parse(tamperedPairBytes.toString('utf8'))),
    );
    expect(observed.result).toMatchObject({
      ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
    });
    expect(observed.namespaceEvents).toEqual([]);
    const finalMetadata = fs.lstatSync(files.authority);
    const stagingMetadata = fs.lstatSync(files.authorityStaging);
    expect({ dev: finalMetadata.dev, ino: finalMetadata.ino, nlink: finalMetadata.nlink })
      .toEqual({ dev: stagingMetadata.dev, ino: stagingMetadata.ino, nlink: 2 });
    expect(fs.readFileSync(files.authority)).toEqual(fs.readFileSync(files.authorityStaging));
    await assertStatusAndRecoveryRejectZeroWrite(harness, staged.txId);
  }, 30_000);

  it.each(PUBLICATION_CRASH_CASES)(
    'recovers the $layer publication $stage crash window from its exact durable shape',
    async ({ layer, stage: publicationStage, shape }) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const epoch = crypto.randomUUID();
      const running = startProtocol(harness, staged.txId, epoch, {
        action: 'cleanup', pausePublication: { layer, stage: publicationStage },
      });
      let observed: any;
      try {
        observed = await waitForReady(running);
      } finally {
        await stopProtocol(running);
      }
      expect(observed.event).toBe(`publication-${publicationStage}`);
      const publicationFiles = layerPublicationFiles(
        harness, staged.txId, epoch, layer,
      );
      const { final, staging: stagingFile } = publicationFiles;
      if (shape === 'staging') {
        expect(fs.existsSync(final)).toBe(false);
        expect(fs.lstatSync(stagingFile).nlink).toBe(1);
      } else if (shape === 'pair') {
        const left = fs.lstatSync(final);
        const right = fs.lstatSync(stagingFile);
        expect({ dev: left.dev, ino: left.ino, nlink: left.nlink })
          .toEqual({ dev: right.dev, ino: right.ino, nlink: 2 });
      } else {
        expect(fs.lstatSync(final).nlink).toBe(1);
        expect(fs.existsSync(stagingFile)).toBe(false);
      }
      await assertStatusRejectsZeroWrite(harness, staged.txId);
      await applier.recoverProfiles(harness.paths);
      expect(qArtifacts(harness)).toEqual([]);
    },
    30_000,
  );

  it.each([
    'inventory', 'reservation', 'authority', 'intent', 'delete-authority', 'done',
  ] as const)(
    'places a fresh full-batch scan between every %s staging-create/link/unlink namespace mutation',
    async (layer) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const epoch = crypto.randomUUID();
      const observed = await runProtocol(harness, staged.txId, epoch, {
        action: 'audit-cleanup',
      });
      expect(observed.result).toEqual({ ok: true });
      const events = observed.namespaceEvents.filter((event: any) => (
        event.layer === layer
          && ['create-staging', 'link-final', 'unlink-staging'].includes(event.operation)
      ));
      expect(events.map((event: any) => event.operation)).toEqual([
        'create-staging', 'link-final', 'unlink-staging',
      ]);
      expect(events[0].generation).toBeGreaterThan(0);
      expect(events[1].generation).toBeGreaterThan(events[0].generation);
      expect(events[2].generation).toBeGreaterThan(events[1].generation);
      expect(qArtifacts(harness)).toEqual([]);
    },
    30_000,
  );

  it('requires a fully drained-and-closed batch scan before every Q namespace mutation', async () => {
    const harness = makeHarness();
    const staged = await stage(harness);
    const epoch = crypto.randomUUID();
    const observed = await runProtocol(harness, staged.txId, epoch, {
      action: 'audit-cleanup', populateFiles: 1,
    });
    expect(observed.result).toEqual({ ok: true });
    expect(observed.scanCloseEvents.length).toBeGreaterThan(0);
    expect(observed.scanCloseEvents.every((event: any) => (
      event.fullyRead === true && event.incremented === true
    ))).toBe(true);
    const completedGenerations = new Set(
      observed.scanCloseEvents.map((event: any) => event.generation),
    );
    const mutations = observed.namespaceEvents as Array<{
      layer: string;
      operation: string;
      generation: number;
      target: string;
    }>;
    expect(mutations.length).toBeGreaterThan(0);
    for (const [index, event] of mutations.entries()) {
      expect(completedGenerations.has(event.generation)).toBe(true);
      expect(event.generation).toBeGreaterThan(index === 0 ? 0 : mutations[index - 1].generation);
    }
    const kinds = mutations.map((event) => `${event.layer}:${event.operation}`);
    for (const layer of [
      'inventory', 'reservation', 'authority', 'intent', 'delete-authority', 'done',
    ]) {
      for (const operation of ['create-staging', 'link-final', 'unlink-staging']) {
        expect(kinds).toContain(`${layer}:${operation}`);
      }
    }
    for (const required of [
      'quarantine-root:mkdir-quarantine-root',
      'container:mkdir-container',
      'payload:rename-source-to-payload',
      'payload:unlink-entry',
      'payload:rmdir-entry',
      'intent:unlink-final',
      'container:rmdir-container',
      'authority:unlink-final',
      'reservation:unlink-final',
      'inventory:unlink-final',
      'delete-authority:unlink-final',
      'done:unlink-final',
    ]) expect(kinds).toContain(required);
    expect(qArtifacts(harness)).toEqual([]);
  }, 45_000);

  it.each([
    { cut: 'authority', remain: ['inventory', 'reservation', 'delete-authority', 'done'] },
    { cut: 'reservation', remain: ['inventory', 'delete-authority', 'done'] },
    { cut: 'inventory', remain: ['delete-authority', 'done'] },
    { cut: 'delete-authority', remain: ['done'] },
    { cut: 'done', remain: [] },
  ] as const)(
    'recovers teardown after durable $cut unlink with frozen remaining records and final zero artifacts',
    async ({ cut, remain }) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const epoch = crypto.randomUUID();
      await createDoneResidue(harness, staged.txId, epoch);
      const running = startProtocol(harness, staged.txId, epoch, {
        action: 'recover', pauseTeardownAfter: cut,
      });
      let observed: any;
      try {
        observed = await waitForReady(running);
      } finally {
        await stopProtocol(running);
      }
      expect(observed).toMatchObject({ event: 'teardown-unlink-durable', layer: cut });
      const doneBytes = Buffer.from(observed.before['done.json'].bytes, 'base64');
      const done = JSON.parse(doneBytes.toString('utf8'));
      const embedded: Record<string, unknown> = {
        inventory: done.inventory,
        reservation: done.reservation,
        authority: done.authority,
        'delete-authority': done.deleteAuthority,
        done,
      };
      expect(Object.keys(observed.frozen).sort()).toEqual(
        remain.map((layer) => `${layer}.json`).sort(),
      );
      for (const layer of remain) {
        expect(Buffer.from(observed.frozen[`${layer}.json`].bytes, 'base64'))
          .toEqual(canonicalBytes(embedded[layer]));
      }
      if (remain.length > 0) {
        await assertStatusRejectsZeroWrite(harness, staged.txId);
      } else {
        const before = qWorld(harness, staged.txId);
        expect(await capturedFailure(() => applier.profileStatus(harness.paths))).toBeUndefined();
        expect(qWorld(harness, staged.txId)).toEqual(before);
      }
      await applier.recoverProfiles(harness.paths);
      expect(qArtifacts(harness)).toEqual([]);
    },
    30_000,
  );

  it.each([
    'replace-authority-before-teardown-read',
    'tamper-authority-before-teardown-read',
    'recreate-authority-after-unlink',
  ] as const)(
    'rejects teardown frozen-record attack %s before a second namespace mutation',
    async (attack) => {
      const harness = makeHarness();
      const staged = await stage(harness);
      const epoch = crypto.randomUUID();
      await createDoneResidue(harness, staged.txId, epoch);
      const files = qPaths(harness, staged.txId, epoch);
      const observed = await runProtocol(harness, staged.txId, epoch, {
        action: 'recover', attack,
      });
      expect(observed.attacked).toBe(true);
      expect(observed.result).toMatchObject({
        ok: false, code: 'CRON_WORKER_LIFECYCLE_INVALID',
      });
      for (const file of [
        requiredPath(files.inventory, 'inventory final'),
        files.reservation, files.authority, files.deleteAuthority, files.done,
      ]) expect(fs.existsSync(file)).toBe(true);
      const current = Object.fromEntries(Object.entries(observed.attackSnapshot).map(
        ([name, rawRecord]) => {
          const record = rawRecord as any;
          return [name, {
            ...record,
            dev: String(fs.lstatSync(record.path).dev),
            ino: String(fs.lstatSync(record.path).ino),
            nlink: fs.lstatSync(record.path).nlink,
            size: fs.lstatSync(record.path).size,
            bytes: fs.readFileSync(record.path).toString('base64'),
          }];
        },
      ));
      expect(current).toEqual(observed.attackSnapshot);
      if (attack === 'replace-authority-before-teardown-read') {
        expect(canonicalTestPath(observed.heldFile).startsWith(
          `${canonicalTestPath(files.transaction)}${path.sep}`,
        ))
          .toBe(false);
        expect(path.basename(observed.heldFile).startsWith('cron-worker-cleanup-')).toBe(false);
        expect(fs.readFileSync(observed.heldFile))
          .toEqual(fs.readFileSync(files.authority));
        expect(observed.namespaceEvents).toEqual([]);
      } else if (attack === 'tamper-authority-before-teardown-read') {
        expect(observed.attackDetails).toMatchObject({ kind: 'same-inode-teardown-tamper' });
        expect(observed.attackDetails.beforeIdentity).toEqual(
          observed.attackDetails.afterIdentity,
        );
        expect(observed.attackDetails.beforeSha256).not.toBe(
          observed.attackDetails.afterSha256,
        );
        const tamperedBytes = Buffer.from(observed.attackDetails.bytes, 'base64');
        expect(tamperedBytes).toHaveLength(observed.attackDetails.beforeIdentity.size);
        expect(tamperedBytes).toEqual(
          canonicalBytes(JSON.parse(tamperedBytes.toString('utf8'))),
        );
        expect(observed.namespaceEvents).toEqual([]);
        await assertStatusAndRecoveryRejectZeroWrite(harness, staged.txId);
      } else {
        expect(observed.namespaceEvents.map((event: any) => (
          `${event.layer}:${event.operation}`
        ))).toEqual(['authority:unlink-final']);
      }
    },
    30_000,
  );

  it('leaves no Q control or quarantine artifact after a normal verified commit', async () => {
    const harness = makeHarness();
    const staged = await install(harness);
    expect(qArtifacts(harness)).toEqual([]);
    const files = qPaths(harness, staged.txId, crypto.randomUUID());
    expect(fs.existsSync(files.transaction)).toBe(false);
    expect(!fs.existsSync(files.quarantine) || fs.readdirSync(files.quarantine).length === 0)
      .toBe(true);
  }, 60_000);
});
