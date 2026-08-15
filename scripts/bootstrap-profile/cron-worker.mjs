#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jobsDigest } = require('./cron-digest.cjs');
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail() {
  throw new Error('Bootstrap cron worker failed');
}

function verifyAndCheckpointStateDatabase(stateDir) {
  const databasePath = path.join(stateDir, 'state/openclaw.sqlite');
  const Database = require('better-sqlite3');
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    const checked = database.pragma('quick_check');
    if (checked?.[0]?.quick_check !== 'ok') fail();
    const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)');
    if (!Array.isArray(checkpoint) || checkpoint.some((row) => row.busy !== 0)) fail();
  } finally {
    database.close();
  }
}

function lifecycleFileIdentity(file) {
  const metadata = fs.lstatSync(file, { bigint: true });
  const mode = process.platform === 'win32' ? null : Number(metadata.mode & 0o7777n);
  const uid = Number(metadata.uid);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1n
      || (process.platform !== 'win32' && (mode !== 0o600
        || (typeof process.getuid === 'function' && uid !== process.getuid())))) fail();
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    nlink: metadata.nlink.toString(),
    mode,
    uid,
  };
}

function sameLifecycleFileIdentity(identity) {
  try {
    const observed = lifecycleFileIdentity(identity.file);
    return observed.dev === identity.dev && observed.ino === identity.ino
      && observed.nlink === '1' && observed.mode === identity.mode
      && observed.uid === identity.uid;
  } catch {
    return false;
  }
}

function parseLifecycle(argv, action) {
  const lifecycleIndex = argv.indexOf('--lifecycle');
  const txIndex = argv.indexOf('--tx-id');
  const epochIndex = argv.indexOf('--epoch');
  const devIndex = argv.indexOf('--lifecycle-dev');
  const inoIndex = argv.indexOf('--lifecycle-ino');
  if ([lifecycleIndex, txIndex, epochIndex, devIndex, inoIndex].every((index) => index < 0)) {
    return null;
  }
  if (action !== 'compare-and-replace' || lifecycleIndex < 0 || txIndex < 0 || epochIndex < 0
      || devIndex < 0 || inoIndex < 0
      || !path.isAbsolute(argv[lifecycleIndex + 1] ?? '')
      || !/^tx-[0-9a-f-]{36}$/.test(argv[txIndex + 1] ?? '')
      || !UUID.test(argv[epochIndex + 1] ?? '')
      || !/^\d+$/.test(argv[devIndex + 1] ?? '')
      || !/^\d+$/.test(argv[inoIndex + 1] ?? '')) fail();
  const lifecycle = path.normalize(argv[lifecycleIndex + 1]);
  const observed = lifecycleFileIdentity(lifecycle);
  if (observed.dev !== argv[devIndex + 1] || observed.ino !== argv[inoIndex + 1]) fail();
  return {
    file: lifecycle,
    txId: argv[txIndex + 1],
    epoch: argv[epochIndex + 1],
    dev: observed.dev,
    ino: observed.ino,
    nlink: observed.nlink,
    mode: observed.mode,
    uid: observed.uid,
  };
}

function openLifecycle(identity) {
  if (!identity) return null;
  const Database = require('better-sqlite3');
  const database = new Database(identity.file, { fileMustExist: true, timeout: 30_000 });
  if (!sameLifecycleFileIdentity(identity)) {
    database.close();
    fail();
  }
  const row = database.prepare(
    'SELECT version, tx_id AS txId, epoch, state, authority FROM rc_cron_worker_epoch WHERE singleton = 1',
  ).get();
  let authority;
  try { authority = JSON.parse(row?.authority); } catch { fail(); }
  if (!row || row.version !== 1 || row.txId !== identity.txId
      || row.epoch !== identity.epoch || row.state !== 'active'
      || authority?.version !== 1 || authority?.txId !== identity.txId
      || authority?.epoch !== identity.epoch
      || authority?.lifecycle?.dev !== identity.dev
      || authority?.lifecycle?.ino !== identity.ino
      || authority?.lifecycle?.nlink !== identity.nlink
      || authority?.lifecycle?.mode !== identity.mode
      || authority?.lifecycle?.uid !== identity.uid) {
    try { database.exec('ROLLBACK'); } catch {}
    database.close();
    fail();
  }
  return database;
}

function parentAlive(required) {
  return !required || (typeof process.send === 'function' && process.connected);
}

function assertParentAlive(required) {
  if (!parentAlive(required)) fail();
}

function acquireMutationLease(database, identity) {
  if (!database) return;
  if (!sameLifecycleFileIdentity(identity)) fail();
  database.exec('BEGIN IMMEDIATE');
  if (!sameLifecycleFileIdentity(identity)) fail();
  const row = database.prepare(
    'SELECT version, tx_id AS txId, epoch, state FROM rc_cron_worker_epoch WHERE singleton = 1',
  ).get();
  if (!row || row.version !== 1 || row.txId !== identity.txId
      || row.epoch !== identity.epoch || row.state !== 'active') fail();
}

