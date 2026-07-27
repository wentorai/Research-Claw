import { describe, expect, it } from 'vitest';
import { desktopOpenCommand } from '../workspace/rpc.js';

describe('workspace desktop-open command', () => {
  it('uses PowerShell Start-Process on Windows instead of explorer.exe exit codes', () => {
    const hostilePath = String.raw`C:\研究\x & calc.exe & y.pdf`;
    const command = desktopOpenCommand('win32', hostilePath);

    expect(command.file).toBe('powershell.exe');
    expect(command.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Start-Process -FilePath $args[0]',
      hostilePath,
    ]);
    expect(command.args).not.toContain('cmd.exe');
    expect(command.args).not.toContain('explorer.exe');
  });

  it.each([
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ] as const)('keeps %s paths as one inert argv element', (platform, executable) => {
    const hostilePath = '/tmp/x$(touch pwn).pdf';
    expect(desktopOpenCommand(platform, hostilePath)).toEqual({
      file: executable,
      args: [hostilePath],
    });
  });
});
