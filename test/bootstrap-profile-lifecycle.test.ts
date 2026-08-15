import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const require = createRequire(import.meta.url);
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

type Paths = {
  rcRoot: string;
  configPath: string;
  workspace: string;
  stateDir: string;
  dbPath: string;
  globalConfigPath: string;
};

type Harness = Paths & { root: string };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-lifecycle-'));
  roots.push(root);
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  const configRoot = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const dataRoot = path.join(root, 'data');
  for (const directory of [configRoot, workspace, stateDir, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  const paths = {
    root,
    rcRoot: ROOT,
    configPath: path.join(configRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  writeJson(paths.configPath, {
    agents: { defaults: { model: { primary: 'user-provider/user-model' } } },
    models: {
      mode: 'merge',
      providers: {
        'user-provider': {
          baseUrl: 'https://user.invalid/v1',
          api: 'openai-completions',
          models: [{ id: 'user-model', name: 'User model', input: ['text'], contextWindow: 1, maxTokens: 1 }],
          userOwned: true,
        },
      },
    },
    plugins: {
      entries: {
        'research-claw-core': { enabled: true, config: { userField: 'preserve' } },
        'dual-model-supervisor': {
          enabled: false,
          config: { enabled: false, reviewMode: 'off', userField: 'preserve' },
        },
      },
    },
    tools: { deny: ['user_deny'] },
  });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1,
    profiles: {
      'user-provider:manual': {
        type: 'api_key', provider: 'user-provider', key: 'USER_OWNED_FAKE_KEY', preserve: true,
      },
    },
  });
  writeJson(paths.globalConfigPath, {
    userGlobal: { preserve: true },
    models: { providers: { 'user-global-provider': { preserve: true } } },
  });
  const userSkill = path.join(workspace, 'skills', 'user-skill');
  fs.mkdirSync(userSkill, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(userSkill, 'SKILL.md'),
    '---\nname: user-skill\ndescription: user owned\n---\n\nPRESERVE_USER_SKILL\n',
    { mode: 0o600 },
  );
  ensureInitialized({ ...paths, externalStopVerified: true });
  return paths;
}

function capsule(overrides: {
  profileId?: string;
  revision?: number;
  key?: string;
} = {}): Buffer {
  const value = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  if (overrides.profileId) {
    value.profile.id = overrides.profileId;
    value.model.providerId = `custom-rc-profile-${overrides.profileId}`;
  }
  if (overrides.revision !== undefined) value.profile.revision = overrides.revision;
  if (overrides.key !== undefined) value.secrets.modelApiKey = overrides.key;
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function install(harness: Harness, bytes: Buffer): Promise<any> {
  const staged = await applier.stageProfile({
    ...harness,
    capsuleBytes: bytes,
    rcVersion: '0.8.3',
  });
  const applied = await applier.applyProfile({ ...harness, txId: staged.txId });
  await applier.verifyProfile({ ...harness, txId: staged.txId });
  await applier.commitProfile({ ...harness, txId: staged.txId });
  return { staged, applied };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function countBytes(root: string, needle: string): number {
  const target = Buffer.from(needle);
  let count = 0;
  const visit = (current: string): void => {
    const metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`unexpected symlink: ${current}`);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(current)) visit(path.join(current, name));
      return;
    }
    if (!metadata.isFile()) return;
    const bytes = fs.readFileSync(current);
    let offset = 0;
    for (;;) {
      const found = bytes.indexOf(target, offset);
      if (found < 0) break;
      count += 1;
      offset = found + target.length;
    }
  };
  visit(root);
  return count;
}

function managedSkillDirectories(harness: Harness, profileId: string): string[] {
  const prefix = `rc-profile--${profileId}--`;
  return fs.readdirSync(path.join(harness.workspace, 'skills'))
    .filter((name) => name.startsWith(prefix))
    .sort();
}

