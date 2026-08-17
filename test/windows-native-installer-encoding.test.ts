import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-windows.ps1');
const VERIFIER = path.join(
  ROOT,
  'scripts',
  'verify-native-windows-installer-encoding.ps1',
);
const WORKFLOW = path.join(
  ROOT,
  '.github',
  'workflows',
  'windows-installer-contract.yml',
);
const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

describe('native Windows installer byte encoding', () => {
  it('is strict UTF-8 with a BOM for Windows PowerShell 5.1 on DBCS hosts', () => {
    const bytes = fs.readFileSync(INSTALLER);
    expect(bytes.subarray(0, UTF8_BOM.length)).toEqual(UTF8_BOM);

    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(UTF8_BOM.length),
    );
    expect(text).toMatch(/[^\u0000-\u007F]/u);
    expect(text).not.toContain('\uFFFD');
    expect(text.startsWith('param([string]$AuthToken)')).toBe(true);
  });

  it('is parsed from the same byte snapshot by PS5.1 and PS7 on Windows x64', () => {
    const verifier = fs.readFileSync(VERIFIER, 'utf8');
    expect(verifier).toContain('[System.IO.File]::ReadAllBytes($resolved)');
    expect(verifier).toContain('$bytes[0] -ne 0xEF');
    expect(verifier).toContain('New-Object System.Text.UTF8Encoding($false, $true)');
    expect(verifier).toContain(
      '[System.Management.Automation.Language.Parser]::ParseInput',
    );
    expect(verifier).toContain("$processorArchitecture -cne 'AMD64'");
    expect(verifier).toContain('$PSVersionTable.PSEdition -cne $ExpectedEdition');
    expect(verifier).toContain('$PSVersionTable.PSVersion.Major -ne $ExpectedMajorVersion');

    const workflow = fs.readFileSync(WORKFLOW, 'utf8');
    const calls = workflow.match(
      /verify-native-windows-installer-encoding\.ps1/g,
    ) ?? [];
    expect(calls).toHaveLength(2);
    expect(workflow).toContain(
      '-ExpectedEdition Desktop -ExpectedMajorVersion 5',
    );
    expect(workflow).toContain('-ExpectedEdition Core -ExpectedMajorVersion 7');
  });

  it('prevents QuickEdit from suspending the shared installer and gateway console', () => {
    const installer = fs.readFileSync(INSTALLER, 'utf8');

    expect(installer).toContain('function Disable-ConsoleQuickEdit');
    expect(installer).toContain('function Restore-ConsoleInputMode');
    expect(installer).toContain('ENABLE_QUICK_EDIT_MODE = 0x0040');
    expect(installer).toContain('ENABLE_EXTENDED_FLAGS = 0x0080');
    expect(installer).toContain('GetConsoleMode');
    expect(installer).toContain('SetConsoleMode');
    expect(installer).toContain('$script:ConsoleOriginalMode');
    expect(installer).toContain('$script:ConsoleModeManaged = Disable-ConsoleQuickEdit');
    expect(installer).toContain('Restore-ConsoleInputMode');

    const disableIndex = installer.indexOf(
      '$script:ConsoleModeManaged = Disable-ConsoleQuickEdit',
    );
    const bashIndex = installer.indexOf('& $bash @arguments');
    const restoreIndex = installer.lastIndexOf('Restore-ConsoleInputMode');
    expect(disableIndex).toBeGreaterThan(0);
    expect(disableIndex).toBeLessThan(bashIndex);
    expect(restoreIndex).toBeGreaterThan(bashIndex);
  });
});
