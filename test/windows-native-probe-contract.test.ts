import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROBE_ROOT = path.join(
  ROOT,
  'scripts',
  'acceptance',
  'windows-native-probe',
);
const PROBE = path.join(PROBE_ROOT, 'probe-windows-native.cjs');

describe('Windows native full-chain probe package', () => {
  it('passes its platform-independent redaction self-test', () => {
    const result = spawnSync(process.execPath, [PROBE, '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, cases: 5 });
  });

  it('ships a double-click launcher without embedded credentials', () => {
    const files = [
      'Run-Wentor-Probe.cmd',
      'Run-Wentor-Probe.ps1',
      'README.txt',
      'probe-windows-native.cjs',
    ];
    for (const name of files) {
      expect(fs.statSync(path.join(PROBE_ROOT, name)).isFile()).toBe(true);
    }
    const launchers = files
      .map((name) => fs.readFileSync(path.join(PROBE_ROOT, name), 'utf8'))
      .join('\n');
    expect(launchers).not.toMatch(/rca_[A-Za-z0-9_-]{43,}/);
    expect(launchers).not.toMatch(/(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/m);
    expect(launchers).not.toMatch(/Authorization\s*:\s*Bearer\s+\S+/i);
    expect(launchers).not.toContain('AuthToken');
  });

  it('keeps every mutating product check inside an isolated root', () => {
    const source = fs.readFileSync(PROBE, 'utf8');
    expect(source).toContain("'NativeProbe', runId");
    expect(source).toContain("'isolated-home'");
    expect(source).toContain("'isolated-test-runtime'");
    expect(source).not.toContain('--auth-token');
  });

  it('forces Node 22, disables Git GUI prompts, and keeps safe tar operands relative', () => {
    const source = fs.readFileSync(PROBE, 'utf8');
    const launcher = fs.readFileSync(
      path.join(PROBE_ROOT, 'Run-Wentor-Probe.ps1'),
      'utf8',
    );
    expect(launcher.indexOf("-Filter 'node-v22*'")).toBeLessThan(
      launcher.indexOf('Get-Command node.exe'),
    );
    expect(launcher).toContain('-p process.versions.node');
    expect(launcher).toContain('-p process.versions.modules');
    expect(launcher).toContain('-p process.arch');
    expect(launcher).toContain("$nodeVersion -match '^22\\.'");
    expect(launcher).not.toContain("process.versions.node.split(\"");
    expect(source).toContain("safe.GCM_INTERACTIVE = 'Never'");
    expect(source).toContain("'credential.helper='");
    expect(source).toContain('relativeTarPath(relativeStage, fixtureArchive)');
    expect(source).toContain('relativeTarPath(extractDir, packedArchive)');
    expect(source).toContain('probe-homedir.cjs');
    expect(source).toContain('both release remotes are unavailable');
  });
});