function maybePauseAtWorkerPhase(phase, identity) {
  if (!['test', 'bootstrap-worker-test'].includes(process.env.NODE_ENV)
      || process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS !== '1'
      || process.env.RC_BOOTSTRAP_WORKER_PAUSE_AT !== phase) return;
  const ready = process.env.RC_BOOTSTRAP_WORKER_READY;
  if (typeof ready !== 'string' || !path.isAbsolute(ready) || ready.includes('\0')) fail();
  const home = process.env.HOME;
  const tmpdir = process.env.TMPDIR;
  if (typeof home !== 'string' || !path.isAbsolute(home)
      || typeof tmpdir !== 'string' || !path.isAbsolute(tmpdir)) fail();
  const homeMetadata = fs.lstatSync(home);
  const tmpMetadata = fs.lstatSync(tmpdir);
  const readyTemp = `${ready}.tmp-${identity?.epoch}`;
  fs.writeFileSync(readyTemp, `${JSON.stringify({
    version: 1,
    txId: identity?.txId,
    epoch: identity?.epoch,
    phase,
    scratch: {
      home,
      tmpdir,
      homeIdentity: {
        dev: String(homeMetadata.dev),
        ino: String(homeMetadata.ino),
        mode: process.platform === 'win32' ? null : homeMetadata.mode & 0o7777,
        uid: homeMetadata.uid,
      },
      tmpIdentity: {
        dev: String(tmpMetadata.dev),
        ino: String(tmpMetadata.ino),
        mode: process.platform === 'win32' ? null : tmpMetadata.mode & 0o7777,
        uid: tmpMetadata.uid,
      },
    },
  })}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(readyTemp, ready);
  const timer = setInterval(() => {}, 60_000);
  const disconnected = new Promise((resolve) => process.once('disconnect', resolve));
  // The test releases this pause only by killing the parent. IPC disconnect is
  // the kernel-authenticated parent-death signal and never relies on PID reuse.
  return disconnected.finally(() => clearInterval(timer));
}

function parseArguments(argv) {
  const action = argv[0];
  const stateIndex = argv.indexOf('--state-dir');
  if (!action || stateIndex < 0 || stateIndex + 1 >= argv.length) fail();
  const rawStateDir = argv[stateIndex + 1];
  if (typeof rawStateDir !== 'string' || rawStateDir.includes('\0') || !path.isAbsolute(rawStateDir)) fail();
  const metadata = fs.lstatSync(rawStateDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
  const stateDir = fs.realpathSync(rawStateDir);
  const storeIndex = argv.indexOf('--store-path');
  let storePath;
  if (storeIndex >= 0) {
    const rawStorePath = argv[storeIndex + 1];
    if (typeof rawStorePath !== 'string' || rawStorePath.includes('\0')
        || !path.isAbsolute(rawStorePath)) fail();
    storePath = path.normalize(rawStorePath);
  }
  const lifecycle = parseLifecycle(argv, action);
  const allowedLength = (storePath === undefined ? 3 : 5) + (lifecycle ? 10 : 0);
  if (argv.length !== allowedLength) fail();
  return { action, stateDir, storePath, lifecycle };
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_INPUT_BYTES) fail();
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks, length).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

try {
  const {
    action, stateDir, storePath: requestedStorePath, lifecycle,
  } = parseArguments(process.argv.slice(2));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');
  const input = await readInput();
  const { loadCronStore, resolveCronStorePath, saveCronStore } = await import(
    'openclaw/plugin-sdk/cron-store-runtime'
  );
  // The SQLite clone lives under stateDir, but store_key is the canonical live
  // jobs.json pathname. Keeping those two identities separate is required to
  // inspect an online SQLite backup without mutating the live store.
  const storePath = resolveCronStorePath(requestedStorePath);

  if (action === 'seed') {
    if (!input || input.version !== 1 || !Array.isArray(input.jobs)) fail();
    await saveCronStore(storePath, { version: 1, jobs: input.jobs });
    const saved = await loadCronStore(storePath);
    process.stdout.write(`${JSON.stringify({ jobs: saved.jobs, digest: jobsDigest(saved.jobs) })}\n`);
  } else if (action === 'inspect') {
    const store = await loadCronStore(storePath);
    process.stdout.write(`${JSON.stringify({ jobs: store.jobs, digest: jobsDigest(store.jobs) })}\n`);
  } else if (action === 'compare-and-replace') {
    if (!input || !Array.isArray(input.jobs) || typeof input.expectedDigest !== 'string') fail();
    const lease = openLifecycle(lifecycle);
    try {
      assertParentAlive(Boolean(lifecycle));
      const store = await loadCronStore(storePath);
      if (jobsDigest(store.jobs) !== input.expectedDigest) fail();
      assertParentAlive(Boolean(lifecycle));
      await maybePauseAtWorkerPhase('pre-cas', lifecycle);
      assertParentAlive(Boolean(lifecycle));
      acquireMutationLease(lease, lifecycle);
      assertParentAlive(Boolean(lifecycle));
      await saveCronStore(storePath, { version: 1, jobs: input.jobs });
      // A successful worker result is itself the durable mutation boundary. Do
      // not let the parent observe success until the canonical SQLite store is
      // internally consistent and its WAL is checkpointed.
      verifyAndCheckpointStateDatabase(stateDir);
      await maybePauseAtWorkerPhase('post-write', lifecycle);
      assertParentAlive(Boolean(lifecycle));
      process.stdout.write(`${JSON.stringify({ jobs: input.jobs, digest: jobsDigest(input.jobs) })}\n`);
    } finally {
      if (lease) {
        if (lease.inTransaction) {
          try { lease.exec('COMMIT'); } catch { try { lease.exec('ROLLBACK'); } catch {} }
        }
        lease.close();
      }
    }
  } else {
    fail();
  }
} catch {
  process.stderr.write('Bootstrap cron worker failed\n');
  process.exitCode = 1;
}
