/**
 * Upload conflict resolution — unit tests.
 *
 * Covers the /rc/upload conflict policy building blocks:
 * - normalizeConflictMode fails closed on unknown values
 * - finderStyleName "name (n).ext" candidates (dotfiles, no-extension names)
 * - resolveUploadConflict against a real filesystem (fail / overwrite / rename,
 *   file-vs-directory collisions, (2)/(3) increments)
 * - service.exists() type field (file vs directory) used by the dashboard
 *   pre-flight check
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  finderStyleName,
  normalizeConflictMode,
  resolveUploadConflict,
} from '../workspace/upload-conflict.js';
import { WorkspaceService, type WorkspaceConfig } from '../workspace/service.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-upload-conflict-'));
}

function makeConfig(root: string): WorkspaceConfig {
  return {
    root,
    autoTrackGit: false,
    commitDebounceMs: 0,
    maxGitFileSize: 10 * 1024 * 1024,
    maxUploadSize: 50 * 1024 * 1024,
    gitAuthorName: 'Test',
    gitAuthorEmail: 'test@example.com',
  };
}

describe('normalizeConflictMode', () => {
  it('accepts overwrite and rename', () => {
    expect(normalizeConflictMode('overwrite')).toBe('overwrite');
    expect(normalizeConflictMode('rename')).toBe('rename');
  });

  it('fails closed on absent/unknown values', () => {
    expect(normalizeConflictMode(undefined)).toBe('fail');
    expect(normalizeConflictMode('')).toBe('fail');
    expect(normalizeConflictMode('fail')).toBe('fail');
    expect(normalizeConflictMode('replace')).toBe('fail');
    expect(normalizeConflictMode('RENAME')).toBe('fail');
  });
});

describe('finderStyleName', () => {
  it('inserts the counter before the last extension', () => {
    expect(finderStyleName('data.csv', 2)).toBe('data (2).csv');
    expect(finderStyleName('archive.tar.gz', 3)).toBe('archive.tar (3).gz');
  });

  it('appends for dotfiles and extension-less names', () => {
    expect(finderStyleName('.env', 2)).toBe('.env (2)');
    expect(finderStyleName('README', 2)).toBe('README (2)');
  });
});

describe('resolveUploadConflict', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('proceeds with the original name when nothing exists (any mode)', async () => {
    for (const mode of ['fail', 'overwrite', 'rename'] as const) {
      const r = await resolveUploadConflict(dir, 'new.txt', mode);
      expect(r).toEqual({ action: 'proceed', fileName: 'new.txt', renamed: false });
    }
  });

  it('proceeds when the destination directory itself does not exist yet', async () => {
    const r = await resolveUploadConflict(path.join(dir, 'not-created-yet'), 'a.txt', 'fail');
    expect(r.action).toBe('proceed');
  });

  it("mode 'fail': existing file → conflict", async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    const r = await resolveUploadConflict(dir, 'a.txt', 'fail');
    expect(r).toEqual({ action: 'conflict', existing: 'file' });
  });

  it("mode 'overwrite': existing file → proceed with original name", async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    const r = await resolveUploadConflict(dir, 'a.txt', 'overwrite');
    expect(r).toEqual({ action: 'proceed', fileName: 'a.txt', renamed: false });
  });

  it("mode 'overwrite': existing DIRECTORY → conflict (a file can never replace a dir)", async () => {
    fs.mkdirSync(path.join(dir, 'a.txt'));
    const r = await resolveUploadConflict(dir, 'a.txt', 'overwrite');
    expect(r).toEqual({ action: 'conflict', existing: 'directory' });
  });

  it("mode 'rename': walks (2), (3)… until a free slot", async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    const first = await resolveUploadConflict(dir, 'a.txt', 'rename');
    expect(first).toEqual({ action: 'proceed', fileName: 'a (2).txt', renamed: true });

    fs.writeFileSync(path.join(dir, 'a (2).txt'), 'A2');
    const second = await resolveUploadConflict(dir, 'a.txt', 'rename');
    expect(second).toEqual({ action: 'proceed', fileName: 'a (3).txt', renamed: true });
  });

  it("mode 'rename': also renames around an existing directory", async () => {
    fs.mkdirSync(path.join(dir, 'data'));
    const r = await resolveUploadConflict(dir, 'data', 'rename');
    expect(r).toEqual({ action: 'proceed', fileName: 'data (2)', renamed: true });
  });
});

describe('service.exists type field (dashboard pre-flight)', () => {
  let root: string;
  let service: WorkspaceService;

  beforeEach(async () => {
    root = makeTempDir();
    service = new WorkspaceService(makeConfig(root));
    await service.init();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports files with type file', async () => {
    await service.save('sources/x.txt', 'X');
    expect(await service.exists('sources/x.txt')).toEqual({ exists: true, type: 'file' });
  });

  it('reports directories with type directory', async () => {
    expect(await service.exists('sources')).toEqual({ exists: true, type: 'directory' });
  });

  it('reports missing paths as exists false', async () => {
    expect(await service.exists('sources/nope.txt')).toEqual({ exists: false });
  });
});
