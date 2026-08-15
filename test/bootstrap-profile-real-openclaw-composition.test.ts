import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const SYNC_SOURCE = path.join(ROOT, 'scripts/sync-global-config.cjs');
const OPENCLAW_PACKAGE = path.join(ROOT, 'node_modules/openclaw/package.json');
const OPENCLAW_ENTRY = path.join(ROOT, 'node_modules/openclaw/dist/entry.js');
const EXPECTED_OPENCLAW_VERSION = '2026.6.1';
const OWNER_PLUGIN_ID = 'rc-profile-catalog-owner';

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

type Harness = {
  root: string;
  home: string;
  temp: string;
  projectRoot: string;
  copiedSync: string;
  ownerPluginDir: string;
  authPath: string;
  agentDir: string;
  dataRoot: string;
  paths: Paths;
};

type PathState =
  | { type: 'absent' }
  | { type: 'symlink'; mode: number | null; target: string }
  | { type: 'file'; mode: number | null; bytes: string; sha256: string }
  | { type: 'directory'; mode: number | null; children: Record<string, PathState> }
  | { type: 'other'; mode: number | null };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function modeOf(metadata: fs.Stats): number | null {
  return process.platform === 'win32' ? null : metadata.mode & 0o777;
}

function makePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function writeJson(file: string, value: unknown): void {
  makePrivateDirectory(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeMetadataOnlyPlugin(
  directory: string,
  manifest: Record<string, unknown>,
): void {
  makePrivateDirectory(directory);
  writeJson(path.join(directory, 'package.json'), {
    name: `@research-claw-test/${manifest.id}`,
    version: '0.0.0-test',
    private: true,
    type: 'module',
    main: 'index.js',
    openclaw: { extensions: ['./index.js'] },
  });
  writeJson(path.join(directory, 'openclaw.plugin.json'), {
    ...manifest,
    main: 'index.js',
  });
  fs.writeFileSync(
    path.join(directory, 'index.js'),
    `export default { id: ${JSON.stringify(manifest.id)}, register() {} };\n`,
    { mode: 0o600 },
  );
  if (process.platform !== 'win32') fs.chmodSync(path.join(directory, 'index.js'), 0o600);
}

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-real-oc-composition-'));
  roots.push(root);
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);

  const home = path.join(root, 'home');
  const stateDir = path.join(home, '.openclaw');
  const workspace = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  const temp = path.join(root, 'tmp');
  const projectRoot = path.join(root, 'project');
  const projectConfigRoot = path.join(projectRoot, 'config');
  const projectScriptsRoot = path.join(projectRoot, 'scripts');
  const ownerPluginDir = path.join(root, 'plugins', OWNER_PLUGIN_ID);
  const corePluginDir = path.join(root, 'plugins', 'research-claw-core');
  const supervisorPluginDir = path.join(root, 'plugins', 'dual-model-supervisor');
  for (const directory of [
    home, stateDir, workspace, path.join(workspace, 'skills'), dataRoot, temp,
    projectConfigRoot, projectScriptsRoot, path.dirname(ownerPluginDir),
  ]) makePrivateDirectory(directory);

  const copiedSync = path.join(projectScriptsRoot, 'sync-global-config.cjs');
  fs.copyFileSync(SYNC_SOURCE, copiedSync);
  if (process.platform !== 'win32') fs.chmodSync(copiedSync, 0o700);

  const capsule = readJson(FIXTURE);
  const providerId = capsule.model.providerId as string;
  writeMetadataOnlyPlugin(ownerPluginDir, {
    id: OWNER_PLUGIN_ID,
    activation: { onStartup: false },
    enabledByDefault: true,
    providers: [providerId],
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  });
  writeMetadataOnlyPlugin(
    corePluginDir,
    readJson(path.join(ROOT, 'extensions/research-claw-core/openclaw.plugin.json')),
  );
  writeMetadataOnlyPlugin(
    supervisorPluginDir,
    readJson(path.join(ROOT, 'extensions/dual-model-supervisor/openclaw.plugin.json')),
  );

  const paths: Paths = {
    rcRoot: ROOT,
    configPath: path.join(projectConfigRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  const authPath = path.join(stateDir, 'agents/main/agent/auth-profiles.json');
  const agentDir = path.dirname(authPath);
  writeJson(paths.configPath, {
    gateway: { mode: 'local' },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: 'fixture-before/profile' },
      },
    },
    models: { mode: 'merge', providers: {} },
    skills: { allowBundled: ['rc-bootstrap-composition-no-bundled-skills'] },
    plugins: {
      enabled: true,
      allow: [OWNER_PLUGIN_ID, 'research-claw-core', 'dual-model-supervisor'],
      load: { paths: [ownerPluginDir, corePluginDir, supervisorPluginDir] },
      entries: {
        [OWNER_PLUGIN_ID]: { enabled: true },
        'research-claw-core': {
          enabled: true,
          config: { dbPath: paths.dbPath },
        },
        'dual-model-supervisor': {
          enabled: false,
          config: { enabled: false, reviewMode: 'off' },
        },
      },
    },
    tools: { deny: [] },
  });
  writeJson(paths.globalConfigPath, {
    userGlobalFixture: { preserve: true },
    models: { mode: 'merge', providers: {} },
  });
  writeJson(authPath, { version: 1, profiles: {} });

  ensureInitialized({ ...paths, externalStopVerified: true });
  return {
    root,
    home,
    temp,
    projectRoot,
    copiedSync,
    ownerPluginDir,
    authPath,
    agentDir,
    dataRoot,
    paths,
  };
}

