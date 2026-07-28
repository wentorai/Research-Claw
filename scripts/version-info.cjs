#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function readVersion(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readCommit(root) {
  const fromEnvironment = process.env.RC_BUILD_COMMIT?.trim();
  if (fromEnvironment && /^[0-9a-f]{7,40}$/i.test(fromEnvironment)) {
    return fromEnvironment.slice(0, 12).toLowerCase();
  }
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv) {
  let root = path.resolve(__dirname, '..');
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) {
      root = path.resolve(argv[++i]);
    } else if (argv[i] === '--json') {
      json = true;
    }
  }
  return { root, json };
}

const { root, json } = parseArgs(process.argv.slice(2));
const info = {
  researchClaw: readVersion(path.join(root, 'package.json')),
  openClaw: readVersion(path.join(root, 'node_modules', 'openclaw', 'package.json')),
  commit: readCommit(root),
};

if (json) {
  process.stdout.write(`${JSON.stringify(info)}\n`);
} else {
  process.stdout.write(
    `Research-Claw v${info.researchClaw} · OpenClaw ${info.openClaw} · commit ${info.commit}\n`,
  );
}
