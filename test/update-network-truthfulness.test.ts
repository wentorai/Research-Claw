import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  cpSync,
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

const ROOT = path.resolve(import.meta.dirname, '..');
const POSIX_UPDATER = path.join(ROOT, 'scripts', 'update-research-claw.sh');
const POWERSHELL_UPDATER = path.join(ROOT, 'scripts', 'update-research-claw.ps1');
const POWERSHELL_VERIFIER = path.join(
  ROOT,
  'scripts',
  'verify-updater-powershell.ps1',
);
const CI_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');

describe('standalone updater network truthfulness', () => {
  let fixtureRoot: string;
  let binDir: string;
  let nodeCalls: string;
  let pinnedNode: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-update-network-'));
    binDir = path.join(fixtureRoot, 'bin');
    nodeCalls = path.join(fixtureRoot, 'node-calls.log');
    pinnedNode = path.join(binDir, 'node22');
    mkdirSync(path.join(fixtureRoot, '.git'));
    mkdirSync(path.join(fixtureRoot, 'scripts'));
    mkdirSync(binDir);
    cpSync(POSIX_UPDATER, path.join(fixtureRoot, 'scripts', 'update-research-claw.sh'));

    writeFileSync(
      path.join(binDir, 'git'),
      `#!/bin/sh
case "$1" in
  rev-parse) printf '%s\\n' deadbeef; exit 0 ;;
  pull) exit "\${FAKE_PULL_EXIT:-0}" ;;
  remote) exit 0 ;;
  fetch) exit "\${FAKE_FETCH_EXIT:-0}" ;;
  merge) exit "\${FAKE_MERGE_EXIT:-0}" ;;
esac
exit 0
`,
    );
    writeFileSync(
      path.join(binDir, 'node'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$NODE_CALLS"
case "$*" in
  *"node-runtime.cjs resolve --shell"*)
    printf "RC_NODE_PATH='%s'\\nRC_NODE_DIR='%s'\\nRC_NODE_VERSION='22.22.2'\\nRC_NODE_ABI='127'\\n" "$PINNED_NODE" "$BIN_DIR"
    ;;
esac
exit 0
`,
    );
    writeFileSync(
      pinnedNode,
      `#!/bin/sh
printf 'PINNED %s\\n' "$*" >> "$NODE_CALLS"
exit 0
`,
    );
    chmodSync(path.join(binDir, 'git'), 0o755);
    chmodSync(path.join(binDir, 'node'), 0o755);
    chmodSync(pinnedNode, 0o755);
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function runUpdater(overrides: Record<string, string>) {
    return spawnSync('bash', [path.join(fixtureRoot, 'scripts', 'update-research-claw.sh')], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: path.join(fixtureRoot, 'home'),
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        NODE_CALLS: nodeCalls,
        PINNED_NODE: pinnedNode,
        BIN_DIR: binDir,
        ...overrides,
      },
    });
  }

  it('fails before install/build when neither origin nor GitHub can be checked', () => {
    const result = runUpdater({
      FAKE_PULL_EXIT: '17',
      FAKE_FETCH_EXIT: '18',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /update (?:was not completed|could not be completed)/i,
    );
    expect(result.stdout).not.toContain('[update-research-claw] Done.');
    expect(existsSync(nodeCalls) ? readFileSync(nodeCalls, 'utf8') : '').toBe('');
  });

  it('fails before install/build when fetched GitHub cannot be fast-forwarded', () => {
    const result = runUpdater({
      FAKE_PULL_EXIT: '17',
      FAKE_FETCH_EXIT: '0',
      FAKE_MERGE_EXIT: '19',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/fast-forward|update.*not completed/i);
    expect(result.stdout).not.toContain('[update-research-claw] Done.');
    expect(existsSync(nodeCalls) ? readFileSync(nodeCalls, 'utf8') : '').toBe('');
  });

  it('keeps a successful origin check usable when only GitHub is unavailable', () => {
    const result = runUpdater({
      FAKE_PULL_EXIT: '0',
      FAKE_FETCH_EXIT: '18',
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/origin.*succeeded|origin.*checked/i);
    expect(result.stdout).toContain('[update-research-claw] Done.');
    expect(readFileSync(nodeCalls, 'utf8')).toContain('run-pnpm.cjs install');
    expect(readFileSync(nodeCalls, 'utf8')).toContain('run-pnpm.cjs build');
    expect(readFileSync(nodeCalls, 'utf8')).toContain('PINNED ');
    expect(readFileSync(nodeCalls, 'utf8')).toContain('native-runtime-guard.cjs');
  });

  it('requires the PowerShell updater to reject double failure and merge failure', () => {
    const source = readFileSync(POWERSHELL_UPDATER, 'utf8');

    expect(source).toMatch(/\$OriginPullSucceeded\s*=/);
    expect(source).toMatch(/\$GithubFetchSucceeded\s*=/);
    expect(source).toContain(
      'if (-not $OriginPullSucceeded -and -not $GithubFetchSucceeded)',
    );
    expect(source).toMatch(
      /neither origin nor GitHub could be checked[\s\S]*existing installation was kept/i,
    );
    expect(source).toMatch(/if\s*\(\s*-not\s+\$GithubMergeSucceeded[\s\S]*throw\s+["'][^"']*fast-forward/i);
  });

  it('executes the PowerShell updater semantics as a required CI step', () => {
    expect(existsSync(POWERSHELL_VERIFIER)).toBe(true);
    const workflow = readFileSync(CI_WORKFLOW, 'utf8');
    expect(workflow).toContain(
      'pwsh -NoLogo -NoProfile -File scripts/verify-updater-powershell.ps1',
    );
    expect(workflow).not.toMatch(
      /verify-updater-powershell\.ps1[\s\S]{0,120}continue-on-error:\s*true/,
    );
  });
});