function isolatedChildEnv(harness: Harness): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: harness.home,
    USERPROFILE: harness.home,
    TMPDIR: harness.temp,
    TMP: harness.temp,
    TEMP: harness.temp,
    OPENCLAW_STATE_DIR: harness.paths.stateDir,
    OPENCLAW_CONFIG_PATH: harness.paths.configPath,
    OPENCLAW_AGENT_DIR: harness.agentDir,
    OPENCLAW_AUTH_STORE_READONLY: '1',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
  for (const key of [
    'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot', 'WINDIR',
    'LANG', 'LC_ALL', 'TZ', 'TERM',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function runSync(harness: Harness) {
  const sourceBytes = fs.readFileSync(SYNC_SOURCE);
  const copiedBytes = fs.readFileSync(harness.copiedSync);
  expect(copiedBytes).toEqual(sourceBytes);
  const result = spawnSync(process.execPath, [harness.copiedSync], {
    cwd: harness.projectRoot,
    env: isolatedChildEnv(harness),
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(fs.readFileSync(harness.copiedSync)).toEqual(sourceBytes);
  return result;
}

function runRealOpenClawDerivation(harness: Harness) {
  const packageRoot = fs.realpathSync(path.dirname(OPENCLAW_PACKAGE));
  const entry = fs.realpathSync(OPENCLAW_ENTRY);
  expect(entry.startsWith(`${packageRoot}${path.sep}`)).toBe(true);
  expect(readJson(OPENCLAW_PACKAGE).version).toBe(EXPECTED_OPENCLAW_VERSION);
  // Unlike `models status`, the real capability catalog command calls
  // loadModelCatalog in write mode, which invokes ensureOpenClawModelsJson.
  const result = spawnSync(process.execPath, [entry, 'infer', 'model', 'list', '--json'], {
    cwd: ROOT,
    env: isolatedChildEnv(harness),
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    maxBuffer: 10 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  return result;
}

function pathState(target: string): PathState {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(target);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { type: 'absent' };
    throw error;
  }
  const mode = modeOf(metadata);
  if (metadata.isSymbolicLink()) {
    return { type: 'symlink', mode, target: fs.readlinkSync(target) };
  }
  if (metadata.isFile()) {
    const bytes = fs.readFileSync(target);
    return {
      type: 'file',
      mode,
      bytes: bytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
  if (metadata.isDirectory()) {
    return {
      type: 'directory',
      mode,
      children: Object.fromEntries(
        fs.readdirSync(target).sort().map((name) => [name, pathState(path.join(target, name))]),
      ),
    };
  }
  return { type: 'other', mode };
}

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

function secretOccurrences(root: string, secret: string): Array<{ file: string; count: number }> {
  const needle = Buffer.from(secret, 'utf8');
  const output: Array<{ file: string; count: number }> = [];
  const visit = (target: string): void => {
    const metadata = fs.lstatSync(target);
    if (metadata.isSymbolicLink()) throw new Error(`unexpected symlink in isolated root: ${target}`);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
      return;
    }
    if (!metadata.isFile()) return;
    const bytes = fs.readFileSync(target);
    let count = 0;
    let offset = 0;
    for (;;) {
      const found = bytes.indexOf(needle, offset);
      if (found < 0) break;
      count += 1;
      offset = found + needle.length;
    }
    if (count > 0) output.push({ file: target, count });
  };
  visit(root);
  return output;
}

function transactionRoots(harness: Harness, txId: string): string[] {
  return [
    path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap/transactions', txId),
    path.join(harness.paths.workspace, '.rc-bootstrap-transactions', txId),
    path.join(harness.paths.stateDir, '.rc-bootstrap-transactions', txId),
    path.join(harness.dataRoot, '.rc-bootstrap-transactions', txId),
  ];
}

function expectAppliedSecretCopies(harness: Harness, txId: string, key: string): void {
  const occurrences = secretOccurrences(harness.root, key);
  const txRoots = transactionRoots(harness, txId);
  expect(occurrences.reduce((total, entry) => total + entry.count, 0)).toBe(2);
  expect(occurrences.find((entry) => entry.file === harness.authPath)).toEqual({
    file: harness.authPath,
    count: 1,
  });
  const transactionCopies = occurrences.filter((entry) => entry.file !== harness.authPath);
  expect(transactionCopies).toHaveLength(1);
  expect(transactionCopies[0].count).toBe(1);
  expect(path.basename(transactionCopies[0].file)).toBe('capsule.json');
  expect(txRoots.some((root) => isInside(root, transactionCopies[0].file))).toBe(true);
  for (const occurrence of occurrences) {
    if (process.platform !== 'win32') {
      expect(fs.statSync(occurrence.file).mode & 0o077).toBe(0);
    }
  }
}

function writeSetTargets(harness: Harness): string[] {
  const cron = path.join(harness.paths.stateDir, 'state/openclaw.sqlite');
  return [
    harness.paths.configPath,
    path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap/receipt.json'),
    path.join(path.dirname(harness.paths.configPath), '.rc-bootstrap/peripheral-suspensions.json'),
    path.join(harness.paths.workspace, 'skills'),
    harness.authPath,
    harness.paths.globalConfigPath,
    cron,
    `${cron}-wal`,
    `${cron}-shm`,
    harness.paths.dbPath,
    `${harness.paths.dbPath}-wal`,
    `${harness.paths.dbPath}-shm`,
  ];
}

describe('current applier + native sync + real OpenClaw catalog composition', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps the committed model key exactly once after real global sync and catalog derivation',
    async () => {
      const harness = makeHarness();
      const capsuleBytes = fs.readFileSync(FIXTURE);
      const capsule = JSON.parse(capsuleBytes.toString('utf8'));
      const key = capsule.secrets.modelApiKey as string;
      const providerId = capsule.model.providerId as string;
      const authProfileId = `${providerId}:managed`;
      const staged = await applier.stageProfile({
        ...harness.paths,
        capsuleBytes,
        rcVersion: '0.8.3',
      });
      await applier.applyProfile({ ...harness.paths, txId: staged.txId });

      const syncResult = runSync(harness);
      const openClawResult = runRealOpenClawDerivation(harness);
      expect(`${syncResult.stdout}${syncResult.stderr}${openClawResult.stdout}${openClawResult.stderr}`)
        .not.toContain(key);

      const projectConfig = readJson(harness.paths.configPath);
      const globalConfig = readJson(harness.paths.globalConfigPath);
      expect(projectConfig.models.providers[providerId].apiKey).toBe(authProfileId);
      expect(globalConfig.models.providers[providerId].apiKey).toBe(authProfileId);
      expect(projectConfig.auth.profiles[authProfileId]).toEqual({
        provider: providerId,
        mode: 'api_key',
      });
      expect(globalConfig.auth.profiles[authProfileId]).toEqual({
        provider: providerId,
        mode: 'api_key',
      });

      const modelsPath = path.join(harness.agentDir, 'models.json');
      const catalogPath = path.join(
        harness.agentDir,
        'plugins',
        encodeURIComponent(OWNER_PLUGIN_ID),
        'catalog.json',
      );
      expect(fs.existsSync(modelsPath)).toBe(true);
      expect(fs.existsSync(catalogPath)).toBe(true);
      const catalog = readJson(catalogPath);
      expect(readJson(modelsPath).providers ?? {}).not.toHaveProperty(providerId);
      expect(fs.readFileSync(modelsPath, 'utf8')).not.toContain(key);
      expect(catalog.generatedBy).toBe('openclaw-plugin-model-catalog-v1');
      expect(catalog.providers[providerId].apiKey).toBe(authProfileId);
      expect(fs.readFileSync(catalogPath, 'utf8')).not.toContain(key);

      await applier.verifyProfile({ ...harness.paths, txId: staged.txId });
      const txRoots = transactionRoots(harness, staged.txId);
      expectAppliedSecretCopies(harness, staged.txId, key);

      await applier.commitProfile({ ...harness.paths, txId: staged.txId });
      const authStore = readJson(harness.authPath);
      expect(authStore).toEqual({
        version: 1,
        profiles: {
          [authProfileId]: { type: 'api_key', provider: providerId, key },
        },
      });
      if (process.platform !== 'win32') {
        expect(fs.statSync(harness.authPath).mode & 0o777).toBe(0o600);
      }
      expect(secretOccurrences(harness.root, key)).toEqual([{ file: harness.authPath, count: 1 }]);
      expect(txRoots.map((root) => fs.existsSync(root))).toEqual([false, false, false, false]);
      expect(readJson(harness.paths.globalConfigPath).userGlobalFixture).toEqual({ preserve: true });
    },
    90_000,
  );

  it('restores the declared write-set byte-for-byte after real sync and catalog derivation', async () => {
    const harness = makeHarness();
    const capsuleBytes = fs.readFileSync(FIXTURE);
    const capsule = JSON.parse(capsuleBytes.toString('utf8'));
    const key = capsule.secrets.modelApiKey as string;
    const providerId = capsule.model.providerId as string;
    const targets = writeSetTargets(harness);
    const before = targets.map((target) => pathState(target));
    const staged = await applier.stageProfile({
      ...harness.paths,
      capsuleBytes,
      rcVersion: '0.8.3',
    });
    await applier.applyProfile({ ...harness.paths, txId: staged.txId });

    const syncResult = runSync(harness);
    const openClawResult = runRealOpenClawDerivation(harness);
    expect(`${syncResult.stdout}${syncResult.stderr}${openClawResult.stdout}${openClawResult.stderr}`)
      .not.toContain(key);
    const modelsPath = path.join(harness.agentDir, 'models.json');
    const catalogPath = path.join(
      harness.agentDir,
      'plugins',
      encodeURIComponent(OWNER_PLUGIN_ID),
      'catalog.json',
    );
    expect(fs.existsSync(modelsPath)).toBe(true);
    expect(fs.existsSync(catalogPath)).toBe(true);
    expect(readJson(modelsPath).providers ?? {}).not.toHaveProperty(providerId);
    expect(fs.readFileSync(modelsPath, 'utf8')).not.toContain(key);
    expect(readJson(catalogPath).providers[providerId].apiKey).toBe(`${providerId}:managed`);
    expect(fs.readFileSync(catalogPath, 'utf8')).not.toContain(key);
    expectAppliedSecretCopies(harness, staged.txId, key);

    await applier.rollbackProfile({ ...harness.paths, txId: staged.txId });
    expect(targets.map((target) => pathState(target))).toEqual(before);
    expect(fs.existsSync(modelsPath)).toBe(true);
    expect(fs.existsSync(catalogPath)).toBe(true);
    expect(fs.readFileSync(modelsPath, 'utf8')).not.toContain(key);
    expect(fs.readFileSync(catalogPath, 'utf8')).not.toContain(key);
    expect(secretOccurrences(harness.root, key)).toEqual([]);
    expect(transactionRoots(harness, staged.txId).map((root) => fs.existsSync(root)))
      .toEqual([false, false, false, false]);
  }, 60_000);
});
