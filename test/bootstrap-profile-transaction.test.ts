import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const require = createRequire(import.meta.url);
const {
  ensureInitialized,
  initializeAfterConfigVolumeLoss,
} = require('../scripts/bootstrap-profile/maintenance-lease.cjs');
process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS = '1';
const applier: {
  stageProfile(options: Paths & { capsuleBytes: Buffer; rcVersion: string }): Promise<any>;
  applyProfile(options: Paths & { txId: string; fault?: string }): Promise<any>;
  verifyProfile(options: Paths & { txId: string }): Promise<any>;
  commitProfile(options: Paths & { txId: string }): Promise<any>;
  rollbackProfile(options: Paths & { txId: string }): Promise<any>;
  recoverProfiles(options: Paths): Promise<any>;
  profileStatus(options: Paths): Promise<any>;
} = require('../scripts/bootstrap-profile/applier.cjs');

type Paths = {
  rcRoot: string;
  configPath: string;
  workspace: string;
  stateDir: string;
  dbPath: string;
  globalConfigPath: string;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function makePaths(): Paths & { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-tx-'));
  roots.push(root);
  const configRoot = path.join(root, 'config-volume');
  const workspace = path.join(root, 'workspace-volume');
  const stateDir = path.join(root, 'state-volume');
  const dataRoot = path.join(root, 'data-volume');
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
      'dual-model-supervisor': { enabled: false, config: {
        enabled: false, supervisorModel: 'user-reviewer/model', reviewMode: 'off', userField: true,
      } },
    } },
    tools: { deny: ['user_deny'] },
  });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1,
    profiles: { 'user-provider:manual': { type: 'api_key', provider: 'user-provider', key: 'USER_FAKE_KEY' } },
  });
  writeJson(paths.globalConfigPath, { userGlobal: true });
  fs.mkdirSync(path.join(workspace, 'skills', 'user-skill'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'skills', 'user-skill', 'SKILL.md'),
    '---\nname: user-skill\ndescription: user owned\n---\n');
  ensureInitialized({ ...paths, externalStopVerified: true });
  return paths;
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
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), path.join(relative, name));
    } else {
      hash.update(fs.readFileSync(current));
    }
  };
  visit(root, '.');
  return hash.digest('hex');
}

function liveDigest(paths: ReturnType<typeof makePaths>): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    config: treeDigest(paths.configPath),
    receipt: treeDigest(path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'receipt.json')),
    suspensions: treeDigest(path.join(
      path.dirname(paths.configPath), '.rc-bootstrap', 'peripheral-suspensions.json',
    )),
    skills: treeDigest(path.join(paths.workspace, 'skills')),
    auth: treeDigest(path.join(paths.stateDir, 'agents/main/agent/auth-profiles.json')),
    globalConfig: treeDigest(paths.globalConfigPath),
    cronDb: treeDigest(path.join(paths.stateDir, 'state/openclaw.sqlite')),
    cronWal: treeDigest(path.join(paths.stateDir, 'state/openclaw.sqlite-wal')),
    cronShm: treeDigest(path.join(paths.stateDir, 'state/openclaw.sqlite-shm')),
    rcDb: treeDigest(paths.dbPath),
    rcWal: treeDigest(`${paths.dbPath}-wal`),
    rcShm: treeDigest(`${paths.dbPath}-shm`),
  })).digest('hex');
}

function transactionRoot(paths: ReturnType<typeof makePaths>, txId: string): string {
  return path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'transactions', txId);
}

function volumeMarkerRoots(paths: ReturnType<typeof makePaths>, txId: string): string[] {
  return [
    transactionRoot(paths, txId),
    path.join(paths.workspace, '.rc-bootstrap-transactions', txId),
    path.join(paths.stateDir, '.rc-bootstrap-transactions', txId),
    path.join(path.dirname(paths.dbPath), '.rc-bootstrap-transactions', txId),
  ];
}

async function stage(paths: ReturnType<typeof makePaths>, raw = fs.readFileSync(FIXTURE)): Promise<any> {
  return applier.stageProfile({ ...paths, capsuleBytes: raw, rcVersion: '0.8.3' });
}

function mutate<T>(paths: Paths, operation: () => Promise<T>): Promise<T> {
  void paths;
  return operation();
}

