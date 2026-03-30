/**
 * workspace-export Unit Tests
 *
 * Tests for Issue #38 fix:
 * 1. Binary format guard in workspace_save (rejects .docx, .xlsx, .pdf, etc.)
 * 2. workspace_export tool parameter validation
 * 3. export-convert module logic
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { WorkspaceService, type WorkspaceConfig } from '../workspace/service.js';
import { createWorkspaceTools } from '../workspace/tools.js';
import {
  isSupportedFormat,
  isValidSource,
  validSourceExts,
  SUPPORTED_FORMATS,
} from '../workspace/export-convert.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ws-export-test-'));
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

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Extract the text content from a tool result. */
function resultText(result: unknown): string {
  const r = result as { content?: Array<{ text?: string }> };
  return r?.content?.[0]?.text ?? '';
}

/** Check if a tool result is an error. */
function isError(result: unknown): boolean {
  return resultText(result).startsWith('Error:');
}

// ---------------------------------------------------------------------------
// Test Suite: Binary Save Guard
// ---------------------------------------------------------------------------

describe('workspace_save binary guard (Issue #38)', () => {
  let tmpDir: string;
  let svc: WorkspaceService;
  let saveTool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

  beforeEach(async () => {
    tmpDir = makeTempDir();
    svc = new WorkspaceService(makeConfig(tmpDir));
    await svc.init();
    const tools = createWorkspaceTools(svc);
    saveTool = tools.find((t) => t.name === 'workspace_save')!;
  });

  afterEach(() => {
    svc.destroy();
    cleanup(tmpDir);
  });

  it('rejects .docx writes with helpful error message', async () => {
    const result = await saveTool.execute('test', {
      path: 'outputs/drafts/paper.docx',
      content: '# My Paper\n\nThis is a test.',
    });
    expect(isError(result)).toBe(true);
    const text = resultText(result);
    expect(text).toContain('binary format');
    expect(text).toContain('workspace_export');
    expect(text).toContain('.md');
  });

  it('rejects .xlsx writes', async () => {
    const result = await saveTool.execute('test', {
      path: 'data.xlsx',
      content: 'col1,col2\n1,2',
    });
    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain('.csv');
  });

  it('rejects .pdf writes', async () => {
    const result = await saveTool.execute('test', {
      path: 'outputs/exports/report.pdf',
      content: 'Some text',
    });
    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain('binary format');
  });

  it('rejects .pptx writes', async () => {
    const result = await saveTool.execute('test', {
      path: 'slides.pptx',
      content: 'Slide content',
    });
    expect(isError(result)).toBe(true);
  });

  it('rejects .png writes', async () => {
    const result = await saveTool.execute('test', {
      path: 'figure.png',
      content: 'not a real image',
    });
    expect(isError(result)).toBe(true);
  });

  it('allows .md writes (text format)', async () => {
    const result = await saveTool.execute('test', {
      path: 'outputs/drafts/paper.md',
      content: '# My Paper\n\nThis is a test.',
    });
    expect(isError(result)).toBe(false);
    expect(resultText(result)).toContain('Saved');
  });

  it('allows .csv writes (text format)', async () => {
    const result = await saveTool.execute('test', {
      path: 'data.csv',
      content: 'col1,col2\n1,2',
    });
    expect(isError(result)).toBe(false);
  });

  it('allows .tex writes (text format)', async () => {
    const result = await saveTool.execute('test', {
      path: 'paper.tex',
      content: '\\documentclass{article}',
    });
    expect(isError(result)).toBe(false);
  });

  it('allows .bib writes (text format)', async () => {
    const result = await saveTool.execute('test', {
      path: 'refs.bib',
      content: '@article{key, title={Test}}',
    });
    expect(isError(result)).toBe(false);
  });

  it('guard error message includes correct workflow steps', async () => {
    const result = await saveTool.execute('test', {
      path: 'outputs/exports/summary.docx',
      content: '# Summary',
    });
    const text = resultText(result);
    // Should suggest saving as .md first
    expect(text).toContain('workspace_save');
    expect(text).toContain('.md');
    // Should suggest using workspace_export
    expect(text).toContain('workspace_export');
    expect(text).toContain('docx');
  });

  it('does not create the file on disk when guard rejects', async () => {
    await saveTool.execute('test', {
      path: 'should-not-exist.docx',
      content: 'test',
    });
    expect(fs.existsSync(path.join(tmpDir, 'should-not-exist.docx'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test Suite: workspace_export tool parameter validation
// ---------------------------------------------------------------------------

describe('workspace_export parameter validation', () => {
  let tmpDir: string;
  let svc: WorkspaceService;
  let exportTool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

  beforeEach(async () => {
    tmpDir = makeTempDir();
    svc = new WorkspaceService(makeConfig(tmpDir));
    await svc.init();
    const tools = createWorkspaceTools(svc);
    exportTool = tools.find((t) => t.name === 'workspace_export')!;
  });

  afterEach(() => {
    svc.destroy();
    cleanup(tmpDir);
  });

  it('workspace_export tool is registered', () => {
    expect(exportTool).toBeDefined();
    expect(exportTool.execute).toBeTypeOf('function');
  });

  it('rejects missing source parameter', async () => {
    const result = await exportTool.execute('test', { format: 'docx' });
    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain('source');
  });

  it('rejects missing format parameter', async () => {
    const result = await exportTool.execute('test', { source: 'file.md' });
    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain('format');
  });

  it('rejects unsupported format', async () => {
    const result = await exportTool.execute('test', {
      source: 'file.md',
      format: 'rtf',
    });
    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain('Unsupported');
  });

  it('rejects invalid source extension for target format', async () => {
    // .py cannot be converted to docx
    fs.writeFileSync(path.join(tmpDir, 'script.py'), 'print("hello")');
    const result = await exportTool.execute('test', {
      source: 'script.py',
      format: 'docx',
    });
    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain('Cannot convert');
  });

  it('rejects non-existent source file', async () => {
    const result = await exportTool.execute('test', {
      source: 'nonexistent.md',
      format: 'docx',
    });
    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// Test Suite: export-convert module
// ---------------------------------------------------------------------------

describe('export-convert module', () => {
  it('SUPPORTED_FORMATS includes docx, pdf, xlsx', () => {
    expect(SUPPORTED_FORMATS).toContain('docx');
    expect(SUPPORTED_FORMATS).toContain('pdf');
    expect(SUPPORTED_FORMATS).toContain('xlsx');
  });

  it('isSupportedFormat returns true for valid formats', () => {
    expect(isSupportedFormat('docx')).toBe(true);
    expect(isSupportedFormat('pdf')).toBe(true);
    expect(isSupportedFormat('xlsx')).toBe(true);
  });

  it('isSupportedFormat returns false for unknown formats', () => {
    expect(isSupportedFormat('rtf')).toBe(false);
    expect(isSupportedFormat('odt')).toBe(false);
    expect(isSupportedFormat('pptx')).toBe(false);
  });

  it('isValidSource returns true for md→docx', () => {
    expect(isValidSource('paper.md', 'docx')).toBe(true);
  });

  it('isValidSource returns true for csv→xlsx', () => {
    expect(isValidSource('data.csv', 'xlsx')).toBe(true);
  });

  it('isValidSource returns false for py→docx', () => {
    expect(isValidSource('script.py', 'docx')).toBe(false);
  });

  it('isValidSource returns false for xlsx→docx', () => {
    expect(isValidSource('data.xlsx', 'docx')).toBe(false);
  });

  it('validSourceExts returns correct list for docx', () => {
    const exts = validSourceExts('docx');
    expect(exts).toContain('.md');
    expect(exts).toContain('.txt');
    expect(exts).not.toContain('.py');
  });

  it('validSourceExts returns correct list for xlsx', () => {
    const exts = validSourceExts('xlsx');
    expect(exts).toContain('.csv');
    expect(exts).toContain('.json');
    expect(exts).not.toContain('.md');
  });

  it('validSourceExts returns empty for unknown format', () => {
    expect(validSourceExts('unknown')).toEqual([]);
  });
});
