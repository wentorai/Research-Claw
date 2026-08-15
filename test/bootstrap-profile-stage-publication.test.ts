import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts/apply-bootstrap-profile.cjs');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const FAKE_SECRET = 'RC_TEST_ONLY_FAKE_MODEL_KEY';
const require = createRequire(import.meta.url);
const applier: {
  stageProfile(options: Paths & { capsuleBytes: Buffer; rcVersion: string }): Promise<any>;
  rollbackProfile(options: Paths & { txId: string }): Promise<any>;
  recoverProfiles(options: Paths): Promise<any>;
} = require('../scripts/bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

type Paths = {
  rcRoot: string;
  configPath: string;
  workspace: string;
  stateDir: string;
  dbPath: string;
  globalConfigPath: string;
};

type Harness = { root: string; paths: Paths; transactions: string };

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-stage-publication-'));
  temporaryRoots.push(root);
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
    plugins: { entries: {
      'research-claw-core': { enabled: true, config: {} },
      'dual-model-supervisor': { enabled: false, config: { enabled: false, reviewMode: 'off' } },
    } },
    tools: { deny: [] },
  });
  writeJson(paths.globalConfigPath, { userGlobal: true });
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1,
    profiles: {},
  });
  ensureInitialized({ ...paths, externalStopVerified: true });
  return {
    root,
    paths,
    transactions: path.join(configRoot, '.rc-bootstrap', 'transactions'),
  };
}

function cliArgs(command: string, h: Harness, txId?: string): string[] {
  return [
    ENTRY,
    command,
    '--rc-root', ROOT,
    '--config', h.paths.configPath,
    '--workspace', h.paths.workspace,
    '--state-dir', h.paths.stateDir,
    '--db', h.paths.dbPath,
    '--global-config', h.paths.globalConfigPath,
    ...(txId ? ['--tx-id', txId] : []),
  ];
}

function digestPath(target: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (current: string, relative: string) => {
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(current);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        hash.update(`${relative}:absent;`);
        return;
      }
      throw error;
    }
    const type = metadata.isDirectory() ? 'directory'
      : metadata.isFile() ? 'file' : metadata.isSymbolicLink() ? 'symlink' : 'other';
    hash.update(`${relative}:${type}:${metadata.mode & 0o777};`);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), relative ? path.join(relative, name) : name);
      }
    } else if (metadata.isFile()) {
      hash.update(fs.readFileSync(current));
    } else if (metadata.isSymbolicLink()) {
      hash.update(fs.readlinkSync(current));
    }
  };
  visit(target, '');
  return hash.digest('hex');
}

function liveDigest(h: Harness): string {
  const assets = [
    h.paths.configPath,
    path.join(h.paths.workspace, 'skills'),
    path.join(h.paths.stateDir, 'agents/main/agent/auth-profiles.json'),
    h.paths.globalConfigPath,
    h.paths.dbPath,
  ];
  return crypto.createHash('sha256')
    .update(JSON.stringify(assets.map((asset) => digestPath(asset))))
    .digest('hex');
}

