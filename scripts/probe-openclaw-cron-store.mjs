#!/usr/bin/env node

/**
 * OpenClaw 2026.6.1 cron persistence contract probe.
 *
 * This is deliberately a subprocess probe. Each worker receives an isolated
 * HOME and OPENCLAW_STATE_DIR, so the real OpenClaw plugin SDK can open and
 * close its canonical state database without sharing the caller's module or
 * SQLite caches. No network or Gateway is used.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const require = createRequire(import.meta.url);
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(ROOT, 'extensions', 'research-claw-core'), ROOT],
}));
const ASYNC_WORKER_TIMEOUT_MS = 15_000;
const WORKER_TERM_GRACE_MS = 750;
const WORKER_KILL_GRACE_MS = 2_000;
const asyncWorkers = new Set();
let receivedSignal = null;
let rejectSignalAbort;
const signalAbort = new Promise((_, reject) => { rejectSignalAbort = reject; });
// A signal may arrive between synchronous probe sections. Keep the rejection
// handled until the next abortable await races it.
signalAbort.catch(() => {});

class ProbeSignalError extends Error {
  constructor(signal) {
    super(`cron probe interrupted by ${signal}`);
    this.name = 'ProbeSignalError';
    this.signal = signal;
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function job(id, sessionKey, name = id) {
  return {
    id,
    ...(sessionKey ? { sessionKey } : {}),
    name,
    enabled: true,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    schedule: { kind: 'cron', expr: '0 8 * * *' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: `fake probe job ${id}` },
    delivery: { mode: 'none' },
    state: {},
  };
}

function portableMode(stat) {
  // Windows does not expose restorable POSIX permission bits. Type, bytes,
  // link targets and directory presence are still exact there; mode equality
  // is explicitly conditional in the report and test.
  return process.platform === 'win32' ? null : stat.mode & 0o7777;
}

function snapshotTree(root) {
  const snapshot = new Map();
  if (!fs.existsSync(root)) {
    snapshot.set('', { type: 'absent', mode: null });
    return snapshot;
  }

  const capture = (absolute, relative) => {
    const stat = fs.lstatSync(absolute);
    const mode = portableMode(stat);
    if (stat.isDirectory()) {
      snapshot.set(relative, { type: 'directory', mode });
      for (const name of fs.readdirSync(absolute).sort()) {
        capture(path.join(absolute, name), relative ? path.join(relative, name) : name);
      }
      return;
    }
    if (stat.isFile()) {
      snapshot.set(relative, { type: 'file', mode, bytes: fs.readFileSync(absolute) });
      return;
    }
    if (stat.isSymbolicLink()) {
      let linkKind = 'file';
      try {
        if (fs.statSync(absolute).isDirectory()) linkKind = 'directory';
      } catch {
        // A dangling link is still captured and restored as a link. The target
        // string, rather than its current referent, is the durable preimage.
      }
      snapshot.set(relative, {
        type: 'symlink',
        mode,
        target: fs.readlinkSync(absolute),
        linkKind,
      });
      return;
    }
    throw new Error(`unsupported filesystem entry in cron probe snapshot: ${absolute}`);
  };

  capture(root, '');
  return snapshot;
}

function treeDigest(snapshot) {
  const hash = crypto.createHash('sha256');
  for (const [name, entry] of [...snapshot.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const metadata = JSON.stringify({
      name,
      type: entry.type,
      mode: entry.mode,
      target: entry.target ?? null,
      linkKind: entry.linkKind ?? null,
      byteLength: entry.bytes?.length ?? null,
    });
    hash.update(String(Buffer.byteLength(metadata)));
    hash.update(':');
    hash.update(metadata);
    hash.update(':');
    if (entry.type === 'file') hash.update(entry.bytes);
    hash.update(';');
  }
  return hash.digest('hex');
}

function restoreTree(root, snapshot) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  const rootEntry = snapshot.get('');
  if (!rootEntry || rootEntry.type === 'absent') return;
  if (rootEntry.type !== 'directory') {
    throw new Error(`cron probe snapshot root must be a directory, found ${rootEntry.type}`);
  }

  const entries = [...snapshot.entries()];
  const directories = entries
    .filter(([, entry]) => entry.type === 'directory')
    .sort(([a], [b]) => a.split(path.sep).length - b.split(path.sep).length);
  for (const [name] of directories) {
    fs.mkdirSync(name ? path.join(root, name) : root, { recursive: true, mode: 0o700 });
  }

  for (const [name, entry] of entries) {
    if (!name || entry.type === 'directory' || entry.type === 'absent') continue;
    const absolute = path.join(root, name);
    if (entry.type === 'file') {
      fs.writeFileSync(absolute, entry.bytes, { mode: entry.mode ?? 0o600 });
      if (entry.mode !== null) fs.chmodSync(absolute, entry.mode);
      continue;
    }
    if (entry.type === 'symlink') {
      if (process.platform === 'win32' && entry.linkKind !== 'directory') {
        throw new Error('Windows cron probe snapshots require directory junctions for privilege-free restore');
      }
      const linkType = process.platform === 'win32'
        ? 'junction'
        : entry.linkKind === 'directory' ? 'dir' : 'file';
      fs.symlinkSync(entry.target, absolute, linkType);
      // Unix symlink permissions are normally fixed at 0777. lchmod is only
      // available on a subset of platforms, so use it when the platform offers
      // a meaningful, supported implementation.
      if (entry.mode !== null && typeof fs.lchmodSync === 'function') {
        try { fs.lchmodSync(absolute, entry.mode); } catch (error) {
          if (!['ENOSYS', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
        }
      }
    }
  }

  // Apply directory modes last so a read-only parent cannot prevent child
  // restoration. On Windows, mode is intentionally not part of exactness.
  for (const [name, entry] of [...directories].reverse()) {
    if (entry.mode !== null) fs.chmodSync(name ? path.join(root, name) : root, entry.mode);
  }
}

function snapshotCoverage(snapshot) {
  const entries = [...snapshot.entries()];
  const types = [...new Set(entries.map(([, entry]) => entry.type))].sort();
  const directoryNames = entries
    .filter(([, entry]) => entry.type === 'directory')
    .map(([name]) => name);
  const emptyDirectoryCount = directoryNames.filter((directory) => {
    const prefix = directory ? `${directory}${path.sep}` : '';
    return !entries.some(([name]) => name !== directory && name.startsWith(prefix)
      && !name.slice(prefix.length).includes(path.sep));
  }).length;
  return {
    entryCount: entries.length,
    types,
    emptyDirectoryCount,
    symlinkCount: entries.filter(([, entry]) => entry.type === 'symlink').length,
    posixModeCompared: process.platform !== 'win32',
  };
}

function combinedStateDigest(dataSnapshot, stateSnapshot) {
  return sha256(Buffer.from(JSON.stringify({
    rcData: treeDigest(dataSnapshot),
    openclawState: treeDigest(stateSnapshot),
  })));
}

function waitForFile(file, timeoutMs = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function minimalParentEnv() {
  const env = {};
  // These variables are runtime/OS necessities, not application state. Do not
  // inherit proxies, credentials, Node options, npm config, or any OPENCLAW_*/
  // RC_* value from the caller.
  const keys = process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']
    : ['PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];
  for (const key of keys) {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function workerEnv(base, extra = {}) {
  for (const key of Object.keys(extra)) {
    if (!key.startsWith('RC_CRON_PROBE_')) {
      throw new Error(`refusing non-probe worker environment key: ${key}`);
    }
  }
  return {
    ...minimalParentEnv(),
    HOME: base.home,
    USERPROFILE: base.home,
    ...(process.platform === 'win32' ? {
      APPDATA: path.join(base.home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(base.home, 'AppData', 'Local'),
    } : {}),
    XDG_CONFIG_HOME: path.join(base.home, '.config'),
    XDG_CACHE_HOME: path.join(base.home, '.cache'),
    XDG_DATA_HOME: path.join(base.home, '.local', 'share'),
    XDG_STATE_HOME: path.join(base.home, '.local', 'state'),
    TMPDIR: base.tmp,
    TMP: base.tmp,
    TEMP: base.tmp,
    OPENCLAW_HOME: base.home,
    OPENCLAW_STATE_DIR: base.state,
    OPENCLAW_CONFIG_PATH: path.join(base.state, 'openclaw.json'),
    RC_CRON_PROBE_FIXTURE: base.fixture,
    ...extra,
  };
}

function runWorker(base, action, extra = {}) {
  const result = spawnSync(process.execPath, [SELF, '--worker', action], {
    cwd: ROOT,
    env: workerEnv(base, extra),
    encoding: 'utf8',
    timeout: 40_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cron probe worker ${action} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
  });
}

async function terminateWorker(record) {
  const { child } = record;
  if (child.exitCode !== null || child.signalCode !== null) {
    await record.settled;
    return;
  }
  try { child.kill('SIGTERM'); } catch {}
  let closed = await waitForChildClose(child, WORKER_TERM_GRACE_MS);
  if (!closed) {
    try { child.kill('SIGKILL'); } catch {}
    closed = await waitForChildClose(child, WORKER_KILL_GRACE_MS);
  }
  if (!closed) throw new Error(`cron probe worker ${record.action} did not exit after SIGKILL`);
  await record.settled;
}

async function cleanupAsyncWorkers() {
  await Promise.all([...asyncWorkers].map((record) => terminateWorker(record)));
}

function spawnWorker(base, action, extra = {}, timeoutMs = ASYNC_WORKER_TIMEOUT_MS) {
  const child = spawn(process.execPath, [SELF, '--worker', action], {
    cwd: ROOT,
    env: workerEnv(base, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { action, child, settled: null, timeout: null };
  asyncWorkers.add(record);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('close', (code) => {
      if (record.timeout) clearTimeout(record.timeout);
      if (code !== 0) reject(new Error(
        `cron probe worker ${action} failed (${code ?? child.signalCode}): ${stderr || stdout}`,
      ));
      else resolve(stdout.trim() ? JSON.parse(stdout) : null);
    });
  });
  record.settled = done.then(
    () => undefined,
    () => undefined,
  ).finally(() => asyncWorkers.delete(record));
  record.timeout = setTimeout(() => {
    terminateWorker(record).catch(() => {});
  }, timeoutMs);
  record.timeout.unref?.();
  return { child, done };
}

if (!process.argv.includes('--worker')) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (receivedSignal) return;
      receivedSignal = signal;
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
      rejectSignalAbort(new ProbeSignalError(signal));
      // Do not wait for the next normal await: begin TERM→KILL cleanup now.
      cleanupAsyncWorkers().catch(() => {});
    });
  }
}

