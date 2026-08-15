import crypto from 'node:crypto';
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

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-ownership-'));
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
  const harness = {
    root,
    rcRoot: ROOT,
    configPath: path.join(configRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  writeJson(harness.configPath, {
    agents: { defaults: { model: { primary: 'user-provider/user-model' } } },
    models: { mode: 'merge', providers: {
      'user-provider': { baseUrl: 'https://user.invalid/v1', api: 'openai-completions', models: [] },
    } },
    auth: { profiles: {}, order: {} },
    plugins: { entries: {
      'research-claw-core': { enabled: true, config: {} },
      'dual-model-supervisor': { enabled: false, config: { enabled: false, reviewMode: 'off' } },
    } },
    tools: { deny: ['user-rule'] },
  });
  writeJson(harness.globalConfigPath, {
    models: { providers: { 'user-global-provider': { preserve: true } } },
    auth: { profiles: {}, order: {} },
  });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1,
    profiles: {
      'user-provider:manual': { type: 'api_key', provider: 'user-provider', key: 'USER_KEY' },
    },
  });
  ensureInitialized({ ...harness, externalStopVerified: true });
  return harness;
}

function capsule(overrides: { revision?: number; profileId?: string } = {}): Buffer {
  const value = readJson(FIXTURE);
  if (overrides.revision !== undefined) value.profile.revision = overrides.revision;
  if (overrides.profileId !== undefined) {
    value.profile.id = overrides.profileId;
    value.model.providerId = `custom-rc-profile-${overrides.profileId}`;
  }
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function canonicalReceipt(raw = capsule()): any {
  const value = JSON.parse(raw.toString('utf8'));
  return {
    version: 1,
    profile: {
      id: value.profile.id,
      revision: value.profile.revision,
      digest: crypto.createHash('sha256').update(raw).digest('hex'),
    },
    provider: {
      id: value.model.providerId,
      authProfileId: `${value.model.providerId}:managed`,
    },
    skills: value.skills.items.map((skill: any) => ({
      slug: skill.slug,
      directory: `rc-profile--${value.profile.id}--${skill.slug}`,
      files: skill.files.map((file: any) => ({ path: file.path, sha256: file.sha256 })),
    })),
    managedDeny: ['periph_*', 'plaud__*'],
    peripheralSuspensions: { monitors: [], mcp: [] },
  };
}

function receiptFile(h: Harness): string {
  return path.join(path.dirname(h.configPath), '.rc-bootstrap', 'receipt.json');
}

function transactionRoot(h: Harness): string {
  return path.join(path.dirname(h.configPath), '.rc-bootstrap', 'transactions');
}

function writeReceipt(h: Harness, receipt: any): void {
  writeJson(receiptFile(h), receipt);
}

function seedInstalledOwnership(h: Harness): void {
  const raw = capsule();
  const value = JSON.parse(raw.toString('utf8'));
  const receipt = canonicalReceipt(raw);
  writeReceipt(h, receipt);

  for (const skill of value.skills.items) {
    const directory = path.join(h.workspace, 'skills', `rc-profile--${value.profile.id}--${skill.slug}`);
    for (const file of skill.files) {
      const target = path.join(directory, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, file.content, { mode: 0o600 });
    }
  }

  for (const file of [h.configPath, h.globalConfigPath]) {
    const config = readJson(file);
    config.models ??= {};
    config.models.providers ??= {};
    config.models.providers[receipt.provider.id] = { apiKey: receipt.provider.authProfileId };
    config.auth ??= {};
    config.auth.profiles ??= {};
    config.auth.order ??= {};
    config.auth.profiles[receipt.provider.authProfileId] = {
      provider: receipt.provider.id, mode: 'api_key',
    };
    config.auth.order[receipt.provider.id] = [receipt.provider.authProfileId];
    writeJson(file, config);
  }
  const authFile = path.join(h.stateDir, 'agents/main/agent/auth-profiles.json');
  const auth = readJson(authFile);
  auth.profiles[receipt.provider.authProfileId] = {
    type: 'api_key', provider: receipt.provider.id, key: 'OLD_MANAGED_KEY',
  };
  writeJson(authFile, auth);
}

async function stage(h: Harness, raw = capsule()): Promise<any> {
  return applier.stageProfile({ ...h, capsuleBytes: raw, rcVersion: '0.8.3' });
}

function pathState(target: string): any {
  if (!fs.existsSync(target) && !fs.lstatSync(path.dirname(target)).isDirectory()) return { absent: true };
  let metadata: fs.Stats;
  try { metadata = fs.lstatSync(target); } catch (error: any) {
    if (error?.code === 'ENOENT') return { absent: true };
    throw error;
  }
  if (metadata.isDirectory()) {
    return {
      type: 'directory',
      mtimeMs: metadata.mtimeMs,
      children: Object.fromEntries(fs.readdirSync(target).sort().map(
        (name) => [name, pathState(path.join(target, name))],
      )),
    };
  }
  if (metadata.isSymbolicLink()) {
    return { type: 'symlink', mtimeMs: metadata.mtimeMs, target: fs.readlinkSync(target) };
  }
  return {
    type: 'file',
    mtimeMs: metadata.mtimeMs,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
  };
}

function protectedState(h: Harness, txId: string): any {
  return {
    manifest: pathState(path.join(transactionRoot(h), txId, 'manifest.json')),
    config: pathState(h.configPath),
    receipt: pathState(receiptFile(h)),
    suspensions: pathState(path.join(path.dirname(h.configPath), '.rc-bootstrap', 'peripheral-suspensions.json')),
    skills: pathState(path.join(h.workspace, 'skills')),
    auth: pathState(path.join(h.stateDir, 'agents/main/agent/auth-profiles.json')),
    global: pathState(h.globalConfigPath),
    workspaceSatellite: pathState(path.join(h.workspace, '.rc-bootstrap-transactions')),
    stateSatellite: pathState(path.join(h.stateDir, '.rc-bootstrap-transactions')),
    dataSatellite: pathState(path.join(path.dirname(h.dbPath), '.rc-bootstrap-transactions')),
  };
}

async function expectPreconditionChanged(
  h: Harness,
  staged: any,
  mutate: () => void,
): Promise<void> {
  mutate();
  const before = protectedState(h, staged.txId);
  await expect(applier.applyProfile({ ...h, txId: staged.txId }))
    .rejects.toMatchObject({ code: 'STAGED_PRECONDITION_CHANGED' });
  expect(protectedState(h, staged.txId)).toEqual(before);
  expect(readJson(path.join(transactionRoot(h), staged.txId, 'manifest.json')).state).toBe('staged');
}

describe('receipt v1 is an exact, profile-bound deletion capability', () => {
  it.each([
    ['unknown top-level key', (r: any) => { r.extra = true; }],
    ['unknown profile key', (r: any) => { r.profile.extra = true; }],
    ['user-provider lure', (r: any) => { r.provider.id = 'user-provider'; }],
    ['user-auth lure', (r: any) => { r.provider.authProfileId = 'user-provider:manual'; }],
    ['skill owned by another profile', (r: any) => {
      r.skills[0].directory = `rc-profile--another-profile--${r.skills[0].slug}`;
    }],
    ['slug-directory mismatch', (r: any) => {
      r.skills[0].directory = `${r.skills[0].directory}-other`;
    }],
    ['duplicate skill slug', (r: any) => { r.skills.push(structuredClone(r.skills[0])); }],
    ['duplicate skill directory', (r: any) => { r.skills[1].directory = r.skills[0].directory; }],
    ['duplicate file path', (r: any) => { r.skills[0].files.push(structuredClone(r.skills[0].files[0])); }],
    ['file without SHA-256', (r: any) => { r.skills[0].files[0].sha256 = 'not-a-digest'; }],
    ['missing SKILL.md', (r: any) => {
      r.skills[0].files = r.skills[0].files.filter((file: any) => file.path !== 'SKILL.md');
    }],
    ['unknown skill key', (r: any) => { r.skills[0].extra = true; }],
    ['unknown file key', (r: any) => { r.skills[0].files[0].extra = true; }],
    ['duplicate suspension owner', (r: any) => { r.peripheralSuspensions.monitors = ['m1', 'm1']; }],
    ['unsupported suspension MCP', (r: any) => { r.peripheralSuspensions.mcp = ['other-mcp']; }],
  ])('rejects %s as INVALID_RECEIPT before creating a transaction', async (_label, mutate) => {
    const h = makeHarness();
    const receipt = canonicalReceipt();
    mutate(receipt);
    writeReceipt(h, receipt);
    await expect(stage(h)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
    expect(fs.existsSync(transactionRoot(h)) ? fs.readdirSync(transactionRoot(h)) : []).toEqual([]);
  });

  it.each(['provider', 'auth'] as const)(
    'does not let a fresh profile claim an existing user-owned %s target',
    async (kind) => {
      const h = makeHarness();
      const value = JSON.parse(capsule().toString('utf8'));
      const provider = value.model.providerId;
      const authProfile = `${provider}:managed`;
      if (kind === 'provider') {
        const config = readJson(h.configPath);
        config.models.providers[provider] = { userOwned: true };
        writeJson(h.configPath, config);
      } else {
        const authFile = path.join(h.stateDir, 'agents/main/agent/auth-profiles.json');
        const auth = readJson(authFile);
        auth.profiles[authProfile] = { type: 'api_key', provider, key: 'USER_OWNED_LURE' };
        writeJson(authFile, auth);
      }
      await expect(stage(h)).rejects.toMatchObject({ code: 'UNOWNED_MANAGED_TARGET' });
      expect(fs.existsSync(transactionRoot(h)) ? fs.readdirSync(transactionRoot(h)) : []).toEqual([]);
    },
  );

  it.each(['receipt-list-mismatch', 'ledger-owner-mismatch'] as const)(
    'rejects %s between receipt and durable peripheral ownership',
    async (variant) => {
      const h = makeHarness();
      const receipt = canonicalReceipt();
      receipt.peripheralSuspensions.monitors = ['owned-monitor'];
      writeReceipt(h, receipt);
      writeJson(path.join(path.dirname(h.configPath), '.rc-bootstrap', 'peripheral-suspensions.json'), {
        version: 1,
        entries: {
          'owned-monitor': {
            ownerProfileId: variant === 'ledger-owner-mismatch'
              ? 'another-profile' : receipt.profile.id,
            baseline: { enabled: 1, gatewayJobId: null },
            baselineRowHash: 'a'.repeat(64),
            suspendedRowHash: 'b'.repeat(64),
            jobs: [],
          },
          ...(variant === 'receipt-list-mismatch' ? {
            'unlisted-monitor': {
              ownerProfileId: receipt.profile.id,
              baseline: { enabled: 1, gatewayJobId: null },
              baselineRowHash: 'c'.repeat(64),
              suspendedRowHash: 'd'.repeat(64),
              jobs: [],
            },
          } : {}),
        },
        mcp: {},
      });
      await expect(stage(h)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
      expect(fs.existsSync(transactionRoot(h)) ? fs.readdirSync(transactionRoot(h)) : []).toEqual([]);
    },
  );
});

describe('stage-to-apply ownership preconditions', () => {
  it('rejects a target skill directory created after stage without publishing preparing intent', async () => {
    const h = makeHarness();
    const staged = await stage(h);
    const target = path.join(
      h.workspace, 'skills', 'rc-profile--thermoelectric-user-a--develop-flexible-bismuth-telluride',
    );
    await expectPreconditionChanged(h, staged, () => {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(target, 'USER.md'), 'user-owned\n', { mode: 0o600 });
    });
  });

  it('rejects a same-frontmatter-name workspace skill added after stage', async () => {
    const h = makeHarness();
    const staged = await stage(h);
    await expectPreconditionChanged(h, staged, () => {
      const target = path.join(h.workspace, 'skills', 'user-added-after-stage');
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(target, 'SKILL.md'), [
        '---',
        'name: develop-flexible-bismuth-telluride',
        'description: user conflict',
        '---',
        '',
      ].join('\n'), { mode: 0o600 });
    });
  });

  it.each(['content', 'symlink', 'hardlink'] as const)(
    'rejects %s changes to an old receipt-owned directory after stage',
    async (variant) => {
      const h = makeHarness();
      seedInstalledOwnership(h);
      const staged = await stage(h, capsule({ revision: 2 }));
      const oldFile = path.join(
        h.workspace,
        'skills/rc-profile--thermoelectric-user-a--develop-flexible-bismuth-telluride/SKILL.md',
      );
      await expectPreconditionChanged(h, staged, () => {
        if (variant === 'content') fs.appendFileSync(oldFile, '\noperator-race\n');
        if (variant === 'symlink') {
          fs.unlinkSync(oldFile);
          fs.symlinkSync(path.join(h.root, 'outside'), oldFile);
        }
        if (variant === 'hardlink') fs.linkSync(oldFile, path.join(h.root, 'hardlink-alias'));
      });
    },
  );

  it.each(['receipt-appeared', 'receipt-changed', 'revision-race'] as const)(
    'rejects %s between stage and apply',
    async (variant) => {
      const h = makeHarness();
      if (variant !== 'receipt-appeared') seedInstalledOwnership(h);
      const staged = await stage(h, capsule({ revision: variant === 'receipt-appeared' ? 1 : 2 }));
      await expectPreconditionChanged(h, staged, () => {
        const receipt = variant === 'receipt-appeared'
          ? canonicalReceipt()
          : readJson(receiptFile(h));
        if (variant === 'receipt-changed') receipt.managedDeny = [];
        if (variant === 'revision-race') receipt.profile.revision = 2;
        writeReceipt(h, receipt);
      });
    },
  );

  it.each(['provider', 'auth'] as const)(
    'rejects a user-owned %s target introduced after stage',
    async (kind) => {
      const h = makeHarness();
      const staged = await stage(h);
      const value = JSON.parse(capsule().toString('utf8'));
      const provider = value.model.providerId;
      const authProfile = `${provider}:managed`;
      await expectPreconditionChanged(h, staged, () => {
        if (kind === 'provider') {
          const config = readJson(h.configPath);
          config.models.providers[provider] = { userOwned: true };
          writeJson(h.configPath, config);
        } else {
          const authFile = path.join(h.stateDir, 'agents/main/agent/auth-profiles.json');
          const auth = readJson(authFile);
          auth.profiles[authProfile] = { type: 'api_key', provider, key: 'USER_OWNED_LURE' };
          writeJson(authFile, auth);
        }
      });
    },
  );

  it.each(['config', 'global-config', 'auth-store'] as const)(
    'rejects receipt-owned provider/auth drift in %s after stage',
    async (kind) => {
      const h = makeHarness();
      seedInstalledOwnership(h);
      const staged = await stage(h, capsule({ revision: 2 }));
      await expectPreconditionChanged(h, staged, () => {
        const file = kind === 'config' ? h.configPath
          : kind === 'global-config' ? h.globalConfigPath
            : path.join(h.stateDir, 'agents/main/agent/auth-profiles.json');
        const value = readJson(file);
        if (kind === 'auth-store') {
          value.profiles['custom-rc-profile-thermoelectric-user-a:managed'].key = 'RACED_KEY';
        } else {
          value.models.providers['custom-rc-profile-thermoelectric-user-a'].operatorRace = true;
        }
        writeJson(file, value);
      });
    },
  );

  it.each([
    ['config-symlink', 'INVALID_CONFIG_IDENTITY'],
    ['auth-hardlink', 'STAGED_PRECONDITION_CHANGED'],
  ] as const)(
    'rejects a %s target swap before publishing preparing intent',
    async (variant, code) => {
      const h = makeHarness();
      const staged = await stage(h);
      const mutate = (): void => {
        if (variant === 'config-symlink') {
          const replacement = path.join(h.root, 'operator-config.json');
          fs.copyFileSync(h.configPath, replacement);
          fs.unlinkSync(h.configPath);
          fs.symlinkSync(replacement, h.configPath);
        } else {
          fs.linkSync(
            path.join(h.stateDir, 'agents/main/agent/auth-profiles.json'),
            path.join(h.root, 'auth-hardlink.json'),
          );
        }
      };
      if (code === 'STAGED_PRECONDITION_CHANGED') {
        await expectPreconditionChanged(h, staged, mutate);
      } else {
        mutate();
        const before = protectedState(h, staged.txId);
        await expect(applier.applyProfile({ ...h, txId: staged.txId }))
          .rejects.toMatchObject({ code });
        expect(protectedState(h, staged.txId)).toEqual(before);
        expect(readJson(path.join(transactionRoot(h), staged.txId, 'manifest.json')).state).toBe('staged');
      }
    },
  );
});
