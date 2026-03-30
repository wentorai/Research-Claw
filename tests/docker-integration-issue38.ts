/**
 * Docker Integration Test for Issue #38
 *
 * Tests the full workspace_save guard + workspace_export pipeline
 * inside the Docker container where pandoc + CJK fonts are available.
 *
 * Run: docker run --rm --entrypoint="" rc-test-issue38 npx tsx tests/docker-integration-issue38.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceService } from '../extensions/research-claw-core/src/workspace/service.js';
import { createWorkspaceTools } from '../extensions/research-claw-core/src/workspace/tools.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-e2e-'));

function resultText(r: unknown): string {
  return (r as { content: Array<{ text: string }> })?.content?.[0]?.text ?? '';
}
function isErr(r: unknown): boolean {
  return resultText(r).startsWith('Error:');
}

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function run() {
  const svc = new WorkspaceService({
    root: tmpDir,
    autoTrackGit: false,
    commitDebounceMs: 0,
    maxGitFileSize: 10 * 1024 * 1024,
    maxUploadSize: 50 * 1024 * 1024,
    gitAuthorName: 'Test',
    gitAuthorEmail: 'test@test.com',
  });
  await svc.init();

  const tools = createWorkspaceTools(svc);
  const saveTool = tools.find((t) => t.name === 'workspace_save')!;
  const exportTool = tools.find((t) => t.name === 'workspace_export')!;

  // --- Test 1: Guard rejects .docx write ---
  console.log('\n=== Test 1: workspace_save rejects .docx ===');
  const r1 = await saveTool.execute('t1', { path: 'paper.docx', content: '# Test' });
  assert('Rejects .docx write', isErr(r1));
  assert('Error mentions workspace_export', resultText(r1).includes('workspace_export'));
  assert('Error mentions .md alternative', resultText(r1).includes('.md'));
  assert('No file created on disk', !fs.existsSync(path.join(tmpDir, 'paper.docx')));

  // --- Test 2: Guard rejects .xlsx write ---
  console.log('\n=== Test 2: workspace_save rejects .xlsx ===');
  const r2 = await saveTool.execute('t2', { path: 'data.xlsx', content: 'col1,col2' });
  assert('Rejects .xlsx write', isErr(r2));
  assert('Error mentions .csv alternative', resultText(r2).includes('.csv'));

  // --- Test 3: workspace_save allows .md ---
  console.log('\n=== Test 3: workspace_save allows .md ===');
  const mdContent = [
    '# 聚合物电解质改性方法总结',
    '',
    '## 1. 引言',
    '',
    '聚合物电解质是一类重要的功能材料，广泛应用于锂离子电池、燃料电池等领域。',
    '',
    '## 2. 改性方法',
    '',
    '### 2.1 交联改性',
    '',
    '通过化学交联提高聚合物电解质的机械强度。添加 SiO₂ 纳米粒子。',
    '',
    '## 参考文献',
    '',
    '1. Zhang et al., *Advanced Energy Materials*, 2024.',
    '2. 王明等，《高分子学报》，2023.',
  ].join('\n');
  const r3 = await saveTool.execute('t3', { path: 'outputs/drafts/paper.md', content: mdContent });
  assert('Saves .md successfully', !isErr(r3));
  assert('File exists on disk', fs.existsSync(path.join(tmpDir, 'outputs/drafts/paper.md')));

  // --- Test 4: workspace_export md → docx ---
  console.log('\n=== Test 4: workspace_export md → docx ===');
  const r4 = await exportTool.execute('t4', {
    source: 'outputs/drafts/paper.md',
    format: 'docx',
  });
  assert('Export succeeds', !isErr(r4), resultText(r4));

  const docxPath = path.join(tmpDir, 'outputs/exports/paper.docx');
  assert('Output file exists', fs.existsSync(docxPath));

  if (fs.existsSync(docxPath)) {
    const buf = fs.readFileSync(docxPath);
    assert('File size > 0', buf.length > 0);
    assert('Valid ZIP header (PK)', buf[0] === 0x50 && buf[1] === 0x4b);

    // Verify OOXML structure
    const zipCheck = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(zipCheck.execFile);
    try {
      const { stdout } = await exec('python3', [
        '-c',
        `import zipfile; z=zipfile.ZipFile("${docxPath}"); names=z.namelist(); ` +
        `print("OK" if "[Content_Types].xml" in names and "word/document.xml" in names else "FAIL"); ` +
        `doc=z.read("word/document.xml").decode("utf-8"); ` +
        `print("CJK_OK" if "聚合物电解质" in doc else "CJK_FAIL"); z.close()`,
      ]);
      assert('Valid OOXML structure', stdout.includes('OK'));
      assert('Chinese text preserved in docx', stdout.includes('CJK_OK'));
    } catch (e) {
      assert('Python ZIP validation', false, String(e));
    }
  }

  // --- Test 5: workspace_export md → docx with custom output path ---
  console.log('\n=== Test 5: workspace_export with custom output ===');
  const r5 = await exportTool.execute('t5', {
    source: 'outputs/drafts/paper.md',
    format: 'docx',
    output: 'outputs/exports/custom-name.docx',
  });
  assert('Custom output succeeds', !isErr(r5));
  assert('Custom output file exists', fs.existsSync(path.join(tmpDir, 'outputs/exports/custom-name.docx')));

  // --- Test 6: workspace_export csv → xlsx ---
  console.log('\n=== Test 6: workspace_export csv → xlsx ===');
  const csvContent = '方法,离子电导率,强度\n交联,0.0012,45\n共混,0.00085,38';
  await saveTool.execute('t6a', { path: 'data.csv', content: csvContent });
  const r6 = await exportTool.execute('t6', { source: 'data.csv', format: 'xlsx' });
  assert('CSV→XLSX succeeds', !isErr(r6), resultText(r6));
  const xlsxPath = path.join(tmpDir, 'outputs/exports/data.xlsx');
  assert('XLSX file exists', fs.existsSync(xlsxPath));
  if (fs.existsSync(xlsxPath)) {
    const buf = fs.readFileSync(xlsxPath);
    assert('XLSX has ZIP header', buf[0] === 0x50 && buf[1] === 0x4b);
  }

  // --- Test 7: workspace_export rejects unsupported format ---
  console.log('\n=== Test 7: Rejects unsupported format ===');
  const r7 = await exportTool.execute('t7', { source: 'outputs/drafts/paper.md', format: 'rtf' });
  assert('Rejects unsupported format', isErr(r7));

  // --- Test 8: workspace_export rejects invalid source for format ---
  console.log('\n=== Test 8: Rejects invalid source for format ===');
  const r8 = await exportTool.execute('t8', { source: 'outputs/drafts/paper.md', format: 'xlsx' });
  assert('Rejects md→xlsx', isErr(r8));
  assert('Error mentions valid source formats', resultText(r8).includes('.csv'));

  // --- Test 9: workspace_export rejects non-existent source ---
  console.log('\n=== Test 9: Rejects non-existent source ===');
  const r9 = await exportTool.execute('t9', { source: 'nonexistent.md', format: 'docx' });
  assert('Rejects missing source', isErr(r9));
  assert('Error mentions not found', resultText(r9).includes('not found'));

  // --- Cleanup ---
  svc.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // --- Summary ---
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All integration tests PASSED');
  }
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
