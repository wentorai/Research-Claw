import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-journal-'));
  roots.push(root);
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
  fs.writeFileSync(paths.configPath, '{}\n', { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(paths.configPath, 0o600);
  ensureInitialized({ ...paths, externalStopVerified: true });
  const transactions = path.join(configRoot, '.rc-bootstrap', 'transactions');
  fs.mkdirSync(transactions, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(transactions, 0o700);
  return { root, paths, transactions };
}

describe('primary transaction directory validation', () => {
  it.each([
    ['stray regular file', 'UNKNOWN_TRANSACTION_STATE', (item: ReturnType<typeof harness>) => {
      fs.writeFileSync(path.join(item.transactions, 'notes.txt'), 'operator note', { mode: 0o600 });
      return path.join(item.transactions, 'notes.txt');
    }],
    ['stray directory', 'UNKNOWN_TRANSACTION_STATE', (item: ReturnType<typeof harness>) => {
      const target = path.join(item.transactions, 'not-a-transaction');
      fs.mkdirSync(target, { mode: 0o700 });
      return target;
    }],
    ['UUID-shaped regular file', 'UNSAFE_TRANSACTION_ROOT', (item: ReturnType<typeof harness>) => {
      const target = path.join(item.transactions, 'tx-11111111-1111-4111-8111-111111111111');
      fs.writeFileSync(target, '{}\n', { mode: 0o600 });
      return target;
    }],
  ] as const)('fails closed on a %s with a stable public code and preserves it', async (_label, code, create) => {
    const item = harness();
    const target = create(item);
    await expect(applier.recoverProfiles(item.paths)).rejects.toMatchObject({ code });
    expect(fs.existsSync(target)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a UUID-shaped symlink without following or deleting it',
    async () => {
      const item = harness();
      const outside = path.join(item.root, 'outside');
      fs.mkdirSync(outside, { mode: 0o700 });
      const target = path.join(item.transactions, 'tx-22222222-2222-4222-8222-222222222222');
      fs.symlinkSync(outside, target);

      await expect(applier.recoverProfiles(item.paths))
        .rejects.toMatchObject({ code: 'UNSAFE_TRANSACTION_ROOT' });
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(outside)).toBe(true);
    },
  );
});
