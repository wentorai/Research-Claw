import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'native-runtime-guard.cjs');

function createGuardFixture(preflightSource: string, rebuildSource: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-native-guard-'));
  const scripts = path.join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  copyFileSync(GUARD, path.join(scripts, 'native-runtime-guard.cjs'));
  writeFileSync(path.join(scripts, 'runtime-preflight.cjs'), preflightSource);
  writeFileSync(path.join(scripts, 'run-pnpm.cjs'), rebuildSource);
  chmodSync(path.join(scripts, 'runtime-preflight.cjs'), 0o755);
  chmodSync(path.join(scripts, 'run-pnpm.cjs'), 0o755);
  return root;
}

describe('Native runtime ABI repair guard', () => {
  it('repairs one exact better-sqlite3 ABI mismatch and re-runs preflight', () => {
    const state = path.join(os.tmpdir(), `rc-native-guard-state-${process.pid}-${Date.now()}`);
    const calls = `${state}.calls`;
    const root = createGuardFixture(
      `const fs = require('node:fs');
if (!fs.existsSync(process.env.RC_GUARD_STATE)) {
  process.stderr.write('[preflight] NATIVE_ABI_MISMATCH: fixture mismatch\\n');
  process.exit(78);
}
process.stdout.write('[preflight] Core runtime ready\\n');
`,
      `const fs = require('node:fs');
fs.appendFileSync(process.env.RC_GUARD_CALLS, process.argv.slice(2).join(' ') + '\\n');
if (process.env.RC_REBUILD_EXIT === '0') fs.writeFileSync(process.env.RC_GUARD_STATE, 'repaired');
process.exit(Number(process.env.RC_REBUILD_EXIT || 0));
`,
    );
    try {
      const result = spawnSync(process.execPath, [
        path.join(root, 'scripts', 'native-runtime-guard.cjs'),
        '--root', root,
        '--config', path.join(root, 'config.json'),
        '--require-build',
        '--repair-native-abi',
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          RC_GUARD_STATE: state,
          RC_GUARD_CALLS: calls,
          RC_REBUILD_EXIT: '0',
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('rebuild better-sqlite3\n');
      expect(`${result.stdout}\n${result.stderr}`).toContain('Native ABI repaired');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { force: true });
      rmSync(calls, { force: true });
    }
  });

  it('does not mutate dependencies for a non-ABI preflight failure', () => {
    const calls = path.join(os.tmpdir(), `rc-native-guard-calls-${process.pid}-${Date.now()}`);
    const root = createGuardFixture(
      `process.stderr.write('[preflight] DATABASE_UNREADABLE: fixture database failure\\n');
process.exit(78);
`,
      `require('node:fs').appendFileSync(process.env.RC_GUARD_CALLS, 'unexpected\\n');
process.exit(0);
`,
    );
    try {
      const result = spawnSync(process.execPath, [
        path.join(root, 'scripts', 'native-runtime-guard.cjs'),
        '--root', root,
        '--repair-native-abi',
      ], { encoding: 'utf8', env: { ...process.env, RC_GUARD_CALLS: calls } });

      expect(result.status).toBe(78);
      expect(result.stderr).toContain('DATABASE_UNREADABLE');
      expect(existsSync(calls)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(calls, { force: true });
    }
  });

  it('keeps startup failed when the targeted rebuild does not repair the ABI', () => {
    const calls = path.join(os.tmpdir(), `rc-native-guard-calls-${process.pid}-${Date.now()}`);
    const root = createGuardFixture(
      `process.stderr.write('[preflight] NATIVE_ABI_MISMATCH: fixture mismatch\\n');
process.exit(78);
`,
      `require('node:fs').appendFileSync(process.env.RC_GUARD_CALLS, process.argv.slice(2).join(' ') + '\\n');
process.exit(19);
`,
    );
    try {
      const result = spawnSync(process.execPath, [
        path.join(root, 'scripts', 'native-runtime-guard.cjs'),
        '--root', root,
        '--repair-native-abi',
      ], { encoding: 'utf8', env: { ...process.env, RC_GUARD_CALLS: calls } });

      expect(result.status).not.toBe(0);
      expect(readFileSync(calls, 'utf8')).toBe('rebuild better-sqlite3\n');
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('Native ABI repaired');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(calls, { force: true });
    }
  });

  it('binds both standalone updaters and the launcher to the resolved Node 22 guard', () => {
    const posix = readFileSync(path.join(ROOT, 'scripts', 'update-research-claw.sh'), 'utf8');
    const windows = readFileSync(path.join(ROOT, 'scripts', 'update-research-claw.ps1'), 'utf8');
    const launcher = readFileSync(path.join(ROOT, 'scripts', 'run.sh'), 'utf8');

    expect(posix).toContain('node-runtime.cjs" resolve --shell');
    expect(posix).toContain('"$GW_NODE" "$ROOT/scripts/run-pnpm.cjs" install');
    expect(posix).toContain('native-runtime-guard.cjs');
    expect(posix).toContain('--repair-native-abi');
    expect(posix).not.toContain('node "$ROOT/scripts/run-pnpm.cjs" install');

    expect(windows).toContain('$GatewayNode');
    expect(windows).toContain("'native-runtime-guard.cjs'");
    expect(windows).toContain('--repair-native-abi');
    expect(windows).not.toMatch(/& node .*run-pnpm\.cjs.* install/);

    expect(launcher).toContain('native-runtime-guard.cjs');
    expect(launcher).toContain('--repair-native-abi');
  });
});
