import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const APPLIER_SOURCE = path.join(ROOT, 'scripts/bootstrap-profile/applier.cjs');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const require = createRequire(import.meta.url);
const applier = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');
process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS = '1';

type Paths = {
  rcRoot: string;
  configPath: string;
  workspace: string;
  stateDir: string;
  dbPath: string;
  globalConfigPath: string;
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function valueHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function treeDigest(root: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (current: string, relative: string) => {
    if (!fs.existsSync(current)) {
      hash.update(`${relative}:absent;`);
      return;
    }
    const metadata = fs.lstatSync(current);
    hash.update(`${relative}:${metadata.isDirectory() ? 'd' : 'f'}:${metadata.mode & 0o777};`);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), path.join(relative, name));
      }
    } else if (metadata.isFile()) {
      hash.update(fs.readFileSync(current));
    }
  };
  visit(root, '.');
  return hash.digest('hex');
}

function liveState(paths: Paths): Record<string, string> {
  const configRoot = path.join(path.dirname(paths.configPath), '.rc-bootstrap');
  return Object.fromEntries([
    paths.configPath,
    path.join(configRoot, 'receipt.json'),
    path.join(configRoot, 'peripheral-suspensions.json'),
    path.join(paths.workspace, 'skills'),
    path.join(paths.stateDir, 'agents/main/agent/auth-profiles.json'),
    paths.globalConfigPath,
    path.join(paths.stateDir, 'state/openclaw.sqlite'),
    path.join(paths.stateDir, 'state/openclaw.sqlite-wal'),
    path.join(paths.stateDir, 'state/openclaw.sqlite-shm'),
    paths.dbPath,
    `${paths.dbPath}-wal`,
    `${paths.dbPath}-shm`,
  ].map((target, index) => [`${index}:${path.basename(target)}`, treeDigest(target)]));
}

function makeHarness(): Paths & { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-security-'));
  temporaryRoots.push(root);
  const configRoot = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const dataRoot = path.join(root, 'data');
  for (const directory of [configRoot, workspace, stateDir, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
    models: { mode: 'merge', providers: {
      'user-provider': { baseUrl: 'https://user.invalid/v1', api: 'openai-completions', models: [] },
    } },
    plugins: { entries: {
      'research-claw-core': { enabled: true, config: { userField: 'preserve' } },
      'dual-model-supervisor': {
        enabled: false,
        config: { enabled: false, supervisorModel: 'user/model', reviewMode: 'off' },
      },
    } },
    tools: { deny: ['user-rule'] },
  });
  writeJson(paths.globalConfigPath, { userGlobal: true });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1,
    profiles: {
      'user-provider:manual': { type: 'api_key', provider: 'user-provider', key: 'USER_KEY' },
    },
  });
  return paths;
}

function capsule(): Buffer {
  const value = readJson(FIXTURE);
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function stage(paths: Paths, raw = capsule()): Promise<any> {
  try {
    ensureInitialized({ ...paths, externalStopVerified: true });
  } catch (error: any) {
    if (error?.code !== 'LOCK_AUTHORITY_EXISTS') throw error;
  }
  return applier.stageProfile({ ...paths, capsuleBytes: raw, rcVersion: '0.8.3' });
}

function transactionRoots(paths: Paths, txId: string): Record<string, string> {
  return {
    config: path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'transactions', txId),
    workspace: path.join(paths.workspace, '.rc-bootstrap-transactions', txId),
    state: path.join(paths.stateDir, '.rc-bootstrap-transactions', txId),
    data: path.join(path.dirname(paths.dbPath), '.rc-bootstrap-transactions', txId),
  };
}

async function applyUntilFault(paths: Paths, fault = 'auth'): Promise<{ staged: any; roots: Record<string, string> }> {
  const staged = await stage(paths);
  await expect(applier.applyProfile({
    ...paths, txId: staged.txId, fault, initializeLocks: false,
  }))
    .rejects.toMatchObject({ code: 'INJECTED_FAULT' });
  return { staged, roots: transactionRoots(paths, staged.txId) };
}

