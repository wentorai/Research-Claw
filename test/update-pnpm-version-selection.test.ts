import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-pnpm.cjs');

function writeJavaScriptCli(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

describe('update pnpm runner', () => {
  it('executes npm and pnpm JavaScript CLIs without Windows shell wrappers', () => {
    const source = readFileSync(RUNNER, 'utf8');

    expect(source).not.toMatch(/\b(?:npm|pnpm)\.cmd\b/);
    expect(source).not.toMatch(/shell\s*:\s*true/);
    expect(source).toMatch(
      /const pnpmCli = process\.platform === 'win32'/,
    );
    expect(source).toContain(
      "path.join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')",
    );
    expect(source).toContain(
      "path.join(prefix, 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')",
    );
    expect(source).toMatch(
      /spawnSync\(\s*process\.execPath,\s*\[\s*npmCli,/,
    );
    expect(source).toMatch(
      /spawnSync\(\s*process\.execPath,\s*\[\s*pnpmCli,/,
    );
  });

  it('replaces an old isolated pnpm before executing the requested command', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-update-pnpm-'));
    const fakeBin = path.join(tempRoot, 'bin');
    const privatePrefix = path.join(tempRoot, 'private-pnpm');
    const privateCli = path.join(
      privatePrefix,
      'lib',
      'node_modules',
      'pnpm',
      'bin',
      'pnpm.cjs',
    );
    const npmCli = path.join(fakeBin, 'npm-cli.cjs');
    const npmCalls = path.join(tempRoot, 'npm-calls.log');
    const pnpmRuns = path.join(tempRoot, 'pnpm-runs.log');

    try {
      writeJavaScriptCli(
        privateCli,
        `'use strict';
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  process.stdout.write('9.15.9\\n');
  process.exit(0);
}
fs.appendFileSync(process.env.PNPM_RUNS, \`OLD:\${process.argv.slice(2).join(' ')}\\n\`);
`,
      );
      writeJavaScriptCli(
        npmCli,
        `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_CALLS, \`\${args.join(' ')}\\n\`);
const prefixIndex = args.indexOf('--prefix');
if (prefixIndex < 0 || !args[prefixIndex + 1]) process.exit(98);
const cli = path.join(
  args[prefixIndex + 1],
  'lib',
  'node_modules',
  'pnpm',
  'bin',
  'pnpm.cjs',
);
fs.mkdirSync(path.dirname(cli), { recursive: true });
fs.writeFileSync(cli, \`'use strict';
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  process.stdout.write('10.34.4\\\\n');
  process.exit(0);
}
fs.appendFileSync(process.env.PNPM_RUNS, process.argv.slice(2).join(' ') + '\\\\n');
\`);
`,
      );

      const result = spawnSync(
        process.execPath,
        [RUNNER, 'install', '--frozen-lockfile'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: tempRoot,
            NPM_CALLS: npmCalls,
            PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
            PNPM_RUNS: pnpmRuns,
            RC_NPM_CLI: npmCli,
            RC_PNPM_PREFIX: privatePrefix,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(npmCalls), result.stdout).toBe(true);
      expect(readFileSync(npmCalls, 'utf8')).toContain(
        `install --prefix ${privatePrefix} -g pnpm@10.34.4`,
      );
      expect(readFileSync(pnpmRuns, 'utf8')).toBe(
        'install --frozen-lockfile\n',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reuses an exact isolated pnpm without invoking npm', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-update-pnpm-'));
    const fakeBin = path.join(tempRoot, 'bin');
    const privatePrefix = path.join(tempRoot, 'private-pnpm');
    const privateCli = path.join(
      privatePrefix,
      'lib',
      'node_modules',
      'pnpm',
      'bin',
      'pnpm.cjs',
    );
    const npmCli = path.join(fakeBin, 'npm-cli.cjs');
    const pnpmRuns = path.join(tempRoot, 'pnpm-runs.log');

    try {
      writeJavaScriptCli(
        npmCli,
        "'use strict';\nprocess.exit(97);\n",
      );
      writeJavaScriptCli(
        privateCli,
        `'use strict';
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  process.stdout.write('10.34.4\\n');
  process.exit(0);
}
fs.appendFileSync(process.env.PNPM_RUNS, \`\${process.argv.slice(2).join(' ')}\\n\`);
`,
      );

      const result = spawnSync(process.execPath, [RUNNER, 'build'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tempRoot,
          PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          PNPM_RUNS: pnpmRuns,
          RC_NPM_CLI: npmCli,
          RC_PNPM_PREFIX: privatePrefix,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(pnpmRuns, 'utf8')).toBe('build\n');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