function containsBytes(root: string, needle: Buffer): boolean {
  if (!fs.existsSync(root)) return false;
  const metadata = fs.lstatSync(root);
  if (metadata.isSymbolicLink()) return false;
  if (metadata.isFile()) return fs.readFileSync(root).includes(needle);
  if (!metadata.isDirectory()) return false;
  return fs.readdirSync(root).some((name) => containsBytes(path.join(root, name), needle));
}

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  ready: string,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.once('exit', () => { exited = true; });
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(ready)) {
    if (exited) throw new Error(`stage exited before pause; stdout=${stdout}; stderr=${stderr}`);
    if (Date.now() > deadline) throw new Error(`stage pause timeout; stdout=${stdout}; stderr=${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { stdout, stderr };
}

async function killStageAt(h: Harness, pause: string): Promise<string> {
  const ready = path.join(h.root, `${pause}.ready`);
  const child = spawn(process.execPath, cliArgs('stage', h), {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
      RC_BOOTSTRAP_FAULT_PAUSE_AFTER: pause,
      RC_BOOTSTRAP_FAULT_READY: ready,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(fs.readFileSync(FIXTURE));
  const output = await waitForReady(child, ready);
  expect(`${output.stdout}${output.stderr}`).not.toContain(FAKE_SECRET);
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const residues = fs.readdirSync(h.transactions).filter(
    (name) => name.startsWith('.rc-bootstrap-stage-v1-'),
  );
  expect(residues).toHaveLength(1);
  return path.join(h.transactions, residues[0]);
}

function expectNoPublicationResidue(h: Harness): void {
  expect(fs.readdirSync(h.transactions)).toEqual([]);
  expect(containsBytes(h.transactions, Buffer.from(FAKE_SECRET))).toBe(false);
  const tempNames: string[] = [];
  const visit = (target: string) => {
    if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory()) return;
    for (const name of fs.readdirSync(target)) {
      if (name.endsWith('.tmp') || name.startsWith('.rc-bootstrap-stage-v1-')) tempNames.push(name);
      visit(path.join(target, name));
    }
  };
  visit(path.dirname(h.transactions));
  expect(tempNames).toEqual([]);
}

const PUBLICATION_PAUSES = [
  'stage-unpublished-directory',
  'stage-capsule-temp',
  'stage-capsule-written',
  'stage-manifest-temp',
  'stage-before-publish',
] as const;

describe.skipIf(process.platform === 'win32')('atomic stage publication crash recovery', () => {
  it.each(PUBLICATION_PAUSES)(
    'recovers a SIGKILL at %s without consuming a partial Capsule',
    async (pause) => {
      const h = makeHarness();
      const before = liveDigest(h);
      await killStageAt(h, pause);

      await expect(applier.recoverProfiles(h.paths)).resolves.toEqual({ recovered: [] });
      expect(liveDigest(h)).toBe(before);
      expectNoPublicationResidue(h);

      const staged = await applier.stageProfile({
        ...h.paths,
        capsuleBytes: fs.readFileSync(FIXTURE),
        rcVersion: '0.8.3',
      });
      expect(fs.readdirSync(path.join(h.transactions, staged.txId)).sort())
        .toEqual(['capsule.json', 'manifest.json']);
      await applier.rollbackProfile({ ...h.paths, txId: staged.txId });
      expect(liveDigest(h)).toBe(before);
      expectNoPublicationResidue(h);
    },
    45_000,
  );

  it('does zero cleanup when an unknown entry is mixed with a valid unpublished stage', async () => {
    const h = makeHarness();
    await killStageAt(h, 'stage-capsule-written');
    fs.writeFileSync(path.join(h.transactions, 'operator-note'), 'preserve', { mode: 0o600 });
    const before = digestPath(h.transactions);

    await expect(applier.recoverProfiles(h.paths))
      .rejects.toMatchObject({ code: 'INVALID_STAGE_PUBLICATION' });
    expect(digestPath(h.transactions)).toBe(before);
  });

  it('does zero cleanup when staged Capsule bytes no longer match the authenticated identity', async () => {
    const h = makeHarness();
    const unpublished = await killStageAt(h, 'stage-capsule-written');
    fs.writeFileSync(path.join(unpublished, 'capsule.json'), '{"tampered":true}\n', { mode: 0o600 });
    const before = digestPath(h.transactions);

    await expect(applier.recoverProfiles(h.paths))
      .rejects.toMatchObject({ code: 'INVALID_STAGE_PUBLICATION' });
    expect(digestPath(h.transactions)).toBe(before);
  });

  it('does zero cleanup when an authenticated unpublished stage contains an extra entry', async () => {
    const h = makeHarness();
    const unpublished = await killStageAt(h, 'stage-manifest-temp');
    fs.writeFileSync(path.join(unpublished, 'unexpected'), 'preserve', { mode: 0o600 });
    const before = digestPath(h.transactions);

    await expect(applier.recoverProfiles(h.paths))
      .rejects.toMatchObject({ code: 'INVALID_STAGE_PUBLICATION' });
    expect(digestPath(h.transactions)).toBe(before);
  });
});
