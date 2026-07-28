import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const RUN_SCRIPT = path.join(ROOT, 'scripts', 'run.sh');
const LOCK_HELPER = path.join(ROOT, 'scripts', 'run-lock.sh');
const tempRoots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

function tempLockDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-run-lock-test-'));
  tempRoots.push(root);
  return path.join(root, 'gateway.lock');
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('run.sh single-instance ownership', () => {
  it('refuses a second owner without terminating the live first owner', () => {
    expect(fs.existsSync(LOCK_HELPER)).toBe(true);

    const lockDir = tempLockDir();
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    children.push(owner);
    expect(owner.pid).toBeTypeOf('number');

    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), `${owner.pid}\n`);

    const attempt = spawnSync('bash', ['-c',
      'source "$1"; acquire_run_lock || exit $?; release_run_lock',
      'bash',
      LOCK_HELPER,
    ], {
      encoding: 'utf8',
      env: { ...process.env, RC_RUN_LOCK_DIR: lockDir },
    });

    expect(attempt.status).toBe(73);
    expect(`${attempt.stdout}${attempt.stderr}`).toMatch(/already running/i);
    expect(owner.exitCode).toBeNull();
  });

  it('reclaims a stale lock and removes only its own lock on exit', () => {
    expect(fs.existsSync(LOCK_HELPER)).toBe(true);

    const lockDir = tempLockDir();
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), '99999999\n');

    const attempt = spawnSync('bash', ['-c',
      'source "$1"; acquire_run_lock || exit $?; test -d "$RC_RUN_LOCK_DIR"; release_run_lock; test ! -e "$RC_RUN_LOCK_DIR"',
      'bash',
      LOCK_HELPER,
    ], {
      encoding: 'utf8',
      env: { ...process.env, RC_RUN_LOCK_DIR: lockDir },
    });

    expect(attempt.status).toBe(0);
  });

  it('run.sh uses the ownership helper and never force-kills a port or gateway', () => {
    const script = fs.readFileSync(RUN_SCRIPT, 'utf8');
    expect(script).toContain('acquire_run_lock');
    expect(script).not.toMatch(/kill\s+-9/);
    expect(script).not.toMatch(/xargs\s+kill/);
    expect(script).not.toContain('gateway run --allow-unconfigured --auth token --port 28789 --force');
  });
});
