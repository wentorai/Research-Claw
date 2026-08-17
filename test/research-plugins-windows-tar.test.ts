import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const {
  tarExtractionInvocation,
} = require(path.join(ROOT, 'scripts', 'install-research-plugins.cjs')) as {
  tarExtractionInvocation: (
    archive: string,
    stageDir: string,
    workDir: string,
    platform?: NodeJS.Platform,
  ) => { executable: string; args: string[]; cwd: string };
};

describe('Research-plugins package extraction', () => {
  it('uses a drive-safe relative tar operand on native Windows', () => {
    const command = tarExtractionInvocation(
      'C:\\Users\\Liv\\AppData\\Local\\Temp\\rc\\pack\\research-plugins.tgz',
      'C:\\Users\\Liv\\AppData\\Local\\Temp\\rc\\stage',
      'C:\\Users\\Liv\\AppData\\Local\\Temp\\rc',
      'win32',
    );

    expect(command).toEqual({
      executable: 'tar.exe',
      args: ['-xzf', '../pack/research-plugins.tgz', '--strip-components=1'],
      cwd: 'C:\\Users\\Liv\\AppData\\Local\\Temp\\rc\\stage',
    });
    expect(command.args.join(' ')).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(command.args).not.toContain('-C');
  });

  it('fails closed when a Windows archive cannot be made relative to the stage drive', () => {
    expect(() => tarExtractionInvocation(
      'D:\\pack\\research-plugins.tgz',
      'C:\\stage',
      'C:\\work',
      'win32',
    )).toThrow(/same Windows drive/i);
  });

  it('preserves the established POSIX tar invocation', () => {
    expect(tarExtractionInvocation(
      '/tmp/rc/pack/research-plugins.tgz',
      '/tmp/rc/stage',
      '/tmp/rc',
      'darwin',
    )).toEqual({
      executable: 'tar',
      args: [
        '-xzf',
        '/tmp/rc/pack/research-plugins.tgz',
        '--strip-components=1',
        '-C',
        '/tmp/rc/stage',
      ],
      cwd: '/tmp/rc',
    });
  });
});
