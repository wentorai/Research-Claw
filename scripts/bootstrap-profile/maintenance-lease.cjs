'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fsyncDirectory } = require('./storage.cjs');

const LOCK_VERSION = 1;
const IDENTITY_KEYS = ['version', 'rootUuid', 'configBasename'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTHORITY_FILE = 'authority.json';
const ROOT_AUTHORITY_DIRECTORY = '.rc-bootstrap-lock-authority';
const ROOT_AUTHORITY_NEXT_FILE = '.authority-next.json';
const ROOT_AUTHORITY_NEXT_ANCHOR = '.authority-next.anchor';
const VOLUME_LOSS_RECOVERY_NAME = /^\.rc-bootstrap-volume-loss-recovery-v1-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const VOLUME_LOSS_RECOVERY_STAGING_NAME = /^\.rc-bootstrap-volume-loss-recovery-stage-v1-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const ROOT_AUTHORITY_STATES = new Set(['preparing', 'committed']);
const STAGING_NAME = /^\.locks-init-[0-9a-f-]{36}$/;
const ROOT_AUTHORITY_STAGING_NAME = /^\.lock-authority-init-[0-9a-f-]{36}$/;
const VOLUME_LOSS_RECOVERY_FILE = 'recovery.json';
const VOLUME_LOSS_PLACEHOLDER_FILE = 'placeholder.json';
const VOLUME_LOSS_PLACEHOLDER_NAME = /^\.config-placeholder-[0-9a-f-]{36}$/;
const DATABASE_SCHEMA = `CREATE TABLE rc_lock_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL CHECK (version = 1),
          root_uuid TEXT NOT NULL,
          config_basename TEXT NOT NULL
        )`;

class MaintenanceLeaseError extends Error {
  constructor(code) {
    super('Research-Claw bootstrap lock failed');
    this.name = 'MaintenanceLeaseError';
    this.code = code;
  }
}

function fail(code) {
  throw new MaintenanceLeaseError(code);
}

function failBusyIfRace(error) {
  if (error && ['EEXIST', 'ENOENT'].includes(error.code)) fail('LOCK_INITIALIZATION_BUSY');
  throw error;
}

function isRaceError(error) {
  return Boolean(error && ['EEXIST', 'ENOENT'].includes(error.code));
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function requirePrivateDirectory(target, code = 'INVALID_LOCK_ROOT', { privateMode = true } = {}) {
  const metadata = lstatIfPresent(target);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) fail(code);
  if (process.platform !== 'win32'
      && (metadata.uid !== process.getuid()
        || (metadata.mode & 0o022) !== 0
        || (privateMode && (metadata.mode & 0o055) !== 0))) fail(code);
  return fs.realpathSync(target);
}

function createPrivateDirectory(target) {
  let created = false;
  try {
    fs.mkdirSync(target, { mode: 0o700 });
    created = true;
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const metadata = lstatIfPresent(target);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail('INVALID_LOCK_ROOT');
  }
  if (process.platform !== 'win32' && metadata.uid !== process.getuid()) {
    fail('INVALID_LOCK_ROOT');
  }
  if (created && process.platform !== 'win32') fs.chmodSync(target, 0o700);
  return requirePrivateDirectory(target);
}

function requirePrivateFile(target, code = 'INVALID_LOCK_FILE') {
  const metadata = lstatIfPresent(target);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) fail(code);
  if (process.platform !== 'win32'
      && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)) fail(code);
  return metadata;
}

function completeCanonicalEmptyFile(file, bytes, parent, code) {
  const before = requirePrivateFile(file, code);
  if (before.size !== 0) return false;
  const descriptor = fs.openSync(file, 'r+');
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) fail(code);
    if (opened.size === 0) {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(parent);
  const after = requirePrivateFile(file, code);
  if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== bytes.length || !fs.readFileSync(file).equals(bytes)) fail(code);
  return true;
}

function requireSafeJournal(file) {
  const journal = `${file}-journal`;
  const metadata = lstatIfPresent(journal);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    fail('INVALID_LOCK_FILE');
  }
  if (process.platform !== 'win32'
      && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)) {
    fail('INVALID_LOCK_FILE');
  }
}

function rejectWalSidecars(file) {
  if (lstatIfPresent(`${file}-wal`) || lstatIfPresent(`${file}-shm`)) {
    fail('INVALID_LOCK_DATABASE');
  }
  requireSafeJournal(file);
}

function validateConfigFile(configPath, { allowAbsent = false } = {}) {
  const metadata = lstatIfPresent(configPath);
  if (!metadata) {
    if (allowAbsent) return;
    fail('INVALID_CONFIG_IDENTITY');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    fail('INVALID_CONFIG_IDENTITY');
  }
  if (process.platform !== 'win32'
      && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)) {
    fail('INVALID_CONFIG_IDENTITY');
  }
}

function resolveLockPaths(configPath, { initialize = false, allowConfigAbsent = false } = {}) {
  if (typeof configPath !== 'string' || configPath.includes('\0') || !path.isAbsolute(configPath)) {
    fail('INVALID_LOCK_ROOT');
  }
  const normalized = path.normalize(configPath);
  const configRoot = requirePrivateDirectory(path.dirname(normalized), 'INVALID_LOCK_ROOT', {
    privateMode: false,
  });
  const canonicalConfig = path.join(configRoot, path.basename(normalized));
  validateConfigFile(canonicalConfig, { allowAbsent: allowConfigAbsent });

  const bootstrapRoot = path.join(configRoot, '.rc-bootstrap');
  const locksRoot = path.join(bootstrapRoot, 'locks');
  // The durable completion marker intentionally lives outside `.rc-bootstrap`.
  // Losing or replacing that entire subtree must not make an already-published
  // lock authority look like a fresh installation.
  const rootAuthorityDirectory = path.join(configRoot, ROOT_AUTHORITY_DIRECTORY);
  if (initialize) {
    createPrivateDirectory(bootstrapRoot);
  } else {
    requirePrivateDirectory(bootstrapRoot, 'LOCK_AUTHORITY_LOST');
    requirePrivateDirectory(locksRoot, 'LOCK_AUTHORITY_LOST');
  }
  return {
    configRoot,
    configPath: canonicalConfig,
    configBasename: path.basename(canonicalConfig),
    bootstrapRoot,
    locksRoot,
    rootAuthorityDirectory,
    rootAuthority: path.join(rootAuthorityDirectory, AUTHORITY_FILE),
    identity: path.join(locksRoot, 'identity.json'),
    authority: path.join(locksRoot, AUTHORITY_FILE),
    operation: path.join(locksRoot, 'operation.sqlite'),
    runtime: path.join(locksRoot, 'runtime.sqlite'),
  };
}

function pathsForLocksRoot(base, locksRoot) {
  return {
    ...base,
    locksRoot,
    identity: path.join(locksRoot, 'identity.json'),
    authority: path.join(locksRoot, AUTHORITY_FILE),
    operation: path.join(locksRoot, 'operation.sqlite'),
    runtime: path.join(locksRoot, 'runtime.sqlite'),
  };
}

function stableIdentity(value, configBasename) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...IDENTITY_KEYS].sort().join(',')
      || value.version !== LOCK_VERSION || !UUID.test(value.rootUuid)
      || value.configBasename !== configBasename) fail('LOCK_IDENTITY_MISMATCH');
  return value;
}

function readIdentity(paths, expectedRootUuid = null) {
  const metadata = requirePrivateFile(paths.identity, 'LOCK_AUTHORITY_LOST');
  if (metadata.size === 0 && expectedRootUuid) fail('LOCK_INITIALIZATION_BUSY');
  if (metadata.size < 2 || metadata.size > 4096) fail('LOCK_IDENTITY_MISMATCH');
  let value;
  try { value = JSON.parse(fs.readFileSync(paths.identity, 'utf8')); } catch { fail('LOCK_IDENTITY_MISMATCH'); }
  const stable = stableIdentity(value, paths.configBasename);
  if (expectedRootUuid && stable.rootUuid !== expectedRootUuid) fail('LOCK_IDENTITY_MISMATCH');
  return stable;
}

