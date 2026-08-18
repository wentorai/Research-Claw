import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const CAPTURE_ROOT = path.join(
  ROOT,
  'scripts',
  'acceptance',
  'windows-native-ux-capture',
);
const CORE = path.join(CAPTURE_ROOT, 'capture-windows-native-ux.cjs');
const HOST_SNAPSHOT = path.join(CAPTURE_ROOT, 'Capture-Wentor-UX-Host.ps1');
const LAUNCHER = path.join(CAPTURE_ROOT, 'Run-Wentor-UX-Capture.ps1');
const CMD = path.join(CAPTURE_ROOT, 'Run-Wentor-UX-Capture.cmd');
const SUMS = path.join(CAPTURE_ROOT, 'SHA256SUMS.txt');

function read(name: string): string {
  return fs.readFileSync(path.join(CAPTURE_ROOT, name), 'utf8');
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('Windows native UX read-only capture package', () => {
  it('passes its platform-independent behavior and redaction self-test', () => {
    const result = spawnSync(process.execPath, [CORE, '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, cases: 11 });
  });

  it('ships an ASCII, no-pause double-click chain with no embedded credential', () => {
    const names = [
      'README.txt',
      'Run-Wentor-UX-Capture.cmd',
      'Run-Wentor-UX-Capture.ps1',
      'Capture-Wentor-UX-Host.ps1',
      'capture-windows-native-ux.cjs',
      'SHA256SUMS.txt',
    ];
    for (const name of names) {
      expect(fs.statSync(path.join(CAPTURE_ROOT, name)).isFile(), name).toBe(true);
    }
    for (const name of ['Run-Wentor-UX-Capture.cmd', 'Run-Wentor-UX-Capture.ps1', 'Capture-Wentor-UX-Host.ps1']) {
      const bytes = fs.readFileSync(path.join(CAPTURE_ROOT, name));
      expect([...bytes].every((byte) => byte <= 0x7f), name).toBe(true);
    }
    const source = names.map(read).join('\n');
    expect(source).not.toMatch(/rca_[A-Za-z0-9_-]{43,}/);
    expect(source).not.toMatch(/(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/m);
    expect(source).not.toMatch(/Authorization\s*:\s*Bearer\s+\S+/i);
    expect(read('Run-Wentor-UX-Capture.cmd')).not.toMatch(/^\s*pause\s*$/im);
    expect(source).not.toMatch(/Read-Host|Console\.Read|Console\.ReadKey|choice\.exe/i);
  });

  it('captures exact listener identity without emitting raw command lines or stopping processes', () => {
    const source = read('Capture-Wentor-UX-Host.ps1');
    expect(source).toContain('Get-NetTCPConnection');
    expect(source).toContain('CreationDate');
    expect(source).toContain('OwningProcess');
    expect(source).toContain('commandLineContainsRcRoot');
    expect(source).toContain('executableUnderWentorRuntime');
    expect(source).not.toContain('commandLine =');
    expect(source).not.toMatch(/Stop-Process|taskkill|Terminate\(|Win32Shutdown/i);
    expect(read('capture-windows-native-ux.cjs')).not.toMatch(/process\.kill|taskkill|Stop-Process/);
  });

  it('requires native x64 Desktop 5.1 and Core 7 observations instead of shell aliases', () => {
    const source = read('capture-windows-native-ux.cjs');
    expect(source).toContain('shellContractGreen');
    expect(source).toContain("desktop.powershell.edition === 'Desktop'");
    expect(source).toContain('desktop.powershell.major === 5');
    expect(source).toContain("core.powershell.edition === 'Core'");
    expect(source).toContain('core.powershell.major === 7');
    expect(source).toContain("item.powershell?.processorArchitecture === 'AMD64'");
  });

  it('tests all loopback names and reports dispatch acceptance without claiming the browser opened', () => {
    const source = read('capture-windows-native-ux.cjs');
    expect(source).toContain('http://127.0.0.1:28789/');
    expect(source).toContain('http://localhost:28789/');
    expect(source).toContain("const ASCII_ALIAS = 'xn--w8yz0bg0vrjz.localhost'");
    expect(source).toContain('const BRAND_ALIAS_URL = `http://${ASCII_ALIAS}:28789/`');
    expect(source).toContain("displayUrl: 'http://科研龙虾.localhost:28789/'");
    expect(source).toContain('dispatchAccepted');
    expect(source).not.toContain('browserOpened');
    expect(read('Capture-Wentor-UX-Host.ps1')).toContain('Start-Process');
  });

  it('uses a real Chromium browser for the brand alias instead of treating Node DNS as browser authority', () => {
    const source = read('capture-windows-native-ux.cjs');
    expect(source).toContain('browserAliasObservation');
    expect(source).toContain("'--headless=new'");
    expect(source).toContain("'--dump-dom'");
    expect(source).toContain('WentorOS · Research-Claw');
    expect(source).toContain('browserAliasGreen');
    expect(source).toContain('fs.mkdtempSync');
    expect(source).toContain('fs.rmSync(browserProbeRoot');
  });

  it('finds the user-level Wentor PortableGit before declaring source authority unavailable', () => {
    const source = read('capture-windows-native-ux.cjs');
    expect(source).toContain('findGitExecutable');
    expect(source).toContain("'Wentor', 'Runtimes'");
    expect(source).toContain("entry.name.startsWith('PortableGit-')");
    expect(source).toContain("'bin', 'git.exe'");
    expect(source).toContain("'cmd', 'git.exe'");
  });

  it('binds PASS to the frozen production commit, clean status, and shared-file tuple', () => {
    const source = read('capture-windows-native-ux.cjs');
    expect(source).toContain("const EXPECTED_SOURCE_COMMIT = '5015be7a72387098f122cb3e7cc4aae32714d4fa'");
    expect(source).toContain("'scripts/install-windows.ps1': '2f76c8c4307e0cb68e8ed3c8fe51edb7a59ebd50ba4f019e55e88a052b8de93b'");
    expect(source).toContain("'scripts/install.sh': 'afa18713e02740288e986b8fd1c7b1a6e203c4503ca4f72fd6c501da4a3d5c57'");
    expect(source).toContain("'scripts/run.sh': '220d13f82e17cf74d029744915c743f17acf715d701c8861f89b0ebcc9aebc8f'");
    expect(source).toContain("'scripts/ensure-config.cjs': '690e576e8bb8d2851170ba1b6f4ae18411c497089081adfd9ccdc1a17bd80c11'");
    expect(source).toContain('sourceAuthorityObservation');
    expect(source).toContain('sourceAuthorityGreen');
  });

  it('keeps the live capture read-only and excludes configuration or credential reads', () => {
    const source = [read('capture-windows-native-ux.cjs'), read('Capture-Wentor-UX-Host.ps1')].join('\n');
    expect(source).not.toMatch(/openclaw\.json|auth-profiles|credentials|setup.?token|model.?key/i);
    expect(source).toContain('writeEvidenceExclusive');
    expect(source).not.toMatch(/unlinkSync|renameSync|copyFileSync/);
    expect(source.match(/fs\.rmSync\(/g)).toHaveLength(1);
    expect(source).toContain('fs.rmSync(browserProbeRoot');
    expect(source).not.toMatch(/Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item/i);
  });

  it('binds every package member to the checked-in SHA256SUMS file', () => {
    const lines = fs.readFileSync(SUMS, 'utf8').trim().split('\n');
    const expectedMembers = [
      'README.txt',
      'Run-Wentor-UX-Capture.cmd',
      'Run-Wentor-UX-Capture.ps1',
      'Capture-Wentor-UX-Host.ps1',
      'capture-windows-native-ux.cjs',
    ].sort();
    const actualMembers: string[] = [];
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
      expect(match, line).not.toBeNull();
      const [, digest, name] = match!;
      actualMembers.push(name);
      expect(sha256(path.join(CAPTURE_ROOT, name)), name).toBe(digest);
    }
    expect(actualMembers.sort()).toEqual(expectedMembers);
  });
});
