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