async function committedBeforeCleanupAuthorityPromotion(paths: Paths): Promise<{
  staged: any;
  roots: Record<string, string>;
  prepared: string;
  final: string;
}> {
  const staged = await stage(paths);
  await applier.applyProfile({ ...paths, txId: staged.txId, initializeLocks: false });
  await applier.verifyProfile({ ...paths, txId: staged.txId, initializeLocks: false });
  await expect(applier.commitProfile({
    ...paths, txId: staged.txId, fault: 'commit-intent', initializeLocks: false,
  })).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
  const roots = transactionRoots(paths, staged.txId);
  return {
    staged,
    roots,
    prepared: path.join(roots.config, `committed-cleanup-intent-${staged.txId}.json`),
    final: path.join(
      path.dirname(paths.configPath), '.rc-bootstrap', 'committed-cleanup', `${staged.txId}.json`,
    ),
  };
}

async function expectRejectedWithMaterial(
  operation: () => Promise<unknown>,
  roots: Record<string, string>,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect.soft(caught, 'the forged transaction must fail closed').toBeTruthy();
  for (const [volume, root] of Object.entries(roots)) {
    expect.soft(fs.existsSync(root), `${volume} recovery material must remain`).toBe(true);
  }
}

function rewriteMarker(file: string, edit: (marker: any) => void): void {
  const marker = readJson(file);
  edit(marker);
  marker.preimageDigest = valueHash({
    transactionTopology: marker.transactionTopology,
    assets: marker.assets.map(({ id, target, digest }: any) => ({ id, target, digest })),
    directories: marker.directories,
  });
  writeJson(file, marker);
}

