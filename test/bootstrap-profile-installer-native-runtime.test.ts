import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install.sh');
const roots: string[] = [];
const userFiles = [
  'workspace/.ResearchClaw/SOUL.md',
  'workspace/.ResearchClaw/IDENTITY.md',
  'workspace/.ResearchClaw/TOOLS.md',
  'workspace/.ResearchClaw/USER.md',
  'workspace/MEMORY.md',
  'workspace/USER.md',
  'workspace/.ResearchClaw/BOOTSTRAP.md.done',
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  return result.stdout;
}

function extractBetween(source: string, startText: string, endText: string): string {
  const start = source.indexOf(startText);
  expect(start, `missing installer anchor: ${startText}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endText, start);
  expect(end, `missing installer anchor: ${endText}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function writeBlockingGit(bin: string): void {
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
set -eu
subcommand=''
for arg in "$@"; do
  case "$arg" in -*) ;; *) subcommand="$arg"; break ;; esac
done
case "$subcommand" in
  reset)
    "$RC_TEST_REAL_GIT" "$@"
    touch "$RC_TEST_EVENTS/reset-complete"
    ;;
  clean)
    "$RC_TEST_REAL_GIT" "$@"
    touch "$RC_TEST_EVENTS/clean-complete"
    ;;
  pull)
    test -f "$RC_TEST_EVENTS/reset-complete"
    test -f "$RC_TEST_EVENTS/clean-complete"
    printf '%s\n' "$$" > "$RC_TEST_EVENTS/pull.pid"
    touch "$RC_TEST_EVENTS/pull-ready"
    trap 'touch "$RC_TEST_EVENTS/pull-stopped"; exit 143' TERM
    trap 'touch "$RC_TEST_EVENTS/pull-stopped"; exit 130' INT
    deadline=$((SECONDS + 20))
    while [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
    exit 70
    ;;
  *) exec "$RC_TEST_REAL_GIT" "$@" ;;
esac
`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'mktemp'), `#!/usr/bin/env bash
set -eu
if [ "$#" -eq 0 ]; then
  exec /usr/bin/mktemp "$TMPDIR/rc-test-mktemp.XXXXXX"
fi
if [ "$#" -eq 1 ] && [ "$1" = -d ]; then
  exec /usr/bin/mktemp -d "$TMPDIR/rc-test-mktemp.XXXXXX"
fi
exec /usr/bin/mktemp "$@"
`, { mode: 0o700 });
}

function writeNoisyGnuStat(bin: string): void {
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'stat'), `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$RC_TEST_STAT_LOG"
if [ "$1" = -f ]; then
  printf 'GNU_STAT_FAILED_BRANCH_NOISE\n'
  exit 1
fi
if [ "$1" = -c ]; then
  exec "$RC_TEST_NODE" -e '
    const fs = require("fs");
    const format = process.argv[1];
    const stat = fs.statSync(process.argv[2]);
    if (format === "%d:%i") process.stdout.write(String(stat.dev) + ":" + String(stat.ino));
    else if (format === "%u") process.stdout.write(String(stat.uid));
    else if (format === "%a") process.stdout.write((stat.mode & 0o777).toString(8));
    else process.exit(97);
  ' "$2" "$3"
