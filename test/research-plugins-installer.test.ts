import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(
  ROOT,
  'scripts',
  'install-research-plugins.cjs',
);
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const OPENCLAW = path.join(ROOT, 'node_modules', '.bin', 'openclaw');
const EXAMPLE_CONFIG = path.join(ROOT, 'config', 'openclaw.example.json');
const INTEGRITY_RECORD = '.research-claw-integrity.json';
const FIXTURE_PS_START = 'Mon Jan  1 00:00:00 2024';

type CommandResult = ReturnType<typeof spawnSync>;

function command(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): CommandResult {
  return spawnSync(executable, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function expectSuccess(result: CommandResult): void {
  expect(
    result.status,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  ).toBe(0);
}

function expectInstallFailure(result: CommandResult): void {
  expect(result.error).toBeUndefined();
  expect(typeof result.status).toBe('number');
  expect(result.status).toBeGreaterThan(0);
  expect(String(result.stderr)).toContain(
    'Research plugins were not changed:',
  );
  expect(String(result.stderr)).not.toContain('MODULE_NOT_FOUND');
}

function writeFixturePackage(
  packageDir: string,
  version: string,
  env: NodeJS.ProcessEnv,
): void {
  const dependencyDir = path.join(
    path.dirname(packageDir),
    `${path.basename(packageDir)}-dependency`,
  );
  const vendorDir = path.join(packageDir, 'vendor');
  fs.mkdirSync(dependencyDir, { recursive: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(
    path.join(dependencyDir, 'package.json'),
    JSON.stringify({
      name: '@wentorai/rp-fixture-dependency',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(dependencyDir, 'index.js'),
    'export const fixtureDependency = true;\n',
  );
  const packArgs = [
      'pack',
      dependencyDir,
      '--pack-destination',
      vendorDir,
      '--json',
    ];
  const npmCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  const packedDependency = spawnSync(
    process.platform === 'win32' ? process.execPath : 'npm',
    process.platform === 'win32' ? [npmCli, ...packArgs] : packArgs,
    { encoding: 'utf8', env, timeout: 30_000 },
  );
  if (packedDependency.status !== 0) {
    throw new Error(
      `fixture dependency pack failed: ${
        packedDependency.stderr || packedDependency.stdout
      }`,
    );
  }

  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@wentorai/research-plugins',
      version,
      type: 'module',
      files: [
        'catalog.json',
        'dist/',
        'openclaw.plugin.json',
        'skills/',
        'vendor/',
      ],
      dependencies: {
        '@wentorai/rp-fixture-dependency':
          'file:vendor/wentorai-rp-fixture-dependency-1.0.0.tgz',
      },
      openclaw: {
        extensions: ['./dist/index.js'],
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(packageDir, 'openclaw.plugin.json'),
    JSON.stringify({
      id: 'research-plugins',
      version,
      name: 'Research Plugins integration fixture',
      main: 'dist/index.js',
      activation: { onStartup: true },
      contracts: { tools: [] },
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(packageDir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      items: [
        {
          id: 'fixture-skill',
          type: 'skill',
          name: 'fixture-skill',
          description: 'Integration fixture',
          category: 'test',
          subcategory: 'test',
          keywords: ['fixture'],
          path: 'skills/test/fixture-skill',
        },
        {
          id: 'fixture-skill-two',
          type: 'skill',
          name: 'fixture-skill-two',
          description: 'Second integration fixture',
          category: 'test',
          subcategory: 'test',
          keywords: ['fixture'],
          path: 'skills/test/fixture-skill-two',
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(packageDir, 'dist', 'index.js'),
    "import './runtime-tool.js';\nexport default function activate() {}\n",
  );
  fs.writeFileSync(
    path.join(packageDir, 'dist', 'runtime-tool.js'),
    'export const runtimeTool = true;\n',
  );
  const skillDir = path.join(
    packageDir,
    'skills',
    'test',
    'fixture-skill',
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: Integration fixture\n---\n',
  );
  const secondSkillDir = path.join(
    packageDir,
    'skills',
    'test',
    'fixture-skill-two',
  );
  fs.mkdirSync(secondSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(secondSkillDir, 'SKILL.md'),
    '---\nname: fixture-skill-two\ndescription: Second integration fixture\n---\n',
  );
}

describe('research-plugins Windows npm invocation', () => {
  it('executes the npm JavaScript CLI through the pinned Node runtime', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-win-npm-cli-'));
    const nodeExecutable = path.join(fixtureRoot, 'node.exe');
    const npmCli = path.join(
      fixtureRoot,
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(nodeExecutable, 'fixture');
    fs.writeFileSync(npmCli, 'fixture');
    const probe = [
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
      `const installer = require(${JSON.stringify(INSTALLER)});`,
      `process.stdout.write(JSON.stringify(installer.npmInvocation(['pack', 'fixture'], ${JSON.stringify(nodeExecutable)})));`,
    ].join('\n');
    try {
      const result = spawnSync(process.execPath, ['-e', probe], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      const invocation = JSON.parse(result.stdout);
      expect(invocation).toEqual({
        executable: nodeExecutable,
        args: [npmCli, 'pack', 'fixture'],
      });
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

function currentProcessStartIdentity(): string {
  try {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    const startTime = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/)[19];
    if (commandEnd > -1 && startTime) return `proc:${startTime}`;
  } catch {
    // macOS test runs use the deterministic ps fixture installed below.
  }
  return `ps:${FIXTURE_PS_START}`;
}

function treeDigest(root: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      hash.update(`${relative}\0${stat.mode}\0${stat.size}\0`);
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (stat.isFile()) {
        hash.update(fs.readFileSync(absolute));
      } else if (stat.isSymbolicLink()) {
        hash.update(fs.readlinkSync(absolute));
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

describe('research-plugins atomic installer', () => {
  let tmpDir: string;
  let homeDir: string;
  let packageDir: string;
  let pluginDir: string;
  let configPath: string;
  let isolatedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-rp-installer-'));
    homeDir = path.join(tmpDir, 'home');
    packageDir = path.join(tmpDir, 'fixture-package');
    pluginDir = path.join(
      homeDir,
      '.openclaw',
      'extensions',
      'research-plugins',
    );
    configPath = path.join(tmpDir, 'project', 'config', 'openclaw.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.copyFileSync(EXAMPLE_CONFIG, configPath);
    const homedirHook = path.join(tmpDir, 'test-homedir.cjs');
    fs.writeFileSync(
      homedirHook,
      `require('node:os').homedir = () => ${JSON.stringify(homeDir)};\n`,
    );
    const fixtureBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fixtureBin, { recursive: true });
    if (process.platform !== 'win32') {
      const fixturePs = path.join(fixtureBin, 'ps');
      fs.writeFileSync(
        fixturePs,
        `#!/bin/sh\nprintf '%s\\n' '${FIXTURE_PS_START}'\n`,
        { mode: 0o755 },
      );
    }
    isolatedEnv = {
      ...process.env,
      HOME: homeDir,
      XDG_CACHE_HOME: path.join(tmpDir, 'xdg-cache'),
      XDG_CONFIG_HOME: path.join(tmpDir, 'xdg-config'),
      XDG_DATA_HOME: path.join(tmpDir, 'xdg-data'),
      XDG_STATE_HOME: path.join(tmpDir, 'xdg-state'),
      NPM_CONFIG_CACHE: path.join(tmpDir, 'npm-cache'),
      NPM_CONFIG_USERCONFIG: path.join(tmpDir, 'npmrc'),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.join(tmpDir, 'openclaw-state'),
      NODE_OPTIONS: `--require="${homedirHook.replaceAll('\\', '/')}"`,
      NODE_ENV: 'production',
      PATH: process.platform === 'win32'
        ? process.env.PATH
        : `${fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    delete isolatedEnv.VITEST;
    delete isolatedEnv.VITEST_POOL_ID;
    delete isolatedEnv.VITEST_WORKER_ID;
    writeFixturePackage(packageDir, '9.9.1-test', isolatedEnv);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runInstaller(
    packageSpec: string,
    envOverrides: NodeJS.ProcessEnv = {},
  ): CommandResult {
    return command('node', [
      INSTALLER,
      '--package',
      packageSpec,
      '--target',
      pluginDir,
    ], { ...isolatedEnv, ...envOverrides });
  }

  function runSourceInstaller(sourceDir: string): CommandResult {
    return command('node', [
      INSTALLER,
      '--source-dir',
      sourceDir,
      '--target',
      pluginDir,
    ], isolatedEnv);
  }

  function runEnsure(): CommandResult {
    return command(
      'node',
      [ENSURE_CONFIG, configPath],
      isolatedEnv,
    );
  }

  function runOpenClaw(...args: string[]): CommandResult {
    return command(OPENCLAW, args, isolatedEnv);
  }

  function expectNoInstallerDebris(): void {
    const parent = path.dirname(pluginDir);
    if (!fs.existsSync(parent)) return;
    expect(
      fs.readdirSync(parent).filter((name) =>
        name.startsWith('.research-plugins.install-')
        || name.startsWith('.research-plugins.backup-')
        || name === '.research-plugins.install.lock'),
    ).toEqual([]);
  }

  it('installs a packed plugin, restores config, and is discovered by real OpenClaw', () => {
    expectSuccess(runInstaller(packageDir));
    const afterFirstInstall = treeDigest(pluginDir);
    expectSuccess(runInstaller(packageDir));
    expect(treeDigest(pluginDir)).toBe(afterFirstInstall);
    expectSuccess(runEnsure());
    const afterFirstEnsure = fs.readFileSync(configPath, 'utf8');
    expectSuccess(runEnsure());

    expect(
      JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')),
    ).toMatchObject({
      name: '@wentorai/research-plugins',
      version: '9.9.1-test',
    });
    expect(
      fs.existsSync(path.join(
        pluginDir,
        'node_modules',
        '@wentorai',
        'rp-fixture-dependency',
        'package.json',
      )),
    ).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirstEnsure);
    expectNoInstallerDebris();

    const validation = runOpenClaw('config', 'validate', '--json');
    expectSuccess(validation);
    expect(JSON.parse(String(validation.stdout))).toMatchObject({
      valid: true,
    });

    const listing = runOpenClaw('plugins', 'list', '--json');
    expectSuccess(listing);
    const plugin = JSON.parse(String(listing.stdout)).plugins.find(
      (candidate: { id?: string }) => candidate.id === 'research-plugins',
    );
    expect(plugin).toMatchObject({
      id: 'research-plugins',
      status: 'loaded',
      dependencyStatus: {
        requiredInstalled: true,
        missing: [],
      },
    });
    expect(fs.realpathSync(plugin.source)).toBe(
      fs.realpathSync(path.join(pluginDir, 'dist', 'index.js')),
    );
  }, 60_000);

  it('reuses the complete pinned 1.4.8 install without touching the network toolchain', () => {
    writeFixturePackage(packageDir, '1.4.8', isolatedEnv);
    expectSuccess(runInstaller(packageDir));
    const before = treeDigest(pluginDir);
    const forbiddenBin = path.join(tmpDir, 'forbidden-network-bin');
    const networkMarker = path.join(tmpDir, 'network-tool-invoked');
    fs.mkdirSync(forbiddenBin);
    if (process.platform !== 'win32') {
      const npm = path.join(forbiddenBin, 'npm');
      fs.writeFileSync(
        npm,
        `#!/bin/sh\nprintf forbidden > ${JSON.stringify(networkMarker)}\nexit 97\n`,
        { mode: 0o755 },
      );
    }

    const reused = command(process.execPath, [
      INSTALLER,
      '--target',
      pluginDir,
    ], {
      ...isolatedEnv,
      PATH: process.platform === 'win32' ? isolatedEnv.PATH : forbiddenBin,
    });

    expectSuccess(reused);
    expect(String(reused.stdout)).toContain('already ready (v1.4.8)');
    expect(fs.existsSync(networkMarker)).toBe(false);
    expect(treeDigest(pluginDir)).toBe(before);
    expectNoInstallerDebris();
  }, 60_000);

  it('preserves the complete old install when a later package attempt fails', () => {
    expectSuccess(runInstaller(packageDir));
    const before = treeDigest(pluginDir);
    const brokenPackageDir = path.join(tmpDir, 'broken-fixture-package');
    writeFixturePackage(
      brokenPackageDir,
      '9.9.2-broken',
      isolatedEnv,
    );
    const brokenPackagePath = path.join(brokenPackageDir, 'package.json');
    const brokenPackage = JSON.parse(
      fs.readFileSync(brokenPackagePath, 'utf8'),
    );
    brokenPackage.dependencies = {
      '@wentorai/rp-fixture-dependency':
        'file:vendor/does-not-exist.tgz',
    };
    fs.writeFileSync(
      brokenPackagePath,
      JSON.stringify(brokenPackage, null, 2),
    );

    const failed = runInstaller(brokenPackageDir);

    expectInstallFailure(failed);
    expect(String(failed.stderr)).toContain(
      'production dependency install failed',
    );
    expect(treeDigest(pluginDir)).toBe(before);
    expect(
      JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')),
    ).toMatchObject({ version: '9.9.1-test' });
    expectNoInstallerDebris();

    expectSuccess(runEnsure());
    expectSuccess(runOpenClaw('config', 'validate', '--json'));
    const listing = runOpenClaw('plugins', 'list', '--json');
    expectSuccess(listing);
    expect(
      JSON.parse(String(listing.stdout)).plugins.find(
        (candidate: { id?: string }) => candidate.id === 'research-plugins',
      ),
    ).toMatchObject({
      status: 'loaded',
      dependencyStatus: { requiredInstalled: true },
    });
  }, 60_000);

  it('keeps a structurally complete pre-marker install usable when an update is offline', () => {
    expectSuccess(runInstaller(packageDir));
    fs.rmSync(path.join(pluginDir, INTEGRITY_RECORD));
    const legacyTree = treeDigest(pluginDir);

    const checkBefore = command('node', [
      INSTALLER,
      '--check',
      '--quiet',
      '--target',
      pluginDir,
    ], isolatedEnv);
    expectSuccess(checkBefore);

    const failed = runInstaller(path.join(tmpDir, 'offline-package'));
    expectInstallFailure(failed);
    expect(treeDigest(pluginDir)).toBe(legacyTree);
    expectSuccess(runEnsure());

    const listing = runOpenClaw('plugins', 'list', '--json');
    expectSuccess(listing);
    expect(
      JSON.parse(String(listing.stdout)).plugins.find(
        (candidate: { id?: string }) => candidate.id === 'research-plugins',
      ),
    ).toMatchObject({
      status: 'loaded',
      dependencyStatus: { requiredInstalled: true },
    });
  }, 60_000);

  it('leaves no fake install after a fresh failure and removes stale config claims', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.plugins.allow.push('research-plugins');
    config.plugins.load.paths.push(pluginDir);
    config.plugins.installs ??= {};
    config.plugins.installs['research-plugins'] = {
      source: 'npm',
      spec: '@wentorai/research-plugins',
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const failed = runInstaller(path.join(tmpDir, 'does-not-exist'));
    expectInstallFailure(failed);
    expect(fs.existsSync(pluginDir)).toBe(false);
    expectNoInstallerDebris();

    expectSuccess(runEnsure());
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.plugins.allow).not.toContain('research-plugins');
    expect(after.plugins.load.paths).not.toContain(pluginDir);
    expect(after.plugins.installs?.['research-plugins']).toBeUndefined();

    const validation = runOpenClaw('config', 'validate', '--json');
    expectSuccess(validation);
    expect(JSON.parse(String(validation.stdout))).toMatchObject({
      valid: true,
    });

    expectSuccess(runInstaller(packageDir));
    expectSuccess(runEnsure());
    const listing = runOpenClaw('plugins', 'list', '--json');
    expectSuccess(listing);
    expect(
      JSON.parse(String(listing.stdout)).plugins.find(
        (candidate: { id?: string }) => candidate.id === 'research-plugins',
      ),
    ).toMatchObject({
      status: 'loaded',
      dependencyStatus: { requiredInstalled: true, missing: [] },
    });
  }, 60_000);

  it('atomically replaces a damaged target from a prepared Docker source', () => {
    expectSuccess(runInstaller(packageDir));
    const preparedSource = path.join(tmpDir, 'prepared-source');
    fs.cpSync(pluginDir, preparedSource, { recursive: true });
    const sourcePackagePath = path.join(preparedSource, 'package.json');
    const sourceManifestPath = path.join(
      preparedSource,
      'openclaw.plugin.json',
    );
    const sourcePackage = JSON.parse(
      fs.readFileSync(sourcePackagePath, 'utf8'),
    );
    const sourceManifest = JSON.parse(
      fs.readFileSync(sourceManifestPath, 'utf8'),
    );
    sourcePackage.version = '9.9.1-test';
    sourceManifest.version = '9.9.1-test';
    fs.writeFileSync(
      sourcePackagePath,
      JSON.stringify(sourcePackage, null, 2),
    );
    fs.writeFileSync(
      sourceManifestPath,
      JSON.stringify(sourceManifest, null, 2),
    );
    const damagedCatalogPath = path.join(pluginDir, 'catalog.json');
    const completeCatalog = JSON.parse(
      fs.readFileSync(damagedCatalogPath, 'utf8'),
    );
    fs.writeFileSync(
      damagedCatalogPath,
      JSON.stringify({
        ...completeCatalog,
        items: [completeCatalog.items[0]],
      }),
    );
    const damagedCheck = command('node', [
      INSTALLER,
      '--check',
      '--quiet',
      '--target',
      pluginDir,
    ], isolatedEnv);
    expect(damagedCheck.status).toBe(1);

    expectSuccess(runSourceInstaller(preparedSource));

    expect(
      JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')),
    ).toMatchObject({ version: '9.9.1-test' });
    expect(
      JSON.parse(fs.readFileSync(damagedCatalogPath, 'utf8')).items,
    ).toHaveLength(2);
    expectNoInstallerDebris();
  }, 60_000);

  it('repairs a same-version install with a missing shipped runtime module', () => {
    expectSuccess(runInstaller(packageDir));
    const preparedSource = path.join(tmpDir, 'prepared-runtime-source');
    fs.cpSync(pluginDir, preparedSource, { recursive: true });
    fs.rmSync(path.join(pluginDir, 'dist', 'runtime-tool.js'));

    const damagedCheck = command('node', [
      INSTALLER,
      '--check',
      '--quiet',
      '--target',
      pluginDir,
    ], isolatedEnv);
    expect(damagedCheck.status).toBe(1);

    expectSuccess(runSourceInstaller(preparedSource));
    expect(
      fs.readFileSync(
        path.join(pluginDir, 'dist', 'runtime-tool.js'),
        'utf8',
      ),
    ).toContain('runtimeTool = true');
    expectNoInstallerDebris();
  }, 60_000);

  it('rejects a malformed integrity record instead of treating it as legacy', () => {
    expectSuccess(runInstaller(packageDir));
    fs.rmSync(path.join(pluginDir, 'dist', 'runtime-tool.js'));
    fs.writeFileSync(
      path.join(pluginDir, INTEGRITY_RECORD),
      '{"schemaVersion":',
    );

    const damagedCheck = command('node', [
      INSTALLER,
      '--check',
      '--quiet',
      '--target',
      pluginDir,
    ], isolatedEnv);

    expect(damagedCheck.status).toBe(1);
  }, 60_000);

  it('does not steal an old lock whose exact owner process is still alive', () => {
    const processStart = currentProcessStartIdentity();
    const lockPath = path.join(
      path.dirname(pluginDir),
      '.research-plugins.install.lock',
    );
    fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        processStart,
        createdAt: Date.now() - 16 * 60_000,
      }),
    );

    const blocked = runInstaller(packageDir);

    expect(blocked.status).toBe(1);
    expect(String(blocked.stderr)).toContain(
      'another research-plugins installation is active',
    );
    expect(fs.existsSync(pluginDir)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  }, 60_000);

  it('does not steal a foreign-container lock with a live heartbeat', () => {
    const lockPath = path.join(
      path.dirname(pluginDir),
      '.research-plugins.install.lock',
    );
    fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1,
        hostname: 'other-running-container',
        createdAt: Date.now() - 31 * 60_000,
      }),
    );
    const heartbeat = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs');const p=process.argv[1];setInterval(()=>{const n=new Date();fs.utimesSync(p,n,n)},100)",
        lockPath,
      ],
      { stdio: 'ignore' },
    );
    try {
      const blocked = runInstaller(packageDir);
      expect(blocked.status).toBe(1);
      expect(String(blocked.stderr)).toContain(
        'another research-plugins installation is active',
      );
      expect(fs.existsSync(pluginDir)).toBe(false);
    } finally {
      heartbeat.kill();
    }
  }, 60_000);

  it('recovers a valid backup left by an interrupted swap before retrying', () => {
    expectSuccess(runInstaller(packageDir));
    const before = treeDigest(pluginDir);
    const interruptedBackup = path.join(
      path.dirname(pluginDir),
      '.research-plugins.backup-interrupted-fixture',
    );
    fs.renameSync(pluginDir, interruptedBackup);
    const staleWork = path.join(
      path.dirname(pluginDir),
      '.research-plugins.install-interrupted-fixture',
    );
    fs.mkdirSync(staleWork);
    fs.writeFileSync(
      path.join(path.dirname(pluginDir), '.research-plugins.install.lock'),
      JSON.stringify({
        pid: process.pid,
        hostname: 'different-container-fixture',
        processStart: 'reused-pid-from-previous-container',
        createdAt: Date.now(),
      }),
    );

    const failed = runInstaller(path.join(tmpDir, 'does-not-exist'));

    expectInstallFailure(failed);
    expect(treeDigest(pluginDir)).toBe(before);
    expect(fs.existsSync(interruptedBackup)).toBe(false);
    expect(fs.existsSync(staleWork)).toBe(false);
    expectNoInstallerDebris();
  }, 60_000);

  it('retries rollback when both the swap and its first restore attempt fail', () => {
    expectSuccess(runInstaller(packageDir));
    const before = treeDigest(pluginDir);
    const faultInjector = path.join(tmpDir, 'rename-fault.cjs');
    fs.writeFileSync(
      faultInjector,
      `const fs = require('node:fs');
const rename = fs.renameSync;
let failures = 0;
fs.renameSync = function injectedRename(from, to) {
  const source = String(from).replaceAll('\\\\\\\\', '/');
  const target = String(to).replaceAll('\\\\\\\\', '/');
  const stageSwap = source.includes('/.research-plugins.install-')
    && source.endsWith('/stage')
    && target.endsWith('/research-plugins');
  const backupRestore = source.includes('/.research-plugins.backup-')
    && target.endsWith('/research-plugins');
  if ((stageSwap || backupRestore) && failures < 2) {
    failures += 1;
    const error = new Error('injected rename failure');
    error.code = 'EIO';
    throw error;
  }
  return rename.apply(this, arguments);
};\n`,
    );

    const failed = runInstaller(packageDir, {
      NODE_OPTIONS: `${isolatedEnv.NODE_OPTIONS} --require="${faultInjector.replaceAll('\\', '/')}"`,
    });

    expectInstallFailure(failed);
    expect(failed.status).toBe(1);
    expect(treeDigest(pluginDir)).toBe(before);
    expectNoInstallerDebris();
  }, 60_000);

  it('refuses a destructive target outside the current user canonical path', () => {
    const outside = path.join(tmpDir, 'research-plugins');
    const result = command('node', [
      INSTALLER,
      '--package',
      packageDir,
      '--target',
      outside,
    ], isolatedEnv);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(String(result.stderr)).toContain(
      '--target must be the current user canonical',
    );
    expect(fs.existsSync(outside)).toBe(false);
  });
});
