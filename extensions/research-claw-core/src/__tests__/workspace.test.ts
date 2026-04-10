/**
 * WorkspaceService Unit Tests
 *
 * Tests for the 7 rc.ws.* RPC methods: init, tree, read, save, history, diff, restore.
 *
 * NOTE: The WorkspaceService depends on the filesystem and git binary. These tests
 * exercise path validation logic and the service interface. Full integration with
 * git requires a live filesystem, so git-dependent tests verify behavior via the
 * service layer (init creates dirs, save writes files, etc.). Tests that require
 * live git are kept minimal and use a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { WorkspaceService, WorkspaceError, type WorkspaceConfig } from '../workspace/service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ws-test-'));
}

function makeConfig(root: string): WorkspaceConfig {
  return {
    root,
    autoTrackGit: false, // most unit tests disable git to avoid git binary dep
    commitDebounceMs: 0,
    maxGitFileSize: 10 * 1024 * 1024,
    maxUploadSize: 50 * 1024 * 1024,
    gitAuthorName: 'Test',
    gitAuthorEmail: 'test@example.com',
  };
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('WorkspaceService', () => {
  let tmpDir: string;
  let svc: WorkspaceService;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    if (svc) svc.destroy();
    cleanup(tmpDir);
  });

  // ── Path validation ─────────────────────────────────────────────────

  describe('path validation', () => {
    it('rejects absolute paths', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await expect(svc.read('/etc/passwd')).rejects.toThrow(WorkspaceError);
    });

    it('rejects path traversal with ..', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await expect(svc.read('../../../etc/passwd')).rejects.toThrow(WorkspaceError);
    });

    it('rejects null bytes in path', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await expect(svc.read('file\0name')).rejects.toThrow(WorkspaceError);
    });

    it('rejects empty path', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await expect(svc.read('')).rejects.toThrow(WorkspaceError);
    });
  });

  // ── init ────────────────────────────────────────────────────────────

  describe('init', () => {
    it('creates workspace root and scaffold directories', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      expect(fs.existsSync(path.join(tmpDir, 'sources', 'papers'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'sources', 'data'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'sources', 'references'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'outputs', 'drafts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'outputs', 'figures'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'outputs', 'exports'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'outputs', 'reports'))).toBe(true);
    });

    it('creates default .gitignore', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      const gitignorePath = path.join(tmpDir, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('.DS_Store');
      expect(content).toContain('node_modules/');
    });

    it('does not overwrite existing .gitignore', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'custom content\n');

      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(content).toBe('custom content\n');
    });
  });

  // ── tree ────────────────────────────────────────────────────────────

  describe('tree', () => {
    it('returns workspace tree structure', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      // Create a test file
      fs.writeFileSync(path.join(tmpDir, 'test.md'), '# Hello');

      const result = await svc.tree();
      expect(result.workspace_root).toBe(path.resolve(tmpDir));
      expect(result.tree.length).toBeGreaterThan(0);

      // Should have directories listed before files
      const firstDir = result.tree.find((n) => n.type === 'directory');
      const firstFile = result.tree.find((n) => n.type === 'file');
      if (firstDir && firstFile) {
        const dirIdx = result.tree.indexOf(firstDir);
        const fileIdx = result.tree.indexOf(firstFile);
        expect(dirIdx).toBeLessThan(fileIdx);
      }
    });

    it('lists files with metadata', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      fs.writeFileSync(path.join(tmpDir, 'notes.md'), '# Notes');

      const result = await svc.tree();
      const notesNode = result.tree.find((n) => n.name === 'notes.md');
      expect(notesNode).toBeDefined();
      expect(notesNode!.type).toBe('file');
      expect(notesNode!.mime_type).toBe('text/markdown');
      expect(notesNode!.size).toBeGreaterThan(0);
    });

    it('respects depth limit', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      // Create a nested directory
      const deep = path.join(tmpDir, 'a', 'b', 'c', 'd');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'deep.txt'), 'deep');

      const shallowResult = await svc.tree(undefined, 1);
      // At depth 1, should not have children resolved
      const dirA = shallowResult.tree.find((n) => n.name === 'a');
      expect(dirA).toBeDefined();
      expect(dirA!.children).toBeUndefined();
    });

    it('excludes .git directory', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      // Create a fake .git directory
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

      const result = await svc.tree();
      const gitDir = result.tree.find((n) => n.name === '.git');
      expect(gitDir).toBeUndefined();
    });

    it('handles subdirectory as root', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      fs.writeFileSync(path.join(tmpDir, 'sources', 'papers', 'test.pdf'), 'data');

      const result = await svc.tree('sources/papers');
      const testFile = result.tree.find((n) => n.name === 'test.pdf');
      expect(testFile).toBeDefined();
    });
  });

  // ── save + read ─────────────────────────────────────────────────────

  describe('save and read', () => {
    it('saves and reads a text file', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      const saveResult = await svc.save('notes/test.md', '# Test Content\n\nHello world.');
      expect(saveResult.path).toBe('notes/test.md');
      expect(saveResult.size).toBeGreaterThan(0);

      const readResult = await svc.read('notes/test.md');
      expect(readResult.content).toBe('# Test Content\n\nHello world.');
      expect(readResult.encoding).toBe('utf-8');
      expect(readResult.mime_type).toBe('text/markdown');
    });

    it('creates parent directories automatically', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await svc.save('deep/nested/dir/file.txt', 'content');
      expect(fs.existsSync(path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt'))).toBe(true);
    });

    it('throws when reading non-existent file', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await expect(svc.read('nonexistent.txt')).rejects.toThrow(WorkspaceError);
    });

    // ── .ResearchClaw/ fallback for relocatable prompt files ──────────

    it('reads HEARTBEAT.md from .ResearchClaw/ when missing at root', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      // Place file only in .ResearchClaw/ (simulates post-migration state)
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.mkdirSync(rcDir, { recursive: true });
      fs.writeFileSync(path.join(rcDir, 'HEARTBEAT.md'), '# Heartbeat\ntest');

      const result = await svc.read('HEARTBEAT.md');
      expect(result.content).toBe('# Heartbeat\ntest');
      expect(result.encoding).toBe('utf-8');
    });

    it('prefers root file over .ResearchClaw/ when both exist', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      // Place file at both locations — root should win
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'root version');
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.mkdirSync(rcDir, { recursive: true });
      fs.writeFileSync(path.join(rcDir, 'AGENTS.md'), 'rc version');

      const result = await svc.read('AGENTS.md');
      expect(result.content).toBe('root version');
    });

    it('does NOT fallback for non-relocatable files', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      // Place a non-relocatable file only in .ResearchClaw/
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.mkdirSync(rcDir, { recursive: true });
      fs.writeFileSync(path.join(rcDir, 'random.md'), 'should not be found');

      await expect(svc.read('random.md')).rejects.toThrow(WorkspaceError);
    });

    it('fallback works for all RELOCATABLE_PROMPT_FILES', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      const relocatable = [
        'AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md',
        'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md',
      ];
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.mkdirSync(rcDir, { recursive: true });

      for (const f of relocatable) {
        fs.writeFileSync(path.join(rcDir, f), `content of ${f}`);
      }

      for (const f of relocatable) {
        const result = await svc.read(f);
        expect(result.content).toBe(`content of ${f}`);
      }
    });

    it('fallback throws when file missing from both root and .ResearchClaw/', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      // HEARTBEAT.md is relocatable but doesn't exist anywhere
      await expect(svc.read('HEARTBEAT.md')).rejects.toThrow(WorkspaceError);
    });

    it('reports file as not committed when git is disabled', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await svc.save('test.md', 'content');
      const saveResult = await svc.save('test.md', 'updated');
      expect(saveResult.committed).toBe(false);
    });
  });

  // ── history / diff / restore (no-git fallback) ─────────────────────

  describe('history / diff / restore (no git)', () => {
    it('returns empty history when git is disabled', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      const history = await svc.history();
      expect(history.commits).toHaveLength(0);
      expect(history.total).toBe(0);
    });

    it('returns empty diff when git is disabled', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      const diff = await svc.diff();
      expect(diff.diff).toBe('');
      expect(diff.files_changed).toBe(0);
    });

    it('throws when restoring without git', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await expect(svc.restore('test.md', 'abc1234')).rejects.toThrow(
        /not enabled/,
      );
    });
  });

  // ── destroy ─────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('cleans up without errors', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      expect(() => svc.destroy()).not.toThrow();
    });

    it('can be called multiple times safely', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      svc.destroy();
      expect(() => svc.destroy()).not.toThrow();
    });
  });

  // ── Git integration (requires git binary) ──────────────────────────

  describe('git integration', () => {
    it('init with autoTrackGit creates .git directory', async () => {
      const config = makeConfig(tmpDir);
      config.autoTrackGit = true;
      svc = new WorkspaceService(config);

      try {
        await svc.init();
        expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(true);
      } catch (err) {
        // Git not available in test environment — skip gracefully
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('not found') || errMsg.includes('GIT_NOT_FOUND')) {
          // Expected on systems without git
          return;
        }
        throw err;
      }
    });

    it('save with autoTrackGit commits the file', async () => {
      const config = makeConfig(tmpDir);
      config.autoTrackGit = true;
      svc = new WorkspaceService(config);

      try {
        await svc.init();
        const result = await svc.save('test.md', '# Hello');
        expect(result.committed).toBe(true);
        expect(result.commit_hash).toBeTruthy();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('not found') || errMsg.includes('GIT_NOT_FOUND')) {
          return;
        }
        throw err;
      }
    });

    it('history returns commits after saves', async () => {
      const config = makeConfig(tmpDir);
      config.autoTrackGit = true;
      svc = new WorkspaceService(config);

      try {
        await svc.init();
        await svc.save('test.md', '# Version 1');
        await svc.save('test.md', '# Version 2');

        const history = await svc.history('test.md');
        expect(history.commits.length).toBeGreaterThanOrEqual(2);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('not found') || errMsg.includes('GIT_NOT_FOUND')) {
          return;
        }
        throw err;
      }
    });
  });
});
