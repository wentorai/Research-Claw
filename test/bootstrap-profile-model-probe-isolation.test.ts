import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'scripts/bootstrap-profile/model-probe.cjs');
const RUNNER = path.join(ROOT, 'test/fixtures/bootstrap-profile-model-probe-openclaw-runner.cjs');
const SECRET = 'RC_T09_ISOLATED_MODEL_PROBE_KEY';
const PROVIDER = 'custom-rc-profile-isolation';
const PROFILE = `${PROVIDER}:managed`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function harness(failure: boolean | string = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-model-probe-isolation-'));
  roots.push(root);
  const fakeRoot = path.join(root, 'candidate');
  const entry = path.join(fakeRoot, 'node_modules/openclaw/dist/entry.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(RUNNER, entry);
  const stateDir = path.join(root, 'live-state');
  const configPath = path.join(root, 'live-config/openclaw.json');
  const authPath = path.join(stateDir, 'agents/main/agent/auth-profiles.json');
  const scratchParent = path.join(root, 'scratch-parent');
  fs.mkdirSync(scratchParent, { mode: 0o700 });
  writeJson(configPath, {
    fixtureProbeFailure: failure === true,
    ...(typeof failure === 'string' ? { fixtureProbeStatus: failure } : {}),
    agents: { defaults: { model: { primary: `${PROVIDER}/fixture` } } },
    models: { providers: { [PROVIDER]: { apiKey: PROFILE } } },
    auth: { order: { [PROVIDER]: [PROFILE] } },
    plugins: { enabled: true, load: { paths: ['/must-not-enter-isolated-probe'] } },
    mcp: { servers: { forbidden: { command: '/must-not-run' } } },
  });
  writeJson(authPath, {
    version: 1,
    profiles: {
      [PROFILE]: { type: 'api_key', provider: PROVIDER, key: SECRET },
      'user-provider:manual': { type: 'api_key', provider: 'user-provider', key: 'USER_KEY_PRESERVE' },
    },
  });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-state.json'), {
    version: 1,
    usageStats: { 'user-provider:manual': { errorCount: 0 } },
  });
  return { root, fakeRoot, stateDir, configPath, scratchParent };
}

function tree(root: string): Record<string, string> {
  const output: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) output[path.relative(root, target)] = fs.readFileSync(target).toString('base64');
    }
  };
  visit(root);
  return output;
}

