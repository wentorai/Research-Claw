import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_WORKSPACE = 'extensions/research-claw-core/workspace';
const RUNTIME_WORKSPACE_PROBE = `${RUNTIME_WORKSPACE}/.gitignore-probe`;

describe('repository submodule structure', () => {
  it('does not track the generated core runtime workspace as a gitlink', () => {
    const staged = execFileSync(
      'git',
      ['ls-files', '--stage', '--', RUNTIME_WORKSPACE],
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();

    expect(staged).toBe('');
  });

  it('ignores the runtime workspace without inventing a submodule mapping', () => {
    const ignored = spawnSync(
      'git',
      ['check-ignore', '--no-index', '--verbose', RUNTIME_WORKSPACE_PROBE],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(ignored.status, ignored.stderr).toBe(0);
    expect(ignored.stdout.trim().split('\t')[0]).toMatch(
      /^\.gitignore:\d+:\/extensions\/research-claw-core\/workspace\/$/,
    );

    const gitmodules = fs.readFileSync(path.join(ROOT, '.gitmodules'), 'utf8');
    expect(gitmodules).not.toContain(RUNTIME_WORKSPACE);
  });

  it('can traverse every real submodule without a missing mapping error', () => {
    const result = spawnSync(
      'git',
      ['submodule', 'foreach', '--recursive', ':'],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(
      execFileSync('git', ['submodule', 'status', '--recursive'], {
        cwd: ROOT,
        encoding: 'utf8',
      }),
    ).toContain('ppt-master');
  });
});

