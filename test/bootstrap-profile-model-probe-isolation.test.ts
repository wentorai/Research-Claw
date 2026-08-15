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

function harness(failure = false) {
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
    fixtureProbeFailure: failure,
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

describe('isolated Bootstrap Profile credential/model probe', () => {
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
});
