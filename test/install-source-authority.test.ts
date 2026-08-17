import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function createRemote(root: string, name: string, marker: string): string {
  const source = path.join(root, `${name}-source`);
  const bare = path.join(root, `${name}.git`);
  fs.mkdirSync(source);
  git(source, ['init', '--quiet', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'RC Source Authority Test']);
  git(source, ['config', 'user.email', 'rc-source-authority@invalid.example']);
  fs.writeFileSync(path.join(source, 'authority.txt'), `${marker}\n`);
  git(source, ['add', 'authority.txt']);
  git(source, ['commit', '--quiet', '-m', marker]);
  git(root, ['clone', '--quiet', '--bare', source, bare]);
  return bare;
}

function extractUpdate(source: string): string {
  const startText = '# --- [5/8] Clone or update ---';
  const endText = '\nensure_ppt_master\n';
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('native installer source authority', () => {
  it.skipIf(process.platform === 'win32')(
    'ignores a foreign existing origin and resets to the exact official main FETCH_HEAD',
    () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-source-authority-'));
      roots.push(sandbox);
      const foreign = createRemote(sandbox, 'foreign', 'foreign-untrusted');
      const gitee = createRemote(sandbox, 'gitee', 'official-gitee');
      const github = createRemote(sandbox, 'github', 'official-github');
      const install = path.join(sandbox, 'install');
      git(sandbox, ['clone', '--quiet', foreign, install]);

      const updater = extractUpdate(fs.readFileSync(INSTALLER, 'utf8'));
      const runner = path.join(sandbox, 'runner.sh');
      fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="$RC_TEST_INSTALL"
GITEE_REPO="$RC_TEST_GITEE"
GITHUB_REPO="$RC_TEST_GITHUB"
REPO_OVERRIDE=''
UPDATE_FAILED=false
RC_UPDATE_MUTATION_STARTED=false
info() { :; }
ok() { :; }
warn() { printf 'WARN %s\\n' "$1"; }
die() { printf 'DIE %s\\n' "$1" >&2; exit 1; }
step() { :; }
run_with_heartbeat() { shift; "$@"; }
rc_install_snapshot_update_backup() { :; }
rc_install_restore_update_backup() { :; }
rc_install_discard_update_backup() { :; }
${updater}
`, { mode: 0o700 });

      const result = spawnSync('/bin/bash', [runner], {
        cwd: install,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: path.join(sandbox, 'home'),
          RC_TEST_INSTALL: install,
          RC_TEST_GITEE: gitee,
          RC_TEST_GITHUB: github,
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readFileSync(path.join(install, 'authority.txt'), 'utf8')).toBe(
        'official-gitee\n',
      );
      expect(git(install, ['rev-parse', 'HEAD'])).toBe(
        git(path.join(sandbox, 'gitee-source'), ['rev-parse', 'HEAD']),
      );
      expect(result.stdout).toMatch(/foreign.*origin.*ignored/i);
    },
  );
});