function createIdentity(paths, rootUuid = crypto.randomUUID()) {
  if (!UUID.test(rootUuid)) fail('INVALID_LOCK_ROOT');
  const value = {
    version: LOCK_VERSION,
    rootUuid,
    configBasename: paths.configBasename,
  };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  let descriptor;
  try {
    descriptor = fs.openSync(paths.identity, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const canonical = path.basename(paths.locksRoot) === `.locks-init-${rootUuid}`;
      if (canonical) completeCanonicalEmptyFile(
        paths.identity, bytes, paths.locksRoot, 'LOCK_IDENTITY_MISMATCH',
      );
      return readIdentity(paths, rootUuid);
    }
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') fs.chmodSync(paths.identity, 0o600);
  fsyncDirectory(paths.locksRoot);
  return stableIdentity(value, paths.configBasename);
}

function resolveDatabase(rcRoot) {
  if (typeof rcRoot !== 'string' || rcRoot.includes('\0') || !path.isAbsolute(rcRoot)) {
    fail('SQLITE_RUNTIME_UNAVAILABLE');
  }
  let modulePath;
  try {
    modulePath = require.resolve('better-sqlite3', {
      paths: [path.join(rcRoot, 'extensions/research-claw-core'), rcRoot],
    });
  } catch {
    fail('SQLITE_RUNTIME_UNAVAILABLE');
  }
  return require(modulePath);
}

function mapSqliteError(error, code) {
  if (error && ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_RECOVERY'].includes(error.code)) fail(code);
  if (error instanceof MaintenanceLeaseError) throw error;
  fail('INVALID_LOCK_DATABASE');
}

function openExisting(Database, file) {
  const before = requirePrivateFile(file, 'LOCK_AUTHORITY_LOST');
  rejectWalSidecars(file);
  let database;
  try {
    database = new Database(file, { fileMustExist: true });
    database.pragma('busy_timeout = 0');
  } catch (error) {
    try { database?.close(); } catch {}
    mapSqliteError(error, 'LOCK_DATABASE_BUSY');
  }
  const after = requirePrivateFile(file, 'LOCK_AUTHORITY_LOST');
  if (before.dev !== after.dev || before.ino !== after.ino) {
    try { database.close(); } catch {}
    fail('INVALID_LOCK_FILE');
  }
  rejectWalSidecars(file);
  return database;
}

function validateDatabase(database, identity) {
  try {
    if (database.pragma('journal_mode', { simple: true }) !== 'delete'
        || database.pragma('locking_mode', { simple: true }) !== 'normal'
        || database.pragma('user_version', { simple: true }) !== LOCK_VERSION) {
      fail('INVALID_LOCK_DATABASE');
    }
    const schema = database.prepare(
      "SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    if (schema.length !== 1 || schema[0].name !== 'rc_lock_identity' || schema[0].type !== 'table') {
      fail('INVALID_LOCK_DATABASE');
    }
    const canonicalSql = (value) => String(value).replace(/\s+/g, ' ').trim().toLowerCase();
    if (canonicalSql(schema[0].sql) !== canonicalSql(DATABASE_SCHEMA)) {
      fail('INVALID_LOCK_DATABASE');
    }
    const columns = database.pragma('table_info(rc_lock_identity)');
    if (stableColumns(columns) !== stableColumns([
      { cid: 0, name: 'singleton', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'root_uuid', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'config_basename', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    ])) fail('INVALID_LOCK_DATABASE');
    const row = database.prepare(
      'SELECT singleton, version, root_uuid, config_basename FROM rc_lock_identity',
    ).all();
    if (row.length !== 1 || row[0].singleton !== 1 || row[0].version !== LOCK_VERSION
        || row[0].root_uuid !== identity.rootUuid
        || row[0].config_basename !== identity.configBasename) fail('LOCK_IDENTITY_MISMATCH');
  } catch (error) {
    if (error instanceof MaintenanceLeaseError) throw error;
    mapSqliteError(error, 'LOCK_DATABASE_BUSY');
  }
}

function stableColumns(columns) {
  return JSON.stringify(columns.map((column) => ({
    cid: column.cid,
    name: column.name,
    type: column.type,
    notnull: column.notnull,
    dflt_value: column.dflt_value,
    pk: column.pk,
  })));
}

function createEmptyPrivateFile(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  fsyncDirectory(path.dirname(file));
  return true;
}

function initializeDatabase(Database, file, identity) {
  createEmptyPrivateFile(file);
  const database = openExisting(Database, file);
  try {
    database.pragma('busy_timeout = 0');
    const journalMode = database.pragma('journal_mode = DELETE', { simple: true });
    const lockingMode = database.pragma('locking_mode = NORMAL', { simple: true });
    database.pragma('synchronous = FULL');
    if (journalMode !== 'delete' || lockingMode !== 'normal') fail('INVALID_LOCK_DATABASE');
    database.exec('BEGIN EXCLUSIVE');
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS ${DATABASE_SCHEMA.slice('CREATE TABLE '.length)};`);
      const rows = database.prepare('SELECT COUNT(*) AS count FROM rc_lock_identity').get();
      if (rows.count === 0) {
        database.prepare(
          'INSERT INTO rc_lock_identity(singleton, version, root_uuid, config_basename) VALUES (1, ?, ?, ?)',
        ).run(LOCK_VERSION, identity.rootUuid, identity.configBasename);
      }
      database.pragma(`user_version = ${LOCK_VERSION}`);
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
    validateDatabase(database, identity);
  } catch (error) {
    try { database.close(); } catch {}
    if (error instanceof MaintenanceLeaseError) throw error;
    mapSqliteError(error, 'LOCK_INITIALIZATION_BUSY');
  }
  database.close();
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  rejectWalSidecars(file);
  const descriptor = fs.openSync(file, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fsyncDirectory(path.dirname(file));
}

function readAuthority(paths, identity) {
  const metadata = requirePrivateFile(paths.authority, 'LOCK_AUTHORITY_LOST');
  if (metadata.size < 2 || metadata.size > 4096) fail('INVALID_LOCK_AUTHORITY');
  let value;
  try { value = JSON.parse(fs.readFileSync(paths.authority, 'utf8')); } catch { fail('INVALID_LOCK_AUTHORITY'); }
  if (!value || Object.keys(value).sort().join(',') !== 'configBasename,rootUuid,version'
      || value.version !== LOCK_VERSION || value.rootUuid !== identity.rootUuid
      || value.configBasename !== identity.configBasename) fail('INVALID_LOCK_AUTHORITY');
  return value;
}

function authorityValue(identity) {
  return {
    version: LOCK_VERSION,
    rootUuid: identity.rootUuid,
    configBasename: identity.configBasename,
  };
}

function observeExpectedLockAuthority(file, identity, { allowEmpty = false } = {}) {
  const metadata = requirePrivateFile(file, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  if (metadata.size === 0 && allowEmpty) return false;
  if (metadata.size < 2 || metadata.size > 4096) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  if (JSON.stringify(value) !== JSON.stringify(authorityValue(identity))) {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  const after = lstatIfPresent(file);
  if (!after || after.dev !== metadata.dev || after.ino !== metadata.ino
      || after.size !== metadata.size || after.nlink !== 1) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  return true;
}

function observeCanonicalPartialLockSet(stagingRoot, paths, rootUuid, { allowEmpty = true } = {}) {
  const before = lstatIfPresent(stagingRoot);
  requirePrivateDirectory(stagingRoot, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  if (!before || before.isSymbolicLink() || !before.isDirectory()) {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  const entries = fs.readdirSync(stagingRoot).sort();
  const prefixes = [
    [],
    ['identity.json'],
    ['identity.json', 'operation.sqlite'],
    ['identity.json', 'operation.sqlite', 'runtime.sqlite'],
    ['authority.json', 'identity.json', 'operation.sqlite', 'runtime.sqlite'].sort(),
  ].map((value) => JSON.stringify(value));
  if (!prefixes.includes(JSON.stringify(entries))) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  if (entries.length === 0) {
    if (!allowEmpty) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  } else {
    const staging = pathsForLocksRoot(paths, stagingRoot);
    const identityMetadata = requirePrivateFile(
      staging.identity, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY',
    );
    if (identityMetadata.size === 0) {
      if (!allowEmpty || entries.length !== 1) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    } else {
      let identity;
      try { identity = readIdentity(staging, rootUuid); } catch (error) {
        if (error instanceof MaintenanceLeaseError
            && ['LOCK_AUTHORITY_LOST', 'LOCK_IDENTITY_MISMATCH'].includes(error.code)) {
          fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
        }
        throw error;
      }
      if (entries.includes('operation.sqlite')) {
        requirePrivateFile(staging.operation, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
      }
      if (entries.includes('runtime.sqlite')) {
        requirePrivateFile(staging.runtime, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
      }
      if (entries.includes('authority.json')) {
        observeExpectedLockAuthority(staging.authority, identity, { allowEmpty });
      }
    }
  }
  const after = lstatIfPresent(stagingRoot);
  if (!after || after.dev !== before.dev || after.ino !== before.ino) {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
}

function parseRootAuthorityValue(value, paths, code = 'INVALID_LOCK_AUTHORITY') {
  if (!value || Object.keys(value).sort().join(',') !== 'configBasename,rootUuid,stagingName,state,version'
      || value.version !== LOCK_VERSION || !UUID.test(value.rootUuid)
      || value.configBasename !== paths.configBasename
      || !ROOT_AUTHORITY_STATES.has(value.state)
      || (value.stagingName !== null && !STAGING_NAME.test(value.stagingName))) {
    fail(code);
  }
  return value;
}

function readRootAuthorityJson(file, paths, code, expectedLinks = 1) {
  const metadata = lstatIfPresent(file);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()
      || metadata.nlink !== expectedLinks || metadata.size < 2 || metadata.size > 4096) fail(code);
  if (process.platform !== 'win32'
      && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)) fail(code);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(code); }
  const after = lstatIfPresent(file);
  if (!after || metadata.dev !== after.dev || metadata.ino !== after.ino
      || metadata.size !== after.size || after.nlink !== expectedLinks) fail(code);
  return { metadata: after, value: parseRootAuthorityValue(value, paths, code) };
}

function rootAuthorityBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function inspectRootAuthority(paths, code = 'INVALID_LOCK_AUTHORITY') {
  requirePrivateDirectory(paths.rootAuthorityDirectory, 'LOCK_AUTHORITY_LOST');
  const entries = fs.readdirSync(paths.rootAuthorityDirectory).sort();
  if (JSON.stringify(entries) === JSON.stringify([AUTHORITY_FILE])) {
    const authority = readRootAuthorityJson(paths.rootAuthority, paths, code);
    return { ...authority, topology: 'complete' };
  }
  const next = path.join(paths.rootAuthorityDirectory, ROOT_AUTHORITY_NEXT_FILE);
  const anchor = path.join(paths.rootAuthorityDirectory, ROOT_AUTHORITY_NEXT_ANCHOR);
  if (JSON.stringify(entries) === JSON.stringify([
    ROOT_AUTHORITY_NEXT_ANCHOR, ROOT_AUTHORITY_NEXT_FILE, AUTHORITY_FILE,
  ].sort())) {
    const authority = readRootAuthorityJson(paths.rootAuthority, paths, code);
    if (authority.value.state !== 'preparing') fail(code);
    const nextRecord = readRootAuthorityJson(next, paths, code, 2);
    const anchorMetadata = lstatIfPresent(anchor);
    if (!anchorMetadata || anchorMetadata.isSymbolicLink() || !anchorMetadata.isFile()
        || anchorMetadata.nlink !== 2 || anchorMetadata.dev !== nextRecord.metadata.dev
        || anchorMetadata.ino !== nextRecord.metadata.ino) fail(code);
    if (nextRecord.value.rootUuid !== authority.value.rootUuid
        || nextRecord.value.state !== 'committed' || nextRecord.value.stagingName !== null) fail(code);
    return { ...authority, next: nextRecord, topology: 'preparing-transition' };
  }
  if (JSON.stringify(entries) === JSON.stringify([
    ROOT_AUTHORITY_NEXT_ANCHOR, AUTHORITY_FILE,
  ].sort())) {
    const authority = readRootAuthorityJson(paths.rootAuthority, paths, code, 2);
    const anchorMetadata = lstatIfPresent(anchor);
    if (!anchorMetadata || anchorMetadata.isSymbolicLink() || !anchorMetadata.isFile()
        || anchorMetadata.nlink !== 2 || anchorMetadata.dev !== authority.metadata.dev
        || anchorMetadata.ino !== authority.metadata.ino
        || authority.value.state !== 'committed' || authority.value.stagingName !== null) fail(code);
    return { ...authority, topology: 'committed-transition' };
  }
  fail(code);
}

function parseRootAuthority(paths, code = 'INVALID_LOCK_AUTHORITY') {
  return inspectRootAuthority(paths, code).value;
}

function readRootAuthority(paths, identity) {
  const value = parseRootAuthority(paths);
  if (value.state !== 'committed' || value.stagingName !== null
      || value.rootUuid !== identity.rootUuid) fail('INVALID_LOCK_AUTHORITY');
  return value;
}

function rootAuthorityValue(identity, state, stagingName) {
  return {
    version: LOCK_VERSION,
    rootUuid: identity.rootUuid,
    configBasename: identity.configBasename,
    state,
    stagingName,
  };
}

function isCanonicalRecoveryElection(value, stagingName = null) {
  return value.state === 'preparing'
    && value.stagingName === `.locks-init-${value.rootUuid}`
    && (stagingName === null || stagingName === `.lock-authority-init-${value.rootUuid}`);
}

function observeExpectedRootAuthorityFile(
  file, paths, expected, code, { expectedLinks = 1, allowEmpty = false } = {},
) {
  const metadata = lstatIfPresent(file);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()
      || metadata.nlink !== expectedLinks) fail(code);
  if (process.platform !== 'win32'
      && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)) fail(code);
  if (metadata.size === 0) {
    if (!allowEmpty) fail(code);
    const after = lstatIfPresent(file);
    if (!after || after.dev !== metadata.dev || after.ino !== metadata.ino
        || after.size !== 0 || after.nlink !== expectedLinks) fail(code);
    return { metadata: after, empty: true };
  }
  const checked = readRootAuthorityJson(file, paths, code, expectedLinks);
  if (JSON.stringify(checked.value) !== JSON.stringify(expected)) fail(code);
  return { ...checked, empty: false };
}

function observeExpectedRootAuthorityNextPair(
  directory, paths, preparing, code, { allowEmpty = false } = {},
) {
  const nextValue = rootAuthorityValue(preparing, 'committed', null);
  const next = path.join(directory, ROOT_AUTHORITY_NEXT_FILE);
  const anchor = path.join(directory, ROOT_AUTHORITY_NEXT_ANCHOR);
  const nextMetadata = lstatIfPresent(next);
  const anchorMetadata = lstatIfPresent(anchor);
  if (!nextMetadata || (anchorMetadata && nextMetadata.nlink !== 2)) {
    if (!nextMetadata || anchorMetadata) fail(code);
  }
  if (!anchorMetadata) {
    observeExpectedRootAuthorityFile(
      next, paths, nextValue, code, { allowEmpty },
    );
    return;
  }
  const checked = observeExpectedRootAuthorityFile(
    next, paths, nextValue, code, { expectedLinks: 2 },
  );
  const checkedAnchor = lstatIfPresent(anchor);
  if (!checkedAnchor || checkedAnchor.isSymbolicLink() || !checkedAnchor.isFile()
      || checkedAnchor.nlink !== 2 || checkedAnchor.dev !== checked.metadata.dev
      || checkedAnchor.ino !== checked.metadata.ino) fail(code);
}

function observeRootAuthorityStageRace(staging, paths, value, code, allowEmpty) {
  const before = lstatIfPresent(staging);
  requirePrivateDirectory(staging, code);
  if (!before || before.isSymbolicLink() || !before.isDirectory()) fail(code);
  const entries = fs.readdirSync(staging).sort();
  const nextOnly = JSON.stringify([ROOT_AUTHORITY_NEXT_FILE]);
  const nextPair = JSON.stringify([ROOT_AUTHORITY_NEXT_ANCHOR, ROOT_AUTHORITY_NEXT_FILE].sort());
  const complete = JSON.stringify([
    ROOT_AUTHORITY_NEXT_ANCHOR, ROOT_AUTHORITY_NEXT_FILE, AUTHORITY_FILE,
  ].sort());
  const topology = JSON.stringify(entries);
  if (entries.length === 0) {
    if (!allowEmpty) fail(code);
  } else if (topology === nextOnly) {
    observeExpectedRootAuthorityNextPair(staging, paths, value, code, { allowEmpty });
  } else if (topology === nextPair) {
    observeExpectedRootAuthorityNextPair(staging, paths, value, code);
  } else if (topology === complete) {
    observeExpectedRootAuthorityNextPair(staging, paths, value, code);
    observeExpectedRootAuthorityFile(
      path.join(staging, AUTHORITY_FILE), paths, value, code, { allowEmpty },
    );
  } else {
    fail(code);
  }
  const after = lstatIfPresent(staging);
  if (!after || after.dev !== before.dev || after.ino !== before.ino) fail(code);
}

function ensureRootAuthorityNextPair(directory, paths, preparing, code = 'INVALID_LOCK_AUTHORITY') {
  if (preparing.state !== 'preparing' || !STAGING_NAME.test(preparing.stagingName)) fail(code);
  const nextValue = rootAuthorityValue(preparing, 'committed', null);
  const next = path.join(directory, ROOT_AUTHORITY_NEXT_FILE);
  const anchor = path.join(directory, ROOT_AUTHORITY_NEXT_ANCHOR);
  const nextMetadata = lstatIfPresent(next);
  const anchorMetadata = lstatIfPresent(anchor);
  if (!nextMetadata && !anchorMetadata) {
    let descriptor;
    try { descriptor = fs.openSync(next, 'wx', 0o600); } catch (error) {
      if (!isRaceError(error)) throw error;
      const canonical = isCanonicalRecoveryElection(preparing);
      observeExpectedRootAuthorityNextPair(
        directory, paths, preparing, canonical ? 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' : code,
        { allowEmpty: canonical },
      );
      fail('LOCK_INITIALIZATION_BUSY');
    }
    try {
      fs.writeFileSync(descriptor, rootAuthorityBytes(nextValue));
      try { fs.linkSync(next, anchor); } catch (error) {
        if (!isRaceError(error)) throw error;
        observeExpectedRootAuthorityNextPair(
          directory, paths, preparing,
          isCanonicalRecoveryElection(preparing) ? 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' : code,
        );
        fail('LOCK_INITIALIZATION_BUSY');
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (process.platform !== 'win32') fs.chmodSync(next, 0o600);
    fsyncDirectory(directory);
  } else if (nextMetadata && !anchorMetadata) {
    const checked = readRootAuthorityJson(next, paths, code);
    if (JSON.stringify(checked.value) !== JSON.stringify(nextValue)) fail(code);
    try { fs.linkSync(next, anchor); } catch (error) {
      if (!isRaceError(error)) throw error;
      observeExpectedRootAuthorityNextPair(
        directory, paths, preparing,
        isCanonicalRecoveryElection(preparing) ? 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' : code,
      );
      fail('LOCK_INITIALIZATION_BUSY');
    }
    const descriptor = fs.openSync(next, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fsyncDirectory(directory);
  } else if (!nextMetadata && anchorMetadata) {
    fail(code);
  }
  const checkedNext = readRootAuthorityJson(next, paths, code, 2);
  const checkedAnchor = lstatIfPresent(anchor);
  if (!checkedAnchor || checkedAnchor.isSymbolicLink() || !checkedAnchor.isFile()
      || checkedAnchor.nlink !== 2 || checkedAnchor.dev !== checkedNext.metadata.dev
      || checkedAnchor.ino !== checkedNext.metadata.ino
      || JSON.stringify(checkedNext.value) !== JSON.stringify(nextValue)) fail(code);
  return nextValue;
}

function validateRootAuthorityPublishingStage(staging, paths, value, code = 'INVALID_LOCK_AUTHORITY') {
  requirePrivateDirectory(staging, code);
  const entries = fs.readdirSync(staging).sort();
  const allowed = new Set([AUTHORITY_FILE, ROOT_AUTHORITY_NEXT_FILE, ROOT_AUTHORITY_NEXT_ANCHOR]);
  if (!entries.every((name) => allowed.has(name))) fail(code);
  const next = ensureRootAuthorityNextPair(staging, paths, value, code);
  const authority = path.join(staging, AUTHORITY_FILE);
  if (!lstatIfPresent(authority)) {
    try { writeJsonExclusive(authority, value, staging); } catch (error) {
      if (!isRaceError(error)) throw error;
      const canonical = isCanonicalRecoveryElection(value);
      observeExpectedRootAuthorityFile(
        authority, paths, value, canonical ? 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' : code,
        { allowEmpty: canonical },
      );
      fail('LOCK_INITIALIZATION_BUSY');
    }
  }
  const authorityRecord = readRootAuthorityJson(authority, paths, code);
  if (JSON.stringify(authorityRecord.value) !== JSON.stringify(value)) fail(code);
  const finalEntries = fs.readdirSync(staging).sort();
  if (JSON.stringify(finalEntries) !== JSON.stringify([
    ROOT_AUTHORITY_NEXT_ANCHOR, ROOT_AUTHORITY_NEXT_FILE, AUTHORITY_FILE,
  ].sort())) fail(code);
  return next;
}

function publishRootAuthority(paths, value, stagingName = `.lock-authority-init-${crypto.randomUUID()}`) {
  if (!ROOT_AUTHORITY_STAGING_NAME.test(stagingName)) fail('INVALID_LOCK_ROOT');
  const staging = path.join(paths.configRoot, stagingName);
  if (!lstatIfPresent(staging)) {
    try { fs.mkdirSync(staging, { mode: 0o700 }); } catch (error) {
      if (!isRaceError(error)) throw error;
      const canonical = isCanonicalRecoveryElection(value, stagingName);
      observeRootAuthorityStageRace(
        staging, paths, value, canonical ? 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' : 'INVALID_LOCK_AUTHORITY',
        canonical,
      );
      fail('LOCK_INITIALIZATION_BUSY');
    }
    fsyncDirectory(paths.configRoot);
  }
  try {
    validateRootAuthorityPublishingStage(staging, paths, value);
    try {
      fs.renameSync(staging, paths.rootAuthorityDirectory);
      fsyncDirectory(paths.configRoot);
    } catch (error) {
      if (!error || !['EEXIST', 'ENOTEMPTY', 'ENOENT'].includes(error.code)
          || !lstatIfPresent(paths.rootAuthorityDirectory)) throw error;
      const published = parseRootAuthority(
        paths,
        isCanonicalRecoveryElection(value) ? 'RECOVERY_CONFIG_ROOT_NOT_EMPTY'
          : 'INVALID_LOCK_AUTHORITY',
      );
      if (JSON.stringify(published) !== JSON.stringify(value)) {
        fail(isCanonicalRecoveryElection(value)
          ? 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' : 'INVALID_LOCK_AUTHORITY');
      }
    }
  } catch (error) {
    throw error;
  }
  const published = parseRootAuthority(paths);
  if (JSON.stringify(published) !== JSON.stringify(value)) fail('LOCK_INITIALIZATION_BUSY');
  if (lstatIfPresent(staging)) {
    validateRootAuthorityPublishingStage(staging, paths, value);
    removeInitDirectory(staging);
  }
  return published;
}

function replaceRootAuthority(paths, expected, next) {
  const code = isCanonicalRecoveryElection(expected)
    ? 'RECOVERY_CONFIG_ROOT_NOT_EMPTY' : 'INVALID_LOCK_AUTHORITY';
  let inspected = inspectRootAuthority(paths);
  if (inspected.topology === 'complete') {
    if (JSON.stringify(inspected.value) === JSON.stringify(next)) return inspected.value;
    if (JSON.stringify(inspected.value) !== JSON.stringify(expected)) fail(code);
    ensureRootAuthorityNextPair(paths.rootAuthorityDirectory, paths, expected, code);
    inspected = inspectRootAuthority(paths, code);
  }
  if (inspected.topology === 'preparing-transition') {
    if (JSON.stringify(inspected.value) !== JSON.stringify(expected)
        || JSON.stringify(inspected.next.value) !== JSON.stringify(next)) {
      fail(code);
    }
    try {
      fs.renameSync(
        path.join(paths.rootAuthorityDirectory, ROOT_AUTHORITY_NEXT_FILE), paths.rootAuthority,
      );
    } catch (error) {
      if (!isRaceError(error)) throw error;
      const observed = inspectRootAuthority(paths, code);
      if (!['committed-transition', 'complete'].includes(observed.topology)
          || JSON.stringify(observed.value) !== JSON.stringify(next)) throw error;
      if (observed.topology === 'complete') return observed.value;
    }
    fsyncDirectory(paths.rootAuthorityDirectory);
    inspected = inspectRootAuthority(paths, code);
  }
  if (inspected.topology !== 'committed-transition'
      || JSON.stringify(inspected.value) !== JSON.stringify(next)) fail(code);
  try {
    fs.unlinkSync(path.join(paths.rootAuthorityDirectory, ROOT_AUTHORITY_NEXT_ANCHOR));
  } catch (error) {
    if (!isRaceError(error)) throw error;
    const observed = inspectRootAuthority(paths, code);
    if (observed.topology !== 'complete'
        || JSON.stringify(observed.value) !== JSON.stringify(next)) throw error;
    return observed.value;
  }
  fsyncDirectory(paths.rootAuthorityDirectory);
  return parseRootAuthority(paths, code);
}

function validateUnpublishedLockSet({ rcRoot, paths }) {
  const identity = readIdentity(paths);
  readAuthority(paths, identity);
  const Database = resolveDatabase(rcRoot);
  const operationDb = openExisting(Database, paths.operation);
  let runtimeDb = null;
  let failure;
  try {
    beginLock(operationDb, 'shared', 'OPERATION_LOCK_BUSY', identity);
    validateDatabase(operationDb, identity);
    runtimeDb = openExisting(Database, paths.runtime);
    beginLock(runtimeDb, 'shared', 'RUNTIME_LOCK_BUSY', identity);
    validateDatabase(runtimeDb, identity);
  } catch (error) {
    failure = error;
  }
  let releaseFailure;
  for (const database of [runtimeDb, operationDb]) {
    try { closeLock(database); } catch (error) { releaseFailure ??= error; }
  }
  if (failure) throw failure;
  if (releaseFailure) throw releaseFailure;
  return identity;
}

function ensureInitialized({
  rcRoot,
  configPath,
  externalStopVerified = false,
  initializationNames = null,
}) {
  const paths = resolveLockPaths(configPath, { initialize: true });
  const rootAuthority = lstatIfPresent(paths.rootAuthorityDirectory);
  const lockAuthority = lstatIfPresent(paths.locksRoot);
  if (rootAuthority) {
    const rootRecord = parseRootAuthority(paths);
    if (rootRecord.state === 'preparing') {
      if (!externalStopVerified) fail('EXTERNAL_STOP_PROOF_REQUIRED');
      const stagingRoot = path.join(paths.bootstrapRoot, rootRecord.stagingName);
      const staging = pathsForLocksRoot(paths, stagingRoot);
      const recoveryPaths = lockAuthority ? paths : staging;
      const identity = validateUnpublishedLockSet({ rcRoot, paths: recoveryPaths });
      if (identity.rootUuid !== rootRecord.rootUuid) fail('INVALID_LOCK_AUTHORITY');
      if (!lockAuthority) {
        fs.renameSync(stagingRoot, paths.locksRoot);
        fsyncDirectory(paths.bootstrapRoot);
      } else if (lstatIfPresent(stagingRoot)) {
        // The final lock set already exists, so any same-named staging path is
        // contradictory material rather than something safe to clean blindly.
        fail('INVALID_LOCK_AUTHORITY');
      }
      const committed = rootAuthorityValue(identity, 'committed', null);
      replaceRootAuthority(paths, rootRecord, committed);
    } else if (!lockAuthority) fail('LOCK_AUTHORITY_LOST');
    if (initializationNames) cleanupOrdinaryInitializationLoser({
      rcRoot, paths, initializationNames,
    });
    const held = acquireBootstrapLocks({
      rcRoot,
      configPath,
      operation: 'shared',
      runtime: 'shared',
      initialize: false,
    });
    try {
      return { paths: held.paths, identity: held.identity, created: false };
    } finally {
      held.release();
    }
  }
  if (!externalStopVerified) fail('EXTERNAL_STOP_PROOF_REQUIRED');
  if (lockAuthority) fail('LOCK_AUTHORITY_LOST');

  if (initializationNames !== null
      && (!initializationNames || typeof initializationNames !== 'object'
        || !STAGING_NAME.test(initializationNames.stagingName)
        || !ROOT_AUTHORITY_STAGING_NAME.test(initializationNames.rootAuthorityStagingName)
        || !UUID.test(initializationNames.rootUuid))) {
    fail('INVALID_LOCK_ROOT');
  }
  const stagingName = initializationNames?.stagingName || `.locks-init-${crypto.randomUUID()}`;
  const stagingUuid = stagingName.slice('.locks-init-'.length);
  const rootAuthorityStagingName = initializationNames?.rootAuthorityStagingName
    || `.lock-authority-init-${stagingUuid}`;
  const stagingRoot = path.join(paths.bootstrapRoot, stagingName);
  try { fs.mkdirSync(stagingRoot, { mode: 0o700 }); } catch (error) {
    if (!isRaceError(error)) throw error;
    if (!initializationNames) fail('INVALID_LOCK_ROOT');
    observeCanonicalPartialLockSet(stagingRoot, paths, initializationNames.rootUuid);
    fail('LOCK_INITIALIZATION_BUSY');
  }
  fsyncDirectory(paths.bootstrapRoot);
  const staging = pathsForLocksRoot(paths, stagingRoot);
  const Database = resolveDatabase(rcRoot);
  let candidateIdentity = null;
  try {
    const identity = createIdentity(staging, initializationNames?.rootUuid);
    candidateIdentity = identity;
    initializeDatabase(Database, staging.operation, identity);
    initializeDatabase(Database, staging.runtime, identity);
    try {
      writeJsonExclusive(staging.authority, authorityValue(identity), staging.locksRoot);
    } catch (error) {
      if (!error || !['EEXIST', 'ENOENT', 'ENOTEMPTY'].includes(error.code)
          || !initializationNames) throw error;
      const complete = observeExpectedLockAuthority(
        staging.authority, identity, { allowEmpty: true },
      );
      if (!complete) fail('LOCK_INITIALIZATION_BUSY');
    }
    fsyncDirectory(staging.locksRoot);
    publishRootAuthority(
      paths,
      rootAuthorityValue(identity, 'preparing', stagingName),
      rootAuthorityStagingName,
    );
    try {
      fs.renameSync(staging.locksRoot, paths.locksRoot);
    } catch (error) {
      if (!error || !['EEXIST', 'ENOENT', 'ENOTEMPTY'].includes(error.code)
          || !initializationNames) throw error;
      if (!lstatIfPresent(paths.locksRoot)) throw error;
      validateExactLockSetDirectory(paths.locksRoot);
      const publishedIdentity = validateUnpublishedLockSet({ rcRoot, paths });
      if (publishedIdentity.rootUuid !== identity.rootUuid) {
        fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
      }
      if (lstatIfPresent(staging.locksRoot)) {
        fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
      }
    }
    fsyncDirectory(paths.bootstrapRoot);
    replaceRootAuthority(
      paths,
      rootAuthorityValue(identity, 'preparing', stagingName),
      rootAuthorityValue(identity, 'committed', null),
    );
  } catch (error) {
    // Once the preparing marker exists, recovery must retain the exact staged
    // authority and finish it under a fresh external stop proof.
    if (initializationNames) {
      throw error;
    }
    if (!lstatIfPresent(paths.rootAuthorityDirectory)) removeInitDirectory(staging.locksRoot);
    else if (candidateIdentity) cleanupOrdinaryInitializationLoser({
      rcRoot,
      paths,
      initializationNames: {
        stagingName,
        rootAuthorityStagingName,
        rootUuid: candidateIdentity.rootUuid,
      },
    });
    throw error;
  }

  const held = acquireBootstrapLocks({
    rcRoot,
    configPath,
    operation: 'shared',
    runtime: 'shared',
    initialize: false,
  });
  try {
    return { paths: held.paths, identity: held.identity, created: true };
  } finally {
    held.release();
  }
}

function cleanupOrdinaryInitializationLoser({ rcRoot, paths, initializationNames }) {
  if (!initializationNames || !STAGING_NAME.test(initializationNames.stagingName)
      || !ROOT_AUTHORITY_STAGING_NAME.test(initializationNames.rootAuthorityStagingName)
      || !UUID.test(initializationNames.rootUuid)) return false;
  const stagingRoot = path.join(paths.bootstrapRoot, initializationNames.stagingName);
  const rootAuthorityStage = path.join(paths.configRoot, initializationNames.rootAuthorityStagingName);
  if (!lstatIfPresent(stagingRoot) && !lstatIfPresent(rootAuthorityStage)) return false;
  let winnerRecord = parseRootAuthority(paths);
  for (let attempt = 0; attempt < 100
    && (winnerRecord.state !== 'committed' || winnerRecord.stagingName !== null); attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    winnerRecord = parseRootAuthority(paths);
  }
  if (winnerRecord.rootUuid === initializationNames.rootUuid) return false;
  if (winnerRecord.state !== 'committed' || winnerRecord.stagingName !== null) {
    fail('INVALID_LOCK_AUTHORITY');
  }
  const winnerIdentity = validateUnpublishedLockSet({ rcRoot, paths });
  if (winnerIdentity.rootUuid !== winnerRecord.rootUuid) fail('INVALID_LOCK_AUTHORITY');
  const loserIdentity = {
    version: LOCK_VERSION,
    rootUuid: initializationNames.rootUuid,
    configBasename: paths.configBasename,
  };
  if (!lstatIfPresent(stagingRoot)) fail('INVALID_LOCK_AUTHORITY');
  validateExactLockSetDirectory(stagingRoot);
  const loserPaths = pathsForLocksRoot(paths, stagingRoot);
  const validated = validateUnpublishedLockSet({ rcRoot, paths: loserPaths });
  if (validated.rootUuid !== initializationNames.rootUuid
      || validated.configBasename !== paths.configBasename) fail('INVALID_LOCK_AUTHORITY');
  if (lstatIfPresent(rootAuthorityStage)) {
    validateRootAuthorityPublishingStage(
      rootAuthorityStage,
      paths,
      rootAuthorityValue(loserIdentity, 'preparing', initializationNames.stagingName),
    );
  }
  if (lstatIfPresent(stagingRoot)) removeInitDirectory(stagingRoot);
  if (lstatIfPresent(rootAuthorityStage)) removeInitDirectory(rootAuthorityStage);
  return true;
}

function initializeAfterConfigVolumeLoss({ rcRoot, configPath, externalStopVerified = false }) {
  if (!externalStopVerified) fail('EXTERNAL_STOP_PROOF_REQUIRED');
  if (typeof configPath !== 'string' || configPath.includes('\0') || !path.isAbsolute(configPath)) {
    fail('INVALID_LOCK_ROOT');
  }
  const configRoot = requirePrivateDirectory(path.dirname(path.normalize(configPath)));
  const configBasename = path.basename(configPath);
  const rootAuthorityPresent = lstatIfPresent(path.join(configRoot, ROOT_AUTHORITY_DIRECTORY));
  const locksPresent = lstatIfPresent(path.join(configRoot, '.rc-bootstrap', 'locks'));
  let recoveryMarkerNames = fs.readdirSync(configRoot)
    .filter((name) => VOLUME_LOSS_RECOVERY_NAME.test(name));
  if (rootAuthorityPresent && recoveryMarkerNames.length !== 1) {
    fail('LOCK_AUTHORITY_NOT_LOST');
  }
  if (!rootAuthorityPresent && locksPresent) fail('LOCK_AUTHORITY_NOT_LOST');
  if (!rootAuthorityPresent && recoveryMarkerNames.length > 0) {
    // Authenticate the complete unpublished topology before changing a byte.
    validateUnpublishedVolumeLossInitialization(configRoot, configBasename, rcRoot);
    cleanupUnpublishedVolumeLossInitialization(configRoot, configBasename, rcRoot);
    recoveryMarkerNames = [];
  }
  const initializationNames = prepareVolumeLossInitialization(configRoot, configBasename);
  if (rootAuthorityPresent) {
    const published = validateRecoverablePublishedVolumeLossInitialization(
      configRoot, configBasename, initializationNames,
    );
    if (published.authority.state === 'committed' && !lstatIfPresent(configPath)) {
      const identity = validateUnpublishedLockSet({ rcRoot, paths: published.lockPaths });
      cleanupPublishedVolumeLossInitialization(
        configRoot, configBasename, initializationNames,
      );
      return { paths: published.lockPaths, identity, created: true };
    }
  }

  // A physically replaced config volume cannot prove the old SQLite inode is
  // unlocked. T06 owns the external native/container stop proof; only this
  // explicit ABI may publish a replacement authority with the config file
  // absent. Ordinary acquire/recover remains fail-closed.
  const placeholder = path.join(configRoot, configBasename);
  ensureVolumeLossPlaceholder(configRoot, placeholder, initializationNames);
  try {
    const result = ensureInitialized({
      rcRoot,
      configPath: placeholder,
      externalStopVerified: true,
      initializationNames,
    });
    cleanupPublishedVolumeLossInitialization(
      configRoot, configBasename, initializationNames,
    );
    return { ...result, created: true };
  } catch (error) {
    // Before publication, an ordinary caught error may safely erase only the
    // exact artifacts authenticated by its recovery record. Once an outer
    // authority exists, all evidence remains durable for an explicit retry.
    if (error instanceof MaintenanceLeaseError && error.code === 'LOCK_INITIALIZATION_BUSY') {
      throw error;
    }
    if (error instanceof MaintenanceLeaseError
        && error.code === 'RECOVERY_CONFIG_ROOT_NOT_EMPTY') throw error;
    if (!lstatIfPresent(path.join(configRoot, ROOT_AUTHORITY_DIRECTORY))) {
      cleanupUnpublishedVolumeLossInitialization(configRoot, configBasename, rcRoot);
    }
    throw error;
  }
}

function unpublishedInitDirectoryName(name) {
  return STAGING_NAME.test(name) || ROOT_AUTHORITY_STAGING_NAME.test(name);
}

function requirePrivateRecoveryDirectory(target) {
  requirePrivateDirectory(target, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
}

function validateUnpublishedLocksStaging(target) {
  requirePrivateDirectory(target, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const allowed = new Set([
    'identity.json',
    'authority.json',
    'operation.sqlite',
    'operation.sqlite-journal',
    'runtime.sqlite',
    'runtime.sqlite-journal',
  ]);
  for (const name of fs.readdirSync(target)) {
    if (!allowed.has(name)) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    requirePrivateFile(path.join(target, name), 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
}

function validateCanonicalUnpublishedLocksStaging({ rcRoot, paths, recovery }) {
  const stagingRoot = path.join(paths.bootstrapRoot, recovery.stagingName);
  observeCanonicalPartialLockSet(stagingRoot, paths, recovery.rootUuid);
  const entries = fs.readdirSync(stagingRoot).sort();
  if (!entries.includes('identity.json')) return;
  const staging = pathsForLocksRoot(paths, stagingRoot);
  const identityMetadata = requirePrivateFile(
    staging.identity, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY',
  );
  if (identityMetadata.size === 0) return;
  let identity;
  try { identity = readIdentity(staging, recovery.rootUuid); } catch {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  if (entries.includes('operation.sqlite')) {
    const Database = resolveDatabase(rcRoot);
    const operation = openExisting(Database, staging.operation);
    try { validateDatabase(operation, identity); } catch {
      try { operation.close(); } catch {}
      fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    }
    operation.close();
  }
  if (entries.includes('runtime.sqlite')) {
    const Database = resolveDatabase(rcRoot);
    const runtime = openExisting(Database, staging.runtime);
    try { validateDatabase(runtime, identity); } catch {
      try { runtime.close(); } catch {}
      fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    }
    runtime.close();
  }
  if (entries.includes('authority.json')) {
    observeExpectedLockAuthority(staging.authority, identity, { allowEmpty: true });
  }
}

function validateExactLockSetDirectory(target) {
  requirePrivateDirectory(target, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const expected = ['authority.json', 'identity.json', 'operation.sqlite', 'runtime.sqlite'];
  const entries = fs.readdirSync(target).sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  for (const name of entries) {
    requirePrivateFile(path.join(target, name), 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
}

function validateRootAuthorityStaging(target, paths, recovery) {
  observeRootAuthorityStageRace(
    target,
    paths,
    rootAuthorityValue(recovery, 'preparing', recovery.stagingName),
    'RECOVERY_CONFIG_ROOT_NOT_EMPTY',
    true,
  );
}

function volumeLossRecoveryValue(recoveryMarkerName) {
  const match = VOLUME_LOSS_RECOVERY_NAME.exec(recoveryMarkerName);
  if (!match) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const initUuid = match[1];
  return {
    initUuid,
    recoveryMarkerName,
    stagingName: `.locks-init-${initUuid}`,
    rootAuthorityStagingName: `.lock-authority-init-${initUuid}`,
    placeholderStagingName: `.config-placeholder-${initUuid}`,
  };
}

function uuidFromDigest(bytes) {
  const hex = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) & 3];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function canonicalVolumeLossIdentity(configRoot, configBasename) {
  const metadata = fs.statSync(configRoot);
  if (!metadata.isDirectory() || !Number.isSafeInteger(metadata.dev)
      || !Number.isSafeInteger(metadata.ino) || metadata.ino < 1) fail('INVALID_LOCK_ROOT');
  const identity = `rc-bootstrap-volume-loss-v1\0${metadata.dev}\0${metadata.ino}\0${configBasename}`;
  return uuidFromDigest(identity);
}

function canonicalVolumeLossNames(configRoot, configBasename) {
  const initUuid = canonicalVolumeLossIdentity(configRoot, configBasename);
  return volumeLossRecoveryValue(`.rc-bootstrap-volume-loss-recovery-v1-${initUuid}`);
}

function stableRecoveryRecord(value, expected) {
  const keys = [
    'version', 'initUuid', 'recoveryMarkerName', 'stagingName', 'rootAuthorityStagingName',
    'placeholderStagingName', 'rootUuid', 'configBasename',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== keys.sort().join(',')
      || value.version !== 1
      || value.initUuid !== expected.initUuid
      || value.recoveryMarkerName !== expected.recoveryMarkerName
      || value.stagingName !== expected.stagingName
      || value.rootAuthorityStagingName !== expected.rootAuthorityStagingName
      || value.placeholderStagingName !== expected.placeholderStagingName
      || value.rootUuid !== expected.rootUuid
      || value.configBasename !== expected.configBasename
      || !UUID.test(value.rootUuid)
      || !STAGING_NAME.test(value.stagingName)
      || !ROOT_AUTHORITY_STAGING_NAME.test(value.rootAuthorityStagingName)
      || !VOLUME_LOSS_PLACEHOLDER_NAME.test(value.placeholderStagingName)) {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  return value;
}

function readPrivateJsonBounded(file, code = 'RECOVERY_CONFIG_ROOT_NOT_EMPTY') {
  const metadata = requirePrivateFile(file, code);
  if (metadata.size < 2 || metadata.size > 4096) fail(code);
  let bytes;
  try { bytes = fs.readFileSync(file, 'utf8'); } catch { fail(code); }
  const after = requirePrivateFile(file, code);
  if (metadata.dev !== after.dev || metadata.ino !== after.ino || metadata.size !== after.size) fail(code);
  try { return JSON.parse(bytes); } catch { fail(code); }
}

function readVolumeLossRecoveryMarker(configRoot, markerName, configBasename) {
  const marker = path.join(configRoot, markerName);
  requirePrivateRecoveryDirectory(marker);
  const entries = fs.readdirSync(marker).sort();
  if (!entries.every((name) => [VOLUME_LOSS_RECOVERY_FILE, VOLUME_LOSS_PLACEHOLDER_FILE].includes(name))
      || !entries.includes(VOLUME_LOSS_RECOVERY_FILE)) {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  const derived = volumeLossRecoveryValue(markerName);
  const record = readPrivateJsonBounded(path.join(marker, VOLUME_LOSS_RECOVERY_FILE));
  stableRecoveryRecord(record, {
    ...derived,
    rootUuid: record?.rootUuid,
    configBasename,
  });
  return { ...record, marker, entries };
}

function readVolumeLossRecoveryStage(configRoot, stageName, configBasename) {
  const match = VOLUME_LOSS_RECOVERY_STAGING_NAME.exec(stageName);
  if (!match) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const markerName = `.rc-bootstrap-volume-loss-recovery-v1-${match[1]}`;
  const staging = path.join(configRoot, stageName);
  requirePrivateRecoveryDirectory(staging);
  const entries = fs.readdirSync(staging).sort();
  if (!entries.every((name) => name === VOLUME_LOSS_RECOVERY_FILE)) {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  const names = volumeLossRecoveryValue(markerName);
  if (entries.length === 0) {
    return {
      ...names,
      rootUuid: names.initUuid,
      configBasename,
      marker: path.join(configRoot, markerName),
      staging,
      stageName,
      entries,
    };
  }
  const record = readPrivateJsonBounded(path.join(staging, VOLUME_LOSS_RECOVERY_FILE));
  stableRecoveryRecord(record, { ...names, rootUuid: names.initUuid, configBasename });
  return { ...record, marker: path.join(configRoot, markerName), staging, stageName, entries };
}

function stablePlaceholderRecord(value, recovery) {
  const keys = ['version', 'rootUuid', 'configBasename', 'dev', 'ino', 'uid'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== keys.sort().join(',')
      || value.version !== 1 || value.rootUuid !== recovery.rootUuid
      || value.configBasename !== recovery.configBasename
      || !Number.isSafeInteger(value.dev) || value.dev < 0
      || !Number.isSafeInteger(value.ino) || value.ino < 1
      || !Number.isSafeInteger(value.uid) || value.uid < 0) {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  return value;
}

function readVolumeLossPlaceholderRecord(recovery) {
  if (!fs.readdirSync(recovery.marker).includes(VOLUME_LOSS_PLACEHOLDER_FILE)) {
    fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  }
  return stablePlaceholderRecord(readPrivateJsonBounded(
    path.join(recovery.marker, VOLUME_LOSS_PLACEHOLDER_FILE),
  ), recovery);
}

function requireExactVolumeLossPlaceholder(configRoot, recovery) {
  const placeholder = path.join(configRoot, recovery.configBasename);
  const metadata = requirePrivateFile(placeholder, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const record = readVolumeLossPlaceholderRecord(recovery);
  if (metadata.size !== 0 || metadata.dev !== record.dev || metadata.ino !== record.ino
      || metadata.uid !== record.uid) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  return placeholder;
}

function validateUnpublishedVolumeLossInitialization(configRoot, configBasename, rcRoot = null) {
  const entries = fs.readdirSync(configRoot).sort();
  const markerNames = entries.filter((name) => VOLUME_LOSS_RECOVERY_NAME.test(name));
  if (markerNames.length !== 1) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const recovery = readVolumeLossRecoveryMarker(configRoot, markerNames[0], configBasename);
  const allowed = new Set([recovery.recoveryMarkerName]);
  const bootstrapRoot = path.join(configRoot, '.rc-bootstrap');
  if (entries.includes('.rc-bootstrap')) {
    requirePrivateDirectory(bootstrapRoot, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    const bootstrapEntries = fs.readdirSync(bootstrapRoot).sort();
    if (!bootstrapEntries.every((name) => name === recovery.stagingName)) {
      fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    }
    for (const name of bootstrapEntries) {
      if (rcRoot && name === recovery.stagingName) {
        validateCanonicalUnpublishedLocksStaging({
          rcRoot,
          paths: {
            configRoot,
            configBasename,
            bootstrapRoot,
          },
          recovery,
        });
      } else {
        validateUnpublishedLocksStaging(path.join(bootstrapRoot, name));
      }
    }
    allowed.add('.rc-bootstrap');
  }
  for (const name of entries) {
    if (name !== recovery.rootAuthorityStagingName) continue;
    validateRootAuthorityStaging(path.join(configRoot, name), {
      configRoot,
      configBasename,
    }, recovery);
    allowed.add(name);
  }
  const forbiddenRecordedStaging = entries.some((name) => (
    (STAGING_NAME.test(name) || ROOT_AUTHORITY_STAGING_NAME.test(name))
      && !allowed.has(name)
  ));
  if (forbiddenRecordedStaging) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  if (entries.includes(configBasename)) {
    requireExactVolumeLossPlaceholder(configRoot, recovery);
    allowed.add(configBasename);
  }
  if (entries.includes(recovery.placeholderStagingName)) {
    requireExactVolumeLossPlaceholderAt(
      path.join(configRoot, recovery.placeholderStagingName), recovery,
    );
    allowed.add(recovery.placeholderStagingName);
  }
  if (!entries.every((name) => allowed.has(name))) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  return { entries, recovery };
}

function cleanupUnpublishedVolumeLossInitialization(configRoot, configBasename, rcRoot = null) {
  const { entries, recovery } = validateUnpublishedVolumeLossInitialization(
    configRoot, configBasename, rcRoot,
  );
  // Keep the authenticated marker until every other exact artifact is gone.
  // A crash during cleanup therefore leaves enough evidence for a retry.
  const ordered = entries.filter((name) => name !== recovery.recoveryMarkerName).sort((left, right) => {
    const priority = (name) => name === configBasename || name === recovery.placeholderStagingName
      ? 0 : name === '.rc-bootstrap' || ROOT_AUTHORITY_STAGING_NAME.test(name) ? 1 : 2;
    return priority(left) - priority(right);
  });
  for (const name of ordered) {
    const target = path.join(configRoot, name);
    if (name === '.rc-bootstrap') {
      for (const child of fs.readdirSync(target)) {
        removeInitDirectory(path.join(target, child));
      }
      removeInitDirectory(target);
    } else if (unpublishedInitDirectoryName(name)) {
      removeInitDirectory(target);
    } else if (name === configBasename) {
      fs.unlinkSync(target);
      fsyncDirectory(configRoot);
    } else if (name === recovery.placeholderStagingName) {
      fs.unlinkSync(target);
      fsyncDirectory(configRoot);
    }
  }
  removeVolumeLossRecoveryMarker(configRoot, recovery.recoveryMarkerName);
}

function createVolumeLossRecoveryMarker(configRoot, markerName) {
  const marker = path.join(configRoot, markerName);
  const names = volumeLossRecoveryValue(markerName);
  const stagingName = `.rc-bootstrap-volume-loss-recovery-stage-v1-${names.initUuid}`;
  if (!VOLUME_LOSS_RECOVERY_STAGING_NAME.test(stagingName)) fail('INVALID_LOCK_ROOT');
  const staging = path.join(configRoot, stagingName);
  if (!lstatIfPresent(staging)) {
    try {
      fs.mkdirSync(staging, { mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(staging, 0o700);
      fsyncDirectory(configRoot);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      requirePrivateRecoveryDirectory(staging);
      const entries = fs.readdirSync(staging).sort();
      if (!entries.every((name) => name === VOLUME_LOSS_RECOVERY_FILE)) {
        fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
      }
    }
  }
  const record = {
    version: 1,
    ...names,
    rootUuid: names.initUuid,
    configBasename: null,
  };
  try {
    return { marker, staging, record };
  } catch (error) {
    removeInitDirectory(staging);
    throw error;
  }
}

function publishVolumeLossRecoveryMarker(configRoot, markerName, configBasename) {
  const prepared = createVolumeLossRecoveryMarker(configRoot, markerName);
  prepared.record.configBasename = configBasename;
  try {
    const recordFile = path.join(prepared.staging, VOLUME_LOSS_RECOVERY_FILE);
    try {
      if (!lstatIfPresent(recordFile)) {
        try {
          writeJsonExclusive(recordFile, prepared.record, prepared.staging);
        } catch (error) {
          if (error && error.code === 'EEXIST') {
            const recordMetadata = requirePrivateFile(
              recordFile, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY',
            );
            if (recordMetadata.size === 0) {
              completeCanonicalEmptyFile(
                recordFile,
                Buffer.from(`${JSON.stringify(prepared.record, null, 2)}\n`),
                prepared.staging,
                'RECOVERY_CONFIG_ROOT_NOT_EMPTY',
              );
            }
            const contender = readVolumeLossRecoveryStage(
              configRoot, path.basename(prepared.staging), configBasename,
            );
            if (contender.entries.length === 0) fail('LOCK_INITIALIZATION_BUSY');
            if (contender.rootUuid !== prepared.record.rootUuid) {
              fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
            }
            fail('LOCK_INITIALIZATION_BUSY');
          }
          throw error;
        }
      } else {
        const current = readVolumeLossRecoveryStage(
          configRoot, path.basename(prepared.staging), configBasename,
        );
        if (current.rootUuid !== prepared.record.rootUuid) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT' || !lstatIfPresent(prepared.marker)) throw error;
      return readVolumeLossRecoveryMarker(configRoot, markerName, configBasename);
    }
    try {
      fs.renameSync(prepared.staging, prepared.marker);
      fsyncDirectory(configRoot);
    } catch (error) {
      if (!error || !['EEXIST', 'ENOTEMPTY', 'ENOENT'].includes(error.code)
          || !lstatIfPresent(prepared.marker)) throw error;
      const winner = readVolumeLossRecoveryMarker(configRoot, markerName, configBasename);
      if (lstatIfPresent(prepared.staging)) {
        const contender = readVolumeLossRecoveryStage(
          configRoot, path.basename(prepared.staging), configBasename,
        );
        if (contender.rootUuid !== winner.rootUuid) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
        removeInitDirectory(prepared.staging);
      }
    }
  } catch (error) {
    throw error;
  }
  return readVolumeLossRecoveryMarker(configRoot, markerName, configBasename);
}

function prepareVolumeLossInitialization(configRoot, configBasename) {
  const entries = fs.readdirSync(configRoot).sort();
  const canonical = canonicalVolumeLossNames(configRoot, configBasename);
  const markerNames = entries.filter((name) => VOLUME_LOSS_RECOVERY_NAME.test(name));
  const stageNames = entries.filter((name) => VOLUME_LOSS_RECOVERY_STAGING_NAME.test(name));
  if (markerNames.length === 1) {
    if (markerNames[0] !== canonical.recoveryMarkerName || stageNames.length > 1
        || (stageNames.length === 1
          && stageNames[0] !== `.rc-bootstrap-volume-loss-recovery-stage-v1-${canonical.initUuid}`)) {
      fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    }
    const recovery = readVolumeLossRecoveryMarker(configRoot, markerNames[0], configBasename);
    if (stageNames.length === 1) {
      const staged = readVolumeLossRecoveryStage(configRoot, stageNames[0], configBasename);
      if (staged.entries.length > 0 && staged.rootUuid !== recovery.rootUuid) {
        fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
      }
      removeInitDirectory(staged.staging);
    }
    return recovery;
  }
  if (markerNames.length > 1 || stageNames.length > 1) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  if (stageNames.length === 1) {
    const expectedStage = `.rc-bootstrap-volume-loss-recovery-stage-v1-${canonical.initUuid}`;
    if (stageNames[0] !== expectedStage || entries.length !== 1) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    const staging = path.join(configRoot, expectedStage);
    requirePrivateRecoveryDirectory(staging);
    const stagedEntries = fs.readdirSync(staging).sort();
    if (JSON.stringify(stagedEntries) === JSON.stringify([VOLUME_LOSS_RECOVERY_FILE])) {
      const recordFile = path.join(staging, VOLUME_LOSS_RECOVERY_FILE);
      const metadata = requirePrivateFile(recordFile, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
      if (metadata.size === 0) {
        const record = {
          version: 1,
          ...canonical,
          rootUuid: canonical.initUuid,
          configBasename,
        };
        completeCanonicalEmptyFile(
          recordFile,
          Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
          staging,
          'RECOVERY_CONFIG_ROOT_NOT_EMPTY',
        );
      }
    }
    readVolumeLossRecoveryStage(configRoot, stageNames[0], configBasename);
    return publishVolumeLossRecoveryMarker(
      configRoot, canonical.recoveryMarkerName, configBasename,
    );
  }
  if (entries.length !== 0) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  return publishVolumeLossRecoveryMarker(
    configRoot, canonical.recoveryMarkerName, configBasename,
  );
}

function placeholderIdentity(metadata, recovery) {
  return {
    version: 1,
    rootUuid: recovery.rootUuid,
    configBasename: recovery.configBasename,
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
  };
}

function requireExactVolumeLossPlaceholderAt(file, recovery) {
  const metadata = requirePrivateFile(file, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const record = readVolumeLossPlaceholderRecord(recovery);
  if (metadata.size !== 0 || metadata.dev !== record.dev || metadata.ino !== record.ino
      || metadata.uid !== record.uid) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  return file;
}

function ensureVolumeLossPlaceholder(configRoot, placeholder, recovery) {
  const placeholderRecord = path.join(recovery.marker, VOLUME_LOSS_PLACEHOLDER_FILE);
  const staged = path.join(configRoot, recovery.placeholderStagingName);
  const hasRecord = lstatIfPresent(placeholderRecord);
  if (hasRecord) {
    if (lstatIfPresent(placeholder)) return requireExactVolumeLossPlaceholder(configRoot, recovery);
    requireExactVolumeLossPlaceholderAt(staged, recovery);
    fs.renameSync(staged, placeholder);
    fsyncDirectory(configRoot);
    return requireExactVolumeLossPlaceholder(configRoot, recovery);
  }
  if (lstatIfPresent(placeholder) || lstatIfPresent(staged)) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  let descriptor;
  try {
    descriptor = fs.openSync(staged, 'wx', 0o600);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    const metadata = requirePrivateFile(staged, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    if (metadata.size !== 0) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    const after = lstatIfPresent(staged);
    if (!after || after.dev !== metadata.dev || after.ino !== metadata.ino
        || after.size !== 0 || after.nlink !== 1) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    // A same-election contender may be creating the canonical placeholder.
    // Observe only a fully authenticated result; never delete or replace it.
    for (let attempt = 0; attempt < 100 && !lstatIfPresent(placeholderRecord); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    if (!lstatIfPresent(placeholderRecord)) fail('LOCK_INITIALIZATION_BUSY');
    if (lstatIfPresent(placeholder)) return requireExactVolumeLossPlaceholder(configRoot, recovery);
    requireExactVolumeLossPlaceholderAt(staged, recovery);
    try {
      fs.renameSync(staged, placeholder);
      fsyncDirectory(configRoot);
    } catch (renameError) {
      if (!renameError || !['EEXIST', 'ENOENT'].includes(renameError.code)
          || !lstatIfPresent(placeholder)) throw renameError;
    }
    return requireExactVolumeLossPlaceholder(configRoot, recovery);
  }
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  if (process.platform !== 'win32') fs.chmodSync(staged, 0o600);
  fsyncDirectory(configRoot);
  const metadata = requirePrivateFile(staged, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  writeJsonExclusive(placeholderRecord, placeholderIdentity(metadata, recovery), recovery.marker);
  fs.renameSync(staged, placeholder);
  fsyncDirectory(configRoot);
  return requireExactVolumeLossPlaceholder(configRoot, recovery);
}

function validateRecoverablePublishedVolumeLossInitialization(
  configRoot, configBasename, recovery,
) {
  const entries = fs.readdirSync(configRoot).sort();
  const allowed = new Set([
    recovery.recoveryMarkerName,
    '.rc-bootstrap',
    ROOT_AUTHORITY_DIRECTORY,
  ]);
  const placeholderPresent = entries.includes(configBasename);
  if (placeholderPresent) {
    requireExactVolumeLossPlaceholder(configRoot, recovery);
    allowed.add(configBasename);
  }
  if (entries.includes(recovery.placeholderStagingName)) {
    requireExactVolumeLossPlaceholderAt(
      path.join(configRoot, recovery.placeholderStagingName), recovery,
    );
    allowed.add(recovery.placeholderStagingName);
  }
  if (!entries.every((name) => allowed.has(name))) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');

  const base = {
    configRoot,
    configPath: path.join(configRoot, configBasename),
    configBasename,
    bootstrapRoot: path.join(configRoot, '.rc-bootstrap'),
    locksRoot: path.join(configRoot, '.rc-bootstrap', 'locks'),
    rootAuthorityDirectory: path.join(configRoot, ROOT_AUTHORITY_DIRECTORY),
    rootAuthority: path.join(configRoot, ROOT_AUTHORITY_DIRECTORY, AUTHORITY_FILE),
  };
  requirePrivateDirectory(base.bootstrapRoot, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  requirePrivateDirectory(base.rootAuthorityDirectory, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const inspectedAuthority = inspectRootAuthority(base, 'RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const authority = inspectedAuthority.value;
  if (authority.rootUuid !== recovery.rootUuid
      || authority.configBasename !== configBasename) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const bootstrapEntries = fs.readdirSync(base.bootstrapRoot).sort();
  const stagingRoot = path.join(base.bootstrapRoot, recovery.stagingName);
  let lockPaths;
  if (authority.state === 'preparing') {
    if (authority.stagingName !== recovery.stagingName || !placeholderPresent
        || !bootstrapEntries.every((name) => ['locks', recovery.stagingName].includes(name))
        || bootstrapEntries.length !== 1) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    const locksRoot = bootstrapEntries[0] === 'locks' ? base.locksRoot : stagingRoot;
    validateExactLockSetDirectory(locksRoot);
    lockPaths = pathsForLocksRoot(base, locksRoot);
    const identity = readIdentity(lockPaths);
    readAuthority(lockPaths, identity);
    if (identity.rootUuid !== recovery.rootUuid) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  } else {
    if (authority.state !== 'committed' || authority.stagingName !== null
        || bootstrapEntries.length !== 1 || bootstrapEntries[0] !== 'locks'
        || lstatIfPresent(stagingRoot)) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    validateExactLockSetDirectory(base.locksRoot);
    lockPaths = pathsForLocksRoot(base, base.locksRoot);
    const identity = readIdentity(lockPaths);
    readAuthority(lockPaths, identity);
    if (identity.rootUuid !== recovery.rootUuid) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
    if (!placeholderPresent && fs.readdirSync(recovery.marker).includes(VOLUME_LOSS_PLACEHOLDER_FILE)) {
      readVolumeLossPlaceholderRecord(recovery);
    }
  }
  return { authority, lockPaths };
}

function cleanupPublishedVolumeLossInitialization(configRoot, configBasename, recovery) {
  const { authority } = validateRecoverablePublishedVolumeLossInitialization(
    configRoot, configBasename, recovery,
  );
  if (authority.state !== 'committed') fail('INVALID_LOCK_AUTHORITY');
  const placeholder = path.join(configRoot, configBasename);
  if (lstatIfPresent(placeholder)) {
    requireExactVolumeLossPlaceholder(configRoot, recovery);
    fs.unlinkSync(placeholder);
    fsyncDirectory(configRoot);
  }
  removeVolumeLossRecoveryMarker(configRoot, recovery.recoveryMarkerName);
}

function removeVolumeLossRecoveryMarker(configRoot, markerName) {
  if (!VOLUME_LOSS_RECOVERY_NAME.test(markerName)) fail('RECOVERY_CONFIG_ROOT_NOT_EMPTY');
  const marker = path.join(configRoot, markerName);
  requirePrivateRecoveryDirectory(marker);
  removeInitDirectory(marker);
}

function removeInitDirectory(target) {
  const metadata = lstatIfPresent(target);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('INVALID_LOCK_ROOT');
  fs.rmSync(target, { recursive: true, force: true });
  fsyncDirectory(path.dirname(target));
}

function writeJsonExclusive(file, value, parent) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  fsyncDirectory(parent);
}

function stableContext({ rcRoot, configPath, initialize = true, allowConfigAbsent = false }) {
  if (initialize) fail('EXPLICIT_LOCK_INITIALIZATION_REQUIRED');
  const paths = resolveLockPaths(configPath, { initialize: false, allowConfigAbsent });
  const identity = readIdentity(paths);
  readAuthority(paths, identity);
  readRootAuthority(paths, identity);
  const Database = resolveDatabase(rcRoot);
  return { paths, identity, Database };
}

function beginLock(database, mode, code, identity) {
  const statement = mode === 'shared' ? 'BEGIN DEFERRED'
    : mode === 'reserved' ? 'BEGIN IMMEDIATE' : 'BEGIN EXCLUSIVE';
  try {
    database.exec(statement);
    const row = database.prepare(
      'SELECT version, root_uuid, config_basename FROM rc_lock_identity WHERE singleton=1',
    ).get();
    if (!row || row.version !== LOCK_VERSION || row.root_uuid !== identity.rootUuid
        || row.config_basename !== identity.configBasename || !database.inTransaction) {
      fail('LOCK_IDENTITY_MISMATCH');
    }
  } catch (error) {
    try { if (database.inTransaction) database.exec('ROLLBACK'); } catch {}
    try { database.close(); } catch {}
    mapSqliteError(error, code);
  }
}

function closeLock(database) {
  if (!database || !database.open) return;
  let failure;
  try {
    if (database.inTransaction) database.exec('ROLLBACK');
  } catch (error) {
    failure = error;
  }
  try { database.close(); } catch (error) { failure ??= error; }
  if (failure) fail('LOCK_RELEASE_FAILED');
}

function acquireBootstrapLocks({
  rcRoot,
  configPath,
  operation = 'exclusive',
  runtime = null,
  initialize = false,
  allowConfigAbsent = false,
}) {
  if (!['shared', 'exclusive'].includes(operation)
      || (runtime !== null && !['shared', 'reserved', 'exclusive'].includes(runtime))) {
    fail('INVALID_LEASE_MODE');
  }
  const context = stableContext({ rcRoot, configPath, initialize, allowConfigAbsent });
  const operationDb = openExisting(context.Database, context.paths.operation);
  beginLock(operationDb, operation, 'OPERATION_LOCK_BUSY', context.identity);
  try {
    validateDatabase(operationDb, context.identity);
  } catch (error) {
    closeLock(operationDb);
    throw error;
  }
  let runtimeDb = null;
  try {
    if (runtime !== null) {
      runtimeDb = openExisting(context.Database, context.paths.runtime);
      beginLock(runtimeDb, runtime, 'RUNTIME_LOCK_BUSY', context.identity);
      try {
        validateDatabase(runtimeDb, context.identity);
      } catch (error) {
        closeLock(runtimeDb);
        runtimeDb = null;
        throw error;
      }
    }
  } catch (error) {
    closeLock(operationDb);
    throw error;
  }
  let released = false;
  return {
    paths: context.paths,
    identity: { ...context.identity },
    operation,
    runtime,
    assertHeld() {
      if (released || (operationDb.open && !operationDb.inTransaction)
          || (runtimeDb && (!runtimeDb.open || !runtimeDb.inTransaction))) fail('BOOTSTRAP_LOCK_NOT_HELD');
      if (!operationDb.open && !runtimeDb?.open) fail('BOOTSTRAP_LOCK_NOT_HELD');
      if (operationDb.open) operationDb.prepare('SELECT singleton FROM rc_lock_identity WHERE singleton=1').get();
      runtimeDb?.prepare('SELECT singleton FROM rc_lock_identity WHERE singleton=1').get();
      return true;
    },
    releaseOperation() {
      if (!operationDb.open) return false;
      closeLock(operationDb);
      return true;
    },
    release() {
      if (released) return false;
      released = true;
      let failure;
      for (const database of [runtimeDb, operationDb]) {
        try { closeLock(database); } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
      return true;
    },
  };
}

async function withBootstrapLocks(options, operation) {
  const held = acquireBootstrapLocks(options);
  try {
    return await operation(held);
  } finally {
    held.release();
  }
}

module.exports = {
  MaintenanceLeaseError,
  acquireBootstrapLocks,
  ensureInitialized,
  initializeAfterConfigVolumeLoss,
  withBootstrapLocks,
};