describe('commit point and transaction state authentication', () => {
  it.each(['missing-embedded', 'missing-volume'] as const)(
    'does not clean a forged committed manifest with %s commit certification',
    async (variant) => {
      const paths = makeHarness();
      const staged = await stage(paths);
      await applier.applyProfile({ ...paths, txId: staged.txId, initializeLocks: false });
      await applier.verifyProfile({ ...paths, txId: staged.txId, initializeLocks: false });
      await expect(applier.commitProfile({
        ...paths, txId: staged.txId, fault: 'certificates-written', initializeLocks: false,
      })).rejects.toMatchObject({ code: 'INJECTED_FAULT' });

      const roots = transactionRoots(paths, staged.txId);
      const manifestFile = path.join(roots.config, 'manifest.json');
      const manifest = readJson(manifestFile);
      const certificate = readJson(path.join(roots.config, 'commit-certificate.json'));
      manifest.state = 'committed';
      manifest.commitCertificate = variant === 'missing-embedded' ? null : certificate;
      writeJson(manifestFile, manifest);
      if (variant === 'missing-volume') {
        fs.rmSync(path.join(roots.state, 'commit-certificate.json'));
      }

      await expectRejectedWithMaterial(
        () => applier.rollbackProfile({ ...paths, txId: staged.txId, initializeLocks: false }),
        roots,
      );
    },
    30_000,
  );

  it('rejects a manifest state backshift instead of treating applying markers as preparing debris', async () => {
    const paths = makeHarness();
    const { staged, roots } = await applyUntilFault(paths);
    const manifestFile = path.join(roots.config, 'manifest.json');
    const manifest = readJson(manifestFile);
    expect(manifest.state).toBe('applying');
    manifest.state = 'preparing';
    writeJson(manifestFile, manifest);

    await expectRejectedWithMaterial(
      () => applier.rollbackProfile({ ...paths, txId: staged.txId, initializeLocks: false }),
      roots,
    );
  });

  it('rejects a tampered certificate among an otherwise valid partial pre-commit set', async () => {
    const paths = makeHarness();
    const staged = await stage(paths);
    await applier.applyProfile({ ...paths, txId: staged.txId, initializeLocks: false });
    await applier.verifyProfile({ ...paths, txId: staged.txId, initializeLocks: false });
    await expect(applier.commitProfile({
      ...paths, txId: staged.txId, fault: 'certificate-workspace', initializeLocks: false,
    })).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    const roots = transactionRoots(paths, staged.txId);
    const workspaceCertificate = path.join(roots.workspace, 'commit-certificate.json');
    const tampered = readJson(workspaceCertificate);
    tampered.digest = '0'.repeat(64);
    writeJson(workspaceCertificate, tampered);

    await expectRejectedWithMaterial(
      () => applier.rollbackProfile({ ...paths, txId: staged.txId, initializeLocks: false }),
      roots,
    );
  });

  it('validates every remaining committed marker and certificate before partial cleanup resumes', async () => {
    const paths = makeHarness();
    const staged = await stage(paths);
    await applier.applyProfile({ ...paths, txId: staged.txId, initializeLocks: false });
    await applier.verifyProfile({ ...paths, txId: staged.txId, initializeLocks: false });
    await expect(applier.commitProfile({
      ...paths, txId: staged.txId, fault: 'cleanup-workspace-renamed', initializeLocks: false,
    })).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    const roots = transactionRoots(paths, staged.txId);
    const workspaceTombstone = path.join(
      paths.workspace, '.rc-bootstrap-committed-cleanup', staged.txId,
    );
    expect(fs.existsSync(workspaceTombstone)).toBe(true);
    const dataCertificate = path.join(roots.data, 'commit-certificate.json');
    const tampered = readJson(dataCertificate);
    tampered.digest = '0'.repeat(64);
    writeJson(dataCertificate, tampered);

    await expect(applier.recoverProfiles({ ...paths, initializeLocks: false }))
      .rejects.toMatchObject({ code: 'INVALID_COMMIT_CERTIFICATE' });
    expect(fs.existsSync(roots.workspace)).toBe(false);
    // Recovery is allowed to finish deleting an already authenticated earlier
    // tombstone before a later remaining source root proves tampered. It must
    // not touch that later root, the other remaining roots, or live state.
    expect(fs.existsSync(workspaceTombstone)).toBe(false);
    expect(fs.existsSync(roots.state)).toBe(false);
    for (const volume of ['config', 'data']) expect(fs.existsSync(roots[volume])).toBe(true);
  });

  it.each(['payload', 'mode', 'hardlink'] as const)(
    'rejects a committed tx-local prepared cleanup authority with bad %s before cleanup',
    async (variant) => {
      const paths = makeHarness();
      const transaction = await committedBeforeCleanupAuthorityPromotion(paths);
      const before = liveState(paths);
      if (variant === 'payload') {
        const prepared = readJson(transaction.prepared);
        prepared.digest = '0'.repeat(64);
        writeJson(transaction.prepared, prepared);
      } else if (variant === 'mode') {
        fs.chmodSync(transaction.prepared, 0o644);
      } else {
        const replacement = `${transaction.prepared}.hardlink`;
        fs.linkSync(transaction.prepared, replacement);
      }

      await expect(applier.recoverProfiles({ ...paths, initializeLocks: false }))
        .rejects.toMatchObject({ code: 'INVALID_COMMITTED_CLEANUP_INTENT' });
      expect(liveState(paths)).toEqual(before);
      for (const root of Object.values(transaction.roots)) expect(fs.existsSync(root)).toBe(true);
    },
    30_000,
  );

  it('rejects unknown tx-local cleanup authority material before publishing or cleanup', async () => {
    const paths = makeHarness();
    const transaction = await committedBeforeCleanupAuthorityPromotion(paths);
    const before = liveState(paths);
    writeJson(path.join(transaction.roots.config, 'committed-cleanup-intent-unknown.json'), {
      unexpected: true,
    });

    await expect(applier.recoverProfiles({ ...paths, initializeLocks: false }))
      .rejects.toMatchObject({ code: 'INVALID_COMMITTED_CLEANUP_INTENT' });
    expect(liveState(paths)).toEqual(before);
    expect(fs.existsSync(transaction.final)).toBe(false);
    for (const root of Object.values(transaction.roots)) expect(fs.existsSync(root)).toBe(true);
  });

  it.each(['bad-payload', 'inconsistent-collision'] as const)(
    'rejects an external final cleanup authority %s before any volume cleanup',
    async (variant) => {
      const paths = makeHarness();
      const transaction = await committedBeforeCleanupAuthorityPromotion(paths);
      const before = liveState(paths);
      fs.mkdirSync(path.dirname(transaction.final), { recursive: true, mode: 0o700 });
      if (variant === 'bad-payload') {
        fs.writeFileSync(transaction.final, '{not-json}\n', { mode: 0o600 });
      } else {
        const collision = readJson(transaction.prepared);
        collision.rootIdentities.config.ino = String(
          BigInt(collision.rootIdentities.config.ino) + 1n,
        );
        collision.digest = valueHash(Object.fromEntries(
          Object.entries(collision).filter(([key]) => key !== 'digest'),
        ));
        writeJson(transaction.final, collision);
      }

      await expect(applier.recoverProfiles({ ...paths, initializeLocks: false }))
        .rejects.toMatchObject({ code: 'INVALID_COMMITTED_CLEANUP_INTENT' });
      expect(liveState(paths)).toEqual(before);
      expect(fs.existsSync(transaction.prepared)).toBe(true);
      expect(fs.existsSync(transaction.final)).toBe(true);
      for (const root of Object.values(transaction.roots)) expect(fs.existsSync(root)).toBe(true);
    },
    30_000,
  );
});

