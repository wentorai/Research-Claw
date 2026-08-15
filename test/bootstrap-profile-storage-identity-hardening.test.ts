import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const storage: {
  readPrivateFile(file: string, options?: { exactMode?: number }): Buffer;
  restorePath(destination: string, snapshotRoot: string, expectedDigest: string): void;
  snapshotPath(source: string, destination: string): string;
  writeBytesAtomic(
    file: string,
    bytes: Buffer,
    mode?: number,
    options?: { beforeRename?: (temporary: string) => void },
  ): void;
} = require('../scripts/bootstrap-profile/storage.cjs');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-storage-identity-'));
  roots.push(root);
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  return root;
}

function writePrivate(file: string, bytes: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

describe.skipIf(process.platform === 'win32')('storage descriptor identity hardening', () => {
  it('revalidates the complete content digest after beforeRename returns', () => {
    const root = fixture();
    const target = path.join(root, 'target.json');
    writePrivate(target, 'ORIGINAL');
    const before = fs.readFileSync(target);
    let temporary = '';
    let temporaryIdentityBefore: fs.Stats | undefined;
    let temporaryIdentityAfter: fs.Stats | undefined;
    let callbackChangedContent = false;
    let failure: unknown;

    try {
      storage.writeBytesAtomic(target, Buffer.from('EXPECTED'), 0o600, {
        beforeRename(candidate) {
          temporary = candidate;
          temporaryIdentityBefore = fs.statSync(candidate);
          const descriptor = fs.openSync(candidate, 'r+');
          try {
            fs.writeSync(descriptor, Buffer.from('MUTATED!'), 0, 8, 0);
            fs.fsyncSync(descriptor);
          } finally {
            fs.closeSync(descriptor);
          }
          temporaryIdentityAfter = fs.statSync(candidate);
          callbackChangedContent = fs.readFileSync(candidate, 'utf8') === 'MUTATED!';
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(temporary).not.toBe('');
    expect(callbackChangedContent).toBe(true);
    expect(temporaryIdentityBefore?.dev).toBe(temporaryIdentityAfter?.dev);
    expect(temporaryIdentityBefore?.ino).toBe(temporaryIdentityAfter?.ino);
    expect(failure).toBeDefined();
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.existsSync(temporary)).toBe(false);
  });

  it('rejects private files carrying POSIX special mode bits', () => {
    const root = fixture();
    const file = path.join(root, 'special.bin');
    writePrivate(file, 'PRIVATE');
    fs.chmodSync(file, 0o4600);
    expect(fs.statSync(file).mode & 0o7777).toBe(0o4600);

    expect(() => storage.readPrivateFile(file, { exactMode: 0o600 })).toThrow();
  });

  it('rejects snapshot sources carrying POSIX special mode bits', () => {
    const root = fixture();
    const source = path.join(root, 'source.bin');
    const snapshot = path.join(root, 'snapshot');
    writePrivate(source, 'SOURCE');
    fs.chmodSync(source, 0o4600);
    expect(fs.statSync(source).mode & 0o7777).toBe(0o4600);

    expect(() => storage.snapshotPath(source, snapshot)).toThrow();
  });

  it('rejects a source path identity change while copying snapshot bytes', () => {
    const root = fixture();
    const source = path.join(root, 'source.bin');
    const held = path.join(root, 'source-held.bin');
    const snapshot = path.join(root, 'snapshot');
    writePrivate(source, 'AAAAAAAA');

    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;
    const originalRenameSync = fs.renameSync;
    const originalWriteFileSync = fs.writeFileSync;
    const destinationDescriptors = new Set<number>();
    let swapped = false;
    let sourceIdentityBefore: fs.Stats | undefined;
    let sourceIdentityAfter: fs.Stats | undefined;
    let failure: unknown;
    sourceIdentityBefore = fs.statSync(source);
    fs.openSync = ((candidate: fs.PathLike, ...args: any[]) => {
      const descriptor = originalOpenSync.call(fs, candidate, ...args as [any]);
      if (typeof candidate === 'string'
          && path.resolve(candidate).startsWith(`${path.resolve(snapshot)}${path.sep}content${path.sep}`)) {
        destinationDescriptors.add(descriptor);
      }
      return descriptor;
    }) as typeof fs.openSync;
    fs.fsyncSync = ((descriptor: number) => {
      const result = originalFsyncSync.call(fs, descriptor);
      if (!swapped && destinationDescriptors.has(descriptor)) {
        swapped = true;
        originalRenameSync.call(fs, source, held);
        originalWriteFileSync.call(fs, source, 'BBBBBBBB', { flag: 'wx', mode: 0o600 });
        sourceIdentityAfter = fs.statSync(source);
      }
      return result;
    }) as typeof fs.fsyncSync;
    try {
      try {
        storage.snapshotPath(source, snapshot);
      } catch (error) {
        failure = error;
      }
    } finally {
      fs.openSync = originalOpenSync;
      fs.fsyncSync = originalFsyncSync;
    }
    expect(swapped).toBe(true);
    expect(sourceIdentityAfter).toBeDefined();
    expect(sourceIdentityBefore?.dev === sourceIdentityAfter?.dev
      && sourceIdentityBefore?.ino === sourceIdentityAfter?.ino).toBe(false);
    expect(failure).toBeDefined();
  });

  it('records the verified snapshot content descriptor identity', () => {
    const root = fixture();
    const source = path.join(root, 'source.bin');
    const snapshot = path.join(root, 'snapshot');
    writePrivate(source, 'IDENTITY');

    storage.snapshotPath(source, snapshot);

    const metadata = JSON.parse(fs.readFileSync(path.join(snapshot, 'snapshot.json'), 'utf8'));
    expect(metadata.entries).toHaveLength(1);
    expect(metadata.entries[0].contentIdentity).toEqual({
      dev: expect.stringMatching(/^\d+$/u),
      ino: expect.stringMatching(/^\d+$/u),
      nlink: 1,
      size: 8,
      mode: 0o600,
    });
  });

  it('restores from the already verified descriptor when the content path is rebound', () => {
    const root = fixture();
    const source = path.join(root, 'source');
    const snapshot = path.join(root, 'snapshot');
    const destination = path.join(root, 'destination');
    const held = path.join(root, 'held-content.bin');
    fs.mkdirSync(source, { mode: 0o700 });
    writePrivate(path.join(source, 'value.bin'), 'AAAAAAAA');
    const digest = storage.snapshotPath(source, snapshot);
    fs.mkdirSync(destination, { mode: 0o700 });
    writePrivate(path.join(destination, 'old.bin'), 'OLD');
    const saved = path.join(snapshot, 'content', 'value.bin');

    const originalRmSync = fs.rmSync;
    const originalRenameSync = fs.renameSync;
    const originalWriteFileSync = fs.writeFileSync;
    let rebound = false;
    fs.rmSync = ((candidate: fs.PathLike, options?: fs.RmDirOptions) => {
      if (!rebound && path.resolve(String(candidate)) === path.resolve(destination)) {
        rebound = true;
        originalRenameSync.call(fs, saved, held);
        originalWriteFileSync.call(fs, saved, 'BBBBBBBB', { flag: 'wx', mode: 0o600 });
      }
      return originalRmSync.call(fs, candidate, options as any);
    }) as typeof fs.rmSync;
    try {
      storage.restorePath(destination, snapshot, digest);
    } finally {
      fs.rmSync = originalRmSync;
    }

    expect(rebound).toBe(true);
    expect(fs.readFileSync(path.join(destination, 'value.bin'), 'utf8')).toBe('AAAAAAAA');
  });
});
