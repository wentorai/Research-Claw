import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const EXAMPLE_CONFIG = path.join(ROOT, 'config', 'openclaw.example.json');
const INSTALLER = path.join(ROOT, 'scripts', 'install.sh');
const require = createRequire(import.meta.url);
const maintenanceLease: {
  ensureInitialized(options: LockPaths & { externalStopVerified?: boolean }): {
    created: boolean;
  };
  acquireBootstrapLocks(options: LockPaths & {
    operation: 'shared' | 'exclusive';
    runtime: 'shared' | 'reserved' | 'exclusive' | null;
    initialize: false;
  }): {
    assertHeld(): boolean;
    release(): boolean;
  };
} = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

type LockPaths = {
  rcRoot: string;
  configPath: string;
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture(): {
  root: string;
  configRoot: string;
  configPath: string;
  lockPaths: LockPaths;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-ensure-mode-'));
  temporaryRoots.push(root);
  const configRoot = path.join(root, 'config');
  for (const directory of [root, configRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  const configPath = path.join(configRoot, 'openclaw.json');
  return {
    root,
    configRoot,
    configPath,
    lockPaths: { rcRoot: ROOT, configPath },
  };
}

function writePrivateConfig(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function expectPrivateConfigMode(file: string): void {
  const metadata = fs.lstatSync(file);
  expect(metadata.isFile()).toBe(true);
  expect(metadata.isSymbolicLink()).toBe(false);
  if (process.platform !== 'win32') {
    expect(metadata.mode & 0o777).toBe(0o600);
    if (typeof process.getuid === 'function') expect(metadata.uid).toBe(process.getuid());
  }
}

function runEnsureConfig(fixture: ReturnType<typeof makeFixture>): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [ENSURE_CONFIG, fixture.configPath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      RC_CONFIG_TEMPLATE_PATH: EXAMPLE_CONFIG,
    },
  });
}

function expectSharedLockWorks(lockPaths: LockPaths): void {
  const held = maintenanceLease.acquireBootstrapLocks({
    ...lockPaths,
    operation: 'shared',
    runtime: 'shared',
    initialize: false,
  });
  try {
    expect(held.assertHeld()).toBe(true);
  } finally {
    expect(held.release()).toBe(true);
  }
}

describe('ensure-config and bootstrap lock private-mode integration', () => {
  it('keeps a 0600 config private after the real atomic ensure-config rewrite', () => {
    const fixture = makeFixture();
    writePrivateConfig(fixture.configPath, {
      agents: { defaults: { timeoutSeconds: 300 } },
      gateway: { auth: { token: 'RC_TEST_ONLY_MODE_TOKEN' } },
    });
    expectPrivateConfigMode(fixture.configPath);
    const beforeDigest = sha256(fixture.configPath);
    const initialized = maintenanceLease.ensureInitialized({
      ...fixture.lockPaths,
      externalStopVerified: true,
    });
    expect(initialized.created).toBe(true);

    const result = runEnsureConfig(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('[ensure-config] Updated 1 config file(s)');
    expect(sha256(fixture.configPath)).not.toBe(beforeDigest);
    expect(JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'))).toMatchObject({
      agents: { defaults: { timeoutSeconds: 3600 } },
      gateway: { auth: { token: 'RC_TEST_ONLY_MODE_TOKEN' } },
    });
    expectPrivateConfigMode(fixture.configPath);
    expect(fs.readdirSync(fixture.configRoot).some((name) => name.includes('.tmp.'))).toBe(false);
    expectSharedLockWorks(fixture.lockPaths);
  });

  it('accepts a fresh installer-style example copy only after chmod 600', () => {
    const installer = fs.readFileSync(INSTALLER, 'utf8');
    expect(installer).toMatch(
      /cp config\/openclaw[.]example[.]json config\/openclaw[.]json\s+chmod 600 config\/openclaw[.]json/u,
    );
    const fixture = makeFixture();

    fs.copyFileSync(EXAMPLE_CONFIG, fixture.configPath);
    if (process.platform !== 'win32') fs.chmodSync(fixture.configPath, 0o600);

    expectPrivateConfigMode(fixture.configPath);
    const initialized = maintenanceLease.ensureInitialized({
      ...fixture.lockPaths,
      externalStopVerified: true,
    });
    expect(initialized.created).toBe(true);
    expectSharedLockWorks(fixture.lockPaths);
  });
});
