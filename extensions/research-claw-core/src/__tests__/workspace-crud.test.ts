/**
 * Workspace CRUD — Functional Tests
 *
 * Tests for the new/modified workspace features:
 * - move() destination overwrite guard (Bug 2.2)
 * - move() git tracking: both source + dest staged (Bug 2.1)
 * - delete() restore hint
 * - save() is_new return field + overwrite detection
 * - workspace_delete tool (confirm guard)
 * - workspace_append tool (existing + new file)
 * - workspace_download SSRF guard + size limit
 *
 * Uses real filesystem + git to validate actual behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { WorkspaceService, WorkspaceError, type WorkspaceConfig } from '../workspace/service.js';
import { createWorkspaceTools } from '../workspace/tools.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ws-crud-'));
}

function makeConfig(root: string, git = false): WorkspaceConfig {
  return {
    root,
    autoTrackGit: git,
    commitDebounceMs: 0, // immediate commit for deterministic tests
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

/** Call a tool's execute() and extract the text content from the result. */
function getToolText(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }> };
  return r.content?.[0]?.text ?? '';
}

/** Call a tool's execute() and extract the details object from the result. */
function getToolDetails(result: unknown): Record<string, unknown> {
  const r = result as { details: Record<string, unknown> };
  return r.details ?? {};
}

// ---------------------------------------------------------------------------
// Service-level tests (real filesystem, optional git)
// ---------------------------------------------------------------------------

