#!/usr/bin/env node

/**
 * Verify the release installer chain from its canonical Research-Claw sources
 * to the Wentor website copies. Read-only: this script never synchronizes or
 * edits files. Run from any directory:
 *
 *   node scripts/verify-installer-copies.mjs
 *   node scripts/verify-installer-copies.mjs --wentor-root /path/to/wentor
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flagIndex = process.argv.indexOf('--wentor-root');
const wentorRoot = flagIndex >= 0
  ? path.resolve(process.argv[flagIndex + 1] ?? '')
  : path.resolve(rcRoot, '..');

const copySets = [
  {
    label: 'native installer',
    source: path.join(rcRoot, 'scripts', 'install.sh'),
    copies: [
      path.join(wentorRoot, 'install.sh'),
      path.join(wentorRoot, 'web', 'public', 'install.sh'),
      path.join(wentorRoot, 'web', 'dist', 'install.sh'),
    ],
  },
  {
    label: 'POSIX Docker installer',
    source: path.join(rcRoot, 'scripts', 'install-docker.sh'),
    copies: [
      path.join(wentorRoot, 'web', 'public', 'docker-install.sh'),
      path.join(wentorRoot, 'web', 'dist', 'docker-install.sh'),
    ],
  },
  {
    label: 'Windows Docker installer',
    source: path.join(rcRoot, 'scripts', 'install-docker.ps1'),
    copies: [
      path.join(wentorRoot, 'web', 'public', 'docker-install.ps1'),
      path.join(wentorRoot, 'web', 'dist', 'docker-install.ps1'),
    ],
  },
];

let failed = false;
for (const set of copySets) {
  if (!fs.existsSync(set.source)) {
    console.error(`MISSING source: ${set.source}`);
    failed = true;
    continue;
  }
  const canonical = fs.readFileSync(set.source);
  for (const copy of set.copies) {
    if (!fs.existsSync(copy)) {
      console.error(`MISSING ${set.label} copy: ${copy}`);
      failed = true;
      continue;
    }
    if (!canonical.equals(fs.readFileSync(copy))) {
      console.error(`DRIFT ${set.label}: ${copy}`);
      failed = true;
    } else {
      console.log(`MATCH ${set.label}: ${copy}`);
    }
  }
}

if (failed) process.exitCode = 1;
