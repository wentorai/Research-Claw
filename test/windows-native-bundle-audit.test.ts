import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const AUDITOR = path.join(ROOT, 'scripts', 'audit_windows_bundle.py');

describe('Windows native offline bundle auditor', () => {
  it('rejects its permanent package-regression fixtures', () => {
    const result = spawnSync('python3', [AUDITOR, '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, cases: 7 });
  });

  it('pins the approved offline runtime byte identities', () => {
    const source = fs.readFileSync(AUDITOR, 'utf8');
    expect(source).toContain('7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c');
    expect(source).toContain('016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5');
    expect(source).toContain('56b8cc9f4971cef253644fafe54063ed7fdca551d4dee0f8c6baa81b855acd72');
    expect(source).toContain('duplicate or case-colliding ZIP member');
    expect(source).toContain('PowerShell member is not UTF-8 with BOM');
    expect(source).toContain('CMD launcher is not ASCII-only');
    expect(source).toContain('private package must contain exactly one Setup Token');
    expect(source).toContain('private package must contain zero embedded model API keys');
  });
});
