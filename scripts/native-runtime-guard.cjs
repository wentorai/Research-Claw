#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, '..'),
    config: '',
    requireBuild: false,
    repairNativeAbi: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' && argv[index + 1]) options.root = path.resolve(argv[++index]);
    else if (argument === '--config' && argv[index + 1]) options.config = path.resolve(argv[++index]);
    else if (argument === '--require-build') options.requireBuild = true;
    else if (argument === '--repair-native-abi') options.repairNativeAbi = true;
  }
  return options;
}

function relay(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function statusOf(result) {
  if (result.error) {
    process.stderr.write(`[runtime] Native runtime command failed: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

const options = parseArgs(process.argv.slice(2));
const preflight = path.join(__dirname, 'runtime-preflight.cjs');
const pnpmRunner = path.join(__dirname, 'run-pnpm.cjs');

function removeStaleNativeBuild() {
  const nodeModulesRoot = fs.realpathSync(path.join(options.root, 'node_modules'));
  const openClawReal = fs.realpathSync(path.join(nodeModulesRoot, 'openclaw'));
  const packageJson = require.resolve('better-sqlite3/package.json', {
    paths: [path.join(openClawReal, '..')],
  });
  const packageMetadata = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  if (packageMetadata?.name !== 'better-sqlite3') {
    throw new Error('resolved package is not better-sqlite3');
  }
  const packageRoot = fs.realpathSync(path.dirname(packageJson));
  const relativePackage = path.relative(nodeModulesRoot, packageRoot);
  if (
    !relativePackage
    || relativePackage === '..'
    || relativePackage.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePackage)
  ) {
    throw new Error('resolved better-sqlite3 package is outside the managed node_modules tree');
  }
  const buildRoot = path.join(packageRoot, 'build');
  if (!fs.existsSync(buildRoot)) return;
  const buildStat = fs.lstatSync(buildRoot);
  if (buildStat.isSymbolicLink() || !buildStat.isDirectory()) {
    throw new Error('better-sqlite3 build path is not a regular directory');
  }
  fs.rmSync(buildRoot, { recursive: true, force: true });
}

function runPreflight() {
  const args = [preflight, '--root', options.root];
  if (options.config) args.push('--config', options.config);
  if (options.requireBuild) args.push('--require-build');
  return spawnSync(process.execPath, args, {
    cwd: options.root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
}

const initial = runPreflight();
const initialStatus = statusOf(initial);
if (initialStatus === 0) {
  relay(initial);
  process.exit(0);
}

const exactAbiMismatch = String(initial.stderr || '').includes(
  '[preflight] NATIVE_ABI_MISMATCH:',
);
if (!options.repairNativeAbi || !exactAbiMismatch) {
  relay(initial);
  process.exit(initialStatus);
}

process.stderr.write(
  '[runtime] Native ABI mismatch detected; rebuilding better-sqlite3 with the pinned Gateway Node.\n',
);
const repair = spawnSync(
  process.execPath,
  [pnpmRunner, 'rebuild', 'better-sqlite3'],
  {
    cwd: options.root,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 10 * 60 * 1000,
  },
);
const repairStatus = statusOf(repair);
const targetedVerification = runPreflight();
const targetedVerificationStatus = statusOf(targetedVerification);
if (targetedVerificationStatus === 0) {
  relay(targetedVerification);
  process.stdout.write('[runtime] Native ABI repaired and verified.\n');
  process.exit(0);
}

process.stderr.write(
  repairStatus === 0
    ? '[runtime] Targeted rebuild returned success but the native binding is still unusable; forcing a clean dependency lifecycle.\n'
    : `[runtime] Targeted native ABI rebuild failed with exit code ${repairStatus}; forcing a clean dependency lifecycle.\n`,
);

try {
  // pnpm rebuild can return zero without replacing an already-present .node
  // binary. Bind the package to this managed node_modules tree before removing
  // only its generated build directory; user config, Profile data, and SQLite
  // databases are outside this boundary and are never touched here.
  removeStaleNativeBuild();
} catch (error) {
  process.stderr.write(
    `[runtime] Could not isolate the stale better-sqlite3 build: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  relay(targetedVerification);
  process.exit(78);
}

const forcedInstall = spawnSync(
  process.execPath,
  [pnpmRunner, 'install', '--force', '--reporter=append-only'],
  {
    cwd: options.root,
    env: {
      ...process.env,
      CI: '1',
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 10 * 60 * 1000,
  },
);
const forcedInstallStatus = statusOf(forcedInstall);
const verified = runPreflight();
const verifiedStatus = statusOf(verified);
if (forcedInstallStatus !== 0 || verifiedStatus !== 0) {
  process.stderr.write(
    forcedInstallStatus !== 0
      ? `[runtime] Forced dependency lifecycle failed with exit code ${forcedInstallStatus}.\n`
      : '[runtime] Forced dependency lifecycle completed, but runtime verification still failed.\n',
  );
  relay(verified);
  process.exit(forcedInstallStatus !== 0 ? forcedInstallStatus : verifiedStatus);
}

relay(verified);
process.stdout.write('[runtime] Native ABI repaired and verified after a forced dependency lifecycle.\n');
