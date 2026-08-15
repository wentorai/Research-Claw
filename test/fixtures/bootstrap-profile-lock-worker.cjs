'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '../..');

function send(message) {
  fs.writeSync(1, `${JSON.stringify(message)}\n`);
}

function parseSpec() {
  if (!process.argv[2]) throw new Error('missing worker specification');
  return JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
}

function installInitializationPause(spec) {
  const delayMs = Number(spec.delayFirstInitializationExclusiveMs || 0);
  if (!Number.isSafeInteger(delayMs) || delayMs <= 0) return;

  const modulePath = require.resolve('better-sqlite3', {
    paths: [path.join(ROOT, 'extensions/research-claw-core'), ROOT],
  });
  const Database = require(modulePath);
  const originalExec = Database.prototype.exec;
  let paused = false;
  Database.prototype.exec = function patchedExec(sql) {
    const result = originalExec.call(this, sql);
    if (!paused && /^\s*BEGIN\s+EXCLUSIVE\s*;?\s*$/iu.test(String(sql))) {
      paused = true;
      send({ event: 'initialization-exclusive-held' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
    return result;
  };
}

function installPublishPause(spec) {
  if (!spec.pauseBeforeInitializationPublish) return;
  const originalRenameSync = fs.renameSync;
  let paused = false;
  fs.renameSync = function patchedRenameSync(source, destination) {
    if (!paused
        && path.basename(String(source)).startsWith('.locks-init-')
        && path.basename(String(destination)) === 'locks') {
      paused = true;
      send({ event: 'initialization-ready-to-publish' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    }
    return originalRenameSync.call(this, source, destination);
  };
}

function installRootAuthorityPause(spec) {
  if (!spec.pauseAfterRootAuthorityPublish) return;
  const originalRenameSync = fs.renameSync;
  let paused = false;
  fs.renameSync = function patchedRootAuthorityRename(source, destination) {
    const result = originalRenameSync.call(this, source, destination);
    if (!paused
        && path.basename(String(destination)) === '.rc-bootstrap-lock-authority') {
      paused = true;
      send({ event: 'root-authority-published' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    }
    return result;
  };
}

function installAfterLocksPublishPause(spec) {
  if (!spec.pauseAfterLocksPublish) return;
  const originalRenameSync = fs.renameSync;
  let paused = false;
  fs.renameSync = function patchedLocksPublish(source, destination) {
    const result = originalRenameSync.call(this, source, destination);
    if (!paused && path.basename(String(destination)) === 'locks') {
      paused = true;
      send({ event: 'locks-published' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    }
    return result;
  };
}

function createCommandQueue() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const queued = [];
  const waiting = [];
  let ended = false;

  input.on('line', (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  });
  input.on('close', () => {
    ended = true;
    while (waiting.length) waiting.shift()(null);
  });

  return {
    next() {
      if (queued.length) return Promise.resolve(queued.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close() {
      input.close();
      process.stdin.pause();
    },
  };
}

async function main() {
  const spec = parseSpec();
  installInitializationPause(spec);
  installPublishPause(spec);
  installRootAuthorityPause(spec);
  installAfterLocksPublishPause(spec);
  const commands = createCommandQueue();
  let held = null;
  let finished = false;

  const finish = async (exitCode, event) => {
    if (finished) return;
    finished = true;
    try { held?.release(); } catch {}
    commands.close();
    if (event) send(event);
    process.exitCode = exitCode;
  };

  const watchdogMs = Number(spec.watchdogMs || 30_000);
  const watchdog = setTimeout(() => {
    void finish(124, { event: 'watchdog-timeout' });
  }, watchdogMs);

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      clearTimeout(watchdog);
      void finish(0, { event: 'terminated', signal });
    });
  }

  try {
    if (spec.gated) {
      send({ event: 'armed' });
      const command = await commands.next();
      if (command !== 'start') throw new Error('worker did not receive start command');
    }

    const locks = require('../../scripts/bootstrap-profile/maintenance-lease.cjs');
    if (spec.initializeAuthority) {
      locks.ensureInitialized({
        rcRoot: spec.lock.rcRoot,
        configPath: spec.lock.configPath,
        externalStopVerified: true,
      });
    }
    held = locks.acquireBootstrapLocks(spec.lock);
    if (spec.releaseOperation) held.releaseOperation();
    send({ event: 'ready', identity: held.identity });

    if (spec.hold === false) {
      clearTimeout(watchdog);
      await finish(0, { event: 'released' });
      return;
    }

    const command = await commands.next();
    if (command !== null && command !== 'release') throw new Error('unknown worker command');
    clearTimeout(watchdog);
    await finish(0, { event: 'released' });
  } catch (error) {
    clearTimeout(watchdog);
    await finish(2, {
      event: 'error',
      code: typeof error?.code === 'string' ? error.code : null,
      name: error?.name || 'Error',
    });
  }
}

void main();
