#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LEGACY_DIR = path.join(PROJECT_ROOT, '.research-claw');
const TARGET_DIR = path.join(os.homedir(), '.research-claw');

function hasEntries(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function migrateDir() {
  if (!fs.existsSync(LEGACY_DIR)) return false;

  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(path.dirname(TARGET_DIR), { recursive: true });
    fs.renameSync(LEGACY_DIR, TARGET_DIR);
    console.log(`[migrate-rc-data] moved ${LEGACY_DIR} -> ${TARGET_DIR}`);
    return true;
  }

  if (!hasEntries(LEGACY_DIR)) return false;

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  fs.cpSync(LEGACY_DIR, TARGET_DIR, {
    recursive: true,
    force: false,
    errorOnExist: false,
    dereference: false,
  });

  const backupDir = `${LEGACY_DIR}.migrated-to-home-${Date.now()}`;
  fs.renameSync(LEGACY_DIR, backupDir);
  console.log(`[migrate-rc-data] merged ${LEGACY_DIR} -> ${TARGET_DIR} (backup: ${backupDir})`);
  return true;
}

try {
  migrateDir();
} catch (error) {
  console.warn(`[migrate-rc-data] warn: ${error?.message || error}`);
  process.exitCode = 1;
}
