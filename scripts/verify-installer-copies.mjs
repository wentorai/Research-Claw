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
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flagIndex = process.argv.indexOf('--wentor-root');
const wentorRoot = flagIndex >= 0
  ? path.resolve(process.argv[flagIndex + 1] ?? '')
  : path.resolve(rcRoot, '..');
const publicUrlIndex = process.argv.indexOf('--public-url');
const publicUrl = publicUrlIndex >= 0
  ? process.argv[publicUrlIndex + 1]
  : null;

if (publicUrlIndex >= 0 && !publicUrl) {
  throw new Error('--public-url requires a URL');
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

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

if (publicUrl) {
  const canonicalPath = copySets[0].source;
  const canonical = fs.readFileSync(canonicalPath);
  let response;
  try {
    response = await fetch(publicUrl, { redirect: 'follow' });
  } catch (error) {
    console.error(`UNREACHABLE public native installer: ${publicUrl} (${error.message})`);
    failed = true;
  }
  if (response && !response.ok) {
    console.error(`HTTP ${response.status} public native installer: ${publicUrl}`);
    failed = true;
  } else if (response) {
    const published = Buffer.from(await response.arrayBuffer());
    if (!canonical.equals(published)) {
      console.error(
        `DRIFT public native installer: ${publicUrl}\n`
        + `  canonical sha256=${sha256(canonical)}\n`
        + `  public    sha256=${sha256(published)}`,
      );
      failed = true;
    } else {
      console.log(`MATCH public native installer: ${publicUrl} sha256=${sha256(canonical)}`);
    }
  }
}

if (failed) process.exitCode = 1;