describe('profile switch, key rotation, and explicit drift repair', () => {
  it('switches profiles transactionally while deleting only receipt-owned provider/auth/skills', async () => {
    const harness = makeHarness();
    const a = JSON.parse(capsule().toString('utf8'));
    const keyA = a.secrets.modelApiKey as string;
    await install(harness, capsule());
    const aSkills = managedSkillDirectories(harness, 'thermoelectric-user-a');
    expect(aSkills.length).toBeGreaterThan(0);

    const keyB = 'RC_TEST_ONLY_PROFILE_B_MODEL_KEY';
    await install(harness, capsule({ profileId: 'thermoelectric-user-b', key: keyB }));

    const config = readJson(harness.configPath);
    expect(config.models.providers).not.toHaveProperty('custom-rc-profile-thermoelectric-user-a');
    expect(config.models.providers['custom-rc-profile-thermoelectric-user-b'].apiKey)
      .toBe('custom-rc-profile-thermoelectric-user-b:managed');
    expect(config.models.providers['user-provider'].userOwned).toBe(true);
    expect(config.plugins.entries['research-claw-core'].config.userField).toBe('preserve');
    expect(config.plugins.entries['dual-model-supervisor'].config.userField).toBe('preserve');

    const auth = readJson(path.join(harness.stateDir, 'agents/main/agent/auth-profiles.json'));
    expect(auth.profiles).not.toHaveProperty('custom-rc-profile-thermoelectric-user-a:managed');
    expect(auth.profiles['custom-rc-profile-thermoelectric-user-b:managed'])
      .toMatchObject({ provider: 'custom-rc-profile-thermoelectric-user-b', key: keyB });
    expect(auth.profiles['user-provider:manual']).toMatchObject({ key: 'USER_OWNED_FAKE_KEY', preserve: true });

    expect(managedSkillDirectories(harness, 'thermoelectric-user-a')).toEqual([]);
    expect(managedSkillDirectories(harness, 'thermoelectric-user-b').length).toBe(aSkills.length);
    expect(fs.readFileSync(
      path.join(harness.workspace, 'skills/user-skill/SKILL.md'), 'utf8',
    )).toContain('PRESERVE_USER_SKILL');
    expect(readJson(harness.globalConfigPath).userGlobal).toEqual({ preserve: true });
    expect(readJson(path.join(
      path.dirname(harness.configPath), '.rc-bootstrap/receipt.json',
    )).profile.id).toBe('thermoelectric-user-b');
    expect(countBytes(harness.root, keyA)).toBe(0);
    expect(countBytes(harness.root, keyB)).toBe(1);
  }, 30_000);

  it('keeps the old key only in the private preimage until a revision/key rotation commits', async () => {
    const harness = makeHarness();
    const first = JSON.parse(capsule().toString('utf8'));
    const oldKey = first.secrets.modelApiKey as string;
    const newKey = 'RC_TEST_ONLY_ROTATED_MODEL_KEY';
    await install(harness, capsule());

    const staged = await applier.stageProfile({
      ...harness,
      capsuleBytes: capsule({ revision: 2, key: newKey }),
      rcVersion: '0.8.3',
    });
    await applier.applyProfile({ ...harness, txId: staged.txId });
    expect(countBytes(harness.root, oldKey)).toBe(1);
    expect(countBytes(harness.root, newKey)).toBe(2); // staged Capsule + live credential store
    await applier.verifyProfile({ ...harness, txId: staged.txId });
    await applier.commitProfile({ ...harness, txId: staged.txId });

    expect(countBytes(harness.root, oldKey)).toBe(0);
    expect(countBytes(harness.root, newKey)).toBe(1);
    const auth = readJson(path.join(harness.stateDir, 'agents/main/agent/auth-profiles.json'));
    expect(auth.profiles['custom-rc-profile-thermoelectric-user-a:managed'].key).toBe(newKey);
    expect(readJson(path.join(
      path.dirname(harness.configPath), '.rc-bootstrap/receipt.json',
    )).profile.revision).toBe(2);
  }, 30_000);

  it('repairs same-digest managed drift without changing user-owned objects', async () => {
    const harness = makeHarness();
    const raw = capsule();
    const key = JSON.parse(raw.toString('utf8')).secrets.modelApiKey as string;
    await install(harness, raw);

    const userConfig = structuredClone(readJson(harness.configPath).models.providers['user-provider']);
    const userAuth = structuredClone(readJson(
      path.join(harness.stateDir, 'agents/main/agent/auth-profiles.json'),
    ).profiles['user-provider:manual']);
    const userSkill = fs.readFileSync(path.join(harness.workspace, 'skills/user-skill/SKILL.md'));

    const config = readJson(harness.configPath);
    const providerId = 'custom-rc-profile-thermoelectric-user-a';
    config.models.providers[providerId] = { operatorDrift: true };
    config.plugins.entries['research-claw-core'].config.productPolicy.capabilities.peripherals = 'enabled';
    config.tools.deny = ['user_deny', 'operator_rule'];
    writeJson(harness.configPath, config);

    const authFile = path.join(harness.stateDir, 'agents/main/agent/auth-profiles.json');
    const auth = readJson(authFile);
    auth.profiles[`${providerId}:managed`] = {
      type: 'api_key', provider: providerId, key: 'RC_TEST_ONLY_DRIFTED_KEY', drift: true,
    };
    writeJson(authFile, auth);

    const global = readJson(harness.globalConfigPath);
    global.models.providers[providerId] = { globalDrift: true };
    writeJson(harness.globalConfigPath, global);

    const managedSkill = managedSkillDirectories(harness, 'thermoelectric-user-a')[0];
    const managedSkillFile = path.join(harness.workspace, 'skills', managedSkill, 'SKILL.md');
    fs.appendFileSync(managedSkillFile, '\nOPERATOR_DRIFT\n');

    const rerun = await install(harness, raw);
    expect(rerun.applied.noop).toBe(false);
    const repaired = readJson(harness.configPath);
    expect(repaired.models.providers[providerId]).not.toHaveProperty('operatorDrift');
    expect(repaired.models.providers[providerId].apiKey).toBe(`${providerId}:managed`);
    expect(repaired.plugins.entries['research-claw-core'].config.productPolicy.capabilities.peripherals)
      .toBe('disabled');
    expect(repaired.tools.deny).toEqual(['user_deny', 'operator_rule', 'periph_*', 'plaud__*']);
    expect(readJson(authFile).profiles[`${providerId}:managed`].key).toBe(key);
    expect(readJson(harness.globalConfigPath).models.providers[providerId]).not.toHaveProperty('globalDrift');
    expect(fs.readFileSync(managedSkillFile, 'utf8')).not.toContain('OPERATOR_DRIFT');

    expect(repaired.models.providers['user-provider']).toEqual(userConfig);
    expect(readJson(authFile).profiles['user-provider:manual']).toEqual(userAuth);
    expect(fs.readFileSync(path.join(harness.workspace, 'skills/user-skill/SKILL.md'))).toEqual(userSkill);
    expect(countBytes(harness.root, 'RC_TEST_ONLY_DRIFTED_KEY')).toBe(0);
    expect(countBytes(harness.root, key)).toBe(1);
  }, 30_000);
});