function throwIfInterrupted() {
  if (receivedSignal) throw new ProbeSignalError(receivedSignal);
}

async function abortable(promise) {
  throwIfInterrupted();
  return await Promise.race([promise, signalAbort]);
}

async function workerMain(action) {
  const { loadCronStore, resolveCronStorePath, saveCronStore } = await import(
    'openclaw/plugin-sdk/cron-store-runtime'
  );
  const storePath = resolveCronStorePath();
  const fixturePath = process.env.RC_CRON_PROBE_FIXTURE;

  if (action === 'seed') {
    const store = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    await saveCronStore(storePath, store);
    process.stdout.write(`${JSON.stringify({ storePath, jobs: store.jobs.map((item) => item.id) })}\n`);
    return;
  }

  const store = await loadCronStore(storePath);
  if (action === 'read') {
    process.stdout.write(`${JSON.stringify({ storePath, jobs: store.jobs.map((item) => item.id) })}\n`);
    return;
  }

  if (action === 'remove-device') {
    const monitorIds = new Set(JSON.parse(process.env.RC_CRON_PROBE_MONITOR_IDS || '[]'));
    const gatewayIds = new Set(JSON.parse(process.env.RC_CRON_PROBE_GATEWAY_IDS || '[]'));
    const removed = [];
    const nextJobs = store.jobs.filter((item) => {
      const exactSession = typeof item.sessionKey === 'string'
        && item.sessionKey.startsWith('cron:rc-monitor:')
        && monitorIds.has(item.sessionKey.slice('cron:rc-monitor:'.length));
      const exactGatewayId = gatewayIds.has(item.id);
      if (exactSession || exactGatewayId) removed.push(item.id);
      return !exactSession && !exactGatewayId;
    });
    await saveCronStore(storePath, { version: 1, jobs: nextJobs });
    process.stdout.write(`${JSON.stringify({ storePath, removed, jobs: nextJobs.map((item) => item.id) })}\n`);
    return;
  }

  if (action === 'rewrite') {
    await saveCronStore(storePath, store);
    process.stdout.write(`${JSON.stringify({ storePath, jobs: store.jobs.map((item) => item.id) })}\n`);
    return;
  }

  if (action === 'stale-writer') {
    const ready = process.env.RC_CRON_PROBE_READY;
    const go = process.env.RC_CRON_PROBE_GO;
    fs.writeFileSync(ready, 'loaded\n');
    await waitForFile(go);
    await saveCronStore(storePath, store);
    process.stdout.write(`${JSON.stringify({ storePath, jobs: store.jobs.map((item) => item.id) })}\n`);
    return;
  }

  if (action === 'hang') {
    fs.writeFileSync(process.env.RC_CRON_PROBE_READY, 'hanging\n');
    await new Promise(() => { setInterval(() => {}, 1_000); });
    return;
  }

  throw new Error(`unknown cron probe worker action: ${action}`);
}