describe('WorkspaceService CRUD fixes', () => {
  let tmpDir: string;
  let svc: WorkspaceService;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    if (svc) svc.destroy();
    cleanup(tmpDir);
  });

  // ── save() is_new field ───────────────────────────────────────────────

  describe('save() is_new field', () => {
    it('returns is_new=true for new files', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      const result = await svc.save('test.md', '# Hello');
      expect(result.is_new).toBe(true);
    });

    it('returns is_new=false for existing files', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await svc.save('test.md', '# Hello');
      const result = await svc.save('test.md', '# Updated');
      expect(result.is_new).toBe(false);
    });
  });

  // ── move() destination guard ──────────────────────────────────────────

  describe('move() destination overwrite guard', () => {
    it('rejects move when destination already exists', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await svc.save('source.md', 'Source content');
      await svc.save('dest.md', 'Destination content');

      await expect(svc.move('source.md', 'dest.md')).rejects.toThrow(
        /already exists/,
      );

      // Verify both files are untouched
      const sourceContent = (await svc.read('source.md')).content;
      const destContent = (await svc.read('dest.md')).content;
      expect(sourceContent).toBe('Source content');
      expect(destContent).toBe('Destination content');
    });

    it('allows move when destination does not exist', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await svc.save('source.md', 'Content');
      const result = await svc.move('source.md', 'dest.md');
      expect(result.ok).toBe(true);

      const readResult = await svc.read('dest.md');
      expect(readResult.content).toBe('Content');
    });

    it('allows move to a new subdirectory', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();

      await svc.save('file.md', 'Content');
      const result = await svc.move('file.md', 'subdir/file.md');
      expect(result.ok).toBe(true);

      const readResult = await svc.read('subdir/file.md');
      expect(readResult.content).toBe('Content');
    });
  });

  // ── CJK filename git status ─────────────────────────────────────────

  describe('CJK filename git status (requires git)', () => {
    it('correctly tracks Chinese filenames', async () => {
      const config = makeConfig(tmpDir, true);
      svc = new WorkspaceService(config);

      try {
        await svc.init();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found') || msg.includes('GIT_NOT_FOUND')) return;
        throw err;
      }

      // Save a file with Chinese name
      await svc.save('outputs/论文草稿.md', '# 测试内容');

      // The tree should show the file with correct git status
      const { tree } = await svc.tree('outputs', 3);
      const cjkFile = tree.find((n) => n.name === '论文草稿.md');
      expect(cjkFile).toBeDefined();
      // After save+commit, status should be 'committed' (not 'untracked' due to encoding bug)
      expect(cjkFile!.git_status).toBe('committed');

      // Modify the file — status should change to 'modified'
      await svc.save('outputs/论文草稿.md', '# 更新内容');
      // git status check uses the batch status map, which must correctly decode octal escapes
      const readResult = await svc.read('outputs/论文草稿.md');
      expect(readResult.git_status).toBe('committed'); // just committed, so committed
    });
  });

  // ── move() git tracking ───────────────────────────────────────────────

  describe('move() git tracking (requires git)', () => {
    it('commits both source deletion and destination addition', async () => {
      const config = makeConfig(tmpDir, true);
      svc = new WorkspaceService(config);

      try {
        await svc.init();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found') || msg.includes('GIT_NOT_FOUND')) return;
        throw err;
      }

      await svc.save('original.md', '# Original');

      const moveResult = await svc.move('original.md', 'renamed.md');
      expect(moveResult.committed).toBe(true);

      // After move+commit, git status should be clean (no dirty entries)
      const diff = await svc.diff();
      expect(diff.files_changed).toBe(0);
      expect(diff.diff).toBe('');
    });
  });

  // ── delete() restore hint ─────────────────────────────────────────────

  describe('delete() restore hint', () => {
    it('returns restore_hint when git is enabled', async () => {
      const config = makeConfig(tmpDir, true);
      svc = new WorkspaceService(config);

      try {
        await svc.init();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found') || msg.includes('GIT_NOT_FOUND')) return;
        throw err;
      }

      await svc.save('to-delete.md', 'Content');

      const result = await svc.delete('to-delete.md');
      expect(result.ok).toBe(true);
      expect(result.committed).toBe(true);
      expect(result.restore_hint).toContain('recoverable');
      expect(result.restore_hint).toContain('workspace_restore');
    });

    it('returns no restore_hint when git is disabled', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir, false));
      await svc.init();

      await svc.save('to-delete.md', 'Content');
      const result = await svc.delete('to-delete.md');
      expect(result.ok).toBe(true);
      expect(result.restore_hint).toBeUndefined();
    });
  });

  // ── migratePromptFiles stale root cleanup ─────────────────────────

  describe('migratePromptFiles stale root cleanup', () => {
    it('removes stale root files when .ResearchClaw/ copy exists', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      // Pre-populate: simulate already-migrated state with stale root leftover
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.mkdirSync(rcDir, { recursive: true });
      fs.writeFileSync(path.join(rcDir, 'AGENTS.md'), 'new version');
      fs.writeFileSync(path.join(rcDir, 'HEARTBEAT.md'), 'heartbeat v2');
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'old stale version');
      fs.writeFileSync(path.join(tmpDir, 'HEARTBEAT.md'), 'old heartbeat');

      await svc.init(); // triggers migratePromptFiles()

      // Root files should be cleaned up
      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'HEARTBEAT.md'))).toBe(false);
      // .ResearchClaw/ files untouched
      expect(fs.readFileSync(path.join(rcDir, 'AGENTS.md'), 'utf-8')).toBe('new version');
      expect(fs.readFileSync(path.join(rcDir, 'HEARTBEAT.md'), 'utf-8')).toBe('heartbeat v2');
    });

    it('does not delete root files when .ResearchClaw/ copy is missing', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      // Only root file, no .ResearchClaw/ copy — should migrate, not delete
      fs.writeFileSync(path.join(tmpDir, 'USER.md'), 'user data');

      await svc.init();

      // File should have been moved to .ResearchClaw/, not deleted
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      expect(fs.existsSync(path.join(tmpDir, 'USER.md'))).toBe(false);
      expect(fs.existsSync(path.join(rcDir, 'USER.md'))).toBe(true);
      expect(fs.readFileSync(path.join(rcDir, 'USER.md'), 'utf-8')).toBe('user data');
    });

    it('is idempotent — multiple init() calls produce same result', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.mkdirSync(rcDir, { recursive: true });
      fs.writeFileSync(path.join(rcDir, 'SOUL.md'), 'soul content');
      fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), 'stale soul');

      await svc.init();
      expect(fs.existsSync(path.join(tmpDir, 'SOUL.md'))).toBe(false);

      // Second init — should not crash or recreate root file
      svc.destroy();
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      expect(fs.existsSync(path.join(tmpDir, 'SOUL.md'))).toBe(false);
      expect(fs.readFileSync(path.join(rcDir, 'SOUL.md'), 'utf-8')).toBe('soul content');
    });

    it('does not touch non-relocatable files at root', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.mkdirSync(rcDir, { recursive: true });
      // A non-relocatable file at root should survive
      fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), 'memory data');
      fs.writeFileSync(path.join(tmpDir, 'custom-notes.md'), 'my notes');

      await svc.init();

      expect(fs.existsSync(path.join(tmpDir, 'MEMORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'custom-notes.md'))).toBe(true);
    });
  });

  // ── before_tool_call path redirect logic ──────────────────────────

  describe('path redirect logic for OC built-in tools', () => {
    /**
     * Simulates the path redirect logic from index.ts before_tool_call hook.
     * This is the same algorithm, extracted for testability.
     */
    const RELOCATABLE_FILES = new Set([
      'AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md',
      'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md',
    ]);

    function redirectPath(
      toolName: string,
      params: Record<string, unknown>,
      wsRoot: string,
    ): { params: { path: string } } | Record<string, never> {
      if (toolName !== 'read' && toolName !== 'write' && toolName !== 'edit') {
        return {};
      }
      const rawPath =
        typeof params.path === 'string' ? params.path :
        typeof params.file_path === 'string' ? params.file_path :
        undefined;
      if (!rawPath) return {};
      const basename = path.basename(rawPath);
      if (!RELOCATABLE_FILES.has(basename) || rawPath !== basename) return {};
      const rcPath = path.join(wsRoot, '.ResearchClaw', basename);
      if (fs.existsSync(rcPath)) {
        return { params: { path: `.ResearchClaw/${basename}` } };
      }
      return {};
    }

    it('redirects read("HEARTBEAT.md") to .ResearchClaw/', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.writeFileSync(path.join(rcDir, 'HEARTBEAT.md'), '# HB');

      const result = redirectPath('read', { path: 'HEARTBEAT.md' }, tmpDir);
      expect(result).toEqual({ params: { path: '.ResearchClaw/HEARTBEAT.md' } });
    });

    it('redirects read with file_path param', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.writeFileSync(path.join(rcDir, 'AGENTS.md'), '# A');

      const result = redirectPath('read', { file_path: 'AGENTS.md' }, tmpDir);
      expect(result).toEqual({ params: { path: '.ResearchClaw/AGENTS.md' } });
    });

    it('redirects write("SOUL.md") to .ResearchClaw/', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.writeFileSync(path.join(rcDir, 'SOUL.md'), '# Soul');

      const result = redirectPath('write', { path: 'SOUL.md', content: 'new' }, tmpDir);
      expect(result).toEqual({ params: { path: '.ResearchClaw/SOUL.md' } });
    });

    it('redirects edit("TOOLS.md") to .ResearchClaw/', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.writeFileSync(path.join(rcDir, 'TOOLS.md'), '# Tools');

      const result = redirectPath('edit', { path: 'TOOLS.md' }, tmpDir);
      expect(result).toEqual({ params: { path: '.ResearchClaw/TOOLS.md' } });
    });

    it('does NOT redirect nested paths like outputs/HEARTBEAT.md', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.writeFileSync(path.join(rcDir, 'HEARTBEAT.md'), '# HB');

      const result = redirectPath('read', { path: 'outputs/HEARTBEAT.md' }, tmpDir);
      expect(result).toEqual({});
    });

    it('does NOT redirect non-relocatable files', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.writeFileSync(path.join(rcDir, 'random.md'), '# Random');

      const result = redirectPath('read', { path: 'random.md' }, tmpDir);
      expect(result).toEqual({});
    });

    it('does NOT redirect when .ResearchClaw/ file does not exist', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      // .ResearchClaw/ exists but HEARTBEAT.md is NOT in it
      const result = redirectPath('read', { path: 'HEARTBEAT.md' }, tmpDir);
      expect(result).toEqual({});
    });

    it('does NOT redirect for non-read/write/edit tools', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      const rcDir = path.join(tmpDir, '.ResearchClaw');
      fs.writeFileSync(path.join(rcDir, 'HEARTBEAT.md'), '# HB');

      expect(redirectPath('exec', { path: 'HEARTBEAT.md' }, tmpDir)).toEqual({});
      expect(redirectPath('workspace_read', { path: 'HEARTBEAT.md' }, tmpDir)).toEqual({});
      expect(redirectPath('search', { path: 'HEARTBEAT.md' }, tmpDir)).toEqual({});
    });

    it('all 7 relocatable files are covered', async () => {
      svc = new WorkspaceService(makeConfig(tmpDir));
      await svc.init();
      const rcDir = path.join(tmpDir, '.ResearchClaw');

      const all = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];
      for (const f of all) {
        fs.writeFileSync(path.join(rcDir, f), `content of ${f}`);
        const result = redirectPath('read', { path: f }, tmpDir);
        expect(result).toEqual({ params: { path: `.ResearchClaw/${f}` } });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tool-level tests (exercises tool execute() → service → filesystem)
// ---------------------------------------------------------------------------

describe('Workspace tool-level functional tests', () => {
  let tmpDir: string;
  let svc: WorkspaceService;
  let tools: ReturnType<typeof createWorkspaceTools>;

  function findTool(name: string) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  }

  beforeEach(async () => {
    tmpDir = makeTempDir();
    svc = new WorkspaceService(makeConfig(tmpDir));
    await svc.init();
    tools = createWorkspaceTools(svc);
  });

  afterEach(() => {
    if (svc) svc.destroy();
    cleanup(tmpDir);
  });

  // ── workspace_save overwrite detection ─────────────────────────────

  describe('workspace_save overwrite detection', () => {
    it('does not show overwrite warning for new files', async () => {
      const tool = findTool('workspace_save');
      const result = await tool.execute('t1', {
        path: 'outputs/test.md',
        content: '# New file',
      });
      const text = getToolText(result);
      expect(text).toContain('Saved');
      expect(text).not.toContain('Overwrote');
    });

    it('shows overwrite warning for existing files', async () => {
      const tool = findTool('workspace_save');
      await tool.execute('t1', {
        path: 'outputs/test.md',
        content: '# Original',
      });

      const result = await tool.execute('t2', {
        path: 'outputs/test.md',
        content: '# Updated',
      });
      const text = getToolText(result);
      expect(text).toContain('Overwrote existing file');
      expect(text).toContain('git history');
    });
  });

  // ── workspace_delete tool ──────────────────────────────────────────

  describe('workspace_delete', () => {
    it('rejects without confirm=true', async () => {
      const tool = findTool('workspace_delete');
      await svc.save('file.md', 'content');

      const result = await tool.execute('t1', {
        path: 'file.md',
        confirm: false,
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('confirm must be true');

      // File should still exist
      const readResult = await svc.read('file.md');
      expect(readResult.content).toBe('content');
    });

    it('deletes with confirm=true', async () => {
      const tool = findTool('workspace_delete');
      await svc.save('file.md', 'content');

      const result = await tool.execute('t1', {
        path: 'file.md',
        confirm: true,
      });
      const text = getToolText(result);
      expect(text).toContain('Deleted');
      expect(text).not.toContain('Error');

      // File should be gone
      await expect(svc.read('file.md')).rejects.toThrow();
    });

    it('rejects deleting non-existent file', async () => {
      const tool = findTool('workspace_delete');
      const result = await tool.execute('t1', {
        path: 'nonexistent.md',
        confirm: true,
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
    });

    it('rejects empty path', async () => {
      const tool = findTool('workspace_delete');
      const result = await tool.execute('t1', {
        path: '',
        confirm: true,
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
    });
  });

  // ── workspace_append tool ──────────────────────────────────────────

  describe('workspace_append', () => {
    it('creates new file when target does not exist', async () => {
      const tool = findTool('workspace_append');
      const result = await tool.execute('t1', {
        path: 'outputs/log.md',
        content: 'First entry',
      });
      const text = getToolText(result);
      expect(text).toContain('Appended');
      expect(text).toContain('file_card');

      const readResult = await svc.read('outputs/log.md');
      expect(readResult.content).toBe('First entry');
    });

    it('appends to existing file with default separator', async () => {
      const tool = findTool('workspace_append');
      await svc.save('outputs/log.md', 'Line 1');

      await tool.execute('t1', {
        path: 'outputs/log.md',
        content: 'Line 2',
      });

      const readResult = await svc.read('outputs/log.md');
      expect(readResult.content).toBe('Line 1\n\nLine 2');
    });

    it('uses custom separator', async () => {
      const tool = findTool('workspace_append');
      await svc.save('outputs/data.csv', 'a,b,c');

      await tool.execute('t1', {
        path: 'outputs/data.csv',
        content: '1,2,3',
        separator: '\n',
      });

      const readResult = await svc.read('outputs/data.csv');
      expect(readResult.content).toBe('a,b,c\n1,2,3');
    });

    it('rejects binary extensions', async () => {
      const tool = findTool('workspace_append');
      const result = await tool.execute('t1', {
        path: 'file.pdf',
        content: 'text',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('binary');
    });

    it('handles multiple sequential appends', async () => {
      const tool = findTool('workspace_append');

      await tool.execute('t1', { path: 'outputs/refs.bib', content: '@article{ref1}' });
      await tool.execute('t2', { path: 'outputs/refs.bib', content: '@article{ref2}' });
      await tool.execute('t3', { path: 'outputs/refs.bib', content: '@article{ref3}' });

      const readResult = await svc.read('outputs/refs.bib');
      expect(readResult.content).toBe('@article{ref1}\n\n@article{ref2}\n\n@article{ref3}');
    });
  });

  // ── workspace_download SSRF guard ──────────────────────────────────

  describe('workspace_download SSRF guard', () => {
    it('blocks localhost', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://localhost:8080/secret',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('Blocked');
    });

    it('blocks 127.0.0.1', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://127.0.0.1/admin',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('private');
    });

    it('blocks cloud metadata IP (169.254.169.254)', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://169.254.169.254/latest/meta-data/',
        path: 'sources/secret.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('private');
    });

    it('blocks 10.x.x.x private range', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://10.0.0.1/internal-api',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('private');
    });

    it('blocks 192.168.x.x private range', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://192.168.1.1/router',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('private');
    });

    it('blocks 172.16-31.x.x private range', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://172.17.0.1/docker',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('private');
    });

    it('blocks 0.0.0.0', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://0.0.0.0/',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('Blocked');
    });

    it('blocks metadata.google.internal', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://metadata.google.internal/computeMetadata/v1/',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('Blocked');
    });

    it('blocks IPv4-mapped IPv6 (::ffff:127.0.0.1)', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://[::ffff:127.0.0.1]/',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      // URL parser normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1 (hex),
      // so it hits the "block all IPv6 literals" path, not the mapped-IPv4 path
      expect(text).toContain('IPv6');
    });

    it('blocks IPv4-mapped IPv6 metadata (::ffff:169.254.169.254)', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://[::ffff:169.254.169.254]/latest/meta-data/',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('IPv6');
    });

    it('blocks generic IPv6 literal addresses', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://[fe80::1]/internal',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('IPv6');
    });

    it('blocks IPv6 loopback ::1', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'http://[::1]/',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('Blocked');
    });

    it('blocks non-HTTP protocols', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'ftp://files.example.com/data.csv',
        path: 'sources/data.csv',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('HTTP');
    });

    it('rejects invalid URL format', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: 'not-a-url',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
    });

    it('rejects empty url', async () => {
      const tool = findTool('workspace_download');
      const result = await tool.execute('t1', {
        url: '',
        path: 'sources/test.txt',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
    });
  });

  // ── workspace_move tool integration ────────────────────────────────

  describe('workspace_move tool', () => {
    it('rejects move to existing destination via tool', async () => {
      const tool = findTool('workspace_move');
      await svc.save('a.md', 'A');
      await svc.save('b.md', 'B');

      const result = await tool.execute('t1', {
        from: 'a.md',
        to: 'b.md',
      });
      const text = getToolText(result);
      expect(text).toContain('Error');
      expect(text).toContain('already exists');
    });
  });
});
