import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROBE_ROOT = path.join(
  ROOT,
  'scripts',
  'acceptance',
  'windows-update-backup-probe',
);

function read(name: string): string {
  return fs.readFileSync(path.join(PROBE_ROOT, name), 'utf8');
}

describe('Windows update backup phase probe', () => {
  it('ships an ASCII, no-pause, credential-free double-click chain', () => {
    const names = [
      'README.txt',
      'Run-Wentor-Update-Backup-Probe.cmd',
      'Run-Wentor-Update-Backup-Probe.ps1',
      'probe-update-backup.sh',
      'SHA256SUMS.txt',
    ];
    for (const name of names) {
      const file = path.join(PROBE_ROOT, name);
      expect(fs.statSync(file).isFile(), name).toBe(true);
      expect([...fs.readFileSync(file)].every((byte) => byte <= 0x7f), name).toBe(true);
    }
    const source = names.map(read).join('\n');
    expect(source).not.toMatch(/rca_[A-Za-z0-9_-]{43,}/);
    expect(source).not.toMatch(/(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/m);
    expect(source).not.toMatch(/Read-Host|Console\.Read|Console\.ReadKey|^\s*pause\s*$/im);
  });

  it('binds every executable package member to SHA256SUMS', () => {
    const lines = read('SHA256SUMS.txt').trim().split('\n');
    const expected = [
      'README.txt',
      'Run-Wentor-Update-Backup-Probe.cmd',
      'Run-Wentor-Update-Backup-Probe.ps1',
      'probe-update-backup.sh',
    ].sort();
    const actual: string[] = [];
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
      expect(match, line).not.toBeNull();
      const [, digest, name] = match!;
      actual.push(name);
      const bytes = fs.readFileSync(path.join(PROBE_ROOT, name));
      expect(crypto.createHash('sha256').update(bytes).digest('hex'), name).toBe(digest);
    }
    expect(actual.sort()).toEqual(expected);
  });

  it('mirrors the production backup primitives and reports each boundary without file contents', () => {
    const shell = read('probe-update-backup.sh');
    expect(shell).toContain('mktemp -d');
    expect(shell).toContain('chmod 700');
    expect(shell).toContain("stat -c '%u'");
    expect(shell).toContain("stat -c '%a'");
    expect(shell).toContain("stat -c '%d:%i'");
    expect(shell).toContain('cp -p');
    expect(shell).toContain('rm -rf');
    expect(shell).toContain('workspace/.ResearchClaw/SOUL.md');
    expect(shell).toContain('workspace/.ResearchClaw/BOOTSTRAP.md.done');
    expect(shell).not.toMatch(/cat\s+--?\s*"?\$?_source|head\s+|tail\s+/);
    expect(shell).toContain('source_type=');
    expect(shell).toContain('copy_exit=');
    expect(shell).toContain('root_mode=');
    expect(shell).toContain('root_owner=');
  });

  it('uses the same ACL-private task-root boundary as the production Windows wrapper', () => {
    const launcher = read('Run-Wentor-Update-Backup-Probe.ps1');
    expect(launcher).toContain("'Wentor\\InstallerTemp'");
    expect(launcher).toContain("'/inheritance:r'");
    expect(launcher).toContain("'*S-1-5-18:(OI)(CI)F'");
    expect(launcher).toContain("'*S-1-5-32-544:(OI)(CI)F'");
    expect(launcher).toContain("$env:TMPDIR = $taskPosix");
    expect(launcher).toContain("$env:RC_WINDOWS_NATIVE = '1'");
    expect(launcher).toContain('Wentor\\ProbeReports');
    expect(launcher).toContain('Remove-Item -LiteralPath $taskRoot -Recurse -Force');
  });
});