function run(item: ReturnType<typeof harness>) {
  return spawnSync(process.execPath, [
    HELPER,
    '--root', item.fakeRoot,
    '--config', item.configPath,
    '--state', item.stateDir,
    '--provider', PROVIDER,
    '--profile', PROFILE,
    '--scratch-root', item.scratchParent,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
}

function installerProbeFunction(): string {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/install.sh'), 'utf8');
  const start = source.indexOf('rc_profile_probe_native() {');
  const end = source.indexOf('\nrc_profile_commit_native() {', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function runInstallerRetryFixture(code: string, alwaysFail = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-model-probe-retry-'));
  roots.push(root);
  const candidate = path.join(root, 'candidate');
  const scratch = path.join(root, 'scratch');
  const counter = path.join(root, 'counter');
  fs.mkdirSync(path.join(candidate, 'scripts/bootstrap-profile'), { recursive: true });
  fs.mkdirSync(path.join(candidate, 'config'), { recursive: true });
  fs.mkdirSync(scratch, { mode: 0o700 });
  writeJson(path.join(candidate, 'config/openclaw.json'), {
    agents: { defaults: { model: { primary: `${PROVIDER}/fixture` } } },
    auth: { order: { [PROVIDER]: [PROFILE] } },
  });
  fs.writeFileSync(path.join(candidate, 'scripts/bootstrap-profile/model-probe.cjs'), `
const fs = require('fs');
const count = fs.existsSync(process.env.RC_TEST_COUNTER)
  ? Number(fs.readFileSync(process.env.RC_TEST_COUNTER, 'utf8')) + 1 : 1;
fs.writeFileSync(process.env.RC_TEST_COUNTER, String(count));
if (count === 1 || process.env.RC_TEST_ALWAYS_FAIL === '1') {
  process.stderr.write('Bootstrap Profile isolated model probe failed (' + process.env.RC_TEST_CODE + ')\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, status: 'ok' }) + '\\n');
`);
  const runner = path.join(root, 'runner.sh');
  fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
GW_NODE="$RC_TEST_NODE"
INSTALL_DIR="$RC_TEST_ROOT"
RC_PROFILE_TEMP_ROOT="$RC_TEST_SCRATCH"
R='' G='' C='' Y='' B='' D='' N=''
warn() { printf 'WARN %s\\n' "$1"; }
die() { printf 'DIE %s\\n' "$1" >&2; exit 1; }
run_with_heartbeat() { local label="$1"; shift; printf 'RUN %s\\n' "$label"; "$@"; }
sleep() { :; }
${installerProbeFunction()}
rc_profile_probe_native
`, { mode: 0o700 });
  const result = spawnSync('/bin/bash', [runner], {
    cwd: candidate,
    encoding: 'utf8',
    env: {
      ...process.env,
      RC_TEST_NODE: process.execPath,
      RC_TEST_ROOT: candidate,
      RC_TEST_SCRATCH: scratch,
      RC_TEST_COUNTER: counter,
      RC_TEST_CODE: code,
      RC_TEST_ALWAYS_FAIL: alwaysFail ? '1' : '0',
    },
  });
  return {
    result,
    count: Number(fs.readFileSync(counter, 'utf8')),
  };
}

describe('isolated Bootstrap Profile credential/model probe', () => {
  it('budgets for the measured native-Windows OpenClaw cold start', () => {
    const source = fs.readFileSync(HELPER, 'utf8');
    expect(source).toContain('const DEFAULT_TIMEOUT_MS = 120_000;');
  });

  it('uses only the target credential and deletes successful runtime state', () => {
    const item = harness();
    const before = tree(item.stateDir);
    const result = run(item);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      provider: PROVIDER,
      profileId: PROFILE,
    });
    expect(tree(item.stateDir)).toEqual(before);
    expect(fs.readdirSync(item.scratchParent)).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
  });

  it('deletes cooldown/log residue after failure without touching live auth state', () => {
    const item = harness(true);
    const before = tree(item.stateDir);
    const result = run(item);
    expect(result.status).not.toBe(0);
    expect(tree(item.stateDir)).toEqual(before);
    expect(fs.readdirSync(item.scratchParent)).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
  });

  it.each([
    ['auth', 'MODEL_PROBE_AUTH'],
    ['billing', 'MODEL_PROBE_BILLING'],
    ['rate_limit', 'MODEL_PROBE_RATE_LIMIT'],
    ['timeout', 'MODEL_PROBE_TIMEOUT'],
    ['format', 'MODEL_PROBE_FORMAT'],
    ['no_model', 'MODEL_PROBE_NO_MODEL'],
    ['unknown', 'MODEL_PROBE_UNKNOWN'],
  ])('reports the safe %s classification without provider error text', (status, code) => {
    const item = harness(status);
    const result = run(item);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`(${code})`);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
    expect(fs.readdirSync(item.scratchParent)).toEqual([]);
  });

  it('keeps the installer-visible error channel constant and disables raw debug output', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/install.sh'), 'utf8');
    expect(source).toContain('RC_MODEL_PROBE_DEBUG=0 "$GW_NODE"');
    expect(source).toContain('run_with_heartbeat "Verifying Bootstrap Profile model access (attempt 1/2)"');
    expect(source).toContain('--scratch-root "$RC_PROFILE_TEMP_ROOT" >"$_probe_output" 2>"$_probe_error"');
  });

  it('retries only a bounded allowlist of transient model classifications', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/install.sh'), 'utf8');
    expect(source).toContain('Verifying Bootstrap Profile model access (attempt 1/2)');
    expect(source).toContain('Verifying Bootstrap Profile model access (retry 2/2)');
    expect(source).toContain('MODEL_PROBE_TIMEOUT|PROBE_TIMEOUT|MODEL_PROBE_FAILED|MODEL_PROBE_RATE_LIMIT|MODEL_PROBE_UNKNOWN)');
    const retryCase = source.match(/case "\$_probe_code" in([\s\S]*?)esac/)?.[1] ?? '';
    expect(retryCase).not.toContain('MODEL_PROBE_AUTH');
    expect(retryCase).not.toContain('MODEL_PROBE_BILLING');
    expect(retryCase).not.toContain('MODEL_PROBE_FORMAT');
    expect(retryCase).not.toContain('MODEL_PROBE_NO_MODEL');
  });

  it('retries one transient failure exactly once and then accepts success', () => {
    const fixture = runInstallerRetryFixture('MODEL_PROBE_TIMEOUT');
    expect(fixture.result.status, `${fixture.result.stdout}\n${fixture.result.stderr}`).toBe(0);
    expect(fixture.count).toBe(2);
    expect(fixture.result.stdout).toContain('attempt 1/2');
    expect(fixture.result.stdout).toContain('retry 2/2');
  });

  it('does not retry a permanent authentication failure', () => {
    const fixture = runInstallerRetryFixture('MODEL_PROBE_AUTH', true);
    expect(fixture.result.status).not.toBe(0);
    expect(fixture.count).toBe(1);
    expect(`${fixture.result.stdout}${fixture.result.stderr}`).not.toContain('retry 2/2');
  });
});