describe('marker topology and identity binding', () => {
  it('rejects an internally rehashed marker whose asset target was substituted', async () => {
    const paths = makeHarness();
    const { staged, roots } = await applyUntilFault(paths);
    rewriteMarker(path.join(roots.state, 'volume-marker.json'), (marker) => {
      const auth = marker.assets.find((asset: any) => asset.id === 'auth');
      expect(auth).toBeTruthy();
      auth.target = path.relative(paths.stateDir, paths.globalConfigPath);
    });

    await expectRejectedWithMaterial(
      () => applier.rollbackProfile({ ...paths, txId: staged.txId, initializeLocks: false }),
      roots,
    );
  });

  it('rejects one marker carrying a self-consistent but mixed profile identity', async () => {
    const paths = makeHarness();
    const { staged, roots } = await applyUntilFault(paths);
    rewriteMarker(path.join(roots.workspace, 'volume-marker.json'), (marker) => {
      marker.profileId = 'thermoelectric-user-b';
      marker.manifestIdentity = valueHash({
        txId: staged.txId,
        profileId: marker.profileId,
        digest: marker.capsuleDigest,
      });
    });

    await expectRejectedWithMaterial(
      () => applier.rollbackProfile({ ...paths, txId: staged.txId, initializeLocks: false }),
      roots,
    );
  });

  it('rejects manifest volume preimage digests swapped across otherwise valid markers', async () => {
    const paths = makeHarness();
    const { staged, roots } = await applyUntilFault(paths);
    const manifestFile = path.join(roots.config, 'manifest.json');
    const manifest = readJson(manifestFile);
    expect(manifest.volumeMarkers.config).not.toBe(manifest.volumeMarkers.state);
    [manifest.volumeMarkers.config, manifest.volumeMarkers.state] = [
      manifest.volumeMarkers.state,
      manifest.volumeMarkers.config,
    ];
    writeJson(manifestFile, manifest);

    await expectRejectedWithMaterial(
      () => applier.rollbackProfile({ ...paths, txId: staged.txId, initializeLocks: false }),
      roots,
    );
  });
});

