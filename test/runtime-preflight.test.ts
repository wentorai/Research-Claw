import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PREFLIGHT = path.join(ROOT, 'scripts', 'runtime-preflight.cjs');
const RUNTIME = path.join(ROOT, 'scripts', 'node-runtime.cjs');

describe('Core runtime preflight', () => {
  it('validates native ABI, core build, and the configured database read-only', () => {
    const runtime = JSON.parse(execFileSync(process.execPath, [RUNTIME, 'resolve'], { encoding: 'utf8' }));
    const output = execFileSync(runtime.path, [
      PREFLIGHT,
      '--root', ROOT,
      '--config', path.join(ROOT, 'config', 'openclaw.json'),
      '--require-build',
      '--json',
    ], { encoding: 'utf8' });
    const result = JSON.parse(output);

    expect(result.ok).toBe(true);
    expect(result.abi).toBe('127');
    expect(result.database.quickCheck).toMatch(/^(ok|new)$/);
    expect(result.coreBuild).toMatch(/research-claw-core\/dist\/index\.js$/);
  });

  it('fails closed before startup when the Core build is absent', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-preflight-'));
    try {
      fs.mkdirSync(path.join(temp, 'extensions', 'research-claw-core'), { recursive: true });
      fs.writeFileSync(path.join(temp, 'extensions', 'research-claw-core', 'index.ts'), 'export {};\n');
      fs.mkdirSync(path.join(temp, 'config'), { recursive: true });
      fs.writeFileSync(path.join(temp, 'config', 'openclaw.json'), '{}\n');
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(temp, 'node_modules'));
      const runtime = JSON.parse(execFileSync(process.execPath, [RUNTIME, 'resolve'], { encoding: 'utf8' }));
      const result = spawnSync(runtime.path, [PREFLIGHT, '--root', temp, '--require-build'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(78);
      expect(result.stderr).toContain('CORE_BUILD_MISSING');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('makes extension build failure fatal in the launcher', () => {
    const launcher = fs.readFileSync(path.join(ROOT, 'scripts', 'run.sh'), 'utf8');
    expect(launcher).toContain('native-runtime-guard.cjs');
    expect(launcher).toContain('--repair-native-abi');
    expect(launcher).toMatch(/Extension build failed[\s\S]*exit 78/);
    expect(launcher).toContain('--require-build');
  });
});
