#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
);
const packageManager = String(packageJson.packageManager ?? '');
const match = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(packageManager);

if (!match) {
  console.error(
    `[research-claw] Cannot determine an exact pnpm version from packageManager=${JSON.stringify(packageManager)}.`,
  );
  process.exitCode = 1;
  return;
}

const requiredVersion = match[1];
const prefix = path.resolve(
  process.env.RC_PNPM_PREFIX || path.join(projectRoot, '.tools', 'pnpm'),
);
const pnpmCli = process.platform === 'win32'
  ? path.join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  : path.join(prefix, 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
const pnpmBinDir = process.platform === 'win32'
  ? prefix
  : path.join(prefix, 'bin');

function resolveNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.RC_NPM_CLI,
    process.env.npm_execpath?.endsWith('npm-cli.js')
      ? process.env.npm_execpath
      : null,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(
      nodeDir,
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ];
  return candidates.find(
    (candidate) => candidate && fs.existsSync(candidate),
  ) || null;
}

function installedVersion() {
  const probe = spawnSync(process.execPath, [pnpmCli, '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (probe.status !== 0) return null;
  return probe.stdout.trim();
}

function installRequiredVersion(currentVersion) {
  if (currentVersion) {
    console.error(
      `[research-claw] Updating the project pnpm tool from ${currentVersion} to ${requiredVersion}...`,
    );
  } else {
    console.error(
      `[research-claw] Preparing the project pnpm tool (${requiredVersion})...`,
    );
  }
  fs.mkdirSync(prefix, { recursive: true });
  const npmCli = resolveNpmCli();
  if (!npmCli) {
    console.error(
      '[research-claw] Cannot locate npm-cli.js for the current Node.js installation.',
    );
    return false;
  }
  const install = spawnSync(
    process.execPath,
    [
      npmCli,
      'install',
      '--prefix',
      prefix,
      '-g',
      `pnpm@${requiredVersion}`,
    ],
    { stdio: 'inherit' },
  );
  if (install.error) {
    console.error(
      `[research-claw] Unable to start npm while preparing pnpm: ${install.error.message}`,
    );
    return false;
  }
  if (install.status !== 0) {
    console.error(
      `[research-claw] Unable to install the required pnpm ${requiredVersion}.`,
    );
    return false;
  }
  const verifiedVersion = installedVersion();
  if (verifiedVersion !== requiredVersion) {
    console.error(
      `[research-claw] pnpm verification failed: expected ${requiredVersion}, received ${verifiedVersion ?? 'unavailable'}.`,
    );
    return false;
  }
  return true;
}

if (process.argv.length < 3) {
  console.error('Usage: node scripts/run-pnpm.cjs <pnpm command> [...args]');
  process.exitCode = 2;
  return;
}

const currentVersion = installedVersion();
if (
  currentVersion !== requiredVersion
  && !installRequiredVersion(currentVersion)
) {
  process.exitCode = 1;
  return;
}

const childEnv = { ...process.env };
const pathKey = Object.keys(childEnv)
  .find((key) => key.toLowerCase() === 'path') || 'PATH';
childEnv[pathKey] = `${pnpmBinDir}${path.delimiter}${childEnv[pathKey] ?? ''}`;

const run = spawnSync(process.execPath, [pnpmCli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: 'inherit',
});
if (run.error) {
  console.error(`[research-claw] Unable to run pnpm: ${run.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = run.status ?? 1;
}