describe('transaction stage and ownership', () => {
  it('stage is isolated, creates a secret-bearing 0700/0600 transaction, and does not read live cron', async () => {
    const paths = makePaths();
    const before = {
      config: treeDigest(paths.configPath),
      workspace: treeDigest(paths.workspace),
      state: treeDigest(path.join(paths.stateDir, 'agents')),
      globalConfig: treeDigest(paths.globalConfigPath),
      cron: treeDigest(path.join(paths.stateDir, 'state')),
      data: treeDigest(paths.dbPath),
    };
    const staged = await stage(paths);

    expect(staged).toMatchObject({ state: 'staged', profileId: 'thermoelectric-user-a', revision: 1 });
    expect(treeDigest(paths.configPath)).toBe(before.config);
    expect(treeDigest(paths.workspace)).toBe(before.workspace);
    expect(treeDigest(path.join(paths.stateDir, 'agents'))).toBe(before.state);
    expect(treeDigest(paths.globalConfigPath)).toBe(before.globalConfig);
    expect(treeDigest(path.join(paths.stateDir, 'state'))).toBe(before.cron);
    expect(treeDigest(paths.dbPath)).toBe(before.data);
    expect(fs.existsSync(path.join(paths.stateDir, 'state/openclaw.sqlite'))).toBe(false);
    const txRoot = transactionRoot(paths, staged.txId);
    expect(fs.statSync(txRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(txRoot, 'capsule.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(txRoot, 'manifest.json'), 'utf8')))
      .not.toHaveProperty('modelApiKey');
  });

  it('rejects lower revision and same revision with a different raw digest before mutation', async () => {
    const paths = makePaths();
    const installed = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    installed.profile.revision = 2;
    const first = await stage(paths, Buffer.from(`${JSON.stringify(installed)}\n`));
    await mutate(paths, () => applier.applyProfile({ ...paths, txId: first.txId }));
    await applier.verifyProfile({ ...paths, txId: first.txId });
    await applier.commitProfile({ ...paths, txId: first.txId });

    const lower = fs.readFileSync(FIXTURE);
    await expect(stage(paths, lower))
      .rejects.toMatchObject({ code: 'REVISION_ROLLBACK' });

    const conflicting = structuredClone(installed);
    conflicting.model.model.name += ' conflict';
    await expect(stage(paths, Buffer.from(`${JSON.stringify(conflicting)}\n`)))
      .rejects.toMatchObject({ code: 'REVISION_DIGEST_CONFLICT' });
  });

  it('fails closed on an unowned target Skill or same-name workspace Skill', async () => {
    const paths = makePaths();
    const raw = fs.readFileSync(FIXTURE);
    const capsule = JSON.parse(raw.toString('utf8'));
    const slug = capsule.skills.items[0].slug;
    const unowned = path.join(paths.workspace, 'skills', `rc-profile--${capsule.profile.id}--${slug}`);
    fs.mkdirSync(unowned, { recursive: true });
    fs.writeFileSync(path.join(unowned, 'user.txt'), 'do not overwrite');
    await expect(stage(paths)).rejects.toMatchObject({ code: 'UNOWNED_SKILL_TARGET' });

    fs.rmSync(unowned, { recursive: true });
    const conflict = path.join(paths.workspace, 'skills', 'another-user-skill');
    fs.mkdirSync(conflict);
    fs.writeFileSync(path.join(conflict, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: conflict\n---\n`);
    await expect(stage(paths)).rejects.toMatchObject({ code: 'SKILL_NAME_CONFLICT' });
  });

  it('rejects non-object config parents and fresh collisions with managed provider/auth IDs', async () => {
    const invalidParent = makePaths();
    const invalidConfig = JSON.parse(fs.readFileSync(invalidParent.configPath, 'utf8'));
    invalidConfig.plugins = 'user-non-object';
    writeJson(invalidParent.configPath, invalidConfig);
    const stagedInvalid = await stage(invalidParent);
    await expect(mutate(invalidParent, () => applier.applyProfile({
      ...invalidParent, txId: stagedInvalid.txId,
    }))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(JSON.parse(fs.readFileSync(invalidParent.configPath, 'utf8')).plugins).toBe('user-non-object');

    const collision = makePaths();
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const providerId = raw.model.providerId;
    const authId = `${providerId}:managed`;
    const config = JSON.parse(fs.readFileSync(collision.configPath, 'utf8'));
    config.models.providers[providerId] = { user: true };
    writeJson(collision.configPath, config);
    const authFile = path.join(collision.stateDir, 'agents/main/agent/auth-profiles.json');
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    auth.profiles[authId] = { type: 'api_key', provider: providerId, key: 'USER_COLLISION_KEY' };
    writeJson(authFile, auth);
    await expect(stage(collision)).rejects.toMatchObject({ code: 'UNOWNED_MANAGED_TARGET' });
    expect(fs.existsSync(path.join(
      path.dirname(collision.configPath), '.rc-bootstrap', 'transactions',
    )) ? fs.readdirSync(path.join(
        path.dirname(collision.configPath), '.rc-bootstrap', 'transactions',
      )) : []).toEqual([]);
    expect(JSON.parse(fs.readFileSync(authFile, 'utf8')).profiles[authId].key).toBe('USER_COLLISION_KEY');
  });
});

describe('four-volume transaction and rollback', () => {
  it('makes the public mutator hold the canonical lock and preserves user-owned assets', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    const beforeUserSkill = treeDigest(path.join(paths.workspace, 'skills', 'user-skill'));
    const applied = await mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId }));
    expect(applied.state).toBe('applied');
    expect(treeDigest(path.join(paths.workspace, 'skills', 'user-skill'))).toBe(beforeUserSkill);
    const config = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
    expect(config.models.providers['user-provider']).toBeTruthy();
    expect(config.tools.deny).toEqual(['user_deny', 'periph_*', 'plaud__*']);
    expect(config.plugins.entries['research-claw-core'].config.userField).toBe('preserve');
    expect(config.models.providers['custom-rc-profile-thermoelectric-user-a'].apiKey)
      .toBe('custom-rc-profile-thermoelectric-user-a:managed');
    expect(JSON.stringify(config)).not.toContain('RC_TEST_ONLY_FAKE_MODEL_KEY');

    for (const volume of ['config', 'workspace', 'state', 'data']) {
      expect(applied.volumeMarkers[volume]).toMatchObject({ txId: staged.txId, state: 'applied' });
      expect(applied.volumeMarkers[volume].preimageDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.each([
    'skills', 'auth', 'config', 'monitor', 'cron', 'suspensions', 'receipt',
  ])('rolls back byte-exactly after the %s swap fault', async (fault) => {
    const paths = makePaths();
    const staged = await stage(paths);
    const before = liveDigest(paths);
    await expect(mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId, fault })))
      .rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    for (const markerRoot of volumeMarkerRoots(paths, staged.txId)) expect(fs.existsSync(markerRoot)).toBe(true);
    await mutate(paths, () => applier.rollbackProfile({ ...paths, txId: staged.txId }));
    expect(liveDigest(paths)).toBe(before);
    for (const markerRoot of volumeMarkerRoots(paths, staged.txId)) expect(fs.existsSync(markerRoot)).toBe(false);
  });

  it('keeps four-volume recovery material until one consistent commit certificate exists', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    await mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId }));
    await applier.verifyProfile({ ...paths, txId: staged.txId });

    const beforeCommit = await applier.profileStatus(paths);
    expect(beforeCommit.pendingTransaction.state).toBe('verified');
    expect(beforeCommit.commitCertificate).toBeNull();
    const committed = await applier.commitProfile({ ...paths, txId: staged.txId });
    expect(committed.commitCertificate.volumes).toEqual(['config', 'workspace', 'state', 'data']);
    expect(committed.commitCertificate.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await applier.profileStatus(paths)).toMatchObject({
      profile: { id: 'thermoelectric-user-a', revision: 1 },
      pendingTransaction: null,
    });
  });

  it.each([1, 2, 3])(
    'treats %i durable commit certificates before the global commit point as prepared progress',
    async (writtenCertificates) => {
      const paths = makePaths();
      const before = liveDigest(paths);
      const staged = await stage(paths);
      await mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId }));
      await applier.verifyProfile({ ...paths, txId: staged.txId });
      await expect(applier.commitProfile({
        ...paths, txId: staged.txId, fault: `certificate-${[
          'config', 'workspace', 'state',
        ][writtenCertificates - 1]}`,
      } as any)).rejects.toMatchObject({ code: 'INJECTED_FAULT' });

      const roots = volumeMarkerRoots(paths, staged.txId);
      expect(roots.filter((root) => fs.existsSync(
        path.join(root, 'commit-certificate.json'),
      ))).toHaveLength(writtenCertificates);

      const recovered = await mutate(paths, () => applier.recoverProfiles({ ...paths }));
      expect(recovered.recovered).toEqual([staged.txId]);
      expect(liveDigest(paths)).toBe(before);
      for (const root of roots) expect(fs.existsSync(root)).toBe(false);
    },
    30_000,
  );

  it('treats the durable committed manifest as the commit point and recovery only finishes cleanup', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    await mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId }));
    await applier.verifyProfile({ ...paths, txId: staged.txId });
    const newState = liveDigest(paths);

    await expect(applier.commitProfile({ ...paths, txId: staged.txId, fault: 'commit-intent' } as any))
      .rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    const roots = volumeMarkerRoots(paths, staged.txId);
    const manifest = JSON.parse(fs.readFileSync(path.join(roots[0], 'manifest.json'), 'utf8'));
    expect(manifest.state).toBe('committed');
    for (const root of roots) {
      const marker = JSON.parse(fs.readFileSync(path.join(root, 'volume-marker.json'), 'utf8'));
      const certificate = JSON.parse(fs.readFileSync(path.join(root, 'commit-certificate.json'), 'utf8'));
      const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
          : value;
      const digest = crypto.createHash('sha256').update(JSON.stringify(stable(marker))).digest('hex');
      expect(certificate.markerDigests[marker.volume]).toBe(digest);
    }

    const recovered = await mutate(paths, () => applier.recoverProfiles({ ...paths }));
    expect(recovered.recovered).toEqual([staged.txId]);
    expect(liveDigest(paths)).toBe(newState);
    for (const root of roots) expect(fs.existsSync(root)).toBe(false);
  });

  it.each([1, 2, 3])(
    'idempotently finishes committed cleanup when %i satellite transaction roots are already absent',
    async (cleanedRoots) => {
      const paths = makePaths();
      const staged = await stage(paths);
      await mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId }));
      await applier.verifyProfile({ ...paths, txId: staged.txId });
      const committedLive = liveDigest(paths);
      await expect(applier.commitProfile({
        ...paths, txId: staged.txId, fault: 'cleanup-intent',
      } as any)).rejects.toMatchObject({ code: 'INJECTED_FAULT' });

      const roots = volumeMarkerRoots(paths, staged.txId);
      // Model an interrupted cleanup after exact same-filesystem root renames.
      const cleanupRoots = [
        path.join(paths.workspace, '.rc-bootstrap-committed-cleanup', staged.txId),
        path.join(paths.stateDir, '.rc-bootstrap-committed-cleanup', staged.txId),
        path.join(path.dirname(paths.dbPath), '.rc-bootstrap-committed-cleanup', staged.txId),
      ];
      for (let index = 0; index < cleanedRoots; index += 1) {
        fs.mkdirSync(path.dirname(cleanupRoots[index]), { recursive: true, mode: 0o700 });
        fs.renameSync(roots[index + 1], cleanupRoots[index]);
        fs.rmSync(cleanupRoots[index], { recursive: true });
      }

      const recovered = await mutate(paths, () => applier.recoverProfiles({ ...paths }));
      expect(recovered.recovered).toEqual([staged.txId]);
      expect(liveDigest(paths)).toBe(committedLive);
      for (const root of roots) expect(fs.existsSync(root)).toBe(false);
    },
    30_000,
  );

  it('cleans partial preparing markers without touching live assets', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    const before = liveDigest(paths);
    await expect(mutate(paths, () => applier.applyProfile({
      ...paths, txId: staged.txId, fault: 'prepare-workspace',
    }))).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    expect(JSON.parse(fs.readFileSync(path.join(transactionRoot(paths, staged.txId), 'manifest.json'), 'utf8')).state)
      .toBe('preparing');
    await mutate(paths, () => applier.recoverProfiles({ ...paths }));
    expect(liveDigest(paths)).toBe(before);
    for (const root of volumeMarkerRoots(paths, staged.txId)) expect(fs.existsSync(root)).toBe(false);
  });

  it('fails closed and preserves recovery material when any marker or snapshot is incomplete', async () => {
    const missing = makePaths();
    const stagedMissing = await stage(missing);
    await expect(mutate(missing, () => applier.applyProfile({
      ...missing, txId: stagedMissing.txId, fault: 'auth',
    }))).rejects.toBeTruthy();
    const missingRoots = volumeMarkerRoots(missing, stagedMissing.txId);
    fs.rmSync(path.join(missingRoots[2], 'volume-marker.json'));
    await expect(mutate(missing, () => applier.rollbackProfile({ ...missing, txId: stagedMissing.txId })))
      .rejects.toMatchObject({ code: 'INCOMPLETE_TRANSACTION_PREIMAGE' });
    expect(fs.existsSync(missingRoots[0])).toBe(true);

    const tampered = makePaths();
    const stagedTampered = await stage(tampered);
    await expect(mutate(tampered, () => applier.applyProfile({
      ...tampered, txId: stagedTampered.txId, fault: 'auth',
    }))).rejects.toBeTruthy();
    const tamperedRoots = volumeMarkerRoots(tampered, stagedTampered.txId);
    const marker = JSON.parse(fs.readFileSync(path.join(tamperedRoots[2], 'volume-marker.json'), 'utf8'));
    const auth = marker.assets.find((asset: any) => asset.id === 'auth');
    const snapshot = path.join(tamperedRoots[2], auth.snapshot, 'content', '__root_file__');
    fs.appendFileSync(snapshot, 'tamper');
    await expect(mutate(tampered, () => applier.rollbackProfile({ ...tampered, txId: stagedTampered.txId })))
      .rejects.toMatchObject({ code: 'INVALID_TRANSACTION_PREIMAGE' });
    expect(fs.existsSync(tamperedRoots[0])).toBe(true);
  });

  it('rejects forged manifest/marker keys and symlink snapshot types without cleaning recovery material', async () => {
    const manifestCase = makePaths();
    const stagedManifest = await stage(manifestCase);
    const manifestFile = path.join(transactionRoot(manifestCase, stagedManifest.txId), 'manifest.json');
    const forgedManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    forgedManifest.unexpected = true;
    fs.writeFileSync(manifestFile, `${JSON.stringify(forgedManifest)}\n`);
    await expect(mutate(manifestCase, () => applier.applyProfile({
      ...manifestCase, txId: stagedManifest.txId,
    }))).rejects.toMatchObject({ code: 'INVALID_TRANSACTION' });
    expect(fs.existsSync(transactionRoot(manifestCase, stagedManifest.txId))).toBe(true);

    const markerCase = makePaths();
    const stagedMarker = await stage(markerCase);
    await expect(mutate(markerCase, () => applier.applyProfile({
      ...markerCase, txId: stagedMarker.txId, fault: 'auth',
    }))).rejects.toBeTruthy();
    const markerRoots = volumeMarkerRoots(markerCase, stagedMarker.txId);
    const markerFile = path.join(markerRoots[2], 'volume-marker.json');
    const forgedMarker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    forgedMarker.assets[0].unexpected = true;
    fs.writeFileSync(markerFile, `${JSON.stringify(forgedMarker)}\n`);
    await expect(mutate(markerCase, () => applier.rollbackProfile({ ...markerCase, txId: stagedMarker.txId })))
      .rejects.toMatchObject({ code: 'INVALID_VOLUME_MARKER' });
    for (const root of markerRoots) expect(fs.existsSync(root)).toBe(true);

    const snapshotCase = makePaths();
    const stagedSnapshot = await stage(snapshotCase);
    await expect(mutate(snapshotCase, () => applier.applyProfile({
      ...snapshotCase, txId: stagedSnapshot.txId, fault: 'auth',
    }))).rejects.toBeTruthy();
    const snapshotRoots = volumeMarkerRoots(snapshotCase, stagedSnapshot.txId);
    const stateMarker = JSON.parse(fs.readFileSync(path.join(snapshotRoots[2], 'volume-marker.json'), 'utf8'));
    const auth = stateMarker.assets.find((asset: any) => asset.id === 'auth');
    const snapshotMetadata = path.join(snapshotRoots[2], auth.snapshot, 'snapshot.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotMetadata, 'utf8'));
    snapshot.entries[0].type = 'symlink';
    fs.writeFileSync(snapshotMetadata, `${JSON.stringify(snapshot)}\n`);
    await expect(mutate(snapshotCase, () => applier.rollbackProfile({ ...snapshotCase, txId: stagedSnapshot.txId })))
      .rejects.toMatchObject({ code: 'INVALID_TRANSACTION_PREIMAGE' });
    for (const root of snapshotRoots) expect(fs.existsSync(root)).toBe(true);
  });

  it('recover deterministically restores an interrupted applied transaction', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    const before = liveDigest(paths);
    await expect(mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId, fault: 'auth' })))
      .rejects.toBeTruthy();
    for (const markerRoot of volumeMarkerRoots(paths, staged.txId)) expect(fs.existsSync(markerRoot)).toBe(true);
    const recovered = await mutate(paths, () => applier.recoverProfiles({ ...paths }));
    expect(recovered).toMatchObject({ recovered: [staged.txId] });
    expect(liveDigest(paths)).toBe(before);
    for (const markerRoot of volumeMarkerRoots(paths, staged.txId)) expect(fs.existsSync(markerRoot)).toBe(false);
  });

  it('discovers orphan satellite markers when the config transaction metadata is lost', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    const before = {
      workspace: treeDigest(path.join(paths.workspace, 'skills')),
      state: treeDigest(path.join(paths.stateDir, 'agents')),
      globalConfig: treeDigest(paths.globalConfigPath),
      cron: treeDigest(path.join(paths.stateDir, 'state')),
      data: treeDigest(paths.dbPath),
      config: treeDigest(paths.configPath),
    };
    await expect(mutate(paths, () => applier.applyProfile({
      ...paths, txId: staged.txId, fault: 'auth',
    }))).rejects.toBeTruthy();
    const roots = volumeMarkerRoots(paths, staged.txId);
    fs.rmSync(roots[0], { recursive: true });

    await expect(mutate(paths, () => applier.recoverProfiles({ ...paths })))
      .rejects.toMatchObject({ code: 'CONFIG_VOLUME_LOST' });
    expect(treeDigest(path.join(paths.workspace, 'skills'))).toBe(before.workspace);
    expect(treeDigest(path.join(paths.stateDir, 'agents'))).toBe(before.state);
    expect(treeDigest(paths.globalConfigPath)).toBe(before.globalConfig);
    expect(treeDigest(path.join(paths.stateDir, 'state'))).toBe(before.cron);
    expect(treeDigest(paths.dbPath)).toBe(before.data);
    // Config is explicitly unknown once its preimage and global commit point
    // are lost; recovery only promises the three independently recoverable volumes.
    for (const root of roots) expect(fs.existsSync(root)).toBe(false);
    const incidents = [
      path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'recovery-incidents', `${staged.txId}.json`),
      path.join(paths.workspace, '.rc-bootstrap-recovery-incidents', `${staged.txId}.json`),
      path.join(paths.stateDir, '.rc-bootstrap-recovery-incidents', `${staged.txId}.json`),
      path.join(path.dirname(paths.dbPath), '.rc-bootstrap-recovery-incidents', `${staged.txId}.json`),
    ];
    for (const incident of incidents) {
      expect(JSON.parse(fs.readFileSync(incident, 'utf8'))).toMatchObject({
        txId: staged.txId, code: 'CONFIG_VOLUME_LOST', restoredVolumes: ['data', 'state', 'workspace'],
      });
      expect(fs.statSync(incident).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(incident, 'utf8')).not.toContain('RC_TEST_ONLY_FAKE_MODEL_KEY');
    }
    fs.rmSync(incidents[0]);
    await expect(stage(paths)).rejects.toMatchObject({ code: 'RECOVERY_INCIDENT_PENDING' });
  });

  it.each(['applying', 'certificate-bearing'])(
    'recovers three satellite volumes when the whole config volume is reset (%s)',
    async (phase) => {
      const paths = makePaths();
      const staged = await stage(paths);
      const before = {
        workspace: treeDigest(path.join(paths.workspace, 'skills')),
        state: treeDigest(path.join(paths.stateDir, 'agents')),
        globalConfig: treeDigest(paths.globalConfigPath),
        cron: treeDigest(path.join(paths.stateDir, 'state')),
        data: treeDigest(paths.dbPath),
      };
      if (phase === 'applying') {
        await expect(mutate(paths, () => applier.applyProfile({
          ...paths, txId: staged.txId, fault: 'auth',
        }))).rejects.toBeTruthy();
      } else {
        await mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId }));
        await applier.verifyProfile({ ...paths, txId: staged.txId });
        await expect(applier.commitProfile({
          ...paths, txId: staged.txId, fault: 'certificates-written',
        } as any)).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
      }
      const roots = volumeMarkerRoots(paths, staged.txId);
      fs.rmSync(path.dirname(paths.configPath), { recursive: true });
      fs.mkdirSync(path.dirname(paths.configPath), { mode: 0o700 });
      initializeAfterConfigVolumeLoss({
        ...paths,
        externalStopVerified: true,
      });

      await expect(mutate(paths, () => applier.recoverProfiles({ ...paths })))
        .rejects.toMatchObject({ code: 'CONFIG_VOLUME_LOST' });
      expect(treeDigest(path.join(paths.workspace, 'skills'))).toBe(before.workspace);
      expect(treeDigest(path.join(paths.stateDir, 'agents'))).toBe(before.state);
      expect(treeDigest(paths.globalConfigPath)).toBe(before.globalConfig);
      expect(treeDigest(path.join(paths.stateDir, 'state'))).toBe(before.cron);
      expect(treeDigest(paths.dbPath)).toBe(before.data);
      for (const root of roots.slice(1)) expect(fs.existsSync(root)).toBe(false);
      for (const incident of [
        path.join(path.dirname(paths.configPath), '.rc-bootstrap/recovery-incidents', `${staged.txId}.json`),
        path.join(paths.workspace, '.rc-bootstrap-recovery-incidents', `${staged.txId}.json`),
        path.join(paths.stateDir, '.rc-bootstrap-recovery-incidents', `${staged.txId}.json`),
        path.join(path.dirname(paths.dbPath), '.rc-bootstrap-recovery-incidents', `${staged.txId}.json`),
      ]) expect(fs.existsSync(incident)).toBe(true);
    },
    30_000,
  );

  it('never recreates an absent config mount and only recovers after explicit stop proof', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    await expect(mutate(paths, () => applier.applyProfile({
      ...paths, txId: staged.txId, fault: 'auth',
    }))).rejects.toBeTruthy();
    const configRoot = path.dirname(paths.configPath);
    fs.rmSync(configRoot, { recursive: true });

    await expect(mutate(paths, () => applier.recoverProfiles({ ...paths })))
      .rejects.toMatchObject({ code: 'INVALID_LOCK_ROOT' });
    expect(fs.existsSync(configRoot)).toBe(false);

    fs.mkdirSync(configRoot, { mode: 0o700 });
    initializeAfterConfigVolumeLoss({
      ...paths,
      externalStopVerified: true,
    });
    await expect(mutate(paths, () => applier.recoverProfiles({ ...paths })))
      .rejects.toMatchObject({ code: 'CONFIG_VOLUME_LOST' });
    expect(fs.statSync(configRoot).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(paths.configPath)).toBe(false);
    const incident = path.join(
      configRoot, '.rc-bootstrap/recovery-incidents', `${staged.txId}.json`,
    );
    expect(fs.readFileSync(incident, 'utf8')).not.toContain('RC_TEST_ONLY_FAKE_MODEL_KEY');
  });

  it('cleans partial preparing satellites after config volume loss without touching live assets', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    const before = liveDigest(paths);
    await expect(mutate(paths, () => applier.applyProfile({
      ...paths, txId: staged.txId, fault: 'prepare-state',
    }))).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    const roots = volumeMarkerRoots(paths, staged.txId);
    fs.rmSync(roots[0], { recursive: true });

    await expect(mutate(paths, () => applier.recoverProfiles({ ...paths })))
      .rejects.toMatchObject({ code: 'CONFIG_VOLUME_LOST' });
    expect(liveDigest(paths)).toBe(before);
    for (const root of roots.slice(1)) expect(fs.existsSync(root)).toBe(false);
  });

  it('rolls back certificate-bearing orphan satellites because the global commit point is lost', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    const before = {
      workspace: treeDigest(path.join(paths.workspace, 'skills')),
      state: treeDigest(path.join(paths.stateDir, 'agents')),
      globalConfig: treeDigest(paths.globalConfigPath),
      cron: treeDigest(path.join(paths.stateDir, 'state')),
      data: treeDigest(paths.dbPath),
      config: treeDigest(paths.configPath),
    };
    await mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId }));
    await applier.verifyProfile({ ...paths, txId: staged.txId });
    await expect(applier.commitProfile({
      ...paths, txId: staged.txId, fault: 'certificates-written',
    } as any)).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    const roots = volumeMarkerRoots(paths, staged.txId);
    for (const root of roots.slice(1)) expect(fs.existsSync(path.join(root, 'commit-certificate.json'))).toBe(true);
    fs.rmSync(roots[0], { recursive: true });

    await expect(mutate(paths, () => applier.recoverProfiles({ ...paths })))
      .rejects.toMatchObject({ code: 'CONFIG_VOLUME_LOST' });
    expect(treeDigest(path.join(paths.workspace, 'skills'))).toBe(before.workspace);
    expect(treeDigest(path.join(paths.stateDir, 'agents'))).toBe(before.state);
    expect(treeDigest(paths.globalConfigPath)).toBe(before.globalConfig);
    expect(treeDigest(path.join(paths.stateDir, 'state'))).toBe(before.cron);
    expect(treeDigest(paths.dbPath)).toBe(before.data);
    expect(treeDigest(paths.configPath)).not.toBe(before.config);
    for (const root of roots) expect(fs.existsSync(root)).toBe(false);
  });

  it('preserves tampered orphan recovery material and fails closed without partial restore', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    await expect(mutate(paths, () => applier.applyProfile({
      ...paths, txId: staged.txId, fault: 'auth',
    }))).rejects.toBeTruthy();
    const roots = volumeMarkerRoots(paths, staged.txId);
    fs.rmSync(roots[0], { recursive: true });
    const marker = JSON.parse(fs.readFileSync(path.join(roots[2], 'volume-marker.json'), 'utf8'));
    const auth = marker.assets.find((asset: any) => asset.id === 'auth');
    fs.appendFileSync(path.join(roots[2], auth.snapshot, 'content', '__root_file__'), 'tamper');

    await expect(mutate(paths, () => applier.recoverProfiles({ ...paths })))
      .rejects.toMatchObject({ code: 'INVALID_TRANSACTION_PREIMAGE' });
    for (const root of roots.slice(1)) expect(fs.existsSync(root)).toBe(true);
  });

  it('preserves every orphan volume when a satellite commit certificate is tampered', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    await mutate(paths, () => applier.applyProfile({ ...paths, txId: staged.txId }));
    await applier.verifyProfile({ ...paths, txId: staged.txId });
    await expect(applier.commitProfile({
      ...paths, txId: staged.txId, fault: 'certificates-written',
    } as any)).rejects.toMatchObject({ code: 'INJECTED_FAULT' });
    const roots = volumeMarkerRoots(paths, staged.txId);
    fs.rmSync(roots[0], { recursive: true });
    const certificate = path.join(roots[1], 'commit-certificate.json');
    const tampered = JSON.parse(fs.readFileSync(certificate, 'utf8'));
    tampered.digest = '0'.repeat(64);
    fs.writeFileSync(certificate, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });

    await expect(mutate(paths, () => applier.recoverProfiles({ ...paths })))
      .rejects.toMatchObject({ code: 'INVALID_COMMIT_CERTIFICATE' });
    for (const root of roots.slice(1)) expect(fs.existsSync(root)).toBe(true);
  });

  it('rejects symlinked config-volume ancestry during recovery and leaves satellites untouched', async () => {
    const paths = makePaths();
    const staged = await stage(paths);
    await expect(mutate(paths, () => applier.applyProfile({
      ...paths, txId: staged.txId, fault: 'auth',
    }))).rejects.toBeTruthy();
    const roots = volumeMarkerRoots(paths, staged.txId);
    const configRoot = path.dirname(paths.configPath);
    const replacement = path.join(paths.root, 'replacement-config');
    fs.rmSync(configRoot, { recursive: true });
    fs.mkdirSync(replacement, { mode: 0o700 });
    fs.symlinkSync(replacement, configRoot);

    await expect(mutate(paths, () => applier.recoverProfiles({ ...paths })))
      .rejects.toMatchObject({ code: 'INVALID_LOCK_ROOT' });
    for (const root of roots.slice(1)) expect(fs.existsSync(root)).toBe(true);
  });
});