function makeBase(temp) {
  return {
    root: temp,
    home: path.join(temp, 'home'),
    state: path.join(temp, 'openclaw-state'),
    data: path.join(temp, 'rc-data'),
    tmp: path.join(temp, 'worker-tmp'),
    fixture: path.join(temp, 'fixture.json'),
  };
}

function initializeBase(base) {
  for (const dir of [base.home, base.state, base.data, base.tmp]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

async function signalLifecycleProbeMain() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-oc-cron-probe-signal-'));
  const base = makeBase(temp);
  initializeBase(base);
  const ready = path.join(temp, 'signal-worker.ready');
  try {
    const worker = spawnWorker(base, 'hang', { RC_CRON_PROBE_READY: ready }, 60_000);
    await abortable(waitForFile(ready));
    process.stdout.write(`${JSON.stringify({ ready: true, workerPid: worker.child.pid, temp })}\n`);
    await abortable(new Promise(() => {}));
  } finally {
    try {
      await cleanupAsyncWorkers();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

async function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/openclaw/package.json'), 'utf8'));
  if (packageJson.version !== '2026.6.1') {
    throw new Error(`probe requires locked OpenClaw 2026.6.1, found ${packageJson.version}`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-oc-cron-probe-'));
  const base = makeBase(temp);
  initializeBase(base);

  try {
    const rcDbPath = path.join(base.data, 'library.db');
    const rcDb = new Database(rcDbPath);
    rcDb.pragma('journal_mode = WAL');
    rcDb.pragma('synchronous = FULL');
    rcDb.pragma('busy_timeout = 5000');
    rcDb.exec(`
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const insert = rcDb.prepare(
      'INSERT INTO rc_monitors (id, name, source_type, enabled, gateway_job_id) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('dev-bound', 'Bound camera', 'device', 1, 'job-device-bound');
    insert.run('dev-orphan', 'Orphan camera', 'device', 1, null);
    insert.run('dev-id-only', 'Legacy bound device', 'device', 1, 'job-device-id-only');
    insert.run('feed-monitor', 'Feed', 'feed', 1, 'job-feed');
    rcDb.pragma('wal_checkpoint(TRUNCATE)');
    rcDb.close();

    const jobs = [
      job('job-device-bound', 'cron:rc-monitor:dev-bound'),
      job('job-device-orphan', 'cron:rc-monitor:dev-orphan'),
      job('job-device-duplicate', 'cron:rc-monitor:dev-orphan'),
      job('job-device-id-only', 'agent:main:cron:legacy'),
      job('job-feed', 'cron:rc-monitor:feed-monitor'),
      job('operator-job', 'agent:main:cron:operator'),
      job('job-prefix-trap', 'cron:rc-monitor:dev-bound:suffix'),
      job('job-name-only', undefined, '[rc-monitor] Bound camera'),
    ];
    fs.writeFileSync(base.fixture, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, { mode: 0o600 });

    const seeded = runWorker(base, 'seed');
    const canonicalStateDb = path.join(base.state, 'state', 'openclaw.sqlite');
    const legacyJson = seeded.storePath;
    const sqliteExists = fs.existsSync(canonicalStateDb);
    const jsonExistsAfterSdkSave = fs.existsSync(legacyJson);

    fs.mkdirSync(path.dirname(legacyJson), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacyJson, '{ malformed legacy json', { mode: 0o600 });
    const readThroughSdk = runWorker(base, 'read');

    // Add metadata-sensitive fixtures after OpenClaw has created its durable
    // state. The rollback snapshot must prove more than regular-file bytes.
    const emptyDirectory = path.join(base.state, 'probe-empty-directory');
    fs.mkdirSync(emptyDirectory, { mode: 0o711 });
    const symlinkPath = path.join(base.state, 'probe-link');
    if (process.platform === 'win32') {
      // Directory junctions do not require Windows Developer Mode/admin rights.
      const symlinkTarget = path.join(base.state, 'probe-link-target-directory');
      fs.mkdirSync(symlinkTarget);
      fs.writeFileSync(path.join(symlinkTarget, 'target.txt'), 'cron probe link target\n');
      fs.symlinkSync(symlinkTarget, symlinkPath, 'junction');
    } else {
      const symlinkTarget = path.join(base.state, 'probe-link-target.txt');
      fs.writeFileSync(symlinkTarget, 'cron probe link target\n', { mode: 0o640 });
      fs.symlinkSync(path.basename(symlinkTarget), symlinkPath, 'file');
    }

    const legacyResult = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/reconcile-cron-upgrade.cjs'),
      '--db', rcDbPath,
      '--jobs', legacyJson,
    ], {
      cwd: ROOT,
      env: workerEnv(base),
      encoding: 'utf8',
      timeout: 40_000,
    });
    if (legacyResult.error) throw legacyResult.error;

    const dataBefore = snapshotTree(base.data);
    const stateBefore = snapshotTree(base.state);
    const preimageDigest = combinedStateDigest(dataBefore, stateBefore);
    const snapshotMetadata = {
      rcData: snapshotCoverage(dataBefore),
      openclawState: snapshotCoverage(stateBefore),
    };

    const dbForSelection = new Database(rcDbPath);
    const deviceRows = dbForSelection.prepare(
      "SELECT id, enabled, gateway_job_id FROM rc_monitors WHERE source_type = 'device' ORDER BY id",
    ).all();
    dbForSelection.close();
    const selectorEnv = {
      RC_CRON_PROBE_MONITOR_IDS: JSON.stringify(deviceRows.map((row) => row.id)),
      RC_CRON_PROBE_GATEWAY_IDS: JSON.stringify(
        deviceRows.map((row) => row.gateway_job_id).filter((value) => typeof value === 'string' && value),
      ),
    };
    const removal = runWorker(base, 'remove-device', selectorEnv);

    const dbForDisable = new Database(rcDbPath);
    const disable = dbForDisable.transaction(() => dbForDisable.prepare(
      "UPDATE rc_monitors SET enabled = 0, gateway_job_id = NULL WHERE source_type = 'device'",
    ).run());
    disable();
    dbForDisable.pragma('wal_checkpoint(TRUNCATE)');
    const monitorAfter = dbForDisable.prepare(
      'SELECT id, source_type, enabled, gateway_job_id FROM rc_monitors ORDER BY id',
    ).all();
    dbForDisable.close();
    const afterRemoval = runWorker(base, 'read');

    // The public SDK write is a BEGIN IMMEDIATE SQLite transaction. A second
    // process waits for the database writer instead of observing a partial
    // delete/insert replacement.
    const lockDb = new Database(canonicalStateDb);
    lockDb.pragma('busy_timeout = 5000');
    lockDb.exec('BEGIN IMMEDIATE');
    const lockStarted = Date.now();
    const lockWorker = spawnWorker(base, 'rewrite');
    await abortable(new Promise((resolve) => setTimeout(resolve, 900)));
    lockDb.exec('COMMIT');
    lockDb.close();
    await abortable(lockWorker.done);
    const lockWaitMs = Date.now() - lockStarted;

    // Prove why the pre-start boundary matters: a process that loaded the old
    // store can overwrite a later offline edit with its stale in-memory copy.
    restoreTree(base.data, dataBefore);
    restoreTree(base.state, stateBefore);
    const ready = path.join(temp, 'stale.ready');
    const go = path.join(temp, 'stale.go');
    const staleWorker = spawnWorker(base, 'stale-writer', {
      RC_CRON_PROBE_READY: ready,
      RC_CRON_PROBE_GO: go,
    });
    await abortable(waitForFile(ready));
    runWorker(base, 'remove-device', selectorEnv);
    const whileStalePaused = runWorker(base, 'read');
    fs.writeFileSync(go, 'save\n');
    await abortable(staleWorker.done);
    const afterStaleSave = runWorker(base, 'read');

    restoreTree(base.data, dataBefore);
    restoreTree(base.state, stateBefore);
    const dataAfterRestore = snapshotTree(base.data);
    const stateAfterRestore = snapshotTree(base.state);
    const postRestoreDigest = combinedStateDigest(dataAfterRestore, stateAfterRestore);
    const postRestoreMetadata = {
      rcData: snapshotCoverage(dataAfterRestore),
      openclawState: snapshotCoverage(stateAfterRestore),
    };

    // Exercise, rather than merely inspect, the worker timeout path. The
    // registry must TERM→KILL→wait and leave no live child behind.
    const hangReady = path.join(temp, 'hang.ready');
    const timeoutWorker = spawnWorker(base, 'hang', {
      RC_CRON_PROBE_READY: hangReady,
    }, 300);
    await abortable(waitForFile(hangReady));
    let timeoutError = '';
    try {
      await abortable(timeoutWorker.done);
    } catch (error) {
      timeoutError = error instanceof Error ? error.message : String(error);
    }
    let timeoutWorkerAlive = false;
    try {
      process.kill(timeoutWorker.child.pid, 0);
      timeoutWorkerAlive = true;
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }

    const report = {
      openclawVersion: packageJson.version,
      storePathLabel: legacyJson,
      canonicalBackend: 'sqlite',
      canonicalStateDb,
      sqliteExists,
      jsonExistsAfterSdkSave,
      malformedJsonIgnoredByCanonicalSdk: readThroughSdk.jobs.length === jobs.length,
      legacyJsonReconcilerExitCode: legacyResult.status,
      legacyJsonReconcilerError: `${legacyResult.stderr || ''}${legacyResult.stdout || ''}`.trim(),
      deviceMonitorIds: deviceRows.map((row) => row.id),
      removedJobIds: removal.removed,
      preservedJobIds: afterRemoval.jobs,
      monitorRowsAfterDisable: monitorAfter,
      sqliteWriterWaitMs: lockWaitMs,
      staleWriter: {
        removedBeforeStaleSave: !whileStalePaused.jobs.includes('job-device-bound'),
        resurrectedAfterStaleSave: afterStaleSave.jobs.includes('job-device-bound'),
      },
      workerLifecycle: {
        timeoutObserved: /failed/.test(timeoutError),
        timeoutWorkerAlive,
        registeredWorkersAfterTimeout: asyncWorkers.size,
      },
      rollback: {
        preimageDigest,
        postRestoreDigest,
        byteExact: preimageDigest === postRestoreDigest,
        semantics: process.platform === 'win32'
          ? 'type-content-symlink-target-empty-directory-exact; POSIX mode not meaningful on Windows'
          : 'type-content-mode-symlink-target-empty-directory-exact',
        snapshotMetadata,
        postRestoreMetadata,
      },
    };

    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    try {
      await cleanupAsyncWorkers();
    } finally {
      if (!process.argv.includes('--keep')) fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

const workerIndex = process.argv.indexOf('--worker');
if (workerIndex >= 0) {
  await workerMain(process.argv[workerIndex + 1]);
} else {
  try {
    if (process.argv.includes('--signal-lifecycle-probe')) await signalLifecycleProbeMain();
    else await main();
  } catch (error) {
    if (error instanceof ProbeSignalError) {
      process.exitCode = error.signal === 'SIGINT' ? 130 : 143;
      process.stderr.write(`${error.message}\n`);
    } else {
      throw error;
    }
  }
}