fi
exit 96
`, { mode: 0o700 });
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function stopFixtureChild(pid: number): Promise<void> {
  if (!pidIsAlive(pid)) return;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && pidIsAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (pidIsAlive(pid)) process.kill(pid, 'SIGKILL');
}

describe('native installer update interruption cleanup', () => {
  it.skipIf(process.platform === 'win32')(
    'discards failed BSD stat output before using the GNU stat fallback',
    () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-native-gnu-stat-'));
      roots.push(sandbox);
      const install = path.join(sandbox, 'install');
      const temp = path.join(sandbox, 'tmp');
      const bin = path.join(sandbox, 'bin');
      const statLog = path.join(sandbox, 'stat.log');
      fs.mkdirSync(install, { mode: 0o700 });
      fs.mkdirSync(temp, { mode: 0o700 });
      writeNoisyGnuStat(bin);

      const installer = fs.readFileSync(INSTALLER, 'utf8');
      const lifecycle = extractBetween(
        installer,
        'RC_BOOTSTRAP_REDEEM_URL=',
        '\nrc_profile_parse_args "$@"',
      );
      const runner = path.join(sandbox, 'gnu-stat-runner.sh');
      fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="$RC_TEST_INSTALL"
R='' G='' C='' Y='' B='' D='' N=''
ISSUES_URL=https://invalid.example/issues
die() { exit 1; }
${lifecycle}
trap rc_install_exit_cleanup EXIT
test "$(rc_install_path_mode "$TMPDIR")" = 700
rc_install_snapshot_update_backup
test -n "$RC_UPDATE_BACKUP_ROOT"
rc_install_discard_update_backup
trap - EXIT
test -z "$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -print -quit)"
`, { mode: 0o700 });

      const result = spawnSync('/bin/bash', [runner], {
        cwd: install,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: path.join(sandbox, 'home'),
          TMPDIR: temp,
          RC_TEST_INSTALL: install,
          RC_TEST_NODE: process.execPath,
          RC_TEST_STAT_LOG: statLog,
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const calls = fs.readFileSync(statLog, 'utf8');
      expect(calls).toContain('-f %Lp');
      expect(calls).toContain('-c %a');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'roots the generated openclaw wrapper at the installation from any caller directory',
    () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-native-openclaw-wrapper-'));
      roots.push(sandbox);
      const install = path.join(sandbox, 'install');
      const home = path.join(sandbox, 'home');
      const caller = path.join(sandbox, 'unrelated-caller');
      const bin = path.join(install, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(home, { mode: 0o700 });
      fs.mkdirSync(caller, { mode: 0o700 });
      fs.mkdirSync(path.join(install, 'config'), { recursive: true });
      fs.writeFileSync(path.join(bin, 'openclaw'), `#!/bin/sh
printf 'CWD=%s\\nCONFIG=%s\\nARGS=%s\\n' "$PWD" "\${OPENCLAW_CONFIG_PATH-}" "$*"
`, { mode: 0o700 });

      const installer = fs.readFileSync(INSTALLER, 'utf8');
      const wrapperSection = extractBetween(
        installer,
        '# --- Ensure `openclaw` CLI is in PATH ---',
        '\nRC_CONFIG_CREATED=0',
      );
      const runner = path.join(sandbox, 'wrapper-runner.sh');
      fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="$RC_TEST_INSTALL"
ok() { :; }
${wrapperSection}
`, { mode: 0o700 });

      const generate = spawnSync('/bin/bash', [runner], {
        cwd: caller,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          RC_TEST_INSTALL: install,
        },
      });
      expect(generate.status, `${generate.stdout}\n${generate.stderr}`).toBe(0);

      const generatedWrapper = path.join(home, '.local', 'bin', 'openclaw');
      const invoked = spawnSync(generatedWrapper, ['config', 'validate', '--json'], {
        cwd: caller,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: home },
      });
      expect(invoked.status, `${invoked.stdout}\n${invoked.stderr}`).toBe(0);
      expect(invoked.stdout).toBe(
        `CWD=${install}\nCONFIG=${path.join(install, 'config', 'openclaw.json')}\nARGS=config validate --json\n`,
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'restores legacy user files and reaps heartbeat state after parent-only SIGINT',
    async () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-native-update-interrupt-'));
      roots.push(sandbox);
      const install = path.join(sandbox, 'install');
      const temp = path.join(sandbox, 'tmp');
      const events = path.join(sandbox, 'events');
      const bin = path.join(sandbox, 'bin');
      fs.mkdirSync(install, { recursive: true });
      fs.mkdirSync(temp, { mode: 0o700 });
      fs.mkdirSync(events, { mode: 0o700 });
      writeBlockingGit(bin);

      git(install, ['init', '--quiet']);
      git(install, ['config', 'user.name', 'RC Native Installer Test']);
      git(install, ['config', 'user.email', 'rc-native-installer-test@invalid.example']);
      fs.writeFileSync(path.join(install, '.gitignore'), 'node_modules/\n');
      const expected = new Map<string, string>();
      for (const [index, relative] of userFiles.entries()) {
        const file = path.join(install, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `baseline-${index}\n`);
      }
      git(install, ['add', '-f', '.gitignore', ...userFiles]);
      git(install, ['commit', '--quiet', '-m', 'legacy user files tracked']);
      for (const [index, relative] of userFiles.entries()) {
        const bytes = `user-owned-${index}-${'x'.repeat(index + 1)}\n`;
        fs.writeFileSync(path.join(install, relative), bytes);
        expected.set(relative, bytes);
      }
      const ordinaryUntracked = path.join(install, 'ordinary-untracked.txt');
      fs.writeFileSync(ordinaryUntracked, 'git clean control\n');
      const runnable = path.join(install, 'node_modules', 'openclaw', 'dist', 'entry.js');
      fs.mkdirSync(path.dirname(runnable), { recursive: true });
      fs.writeFileSync(runnable, '// fallback fixture\n');

      const installer = fs.readFileSync(INSTALLER, 'utf8');
      const heartbeat = extractBetween(
        installer,
        'run_with_heartbeat() {',
        '\n\nensure_ppt_master() {',
      );
      const update = extractBetween(
        installer,
        '# --- [5/8] Clone or update ---',
        '\nensure_ppt_master\n',
      );
      const lifecycleAnchor = '# ── Installer lifecycle cleanup';
      const lifecycleStart = installer.indexOf(lifecycleAnchor);
      const lifecycle = lifecycleStart < 0
        ? ''
        : extractBetween(installer, 'RC_BOOTSTRAP_REDEEM_URL=', '\nrc_profile_parse_args "$@"');
      const runner = path.join(sandbox, 'runner.sh');
      fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="$RC_TEST_INSTALL"
GITHUB_REPO=https://invalid.example/research-claw.git
UPDATE_FAILED=false
R='' G='' C='' Y='' B='' D='' N=''
ISSUES_URL=https://invalid.example/issues
RC_LOG=/dev/null
info() { :; }
ok() { :; }
warn() { :; }
step() { :; }
die() { printf 'fixture-die: %s\n' "$1" >&2; exit 1; }
${lifecycle}
${heartbeat}
if type rc_install_exit_cleanup >/dev/null 2>&1; then
  trap rc_install_exit_cleanup EXIT
  trap rc_install_on_interrupt INT TERM
else
  trap 'exit 130' INT TERM
fi
${update}
`, { mode: 0o700 });

      const child = spawn('/bin/bash', [runner], {
        cwd: install,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: path.join(sandbox, 'home'),
          TMPDIR: temp,
          RC_TEST_INSTALL: install,
          RC_TEST_EVENTS: events,
          RC_TEST_REAL_GIT: '/usr/bin/git',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      const exited = waitForExit(child);
      let pullPid = -1;
      let observed: Record<string, unknown> | undefined;
      try {
        await waitForPath(path.join(events, 'pull-ready'));
        pullPid = Number(fs.readFileSync(path.join(events, 'pull.pid'), 'utf8').trim());
        const checkpoint = Object.fromEntries(
          userFiles.map((relative, index) => [
            relative,
            fs.readFileSync(path.join(install, relative), 'utf8') === `baseline-${index}\n`,
          ]),
        );
        expect(child.kill('SIGINT')).toBe(true);
        const result = await Promise.race([
          exited,
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error('installer did not exit after SIGINT')),
            10_000,
          )),
        ]);
        const restored = Object.fromEntries(
          userFiles.map((relative) => [
            relative,
            fs.readFileSync(path.join(install, relative), 'utf8') === expected.get(relative),
          ]),
        );
        observed = {
          checkpoint,
          ordinaryUntrackedRemoved: !fs.existsSync(ordinaryUntracked),
          exit: result,
          restored,
          tempEntries: fs.readdirSync(temp).sort(),
          heartbeatAliveAtParentExit: pidIsAlive(pullPid),
          heartbeatStoppedAtParentExit: fs.existsSync(path.join(events, 'pull-stopped')),
        };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (pullPid > 0) await stopFixtureChild(pullPid);
      }

      expect(observed, `stdout:\n${stdout}\nstderr:\n${stderr}`).toEqual({
        checkpoint: Object.fromEntries(userFiles.map((relative) => [relative, true])),
        ordinaryUntrackedRemoved: true,
        exit: { code: 130, signal: null },
        restored: Object.fromEntries(userFiles.map((relative) => [relative, true])),
        tempEntries: [],
        heartbeatAliveAtParentExit: false,
        heartbeatStoppedAtParentExit: true,
      });
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'restores regular, symlink, and absent legacy user-file states without following links',
    () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-native-update-types-'));
      roots.push(sandbox);
      const install = path.join(sandbox, 'install');
      const temp = path.join(sandbox, 'tmp');
      const rcWorkspace = path.join(install, 'workspace', '.ResearchClaw');
      fs.mkdirSync(rcWorkspace, { recursive: true });
      fs.mkdirSync(temp, { mode: 0o700 });
      fs.writeFileSync(path.join(rcWorkspace, 'SOUL.target'), 'symlink-target-must-not-change\n');
      fs.symlinkSync('SOUL.target', path.join(rcWorkspace, 'SOUL.md'));
      fs.writeFileSync(path.join(rcWorkspace, 'IDENTITY.md'), 'identity-user-bytes\n');
      fs.writeFileSync(path.join(rcWorkspace, 'USER.md'), 'rc-user-bytes\n');
      fs.writeFileSync(path.join(rcWorkspace, 'BOOTSTRAP.md.done'), 'bootstrap-user-bytes\n');
      fs.writeFileSync(path.join(install, 'workspace', 'USER.target'), 'workspace-link-target\n');
      fs.symlinkSync('USER.target', path.join(install, 'workspace', 'USER.md'));

      const installer = fs.readFileSync(INSTALLER, 'utf8');
      expect(installer).toContain('# ── Installer lifecycle cleanup');
      const lifecycle = extractBetween(
        installer,
        'RC_BOOTSTRAP_REDEEM_URL=',
        '\nrc_profile_parse_args "$@"',
      );
      const runner = path.join(sandbox, 'type-runner.sh');
      fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="$RC_TEST_INSTALL"
R='' G='' C='' Y='' B='' D='' N=''
ISSUES_URL=https://invalid.example/issues
die() { exit 1; }
${lifecycle}
trap rc_install_exit_cleanup EXIT
rc_install_snapshot_update_backup
RC_UPDATE_MUTATION_STARTED=true
for file in \
  workspace/.ResearchClaw/SOUL.md \
  workspace/.ResearchClaw/IDENTITY.md \
  workspace/.ResearchClaw/TOOLS.md \
  workspace/.ResearchClaw/USER.md \
  workspace/MEMORY.md \
  workspace/USER.md \
  workspace/.ResearchClaw/BOOTSTRAP.md.done
do
  rm -f "$INSTALL_DIR/$file"
  printf 'replacement-must-not-survive\n' > "$INSTALL_DIR/$file"
done
rc_install_restore_update_backup
rc_install_discard_update_backup
trap - EXIT
`, { mode: 0o700 });

      const result = spawnSync('/bin/bash', [runner], {
        cwd: install,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: path.join(sandbox, 'home'),
          TMPDIR: temp,
          RC_TEST_INSTALL: install,
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readlinkSync(path.join(rcWorkspace, 'SOUL.md'))).toBe('SOUL.target');
      expect(fs.readFileSync(path.join(rcWorkspace, 'SOUL.target'), 'utf8')).toBe(
        'symlink-target-must-not-change\n',
      );
      expect(fs.readFileSync(path.join(rcWorkspace, 'IDENTITY.md'), 'utf8')).toBe(
        'identity-user-bytes\n',
      );
      expect(fs.existsSync(path.join(rcWorkspace, 'TOOLS.md'))).toBe(false);
      expect(fs.readFileSync(path.join(rcWorkspace, 'USER.md'), 'utf8')).toBe('rc-user-bytes\n');
      expect(fs.existsSync(path.join(install, 'workspace', 'MEMORY.md'))).toBe(false);
      expect(fs.readlinkSync(path.join(install, 'workspace', 'USER.md'))).toBe('USER.target');
      expect(fs.readFileSync(path.join(rcWorkspace, 'BOOTSTRAP.md.done'), 'utf8')).toBe(
        'bootstrap-user-bytes\n',
      );
      expect(fs.readdirSync(temp)).toEqual([]);
    },
  );
});
