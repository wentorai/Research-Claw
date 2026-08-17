#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
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
if (repairStatus !== 0) {
  process.stderr.write(`[runtime] Targeted native ABI rebuild failed with exit code ${repairStatus}.\n`);
  relay(initial);
  process.exit(repairStatus);
}

const verified = runPreflight();
const verifiedStatus = statusOf(verified);
if (verifiedStatus !== 0) {
  process.stderr.write('[runtime] Native ABI rebuild completed, but runtime verification still failed.\n');
  relay(verified);
  process.exit(verifiedStatus);
}

relay(verified);
process.stdout.write('[runtime] Native ABI repaired and verified.\n');
