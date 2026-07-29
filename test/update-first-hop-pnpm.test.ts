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
const BRIDGE = path.join(
  ROOT,
  'scripts',
  'prepare-package-manager.cjs',
);

describe('first-hop pnpm update bridge', () => {
  it('is wired into the package prepare lifecycle', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: { prepare?: string } };

    expect(packageJson.scripts?.prepare).toBe(
      'node scripts/prepare-package-manager.cjs',
    );
    expect(existsSync(BRIDGE)).toBe(true);
  });

  it('normalizes a pnpm 9 install through the exact project pnpm', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-first-hop-'));
    const prefix = path.join(tempRoot, 'pnpm');
    const cli = path.join(
      prefix,
      'lib',
      'node_modules',
      'pnpm',
      'bin',
      'pnpm.cjs',
    );
    const calls = path.join(tempRoot, 'calls.log');

    try {
      mkdirSync(path.dirname(cli), { recursive: true });
      writeFileSync(
        cli,
        `'use strict';
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  process.stdout.write('10.34.4\\n');
  process.exit(0);
}
fs.appendFileSync(process.env.PNPM_RUNS, process.argv.slice(2).join(' ') + '\\n');
`,
      );

      const result = spawnSync(process.execPath, [BRIDGE], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_user_agent: 'pnpm/9.15.9 npm/? node/v22.22.2',
          PNPM_RUNS: calls,
          RC_PNPM_PREFIX: prefix,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe(
        'install --no-frozen-lockfile --ignore-scripts\n',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not recurse when prepare already runs under pnpm 10.34.4', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-first-hop-'));
    const prefix = path.join(tempRoot, 'pnpm');

    try {
      const result = spawnSync(process.execPath, [BRIDGE], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_user_agent: 'pnpm/10.34.4 npm/? node/v22.22.2',
          RC_PNPM_PREFIX: prefix,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(prefix)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
