import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const require = createRequire(import.meta.url);
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-derived-secret-'));
  temporaryRoots.push(root);
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  const configRoot = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const dataRoot = path.join(root, 'data');
  for (const directory of [configRoot, workspace, stateDir, dataRoot]) {
    fs.mkdirSync(directory, { mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  const paths = {
    rcRoot: ROOT,
    configPath: path.join(configRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  writeJson(paths.configPath, {
    agents: { defaults: { model: { primary: 'user/model' } } },
    models: { mode: 'merge', providers: {} },
    plugins: {
      entries: {
        'research-claw-core': { enabled: true, config: {} },
        'dual-model-supervisor': {
          enabled: false, config: { enabled: false, reviewMode: 'off' },
        },
      },
    },
    tools: { deny: [] },
  });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1,
    profiles: {},
  });
  writeJson(paths.globalConfigPath, {});
  ensureInitialized({ ...paths, externalStopVerified: true });
  return paths;
}

async function appliedHarness() {
  const paths = harness();
  const capsuleBytes = fs.readFileSync(FIXTURE);
  const key = JSON.parse(capsuleBytes.toString('utf8')).secrets.modelApiKey as string;
  const staged = await applier.stageProfile({
    ...paths,
    capsuleBytes,
    rcVersion: '0.8.3',
  });
  await applier.applyProfile({ ...paths, txId: staged.txId });
  return { paths, txId: staged.txId, key };
}

describe('derived state secret-copy scan', () => {
  it.each([
    ['models.json', (stateDir: string) => path.join(stateDir, 'agents/main/agent/models.json')],
    ['plugin catalog', (stateDir: string) => path.join(
      stateDir, 'agents/main/agent/plugins/custom-rc-profile-thermoelectric-user-a/catalog.json',
    )],
  ] as const)('rejects a plaintext key copied into %s before commit', async (_label, target) => {
    const { paths, txId, key } = await appliedHarness();
    const file = target(paths.stateDir);
    writeJson(file, {
      provider: 'custom-rc-profile-thermoelectric-user-a',
      apiKey: key,
    });

    await expect(applier.verifyProfile({ ...paths, txId }))
      .rejects.toMatchObject({ code: 'SECRET_COPY_DETECTED' });
    expect(fs.existsSync(file)).toBe(true);
  }, 30_000);

  it('accepts the expected credential plus transaction Capsule/preimage allowlist', async () => {
    const { paths, txId } = await appliedHarness();
    await expect(applier.verifyProfile({ ...paths, txId }))
      .resolves.toMatchObject({ state: 'verified' });
  }, 30_000);

  it.each([
    ['an extra JSON value', (stateDir: string, key: string) => {
      writeJson(path.join(stateDir, 'unexpected.json'), { nested: { modelApiKey: key } });
    }],
    ['an ordinary binary file', (stateDir: string, key: string) => {
      fs.writeFileSync(path.join(stateDir, 'ordinary.bin'), Buffer.from(`prefix\0${key}\0suffix`), {
        mode: 0o600,
      });
    }],
    ['a SQLite TEXT cell', (stateDir: string, key: string) => {
      const database = new DatabaseSync(path.join(stateDir, 'text-copy.sqlite'));
      try {
        database.exec('CREATE TABLE copies (value TEXT NOT NULL)');
        database.prepare('INSERT INTO copies (value) VALUES (?)').run(key);
      } finally {
        database.close();
      }
    }],
    ['a SQLite BLOB cell', (stateDir: string, key: string) => {
      const database = new DatabaseSync(path.join(stateDir, 'blob-copy.sqlite'));
      try {
        database.exec('CREATE TABLE copies (value BLOB NOT NULL)');
        database.prepare('INSERT INTO copies (value) VALUES (?)').run(Buffer.from(key));
      } finally {
        database.close();
      }
    }],
  ] as const)('rejects the complete key copied into %s', async (_label, inject) => {
    const { paths, txId, key } = await appliedHarness();
    inject(paths.stateDir, key);

    await expect(applier.verifyProfile({ ...paths, txId }))
      .rejects.toMatchObject({ code: 'SECRET_COPY_DETECTED' });
  }, 30_000);

  it('rejects the complete key copied into a transaction-owned managed Skill', async () => {
    const { paths, txId, key } = await appliedHarness();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(path.dirname(paths.configPath), '.rc-bootstrap/receipt.json'), 'utf8',
    ));
    const managedSkill = path.join(
      paths.workspace, 'skills', receipt.skills[0].directory, receipt.skills[0].files[0].path,
    );
    fs.appendFileSync(managedSkill, `\n${key}\n`);

    await expect(applier.verifyProfile({ ...paths, txId }))
      .rejects.toMatchObject({ code: 'SECRET_COPY_DETECTED' });
  }, 30_000);
});
