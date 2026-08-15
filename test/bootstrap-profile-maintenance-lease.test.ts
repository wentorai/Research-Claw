import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const locks = require('../scripts/bootstrap-profile/maintenance-lease.cjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-lock-'));
  roots.push(root);
  const configRoot = path.join(root, 'config');
  fs.mkdirSync(configRoot, { mode: 0o700 });
  const configPath = path.join(configRoot, 'openclaw.json');
  fs.writeFileSync(configPath, '{}\n', { mode: 0o600 });
  return { root, configRoot, configPath };
}

function acquire(item: ReturnType<typeof fixture>, operation: 'shared' | 'exclusive', runtime: null | 'shared' | 'reserved' | 'exclusive') {
  return locks.acquireBootstrapLocks({
    rcRoot: ROOT, configPath: item.configPath, operation, runtime,
  });
}

function initialize(item: ReturnType<typeof fixture>) {
  locks.ensureInitialized({
    rcRoot: ROOT, configPath: item.configPath, externalStopVerified: true,
  });
}

describe('SQLite bootstrap operation/runtime locks', () => {
  it('creates permanent private rollback-journal lock databases under the canonical config root', () => {
    const item = fixture();
    initialize(item);
    const held = acquire(item, 'exclusive', 'exclusive');
    expect(held.assertHeld()).toBe(true);
    for (const name of ['operation.sqlite', 'runtime.sqlite']) {
      const file = path.join(item.configRoot, '.rc-bootstrap', 'locks', name);
      expect(fs.existsSync(file)).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(`${file}-wal`)).toBe(false);
    }
    held.release();
    expect(fs.existsSync(path.join(item.configRoot, '.rc-bootstrap', 'locks', 'operation.sqlite'))).toBe(true);
  });

  it('serializes every exclusive operation while allowing concurrent status readers', () => {
    const item = fixture();
    initialize(item);
    const readerA = acquire(item, 'shared', null);
    const readerB = acquire(item, 'shared', null);
    expect(readerA.assertHeld()).toBe(true);
    expect(readerB.assertHeld()).toBe(true);
    expect(() => acquire(item, 'exclusive', null))
      .toThrowError(expect.objectContaining({ code: 'OPERATION_LOCK_BUSY' }));
    readerB.release();
    readerA.release();
    const writer = acquire(item, 'exclusive', null);
    expect(writer.assertHeld()).toBe(true);
    writer.release();
  });

  it('permits runtime shared readers and excludes every runtime mutator', () => {
    const item = fixture();
    initialize(item);
    const onlineA = acquire(item, 'shared', 'shared');
    const onlineB = acquire(item, 'shared', 'shared');
    expect(onlineA.assertHeld()).toBe(true);
    expect(onlineB.assertHeld()).toBe(true);
    // Release operation locks while retaining the gateway/online runtime lock.
    onlineA.releaseOperation();
    onlineB.releaseOperation();
    expect(() => acquire(item, 'exclusive', 'exclusive'))
      .toThrowError(expect.objectContaining({ code: 'RUNTIME_LOCK_BUSY' }));
    onlineB.release();
    onlineA.release();
    const mutation = acquire(item, 'exclusive', 'exclusive');
    expect(mutation.assertHeld()).toBe(true);
    mutation.release();
  });

  it('supports one reserved gateway alongside shared online readers', () => {
    const item = fixture();
    initialize(item);
    const gateway = acquire(item, 'exclusive', 'reserved');
    gateway.releaseOperation();
    const reader = acquire(item, 'exclusive', 'shared');
    reader.releaseOperation();
    expect(() => acquire(item, 'exclusive', 'reserved'))
      .toThrowError(expect.objectContaining({ code: 'RUNTIME_LOCK_BUSY' }));
    expect(() => acquire(item, 'exclusive', 'exclusive'))
      .toThrowError(expect.objectContaining({ code: 'RUNTIME_LOCK_BUSY' }));
    reader.release();
    gateway.release();
  });

  it('does not write lock database bytes during established shared acquisition', () => {
    const item = fixture();
    initialize(item);
    acquire(item, 'exclusive', 'exclusive').release();
    const files = ['operation.sqlite', 'runtime.sqlite'].map(
      (name) => path.join(item.configRoot, '.rc-bootstrap', 'locks', name),
    );
    const before = files.map((file) => fs.readFileSync(file));
    const held = acquire(item, 'shared', 'shared');
    held.release();
    files.forEach((file, index) => expect(fs.readFileSync(file)).toEqual(before[index]));
  });

  it('binds the authority to a persistent root identity and config basename', () => {
    const item = fixture();
    initialize(item);
    acquire(item, 'exclusive', null).release();
    const identity = path.join(item.configRoot, '.rc-bootstrap', 'locks', 'identity.json');
    expect(JSON.parse(fs.readFileSync(identity, 'utf8'))).toMatchObject({
      version: 1, configBasename: 'openclaw.json',
    });
    expect(JSON.parse(fs.readFileSync(identity, 'utf8')).rootUuid)
      .toMatch(/^[0-9a-f-]{36}$/);
    fs.writeFileSync(path.join(item.configRoot, 'sibling.json'), '{}\n', { mode: 0o600 });
    expect(() => locks.acquireBootstrapLocks({
      rcRoot: ROOT,
      configPath: path.join(item.configRoot, 'sibling.json'),
      operation: 'shared',
    })).toThrowError(expect.objectContaining({ code: 'LOCK_IDENTITY_MISMATCH' }));
  });

  it('does not use PID, nonce, TTL, or removable lease records as authority', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'scripts/bootstrap-profile/maintenance-lease.cjs'), 'utf8',
    );
    expect(source).not.toMatch(/process\.kill|boot_id|processStart|nonceHash|staleMs|leaseId/);
    expect(source).toContain('BEGIN EXCLUSIVE');
    expect(source).toContain('BEGIN IMMEDIATE');
    expect(source).toContain('BEGIN DEFERRED');
  });

  it('attempts to release the operation lock even when runtime rollback reports an error', () => {
    const item = fixture();
    initialize(item);
    const modulePath = require.resolve('better-sqlite3', {
      paths: [path.join(ROOT, 'extensions/research-claw-core'), ROOT],
    });
    const Database = require(modulePath);
    const originalExec = Database.prototype.exec;
    let injected = false;
    Database.prototype.exec = function patchedExec(statement: string) {
      if (!injected && String(statement).trim().toUpperCase() === 'ROLLBACK'
          && String((this as any).name).endsWith('runtime.sqlite')) {
        injected = true;
        const error = new Error('test-only runtime rollback failure');
        (error as any).code = 'SQLITE_IOERR';
        throw error;
      }
      return originalExec.call(this, statement);
    };
    try {
      const held = acquire(item, 'exclusive', 'exclusive');
      expect(() => held.release())
        .toThrowError(expect.objectContaining({ code: 'LOCK_RELEASE_FAILED' }));
    } finally {
      Database.prototype.exec = originalExec;
    }
    const successor = acquire(item, 'exclusive', null);
    expect(successor.assertHeld()).toBe(true);
    successor.release();
  });
});