describe('config-volume loss evidence ordering', () => {
  it('passes a durable incident writer into orphan restoration before cleanup can begin', () => {
    const source = fs.readFileSync(APPLIER_SOURCE, 'utf8');
    const start = source.indexOf('async function recoverProfiles(');
    const end = source.indexOf('\nasync function profileStatus(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const implementation = source.slice(start, end);
    const restore = implementation.indexOf('restoreOrphanSatellites(paths, txId, (planned) =>');
    const write = implementation.indexOf('writeRecoveryIncident(paths, incident)', restore);

    expect(restore).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThanOrEqual(0);
    const helperStart = source.indexOf('function restoreOrphanSatellites(');
    const helperEnd = source.indexOf('\nasync function rollbackProfile(', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    expect(helper.indexOf('beforeCleanup(')).toBeGreaterThanOrEqual(0);
    expect(helper.indexOf('beforeCleanup(')).toBeLessThan(helper.indexOf('restorePath('));
    expect(helper.indexOf('beforeCleanup(')).toBeLessThan(helper.indexOf('removePath(roots[volume])'));
  });
});

describe('certificate-free orphan marker authentication', () => {
  it('rejects mixed prepared orphan identities before cleaning any partial satellite', async () => {
    const paths = makeHarness();
    const staged = await stage(paths);
    await expect(applier.applyProfile({
      ...paths, txId: staged.txId, fault: 'prepare-state', initializeLocks: false,
    })).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    const roots = transactionRoots(paths, staged.txId);
    fs.rmSync(roots.config, { recursive: true });
    rewriteMarker(path.join(roots.workspace, 'volume-marker.json'), (marker) => {
      marker.profileId = 'thermoelectric-user-b';
      marker.manifestIdentity = valueHash({
        txId: staged.txId, profileId: marker.profileId, digest: marker.capsuleDigest,
      });
    });
    const before = {
      workspace: treeDigest(roots.workspace),
      state: treeDigest(roots.state),
    };

    await expect(applier.recoverProfiles({ ...paths, initializeLocks: false }))
      .rejects.toMatchObject({ code: 'INVALID_VOLUME_MARKER' });
    expect({
      workspace: treeDigest(roots.workspace),
      state: treeDigest(roots.state),
    }).toEqual(before);
  });

  it('rejects a self-consistent orphan marker whose asset target is not canonical', async () => {
    const paths = makeHarness();
    const { staged, roots } = await applyUntilFault(paths);
    fs.rmSync(roots.config, { recursive: true });
    const substitutedTarget = path.relative(paths.stateDir, paths.globalConfigPath);
    for (const volume of ['workspace', 'state', 'data']) {
      rewriteMarker(path.join(roots[volume], 'volume-marker.json'), (marker) => {
        const topologyAuth = marker.transactionTopology.state.assets.find(
          (asset: any) => asset.id === 'auth',
        );
        expect(topologyAuth).toBeTruthy();
        topologyAuth.target = substitutedTarget;
        if (volume === 'state') {
          const auth = marker.assets.find((asset: any) => asset.id === 'auth');
          expect(auth).toBeTruthy();
          auth.target = substitutedTarget;
        }
      });
    }
    const before = {
      workspace: treeDigest(paths.workspace),
      state: treeDigest(paths.stateDir),
      data: treeDigest(path.dirname(paths.dbPath)),
    };

    await expect(applier.recoverProfiles({ ...paths, initializeLocks: false }))
      .rejects.toMatchObject({ code: 'INVALID_VOLUME_MARKER' });
    expect({
      workspace: treeDigest(paths.workspace),
      state: treeDigest(paths.stateDir),
      data: treeDigest(path.dirname(paths.dbPath)),
    }).toEqual(before);
    for (const volume of ['workspace', 'state', 'data']) expect(fs.existsSync(roots[volume])).toBe(true);
  });

  it.each(['profileId', 'capsuleDigest', 'manifestIdentity'] as const)(
    'rejects a certificate-free orphan set with a mixed %s binding',
    async (field) => {
      const paths = makeHarness();
      const { staged, roots } = await applyUntilFault(paths);
      fs.rmSync(roots.config, { recursive: true });
      rewriteMarker(path.join(roots.workspace, 'volume-marker.json'), (marker) => {
        if (field === 'profileId') marker.profileId = 'thermoelectric-user-b';
        if (field === 'capsuleDigest') marker.capsuleDigest = '1'.repeat(64);
        marker.manifestIdentity = field === 'manifestIdentity'
          ? '2'.repeat(64)
          : valueHash({
            txId: staged.txId,
            profileId: marker.profileId,
            digest: marker.capsuleDigest,
          });
      });
      const before = {
        workspace: treeDigest(paths.workspace),
        state: treeDigest(paths.stateDir),
        data: treeDigest(path.dirname(paths.dbPath)),
      };

      await expect(applier.recoverProfiles({ ...paths, initializeLocks: false }))
        .rejects.toMatchObject({ code: 'INVALID_VOLUME_MARKER' });
      expect({
        workspace: treeDigest(paths.workspace),
        state: treeDigest(paths.stateDir),
        data: treeDigest(path.dirname(paths.dbPath)),
      }).toEqual(before);
      for (const volume of ['workspace', 'state', 'data']) expect(fs.existsSync(roots[volume])).toBe(true);
    },
    30_000,
  );
});

describe('database hardlink safety', () => {
  it('never opts database assets out of hardlink rejection while capturing live preimages', () => {
    const source = fs.readFileSync(APPLIER_SOURCE, 'utf8');
    const start = source.indexOf('function createVolumeMarkers(');
    const end = source.indexOf('\nfunction updateManifest(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const implementation = source.slice(start, end);

    expect(implementation).not.toMatch(
      /allowHardlink:\s*\/\^\(\?:cron\|rc\)-\(\?:db\|wal\|shm\)\$\/[.]test\(asset[.]id\)/,
    );
  });
});
