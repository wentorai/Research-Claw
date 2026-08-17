import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROBE_ROOT = path.join(
  ROOT,
  'scripts',
  'acceptance',
  'windows-runtime-probe',
);
const PROBE = path.join(PROBE_ROOT, 'probe-windows-runtime.cjs');

describe('Windows post-install runtime probe package', () => {
  it('passes its platform-independent safety self-test', () => {
    const result = spawnSync(process.execPath, [PROBE, '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, cases: 8 });
  });

  it('ships ASCII-only launchers with a pinned probe and no credential', () => {
    const files = [
      'README.txt',
      'Inspect-Wentor-Gateway.ps1',
      'Run-Wentor-Runtime-Probe.cmd',
      'Run-Wentor-Runtime-Probe.ps1',
      'SHA256SUMS.txt',
      'probe-windows-runtime.cjs',
    ];
    for (const name of files) {
      expect(fs.statSync(path.join(PROBE_ROOT, name)).isFile()).toBe(true);
    }
    for (const name of files.filter((value) => value.endsWith('.cmd') || value.endsWith('.ps1'))) {
      const bytes = fs.readFileSync(path.join(PROBE_ROOT, name));
      expect([...bytes].every((byte) => byte > 0 && byte < 0x80)).toBe(true);
    }
    const launcher = fs.readFileSync(
      path.join(PROBE_ROOT, 'Run-Wentor-Runtime-Probe.ps1'),
      'utf8',
    );
    expect(launcher.match(/__EXPECTED_HEAD__/g)).toHaveLength(1);
    const pinned = launcher.match(/\$probeSha256 = '([0-9a-f]{64})'/)?.[1];
    expect(pinned).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(PROBE)).digest('hex'),
    );
    const helper = path.join(PROBE_ROOT, 'Inspect-Wentor-Gateway.ps1');
    const helperPinned = launcher.match(
      /\$processHelperSha256 = '([0-9a-f]{64})'/,
    )?.[1];
    expect(helperPinned).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),
    );
    const combined = files
      .map((name) => fs.readFileSync(path.join(PROBE_ROOT, name), 'utf8'))
      .join('\n');
    const operatorFiles = files
      .filter((name) => name !== 'probe-windows-runtime.cjs')
      .map((name) => fs.readFileSync(path.join(PROBE_ROOT, name), 'utf8'))
      .join('\n');
    expect(combined).not.toMatch(/rca_[A-Za-z0-9_-]{43,}/);
    expect(combined).not.toMatch(/(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/m);
    expect(operatorFiles).not.toMatch(/Authorization\s*:\s*Bearer\s+\S+/i);
  });

  it('probes the real post-authentication RPC and stable gateway liveness', () => {
    const source = fs.readFileSync(PROBE, 'utf8');
    expect(source).toContain("method: 'config.get'");
    expect(source).toContain("timedRequest('health'");
    expect(source).toContain("frame.event === 'tick'");
    expect(source).toContain('CONFIG_GET_TIMEOUT_MS = 35_000');
    expect(source).toContain('STABILITY_WINDOW_MS = 75_000');
    expect(source).toContain("const clientId = 'gateway-client'");
    expect(source).toContain("mode: 'backend'");
    expect(source).not.toContain("headers: { Origin:");
    expect(source).toContain("stdio: ['ignore', 'pipe', 'pipe']");
    expect(source).toContain("consoleScope: 'gateway-process-console-direct'");
    expect(source).toContain('gitDescendantCount');
    expect(source).toContain('quickEditEnabled === false');
    expect(source).not.toContain('process.stdin');
    const helperSource = fs.readFileSync(
      path.join(PROBE_ROOT, 'Inspect-Wentor-Gateway.ps1'),
      'utf8',
    );
    expect(helperSource).toContain('AttachConsole');
    expect(helperSource).toContain('CreateFileW');
    expect(helperSource).toContain('CONIN$');
    expect(helperSource).toContain('GetConsoleMode');
    expect(helperSource).toContain('CloseHandle');
    expect(helperSource).toContain('ProcessId, ParentProcessId, Name');
    expect(helperSource).not.toMatch(/CommandLine|EnvironmentVariables/i);
  });

  it('publishes only sanitized evidence and treats Ready as insufficient', () => {
    const source = fs.readFileSync(PROBE, 'utf8');
    expect(source).toContain('installTransactionGreen');
    expect(source).toContain('dashboardRuntimeGreen');
    expect(source).toContain('sanitizeLogTail');
    expect(source).toContain('Refusing to publish a report containing a secret shape');
    expect(source).toContain('consoleInputMode');
    expect(source).toContain('quickEditEnabled');
    expect(source).toContain('installerTimeline');
  });
});
