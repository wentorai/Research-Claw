/**
 * PPT Service Unit Tests
 *
 * Tests path validation, input sanitization, and filesystem operations
 * using a real temp directory. Does NOT require Python or ppt-master scripts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PptService } from '../extensions/research-claw-core/src/ppt/service.js';

let tmpDir: string;
let pptRoot: string;
let workspaceRoot: string;
let repoRoot: string;
let service: PptService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-test-'));
  pptRoot = path.join(tmpDir, 'ppt-master');
  workspaceRoot = path.join(tmpDir, 'workspace');
  repoRoot = tmpDir;

  // Create minimal directory structure
  fs.mkdirSync(pptRoot, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

  service = new PptService({ pptRoot, workspaceRoot, repoRoot });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── getStatus ─────────────────────────────────────────────────────────

describe('getStatus', () => {
  it('reports missing scripts when ppt-master dir is empty', () => {
    const status = service.getStatus();
    expect(status.pptRoot).toBe(pptRoot);
    expect(status.exists).toBe(true);
    expect(status.hasProjectManager).toBe(false);
    expect(status.hasSvgToPptx).toBe(false);
  });

  it('reports scripts present when they exist', () => {
    const scriptsDir = path.join(pptRoot, 'skills', 'ppt-master', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'project_manager.py'), '# stub');
    fs.writeFileSync(path.join(scriptsDir, 'svg_to_pptx.py'), '# stub');

    const status = service.getStatus();
    expect(status.hasProjectManager).toBe(true);
    expect(status.hasSvgToPptx).toBe(true);
  });
});

// ── initProject input validation ──────────────────────────────────────

describe('initProject input validation', () => {
  it('rejects empty projectName', async () => {
    await expect(service.initProject({ projectName: '  ' })).rejects.toThrow('projectName is required');
  });

  it('rejects unsafe characters in projectName', async () => {
    await expect(service.initProject({ projectName: '../escape' })).rejects.toThrow('must only contain');
    await expect(service.initProject({ projectName: 'foo bar' })).rejects.toThrow('must only contain');
    await expect(service.initProject({ projectName: 'hello;rm' })).rejects.toThrow('must only contain');
  });

  it('accepts valid projectName characters', async () => {
    // Will fail because python script doesn't exist, but should pass validation
    await expect(service.initProject({ projectName: 'my-deck_v2.0' })).rejects.toThrow();
    // Should NOT throw about projectName validation
    try {
      await service.initProject({ projectName: 'my-deck_v2.0' });
    } catch (e) {
      expect((e as Error).message).not.toContain('must only contain');
    }
  });
});

// ── exportProject path validation ─────────────────────────────────────

describe('exportProject path validation', () => {
  it('rejects absolute projectPath', async () => {
    await expect(service.exportProject({ projectPath: '/etc/passwd' }))
      .rejects.toThrow('relative path');
  });

  it('rejects path traversal with ..', async () => {
    await expect(service.exportProject({ projectPath: '../../../etc/passwd' }))
      .rejects.toThrow('relative path');
  });

  it('rejects null bytes', async () => {
    await expect(service.exportProject({ projectPath: 'test\0evil' }))
      .rejects.toThrow('relative path');
  });

  it('rejects non-existent projectPath', async () => {
    await expect(service.exportProject({ projectPath: 'projects/nope' }))
      .rejects.toThrow('not found');
  });
});

// ── openOutput path validation ────────────────────────────────────────

describe('openOutput path validation', () => {
  it('rejects empty filePath', async () => {
    await expect(service.openOutput('')).rejects.toThrow('filePath is required');
  });

  it('rejects path outside pptRoot and workspace outputs', async () => {
    await expect(service.openOutput('/etc/passwd'))
      .rejects.toThrow('must be under pptRoot or workspace outputs');
  });

  it('rejects non-existent file under pptRoot', async () => {
    await expect(service.openOutput(path.join(pptRoot, 'nope.pptx')))
      .rejects.toThrow('does not exist');
  });
});

// ── renameOutputFile ──────────────────────────────────────────────────

describe('renameOutputFile', () => {
  it('rejects inputPath outside workspace/outputs', async () => {
    await expect(service.renameOutputFile('/tmp/evil.pptx', 'renamed'))
      .rejects.toThrow('must be under workspace/outputs');
  });

  it('rejects non-pptx inputPath', async () => {
    const txt = path.join(workspaceRoot, 'outputs', 'test.txt');
    fs.writeFileSync(txt, 'hello');
    await expect(service.renameOutputFile(txt, 'renamed'))
      .rejects.toThrow('must be a .pptx file');
  });

  it('rejects empty desiredBaseName', async () => {
    const pptx = path.join(workspaceRoot, 'outputs', 'test.pptx');
    fs.writeFileSync(pptx, 'fake-pptx');
    await expect(service.renameOutputFile(pptx, '   '))
      .rejects.toThrow('desiredBaseName is required');
  });

  it('renames a valid pptx file with sanitized name + timestamp', async () => {
    const pptx = path.join(workspaceRoot, 'outputs', 'test.pptx');
    fs.writeFileSync(pptx, 'fake-pptx-content');

    const result = await service.renameOutputFile(pptx, 'my-report.pdf');
    expect(result.ok).toBe(true);
    expect(result.oldPath).toBe(pptx);
    expect(result.newPath).toContain('my-report');
    expect(result.newPath).toMatch(/\.pptx$/);
    // Old file should be gone
    expect(fs.existsSync(pptx)).toBe(false);
    // New file should exist
    expect(fs.existsSync(result.newPath)).toBe(true);
    expect(fs.readFileSync(result.newPath, 'utf-8')).toBe('fake-pptx-content');
  });

  it('handles CJK characters in desiredBaseName', async () => {
    const pptx = path.join(workspaceRoot, 'outputs', 'test2.pptx');
    fs.writeFileSync(pptx, 'fake');

    const result = await service.renameOutputFile(pptx, '研究报告');
    expect(result.ok).toBe(true);
    expect(result.newPath).toContain('研究报告');
    expect(fs.existsSync(result.newPath)).toBe(true);
  });
});

// ── listWorkspaceOutputs ──────────────────────────────────────────────

describe('listWorkspaceOutputs', () => {
  it('returns empty list for empty outputs directory', () => {
    const result = service.listWorkspaceOutputs();
    expect(result.files).toEqual([]);
    expect(result.root).toBe(path.join(workspaceRoot, 'outputs'));
  });

  it('lists files sorted by mtime (newest first)', () => {
    const outputsDir = path.join(workspaceRoot, 'outputs');
    const f1 = path.join(outputsDir, 'old.pptx');
    const f2 = path.join(outputsDir, 'new.pptx');

    fs.writeFileSync(f1, 'old');
    // Ensure different mtime
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(f1, past, past);
    fs.writeFileSync(f2, 'new');

    const result = service.listWorkspaceOutputs();
    expect(result.files).toHaveLength(2);
    // Newest first
    expect(result.files[0]).toBe(f2);
    expect(result.files[1]).toBe(f1);
  });

  it('recurses into subdirectories', () => {
    const subDir = path.join(workspaceRoot, 'outputs', 'ppt', '2026-03-30');
    fs.mkdirSync(subDir, { recursive: true });
    const f = path.join(subDir, 'deck.pptx');
    fs.writeFileSync(f, 'data');

    const result = service.listWorkspaceOutputs();
    expect(result.files).toContain(f);
  });
});

// ── constructor scaffolding ───────────────────────────────────────────

describe('constructor', () => {
  it('creates outputs directories on init', () => {
    const fresh = path.join(tmpDir, 'fresh-ws');
    // No pre-existing dirs
    expect(fs.existsSync(fresh)).toBe(false);

    new PptService({
      pptRoot: path.join(tmpDir, 'fresh-ppt'),
      workspaceRoot: fresh,
      repoRoot: tmpDir,
    });

    expect(fs.existsSync(path.join(fresh, 'outputs'))).toBe(true);
    expect(fs.existsSync(path.join(fresh, 'outputs', 'ppt'))).toBe(true);
  });
});
