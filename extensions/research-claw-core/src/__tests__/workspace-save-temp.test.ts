/**
 * saveFromTempFile + stale staging sweep — service-side of the streaming
 * upload path.
 *
 * - rename lands the temp file at the destination (temp consumed)
 * - is_new semantics + Add:/Update:/custom commit messages (real git)
 * - files over maxGitFileSize are auto-gitignored, not committed
 * - init() sweeps .uploads-tmp/ entries older than one hour, keeps fresh ones
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { WorkspaceService, type WorkspaceConfig } from '../workspace/service.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-save-temp-'));
}

function makeConfig(root: string, git = false): WorkspaceConfig {
  return {
    root,
    autoTrackGit: git,
    commitDebounceMs: 0,
    maxGitFileSize: 1024, // tiny so the auto-ignore path is testable
    maxUploadSize: 0,
    gitAuthorName: 'Test',
    gitAuthorEmail: 'test@example.com',
  };
}

async function writeTmp(root: string, content: Buffer | string): Promise<string> {
  const dir = path.join(root, '.uploads-tmp');
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, `.${Math.random().toString(36).slice(2)}.tmp`);
  await fsp.writeFile(p, content);
  return p;
}

let root: string;

beforeEach(() => {
  root = makeTempDir();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('saveFromTempFile', () => {
  it('renames the temp file into place and consumes it', async () => {
    const service = new WorkspaceService(makeConfig(root));
    await service.init();
    const tmp = await writeTmp(root, 'CONTENT');

    const result = await service.saveFromTempFile(tmp, 'sources/x.txt');
    expect(result).toMatchObject({ path: 'sources/x.txt', size: 7, is_new: true });
    expect(await fsp.readFile(path.join(root, 'sources/x.txt'), 'utf-8')).toBe('CONTENT');
    await expect(fsp.access(tmp)).rejects.toThrow(); // consumed
  });

  it('DEFAULT (exclusive) throws WS_FILE_EXISTS on an existing dest and keeps the tmp for retry', async () => {
    const service = new WorkspaceService(makeConfig(root));
    await service.init();
    await service.save('sources/deep/a.txt', 'OLD');

    const tmp = await writeTmp(root, 'NEW');
    await expect(service.saveFromTempFile(tmp, 'sources/deep/a.txt')).rejects.toMatchObject({ code: -32009 });
    // Original untouched, tmp left in place so the handler can retry a new name.
    expect(await fsp.readFile(path.join(root, 'sources/deep/a.txt'), 'utf-8')).toBe('OLD');
    await expect(fsp.access(tmp)).resolves.toBeUndefined();
  });

  it('overwrite:true clobbers the existing dest and reports is_new false', async () => {
    const service = new WorkspaceService(makeConfig(root));
    await service.init();
    await service.save('sources/deep/a.txt', 'OLD');

    const tmp = await writeTmp(root, 'NEW');
    const result = await service.saveFromTempFile(tmp, 'sources/deep/a.txt', undefined, { overwrite: true });
    expect(result.is_new).toBe(false);
    expect(await fsp.readFile(path.join(root, 'sources/deep/a.txt'), 'utf-8')).toBe('NEW');
    await expect(fsp.access(tmp)).rejects.toThrow(); // consumed
  });

  it('concurrent exclusive writes to the SAME dest: exactly one wins, no silent clobber', async () => {
    const service = new WorkspaceService(makeConfig(root));
    await service.init();
    const tmpA = await writeTmp(root, 'AAA');
    const tmpB = await writeTmp(root, 'BBB');

    const results = await Promise.allSettled([
      service.saveFromTempFile(tmpA, 'sources/race.txt'),
      service.saveFromTempFile(tmpB, 'sources/race.txt'),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason).toMatchObject({ code: -32009 });
    // The winner's content is intact — never a half-clobber.
    const onDisk = await fsp.readFile(path.join(root, 'sources/race.txt'), 'utf-8');
    expect(['AAA', 'BBB']).toContain(onDisk);
  });

  it('git-commits with the provided message (real git)', async () => {
    const service = new WorkspaceService(makeConfig(root, true));
    await service.init();
    const tmp = await writeTmp(root, 'DATA');

    const result = await service.saveFromTempFile(tmp, 'sources/y.txt', 'Upload: y.txt to sources');
    expect(result.committed).toBe(true);
    const log = execFileSync('git', ['-C', root, 'log', '-1', '--format=%s']).toString().trim();
    expect(log).toBe('Upload: y.txt to sources');
  });

  it('auto-gitignores files over maxGitFileSize instead of committing', async () => {
    const service = new WorkspaceService(makeConfig(root, true));
    await service.init();
    const tmp = await writeTmp(root, Buffer.alloc(4096, 0x61)); // > 1KB cap

    const result = await service.saveFromTempFile(tmp, 'sources/big.bin');
    expect(result.committed).toBe(false);
    const gitignore = await fsp.readFile(path.join(root, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('sources/big.bin');
  });

  it('rejects path traversal like save() does', async () => {
    const service = new WorkspaceService(makeConfig(root));
    await service.init();
    const tmp = await writeTmp(root, 'X');
    await expect(service.saveFromTempFile(tmp, '../escape.txt')).rejects.toThrow();
  });
});

describe('init() stale staging sweep', () => {
  it('removes .uploads-tmp entries older than 1h, keeps fresh ones', async () => {
    const staleDir = path.join(root, '.uploads-tmp');
    await fsp.mkdir(staleDir, { recursive: true });
    const stale = path.join(staleDir, '.stale.tmp');
    const fresh = path.join(staleDir, '.fresh.tmp');
    await fsp.writeFile(stale, 'old');
    await fsp.writeFile(fresh, 'new');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsp.utimes(stale, twoHoursAgo, twoHoursAgo);

    const service = new WorkspaceService(makeConfig(root));
    await service.init();

    await expect(fsp.access(stale)).rejects.toThrow();
    await expect(fsp.access(fresh)).resolves.toBeUndefined();
  });
});
