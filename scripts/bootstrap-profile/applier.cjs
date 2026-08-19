'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MAX_CAPSULE_BYTES, validateCapsuleBytes } = require('./schema.cjs');
const { jobsDigest } = require('./cron-digest.cjs');
const { withBootstrapLocks } = require('./maintenance-lease.cjs');
const {
  assertCanonicalAuthSecretPlacement,
  assertNoUnexpectedStateSecretCopies,
} = require('./secret-copy-scan.cjs');
const {
  ensureDirectory,
  fsyncDirectory,
  readJson,
  readPrivateFile,
  readPrivateFileRecord,
  readPrivateJson,
  reconcileStagedJsonAuthority,
  removePath,
  restorePath,
  sha256,
  snapshotPath,
  verifySnapshot,
  writeBytesAtomic,
  writeBytesExclusiveDurable,
  writeJsonAtomic,
  writeJsonStagedNoReplace,
  unlinkPrivateFileRecord,
} = require('./storage.cjs');

const VOLUMES = ['config', 'workspace', 'state', 'data'];
const AUTH_LOCK_OPTIONS = {
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
  stale: 30_000,
};
const CRON_WORKER_LIMIT = 10 * 1024 * 1024;
function cronWorkerTimeoutMs(platform = process.platform) {
  return platform === 'win32' ? 120_000 : 30_000;
}
const CRON_WORKER_TIMEOUT_MS = cronWorkerTimeoutMs();
const CRON_WORKER_EXIT_TIMEOUT_MS = 30_000;
const CRON_WORKER_LIFECYCLE_MAX_BYTES = 2 * 1024 * 1024;
const CRON_WORKER_LIFECYCLE_CREATE_SQL = `CREATE TABLE rc_cron_worker_epoch (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 1),
      tx_id TEXT NOT NULL,
      epoch TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('idle', 'active')),
      authority TEXT NOT NULL
    )`;
const AUTH_STORE_MAX_BYTES = 2 * 1024 * 1024;
const LIVE_CONFIG_MAX_BYTES = 2 * 1024 * 1024;
const STAGE_PUBLICATION_PREFIX = '.rc-bootstrap-stage-v1-';
const STAGE_PUBLICATION_NAME = /^\.rc-bootstrap-stage-v1-(tx-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{64})-([0-9a-f]{64})$/;
const activeCronWorkers = new Set();
const cronSignalHandlers = new Map();

class BootstrapProfileTransactionError extends Error {
  constructor(code) {
    super('Bootstrap Profile transaction failed');
    this.name = 'BootstrapProfileTransactionError';
    this.code = code;
  }
}

function fail(code) {
  throw new BootstrapProfileTransactionError(code);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function valueHash(value) {
  return sha256(Buffer.from(stableJson(value)));
}

function equal(a, b) {
  return stableJson(a) === stableJson(b);
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertAbsolute(value, code = 'INVALID_PATH') {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) fail(code);
  return path.normalize(value);
}

function assertDirectory(target, code = 'UNSAFE_PATH') {
  const metadata = lstatIfPresent(target);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) fail(code);
  return fs.realpathSync(target);
}

function normalizeRecoverableDirectory(target) {
  const metadata = lstatIfPresent(target);
  if (metadata) return assertDirectory(target);
  const missing = [];
  let current = target;
  while (!lstatIfPresent(current)) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) fail('UNSAFE_PATH');
    current = parent;
  }
  const ancestor = assertDirectory(current);
  return path.join(ancestor, ...missing);
}

function assertExistingFileSafe(target, {
  allowAbsent = true, allowHardlink = false, code = 'UNSAFE_PATH',
} = {}) {
  const metadata = lstatIfPresent(target);
  if (!metadata) {
    if (allowAbsent) return;
    fail('UNSAFE_PATH');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || (!allowHardlink && metadata.nlink !== 1)) fail(code);
}

function assertSnapshotTargetSafe(target, { allowHardlink = false } = {}) {
  const metadata = lstatIfPresent(target);
  if (!metadata) return;
  if (metadata.isSymbolicLink()) fail('UNSAFE_PATH');
  if (metadata.isFile()) {
    if (!allowHardlink && metadata.nlink !== 1) fail('UNSAFE_PATH');
    return;
  }
  if (!metadata.isDirectory()) fail('UNSAFE_PATH');
  for (const name of fs.readdirSync(target)) {
    assertSnapshotTargetSafe(path.join(target, name), { allowHardlink: false });
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(root, target, code = 'UNSAFE_PATH') {
  if (!isInside(root, target)) fail('PATH_ESCAPE');
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const metadata = lstatIfPresent(current);
    if (!metadata) break;
    if (metadata.isSymbolicLink()) fail(code);
  }
}

function normalizePaths(options, { recovery = false, stagedPrecondition = false } = {}) {
  const raw = {
    rcRoot: assertAbsolute(options.rcRoot),
    configPath: assertAbsolute(options.configPath),
    workspace: assertAbsolute(options.workspace),
    stateDir: assertAbsolute(options.stateDir),
    dbPath: assertAbsolute(options.dbPath),
    globalConfigPath: assertAbsolute(options.globalConfigPath),
  };
  const roots = {
    rcRoot: assertDirectory(raw.rcRoot),
    config: recovery
      ? normalizeRecoverableDirectory(path.dirname(raw.configPath))
      : assertDirectory(path.dirname(raw.configPath)),
    workspace: assertDirectory(raw.workspace),
    state: assertDirectory(raw.stateDir),
    data: assertDirectory(path.dirname(raw.dbPath)),
  };
  if (!isInside(raw.stateDir, raw.globalConfigPath)) fail('PATH_ESCAPE');
  const normalized = {
    rcRoot: roots.rcRoot,
    configPath: path.join(roots.config, path.basename(raw.configPath)),
    workspace: roots.workspace,
    stateDir: roots.state,
    dbPath: path.join(roots.data, path.basename(raw.dbPath)),
    globalConfigPath: path.join(roots.state, path.relative(raw.stateDir, raw.globalConfigPath)),
  };
  if (!isInside(roots.state, normalized.globalConfigPath)) fail('PATH_ESCAPE');
  const targetSafetyCode = stagedPrecondition ? 'STAGED_PRECONDITION_CHANGED' : 'UNSAFE_PATH';
  for (const target of [
    normalized.configPath,
    normalized.globalConfigPath,
    normalized.dbPath,
    `${normalized.dbPath}-wal`,
    `${normalized.dbPath}-shm`,
    path.join(normalized.stateDir, 'agents/main/agent/auth-profiles.json'),
    path.join(normalized.stateDir, 'state/openclaw.sqlite'),
    path.join(normalized.stateDir, 'state/openclaw.sqlite-wal'),
    path.join(normalized.stateDir, 'state/openclaw.sqlite-shm'),
  ]) {
    const root = isInside(roots.state, target) ? roots.state
      : isInside(roots.data, target) ? roots.data : roots.config;
    assertNoSymlinkComponents(root, target, targetSafetyCode);
    assertExistingFileSafe(target, { code: targetSafetyCode });
  }
  assertExistingFileSafe(normalized.configPath, {
    allowAbsent: recovery, code: targetSafetyCode,
  });
  return { ...normalized, roots };
}

function pathsHash(paths) {
  return valueHash({
    rcRoot: paths.rcRoot,
    configPath: paths.configPath,
    workspace: paths.workspace,
    stateDir: paths.stateDir,
    dbPath: paths.dbPath,
    globalConfigPath: paths.globalConfigPath,
  });
}

function bootstrapRoot(paths) {
  return path.join(paths.roots.config, '.rc-bootstrap');
}

function receiptPath(paths) {
  return path.join(bootstrapRoot(paths), 'receipt.json');
}

function suspensionsPath(paths) {
  return path.join(bootstrapRoot(paths), 'peripheral-suspensions.json');
}

function transactionsRoot(paths) {
  return path.join(bootstrapRoot(paths), 'transactions');
}

function committedCleanupRoot(paths) {
  return path.join(bootstrapRoot(paths), 'committed-cleanup');
}

function committedCleanupIntentPath(paths, txId) {
  if (typeof txId !== 'string' || !/^tx-[0-9a-f-]{36}$/.test(txId)) fail('INVALID_TRANSACTION_ID');
  return path.join(committedCleanupRoot(paths), `${txId}.json`);
}

function txRoot(paths, txId) {
  if (typeof txId !== 'string' || !/^tx-[0-9a-f-]{36}$/.test(txId)) fail('INVALID_TRANSACTION_ID');
  return path.join(transactionsRoot(paths), txId);
}

function preparedCommittedCleanupIntentPath(paths, txId) {
  return path.join(txRoot(paths, txId), `committed-cleanup-intent-${txId}.json`);
}

function manifestPath(paths, txId) {
  return path.join(txRoot(paths, txId), 'manifest.json');
}

function stagePublicationName(txId, capsuleDigest, expectedPathsHash) {
  if (typeof txId !== 'string' || !/^tx-[0-9a-f-]{36}$/.test(txId)
      || !/^[0-9a-f]{64}$/.test(capsuleDigest)
      || !/^[0-9a-f]{64}$/.test(expectedPathsHash)) fail('INVALID_STAGE_PUBLICATION');
  return `${STAGE_PUBLICATION_PREFIX}${txId}-${capsuleDigest}-${expectedPathsHash}`;
}

function stagePublicationRoot(paths, txId, capsuleDigest, expectedPathsHash) {
  return path.join(
    transactionsRoot(paths), stagePublicationName(txId, capsuleDigest, expectedPathsHash),
  );
}

function readJsonObject(file, fallback, code = 'INVALID_LOCAL_STATE') {
  let value;
  try {
    value = readJson(file, fallback);
  } catch {
    fail(code);
  }
  if (!isObject(value)) fail(code);
  return value;
}

function readPrivateJsonObject(file, fallback, code = 'INVALID_LOCAL_STATE') {
  let value;
  try {
    value = readPrivateJson(file, fallback, { maxBytes: 2 * 1024 * 1024 });
  } catch {
    fail(code);
  }
  if (!isObject(value)) fail(code);
  return value;
}

function assertPrivateDirectory(target, code = 'UNSAFE_TRANSACTION_ROOT') {
  const metadata = lstatIfPresent(target);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) fail(code);
  if (process.platform !== 'win32') {
    if ((metadata.mode & 0o077) !== 0) fail(code);
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) fail(code);
  }
}

function assertSmallPrivateJson(file, code) {
  const metadata = lstatIfPresent(file);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1
      || metadata.size > 2 * 1024 * 1024) fail(code);
  if (process.platform !== 'win32') {
    if ((metadata.mode & 0o077) !== 0) fail(code);
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) fail(code);
  }
}

function exactKeys(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isSlug(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isSafeReceiptPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
      || path.posix.isAbsolute(value)) return false;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')
      || part.trim() !== part || /[\x00-\x1f\x7f]/.test(part))) return false;
  if (value === 'SKILL.md') return true;
  return parts.length >= 2 && parts[0] === 'references' && value.endsWith('.md');
}

function readReceipt(paths) {
  const file = receiptPath(paths);
  if (!lstatIfPresent(file)) return null;
  assertSmallPrivateJson(file, 'INVALID_RECEIPT');
  const value = readPrivateJsonObject(file, null, 'INVALID_RECEIPT');
  if (!exactKeys(value, [
    'version', 'profile', 'provider', 'skills', 'managedDeny', 'peripheralSuspensions',
    ...(Object.hasOwn(value, 'peripheralOverride') ? ['peripheralOverride'] : []),
  ]) || value.version !== 1 || !exactKeys(value.profile, ['id', 'revision', 'digest'])
      || !isSlug(value.profile.id)
      || !Number.isSafeInteger(value.profile.revision) || value.profile.revision < 1
      || !/^[0-9a-f]{64}$/.test(value.profile.digest)
      || !exactKeys(value.provider, ['id', 'authProfileId'])
      || value.provider.id !== `custom-rc-profile-${value.profile.id}`
      || value.provider.authProfileId !== `${value.provider.id}:managed`
      || !Array.isArray(value.skills) || !Array.isArray(value.managedDeny)
      || !exactKeys(value.peripheralSuspensions, ['monitors', 'mcp'])
      || !Array.isArray(value.peripheralSuspensions.monitors)
      || !Array.isArray(value.peripheralSuspensions.mcp)) fail('INVALID_RECEIPT');
  if (value.managedDeny.some((item) => !['periph_*', 'plaud__*'].includes(item))
      || new Set(value.managedDeny).size !== value.managedDeny.length) fail('INVALID_RECEIPT');
  if (value.peripheralSuspensions.monitors.some((id) => typeof id !== 'string' || id.length < 1
      || id.length > 512)
      || new Set(value.peripheralSuspensions.monitors).size
        !== value.peripheralSuspensions.monitors.length
      || value.peripheralSuspensions.mcp.some((id) => id !== 'plaud')
      || new Set(value.peripheralSuspensions.mcp).size !== value.peripheralSuspensions.mcp.length) {
    fail('INVALID_RECEIPT');
  }
  if (value.peripheralOverride !== undefined && (!exactKeys(value.peripheralOverride, ['source', 'value'])
      || value.peripheralOverride.source !== 'explicit-restore'
      || value.peripheralOverride.value !== 'enabled')) fail('INVALID_RECEIPT');
  const slugs = new Set();
  const directories = new Set();
  for (const skill of value.skills) {
    if (!exactKeys(skill, ['slug', 'directory', 'files']) || !isSlug(skill.slug)
        || skill.directory !== `rc-profile--${value.profile.id}--${skill.slug}`
        || slugs.has(skill.slug) || directories.has(skill.directory)
        || !Array.isArray(skill.files) || skill.files.length < 1) fail('INVALID_RECEIPT');
    slugs.add(skill.slug);
    directories.add(skill.directory);
    const files = new Set();
    let hasSkillMd = false;
    for (const fileEntry of skill.files) {
      if (!exactKeys(fileEntry, ['path', 'sha256']) || !isSafeReceiptPath(fileEntry.path)
          || !/^[0-9a-f]{64}$/.test(fileEntry.sha256) || files.has(fileEntry.path)) {
        fail('INVALID_RECEIPT');
      }
      files.add(fileEntry.path);
      if (fileEntry.path === 'SKILL.md') hasSkillMd = true;
    }
    if (!hasSkillMd) fail('INVALID_RECEIPT');
  }
  return value;
}

function readLedger(paths) {
  assertSmallPrivateJson(suspensionsPath(paths), 'INVALID_SUSPENSION_LEDGER');
  const value = readPrivateJsonObject(
    suspensionsPath(paths), { version: 1, entries: {}, mcp: {} }, 'INVALID_SUSPENSION_LEDGER',
  );
  if (value.version !== 1 || !isObject(value.entries) || !isObject(value.mcp ?? {})
      || Object.keys(value).some((key) => !['version', 'entries', 'mcp'].includes(key))
      || Object.keys(value.mcp ?? {}).some((key) => key !== 'plaud')) fail('INVALID_SUSPENSION_LEDGER');
  for (const [id, entry] of Object.entries(value.entries)) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 512 || !isObject(entry)
        || typeof entry.ownerProfileId !== 'string' || !isObject(entry.baseline)
        || !Number.isSafeInteger(entry.baseline.enabled)
        || (entry.baseline.gatewayJobId !== null && typeof entry.baseline.gatewayJobId !== 'string')
        || !/^[0-9a-f]{64}$/.test(entry.baselineRowHash)
        || !/^[0-9a-f]{64}$/.test(entry.suspendedRowHash)
        || !Array.isArray(entry.jobs) || entry.jobs.length > 100
        || entry.jobs.some((job) => !isObject(job) || typeof job.id !== 'string'
          || !Number.isSafeInteger(job.__rcOriginalIndex) || job.__rcOriginalIndex < 0)) {
      fail('INVALID_SUSPENSION_LEDGER');
    }
  }
  const plaud = value.mcp?.plaud;
  if (plaud !== undefined && (!isObject(plaud) || typeof plaud.ownerProfileId !== 'string'
      || plaud.serverPresent !== true || !isObject(plaud.baseline)
      || typeof plaud.baseline.enabledPresent !== 'boolean'
      || (plaud.baseline.enabledValue !== null && typeof plaud.baseline.enabledValue !== 'boolean')
      || plaud.expectedEnabledValue !== false)) fail('INVALID_SUSPENSION_LEDGER');
  return { version: 1, entries: clone(value.entries), mcp: clone(value.mcp ?? {}) };
}

function ownedSkillDirectories(receipt) {
  if (!receipt) return [];
  if (!Array.isArray(receipt.skills)) fail('INVALID_RECEIPT');
  return receipt.skills.map((skill) => skill.directory);
}

function skillNameFromFile(file) {
  let content;
  try {
    const metadata = fs.lstatSync(file);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) return null;
    content = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const line = content.slice(4, end).split('\n').find((item) => item.startsWith('name:'));
  if (!line) return null;
  const raw = line.slice(5).trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function validateSkillOwnership(paths, capsule, receipt) {
  const skillsRoot = path.join(paths.workspace, 'skills');
  assertNoSymlinkComponents(paths.roots.workspace, skillsRoot);
  const owned = new Set(ownedSkillDirectories(receipt));
  const expected = capsule.skills.items.map((item) => `rc-profile--${capsule.profile.id}--${item.slug}`);
  for (const directory of expected) {
    const target = path.join(skillsRoot, directory);
    const metadata = lstatIfPresent(target);
    if (metadata && !owned.has(directory)) fail('UNOWNED_SKILL_TARGET');
    if (metadata && (metadata.isSymbolicLink() || !metadata.isDirectory())) fail('UNSAFE_PATH');
  }
  const names = new Set(capsule.skills.items.map((item) => item.slug));
  const skillsMetadata = lstatIfPresent(skillsRoot);
  if (!skillsMetadata) return;
  if (skillsMetadata.isSymbolicLink() || !skillsMetadata.isDirectory()) fail('UNSAFE_PATH');
  for (const directory of fs.readdirSync(skillsRoot).sort()) {
    if (owned.has(directory)) continue;
    const absolute = path.join(skillsRoot, directory);
    const metadata = fs.lstatSync(absolute);
    if (metadata.isSymbolicLink()) fail('UNSAFE_PATH');
    if (!metadata.isDirectory()) continue;
    const name = skillNameFromFile(path.join(absolute, 'SKILL.md'));
    if (name && names.has(name)) fail('SKILL_NAME_CONFLICT');
  }
}

function assertUnownedManagedTargets(paths, capsule, receipt) {
  if (receipt) return;
  const providerId = capsule.model.providerId;
  const authProfileId = `${providerId}:managed`;
  const config = readJsonObject(paths.configPath, null, 'INVALID_CONFIG');
  const globalConfig = readJsonObject(paths.globalConfigPath, {});
  const auth = readPrivateJsonObject(
    authStorePath(paths), { version: 1, profiles: {} }, 'INVALID_AUTH_STORE',
  );
  for (const candidate of [config, globalConfig]) {
    if (Object.hasOwn(candidate.models?.providers ?? {}, providerId)
        || Object.hasOwn(candidate.auth?.profiles ?? {}, authProfileId)
        || Object.hasOwn(candidate.auth?.order ?? {}, providerId)) fail('UNOWNED_MANAGED_TARGET');
  }
  if (Object.hasOwn(auth.profiles ?? {}, authProfileId)) fail('UNOWNED_MANAGED_TARGET');
}

function ownedTargetDigest(target) {
  const hash = crypto.createHash('sha256');
  let entries = 0;
  let totalBytes = 0;
  const visit = (absolute, relative) => {
    const metadata = lstatIfPresent(absolute);
    if (!metadata) {
      hash.update(`${relative}:absent;`);
      return;
    }
    entries += 1;
    if (entries > 10_000) fail('UNSAFE_PATH');
    const identity = `${metadata.dev}:${metadata.ino}:${metadata.nlink}:${metadata.mode & 0o7777}:${metadata.mtimeMs}`;
    if (metadata.isSymbolicLink()) fail('UNSAFE_PATH');
    if (metadata.isDirectory()) {
      hash.update(`${relative}:directory:${identity};`);
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (metadata.nlink !== 1) fail('UNSAFE_PATH');
    if (!metadata.isFile()) fail('UNSAFE_PATH');
    totalBytes += metadata.size;
    if (totalBytes > 32 * 1024 * 1024) fail('UNSAFE_PATH');
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    let descriptor;
    try {
      descriptor = fs.openSync(absolute, flags);
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev
          || opened.ino !== metadata.ino || opened.size !== metadata.size) fail('UNSAFE_PATH');
      hash.update(`${relative}:file:${identity}:`);
      hash.update(fs.readFileSync(descriptor));
      const after = fs.fstatSync(descriptor);
      const atPath = fs.lstatSync(absolute);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
          || atPath.isSymbolicLink() || !atPath.isFile() || atPath.nlink !== 1
          || atPath.dev !== opened.dev || atPath.ino !== opened.ino || atPath.size !== opened.size) {
        fail('UNSAFE_PATH');
      }
      hash.update(';');
    } catch (error) {
      if (error instanceof BootstrapProfileTransactionError) throw error;
      fail('UNSAFE_PATH');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  try {
    visit(target, '');
    return hash.digest('hex');
  } catch {
    fail('UNSAFE_PATH');
  }
}

function unownedSkillDigest(target) {
  const hash = crypto.createHash('sha256');
  let entries = 0;
  let totalBytes = 0;
  const visit = (absolute, relative) => {
    const metadata = lstatIfPresent(absolute);
    if (!metadata || metadata.isSymbolicLink()) fail('UNSAFE_PATH');
    entries += 1;
    if (entries > 10_000) fail('UNSAFE_PATH');
    const identity = `${metadata.dev}:${metadata.ino}:${metadata.nlink}:${metadata.mode & 0o7777}:${metadata.mtimeMs}`;
    if (metadata.isDirectory()) {
      hash.update(`${relative}:directory:${identity};`);
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (!metadata.isFile() || metadata.nlink < 1) fail('UNSAFE_PATH');
    totalBytes += metadata.size;
    if (totalBytes > 32 * 1024 * 1024) fail('UNSAFE_PATH');
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    let descriptor;
    try {
      descriptor = fs.openSync(absolute, flags);
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== metadata.nlink || opened.dev !== metadata.dev
          || opened.ino !== metadata.ino || opened.size !== metadata.size) fail('UNSAFE_PATH');
      hash.update(`${relative}:file:${identity}:`);
      hash.update(fs.readFileSync(descriptor));
      const after = fs.fstatSync(descriptor);
      const atPath = fs.lstatSync(absolute);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
          || atPath.isSymbolicLink() || !atPath.isFile() || atPath.nlink !== opened.nlink
          || atPath.dev !== opened.dev || atPath.ino !== opened.ino || atPath.size !== opened.size) {
        fail('UNSAFE_PATH');
      }
      hash.update(';');
    } catch (error) {
      if (error instanceof BootstrapProfileTransactionError) throw error;
      fail('UNSAFE_PATH');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  visit(target, '');
  return hash.digest('hex');
}

function validateReceiptLedgerOwnership(receipt, ledger) {
  const monitorIds = Object.keys(ledger.entries).sort();
  const mcpIds = Object.keys(ledger.mcp).sort();
  if (!receipt) {
    if (monitorIds.length > 0 || mcpIds.length > 0) fail('INVALID_RECEIPT');
    return;
  }
  if (!equal(receipt.peripheralSuspensions.monitors, monitorIds)
      || !equal(receipt.peripheralSuspensions.mcp, mcpIds)
      || Object.values(ledger.entries).some((entry) => entry.ownerProfileId !== receipt.profile.id)
      || Object.values(ledger.mcp).some((entry) => entry.ownerProfileId !== receipt.profile.id)) {
    fail('INVALID_RECEIPT');
  }
}

function ownershipPrecondition(paths, capsule, receipt) {
  if (capsule.model.providerId !== `custom-rc-profile-${capsule.profile.id}`) {
    fail('INVALID_PROVIDER_ID');
  }
  validateSkillOwnership(paths, capsule, receipt);
  assertUnownedManagedTargets(paths, capsule, receipt);
  const ledger = readLedger(paths);
  validateReceiptLedgerOwnership(receipt, ledger);
  const skillsRoot = path.join(paths.workspace, 'skills');
  const managedDirectories = [...new Set([
    ...ownedSkillDirectories(receipt),
    ...capsule.skills.items.map((item) => `rc-profile--${capsule.profile.id}--${item.slug}`),
  ])].sort();
  const excluded = new Set(managedDirectories);
  const unownedSkillDirectories = [];
  const skillsMetadata = lstatIfPresent(skillsRoot);
  if (skillsMetadata) {
    if (skillsMetadata.isSymbolicLink() || !skillsMetadata.isDirectory()) fail('UNSAFE_PATH');
    for (const directory of fs.readdirSync(skillsRoot).sort()) {
      if (excluded.has(directory)) continue;
      const absolute = path.join(skillsRoot, directory);
      const metadata = fs.lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail('UNSAFE_PATH');
      if (!metadata.isDirectory()) continue;
      unownedSkillDirectories.push({ directory, digest: unownedSkillDigest(absolute) });
    }
  }
  return {
    version: 1,
    receipt: {
      present: receipt !== null,
      digest: receipt === null ? null : valueHash(receipt),
    },
    providerTargets: {
      config: valueHash({
        provider: readJsonObject(paths.configPath, null, 'INVALID_CONFIG').models?.providers?.[capsule.model.providerId],
        authProfile: readJsonObject(paths.configPath, null, 'INVALID_CONFIG').auth?.profiles?.[`${capsule.model.providerId}:managed`],
        authOrder: readJsonObject(paths.configPath, null, 'INVALID_CONFIG').auth?.order?.[capsule.model.providerId],
      }),
      globalConfig: valueHash({
        provider: readJsonObject(paths.globalConfigPath, {}).models?.providers?.[capsule.model.providerId],
        authProfile: readJsonObject(paths.globalConfigPath, {}).auth?.profiles?.[`${capsule.model.providerId}:managed`],
        authOrder: readJsonObject(paths.globalConfigPath, {}).auth?.order?.[capsule.model.providerId],
      }),
      authStore: valueHash(readPrivateJsonObject(
        authStorePath(paths), { version: 1, profiles: {} }, 'INVALID_AUTH_STORE',
      ).profiles?.[`${capsule.model.providerId}:managed`] ?? null),
    },
    suspensionLedger: valueHash(ledger),
    managedSkillDirectories: managedDirectories.map((directory) => ({
      directory,
      digest: ownedTargetDigest(path.join(skillsRoot, directory)),
    })),
    unownedSkillDirectories,
  };
}

function assertStagedPrecondition(paths, capsule, manifest) {
  let receipt;
  let current;
  try {
    receipt = readReceipt(paths);
    current = ownershipPrecondition(paths, capsule, receipt);
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) fail('STAGED_PRECONDITION_CHANGED');
    throw error;
  }
  if (!equal(current, manifest.ownershipPrecondition)) fail('STAGED_PRECONDITION_CHANGED');
  return receipt;
}

function privatePublicationMetadata(metadata, { directory = false } = {}) {
  if (!metadata || metadata.isSymbolicLink()
      || (directory ? !metadata.isDirectory() : !metadata.isFile())
      || (!directory && metadata.nlink !== 1)) return false;
  if (process.platform !== 'win32') {
    if ((metadata.mode & 0o077) !== 0) return false;
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) return false;
  }
  return true;
}

function assertTransactionParentPrivate(paths) {
  const root = transactionsRoot(paths);
  const metadata = lstatIfPresent(root);
  if (!metadata) return;
  if (!privatePublicationMetadata(metadata, { directory: true })) {
    fail('INVALID_STAGE_PUBLICATION');
  }
}

function parseStagePublication(name) {
  const match = STAGE_PUBLICATION_NAME.exec(name);
  if (!match) fail('INVALID_STAGE_PUBLICATION');
  return { txId: match[1], capsuleDigest: match[2], pathsHash: match[3] };
}

function validateUnpublishedStage(paths, name) {
  const identity = parseStagePublication(name);
  if (identity.pathsHash !== pathsHash(paths)) fail('INVALID_STAGE_PUBLICATION');
  const root = path.join(transactionsRoot(paths), name);
  const rootMetadata = lstatIfPresent(root);
  if (!privatePublicationMetadata(rootMetadata, { directory: true })) {
    fail('INVALID_STAGE_PUBLICATION');
  }
  const entries = fs.readdirSync(root).sort();
  const atomicTemp = /^\.(capsule|manifest)\.json\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/;
  if (entries.some((entry) => !['capsule.json', 'manifest.json'].includes(entry)
      && !atomicTemp.test(entry))) fail('INVALID_STAGE_PUBLICATION');
  const capsuleCandidates = entries.filter(
    (entry) => entry === 'capsule.json' || atomicTemp.exec(entry)?.[1] === 'capsule',
  );
  const manifestCandidates = entries.filter(
    (entry) => entry === 'manifest.json' || atomicTemp.exec(entry)?.[1] === 'manifest',
  );
  const publicationState = entries.length === 0 ? 'empty'
    : entries.length === 1 && atomicTemp.exec(entries[0])?.[1] === 'capsule' ? 'capsule-temp'
      : entries.length === 1 && entries[0] === 'capsule.json' ? 'capsule'
        : entries.length === 2 && entries.includes('capsule.json')
          && entries.some((entry) => atomicTemp.exec(entry)?.[1] === 'manifest') ? 'manifest-temp'
          : entries.length === 2 && entries[0] === 'capsule.json'
            && entries[1] === 'manifest.json' ? 'complete' : null;
  if (publicationState === null || capsuleCandidates.length > 1 || manifestCandidates.length > 1) {
    fail('INVALID_STAGE_PUBLICATION');
  }
  for (const entry of entries) {
    const metadata = lstatIfPresent(path.join(root, entry));
    if (!privatePublicationMetadata(metadata) || metadata.size > MAX_CAPSULE_BYTES) {
      fail('INVALID_STAGE_PUBLICATION');
    }
  }
  const capsuleFile = capsuleCandidates.length === 1
    ? path.join(root, capsuleCandidates[0]) : null;
  if (capsuleFile) {
    let bytes;
    try {
      bytes = readPrivateFile(capsuleFile, { maxBytes: MAX_CAPSULE_BYTES });
    } catch {
      fail('INVALID_STAGE_PUBLICATION');
    }
    if (sha256(bytes) !== identity.capsuleDigest) fail('INVALID_STAGE_PUBLICATION');
  }
  const manifestFile = manifestCandidates.length === 1
    ? path.join(root, manifestCandidates[0]) : null;
  if (manifestFile) {
    if (!capsuleFile) fail('INVALID_STAGE_PUBLICATION');
    let manifest;
    try {
      manifest = readPrivateJson(manifestFile, undefined, { maxBytes: MAX_CAPSULE_BYTES });
    } catch {
      fail('INVALID_STAGE_PUBLICATION');
    }
    const standardKeys = new Set([
      'version', 'txId', 'state', 'profileId', 'revision', 'digest', 'authProfileId',
      'pathsHash', 'lastCompletedStep', 'volumeMarkers', 'commitCertificate', 'ownershipPrecondition',
    ]);
    if (!isObject(manifest) || Object.keys(manifest).some((key) => !standardKeys.has(key))
        || manifest.version !== 1 || manifest.txId !== identity.txId || manifest.state !== 'staged'
        || manifest.digest !== identity.capsuleDigest || manifest.pathsHash !== identity.pathsHash
        || typeof manifest.profileId !== 'string' || !Number.isSafeInteger(manifest.revision)
        || typeof manifest.authProfileId !== 'string' || !isObject(manifest.ownershipPrecondition)
        || manifest.lastCompletedStep !== null || manifest.volumeMarkers !== null
        || manifest.commitCertificate !== null) fail('INVALID_STAGE_PUBLICATION');
  }
  return { ...identity, root };
}

function reconcileUnpublishedStages(paths) {
  const root = transactionsRoot(paths);
  const metadata = lstatIfPresent(root);
  if (!metadata) return [];
  assertTransactionParentPrivate(paths);
  const names = fs.readdirSync(root).sort();
  const hasUnpublished = names.some((name) => name.startsWith(STAGE_PUBLICATION_PREFIX));
  if (names.some((name) => !name.startsWith(STAGE_PUBLICATION_PREFIX)
      && !/^tx-[0-9a-f-]{36}$/.test(name))) {
    fail(hasUnpublished ? 'INVALID_STAGE_PUBLICATION' : 'UNKNOWN_TRANSACTION_STATE');
  }
  const unpublished = [];
  for (const name of names) {
    if (name.startsWith(STAGE_PUBLICATION_PREFIX)) {
      unpublished.push(validateUnpublishedStage(paths, name));
    }
  }
  for (const publication of unpublished) removePath(publication.root);
  return unpublished.map(({ txId }) => txId);
}

function assertNoPendingTransactions(paths) {
  if (readCommittedCleanupIntents(paths).length > 0) fail('PENDING_TRANSACTION');
  const root = transactionsRoot(paths);
  const metadata = lstatIfPresent(root);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('UNSAFE_TRANSACTION_ROOT');
  if (fs.readdirSync(root).length > 0) fail('PENDING_TRANSACTION');
}

function recoveryIncidentRoots(paths) {
  return [
    path.join(bootstrapRoot(paths), 'recovery-incidents'),
    path.join(paths.workspace, '.rc-bootstrap-recovery-incidents'),
    path.join(paths.stateDir, '.rc-bootstrap-recovery-incidents'),
    path.join(paths.roots.data, '.rc-bootstrap-recovery-incidents'),
  ];
}

function recoveryIncident(paths, txId, recoveredState, restoredVolumes = []) {
  return {
    version: 1,
    txId,
    code: 'CONFIG_VOLUME_LOST',
    recoveredState,
    restoredVolumes,
  };
}

function writeRecoveryIncident(paths, incident) {
  for (const incidentRoot of recoveryIncidentRoots(paths)) {
    ensureDirectory(incidentRoot, 0o700);
    const file = path.join(incidentRoot, `${incident.txId}.json`);
    const existing = lstatIfPresent(file);
    if (existing) {
      const current = readJsonObject(file, null, 'INVALID_RECOVERY_INCIDENT');
      if (!equal(current, incident)) fail('INVALID_RECOVERY_INCIDENT');
      continue;
    }
    writeJsonAtomic(file, incident, 0o600);
    if (!equal(readJsonObject(file, null, 'INVALID_RECOVERY_INCIDENT'), incident)) {
      fail('INVALID_RECOVERY_INCIDENT');
    }
  }
}

function assertNoRecoveryIncidents(paths) {
  for (const root of recoveryIncidentRoots(paths)) {
    const metadata = lstatIfPresent(root);
    if (!metadata) continue;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('UNSAFE_TRANSACTION_ROOT');
    if (fs.readdirSync(root).length > 0) fail('RECOVERY_INCIDENT_PENDING');
  }
}

function readManifest(paths, txId) {
  const root = txRoot(paths, txId);
  const metadata = lstatIfPresent(root);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) fail('TRANSACTION_NOT_FOUND');
  assertPrivateDirectory(bootstrapRoot(paths));
  assertPrivateDirectory(transactionsRoot(paths));
  assertPrivateDirectory(root);
  const manifestFile = manifestPath(paths, txId);
  assertExistingFileSafe(manifestFile, { allowAbsent: false });
  assertSmallPrivateJson(manifestFile, 'INVALID_TRANSACTION');
  const manifest = readPrivateJsonObject(manifestFile, null, 'INVALID_TRANSACTION');
  const standardKeys = new Set([
    'version', 'txId', 'state', 'profileId', 'revision', 'digest', 'authProfileId',
    'pathsHash', 'lastCompletedStep', 'volumeMarkers', 'commitCertificate', 'ownershipPrecondition',
  ]);
  const restoreKeys = new Set([...standardKeys]
    .filter((key) => !['authProfileId', 'ownershipPrecondition'].includes(key)).concat('operation'));
  const allowedKeys = manifest.operation === 'peripheral-restore' ? restoreKeys : standardKeys;
  if (Object.keys(manifest).some((key) => !allowedKeys.has(key))) fail('INVALID_TRANSACTION');
  if (manifest.version !== 1 || manifest.txId !== txId || manifest.pathsHash !== pathsHash(paths)
      || typeof manifest.profileId !== 'string' || !Number.isSafeInteger(manifest.revision)
      || !/^[0-9a-f]{64}$/.test(manifest.digest)
      || typeof manifest.state !== 'string'
      || (manifest.operation === undefined && typeof manifest.authProfileId !== 'string')
      || (manifest.operation === undefined && !isObject(manifest.ownershipPrecondition))
      || (manifest.operation !== undefined && manifest.operation !== 'peripheral-restore')) {
    fail('TRANSACTION_PATH_MISMATCH');
  }
  return manifest;
}

function readTransactionCapsule(paths, txId) {
  const file = path.join(txRoot(paths, txId), 'capsule.json');
  try {
    return readPrivateFile(file, { maxBytes: MAX_CAPSULE_BYTES });
  } catch {
    fail('INVALID_TRANSACTION_CAPSULE');
  }
}

function publicTransaction(manifest) {
  return {
    txId: manifest.txId,
    state: manifest.state,
    profileId: manifest.profileId,
    revision: manifest.revision,
    digest: manifest.digest,
  };
}

async function stageProfile(options) {
  const paths = normalizePaths(options);
  reconcileCronCleanupQuarantineAtEntry(paths);
  const validated = validateCapsuleBytes(options.capsuleBytes, { rcVersion: options.rcVersion });
  assertNoRecoveryIncidents(paths);
  reconcileUnpublishedStages(paths);
  assertNoPendingTransactions(paths);
  const receipt = readReceipt(paths);
  if (receipt) {
    if (!isObject(receipt.profile) || !Number.isSafeInteger(receipt.profile.revision)
        || typeof receipt.profile.digest !== 'string') fail('INVALID_RECEIPT');
    if (receipt.profile.id === validated.capsule.profile.id) {
      if (validated.capsule.profile.revision < receipt.profile.revision) fail('REVISION_ROLLBACK');
    }
  }
  const precondition = ownershipPrecondition(paths, validated.capsule, receipt);

  ensureDirectory(bootstrapRoot(paths), 0o700);
  ensureDirectory(transactionsRoot(paths), 0o700);
  assertTransactionParentPrivate(paths);
  const txId = `tx-${crypto.randomUUID()}`;
  const expectedPathsHash = pathsHash(paths);
  const root = stagePublicationRoot(paths, txId, validated.digest, expectedPathsHash);
  const publishedRoot = txRoot(paths, txId);
  fs.mkdirSync(root, { mode: 0o700 });
  fsyncDirectory(transactionsRoot(paths));
  maybePauseForFault('stage-unpublished-directory');
  try {
    writeBytesAtomic(
      path.join(root, 'capsule.json'), Buffer.from(options.capsuleBytes), 0o600,
      { beforeRename: () => maybePauseForFault('stage-capsule-temp') },
    );
    maybePauseForFault('stage-capsule-written');
    const manifest = {
      version: 1,
      txId,
      state: 'staged',
      profileId: validated.capsule.profile.id,
      revision: validated.capsule.profile.revision,
      digest: validated.digest,
      authProfileId: validated.authProfileId,
      pathsHash: expectedPathsHash,
      lastCompletedStep: null,
      volumeMarkers: null,
      commitCertificate: null,
      ownershipPrecondition: precondition,
    };
    writeJsonAtomic(
      path.join(root, 'manifest.json'), manifest, 0o600,
      { beforeRename: () => maybePauseForFault('stage-manifest-temp') },
    );
    const publication = validateUnpublishedStage(paths, path.basename(root));
    if (publication.txId !== txId) fail('INVALID_STAGE_PUBLICATION');
    fsyncDirectory(root);
    maybePauseForFault('stage-before-publish');
    if (lstatIfPresent(publishedRoot)) fail('TRANSACTION_COLLISION');
    fs.renameSync(root, publishedRoot);
    fsyncDirectory(transactionsRoot(paths));
    return publicTransaction(manifest);
  } catch (error) {
    if (lstatIfPresent(root)) removePath(root);
    throw error;
  }
}

function markerRoots(paths, txId) {
  return {
    config: txRoot(paths, txId),
    workspace: path.join(paths.workspace, '.rc-bootstrap-transactions', txId),
    state: path.join(paths.stateDir, '.rc-bootstrap-transactions', txId),
    data: path.join(paths.roots.data, '.rc-bootstrap-transactions', txId),
  };
}

function authStorePath(paths) {
  return path.join(paths.stateDir, 'agents/main/agent/auth-profiles.json');
}

function readSnapshotRootFile(snapshotRoot, expectedDigest, maxBytes) {
  let snapshot;
  try {
    snapshot = verifySnapshot(snapshotRoot, expectedDigest);
  } catch {
    fail('INVALID_TRANSACTION_PREIMAGE');
  }
  const root = snapshot.entries.find((entry) => entry.path === '');
  if (!root) fail('INVALID_TRANSACTION_PREIMAGE');
  if (root.type === 'absent') return null;
  if (root.type !== 'file' || typeof root.content !== 'string'
      || !/^[0-9a-f]{64}$/.test(root.sha256)) fail('INVALID_TRANSACTION_PREIMAGE');
  const contentRoot = path.join(snapshotRoot, 'content');
  const contentFile = path.join(contentRoot, root.content);
  if (!isInside(contentRoot, contentFile)) fail('INVALID_TRANSACTION_PREIMAGE');
  try {
    const bytes = readPrivateFile(contentFile, { maxBytes, exactMode: 0o600 });
    if (sha256(bytes) !== root.sha256) fail('INVALID_TRANSACTION_PREIMAGE');
    verifySnapshot(snapshotRoot, expectedDigest);
    return bytes;
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('INVALID_TRANSACTION_PREIMAGE');
  }
}

function readAuthVerificationPreimage(paths, txId, manifest) {
  const markers = readBoundMarkers(paths, txId, manifest);
  const roots = markerRoots(paths, txId);
  const authAsset = markers.state?.assets?.find((candidate) => candidate.id === 'auth');
  const receiptAsset = markers.config?.assets?.find((candidate) => candidate.id === 'receipt');
  if (!authAsset || !receiptAsset) fail('INVALID_TRANSACTION_PREIMAGE');
  const authBytes = readSnapshotRootFile(
    path.join(roots.state, authAsset.snapshot), authAsset.digest, AUTH_STORE_MAX_BYTES,
  );
  const receiptBytes = readSnapshotRootFile(
    path.join(roots.config, receiptAsset.snapshot), receiptAsset.digest, 2 * 1024 * 1024,
  );
  let authStore;
  let previousReceipt = null;
  try {
    authStore = authBytes === null
      ? { version: 1, profiles: {} } : JSON.parse(authBytes.toString('utf8'));
    previousReceipt = receiptBytes === null ? null : JSON.parse(receiptBytes.toString('utf8'));
  } catch (error) {
    fail('INVALID_TRANSACTION_PREIMAGE');
  }
  const receiptBinding = manifest.ownershipPrecondition?.receipt;
  if (!isObject(authStore) || !isObject(receiptBinding)
      || receiptBinding.present !== (previousReceipt !== null)
      || (previousReceipt === null ? receiptBinding.digest !== null
        : !isObject(previousReceipt) || valueHash(previousReceipt) !== receiptBinding.digest)) {
    fail('INVALID_TRANSACTION_PREIMAGE');
  }
  let retiredAuthProfileId = null;
  if (previousReceipt !== null) {
    const previousProvider = previousReceipt.provider;
    if (!isObject(previousProvider) || typeof previousProvider.id !== 'string'
        || typeof previousProvider.authProfileId !== 'string'
        || previousProvider.authProfileId !== `${previousProvider.id}:managed`) {
      fail('INVALID_TRANSACTION_PREIMAGE');
    }
    retiredAuthProfileId = previousProvider.authProfileId;
  }
  return { authStore, retiredAuthProfileId };
}

function authAtomicIntentPath(paths, txId) {
  return path.join(markerRoots(paths, txId).state, 'auth-intent.json');
}

function authAtomicIntentStagingPath(paths, txId) {
  return path.join(markerRoots(paths, txId).state, 'auth-intent.staging');
}

function authAtomicTempPrefix(txId) {
  if (typeof txId !== 'string' || !/^tx-[0-9a-f-]{36}$/.test(txId)) fail('INVALID_TRANSACTION_ID');
  return `.rc-bootstrap-auth-${txId}`;
}

function authAtomicTempPattern(txId) {
  const prefix = authAtomicTempPrefix(txId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}\\.`
    + '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$');
}

function authAtomicIntent(paths, txId, content, tempName) {
  return {
    version: 1,
    txId,
    target: path.relative(paths.stateDir, authStorePath(paths)),
    tempPrefix: authAtomicTempPrefix(txId),
    tempName,
    payloadBytes: content.length,
    payloadSha256: sha256(content),
  };
}

function readAuthAtomicIntent(paths, txId, record) {
  let intent;
  try {
    intent = JSON.parse(record.bytes.toString('utf8'));
  } catch {
    fail('INVALID_AUTH_TEMP');
  }
  const keys = 'payloadBytes,payloadSha256,target,tempName,tempPrefix,txId,version';
  if (!isObject(intent) || Object.keys(intent).sort().join(',') !== keys
      || intent.version !== 1 || intent.txId !== txId
      || intent.target !== path.relative(paths.stateDir, authStorePath(paths))
      || intent.tempPrefix !== authAtomicTempPrefix(txId)
      || typeof intent.tempName !== 'string'
      || !authAtomicTempPattern(txId).test(intent.tempName)
      || !Number.isSafeInteger(intent.payloadBytes) || intent.payloadBytes < 1
      || intent.payloadBytes > AUTH_STORE_MAX_BYTES
      || typeof intent.payloadSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(intent.payloadSha256)) fail('INVALID_AUTH_TEMP');
  return { intent, record };
}

function listAuthAtomicTemps(paths, txId) {
  const directory = path.dirname(authStorePath(paths));
  const metadata = lstatIfPresent(directory);
  if (!metadata) return [];
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('INVALID_AUTH_TEMP');
  const pattern = authAtomicTempPattern(txId);
  const candidatePrefix = `${authAtomicTempPrefix(txId)}.`;
  const names = fs.readdirSync(directory).filter(
    (name) => name.startsWith(candidatePrefix) && name.endsWith('.tmp'),
  );
  if (names.some((name) => !pattern.test(name))) fail('INVALID_AUTH_TEMP');
  return names.map(
    (name) => path.join(directory, name),
  );
}

function reconcileAuthAtomicWrite(paths, txId) {
  const intentFile = authAtomicIntentPath(paths, txId);
  const stagingFile = authAtomicIntentStagingPath(paths, txId);
  const markerRoot = path.dirname(intentFile);
  const markerMetadata = lstatIfPresent(markerRoot);
  if (!markerMetadata) {
    if (listAuthAtomicTemps(paths, txId).length > 0) fail('INVALID_AUTH_TEMP');
    return;
  }
  if (markerMetadata.isSymbolicLink() || !markerMetadata.isDirectory()) {
    fail('INVALID_AUTH_TEMP');
  }
  const allowedIntentNames = new Set([path.basename(intentFile), path.basename(stagingFile)]);
  if (fs.readdirSync(markerRoot).some(
    (name) => name.startsWith('auth-intent') && !allowedIntentNames.has(name),
  )) fail('INVALID_AUTH_TEMP');
  let authority;
  try {
    authority = reconcileStagedJsonAuthority(intentFile, stagingFile, {
      maxBytes: 4096,
      mode: 0o600,
    });
  } catch {
    fail('INVALID_AUTH_TEMP');
  }
  const candidates = listAuthAtomicTemps(paths, txId);
  if (!authority) {
    if (candidates.length > 0) fail('INVALID_AUTH_TEMP');
    return;
  }
  const authenticated = readAuthAtomicIntent(paths, txId, authority);
  const { intent } = authenticated;
  if (candidates.length > 1) fail('INVALID_AUTH_TEMP');
  if (candidates.length === 1) {
    let candidate;
    try {
      candidate = readPrivateFileRecord(candidates[0], {
        maxBytes: intent.payloadBytes,
        exactMode: 0o600,
      });
    } catch {
      fail('INVALID_AUTH_TEMP');
    }
    if (path.basename(candidates[0]) !== intent.tempName
        || (candidate.bytes.length === intent.payloadBytes
          && sha256(candidate.bytes) !== intent.payloadSha256)) fail('INVALID_AUTH_TEMP');
    try { unlinkPrivateFileRecord(candidates[0], candidate.identity); } catch { fail('INVALID_AUTH_TEMP'); }
  }
  try { unlinkPrivateFileRecord(intentFile, authenticated.record.identity); } catch { fail('INVALID_AUTH_TEMP'); }
}

function liveConfigAtomicSpec(paths, txId, kind) {
  if (!['project', 'global'].includes(kind)) fail('INVALID_LIVE_CONFIG_TEMP');
  if (typeof txId !== 'string' || !/^tx-[0-9a-f-]{36}$/.test(txId)) {
    fail('INVALID_TRANSACTION_ID');
  }
  const project = kind === 'project';
  const target = project ? paths.configPath : paths.globalConfigPath;
  const volumeRoot = project ? paths.roots.config : paths.stateDir;
  const markerRoot = project ? markerRoots(paths, txId).config : markerRoots(paths, txId).state;
  const relativeTarget = path.relative(volumeRoot, target);
  if (!relativeTarget || path.isAbsolute(relativeTarget)
      || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`)) {
    fail('INVALID_LIVE_CONFIG_TEMP');
  }
  const tempPrefix = `.rc-bootstrap-live-config-${txId}-${kind}`;
  const escaped = tempPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    kind,
    target,
    relativeTarget,
    markerRoot,
    intentFile: path.join(markerRoot, `live-config-${kind}-intent.json`),
    intentStagingFile: path.join(markerRoot, `live-config-${kind}-intent.staging`),
    tempPrefix,
    tempPattern: new RegExp(`^${escaped}\\.`
      + '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$'),
  };
}

function liveConfigAtomicIntent(paths, txId, kind, content, tempName) {
  const spec = liveConfigAtomicSpec(paths, txId, kind);
  return {
    version: 1,
    txId,
    kind,
    target: spec.relativeTarget,
    tempPrefix: spec.tempPrefix,
    tempName,
    payloadBytes: content.length,
    payloadSha256: sha256(content),
  };
}

function readLiveConfigAtomicIntent(paths, txId, kind, record) {
  const spec = liveConfigAtomicSpec(paths, txId, kind);
  let intent;
  try {
    intent = JSON.parse(record.bytes.toString('utf8'));
  } catch {
    fail('INVALID_LIVE_CONFIG_TEMP');
  }
  if (!exactKeys(intent, [
    'version', 'txId', 'kind', 'target', 'tempPrefix', 'tempName',
    'payloadBytes', 'payloadSha256',
  ]) || intent.version !== 1 || intent.txId !== txId || intent.kind !== kind
      || intent.target !== spec.relativeTarget || intent.tempPrefix !== spec.tempPrefix
      || typeof intent.tempName !== 'string' || !spec.tempPattern.test(intent.tempName)
      || !Number.isSafeInteger(intent.payloadBytes) || intent.payloadBytes < 1
      || intent.payloadBytes > LIVE_CONFIG_MAX_BYTES
      || typeof intent.payloadSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(intent.payloadSha256)) {
    fail('INVALID_LIVE_CONFIG_TEMP');
  }
  return { intent, record };
}

function listLiveConfigAtomicTemps(paths, txId, kind) {
  const spec = liveConfigAtomicSpec(paths, txId, kind);
  const directory = path.dirname(spec.target);
  const metadata = lstatIfPresent(directory);
  if (!metadata) return [];
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail('INVALID_LIVE_CONFIG_TEMP');
  }
  const candidatePrefix = `${spec.tempPrefix}.`;
  const names = fs.readdirSync(directory).filter(
    (name) => name.startsWith(candidatePrefix) && name.endsWith('.tmp'),
  );
  if (names.some((name) => !spec.tempPattern.test(name))) fail('INVALID_LIVE_CONFIG_TEMP');
  return names.map((name) => path.join(directory, name));
}

function reconcileLiveConfigAtomicWrite(paths, txId, kind) {
  const spec = liveConfigAtomicSpec(paths, txId, kind);
  const markerMetadata = lstatIfPresent(spec.markerRoot);
  if (!markerMetadata) {
    if (listLiveConfigAtomicTemps(paths, txId, kind).length > 0) {
      fail('INVALID_LIVE_CONFIG_TEMP');
    }
    return;
  }
  if (markerMetadata.isSymbolicLink() || !markerMetadata.isDirectory()) {
    fail('INVALID_LIVE_CONFIG_TEMP');
  }
  const intentPrefix = `live-config-${kind}-intent`;
  const allowedIntentNames = new Set([
    path.basename(spec.intentFile), path.basename(spec.intentStagingFile),
  ]);
  if (fs.readdirSync(spec.markerRoot).some(
    (name) => name.startsWith(intentPrefix) && !allowedIntentNames.has(name),
  )) fail('INVALID_LIVE_CONFIG_TEMP');
  let authority;
  try {
    authority = reconcileStagedJsonAuthority(spec.intentFile, spec.intentStagingFile, {
      maxBytes: 4096,
      mode: 0o600,
    });
  } catch {
    fail('INVALID_LIVE_CONFIG_TEMP');
  }
  const candidates = listLiveConfigAtomicTemps(paths, txId, kind);
  if (!authority) {
    if (candidates.length > 0) fail('INVALID_LIVE_CONFIG_TEMP');
    return;
  }
  const authenticated = readLiveConfigAtomicIntent(paths, txId, kind, authority);
  const { intent } = authenticated;
  if (candidates.length > 1) fail('INVALID_LIVE_CONFIG_TEMP');
  if (candidates.length === 1) {
    let candidate;
    try {
      candidate = readPrivateFileRecord(candidates[0], {
        maxBytes: intent.payloadBytes,
        exactMode: 0o600,
      });
    } catch {
      fail('INVALID_LIVE_CONFIG_TEMP');
    }
    if (path.basename(candidates[0]) !== intent.tempName
        || (candidate.bytes.length === intent.payloadBytes
          && sha256(candidate.bytes) !== intent.payloadSha256)) fail('INVALID_LIVE_CONFIG_TEMP');
    try { unlinkPrivateFileRecord(candidates[0], candidate.identity); } catch {
      fail('INVALID_LIVE_CONFIG_TEMP');
    }
  }
  try { unlinkPrivateFileRecord(spec.intentFile, authenticated.record.identity); } catch {
    fail('INVALID_LIVE_CONFIG_TEMP');
  }
}

function reconcileTransactionAtomicWrites(paths, txId) {
  reconcileAuthAtomicWrite(paths, txId);
  reconcileLiveConfigAtomicWrite(paths, txId, 'project');
  reconcileLiveConfigAtomicWrite(paths, txId, 'global');
}

function writeLiveConfigAtomic(paths, txId, kind, value) {
  const spec = liveConfigAtomicSpec(paths, txId, kind);
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (content.length < 1 || content.length > LIVE_CONFIG_MAX_BYTES) {
    fail('INVALID_LIVE_CONFIG_TEMP');
  }
  reconcileLiveConfigAtomicWrite(paths, txId, kind);
  const tempName = `${spec.tempPrefix}.${crypto.randomUUID()}.tmp`;
  writeJsonStagedNoReplace(
    spec.intentFile, spec.intentStagingFile,
    liveConfigAtomicIntent(paths, txId, kind, content, tempName), 0o600,
  );
  try {
    writeBytesAtomic(spec.target, content, 0o600, {
      ensureParent: false,
      temporaryPrefix: spec.tempPrefix,
      temporaryName: tempName,
      beforeRename: () => {
        maybePauseForFault(`live-config-${kind}-temp`);
      },
    });
  } finally {
    reconcileLiveConfigAtomicWrite(paths, txId, kind);
  }
}

function cronWorkerLifecyclePath(paths, txId) {
  return path.join(markerRoots(paths, txId).state, 'cron-worker-lifecycle.sqlite');
}

function cronWorkerLifecycleAuthorityValue(scratch, txId, epoch, lifecycleIdentity) {
  if (!scratch || scratch.home !== cronWorkerScratchPath(scratch.paths, txId, epoch)
      || scratch.tmp !== path.join(scratch.home, 'tmp')
      || scratch.parentIdentity.path !== txRoot(scratch.paths, txId)
      || !samePrivateDirectoryIdentity(scratch.home, scratch.homeIdentity)
      || !samePrivateDirectoryIdentity(scratch.tmp, scratch.tmpIdentity)
      || !samePrivateDirectoryIdentity(scratch.parentIdentity.path, scratch.parentIdentity)
      || !validCronWorkerLifecycleFileIdentity(lifecycleIdentity)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return {
    version: 1,
    txId,
    epoch,
    lifecycle: clone(lifecycleIdentity),
    scratch: clone(scratch.homeIdentity),
    parent: clone(scratch.parentIdentity),
    nested: [{ relative: 'tmp', identity: clone(scratch.tmpIdentity) }],
  };
}

function parseCronWorkerLifecycleAuthority(paths, txId, epoch, encoded) {
  if (typeof encoded !== 'string' || encoded.length < 2 || encoded.length > 4096) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  let value;
  try { value = JSON.parse(encoded); } catch { fail('CRON_WORKER_LIFECYCLE_INVALID'); }
  if (!exactKeys(value, [
    'version', 'txId', 'epoch', 'lifecycle', 'scratch', 'parent', 'nested',
  ])
      || value.version !== 1 || value.txId !== txId || value.epoch !== epoch
      || encoded !== JSON.stringify(stableValue(value))
      || !validCronWorkerLifecycleFileIdentity(value.lifecycle)
      || !sameCronWorkerLifecycleFileIdentity(
        cronWorkerLifecyclePath(paths, txId), value.lifecycle,
      )
      || !Array.isArray(value.nested) || value.nested.length !== 1
      || !exactKeys(value.nested[0], ['relative', 'identity'])
      || value.nested[0].relative !== 'tmp') {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const scratchPath = cronWorkerScratchPath(paths, txId, epoch);
  const expected = [
    [value.scratch, scratchPath],
    [value.parent, txRoot(paths, txId)],
    [value.nested[0].identity, path.join(scratchPath, 'tmp')],
  ];
  for (const [identity, expectedPath] of expected) {
    if (!exactKeys(identity, ['path', 'dev', 'ino', 'mode', 'uid'])
        || identity.path !== expectedPath || !validSerialDirectoryIdentity({
          dev: identity.dev, ino: identity.ino, mode: identity.mode, uid: identity.uid,
        })) fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return {
    paths,
    epoch,
    home: scratchPath,
    tmp: path.join(scratchPath, 'tmp'),
    homeIdentity: value.scratch,
    parentIdentity: value.parent,
    tmpIdentity: value.nested[0].identity,
    encoded,
  };
}

function validateCronWorkerLifecycleRow(paths, txId, row) {
  if (!row || row.version !== 1 || row.txId !== txId
      || !['idle', 'active'].includes(row.state) || typeof row.epoch !== 'string'
      || typeof row.authority !== 'string') fail('CRON_WORKER_LIFECYCLE_INVALID');
  if (row.epoch === '' || row.authority === '') {
    if (row.epoch !== '' || row.authority !== '' || row.state !== 'idle') {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    return null;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.epoch)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return parseCronWorkerLifecycleAuthority(paths, txId, row.epoch, row.authority);
}

function normalizedSql(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().replace(/^CREATE TABLE IF NOT EXISTS /, 'CREATE TABLE ')
    : '';
}

function cronWorkerLifecycleFileIdentity(file) {
  let metadata;
  try { metadata = fs.lstatSync(file, { bigint: true }); } catch {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const mode = process.platform === 'win32' ? null : Number(metadata.mode & 0o7777n);
  const uid = Number(metadata.uid);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1n
      || metadata.size < 0n || metadata.size > BigInt(CRON_WORKER_LIFECYCLE_MAX_BYTES)
      || (process.platform !== 'win32' && (mode !== 0o600
        || (typeof process.getuid === 'function' && uid !== process.getuid())))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    nlink: metadata.nlink.toString(),
    mode,
    uid,
  };
}

function validCronWorkerLifecycleFileIdentity(identity) {
  return exactKeys(identity, ['dev', 'ino', 'nlink', 'mode', 'uid'])
    && typeof identity.dev === 'string' && /^\d+$/.test(identity.dev)
    && typeof identity.ino === 'string' && /^\d+$/.test(identity.ino)
    && identity.nlink === '1' && Number.isSafeInteger(identity.uid)
    && (process.platform === 'win32'
      ? identity.mode === null
      : identity.mode === 0o600
        && (typeof process.getuid !== 'function' || identity.uid === process.getuid()));
}

function sameCronWorkerLifecycleFileIdentity(file, identity) {
  if (!validCronWorkerLifecycleFileIdentity(identity)) return false;
  try { return equal(cronWorkerLifecycleFileIdentity(file), identity); } catch { return false; }
}

function createCronWorkerLifecycleFile(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const metadata = fs.fstatSync(descriptor, { bigint: true });
    const mode = process.platform === 'win32' ? null : Number(metadata.mode & 0o7777n);
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size !== 0n
        || (process.platform !== 'win32' && (mode !== 0o600
          || (typeof process.getuid === 'function'
            && Number(metadata.uid) !== process.getuid())))) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function inspectCronWorkerLifecycleSchema(database, paths, txId, { allowEmpty }) {
  const checked = database.pragma('quick_check');
  if (checked?.length !== 1 || checked[0]?.quick_check !== 'ok') {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const objects = database.prepare(
    "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
  if (objects.length === 0 && allowEmpty) return false;
  if (objects.length !== 1 || objects[0].type !== 'table'
      || objects[0].name !== 'rc_cron_worker_epoch'
      || objects[0].tableName !== 'rc_cron_worker_epoch'
      || normalizedSql(objects[0].sql) !== normalizedSql(CRON_WORKER_LIFECYCLE_CREATE_SQL)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const rows = database.prepare(
    'SELECT version, tx_id AS txId, epoch, state, authority FROM rc_cron_worker_epoch',
  ).all();
  if (rows.length !== 1) fail('CRON_WORKER_LIFECYCLE_INVALID');
  validateCronWorkerLifecycleRow(paths, txId, rows[0]);
  return true;
}

function openCronWorkerLifecycle(paths, txId, { requireExisting = false } = {}) {
  const file = cronWorkerLifecyclePath(paths, txId);
  const root = path.dirname(file);
  const rootIdentity = privateDirectoryIdentity(root, 'CRON_WORKER_LIFECYCLE_INVALID');
  const Database = resolveDatabase(paths);
  let database;
  try {
    let metadata = lstatIfPresent(file);
    if (!metadata) {
      if (requireExisting) fail('CRON_WORKER_LIFECYCLE_INVALID');
      createCronWorkerLifecycleFile(file);
      fsyncDirectory(root);
      metadata = lstatIfPresent(file);
    }
    const identity = cronWorkerLifecycleFileIdentity(file);
    const preflight = new Database(file, { readonly: true, fileMustExist: true });
    let initialized;
    try {
      initialized = inspectCronWorkerLifecycleSchema(preflight, paths, txId, {
        allowEmpty: metadata.size === 0,
      });
    } finally {
      preflight.close();
    }
    if (!samePrivateDirectoryIdentity(root, rootIdentity)
        || !sameCronWorkerLifecycleFileIdentity(file, identity)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    database = new Database(file, { fileMustExist: true, timeout: CRON_WORKER_EXIT_TIMEOUT_MS });
    if (!samePrivateDirectoryIdentity(root, rootIdentity)
        || !sameCronWorkerLifecycleFileIdentity(file, identity)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    if (!initialized) {
      database.exec(CRON_WORKER_LIFECYCLE_CREATE_SQL);
      database.prepare(
        "INSERT INTO rc_cron_worker_epoch (singleton, version, tx_id, epoch, state, authority) VALUES (1, 1, ?, '', 'idle', '')",
      ).run(txId);
    }
    inspectCronWorkerLifecycleSchema(database, paths, txId, { allowEmpty: false });
    if (!samePrivateDirectoryIdentity(root, rootIdentity)
        || !sameCronWorkerLifecycleFileIdentity(file, identity)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    fsyncDirectory(root);
    return { database, file, identity, rootIdentity };
  } catch (error) {
    database?.close();
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
}

function waitForCronWorkerEpochExit(paths, txId) {
  const file = cronWorkerLifecyclePath(paths, txId);
  if (!lstatIfPresent(file)) return;
  let database;
  try {
    const lifecycle = openCronWorkerLifecycle(paths, txId, { requireExisting: true });
    database = lifecycle.database;
    database.pragma(`busy_timeout = ${CRON_WORKER_EXIT_TIMEOUT_MS}`);
    database.exec('BEGIN EXCLUSIVE');
    const row = database.prepare(
      'SELECT version, tx_id AS txId, epoch, state, authority FROM rc_cron_worker_epoch WHERE singleton = 1',
    ).get();
    const authority = validateCronWorkerLifecycleRow(paths, txId, row);
    // EXCLUSIVE acquisition proves that no worker still holds the exact epoch
    // lease. `active` can remain after SIGKILL, or if the parent died between
    // publishing the epoch and spawning the child; retiring it is safe here.
    if (row.state === 'active') {
      database.prepare(
        "UPDATE rc_cron_worker_epoch SET state = 'idle' WHERE singleton = 1 AND epoch = ?",
      ).run(row.epoch);
    }
    database.exec('COMMIT');
    return authority;
  } catch (error) {
    try { database?.exec('ROLLBACK'); } catch {}
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_STILL_ACTIVE');
  } finally {
    database?.close();
  }
}

function clearCronWorkerLifecycleAuthority(paths, txId, epoch, encoded) {
  const lifecycle = openCronWorkerLifecycle(paths, txId);
  try {
    lifecycle.database.exec('BEGIN IMMEDIATE');
    const row = lifecycle.database.prepare(
      'SELECT version, tx_id AS txId, epoch, state, authority FROM rc_cron_worker_epoch WHERE singleton = 1',
    ).get();
    validateCronWorkerLifecycleRow(paths, txId, row);
    if (row.state !== 'idle' || row.epoch !== epoch || row.authority !== encoded) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const changed = lifecycle.database.prepare(
      "UPDATE rc_cron_worker_epoch SET epoch = '', authority = '' WHERE singleton = 1 AND state = 'idle' AND epoch = ? AND authority = ?",
    ).run(epoch, encoded);
    if (changed.changes !== 1) fail('CRON_WORKER_LIFECYCLE_INVALID');
    lifecycle.database.exec('COMMIT');
  } catch (error) {
    try { lifecycle.database.exec('ROLLBACK'); } catch {}
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  } finally {
    lifecycle.database.close();
  }
}

function recoverCronWorkerLifecycleAuthority(paths, txId) {
  const scratch = waitForCronWorkerEpochExit(paths, txId);
  if (!scratch) return;
  const present = lstatIfPresent(scratch.home);
  if (present) {
    if (!samePrivateDirectoryIdentity(scratch.home, scratch.homeIdentity)
        || !samePrivateDirectoryIdentity(scratch.tmp, scratch.tmpIdentity)
        || !samePrivateDirectoryIdentity(scratch.parentIdentity.path, scratch.parentIdentity)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    cleanupCronWorkerScratch(scratch);
  }
  clearCronWorkerLifecycleAuthority(paths, txId, scratch.epoch, scratch.encoded);
}

function volumeDefinitions(paths, receipt, capsule) {
  const oldDirectories = ownedSkillDirectories(receipt);
  const newDirectories = capsule.skills.items.map(
    (item) => `rc-profile--${capsule.profile.id}--${item.slug}`,
  );
  const skillDirectories = [...new Set([...oldDirectories, ...newDirectories])].sort();
  return {
    config: {
      root: paths.roots.config,
      directories: [],
      assets: [
        { id: 'config', target: paths.configPath },
        { id: 'receipt', target: receiptPath(paths) },
        { id: 'suspensions', target: suspensionsPath(paths) },
      ],
    },
    workspace: {
      root: paths.workspace,
      directories: [path.join(paths.workspace, 'skills')],
      assets: skillDirectories.map((directory) => ({
        id: `skill-${sha256(Buffer.from(directory)).slice(0, 16)}`,
        target: path.join(paths.workspace, 'skills', directory),
      })),
    },
    state: {
      root: paths.stateDir,
      directories: [
        path.join(paths.stateDir, 'agents'),
        path.join(paths.stateDir, 'agents/main'),
        path.join(paths.stateDir, 'agents/main/agent'),
        path.join(paths.stateDir, 'state'),
      ],
      assets: [
        { id: 'auth', target: path.join(paths.stateDir, 'agents/main/agent/auth-profiles.json') },
        { id: 'global-config', target: paths.globalConfigPath },
        { id: 'cron-db', target: path.join(paths.stateDir, 'state/openclaw.sqlite') },
        { id: 'cron-wal', target: path.join(paths.stateDir, 'state/openclaw.sqlite-wal') },
        { id: 'cron-shm', target: path.join(paths.stateDir, 'state/openclaw.sqlite-shm') },
      ],
    },
    data: {
      root: paths.roots.data,
      directories: [],
      assets: [
        { id: 'rc-db', target: paths.dbPath },
        { id: 'rc-wal', target: `${paths.dbPath}-wal` },
        { id: 'rc-shm', target: `${paths.dbPath}-shm` },
      ],
    },
  };
}

function topologyForDefinitions(definitions) {
  return Object.fromEntries(VOLUMES.map((volume) => [volume, {
    volumeRoot: definitions[volume].root,
    directories: definitions[volume].directories.map(
      (directory) => path.relative(definitions[volume].root, directory),
    ),
    assets: definitions[volume].assets.map((asset) => ({
      id: asset.id,
      target: path.relative(definitions[volume].root, asset.target),
    })),
  }]));
}

function maybeInjectFault(step, fault) {
  if (process.env.NODE_ENV === 'test'
      && process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS === '1'
      && fault === step) fail('INJECTED_FAULT');
}

function maybePauseForFault(step) {
  const faultsEnabled = process.env.NODE_ENV === 'test'
    && process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS === '1';
  if (!faultsEnabled || process.env.RC_BOOTSTRAP_FAULT_PAUSE_AFTER !== step) return;
  const ready = process.env.RC_BOOTSTRAP_FAULT_READY;
  if (ready && path.isAbsolute(ready) && !ready.includes('\0')) {
    writeBytesAtomic(ready, Buffer.from('ready\n'), 0o600);
  }
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(signal, 0, 0, 1_000);
}

function createVolumeMarkers(paths, txId, receipt, capsule, manifest, fault) {
  const roots = markerRoots(paths, txId);
  const definitions = volumeDefinitions(paths, receipt, capsule);
  const transactionTopology = topologyForDefinitions(definitions);
  const markers = {};
  for (const volume of VOLUMES) {
    const root = roots[volume];
    if (volume !== 'config') {
      const parent = path.dirname(root);
      const parentMetadata = lstatIfPresent(parent);
      if (parentMetadata && (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory())) {
        fail('UNSAFE_TRANSACTION_ROOT');
      }
      ensureDirectory(parent, 0o700);
      if (lstatIfPresent(root)) fail('TRANSACTION_COLLISION');
      fs.mkdirSync(root, { mode: 0o700 });
      fsyncDirectory(parent);
    }
    const preimageRoot = path.join(root, 'preimage');
    ensureDirectory(preimageRoot, 0o700);
    const directories = definitions[volume].directories.map((directory) => {
      assertNoSymlinkComponents(definitions[volume].root, directory);
      const metadata = lstatIfPresent(directory);
      if (metadata && (metadata.isSymbolicLink() || !metadata.isDirectory())) fail('UNSAFE_PATH');
      return {
        target: path.relative(definitions[volume].root, directory),
        existed: Boolean(metadata),
        mode: metadata && process.platform !== 'win32' ? metadata.mode & 0o7777 : null,
      };
    });
    const assets = [];
    for (const asset of definitions[volume].assets) {
      assertNoSymlinkComponents(definitions[volume].root, asset.target);
      assertSnapshotTargetSafe(asset.target);
      const snapshot = path.join(preimageRoot, asset.id);
      const digest = snapshotPath(asset.target, snapshot);
      assets.push({
        id: asset.id,
        target: path.relative(definitions[volume].root, asset.target),
        snapshot: path.relative(root, snapshot),
        digest,
      });
    }
    const marker = {
      version: 1,
      txId,
      volume,
      state: 'prepared',
      profileId: capsule.profile.id,
      capsuleDigest: manifest.digest,
      manifestIdentity: valueHash({ txId, profileId: capsule.profile.id, digest: manifest.digest }),
      volumeRoot: definitions[volume].root,
      transactionTopology,
      assets,
      directories,
      preimageDigest: valueHash({
        transactionTopology,
        assets: assets.map(({ id, target, digest }) => ({ id, target, digest })), directories,
      }),
    };
    writeJsonAtomic(path.join(root, 'volume-marker.json'), marker, 0o600);
    markers[volume] = marker;
    maybeInjectFault(`prepare-${volume}`, fault);
  }
  // The state-volume lifecycle database is intentionally outside the marker
  // preimage. It is transaction control material, not a live user asset.
  const lifecycle = openCronWorkerLifecycle(paths, txId);
  lifecycle.database.close();
  return markers;
}

function updateManifest(paths, txId, update) {
  const manifest = readManifest(paths, txId);
  Object.assign(manifest, update);
  writeJsonAtomic(manifestPath(paths, txId), manifest, 0o600);
  return manifest;
}

function updateMarkerStates(paths, txId, state) {
  const roots = markerRoots(paths, txId);
  for (const volume of VOLUMES) {
    const file = path.join(roots[volume], 'volume-marker.json');
    if (!lstatIfPresent(file)) continue;
    const marker = readJsonObject(file, null, 'INVALID_VOLUME_MARKER');
    marker.state = state;
    writeJsonAtomic(file, marker, 0o600);
  }
}

function publicMarkers(paths, txId) {
  const roots = markerRoots(paths, txId);
  return Object.fromEntries(VOLUMES.map((volume) => {
    const marker = readJsonObject(path.join(roots[volume], 'volume-marker.json'), null, 'INVALID_VOLUME_MARKER');
    return [volume, {
      txId: marker.txId,
      state: marker.state,
      preimageDigest: marker.preimageDigest,
    }];
  }));
}

function providerConfig(capsule, authProfileId) {
  return {
    baseUrl: capsule.model.baseUrl,
    apiKey: authProfileId,
    api: capsule.model.api,
    models: [{
      id: capsule.model.model.id,
      name: capsule.model.model.name,
      input: clone(capsule.model.model.input),
      contextWindow: capsule.model.model.contextWindow,
      maxTokens: capsule.model.model.maxTokens,
    }],
  };
}

function ensureObjectAt(parent, key) {
  if (parent[key] === undefined) parent[key] = {};
  else if (!isObject(parent[key])) fail('INVALID_CONFIG');
  return parent[key];
}

function buildConfigPlan(current, capsule, authProfileId, receipt, ledgerInput) {
  if (!isObject(current)) fail('INVALID_CONFIG');
  const next = clone(current);
  const ledger = clone(ledgerInput);
  const models = ensureObjectAt(next, 'models');
  const providers = ensureObjectAt(models, 'providers');
  const oldProvider = receipt?.provider?.id;
  if (!receipt && Object.hasOwn(providers, capsule.model.providerId)) fail('UNOWNED_MANAGED_TARGET');
  if (typeof oldProvider === 'string' && oldProvider !== capsule.model.providerId) {
    delete providers[oldProvider];
  }
  models.mode = typeof models.mode === 'string' ? models.mode : 'merge';
  providers[capsule.model.providerId] = providerConfig(capsule, authProfileId);
  const agents = ensureObjectAt(next, 'agents');
  const defaults = ensureObjectAt(agents, 'defaults');
  const model = ensureObjectAt(defaults, 'model');
  model.primary = `${capsule.model.providerId}/${capsule.model.model.id}`;

  const auth = ensureObjectAt(next, 'auth');
  const authProfiles = ensureObjectAt(auth, 'profiles');
  const authOrder = ensureObjectAt(auth, 'order');
  if (!receipt && (Object.hasOwn(authProfiles, authProfileId)
      || Object.hasOwn(authOrder, capsule.model.providerId))) fail('UNOWNED_MANAGED_TARGET');
  const oldAuth = receipt?.provider?.authProfileId;
  if (typeof oldAuth === 'string' && oldAuth !== authProfileId) delete authProfiles[oldAuth];
  if (typeof oldProvider === 'string' && oldProvider !== capsule.model.providerId) delete authOrder[oldProvider];
  authProfiles[authProfileId] = { provider: capsule.model.providerId, mode: 'api_key' };
  authOrder[capsule.model.providerId] = [authProfileId];

  const plugins = ensureObjectAt(next, 'plugins');
  const entries = ensureObjectAt(plugins, 'entries');
  const core = ensureObjectAt(entries, 'research-claw-core');
  core.enabled = true;
  const coreConfig = ensureObjectAt(core, 'config');
  coreConfig.productPolicy = { capabilities: clone(capsule.policy.capabilities) };
  const dms = ensureObjectAt(entries, 'dual-model-supervisor');
  dms.enabled = true;
  const dmsConfig = ensureObjectAt(dms, 'config');
  dmsConfig.enabled = true;
  dmsConfig.supervisorModel = '';
  dmsConfig.reviewMode = capsule.policy.supervisor.reviewMode;

  const tools = ensureObjectAt(next, 'tools');
  if (tools.deny === undefined) tools.deny = [];
  if (!Array.isArray(tools.deny) || tools.deny.some((item) => typeof item !== 'string')) fail('INVALID_CONFIG');
  const oldManaged = new Set(Array.isArray(receipt?.managedDeny) ? receipt.managedDeny : []);
  const managedDeny = [];
  const desiredDeny = ['periph_*', 'plaud__*'];
  if (capsule.policy.capabilities.peripherals === 'disabled') {
    for (const item of desiredDeny) {
      if (!tools.deny.includes(item)) {
        tools.deny.push(item);
        managedDeny.push(item);
      } else if (oldManaged.has(item)) {
        managedDeny.push(item);
      }
    }
  } else {
    tools.deny = tools.deny.filter((item) => !oldManaged.has(item));
  }

  if (!isObject(ledger.mcp)) ledger.mcp = {};
  const plaud = next.mcp?.servers?.plaud;
  const plaudLedger = ledger.mcp.plaud;
  if (capsule.policy.capabilities.peripherals === 'disabled') {
    if (plaudLedger) {
      if (!isObject(plaud) || plaud.enabled !== false) fail('SUSPENSION_CONFLICT');
      plaudLedger.ownerProfileId = capsule.profile.id;
    } else if (plaud !== undefined) {
      if (!isObject(plaud)) fail('INVALID_CONFIG');
      const enabledPresent = Object.hasOwn(plaud, 'enabled');
      if (enabledPresent && typeof plaud.enabled !== 'boolean') fail('INVALID_CONFIG');
      ledger.mcp.plaud = {
        ownerProfileId: capsule.profile.id,
        serverPresent: true,
        baseline: { enabledPresent, enabledValue: enabledPresent ? plaud.enabled : null },
        expectedEnabledValue: false,
      };
      plaud.enabled = false;
    }
  } else if (plaudLedger) {
    if (!isObject(plaud) || plaud.enabled !== false) fail('SUSPENSION_CONFLICT');
    if (plaudLedger.baseline.enabledPresent) plaud.enabled = plaudLedger.baseline.enabledValue;
    else delete plaud.enabled;
    delete ledger.mcp.plaud;
  }

  return { config: next, ledger, managedDeny };
}

function buildAuthPlan(current, capsule, authProfileId, receipt) {
  if (!isObject(current)) fail('INVALID_AUTH_STORE');
  const next = clone(current);
  if (next.version !== 1 || !isObject(next.profiles)) fail('INVALID_AUTH_STORE');
  if (!receipt && Object.hasOwn(next.profiles, authProfileId)) fail('UNOWNED_MANAGED_TARGET');
  const oldAuth = receipt?.provider?.authProfileId;
  if (typeof oldAuth === 'string' && oldAuth !== authProfileId) delete next.profiles[oldAuth];
  next.profiles[authProfileId] = {
    type: 'api_key', provider: capsule.model.providerId, key: capsule.secrets.modelApiKey,
  };
  return next;
}

function buildGlobalConfigPlan(current, capsule, authProfileId, receipt) {
  if (!isObject(current)) fail('INVALID_CONFIG');
  const next = clone(current);
  const models = ensureObjectAt(next, 'models');
  const providers = ensureObjectAt(models, 'providers');
  const oldProvider = receipt?.provider?.id;
  if (!receipt && Object.hasOwn(providers, capsule.model.providerId)) fail('UNOWNED_MANAGED_TARGET');
  if (typeof oldProvider === 'string' && oldProvider !== capsule.model.providerId) {
    delete providers[oldProvider];
  }
  models.mode = typeof models.mode === 'string' ? models.mode : 'merge';
  providers[capsule.model.providerId] = providerConfig(capsule, authProfileId);
  const agents = ensureObjectAt(next, 'agents');
  const defaults = ensureObjectAt(agents, 'defaults');
  ensureObjectAt(defaults, 'model').primary = `${capsule.model.providerId}/${capsule.model.model.id}`;
  const auth = ensureObjectAt(next, 'auth');
  const authProfiles = ensureObjectAt(auth, 'profiles');
  const authOrder = ensureObjectAt(auth, 'order');
  if (!receipt && (Object.hasOwn(authProfiles, authProfileId)
      || Object.hasOwn(authOrder, capsule.model.providerId))) fail('UNOWNED_MANAGED_TARGET');
  const oldAuth = receipt?.provider?.authProfileId;
  if (typeof oldAuth === 'string' && oldAuth !== authProfileId) delete authProfiles[oldAuth];
  if (typeof oldProvider === 'string' && oldProvider !== capsule.model.providerId) delete authOrder[oldProvider];
  authProfiles[authProfileId] = { provider: capsule.model.providerId, mode: 'api_key' };
  authOrder[capsule.model.providerId] = [authProfileId];
  return next;
}

function resolveDatabase(paths) {
  let modulePath;
  try {
    modulePath = require.resolve('better-sqlite3', {
      paths: [path.join(paths.rcRoot, 'extensions/research-claw-core'), paths.rcRoot],
    });
  } catch {
    fail('SQLITE_RUNTIME_UNAVAILABLE');
  }
  return require(modulePath);
}

function readMonitorRows(paths, databasePath = paths.dbPath) {
  if (!lstatIfPresent(databasePath)) return [];
  const Database = resolveDatabase(paths);
  let database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='rc_monitors'",
    ).get();
    if (!table) return [];
    return database.prepare('SELECT * FROM rc_monitors ORDER BY id').all();
  } catch {
    fail('MONITOR_STORE_INVALID');
  } finally {
    database?.close();
  }
}

async function cloneMonitorState(paths, txId) {
  const cloneRoot = path.join(txRoot(paths, txId), 'monitor-clone');
  removePath(cloneRoot);
  ensureDirectory(cloneRoot, 0o700);
  if (!lstatIfPresent(paths.dbPath)) return null;
  const target = path.join(cloneRoot, path.basename(paths.dbPath));
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${paths.dbPath}${suffix}`;
    if (lstatIfPresent(source)) {
      fs.copyFileSync(source, `${target}${suffix}`, fs.constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') fs.chmodSync(`${target}${suffix}`, 0o600);
    }
  }
  return target;
}

async function inspectMonitorRows(paths, txId) {
  const databasePath = await cloneMonitorState(paths, txId);
  if (!databasePath) return [];
  try {
    return readMonitorRows(paths, databasePath);
  } finally {
    removePath(path.dirname(databasePath));
  }
}

function suspendedRow(row) {
  return { ...clone(row), enabled: 0, gateway_job_id: null };
}

function ownedJobsForRow(row, jobs) {
  const sessionKey = `cron:rc-monitor:${row.id}`;
  return jobs.flatMap((job, index) => {
    if ((row.gateway_job_id && job.id === row.gateway_job_id) || job.sessionKey === sessionKey) {
      return [{ ...clone(job), __rcOriginalIndex: index }];
    }
    return [];
  });
}

function isDeviceSourceType(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'device';
}

function buildPeripheralPlan(rows, jobs, policy, profileId, ledgerInput) {
  const ledger = clone(ledgerInput);
  const rowMap = new Map(rows.map((row) => [row.id, row]));
  let nextRows = rows.map(clone);
  let nextJobs = jobs.map(clone);
  const originalJobs = jobs.map(clone);
  if (policy === 'disabled') {
    for (const [id, entry] of Object.entries(ledger.entries)) {
      const row = rowMap.get(id);
      if (!row || valueHash(row) !== entry.suspendedRowHash) fail('SUSPENSION_CONFLICT');
      // Once owned by the ledger, no exact device job may reappear. A newly
      // created exact session-key job is drift, not a new baseline.
      if (ownedJobsForRow(row, originalJobs).length > 0) fail('SUSPENSION_CONFLICT');
      entry.ownerProfileId = profileId;
    }
    for (const row of rows.filter((item) => isDeviceSourceType(item.source_type))) {
      if (!ledger.entries[row.id]) {
        const ownedJobs = ownedJobsForRow(row, originalJobs);
        ledger.entries[row.id] = {
          ownerProfileId: profileId,
          baseline: { enabled: row.enabled, gatewayJobId: row.gateway_job_id ?? null },
          baselineRowHash: valueHash(row),
          suspendedRowHash: valueHash(suspendedRow(row)),
          jobs: ownedJobs,
        };
      }
      nextRows = nextRows.map((item) => item.id === row.id ? suspendedRow(item) : item);
    }
    const removedIds = new Set(Object.values(ledger.entries).flatMap(
      (entry) => (entry.jobs ?? []).map((job) => job.id),
    ));
    nextJobs = nextJobs.filter((job) => !removedIds.has(job.id));
  } else {
    const restoredJobs = [];
    for (const [id, entry] of Object.entries(ledger.entries)) {
      const row = rowMap.get(id);
      if (!row || valueHash(row) !== entry.suspendedRowHash) fail('SUSPENSION_CONFLICT');
      for (const owned of entry.jobs ?? []) {
        if (jobs.some((job) => job.id === owned.id)) fail('SUSPENSION_CONFLICT');
        restoredJobs.push(owned);
      }
      nextRows = nextRows.map((item) => item.id === id ? {
        ...item,
        enabled: entry.baseline.enabled,
        gateway_job_id: entry.baseline.gatewayJobId,
      } : item);
    }
  for (const owned of restoredJobs.sort((a, b) => a.__rcOriginalIndex - b.__rcOriginalIndex)) {
      const restored = clone(owned);
      const index = restored.__rcOriginalIndex;
      delete restored.__rcOriginalIndex;
      nextJobs.splice(Math.min(index, nextJobs.length), 0, restored);
    }
    ledger.entries = {};
  }
  return { rows: nextRows, jobs: nextJobs, ledger };
}

function assertCronCloneTopology({
  parent, parentIdentity, cloneRoot, cloneIdentity, stateRoot, stateIdentity,
}) {
  if (!samePrivateDirectoryIdentity(parent, parentIdentity)
      || (cloneIdentity && !samePrivateDirectoryIdentity(cloneRoot, cloneIdentity))
      || (stateIdentity && !samePrivateDirectoryIdentity(stateRoot, stateIdentity))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
}

function sameCronCloneMetadata(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.nlink === right.nlink && left.size === right.size
    && left.mode === right.mode && left.uid === right.uid;
}

function assertCronClonePrivateFile(metadata) {
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1n
      || metadata.size < 0n || metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
      || (process.platform !== 'win32' && (Number(metadata.mode & 0o7777n) !== 0o600
        || (typeof process.getuid === 'function' && Number(metadata.uid) !== process.getuid())))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
}

function cronCloneSourceRecord(
  source, maxBytes = CRON_CLEANUP_TREE_MAX_CONTENT_BYTES,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  let before;
  try { before = fs.lstatSync(source, { bigint: true }); } catch {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n
      || before.size < 0n || before.size > BigInt(maxBytes)
      || (process.platform !== 'win32' && (Number(before.mode & 0o7022n) !== 0
        || (typeof process.getuid === 'function' && Number(before.uid) !== process.getuid())))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const sourceFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(source, sourceFlags);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    let atPath;
    try { atPath = fs.lstatSync(source, { bigint: true }); } catch {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    if (!opened.isFile() || !sameCronCloneMetadata(opened, before)
        || !sameCronCloneMetadata(atPath, opened)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    const size = Number(opened.size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(
        descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset,
      );
      if (count <= 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const stable = fs.fstatSync(descriptor, { bigint: true });
    let stableAtPath;
    try { stableAtPath = fs.lstatSync(source, { bigint: true }); } catch {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    if (!sameCronCloneMetadata(stable, opened)
        || !sameCronCloneMetadata(stableAtPath, opened)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    return { identity: stable, sha256: hash.digest('hex') };
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function planCronCloneFiles(paths) {
  const source = path.join(paths.stateDir, 'state/openclaw.sqlite');
  if (!lstatIfPresent(source)) return [];
  const plan = [];
  let totalBytes = Buffer.byteLength('{}\n');
  for (const suffix of ['', '-wal', '-shm']) {
    const member = `${source}${suffix}`;
    if (!lstatIfPresent(member)) continue;
    const remaining = CRON_CLEANUP_TREE_MAX_CONTENT_BYTES - totalBytes;
    const record = cronCloneSourceRecord(member, remaining);
    totalBytes = cronCleanupSafeAdd(totalBytes, Number(record.identity.size));
    plan.push({ source: member, suffix, ...record });
  }
  return plan;
}

function assertCronCloneSourcePlan(paths, plan) {
  const source = path.join(paths.stateDir, 'state/openclaw.sqlite');
  const bySuffix = new Map(plan.map((item) => [item.suffix, item]));
  for (const suffix of ['', '-wal', '-shm']) {
    const member = `${source}${suffix}`;
    const expected = bySuffix.get(suffix);
    const present = lstatIfPresent(member);
    if (!expected) {
      if (present) fail('CRON_WORKER_LIFECYCLE_INVALID');
      continue;
    }
    if (!present) fail('CRON_WORKER_LIFECYCLE_INVALID');
    const observed = cronCloneSourceRecord(member, Number(expected.identity.size));
    if (!sameCronCloneMetadata(observed.identity, expected.identity)
        || observed.sha256 !== expected.sha256) fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
}

function sameCronCloneObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function copyCronCloneFileExclusiveDurable(
  source, destination, expectedSourceIdentity, expectedSourceSha256,
) {
  const before = cronCloneSourceRecord(source, Number(expectedSourceIdentity.size));
  if (!sameCronCloneMetadata(before.identity, expectedSourceIdentity)
      || before.sha256 !== expectedSourceSha256) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const sourceFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  const destinationFlags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let sourceDescriptor;
  let destinationDescriptor;
  let destinationOpened;
  let copiedRecord;
  try {
    sourceDescriptor = fs.openSync(source, sourceFlags);
    const openedSource = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (!openedSource.isFile() || !sameCronCloneMetadata(openedSource, before.identity)
        || !sameCronCloneMetadata(openedSource, expectedSourceIdentity)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    destinationDescriptor = fs.openSync(destination, destinationFlags, 0o600);
    destinationOpened = fs.fstatSync(destinationDescriptor, { bigint: true });
    if (process.platform !== 'win32') fs.fchmodSync(destinationDescriptor, 0o600);
    const openedDestination = fs.fstatSync(destinationDescriptor, { bigint: true });
    assertCronClonePrivateFile(openedDestination);
    const sourceHash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    const size = Number(openedSource.size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(
        sourceDescriptor, buffer, 0, Math.min(buffer.length, size - offset), offset,
      );
      if (count <= 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
      sourceHash.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        const amount = fs.writeSync(
          destinationDescriptor, buffer, written, count - written, offset + written,
        );
        if (amount <= 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
        written += amount;
      }
      offset += count;
    }
    fs.fsyncSync(destinationDescriptor);
    const afterSource = fs.fstatSync(sourceDescriptor, { bigint: true });
    const afterDestination = fs.fstatSync(destinationDescriptor, { bigint: true });
    let sourceAtPath;
    let destinationAtPath;
    try {
      sourceAtPath = fs.lstatSync(source, { bigint: true });
      destinationAtPath = fs.lstatSync(destination, { bigint: true });
    } catch {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    assertCronClonePrivateFile(afterDestination);
    assertCronClonePrivateFile(destinationAtPath);
    if (!sameCronCloneMetadata(afterSource, openedSource)
        || !sameCronCloneMetadata(sourceAtPath, openedSource)
        || !sameCronCloneMetadata(afterDestination, destinationAtPath)
        || afterDestination.dev !== openedDestination.dev
        || afterDestination.ino !== openedDestination.ino
        || afterDestination.size !== openedSource.size) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const destinationHash = crypto.createHash('sha256');
    offset = 0;
    while (offset < size) {
      const count = fs.readSync(
        destinationDescriptor, buffer, 0, Math.min(buffer.length, size - offset), offset,
      );
      if (count <= 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
      destinationHash.update(buffer.subarray(0, count));
      offset += count;
    }
    const copiedSourceSha256 = sourceHash.digest('hex');
    if (copiedSourceSha256 !== expectedSourceSha256
        || destinationHash.digest('hex') !== copiedSourceSha256) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const stableDestination = fs.fstatSync(destinationDescriptor, { bigint: true });
    let stableDestinationAtPath;
    try { stableDestinationAtPath = fs.lstatSync(destination, { bigint: true }); } catch {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    assertCronClonePrivateFile(stableDestination);
    assertCronClonePrivateFile(stableDestinationAtPath);
    if (!sameCronCloneMetadata(stableDestination, afterDestination)
        || !sameCronCloneMetadata(stableDestinationAtPath, afterDestination)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    copiedRecord = {
      identity: cronCleanupFileIdentity(stableDestination),
      sha256: copiedSourceSha256,
    };
    fsyncDirectory(path.dirname(destination));
    return copiedRecord;
  } catch (error) {
    if (destinationDescriptor !== undefined) {
      try { fs.closeSync(destinationDescriptor); } catch {}
      destinationDescriptor = undefined;
    }
    if (sourceDescriptor !== undefined) {
      try { fs.closeSync(sourceDescriptor); } catch {}
      sourceDescriptor = undefined;
    }
    if (destinationOpened) {
      let candidate;
      try { candidate = fs.lstatSync(destination, { bigint: true }); } catch {}
      if (candidate && !candidate.isSymbolicLink() && candidate.isFile()
          && candidate.nlink === 1n && sameCronCloneObject(candidate, destinationOpened)) {
        try {
          fs.unlinkSync(destination);
          fsyncDirectory(path.dirname(destination));
        } catch {}
      }
    }
    const failure = error instanceof BootstrapProfileTransactionError
      ? error : new BootstrapProfileTransactionError('CRON_WORKER_LIFECYCLE_INVALID');
    try {
      failure.cronCloneDestinationUnbound = Boolean(lstatIfPresent(destination));
    } catch {
      failure.cronCloneDestinationUnbound = true;
    }
    throw failure;
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
  }
}

function assertCronCloneCreatedFiles(records) {
  for (const record of records) {
    const fresh = readCronCleanupFileRecord(record.path, {
      maxBytes: record.identity.size,
    });
    if (!sameCronCleanupFileIdentity(fresh.identity, record.identity)
        || sha256(fresh.bytes) !== record.sha256) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
  }
}

async function cloneCronState(paths, txId) {
  const cloneRoot = path.join(txRoot(paths, txId), 'cron-clone');
  const parent = txRoot(paths, txId);
  const parentIdentity = privateDirectoryIdentity(parent);
  const stateRoot = path.join(cloneRoot, 'state');
  const copyPlan = planCronCloneFiles(paths);
  let cloneIdentity;
  let stateIdentity;
  const createdFiles = [];
  const topology = () => ({
    parent, parentIdentity, cloneRoot, cloneIdentity, stateRoot, stateIdentity,
  });
  const mutate = (callback) => {
    assertCronCloneTopology(topology());
    const value = callback();
    assertCronCloneTopology(topology());
    return value;
  };
  try {
    assertCronCloneSourcePlan(paths, copyPlan);
    assertCronCloneTopology(topology());
    fs.mkdirSync(cloneRoot, { recursive: false, mode: 0o700 });
    cloneIdentity = privateDirectoryIdentity(cloneRoot);
    assertCronCloneTopology(topology());
    mutate(() => fs.mkdirSync(stateRoot, { recursive: false, mode: 0o700 }));
    stateIdentity = privateDirectoryIdentity(stateRoot);
    assertCronCloneTopology(topology());
    const cloneConfig = path.join(cloneRoot, 'openclaw.json');
    try {
      mutate(() => {
        const bytes = Buffer.from('{}\n');
        writeBytesExclusiveDurable(
          cloneConfig, bytes, 0o600, { ensureParent: false },
        );
        const record = readCronCleanupFileRecord(cloneConfig, { maxBytes: bytes.length });
        if (!record.bytes.equals(bytes)) fail('CRON_WORKER_LIFECYCLE_INVALID');
        createdFiles.push({
          path: cloneConfig, identity: record.identity, sha256: sha256(record.bytes),
        });
      });
    } catch (error) {
      try { error.cronCloneDestinationUnbound = Boolean(lstatIfPresent(cloneConfig)); } catch {
        error.cronCloneDestinationUnbound = true;
      }
      throw error;
    }
    const target = path.join(stateRoot, 'openclaw.sqlite');
    for (const member of copyPlan) {
      const destination = `${target}${member.suffix}`;
      const copied = mutate(() => copyCronCloneFileExclusiveDurable(
        member.source, destination, member.identity, member.sha256,
      ));
      createdFiles.push({ path: destination, ...copied });
    }
    assertCronCloneSourcePlan(paths, copyPlan);
    mutate(() => fsyncDirectory(stateRoot));
    mutate(() => fsyncDirectory(cloneRoot));
    mutate(() => fsyncDirectory(parent));
    assertCronCloneTopology(topology());
    assertCronCloneCreatedFiles(createdFiles);
    return {
      path: cloneRoot,
      identity: cloneIdentity,
      stateIdentity,
      parentIdentity,
    };
  } catch (error) {
    if (error?.cronCloneDestinationUnbound !== true
        && cloneIdentity && stateIdentity
        && samePrivateDirectoryIdentity(cloneRoot, cloneIdentity)
        && samePrivateDirectoryIdentity(stateRoot, stateIdentity)
        && samePrivateDirectoryIdentity(parent, parentIdentity)) {
      try {
        assertCronCloneCreatedFiles(createdFiles);
        removePrivateDirectoryIdentity(
          paths, cloneIdentity, 'CRON_WORKER_LIFECYCLE_INVALID',
          {
            nestedIdentities: stateIdentity
              ? [{ relative: 'state', identity: stateIdentity }] : [],
            expectedSourceParentIdentity: parentIdentity,
          },
        );
      } catch {}
    }
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
}

function verifyAndCheckpointCronStore(paths) {
  const databasePath = path.join(paths.stateDir, 'state/openclaw.sqlite');
  if (!lstatIfPresent(databasePath)) fail('CRON_STORE_INVALID');
  const Database = resolveDatabase(paths);
  let database;
  try {
    database = new Database(databasePath, { fileMustExist: true });
    const checked = database.pragma('quick_check');
    if (checked?.[0]?.quick_check !== 'ok') fail('CRON_STORE_INVALID');
    database.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_STORE_INVALID');
  } finally {
    database?.close();
  }
}

function cronWorkerScratchPath(paths, txId, epoch) {
  if (typeof txId !== 'string' || !/^tx-[0-9a-f-]{36}$/.test(txId)
      || typeof epoch !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(epoch)) {
    fail('CRON_WORKER_FAILED');
  }
  return path.join(
    txRoot(paths, txId),
    `.rc-bootstrap-worker-${txId}-${epoch}`,
  );
}

function privateDirectoryIdentity(target, code = 'CRON_WORKER_FAILED') {
  let metadata;
  try { metadata = fs.lstatSync(target, { bigint: true }); } catch { fail(code); }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(code);
  const mode = process.platform === 'win32' ? null : Number(metadata.mode & 0o7777n);
  const uid = Number(metadata.uid);
  if (process.platform !== 'win32' && (mode !== 0o700
      || (typeof process.getuid === 'function' && uid !== process.getuid()))) fail(code);
  return {
    path: target,
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode,
    uid,
  };
}

function samePrivateDirectoryIdentity(target, identity) {
  let metadata;
  try { metadata = fs.lstatSync(target, { bigint: true }); } catch { return false; }
  return !metadata.isSymbolicLink() && metadata.isDirectory()
    && metadata.dev.toString() === identity.dev && metadata.ino.toString() === identity.ino
    && (process.platform === 'win32' || (Number(metadata.mode & 0o7777n) === identity.mode
      && (typeof process.getuid !== 'function' || Number(metadata.uid) === identity.uid)));
}

function cronCleanupQuarantineRoot(paths) {
  return path.join(bootstrapRoot(paths), 'cron-worker-cleanup-quarantine');
}

function serialDirectoryIdentity(identity) {
  return {
    dev: String(identity.dev),
    ino: String(identity.ino),
    mode: identity.mode,
    uid: identity.uid,
  };
}

function cronCleanupDirectoryIdentity(target, code = 'CRON_WORKER_LIFECYCLE_INVALID') {
  let metadata;
  try { metadata = fs.lstatSync(target, { bigint: true }); } catch { fail(code); }
  const mode = process.platform === 'win32' ? null : Number(metadata.mode & 0o7777n);
  const uid = Number(metadata.uid);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
      || (process.platform !== 'win32' && (mode !== 0o700
        || (typeof process.getuid === 'function' && uid !== process.getuid())))) fail(code);
  return {
    path: target,
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode,
    uid,
  };
}

function validSerialDirectoryIdentity(identity) {
  return exactKeys(identity, ['dev', 'ino', 'mode', 'uid'])
    && typeof identity.dev === 'string' && /^\d+$/.test(identity.dev)
    && typeof identity.ino === 'string' && /^\d+$/.test(identity.ino)
    && Number.isSafeInteger(identity.uid)
    && (process.platform === 'win32'
      ? identity.mode === null
      : identity.mode === 0o700
        && (typeof process.getuid !== 'function' || identity.uid === process.getuid()));
}

function sameSerialDirectoryIdentity(target, identity) {
  if (!validSerialDirectoryIdentity(identity)) return false;
  try {
    return equal(serialDirectoryIdentity(cronCleanupDirectoryIdentity(target)), identity);
  } catch {
    return false;
  }
}

function observedPathIdentity(target) {
  const metadata = lstatIfPresent(target);
  if (!metadata) return { present: false };
  return {
    present: true,
    type: metadata.isSymbolicLink() ? 'symlink'
      : metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other',
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    nlink: metadata.nlink,
    mode: process.platform === 'win32' ? null : metadata.mode & 0o7777,
    uid: metadata.uid,
  };
}

function cronCleanupSourceSpec(paths, source) {
  const relative = path.relative(transactionsRoot(paths), source);
  const parts = relative.split(path.sep);
  if (relative.startsWith('..') || path.isAbsolute(relative) || parts.length !== 2
      || !/^tx-[0-9a-f-]{36}$/.test(parts[0])) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const txId = parts[0];
  const scratchPrefix = `.rc-bootstrap-worker-${txId}-`;
  const epoch = parts[1].startsWith(scratchPrefix)
    ? parts[1].slice(scratchPrefix.length) : null;
  if (parts[1] === 'cron-clone') return { txId, kind: 'clone', epoch: null, relative };
  if (!epoch || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(epoch)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return { txId, kind: 'scratch', epoch, relative };
}

const CRON_CLEANUP_UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CRON_CLEANUP_ARTIFACT_PREFIX = 'cron-worker-cleanup-';
const CRON_CLEANUP_INVENTORY_NAME = new RegExp(
  `^cron-worker-cleanup-inventory-(clone|scratch-(${CRON_CLEANUP_UUID_SOURCE}))-([0-9a-f]{64})\\.(json|staging)$`,
);
const CRON_CLEANUP_ARTIFACT_NAME = new RegExp(
  `^cron-worker-cleanup-(reservation|authority|delete-authority|done)-(clone|scratch-(${CRON_CLEANUP_UUID_SOURCE}))\\.(json|staging)$`,
);
const CRON_CLEANUP_CONTAINER_NAME = new RegExp(`^\\.cleanup-(${CRON_CLEANUP_UUID_SOURCE})$`);
const CRON_CLEANUP_FILE_MAX_BYTES = 64 * 1024;
const CRON_CLEANUP_INVENTORY_MAX_BYTES = 4 * 1024 * 1024;
const CRON_CLEANUP_DONE_MAX_BYTES = 8 * 1024 * 1024;
const CRON_CLEANUP_TREE_MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const CRON_CLEANUP_TREE_MAX_PATH_BYTES = 1024 * 1024;
const CRON_CLEANUP_TREE_MAX_ENTRIES = 4096;
const CRON_CLEANUP_TREE_MAX_DEPTH = 64;
const CRON_CLEANUP_PROJECTED_HASH_BYTES = 1024 * 1024 * 1024;
const CRON_CLEANUP_PROJECTED_ENTRY_VISITS = 1_000_000;
const CRON_CLEANUP_BATCH_PROJECTED_HASH_BYTES = 2 * CRON_CLEANUP_PROJECTED_HASH_BYTES;
const CRON_CLEANUP_BATCH_PROJECTED_ENTRY_VISITS = 2 * CRON_CLEANUP_PROJECTED_ENTRY_VISITS;
const CRON_CLEANUP_PROJECTED_SCAN_MULTIPLIER = 3;
// Covers the fixed I/R/A/intent/D/done create, link, normalize, move, and
// teardown refreshes before the per-entry deletion rank begins to dominate.
const CRON_CLEANUP_PROJECTED_SCAN_OVERHEAD = 64;
// Conservative admission multiplier for every full-batch inventory control
// scan. It upper-bounds JSON parse, canonical stringify/compare, stable
// valueHash construction+hash, direct SHA checks, and nested done validation;
// it is intentionally much larger than the current implementation's passes.
const CRON_CLEANUP_PROJECTED_INVENTORY_BYTE_PASSES = 64;
const CRON_CLEANUP_MAX_ARTIFACTS = 2;
const CRON_CLEANUP_DISCOVERY_MAX_ENTRIES = 8192;

function cronCleanupEnumerationBudget(limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return { limit, seen: 0 };
}

function cronCleanupReadDirectoryNames(
  directory,
  budget = cronCleanupEnumerationBudget(CRON_CLEANUP_DISCOVERY_MAX_ENTRIES),
  localLimit = budget.limit,
  onName,
) {
  if (!isObject(budget) || !Number.isSafeInteger(budget.limit) || budget.limit < 0
      || !Number.isSafeInteger(budget.seen) || budget.seen < 0
      || !Number.isSafeInteger(localLimit) || localLimit < 0
      || (onName !== undefined && typeof onName !== 'function')) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const names = [];
  let handle;
  try {
    handle = fs.opendirSync(directory);
    let entry;
    while ((entry = handle.readSync()) !== null) {
      budget.seen += 1;
      if (budget.seen > budget.limit || names.length >= localLimit) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      onName?.(entry.name);
      names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  } finally {
    try { handle?.closeSync(); } catch {}
  }
  return names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function cronCleanupQuarantineNames(directory) {
  return cronCleanupReadDirectoryNames(
    directory,
    cronCleanupEnumerationBudget(CRON_CLEANUP_MAX_ARTIFACTS),
    CRON_CLEANUP_MAX_ARTIFACTS,
  );
}

function cronCleanupContainerNames(directory) {
  return cronCleanupReadDirectoryNames(
    directory, cronCleanupEnumerationBudget(3), 3,
  );
}

function assertNoUnboundCronCleanupSources(paths, boundSources = new Set()) {
  if (!(boundSources instanceof Set)
      || [...boundSources].some((source) => typeof source !== 'string')) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const root = transactionsRoot(paths);
  const metadata = lstatIfPresent(root);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const budget = cronCleanupEnumerationBudget(CRON_CLEANUP_DISCOVERY_MAX_ENTRIES);
  for (const txId of cronCleanupReadDirectoryNames(
    root, budget, CRON_CLEANUP_DISCOVERY_MAX_ENTRIES,
  )) {
    const transaction = path.join(root, txId);
    const transactionMetadata = lstatIfPresent(transaction);
    if (!transactionMetadata || transactionMetadata.isSymbolicLink()
        || !transactionMetadata.isDirectory()) continue;
    for (const name of cronCleanupReadDirectoryNames(
      transaction, budget, CRON_CLEANUP_DISCOVERY_MAX_ENTRIES,
    )) {
      const candidate = path.join(transaction, name);
      if ((name === 'cron-clone' || name.startsWith('.rc-bootstrap-worker-'))
          && !boundSources.has(candidate)) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
    }
  }
}

function cronCleanupSafeAdd(left, right) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return value;
}

function cronCleanupSafeMultiply(left, right) {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return value;
}

function compareCronCleanupRelative(left, right) {
  const depth = cronCleanupEntryDepth(right) - cronCleanupEntryDepth(left);
  return depth || Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function cronCleanupProjectedWork(entries) {
  const ordered = entries.filter((entry) => entry.relative !== '')
    .sort((left, right) => compareCronCleanupRelative(left.relative, right.relative));
  const rank = new Map(ordered.map((entry, index) => [entry.relative, index + 1]));
  rank.set('', ordered.length + 1);
  const scanWeight = cronCleanupSafeAdd(
    cronCleanupSafeMultiply(entries.length, CRON_CLEANUP_PROJECTED_SCAN_MULTIPLIER),
    CRON_CLEANUP_PROJECTED_SCAN_OVERHEAD,
  );
  let contentHashBytes = 0;
  let remainingTreeEntryVisits = 0;
  let contentBytes = 0;
  for (const entry of entries) {
    const visits = cronCleanupSafeAdd(
      cronCleanupSafeMultiply(
        rank.get(entry.relative) ?? ordered.length + 1,
        CRON_CLEANUP_PROJECTED_SCAN_MULTIPLIER,
      ),
      CRON_CLEANUP_PROJECTED_SCAN_OVERHEAD,
    );
    remainingTreeEntryVisits = cronCleanupSafeAdd(remainingTreeEntryVisits, visits);
    if (entry.type === 'file') {
      contentBytes = cronCleanupSafeAdd(contentBytes, entry.size);
      contentHashBytes = cronCleanupSafeAdd(
        contentHashBytes, cronCleanupSafeMultiply(entry.size, visits),
      );
    }
  }
  if (contentHashBytes > CRON_CLEANUP_PROJECTED_HASH_BYTES
      || remainingTreeEntryVisits > CRON_CLEANUP_PROJECTED_ENTRY_VISITS) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return { contentBytes, contentHashBytes, remainingTreeEntryVisits, scanWeight };
}

function cronCleanupProjectedBatchWork(projectedInventories) {
  const projections = projectedInventories.map(({ inventory, inventoryBytes }) => {
    if (!Number.isSafeInteger(inventoryBytes) || inventoryBytes < 0
        || inventoryBytes > CRON_CLEANUP_INVENTORY_MAX_BYTES) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    return { inventory, inventoryBytes, own: cronCleanupProjectedWork(inventory.entries) };
  });
  const totalScanWeight = projections.reduce(
    (sum, projection) => cronCleanupSafeAdd(sum, projection.own.scanWeight), 0,
  );
  let hashedBytes = 0;
  let entryVisits = 0;
  for (const { inventory, inventoryBytes, own } of projections) {
    const externalScans = totalScanWeight - own.scanWeight;
    // Units are bytes processed and entry validations. Content hashing follows
    // each entry's remaining-payload rank; a different artifact's mutations
    // conservatively keep this payload live. Inventory schema validation and
    // canonical/hash byte passes occur on every full-batch scan, including
    // scans caused by the other artifact.
    const ownHashedBytes = cronCleanupSafeAdd(
      own.contentHashBytes,
      cronCleanupSafeMultiply(
        cronCleanupSafeMultiply(inventoryBytes, own.scanWeight),
        CRON_CLEANUP_PROJECTED_INVENTORY_BYTE_PASSES,
      ),
    );
    const ownEntryVisits = cronCleanupSafeAdd(
      own.remainingTreeEntryVisits,
      cronCleanupSafeMultiply(inventory.entries.length, own.scanWeight),
    );
    if (ownHashedBytes > CRON_CLEANUP_PROJECTED_HASH_BYTES
        || ownEntryVisits > CRON_CLEANUP_PROJECTED_ENTRY_VISITS) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const externalHashedBytes = cronCleanupSafeAdd(
      cronCleanupSafeMultiply(own.contentBytes, externalScans),
      cronCleanupSafeMultiply(
        cronCleanupSafeMultiply(inventoryBytes, externalScans),
        CRON_CLEANUP_PROJECTED_INVENTORY_BYTE_PASSES,
      ),
    );
    const externalEntryVisits = cronCleanupSafeMultiply(
      inventory.entries.length, externalScans,
    );
    hashedBytes = cronCleanupSafeAdd(
      hashedBytes, cronCleanupSafeAdd(ownHashedBytes, externalHashedBytes),
    );
    entryVisits = cronCleanupSafeAdd(
      entryVisits, cronCleanupSafeAdd(ownEntryVisits, externalEntryVisits),
    );
  }
  if (hashedBytes > CRON_CLEANUP_BATCH_PROJECTED_HASH_BYTES
      || entryVisits > CRON_CLEANUP_BATCH_PROJECTED_ENTRY_VISITS) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return { hashedBytes, entryVisits };
}

function cronCleanupAuthoritySpec(paths, txId, kind, epoch, inventorySha256 = null) {
  if (typeof txId !== 'string' || !/^tx-[0-9a-f-]{36}$/.test(txId)
      || !['clone', 'scratch'].includes(kind)
      || (kind === 'clone' ? epoch !== null
        : typeof epoch !== 'string' || !(new RegExp(`^${CRON_CLEANUP_UUID_SOURCE}$`)).test(epoch))
      || (inventorySha256 !== null && (typeof inventorySha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(inventorySha256)))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const suffix = kind === 'clone' ? 'clone' : `scratch-${epoch}`;
  const root = txRoot(paths, txId);
  const sourceName = kind === 'clone'
    ? 'cron-clone' : `.rc-bootstrap-worker-${txId}-${epoch}`;
  const inventoryStem = inventorySha256
    ? `cron-worker-cleanup-inventory-${suffix}-${inventorySha256}` : null;
  return {
    txId,
    kind,
    epoch,
    root,
    source: path.join(root, sourceName),
    sourceRelative: path.join(txId, sourceName),
    inventorySha256,
    inventoryFile: inventoryStem ? path.join(root, `${inventoryStem}.json`) : null,
    inventoryStagingFile: inventoryStem ? path.join(root, `${inventoryStem}.staging`) : null,
    reservationFile: path.join(root, `cron-worker-cleanup-reservation-${suffix}.json`),
    reservationStagingFile: path.join(root, `cron-worker-cleanup-reservation-${suffix}.staging`),
    finalFile: path.join(root, `cron-worker-cleanup-authority-${suffix}.json`),
    stagingFile: path.join(root, `cron-worker-cleanup-authority-${suffix}.staging`),
    deleteFile: path.join(root, `cron-worker-cleanup-delete-authority-${suffix}.json`),
    deleteStagingFile: path.join(root, `cron-worker-cleanup-delete-authority-${suffix}.staging`),
    doneFile: path.join(root, `cron-worker-cleanup-done-${suffix}.json`),
    doneStagingFile: path.join(root, `cron-worker-cleanup-done-${suffix}.staging`),
  };
}

function parseCronCleanupArtifactName(paths, txId, name) {
  const inventoryMatch = CRON_CLEANUP_INVENTORY_NAME.exec(name);
  if (inventoryMatch) {
    const kind = inventoryMatch[1] === 'clone' ? 'clone' : 'scratch';
    const epoch = kind === 'clone' ? null : inventoryMatch[2];
    return {
      ...cronCleanupAuthoritySpec(paths, txId, kind, epoch, inventoryMatch[3]),
      layer: 'inventory',
      publication: inventoryMatch[4],
    };
  }
  const match = CRON_CLEANUP_ARTIFACT_NAME.exec(name);
  if (!match) return null;
  const layer = match[1];
  const kind = match[2] === 'clone' ? 'clone' : 'scratch';
  const epoch = kind === 'clone' ? null : match[3];
  const publication = match[4];
  return { ...cronCleanupAuthoritySpec(paths, txId, kind, epoch), layer, publication };
}

function sameCronCleanupFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.nlink === right.nlink && left.size === right.size
    && left.mode === right.mode && left.uid === right.uid;
}

function cronCleanupFileIdentity(metadata) {
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    nlink: Number(metadata.nlink),
    size: Number(metadata.size),
    mode: Number(metadata.mode),
    uid: Number(metadata.uid),
  };
}

function readCronCleanupFileRecord(file, { expectedNlink = 1, maxBytes = CRON_CLEANUP_FILE_MAX_BYTES } = {}) {
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); } catch { fail('CRON_WORKER_LIFECYCLE_INVALID'); }
  const beforeIdentity = cronCleanupFileIdentity(before);
  const privateFile = !before.isSymbolicLink() && before.isFile()
    && before.nlink === BigInt(expectedNlink) && before.size >= 0n
    && before.size <= BigInt(maxBytes)
    && (process.platform === 'win32' || (Number(before.mode & 0o7777n) === 0o600
      && (typeof process.getuid !== 'function' || Number(before.uid) === process.getuid())));
  if (!privateFile) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, flags);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const openedIdentity = cronCleanupFileIdentity(opened);
    if (!opened.isFile() || !sameCronCleanupFileIdentity(openedIdentity, beforeIdentity)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const bytes = Buffer.alloc(openedIdentity.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    let atPath;
    try { atPath = fs.lstatSync(file, { bigint: true }); } catch {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    if (atPath.isSymbolicLink() || !atPath.isFile()
        || !sameCronCleanupFileIdentity(cronCleanupFileIdentity(after), openedIdentity)
        || !sameCronCleanupFileIdentity(cronCleanupFileIdentity(atPath), openedIdentity)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    return {
      bytes,
      identity: openedIdentity,
    };
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function unlinkCronCleanupFileRecord(
  file, identity, { expectedNlink = 1, expectedBytes } = {},
) {
  if (!Buffer.isBuffer(expectedBytes)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const current = readCronCleanupFileRecord(file, { expectedNlink, maxBytes: Math.max(
    CRON_CLEANUP_DONE_MAX_BYTES, identity.size,
  ) });
  if (!sameCronCleanupFileIdentity(current.identity, identity)
      || !current.bytes.equals(expectedBytes)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  fs.unlinkSync(file);
}

function cronCleanupTreeMetadata(target, relative, counters) {
  let before;
  try { before = fs.lstatSync(target, { bigint: true }); } catch {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const beforeMode = Number(before.mode & 0o7777n);
  const beforeUid = Number(before.uid);
  if (before.isSymbolicLink()
      || (process.platform !== 'win32' && ((beforeMode & 0o7000) !== 0
        || (typeof process.getuid === 'function' && beforeUid !== process.getuid())))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  counters.entries += 1;
  counters.pathBytes += Buffer.byteLength(relative);
  if (counters.entries > CRON_CLEANUP_TREE_MAX_ENTRIES
      || counters.pathBytes > CRON_CLEANUP_TREE_MAX_PATH_BYTES) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const common = {
    relative,
    dev: before.dev.toString(),
    ino: before.ino.toString(),
    mode: process.platform === 'win32' ? null : beforeMode,
    uid: beforeUid,
  };
  if (before.isDirectory()) return { ...common, type: 'directory' };
  if (!before.isFile() || before.nlink !== 1n || before.size < 0n
      || before.size > BigInt(CRON_CLEANUP_TREE_MAX_CONTENT_BYTES)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const beforeSize = Number(before.size);
  counters.contentBytes += beforeSize;
  if (counters.contentBytes > CRON_CLEANUP_TREE_MAX_CONTENT_BYTES) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(target, flags);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev
        || opened.ino !== before.ino || opened.size !== before.size
        || opened.mode !== before.mode || opened.uid !== before.uid) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const hash = crypto.createHash('sha256');
    const openedSize = Number(opened.size);
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, openedSize)));
    let offset = 0;
    while (offset < openedSize) {
      const count = fs.readSync(
        descriptor, buffer, 0, Math.min(buffer.length, openedSize - offset), offset,
      );
      if (count <= 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    let atPath;
    try { atPath = fs.lstatSync(target, { bigint: true }); } catch {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    if (atPath.isSymbolicLink() || !atPath.isFile()
        || atPath.nlink !== 1n || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || atPath.dev !== opened.dev || atPath.ino !== opened.ino
        || atPath.size !== opened.size || atPath.mode !== opened.mode || atPath.uid !== opened.uid) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    return {
      ...common,
      type: 'file',
      nlink: 1,
      size: openedSize,
      sha256: hash.digest('hex'),
    };
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function captureCronCleanupTree(root) {
  const entries = [];
  const counters = { entries: 0, pathBytes: 0, contentBytes: 0 };
  const enumerationBudget = cronCleanupEnumerationBudget(CRON_CLEANUP_TREE_MAX_ENTRIES - 1);
  const visit = (target, relative, depth) => {
    if (depth > CRON_CLEANUP_TREE_MAX_DEPTH) fail('CRON_WORKER_LIFECYCLE_INVALID');
    const entry = cronCleanupTreeMetadata(target, relative, counters);
    entries.push(entry);
    if (entry.type === 'directory') {
      const remaining = CRON_CLEANUP_TREE_MAX_ENTRIES - counters.entries;
      for (const name of cronCleanupReadDirectoryNames(
        target, enumerationBudget, Math.max(0, remaining),
      )) {
        visit(path.join(target, name), relative ? path.join(relative, name) : name, depth + 1);
      }
    }
  };
  visit(root, '', 0);
  return { entries, totalBytes: counters.contentBytes, pathBytes: counters.pathBytes };
}

function cronCleanupInventoryForSpec(paths, spec, expectedSourceParentIdentity = null) {
  const sourceParentIdentity = expectedSourceParentIdentity
    ? serialDirectoryIdentity(expectedSourceParentIdentity)
    : serialDirectoryIdentity(cronCleanupDirectoryIdentity(
      spec.root, 'CRON_WORKER_LIFECYCLE_INVALID',
    ));
  if (!validSerialDirectoryIdentity(sourceParentIdentity)
      || !sameSerialDirectoryIdentity(spec.root, sourceParentIdentity)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const captured = captureCronCleanupTree(spec.source);
  if (!sameSerialDirectoryIdentity(spec.root, sourceParentIdentity)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const body = {
    version: 1,
    txId: spec.txId,
    kind: spec.kind,
    epoch: spec.epoch,
    pathsHash: pathsHash(paths),
    source: spec.sourceRelative,
    sourceParentIdentity,
    entries: captured.entries,
    totalBytes: captured.totalBytes,
    pathBytes: captured.pathBytes,
  };
  const value = { ...body, digest: valueHash(body) };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > CRON_CLEANUP_INVENTORY_MAX_BYTES) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  cronCleanupProjectedBatchWork([{ inventory: value, inventoryBytes: bytes.length }]);
  return { value, bytes };
}

function cronCleanupInventoryValue(
  paths, identity, nestedIdentities, expectedSourceParentIdentity,
) {
  const source = cronCleanupSourceSpec(paths, identity.path);
  if (!isObject(expectedSourceParentIdentity)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const expectedNested = nestedIdentities.map((item) => {
    if (!isObject(item) || typeof item.relative !== 'string' || item.relative.length === 0
        || item.relative.includes('\0') || path.isAbsolute(item.relative)
        || path.normalize(item.relative) !== item.relative
        || item.relative === '..' || item.relative.startsWith(`..${path.sep}`)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const target = path.join(identity.path, item.relative);
    if (!isInside(identity.path, target)) fail('CRON_WORKER_LIFECYCLE_INVALID');
    return { ...item, target };
  });
  if (!validSerialDirectoryIdentity(serialDirectoryIdentity(expectedSourceParentIdentity))
      || !sameSerialDirectoryIdentity(
        txRoot(paths, source.txId), serialDirectoryIdentity(expectedSourceParentIdentity),
      ) || !samePrivateDirectoryIdentity(identity.path, identity)
      || !expectedNested.every((item) => samePrivateDirectoryIdentity(
        item.target, item.identity,
      ))) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const inventory = cronCleanupInventoryForSpec(
    paths, cronCleanupAuthoritySpec(paths, source.txId, source.kind, source.epoch),
    expectedSourceParentIdentity,
  );
  const byRelative = new Map(inventory.value.entries.map((entry) => [entry.relative, entry]));
  const rootEntry = byRelative.get('');
  if (!rootEntry || !equal(
    { dev: rootEntry.dev, ino: rootEntry.ino, mode: rootEntry.mode, uid: rootEntry.uid },
    serialDirectoryIdentity(identity),
  ) || !expectedNested.every((item) => {
    const entry = byRelative.get(item.relative);
    return entry?.type === 'directory' && equal(
      { dev: entry.dev, ino: entry.ino, mode: entry.mode, uid: entry.uid },
      serialDirectoryIdentity(item.identity),
    );
  }) || !samePrivateDirectoryIdentity(identity.path, identity)
      || !expectedNested.every((item) => samePrivateDirectoryIdentity(
        item.target, item.identity,
      ))) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return inventory;
}

function parseCronCleanupCanonicalJson(record) {
  let value;
  try { value = JSON.parse(record.bytes.toString('utf8')); } catch {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  if (!record.bytes.equals(cronCleanupJsonBytes(value))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return value;
}

function assertCronCleanupCanonicalRecord(record, value) {
  if (!record.bytes.equals(cronCleanupJsonBytes(value))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return value;
}

function validCronCleanupInventoryEntry(entry) {
  if (!isObject(entry) || typeof entry.relative !== 'string'
      || entry.relative.includes('\0') || path.isAbsolute(entry.relative)
      || (entry.relative !== '' && (entry.relative === '..'
        || entry.relative.startsWith(`..${path.sep}`)
        || path.normalize(entry.relative) !== entry.relative))
      || typeof entry.dev !== 'string' || !/^\d+$/.test(entry.dev)
      || typeof entry.ino !== 'string' || !/^\d+$/.test(entry.ino)
      || !Number.isSafeInteger(entry.uid)
      || (process.platform === 'win32'
        ? entry.mode !== null
        : !Number.isSafeInteger(entry.mode) || (entry.mode & 0o7000) !== 0
          || (typeof process.getuid === 'function' && entry.uid !== process.getuid()))) return false;
  if (entry.type === 'directory') {
    return exactKeys(entry, ['relative', 'type', 'dev', 'ino', 'mode', 'uid']);
  }
  return entry.type === 'file'
    && exactKeys(entry, [
      'relative', 'type', 'dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'sha256',
    ])
    && entry.nlink === 1 && Number.isSafeInteger(entry.size) && entry.size >= 0
    && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256);
}

function validateCronCleanupInventory(paths, spec, value) {
  if (!exactKeys(value, [
    'version', 'txId', 'kind', 'epoch', 'pathsHash', 'source', 'sourceParentIdentity', 'entries',
    'totalBytes', 'pathBytes', 'digest',
  ]) || value.version !== 1 || value.txId !== spec.txId || value.kind !== spec.kind
      || value.epoch !== spec.epoch || value.pathsHash !== pathsHash(paths)
      || value.source !== spec.sourceRelative
      || !validSerialDirectoryIdentity(value.sourceParentIdentity)
      || !sameSerialDirectoryIdentity(spec.root, value.sourceParentIdentity)
      || !Array.isArray(value.entries)
      || value.entries.length < 1 || value.entries.length > CRON_CLEANUP_TREE_MAX_ENTRIES
      || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0
      || value.totalBytes > CRON_CLEANUP_TREE_MAX_CONTENT_BYTES
      || !Number.isSafeInteger(value.pathBytes) || value.pathBytes < 0
      || value.pathBytes > CRON_CLEANUP_TREE_MAX_PATH_BYTES) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const entryByRelative = new Map();
  let totalBytes = 0;
  let pathBytes = 0;
  for (const entry of value.entries) {
    if (!validCronCleanupInventoryEntry(entry) || entryByRelative.has(entry.relative)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    entryByRelative.set(entry.relative, entry);
    pathBytes = cronCleanupSafeAdd(pathBytes, Buffer.byteLength(entry.relative));
    if (entry.type === 'file') totalBytes = cronCleanupSafeAdd(totalBytes, entry.size);
    const depth = entry.relative === '' ? 0 : entry.relative.split(path.sep).length;
    if (depth > CRON_CLEANUP_TREE_MAX_DEPTH) fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const rootEntry = entryByRelative.get('');
  if (!rootEntry || rootEntry.type !== 'directory' || value.entries[0] !== rootEntry
      || totalBytes !== value.totalBytes || pathBytes !== value.pathBytes) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  for (const entry of value.entries) {
    if (entry.relative === '') continue;
    const parent = path.dirname(entry.relative);
    const parentRelative = parent === '.' ? '' : parent;
    const parentEntry = entryByRelative.get(parentRelative);
    if (!parentEntry || parentEntry.type !== 'directory') {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
  }
  const entries = value.entries.map((entry) => entry.type === 'directory' ? {
    relative: entry.relative,
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    uid: entry.uid,
    type: 'directory',
  } : {
    relative: entry.relative,
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    uid: entry.uid,
    type: 'file',
    nlink: entry.nlink,
    size: entry.size,
    sha256: entry.sha256,
  });
  const body = {
    version: value.version,
    txId: value.txId,
    kind: value.kind,
    epoch: value.epoch,
    pathsHash: value.pathsHash,
    source: value.source,
    sourceParentIdentity: serialDirectoryIdentity(value.sourceParentIdentity),
    entries,
    totalBytes: value.totalBytes,
    pathBytes: value.pathBytes,
  };
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)
      || value.digest !== valueHash(body)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const inventory = { ...body, digest: value.digest };
  cronCleanupProjectedBatchWork([{
    inventory,
    inventoryBytes: cronCleanupJsonBytes(inventory).length,
  }]);
  return inventory;
}

function parseCronCleanupInventory(paths, spec, record) {
  const value = parseCronCleanupCanonicalJson(record);
  const inventory = assertCronCleanupCanonicalRecord(
    record, validateCronCleanupInventory(paths, spec, value),
  );
  if (spec.inventorySha256 && sha256(record.bytes) !== spec.inventorySha256) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return inventory;
}

function cronCleanupTreeState(root, inventory, { complete = false } = {}) {
  const rootMetadata = lstatIfPresent(root);
  if (!rootMetadata) return { present: false, complete: false, remaining: [] };
  const expected = new Map(inventory.entries.map((entry) => [entry.relative, entry]));
  const captured = captureCronCleanupTree(root);
  const remaining = [];
  for (const actual of captured.entries) {
    const bound = expected.get(actual.relative);
    if (!bound || !equal(actual, bound)) fail('CRON_WORKER_LIFECYCLE_INVALID');
    remaining.push(actual.relative);
  }
  if (complete && remaining.length !== inventory.entries.length) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return {
    present: true,
    complete: remaining.length === inventory.entries.length,
    remaining,
  };
}

function deterministicCronCleanupId(inventory) {
  const hex = sha256(Buffer.from(
    `${inventory.txId}\0${inventory.kind}\0${inventory.epoch ?? ''}\0${inventory.digest}`,
  ));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}`
    + `-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`
    + `-${hex.slice(20, 32)}`;
}

function cronCleanupReservationValue(paths, inventory, inventoryRecord) {
  const cleanupId = deterministicCronCleanupId(inventory);
  const quarantineRoot = cronCleanupQuarantineRoot(paths);
  const rootIdentity = cronCleanupDirectoryIdentity(
    quarantineRoot, 'CRON_WORKER_LIFECYCLE_INVALID',
  );
  const rootEntry = inventory.entries[0];
  const nested = [];
  const body = {
    version: 1,
    cleanupId,
    txId: inventory.txId,
    kind: inventory.kind,
    epoch: inventory.epoch,
    pathsHash: pathsHash(paths),
    container: `.cleanup-${cleanupId}`,
    source: inventory.source,
    sourceParentIdentity: serialDirectoryIdentity(inventory.sourceParentIdentity),
    sourceIdentity: {
      dev: rootEntry.dev, ino: rootEntry.ino, mode: rootEntry.mode, uid: rootEntry.uid,
    },
    nested,
    quarantineRootIdentity: serialDirectoryIdentity(rootIdentity),
    inventoryBytes: inventoryRecord.bytes.length,
    inventorySha256: sha256(inventoryRecord.bytes),
    inventoryDigest: inventory.digest,
  };
  return { ...body, digest: valueHash(body) };
}

function validateCronCleanupReservation(paths, spec, inventory, inventoryRecord, value) {
  if (!exactKeys(value, [
    'version', 'cleanupId', 'txId', 'kind', 'epoch', 'pathsHash', 'container',
    'source', 'sourceParentIdentity', 'sourceIdentity', 'nested',
    'quarantineRootIdentity', 'inventoryBytes', 'inventorySha256', 'inventoryDigest', 'digest',
  ]) || value.version !== 1 || value.txId !== spec.txId || value.kind !== spec.kind
      || value.epoch !== spec.epoch || value.pathsHash !== pathsHash(paths)
      || typeof value.cleanupId !== 'string'
      || !(new RegExp(`^${CRON_CLEANUP_UUID_SOURCE}$`)).test(value.cleanupId)
      || value.cleanupId !== deterministicCronCleanupId(inventory)
      || value.container !== `.cleanup-${value.cleanupId}` || value.source !== spec.sourceRelative
      || !validSerialDirectoryIdentity(value.sourceParentIdentity)
      || !validSerialDirectoryIdentity(value.sourceIdentity)
      || !Array.isArray(value.nested) || value.nested.length !== 0
      || !validSerialDirectoryIdentity(value.quarantineRootIdentity)
      || value.inventoryBytes !== inventoryRecord.bytes.length
      || value.inventorySha256 !== sha256(inventoryRecord.bytes)
      || value.inventoryDigest !== inventory.digest
      || !sameSerialDirectoryIdentity(spec.root, value.sourceParentIdentity)
      || !sameSerialDirectoryIdentity(
        cronCleanupQuarantineRoot(paths), value.quarantineRootIdentity,
      )) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const rootEntry = inventory.entries[0];
  if (!equal(value.sourceIdentity, {
    dev: rootEntry.dev, ino: rootEntry.ino, mode: rootEntry.mode, uid: rootEntry.uid,
  })) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const body = { ...value };
  delete body.digest;
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)
      || value.digest !== valueHash(body)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const expected = cronCleanupReservationValue(paths, inventory, inventoryRecord);
  if (!equal(value, expected)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return expected;
}

function parseCronCleanupReservation(paths, spec, inventory, inventoryRecord, record) {
  const value = parseCronCleanupCanonicalJson(record);
  return assertCronCleanupCanonicalRecord(record, validateCronCleanupReservation(
    paths, spec, inventory, inventoryRecord, value,
  ));
}

function cronCleanupAuthorityValue(reservation, containerIdentity) {
  const body = {
    ...reservation,
    reservationDigest: reservation.digest,
    containerIdentity: serialDirectoryIdentity(containerIdentity),
  };
  delete body.digest;
  return { ...body, digest: valueHash(body) };
}

function validateCronCleanupAuthority(
  paths, spec, inventory, inventoryRecord, reservation, value,
  { allowContainerAbsent = false } = {},
) {
  const containerPath = path.join(cronCleanupQuarantineRoot(paths), reservation.container);
  const containerPresent = Boolean(lstatIfPresent(containerPath));
  const reservationKeys = [
    'version', 'cleanupId', 'txId', 'kind', 'epoch', 'pathsHash', 'container',
    'source', 'sourceParentIdentity', 'sourceIdentity', 'nested',
    'quarantineRootIdentity', 'inventoryBytes', 'inventorySha256', 'inventoryDigest',
  ];
  if (!exactKeys(value, [
    ...reservationKeys, 'reservationDigest', 'containerIdentity', 'digest',
  ]) || value.reservationDigest !== reservation.digest
      || !reservationKeys.every((key) => equal(value[key], reservation[key]))
      || !validSerialDirectoryIdentity(value.containerIdentity)
      || !sameSerialDirectoryIdentity(
        cronCleanupQuarantineRoot(paths), value.quarantineRootIdentity,
      )
      || ((!allowContainerAbsent || containerPresent)
        && !sameSerialDirectoryIdentity(containerPath, value.containerIdentity))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  validateCronCleanupReservation(paths, spec, inventory, inventoryRecord, {
    ...Object.fromEntries(reservationKeys.map((key) => [key, value[key]])),
    digest: value.reservationDigest,
  });
  const body = { ...value };
  delete body.digest;
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)
      || value.digest !== valueHash(body)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const expected = cronCleanupAuthorityValue(reservation, value.containerIdentity);
  if (!equal(value, expected)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return expected;
}

function parseCronCleanupAuthority(
  paths, spec, inventory, inventoryRecord, reservation, record, options,
) {
  const value = parseCronCleanupCanonicalJson(record);
  return assertCronCleanupCanonicalRecord(record, validateCronCleanupAuthority(
    paths, spec, inventory, inventoryRecord, reservation, value, options,
  ));
}

function cronCleanupDeleteAuthorityValue(runtime) {
  const body = {
    version: 1,
    txId: runtime.authority.txId,
    kind: runtime.authority.kind,
    epoch: runtime.authority.epoch,
    pathsHash: runtime.authority.pathsHash,
    source: runtime.authority.source,
    sourceParentIdentity: runtime.authority.sourceParentIdentity,
    container: runtime.authority.container,
    quarantineRootIdentity: runtime.authority.quarantineRootIdentity,
    containerIdentity: runtime.authority.containerIdentity,
    payloadIdentity: runtime.authority.sourceIdentity,
    inventoryBytes: runtime.authority.inventoryBytes,
    inventorySha256: runtime.authority.inventorySha256,
    inventoryDigest: runtime.authority.inventoryDigest,
    reservationDigest: runtime.authority.reservationDigest,
    authorityDigest: runtime.authority.digest,
    intentSha256: sha256(runtime.intent.record.bytes),
    intentDigest: valueHash(runtime.intent.value),
    canonical: 'absent',
  };
  return { ...body, digest: valueHash(body) };
}

function validateCronCleanupDeleteAuthority(paths, spec, value) {
  if (!exactKeys(value, [
    'version', 'txId', 'kind', 'epoch', 'pathsHash', 'source', 'sourceParentIdentity',
    'container', 'quarantineRootIdentity', 'containerIdentity', 'payloadIdentity',
    'inventoryBytes', 'inventorySha256', 'inventoryDigest', 'reservationDigest',
    'authorityDigest', 'intentSha256', 'intentDigest', 'canonical', 'digest',
  ]) || value.version !== 1 || value.txId !== spec.txId || value.kind !== spec.kind
      || value.epoch !== spec.epoch || value.pathsHash !== pathsHash(paths)
      || value.source !== spec.sourceRelative || value.canonical !== 'absent'
      || typeof value.container !== 'string' || !CRON_CLEANUP_CONTAINER_NAME.test(value.container)
      || !validSerialDirectoryIdentity(value.sourceParentIdentity)
      || !validSerialDirectoryIdentity(value.quarantineRootIdentity)
      || !validSerialDirectoryIdentity(value.containerIdentity)
      || !validSerialDirectoryIdentity(value.payloadIdentity)
      || !Number.isSafeInteger(value.inventoryBytes) || value.inventoryBytes < 1
      || value.inventoryBytes > CRON_CLEANUP_INVENTORY_MAX_BYTES
      || ![value.inventorySha256, value.inventoryDigest, value.reservationDigest,
        value.authorityDigest, value.intentSha256, value.intentDigest]
        .every((digest) => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))
      || !sameSerialDirectoryIdentity(spec.root, value.sourceParentIdentity)
      || !sameSerialDirectoryIdentity(
        cronCleanupQuarantineRoot(paths), value.quarantineRootIdentity,
      ) || lstatIfPresent(spec.source)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const body = { ...value };
  delete body.digest;
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)
      || value.digest !== valueHash(body)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return {
    version: value.version,
    txId: value.txId,
    kind: value.kind,
    epoch: value.epoch,
    pathsHash: value.pathsHash,
    source: value.source,
    sourceParentIdentity: serialDirectoryIdentity(value.sourceParentIdentity),
    container: value.container,
    quarantineRootIdentity: serialDirectoryIdentity(value.quarantineRootIdentity),
    containerIdentity: serialDirectoryIdentity(value.containerIdentity),
    payloadIdentity: serialDirectoryIdentity(value.payloadIdentity),
    inventoryBytes: value.inventoryBytes,
    inventorySha256: value.inventorySha256,
    inventoryDigest: value.inventoryDigest,
    reservationDigest: value.reservationDigest,
    authorityDigest: value.authorityDigest,
    intentSha256: value.intentSha256,
    intentDigest: value.intentDigest,
    canonical: value.canonical,
    digest: value.digest,
  };
}

function parseCronCleanupDeleteAuthority(paths, spec, record) {
  const value = parseCronCleanupCanonicalJson(record);
  return assertCronCleanupCanonicalRecord(
    record, validateCronCleanupDeleteAuthority(paths, spec, value),
  );
}

function cronCleanupDoneValue(paths, runtime) {
  const body = {
    version: 1,
    txId: runtime.spec.txId,
    kind: runtime.spec.kind,
    epoch: runtime.spec.epoch,
    pathsHash: pathsHash(paths),
    inventory: runtime.inventory,
    reservation: runtime.reservation,
    authority: runtime.authority,
    deleteAuthority: runtime.deleteAuthority,
  };
  return { ...body, digest: valueHash(body) };
}

function validateCronCleanupDone(paths, spec, value) {
  if (!exactKeys(value, [
    'version', 'txId', 'kind', 'epoch', 'pathsHash', 'inventory', 'reservation',
    'authority', 'deleteAuthority', 'digest',
  ]) || value.version !== 1 || value.txId !== spec.txId || value.kind !== spec.kind
      || value.epoch !== spec.epoch || value.pathsHash !== pathsHash(paths)
      || !isObject(value.inventory) || !isObject(value.reservation)
      || !isObject(value.authority) || !isObject(value.deleteAuthority)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const inventory = validateCronCleanupInventory(paths, spec, value.inventory);
  const inventoryBytes = cronCleanupJsonBytes(inventory);
  const inventoryRecord = { bytes: inventoryBytes };
  const reservation = validateCronCleanupReservation(
    paths, spec, inventory, inventoryRecord, value.reservation,
  );
  const quarantineRoot = cronCleanupQuarantineRoot(paths);
  const containerPath = path.join(quarantineRoot, reservation.container);
  if (path.dirname(containerPath) !== quarantineRoot
      || path.basename(containerPath) !== reservation.container
      || lstatIfPresent(spec.source) || lstatIfPresent(containerPath)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const authority = validateCronCleanupAuthority(
    paths, spec, inventory, inventoryRecord, reservation, value.authority,
    { allowContainerAbsent: true },
  );
  const deleteAuthority = validateCronCleanupDeleteAuthority(
    paths, spec, value.deleteAuthority,
  );
  if (!equal(deleteAuthority, cronCleanupExpectedDeleteAuthority(authority))
      || authority.digest !== deleteAuthority.authorityDigest
      || reservation.digest !== deleteAuthority.reservationDigest
      || inventory.digest !== deleteAuthority.inventoryDigest
      || sha256(inventoryBytes) !== deleteAuthority.inventorySha256) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const expected = cronCleanupDoneValue(paths, {
    spec, inventory, reservation, authority, deleteAuthority,
  });
  if (!equal(value, expected) || typeof value.digest !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.digest)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return expected;
}

function parseCronCleanupDone(paths, spec, record) {
  const value = parseCronCleanupCanonicalJson(record);
  return assertCronCleanupCanonicalRecord(
    record, validateCronCleanupDone(paths, spec, value),
  );
}

function cronCleanupIntentValue(authority, containerIdentity) {
  return {
    version: 1,
    authorityDigest: authority.digest,
    cleanupId: authority.cleanupId,
    txId: authority.txId,
    kind: authority.kind,
    epoch: authority.epoch,
    container: authority.container,
    containerIdentity: serialDirectoryIdentity(containerIdentity),
    state: 'prepared',
    reason: null,
    observed: null,
  };
}

function cronCleanupExpectedDeleteAuthority(authority) {
  const intentValue = cronCleanupIntentValue(authority, authority.containerIdentity);
  return cronCleanupDeleteAuthorityValue({
    authority,
    intent: {
      value: intentValue,
      record: { bytes: cronCleanupJsonBytes(intentValue) },
    },
  });
}

function validateCronCleanupIntent(authority, container, value) {
  if (!exactKeys(value, [
    'version', 'authorityDigest', 'cleanupId', 'txId', 'kind', 'epoch', 'container',
    'containerIdentity', 'state', 'reason', 'observed',
  ]) || value.version !== 1 || value.authorityDigest !== authority.digest
      || value.cleanupId !== authority.cleanupId || value.txId !== authority.txId
      || value.kind !== authority.kind || value.epoch !== authority.epoch
      || value.container !== authority.container
      || !validSerialDirectoryIdentity(value.containerIdentity)
      || !sameSerialDirectoryIdentity(container, value.containerIdentity)
      || !['prepared', 'incident'].includes(value.state)
      || (value.state === 'prepared'
        ? value.reason !== null || value.observed !== null
        : typeof value.reason !== 'string' || value.reason.length === 0
          || value.reason.length > 128 || !isObject(value.observed))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const prepared = cronCleanupIntentValue(authority, value.containerIdentity);
  const expected = value.state === 'prepared' ? prepared : {
    ...prepared,
    state: 'incident',
    reason: value.reason,
    observed: stableValue(value.observed),
  };
  if (!equal(value, expected)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return expected;
}

function readCronCleanupIntent(authority, container, entries) {
  const finalFile = path.join(container, 'intent.json');
  const stagingFile = path.join(container, 'intent.staging');
  const finalPresent = entries.includes('intent.json');
  const stagingPresent = entries.includes('intent.staging');
  if (!finalPresent && !stagingPresent) return null;
  if (!finalPresent) {
    const stagingRecord = readCronCleanupFileRecord(stagingFile);
    const expected = cronCleanupIntentValue(
      authority, cronCleanupDirectoryIdentity(container, 'CRON_WORKER_LIFECYCLE_INVALID'),
    );
    const expectedBytes = cronCleanupJsonBytes(expected);
    if (stagingRecord.bytes.length > expectedBytes.length
        || !stagingRecord.bytes.equals(expectedBytes.subarray(0, stagingRecord.bytes.length))) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    return {
      stagingOnly: true,
      stagingFile,
      stagingRecord,
      expectedBytes,
      stagingComplete: stagingRecord.bytes.length === expectedBytes.length,
      value: expected,
    };
  }
  const expectedNlink = stagingPresent ? 2 : 1;
  const record = readCronCleanupFileRecord(finalFile, { expectedNlink });
  let stagingRecord = null;
  if (stagingPresent) {
    stagingRecord = readCronCleanupFileRecord(stagingFile, { expectedNlink: 2 });
    if (!sameCronCleanupFileIdentity(record.identity, stagingRecord.identity)
        || !record.bytes.equals(stagingRecord.bytes)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const value = parseCronCleanupCanonicalJson(record);
  const validated = validateCronCleanupIntent(authority, container, value);
  return {
    finalFile,
    stagingFile,
    record,
    stagingRecord,
    value: assertCronCleanupCanonicalRecord(record, validated),
  };
}

function inspectCronCleanupPublication(finalFile, stagingFile, maxBytes) {
  const finalPresent = Boolean(lstatIfPresent(finalFile));
  const stagingPresent = Boolean(lstatIfPresent(stagingFile));
  if (!finalPresent && !stagingPresent) return null;
  if (!finalPresent) {
    return {
      finalPresent: false,
      stagingPresent: true,
      record: null,
      stagingRecord: readCronCleanupFileRecord(stagingFile, { maxBytes }),
    };
  }
  const expectedNlink = stagingPresent ? 2 : 1;
  const record = readCronCleanupFileRecord(finalFile, { expectedNlink, maxBytes });
  let stagingRecord = null;
  if (stagingPresent) {
    stagingRecord = readCronCleanupFileRecord(stagingFile, {
      expectedNlink: 2, maxBytes,
    });
    if (!sameCronCleanupFileIdentity(record.identity, stagingRecord.identity)
        || !record.bytes.equals(stagingRecord.bytes)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return { finalPresent: true, stagingPresent, record, stagingRecord };
}

function cronCleanupJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function assertCronCleanupStagingPrefix(publication, expectedBytes) {
  if (!publication || publication.finalPresent || !publication.stagingRecord
      || publication.stagingRecord.bytes.length > expectedBytes.length
      || !publication.stagingRecord.bytes.equals(
        expectedBytes.subarray(0, publication.stagingRecord.bytes.length),
      )) fail('CRON_WORKER_LIFECYCLE_INVALID');
  publication.expectedBytes = expectedBytes;
  publication.stagingComplete = publication.stagingRecord.bytes.length === expectedBytes.length;
}

function inspectCronCleanupBatch(paths) {
  const groups = new Map();
  const transactionParent = transactionsRoot(paths);
  const transactionParentMetadata = lstatIfPresent(transactionParent);
  if (transactionParentMetadata) {
    if (transactionParentMetadata.isSymbolicLink() || !transactionParentMetadata.isDirectory()) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    // The root names and every child top-level name share one hard discovery
    // budget. Non-Q names count too, so inspection cannot first materialize an
    // unbounded unrelated transaction namespace.
    const discoveryBudget = cronCleanupEnumerationBudget(
      CRON_CLEANUP_DISCOVERY_MAX_ENTRIES,
    );
    for (const directoryName of cronCleanupReadDirectoryNames(
      transactionParent, discoveryBudget, CRON_CLEANUP_DISCOVERY_MAX_ENTRIES,
    )) {
      const directory = path.join(transactionParent, directoryName);
      const metadata = lstatIfPresent(directory);
      if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      let sawCleanupArtifact = false;
      cronCleanupReadDirectoryNames(
        directory, discoveryBudget, CRON_CLEANUP_DISCOVERY_MAX_ENTRIES, (name) => {
        if (!name.startsWith(CRON_CLEANUP_ARTIFACT_PREFIX)) return;
        sawCleanupArtifact = true;
        if (!/^tx-[0-9a-f-]{36}$/.test(directoryName)) {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        const parsed = parseCronCleanupArtifactName(paths, directoryName, name);
        if (!parsed) fail('CRON_WORKER_LIFECYCLE_INVALID');
        const key = `${directoryName}:${parsed.kind}:${parsed.epoch ?? ''}`;
        let group = groups.get(key);
        if (!group) {
          if (groups.size >= CRON_CLEANUP_MAX_ARTIFACTS) {
            fail('CRON_WORKER_LIFECYCLE_INVALID');
          }
          group = { spec: parsed, names: new Set() };
          groups.set(key, group);
        }
        if (parsed.inventorySha256) {
          if (group.spec.inventorySha256
              && group.spec.inventorySha256 !== parsed.inventorySha256) {
            fail('CRON_WORKER_LIFECYCLE_INVALID');
          }
          group.spec = {
            ...group.spec,
            inventorySha256: parsed.inventorySha256,
            inventoryFile: parsed.inventoryFile,
            inventoryStagingFile: parsed.inventoryStagingFile,
          };
        }
        if (group.names.has(name)) fail('CRON_WORKER_LIFECYCLE_INVALID');
        group.names.add(name);
        },
      );
      if (sawCleanupArtifact) {
        cronCleanupDirectoryIdentity(directory, 'CRON_WORKER_LIFECYCLE_INVALID');
      }
    }
  }

  const artifacts = [];
  const containerBindings = new Map();
  const projectedInventories = [];
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => (
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  ));
  for (const [, group] of orderedGroups) {
    const inventoryPublication = group.spec.inventorySha256
      ? inspectCronCleanupPublication(
        group.spec.inventoryFile,
        group.spec.inventoryStagingFile,
        CRON_CLEANUP_INVENTORY_MAX_BYTES,
      ) : null;
    const reservationPublication = inspectCronCleanupPublication(
      group.spec.reservationFile,
      group.spec.reservationStagingFile,
      CRON_CLEANUP_FILE_MAX_BYTES,
    );
    const authorityPublication = inspectCronCleanupPublication(
      group.spec.finalFile,
      group.spec.stagingFile,
      CRON_CLEANUP_FILE_MAX_BYTES,
    );
    const deletePublication = inspectCronCleanupPublication(
      group.spec.deleteFile,
      group.spec.deleteStagingFile,
      CRON_CLEANUP_FILE_MAX_BYTES,
    );
    const donePublication = inspectCronCleanupPublication(
      group.spec.doneFile,
      group.spec.doneStagingFile,
      CRON_CLEANUP_DONE_MAX_BYTES,
    );
    const lowerLayerPair = (publication) => Boolean(publication?.stagingRecord);
    if ((!donePublication?.finalPresent && (
      !inventoryPublication
        || (reservationPublication && (!inventoryPublication.finalPresent
          || lowerLayerPair(inventoryPublication)))
        || (authorityPublication && (!reservationPublication?.finalPresent
          || lowerLayerPair(inventoryPublication) || lowerLayerPair(reservationPublication)))
        || (deletePublication && (!authorityPublication?.finalPresent
          || lowerLayerPair(inventoryPublication) || lowerLayerPair(reservationPublication)
          || lowerLayerPair(authorityPublication)))
    ))
        || (donePublication && !donePublication.finalPresent
          && (!inventoryPublication?.finalPresent || !reservationPublication?.finalPresent
            || !authorityPublication?.finalPresent || !deletePublication?.finalPresent
            || lowerLayerPair(inventoryPublication) || lowerLayerPair(reservationPublication)
            || lowerLayerPair(authorityPublication) || lowerLayerPair(deletePublication)))
        || (donePublication?.finalPresent
          && [inventoryPublication, reservationPublication, authorityPublication,
            deletePublication].some(lowerLayerPair))) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const deleteRecord = deletePublication
      ? deletePublication.record ?? deletePublication.stagingRecord : null;
    let deleteAuthority = deletePublication?.finalPresent
      ? parseCronCleanupDeleteAuthority(paths, group.spec, deleteRecord) : null;
    const doneRecord = donePublication
      ? donePublication.record ?? donePublication.stagingRecord : null;
    let done = donePublication?.finalPresent
      ? parseCronCleanupDone(paths, group.spec, doneRecord) : null;
    let inventoryRecord = inventoryPublication
      ? inventoryPublication.record ?? inventoryPublication.stagingRecord : null;
    let inventory = null;
    if (inventoryPublication?.finalPresent) {
      inventory = parseCronCleanupInventory(paths, group.spec, inventoryRecord);
    } else if (inventoryPublication) {
      const expected = cronCleanupInventoryForSpec(paths, group.spec);
      if (sha256(expected.bytes) !== group.spec.inventorySha256) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      assertCronCleanupStagingPrefix(inventoryPublication, expected.bytes);
      inventory = expected.value;
      inventoryRecord = { ...inventoryPublication.stagingRecord, bytes: expected.bytes };
    }
    if (inventory) {
      projectedInventories.push({
        inventory,
        inventoryBytes: inventoryRecord.bytes.length,
      });
    }
    let reservation = null;
    const reservationRecord = reservationPublication
      ? reservationPublication.record ?? reservationPublication.stagingRecord : null;
    if (reservationRecord) {
      if (reservationPublication.finalPresent) {
        reservation = parseCronCleanupReservation(
          paths, group.spec, inventory, inventoryRecord, reservationRecord,
        );
      } else {
        const expected = cronCleanupReservationValue(paths, inventory, inventoryRecord);
        const expectedBytes = cronCleanupJsonBytes(expected);
        assertCronCleanupStagingPrefix(reservationPublication, expectedBytes);
        reservation = expected;
      }
      if (containerBindings.has(reservation.container)) fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const artifact = {
      ...group,
      inventory,
      inventoryRecord,
      inventoryPublication,
      reservation,
      reservationRecord,
      reservationPublication,
      authority: null,
      authorityRecord: authorityPublication?.record ?? null,
      authorityStagingRecord: authorityPublication?.stagingRecord ?? null,
      authorityPublication,
      deleteAuthority,
      deleteRecord,
      deletePublication,
      done,
      doneRecord,
      donePublication,
      finalFile: group.spec.finalFile,
      stagingFile: group.spec.stagingFile,
      container: null,
      containerIdentity: null,
      intent: null,
      topology: null,
    };
    artifacts.push(artifact);
    const containerBinding = reservation?.container ?? deleteAuthority?.container
      ?? done?.reservation?.container;
    if (containerBinding) {
      if (containerBindings.has(containerBinding)) fail('CRON_WORKER_LIFECYCLE_INVALID');
      containerBindings.set(containerBinding, artifact);
    }
  }
  cronCleanupProjectedBatchWork(projectedInventories);

  const quarantineRoot = cronCleanupQuarantineRoot(paths);
  const quarantineMetadata = lstatIfPresent(quarantineRoot);
  if (quarantineMetadata) {
    cronCleanupDirectoryIdentity(quarantineRoot, 'CRON_WORKER_LIFECYCLE_INVALID');
    for (const name of cronCleanupQuarantineNames(quarantineRoot)) {
      if (!CRON_CLEANUP_CONTAINER_NAME.test(name)) fail('CRON_WORKER_LIFECYCLE_INVALID');
      const artifact = containerBindings.get(name);
      if (!artifact || artifact.container) fail('CRON_WORKER_LIFECYCLE_INVALID');
      artifact.container = path.join(quarantineRoot, name);
      artifact.containerIdentity = cronCleanupDirectoryIdentity(
        artifact.container, 'CRON_WORKER_LIFECYCLE_INVALID',
      );
    }
  }

  for (const artifact of artifacts) {
    if (artifact.donePublication && !artifact.donePublication.finalPresent
        && (artifact.container || lstatIfPresent(artifact.spec.source))) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    if (artifact.done) {
      if (artifact.container) fail('CRON_WORKER_LIFECYCLE_INVALID');
      if ([artifact.inventoryPublication, artifact.reservationPublication,
        artifact.authorityPublication, artifact.deletePublication]
        .some((publication) => publication && !publication.finalPresent)) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      if (artifact.inventory && !equal(artifact.inventory, artifact.done.inventory)) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      if (artifact.reservation && !equal(artifact.reservation, artifact.done.reservation)) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      if (artifact.authorityPublication) {
        if (!artifact.inventory || !artifact.reservation) fail('CRON_WORKER_LIFECYCLE_INVALID');
        const presentAuthority = parseCronCleanupAuthority(
          paths,
          artifact.spec,
          artifact.inventory,
          artifact.inventoryRecord,
          artifact.reservation,
          artifact.authorityPublication.record ?? artifact.authorityPublication.stagingRecord,
          { allowContainerAbsent: true },
        );
        if (!equal(presentAuthority, artifact.done.authority)) {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        artifact.authority = presentAuthority;
      }
      if (artifact.deleteAuthority
          && !equal(artifact.deleteAuthority, artifact.done.deleteAuthority)) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      const hasInventory = Boolean(artifact.inventoryPublication);
      const hasReservation = Boolean(artifact.reservationPublication);
      const hasAuthority = Boolean(artifact.authorityPublication);
      const hasDelete = Boolean(artifact.deletePublication);
      if ((hasAuthority && (!hasReservation || !hasInventory || !hasDelete))
          || (hasReservation && (!hasInventory || !hasDelete))
          || (hasInventory && !hasDelete)
          || (!hasDelete && (hasInventory || hasReservation || hasAuthority))) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      if (!artifact.donePublication.finalPresent
          && (!hasInventory || !hasReservation || !hasAuthority || !hasDelete)) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      artifact.topology = !artifact.donePublication.finalPresent
        ? 'done-staging-only'
        : artifact.donePublication.stagingRecord ? 'done-pair' : 'done';
      continue;
    }
    if (!artifact.inventory) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const sourceState = lstatIfPresent(artifact.spec.source)
      ? cronCleanupTreeState(artifact.spec.source, artifact.inventory, { complete: true })
      : { present: false, complete: false, remaining: [] };
    if (!artifact.inventoryPublication.finalPresent) {
      if (artifact.reservation || artifact.container || !sourceState.complete) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      artifact.topology = 'inventory-staging-only';
      continue;
    }
    if (!artifact.reservation) {
      if (artifact.container || !sourceState.complete) fail('CRON_WORKER_LIFECYCLE_INVALID');
      artifact.topology = artifact.inventoryPublication.stagingRecord
        ? 'inventory-pair' : 'inventory-only';
      continue;
    }
    if (!artifact.reservationPublication.finalPresent) {
      if (artifact.container || artifact.authorityPublication || !sourceState.complete) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      artifact.topology = 'reservation-staging-only';
      continue;
    }
    if (!artifact.container) {
      if (artifact.deletePublication?.finalPresent) {
        if (!artifact.authorityPublication?.finalPresent) {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        artifact.authority = parseCronCleanupAuthority(
          paths,
          artifact.spec,
          artifact.inventory,
          artifact.inventoryRecord,
          artifact.reservation,
          artifact.authorityPublication.record,
          { allowContainerAbsent: true },
        );
        if (!equal(
          artifact.deleteAuthority, cronCleanupExpectedDeleteAuthority(artifact.authority),
        ) || artifact.authority.digest !== artifact.deleteAuthority.authorityDigest
            || artifact.reservation.digest !== artifact.deleteAuthority.reservationDigest
            || artifact.inventory.digest !== artifact.deleteAuthority.inventoryDigest
            || sha256(artifact.inventoryRecord.bytes)
              !== artifact.deleteAuthority.inventorySha256) {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        if (artifact.donePublication && !artifact.donePublication.finalPresent) {
          if (!artifact.authority || !artifact.inventory || !artifact.reservation
              || !artifact.deleteAuthority) fail('CRON_WORKER_LIFECYCLE_INVALID');
          const expectedDone = cronCleanupDoneValue(paths, artifact);
          assertCronCleanupStagingPrefix(
            artifact.donePublication, cronCleanupJsonBytes(expectedDone),
          );
          artifact.done = expectedDone;
          artifact.topology = 'done-staging-only';
          continue;
        }
        artifact.topology = 'container-removed-delete';
        continue;
      }
      if (artifact.authorityPublication || artifact.deletePublication || !sourceState.complete) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      artifact.topology = artifact.reservationPublication.stagingRecord
        ? 'reservation-pair' : 'reservation-only';
      continue;
    }
    if (!artifact.authorityPublication) {
      if (artifact.deletePublication || !sourceState.complete
          || cronCleanupContainerNames(artifact.container).length !== 0) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      artifact.topology = 'container-unbound';
      continue;
    }
    const authorityRecord = artifact.authorityPublication.record
      ?? artifact.authorityPublication.stagingRecord;
    if (artifact.authorityPublication.finalPresent) {
      artifact.authority = parseCronCleanupAuthority(
        paths,
        artifact.spec,
        artifact.inventory,
        artifact.inventoryRecord,
        artifact.reservation,
        authorityRecord,
      );
    } else {
      const expected = cronCleanupAuthorityValue(
        artifact.reservation, artifact.containerIdentity,
      );
      assertCronCleanupStagingPrefix(
        artifact.authorityPublication, cronCleanupJsonBytes(expected),
      );
      artifact.authority = expected;
    }
    if (!artifact.authorityPublication.finalPresent) {
      if (!sourceState.complete || cronCleanupContainerNames(artifact.container).length !== 0) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      artifact.topology = 'authority-staging-only';
      continue;
    }
    const sourcePresent = Boolean(lstatIfPresent(artifact.spec.source));
    const sourceMatches = sourcePresent && sourceState.complete;
    const entries = cronCleanupContainerNames(artifact.container);
    const incidentTransitionNames = entries.filter(
      (name) => name === 'intent.incident.json' || name === 'intent.incident.staging',
    );
    if (incidentTransitionNames.length > 0) {
      inspectCronCleanupPublication(
        path.join(artifact.container, 'intent.incident.json'),
        path.join(artifact.container, 'intent.incident.staging'),
        CRON_CLEANUP_FILE_MAX_BYTES,
      );
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    const allowed = [
      '',
      'intent.staging',
      'intent.json',
      'intent.json,intent.staging',
      'intent.json,payload',
    ];
    if (!allowed.includes(entries.join(','))) fail('CRON_WORKER_LIFECYCLE_INVALID');
    const payload = path.join(artifact.container, 'payload');
    const payloadPresent = entries.includes('payload');
    const intent = readCronCleanupIntent(artifact.authority, artifact.container, entries);
    artifact.entries = entries;
    artifact.intent = intent;
    if (artifact.deletePublication && !artifact.deletePublication.finalPresent) {
      if (sourcePresent || !intent || intent.stagingOnly) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      const expectedDelete = cronCleanupDeleteAuthorityValue(artifact);
      assertCronCleanupStagingPrefix(
        artifact.deletePublication, cronCleanupJsonBytes(expectedDelete),
      );
      artifact.deleteAuthority = expectedDelete;
    }
    if (artifact.deleteAuthority) {
      if (!equal(
        artifact.deleteAuthority, cronCleanupExpectedDeleteAuthority(artifact.authority),
      ) || artifact.authority.digest !== artifact.deleteAuthority.authorityDigest
          || artifact.reservation.digest !== artifact.deleteAuthority.reservationDigest
          || artifact.inventory.digest !== artifact.deleteAuthority.inventoryDigest
          || sha256(artifact.inventoryRecord.bytes) !== artifact.deleteAuthority.inventorySha256
          || (intent && !intent.stagingOnly
            && (sha256(intent.record.bytes) !== artifact.deleteAuthority.intentSha256
              || valueHash(intent.value) !== artifact.deleteAuthority.intentDigest))) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
    }
    if (entries.length === 0) {
      if (sourcePresent && !sourceMatches) fail('CRON_WORKER_LIFECYCLE_INVALID');
      if (!sourcePresent && !artifact.deletePublication?.finalPresent) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      artifact.topology = sourcePresent ? 'container-empty' : 'intent-removed';
      continue;
    }
    if (intent?.stagingOnly) {
      if (!sourceMatches || payloadPresent) fail('CRON_WORKER_LIFECYCLE_INVALID');
      artifact.topology = 'intent-staging-only';
      continue;
    }
    if (!intent || intent.value.state !== 'prepared') fail('CRON_WORKER_LIFECYCLE_INVALID');
    if (intent.stagingRecord && payloadPresent) fail('CRON_WORKER_LIFECYCLE_INVALID');
    if (sourceMatches && !payloadPresent) {
      artifact.topology = intent.stagingRecord ? 'intent-pair' : 'prepared';
      continue;
    }
    if (!sourcePresent && payloadPresent) {
      const payloadState = cronCleanupTreeState(payload, artifact.inventory);
      if (!payloadState.present) fail('CRON_WORKER_LIFECYCLE_INVALID');
      if (!artifact.deletePublication?.finalPresent && !payloadState.complete) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      if (artifact.deletePublication && !artifact.deletePublication.finalPresent) {
        if (!payloadState.complete || !intent || intent.stagingOnly) {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
      }
      artifact.payloadState = payloadState;
      artifact.topology = artifact.deletePublication
        ? artifact.deletePublication.finalPresent ? 'deleting' : 'delete-staging-only'
        : 'moved';
      continue;
    }
    if (!sourcePresent && !payloadPresent) {
      if (!artifact.deletePublication?.finalPresent) fail('CRON_WORKER_LIFECYCLE_INVALID');
      artifact.topology = 'payload-removed';
      continue;
    }
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return { artifacts, quarantineRoot };
}

function assertCronCleanupQuarantinePreflight(paths) {
  const batch = inspectCronCleanupBatch(paths);
  if (batch.artifacts.length > 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
  assertNoUnboundCronCleanupSources(paths);
}

function createCronCleanupRoot(paths) {
  const root = cronCleanupQuarantineRoot(paths);
  let created = false;
  if (!lstatIfPresent(root)) {
    try {
      fs.mkdirSync(root, { recursive: false, mode: 0o700 });
      created = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    if (created) {
      if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
      fsyncDirectory(path.dirname(root));
    }
  }
  cronCleanupDirectoryIdentity(root, 'CRON_WORKER_LIFECYCLE_INVALID');
  return { root, created };
}

function normalizeCronCleanupPair(
  file, stagingFile, record, stagingRecord, expectedValue,
  maxBytes = CRON_CLEANUP_FILE_MAX_BYTES,
) {
  if (!stagingRecord) return record;
  const current = readCronCleanupFileRecord(file, { expectedNlink: 2, maxBytes });
  const staged = readCronCleanupFileRecord(stagingFile, { expectedNlink: 2, maxBytes });
  const expectedBytes = cronCleanupJsonBytes(expectedValue);
  if (!sameCronCleanupFileIdentity(current.identity, record.identity)
      || !sameCronCleanupFileIdentity(staged.identity, stagingRecord.identity)
      || !current.bytes.equals(record.bytes) || !staged.bytes.equals(stagingRecord.bytes)
      || !current.bytes.equals(staged.bytes) || !current.bytes.equals(expectedBytes)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  unlinkCronCleanupFileRecord(
    stagingFile, staged.identity, { expectedNlink: 2, expectedBytes },
  );
  fsyncDirectory(path.dirname(file));
  return readCronCleanupFileRecord(file, { maxBytes });
}

function startCronCleanupStagedPublication(
  finalFile, stagingFile, value, maxBytes = CRON_CLEANUP_FILE_MAX_BYTES,
) {
  const expectedBytes = cronCleanupJsonBytes(value);
  if (expectedBytes.length > maxBytes || lstatIfPresent(finalFile)
      || lstatIfPresent(stagingFile)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  try {
    writeBytesExclusiveDurable(stagingFile, expectedBytes, 0o600, { ensureParent: false });
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const staged = readCronCleanupFileRecord(stagingFile, { maxBytes });
  if (!staged.bytes.equals(expectedBytes)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return staged;
}

function completeCronCleanupStagedPublication(
  finalFile, stagingFile, publication, value, maxBytes = CRON_CLEANUP_FILE_MAX_BYTES,
) {
  const expectedBytes = cronCleanupJsonBytes(value);
  if (expectedBytes.length > maxBytes || publication.finalPresent
      || !publication.stagingRecord) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const staged = readCronCleanupFileRecord(stagingFile, { maxBytes });
  if (!sameCronCleanupFileIdentity(staged.identity, publication.stagingRecord.identity)
      || staged.bytes.length > expectedBytes.length
      || !staged.bytes.equals(expectedBytes.subarray(0, staged.bytes.length))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  if (staged.bytes.length !== expectedBytes.length) {
    const flags = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0)
      | (fs.constants.O_NONBLOCK ?? 0);
    let descriptor;
    try {
      descriptor = fs.openSync(stagingFile, flags);
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile()
          || !sameCronCleanupFileIdentity(cronCleanupFileIdentity(opened), staged.identity)) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      let offset = staged.bytes.length;
      while (offset < expectedBytes.length) {
        const count = fs.writeSync(
          descriptor, expectedBytes, offset, expectedBytes.length - offset, offset,
        );
        if (count <= 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
        offset += count;
      }
      fs.fsyncSync(descriptor);
      const persisted = Buffer.alloc(expectedBytes.length);
      offset = 0;
      while (offset < persisted.length) {
        const count = fs.readSync(
          descriptor, persisted, offset, persisted.length - offset, offset,
        );
        if (count <= 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
        offset += count;
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      const afterIdentity = cronCleanupFileIdentity(after);
      let atPath;
      try { atPath = fs.lstatSync(stagingFile, { bigint: true }); } catch {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
      if (!persisted.equals(expectedBytes) || !after.isFile() || after.nlink !== 1n
          || atPath.isSymbolicLink() || !atPath.isFile() || atPath.nlink !== 1n
          || afterIdentity.dev !== staged.identity.dev
          || afterIdentity.ino !== staged.identity.ino
          || afterIdentity.mode !== staged.identity.mode
          || afterIdentity.uid !== staged.identity.uid
          || afterIdentity.size !== expectedBytes.length
          || !sameCronCleanupFileIdentity(cronCleanupFileIdentity(atPath), afterIdentity)) {
        fail('CRON_WORKER_LIFECYCLE_INVALID');
      }
    } catch (error) {
      if (error instanceof BootstrapProfileTransactionError) throw error;
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(stagingFile));
    return readCronCleanupFileRecord(stagingFile, { maxBytes });
  }
  if (lstatIfPresent(finalFile)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  fs.linkSync(stagingFile, finalFile);
  fsyncDirectory(path.dirname(finalFile));
  const finalRecord = readCronCleanupFileRecord(finalFile, {
    expectedNlink: 2, maxBytes,
  });
  const stagingPair = readCronCleanupFileRecord(stagingFile, {
    expectedNlink: 2, maxBytes,
  });
  if (!sameCronCleanupFileIdentity(finalRecord.identity, stagingPair.identity)
      || !finalRecord.bytes.equals(expectedBytes)
      || !stagingPair.bytes.equals(expectedBytes)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return finalRecord;
}

function emitPrivateDirectoryRemovalTestPhase(controls, phase, context) {
  if (controls === undefined || controls === null) return;
  if (process.env.NODE_ENV !== 'test' || !isObject(controls)
      || typeof controls.onPhase !== 'function') fail('CRON_WORKER_FAILED');
  controls.onPhase(phase, context);
}

function assertCronCleanupImmutableControl(paths, runtime, allowedEntries) {
  const inventoryRecord = readCronCleanupFileRecord(runtime.spec.inventoryFile, {
    maxBytes: CRON_CLEANUP_INVENTORY_MAX_BYTES,
  });
  const reservationRecord = readCronCleanupFileRecord(runtime.spec.reservationFile);
  const authorityRecord = readCronCleanupFileRecord(runtime.finalFile);
  if (!sameCronCleanupFileIdentity(inventoryRecord.identity, runtime.inventoryRecord.identity)
      || !inventoryRecord.bytes.equals(runtime.inventoryRecord.bytes)
      || !sameCronCleanupFileIdentity(
        reservationRecord.identity, runtime.reservationRecord.identity,
      ) || !reservationRecord.bytes.equals(runtime.reservationRecord.bytes)
      || !sameCronCleanupFileIdentity(authorityRecord.identity, runtime.authorityRecord.identity)
      || !authorityRecord.bytes.equals(runtime.authorityRecord.bytes)
      || !sameSerialDirectoryIdentity(runtime.spec.root, runtime.authority.sourceParentIdentity)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const rootIdentity = cronCleanupDirectoryIdentity(
    cronCleanupQuarantineRoot(paths), 'CRON_WORKER_LIFECYCLE_INVALID',
  );
  if (!rootIdentity
      || !equal(serialDirectoryIdentity(rootIdentity), runtime.authority.quarantineRootIdentity)
      || !sameSerialDirectoryIdentity(
    runtime.container, serialDirectoryIdentity(runtime.containerIdentity),
  )) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  const intentRecord = readCronCleanupFileRecord(runtime.intent.finalFile);
  if (!sameCronCleanupFileIdentity(intentRecord.identity, runtime.intent.record.identity)
      || !intentRecord.bytes.equals(runtime.intent.record.bytes)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  if (runtime.deletePublication?.finalPresent) {
    const deleteRecord = readCronCleanupFileRecord(runtime.spec.deleteFile);
    if (!sameCronCleanupFileIdentity(deleteRecord.identity, runtime.deleteRecord.identity)
        || !deleteRecord.bytes.equals(runtime.deleteRecord.bytes)) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
  }
  const entries = cronCleanupContainerNames(runtime.container);
  if (allowedEntries && !equal(entries, [...allowedEntries].sort())) {
    return { entries, entriesMatch: false };
  }
  return { entries, entriesMatch: true };
}

function assertCronCleanupFrozenRecord(
  file, frozen, expectedValue, maxBytes = CRON_CLEANUP_FILE_MAX_BYTES,
) {
  if (!frozen) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const fresh = readCronCleanupFileRecord(file, { maxBytes });
  const expectedBytes = cronCleanupJsonBytes(expectedValue);
  if (!sameCronCleanupFileIdentity(fresh.identity, frozen.identity)
      || !fresh.bytes.equals(frozen.bytes) || !fresh.bytes.equals(expectedBytes)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  return fresh;
}

function assertCronCleanupMismatchFailClosed(paths, runtime, reason, observed, allowedEntries) {
  const baseline = assertCronCleanupImmutableControl(paths, runtime, allowedEntries);
  if (!baseline.entriesMatch) fail('CRON_WORKER_LIFECYCLE_INVALID');
  if (runtime.intent.value.state !== 'prepared' || typeof reason !== 'string'
      || reason.length === 0 || reason.length > 128 || !isObject(observed)) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
  stableValue(observed);
}

function cronCleanupMismatchObservation(runtime) {
  return {
    canonical: observedPathIdentity(runtime.spec.source),
    payload: observedPathIdentity(path.join(runtime.container, 'payload')),
    nested: runtime.authority.nested.map((item) => ({
      relative: item.relative,
      canonical: observedPathIdentity(path.join(runtime.spec.source, item.relative)),
      payload: observedPathIdentity(path.join(runtime.container, 'payload', item.relative)),
    })),
    entries: cronCleanupContainerNames(runtime.container),
  };
}

function refreshCronCleanupArtifact(paths, spec) {
  const batch = inspectCronCleanupBatch(paths);
  const artifact = batch.artifacts.find((item) => item.spec.txId === spec.txId
    && item.spec.kind === spec.kind && item.spec.epoch === spec.epoch);
  if (!artifact) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return artifact;
}

function cronCleanupEntryDepth(relative) {
  return relative === '' ? 0 : relative.split(path.sep).length;
}

function assertCronCleanupInventoryEntry(target, entry) {
  const counters = { entries: 0, pathBytes: 0, contentBytes: 0 };
  const observed = cronCleanupTreeMetadata(target, entry.relative, counters);
  if (!equal(observed, entry)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  return observed;
}

function cronCleanupSortedNames(names) {
  return [...names].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function cronCleanupDirectChildren(remaining, parentRelative) {
  return cronCleanupSortedNames(remaining.filter((relative) => relative !== '')
    .filter((relative) => {
      const parent = path.dirname(relative);
      return (parent === '.' ? '' : parent) === parentRelative;
    }).map((relative) => path.basename(relative)));
}

function assertCronCleanupDirectoryEntries(directory, expected) {
  const readLimit = expected.length + 1;
  const observed = cronCleanupReadDirectoryNames(
    directory, cronCleanupEnumerationBudget(readLimit), readLimit,
  );
  if (!equal(observed, cronCleanupSortedNames(expected))) {
    fail('CRON_WORKER_LIFECYCLE_INVALID');
  }
}

function removeNextCronCleanupPayloadEntry(paths, runtime, testControls, { skipBefore = false } = {}) {
  const payload = path.join(runtime.container, 'payload');
  const inventoryByPath = new Map(
    runtime.inventory.entries.map((entry) => [entry.relative, entry]),
  );
  const remaining = [...runtime.payloadState.remaining];
  const candidates = remaining.filter((relative) => relative !== '')
    .sort(compareCronCleanupRelative);
  if (candidates.length === 0) {
    const rootEntry = inventoryByPath.get('');
    if (!rootEntry || cronCleanupReadDirectoryNames(
      payload, cronCleanupEnumerationBudget(1), 1,
    ).length !== 0
        || !sameSerialDirectoryIdentity(
          runtime.container, runtime.authority.containerIdentity,
        )) {
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    assertCronCleanupInventoryEntry(payload, rootEntry);
    assertCronCleanupDirectoryEntries(runtime.container, ['intent.json', 'payload']);
    if (!skipBefore) emitPrivateDirectoryRemovalTestPhase(testControls, 'before-entry-delete', {
      relative: '', target: payload, parent: runtime.container,
    });
    if (testControls && !skipBefore) {
      const fresh = refreshCronCleanupArtifact(paths, runtime.spec);
      if (fresh.topology !== 'deleting') fail('CRON_WORKER_LIFECYCLE_INVALID');
      return removeNextCronCleanupPayloadEntry(
        paths, fresh, testControls, { skipBefore: true },
      );
    }
    if (!sameSerialDirectoryIdentity(
      runtime.container, runtime.authority.containerIdentity,
    ) || cronCleanupReadDirectoryNames(
      payload, cronCleanupEnumerationBudget(1), 1,
    ).length !== 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
    assertCronCleanupDirectoryEntries(runtime.container, ['intent.json', 'payload']);
    assertCronCleanupInventoryEntry(payload, rootEntry);
    fs.rmdirSync(payload);
    emitPrivateDirectoryRemovalTestPhase(testControls, 'after-entry-delete-before-fsync', {
      relative: '', target: payload, parent: runtime.container,
    });
    fsyncDirectory(runtime.container);
    if (lstatIfPresent(payload) || !sameSerialDirectoryIdentity(
      runtime.container, runtime.authority.containerIdentity,
    )) fail('CRON_WORKER_LIFECYCLE_INVALID');
    assertCronCleanupDirectoryEntries(runtime.container, ['intent.json']);
    emitPrivateDirectoryRemovalTestPhase(testControls, 'after-entry-delete-fsync', {
      relative: '', target: payload, parent: runtime.container,
    });
    if (lstatIfPresent(payload) || !sameSerialDirectoryIdentity(
      runtime.container, runtime.authority.containerIdentity,
    )) fail('CRON_WORKER_LIFECYCLE_INVALID');
    assertCronCleanupDirectoryEntries(runtime.container, ['intent.json']);
    return;
  }
  const relative = candidates[0];
  const entry = inventoryByPath.get(relative);
  const target = path.join(payload, relative);
  if (!entry || !isInside(payload, target)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  const parentRelative = path.dirname(relative) === '.' ? '' : path.dirname(relative);
  const parentEntry = inventoryByPath.get(parentRelative);
  const parent = path.dirname(target);
  if (!parentEntry || parentEntry.type !== 'directory') fail('CRON_WORKER_LIFECYCLE_INVALID');
  const expectedBefore = cronCleanupDirectChildren(remaining, parentRelative);
  const expectedAfter = expectedBefore.filter((name) => name !== path.basename(relative));
  assertCronCleanupInventoryEntry(parent, parentEntry);
  assertCronCleanupDirectoryEntries(parent, expectedBefore);
  assertCronCleanupInventoryEntry(target, entry);
  if (!skipBefore) emitPrivateDirectoryRemovalTestPhase(testControls, 'before-entry-delete', {
    relative, target, parent,
  });
  if (testControls && !skipBefore) {
    const fresh = refreshCronCleanupArtifact(paths, runtime.spec);
    if (fresh.topology !== 'deleting') fail('CRON_WORKER_LIFECYCLE_INVALID');
    return removeNextCronCleanupPayloadEntry(
      paths, fresh, testControls, { skipBefore: true },
    );
  }
  assertCronCleanupInventoryEntry(parent, parentEntry);
  assertCronCleanupDirectoryEntries(parent, expectedBefore);
  assertCronCleanupInventoryEntry(target, entry);
  if (entry.type === 'directory') {
    if (cronCleanupReadDirectoryNames(
      target, cronCleanupEnumerationBudget(1), 1,
    ).length !== 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
  emitPrivateDirectoryRemovalTestPhase(testControls, 'after-entry-delete-before-fsync', {
    relative, target, parent,
  });
  fsyncDirectory(parent);
  if (lstatIfPresent(target)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  assertCronCleanupInventoryEntry(parent, parentEntry);
  assertCronCleanupDirectoryEntries(parent, expectedAfter);
  emitPrivateDirectoryRemovalTestPhase(testControls, 'after-entry-delete-fsync', {
    relative, target, parent,
  });
  if (lstatIfPresent(target)) fail('CRON_WORKER_LIFECYCLE_INVALID');
  assertCronCleanupInventoryEntry(parent, parentEntry);
  assertCronCleanupDirectoryEntries(parent, expectedAfter);
}

function finishCronCleanupArtifact(paths, initial, { code, testControls } = {}) {
  const failureCode = code ?? 'CRON_WORKER_LIFECYCLE_INVALID';
  let runtime = initial;
  try {
    for (let iteration = 0; iteration < CRON_CLEANUP_TREE_MAX_ENTRIES + 64; iteration += 1) {
      runtime = refreshCronCleanupArtifact(paths, runtime.spec);
      const pair = [
        [runtime.donePublication, runtime.spec.doneFile, runtime.spec.doneStagingFile,
          runtime.done, CRON_CLEANUP_DONE_MAX_BYTES],
        [runtime.deletePublication, runtime.spec.deleteFile, runtime.spec.deleteStagingFile,
          runtime.deleteAuthority, CRON_CLEANUP_FILE_MAX_BYTES],
        [runtime.authorityPublication, runtime.spec.finalFile, runtime.spec.stagingFile,
          runtime.authority, CRON_CLEANUP_FILE_MAX_BYTES],
        [runtime.reservationPublication, runtime.spec.reservationFile,
          runtime.spec.reservationStagingFile, runtime.reservation,
          CRON_CLEANUP_FILE_MAX_BYTES],
        [runtime.inventoryPublication, runtime.spec.inventoryFile,
          runtime.spec.inventoryStagingFile, runtime.inventory,
          CRON_CLEANUP_INVENTORY_MAX_BYTES],
      ].find(([publication]) => publication?.finalPresent && publication.stagingRecord);
      if (pair) {
        const [publication, finalFile, stagingFile, expectedValue, maxBytes] = pair;
        normalizeCronCleanupPair(
          finalFile, stagingFile, publication.record, publication.stagingRecord,
          expectedValue, maxBytes,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'inventory-staging-only') {
        completeCronCleanupStagedPublication(
          runtime.spec.inventoryFile,
          runtime.spec.inventoryStagingFile,
          runtime.inventoryPublication,
          runtime.inventory,
          CRON_CLEANUP_INVENTORY_MAX_BYTES,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'inventory-only') {
        cronCleanupTreeState(runtime.spec.source, runtime.inventory, { complete: true });
        emitPrivateDirectoryRemovalTestPhase(
          testControls, 'inventory-only-source-validated-before-q-refresh', {
            path: runtime.spec.source,
            quarantineRoot: cronCleanupQuarantineRoot(paths),
          },
        );
        createCronCleanupRoot(paths);
        // Root creation/adoption is followed by a complete zero-write batch
        // refresh. No reservation is published from the stale inventory-only
        // observation that preceded the namespace operation.
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        if (runtime.topology !== 'inventory-only') {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        const reservation = cronCleanupReservationValue(
          paths, runtime.inventory, runtime.inventoryRecord,
        );
        startCronCleanupStagedPublication(
          runtime.spec.reservationFile, runtime.spec.reservationStagingFile,
          reservation,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'reservation-staging-only') {
        completeCronCleanupStagedPublication(
          runtime.spec.reservationFile,
          runtime.spec.reservationStagingFile,
          runtime.reservationPublication,
          runtime.reservation,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'reservation-only') {
        const root = cronCleanupQuarantineRoot(paths);
        if (!sameSerialDirectoryIdentity(root, runtime.reservation.quarantineRootIdentity)) {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        const container = path.join(root, runtime.reservation.container);
        fs.mkdirSync(container, { recursive: false, mode: 0o700 });
        if (process.platform !== 'win32') fs.chmodSync(container, 0o700);
        cronCleanupDirectoryIdentity(container, 'CRON_WORKER_LIFECYCLE_INVALID');
        fsyncDirectory(root);
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'container-unbound') {
        const authority = cronCleanupAuthorityValue(
          runtime.reservation, runtime.containerIdentity,
        );
        startCronCleanupStagedPublication(
          runtime.spec.finalFile, runtime.spec.stagingFile, authority,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'authority-staging-only') {
        completeCronCleanupStagedPublication(
          runtime.spec.finalFile,
          runtime.spec.stagingFile,
          runtime.authorityPublication,
          runtime.authority,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'container-empty') {
        emitPrivateDirectoryRemovalTestPhase(testControls, 'intent-container-created', {
          path: runtime.spec.source,
          quarantine: runtime.container,
          payload: path.join(runtime.container, 'payload'),
          intentFile: path.join(runtime.container, 'intent.json'),
          identity: { ...runtime.authority.sourceIdentity, path: runtime.spec.source },
        });
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        if (runtime.topology !== 'container-empty') fail(failureCode);
        startCronCleanupStagedPublication(
          path.join(runtime.container, 'intent.json'),
          path.join(runtime.container, 'intent.staging'),
          cronCleanupIntentValue(runtime.authority, runtime.containerIdentity),
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'intent-staging-only') {
        completeCronCleanupStagedPublication(
          path.join(runtime.container, 'intent.json'),
          path.join(runtime.container, 'intent.staging'),
          {
            finalPresent: false,
            stagingRecord: runtime.intent.stagingRecord,
          },
          runtime.intent.value,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'intent-pair') {
        normalizeCronCleanupPair(
          runtime.intent.finalFile, runtime.intent.stagingFile,
          runtime.intent.record, runtime.intent.stagingRecord, runtime.intent.value,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'prepared') {
        const before = assertCronCleanupImmutableControl(paths, runtime, ['intent.json']);
        let sourceMatches = false;
        try {
          sourceMatches = cronCleanupTreeState(
            runtime.spec.source, runtime.inventory, { complete: true },
          ).complete;
        } catch {}
        if (!before.entriesMatch) fail(failureCode);
        if (!sourceMatches) {
          assertCronCleanupMismatchFailClosed(
            paths, runtime,
            'source-identity-before-move',
            cronCleanupMismatchObservation(runtime),
            ['intent.json'],
          );
          fail(failureCode);
        }
        emitPrivateDirectoryRemovalTestPhase(testControls, 'identity-checked', {
          path: runtime.spec.source,
          quarantine: runtime.container,
          payload: path.join(runtime.container, 'payload'),
          intentFile: runtime.intent.finalFile,
          identity: { ...runtime.authority.sourceIdentity, path: runtime.spec.source },
        });
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        if (runtime.topology !== 'prepared') fail(failureCode);
        const afterHook = assertCronCleanupImmutableControl(paths, runtime, ['intent.json']);
        try {
          sourceMatches = cronCleanupTreeState(
            runtime.spec.source, runtime.inventory, { complete: true },
          ).complete;
        } catch { sourceMatches = false; }
        if (!afterHook.entriesMatch) fail(failureCode);
        if (!sourceMatches) {
          assertCronCleanupMismatchFailClosed(
            paths, runtime,
            'source-identity-before-move',
            cronCleanupMismatchObservation(runtime),
            ['intent.json'],
          );
          fail(failureCode);
        }
        const moveContext = {
          path: runtime.spec.source,
          quarantine: runtime.container,
          payload: path.join(runtime.container, 'payload'),
          intentFile: runtime.intent.finalFile,
          identity: { ...runtime.authority.sourceIdentity, path: runtime.spec.source },
        };
        try {
          fs.renameSync(runtime.spec.source, path.join(runtime.container, 'payload'));
          emitPrivateDirectoryRemovalTestPhase(testControls, 'after-rename', moveContext);
          fsyncDirectory(runtime.container);
          emitPrivateDirectoryRemovalTestPhase(
            testControls, 'after-destination-fsync', moveContext,
          );
          fsyncDirectory(runtime.spec.root);
          emitPrivateDirectoryRemovalTestPhase(
            testControls, 'after-source-fsync', moveContext,
          );
        } catch {
          assertCronCleanupMismatchFailClosed(
            paths, runtime, 'source-rename-failed', cronCleanupMismatchObservation(runtime),
            ['intent.json'],
          );
          fail(failureCode);
        }
        emitPrivateDirectoryRemovalTestPhase(testControls, 'source-renamed', moveContext);
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'moved') {
        const payload = path.join(runtime.container, 'payload');
        const postMove = assertCronCleanupImmutableControl(
          paths, runtime, ['intent.json', 'payload'],
        );
        const canonicalAbsent = !lstatIfPresent(runtime.spec.source);
        let payloadComplete = false;
        try {
          payloadComplete = cronCleanupTreeState(
            payload, runtime.inventory, { complete: true },
          ).complete;
        } catch {}
        if (!postMove.entriesMatch) fail(failureCode);
        if (!canonicalAbsent || !payloadComplete) {
          assertCronCleanupMismatchFailClosed(
            paths, runtime,
            !canonicalAbsent ? 'canonical-recreated'
              : 'source-identity-after-move',
            cronCleanupMismatchObservation(runtime),
            ['intent.json', 'payload'],
          );
          fail(failureCode);
        }
        emitPrivateDirectoryRemovalTestPhase(testControls, 'quarantined', {
          path: runtime.spec.source,
          quarantine: runtime.container,
          payload,
          intentFile: runtime.intent.finalFile,
          identity: { ...runtime.authority.sourceIdentity, path: runtime.spec.source },
        });
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        if (runtime.topology !== 'moved') fail(failureCode);
        const beforeDelete = assertCronCleanupImmutableControl(paths, runtime);
        try {
          payloadComplete = cronCleanupTreeState(
            payload, runtime.inventory, { complete: true },
          ).complete;
        } catch { payloadComplete = false; }
        const entriesMatch = equal(beforeDelete.entries, ['intent.json', 'payload']);
        const stillCanonicalAbsent = !lstatIfPresent(runtime.spec.source);
        if (!entriesMatch) fail(failureCode);
        if (!stillCanonicalAbsent || !payloadComplete) {
          assertCronCleanupMismatchFailClosed(
            paths, runtime,
            !stillCanonicalAbsent ? 'canonical-recreated'
              : 'source-identity-after-move',
            cronCleanupMismatchObservation(runtime),
            ['intent.json', 'payload'],
          );
          fail(failureCode);
        }
        fsyncDirectory(runtime.container);
        emitPrivateDirectoryRemovalTestPhase(
          testControls, 'recovery-destination-fsynced', {
            path: runtime.spec.source, quarantine: runtime.container, payload,
          },
        );
        fsyncDirectory(runtime.spec.root);
        emitPrivateDirectoryRemovalTestPhase(
          testControls, 'recovery-source-fsynced', {
            path: runtime.spec.source, quarantine: runtime.container, payload,
          },
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        if (runtime.topology !== 'moved') fail(failureCode);
        const durableControl = assertCronCleanupImmutableControl(
          paths, runtime, ['intent.json', 'payload'],
        );
        let durablePayload = false;
        try {
          durablePayload = cronCleanupTreeState(
            path.join(runtime.container, 'payload'), runtime.inventory, { complete: true },
          ).complete;
        } catch {}
        if (!durableControl.entriesMatch || lstatIfPresent(runtime.spec.source)
            || !durablePayload) fail(failureCode);
        const deletion = cronCleanupDeleteAuthorityValue(runtime);
        startCronCleanupStagedPublication(
          runtime.spec.deleteFile, runtime.spec.deleteStagingFile, deletion,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'delete-staging-only') {
        completeCronCleanupStagedPublication(
          runtime.spec.deleteFile,
          runtime.spec.deleteStagingFile,
          runtime.deletePublication,
          runtime.deleteAuthority,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'deleting') {
        const control = assertCronCleanupImmutableControl(
          paths, runtime, ['intent.json', 'payload'],
        );
        if (!control.entriesMatch || lstatIfPresent(runtime.spec.source)) fail(failureCode);
        removeNextCronCleanupPayloadEntry(paths, runtime, testControls);
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'payload-removed') {
        const control = assertCronCleanupImmutableControl(paths, runtime, ['intent.json']);
        if (!control.entriesMatch || lstatIfPresent(runtime.spec.source)) fail(failureCode);
        const intent = assertCronCleanupFrozenRecord(
          runtime.intent.finalFile, runtime.intent.record,
          cronCleanupIntentValue(runtime.authority, runtime.containerIdentity),
        );
        // Node exposes no fd-relative unlink. The final same-UID component ABA
        // between this frozen-record gate and unlink is the explicit platform boundary.
        unlinkCronCleanupFileRecord(runtime.intent.finalFile, intent.identity, {
          expectedBytes: cronCleanupJsonBytes(
            cronCleanupIntentValue(runtime.authority, runtime.containerIdentity),
          ),
        });
        fsyncDirectory(runtime.container);
        if (lstatIfPresent(runtime.intent.finalFile)) fail(failureCode);
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'intent-removed') {
        const preflight = inspectCronCleanupBatch(paths);
        const refreshed = preflight.artifacts.find((artifact) => (
          artifact.spec.txId === runtime.spec.txId && artifact.spec.kind === runtime.spec.kind
            && artifact.spec.epoch === runtime.spec.epoch
        ));
        if (!refreshed || refreshed.topology !== 'intent-removed') fail(failureCode);
        runtime = refreshed;
        const quarantineRoot = cronCleanupQuarantineRoot(paths);
        const quarantineEntries = cronCleanupQuarantineNames(quarantineRoot);
        const expectedQuarantineEntries = cronCleanupSortedNames(
          preflight.artifacts.filter((artifact) => artifact.container)
            .map((artifact) => path.basename(artifact.container)),
        );
        const containerName = path.basename(runtime.container);
        if (!sameSerialDirectoryIdentity(
          runtime.container, runtime.authority.containerIdentity,
        ) || cronCleanupContainerNames(runtime.container).length !== 0
          || !sameSerialDirectoryIdentity(
            quarantineRoot, runtime.authority.quarantineRootIdentity,
          ) || !quarantineEntries.includes(containerName)
          || !equal(quarantineEntries, expectedQuarantineEntries)
          || lstatIfPresent(runtime.spec.source)) fail(failureCode);
        fs.rmdirSync(runtime.container);
        fsyncDirectory(quarantineRoot);
        if (lstatIfPresent(runtime.container) || !sameSerialDirectoryIdentity(
          quarantineRoot, runtime.authority.quarantineRootIdentity,
        )) fail(failureCode);
        assertCronCleanupDirectoryEntries(
          quarantineRoot, quarantineEntries.filter((name) => name !== containerName),
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'container-removed-delete') {
        const done = cronCleanupDoneValue(paths, runtime);
        startCronCleanupStagedPublication(
          runtime.spec.doneFile, runtime.spec.doneStagingFile, done,
          CRON_CLEANUP_DONE_MAX_BYTES,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'done-staging-only') {
        completeCronCleanupStagedPublication(
          runtime.spec.doneFile,
          runtime.spec.doneStagingFile,
          runtime.donePublication,
          runtime.done,
          CRON_CLEANUP_DONE_MAX_BYTES,
        );
        runtime = refreshCronCleanupArtifact(paths, runtime.spec);
        continue;
      }
      if (runtime.topology === 'done') {
        const removals = [
          [runtime.authorityPublication, runtime.spec.finalFile,
            runtime.done.authority, CRON_CLEANUP_FILE_MAX_BYTES],
          [runtime.reservationPublication, runtime.spec.reservationFile,
            runtime.done.reservation, CRON_CLEANUP_FILE_MAX_BYTES],
          [runtime.inventoryPublication, runtime.spec.inventoryFile,
            runtime.done.inventory, CRON_CLEANUP_INVENTORY_MAX_BYTES],
          [runtime.deletePublication, runtime.spec.deleteFile,
            runtime.done.deleteAuthority, CRON_CLEANUP_FILE_MAX_BYTES],
        ];
        const next = removals.find(([publication]) => publication?.finalPresent);
        if (next) {
          const [publication, file, expectedValue, maxBytes] = next;
          const record = assertCronCleanupFrozenRecord(
            file, publication.record, expectedValue, maxBytes,
          );
          unlinkCronCleanupFileRecord(file, record.identity, {
            expectedBytes: cronCleanupJsonBytes(expectedValue),
          });
          fsyncDirectory(runtime.spec.root);
          if (lstatIfPresent(file)) fail(failureCode);
          runtime = refreshCronCleanupArtifact(paths, runtime.spec);
          continue;
        }
        const doneRecord = assertCronCleanupFrozenRecord(
          runtime.spec.doneFile, runtime.doneRecord, runtime.done,
          CRON_CLEANUP_DONE_MAX_BYTES,
        );
        const removedAuthority = runtime.done.authority;
        unlinkCronCleanupFileRecord(runtime.spec.doneFile, doneRecord.identity, {
          expectedBytes: cronCleanupJsonBytes(runtime.done),
        });
        fsyncDirectory(runtime.spec.root);
        if (lstatIfPresent(runtime.spec.doneFile)) fail(failureCode);
        const after = inspectCronCleanupBatch(paths);
        if (after.artifacts.some((artifact) => artifact.spec.txId === runtime.spec.txId
          && artifact.spec.kind === runtime.spec.kind
          && artifact.spec.epoch === runtime.spec.epoch)) fail(failureCode);
        emitPrivateDirectoryRemovalTestPhase(testControls, 'removed', {
          path: runtime.spec.source,
          identity: { ...removedAuthority.sourceIdentity, path: runtime.spec.source },
        });
        return;
      }
      fail('CRON_WORKER_LIFECYCLE_INVALID');
    }
    fail(failureCode);
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) {
      if (error.code === failureCode) throw error;
      fail(failureCode);
    }
    fail(failureCode);
  }
}

function reconcileCronCleanupQuarantine(paths, options = {}) {
  // Inspection is deliberately complete and zero-write. No cleanup begins
  // until every authority and every quarantine container has a one-to-one,
  // identity-stable plan.
  const batch = inspectCronCleanupBatch(paths);
  const keys = batch.artifacts.map((artifact) => ({
    txId: artifact.spec.txId,
    kind: artifact.spec.kind,
    epoch: artifact.spec.epoch,
  }));
  for (const key of keys) {
    const fresh = inspectCronCleanupBatch(paths).artifacts.find(
      (artifact) => artifact.spec.txId === key.txId && artifact.spec.kind === key.kind
        && artifact.spec.epoch === key.epoch,
    );
    if (!fresh) fail('CRON_WORKER_LIFECYCLE_INVALID');
    finishCronCleanupArtifact(paths, fresh, options);
  }
  const after = inspectCronCleanupBatch(paths);
  if (after.artifacts.length > 0) fail('CRON_WORKER_LIFECYCLE_INVALID');
}

function reconcileCronCleanupQuarantineAtEntry(paths, options = {}) {
  // Establish the entire bound-source set before the first cleanup mutation.
  // A second unbound transient makes the whole batch read-only and fail closed.
  const before = inspectCronCleanupBatch(paths);
  assertNoUnboundCronCleanupSources(
    paths, new Set(before.artifacts.map((artifact) => artifact.spec.source)),
  );
  reconcileCronCleanupQuarantine(paths, options);
  assertNoUnboundCronCleanupSources(paths);
}

function removePrivateDirectoryIdentity(
  paths,
  identity,
  code = 'CRON_WORKER_LIFECYCLE_INVALID',
  { nestedIdentities = [], expectedSourceParentIdentity, testControls } = {},
) {
  reconcileCronCleanupQuarantine(paths, { code });
  if (!isObject(expectedSourceParentIdentity)) fail(code);
  const inventory = cronCleanupInventoryValue(
    paths, identity, nestedIdentities, expectedSourceParentIdentity,
  );
  const source = cronCleanupSourceSpec(paths, identity.path);
  const spec = cronCleanupAuthoritySpec(
    paths, source.txId, source.kind, source.epoch, sha256(inventory.bytes),
  );
  try {
    emitPrivateDirectoryRemovalTestPhase(
      testControls, 'inventory-captured-before-preflight', {
        path: identity.path,
        quarantineRoot: cronCleanupQuarantineRoot(paths),
      },
    );
    const batch = inspectCronCleanupBatch(paths);
    if (batch.artifacts.length !== 0) fail(code);
    const beforePublication = cronCleanupInventoryValue(
      paths, identity, nestedIdentities, expectedSourceParentIdentity,
    );
    if (!beforePublication.bytes.equals(inventory.bytes)) fail(code);
    const published = startCronCleanupStagedPublication(
      spec.inventoryFile, spec.inventoryStagingFile, inventory.value,
      CRON_CLEANUP_INVENTORY_MAX_BYTES,
    );
    if (!published.bytes.equals(inventory.bytes)) fail(code);
    const afterPublication = cronCleanupInventoryValue(
      paths, identity, nestedIdentities, expectedSourceParentIdentity,
    );
    if (!afterPublication.bytes.equals(inventory.bytes)) fail(code);
  } catch (error) {
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail(code);
  }
  reconcileCronCleanupQuarantine(paths, { code, testControls });
}

function createCronWorkerScratch(paths, txId, epoch) {
  const parent = txRoot(paths, txId);
  const parentIdentity = privateDirectoryIdentity(parent);
  const home = cronWorkerScratchPath(paths, txId, epoch);
  const tmp = path.join(home, 'tmp');
  let homeIdentity;
  try {
    fs.mkdirSync(home, { recursive: false, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(home, 0o700);
    homeIdentity = privateDirectoryIdentity(home);
    fs.mkdirSync(tmp, { recursive: false, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o700);
    const tmpIdentity = privateDirectoryIdentity(tmp);
    fsyncDirectory(tmp);
    fsyncDirectory(home);
    fsyncDirectory(parent);
    const stableHomeIdentity = privateDirectoryIdentity(home);
    if (!equal(serialDirectoryIdentity(homeIdentity), serialDirectoryIdentity(stableHomeIdentity))
        || !samePrivateDirectoryIdentity(home, homeIdentity)
        || !samePrivateDirectoryIdentity(tmp, tmpIdentity)
        || !samePrivateDirectoryIdentity(parent, parentIdentity)) fail('CRON_WORKER_FAILED');
    return { paths, home, tmp, homeIdentity, tmpIdentity, parentIdentity };
  } catch (error) {
    if (homeIdentity && samePrivateDirectoryIdentity(home, homeIdentity)) {
      try {
        removePrivateDirectoryIdentity(paths, homeIdentity, 'CRON_WORKER_FAILED', {
          expectedSourceParentIdentity: parentIdentity,
        });
      } catch {}
    }
    if (error instanceof BootstrapProfileTransactionError) throw error;
    fail('CRON_WORKER_FAILED');
  }
}

function cleanupCronWorkerScratch(scratch, testControls) {
  removePrivateDirectoryIdentity(
    scratch.paths,
    scratch.homeIdentity,
    'CRON_WORKER_LIFECYCLE_INVALID',
    {
      nestedIdentities: [{ relative: 'tmp', identity: scratch.tmpIdentity }],
      expectedSourceParentIdentity: scratch.parentIdentity,
      testControls,
    },
  );
}

function minimalWorkerEnv(paths, scratch, extra = {}) {
  let sqliteModuleRoot = '';
  try {
    sqliteModuleRoot = path.dirname(require.resolve('better-sqlite3/package.json', {
      paths: [path.join(paths.rcRoot, 'extensions/research-claw-core'), paths.rcRoot],
    }));
  } catch {}
  const env = {
    PATH: process.env.PATH ?? '',
    NODE_PATH: [
      process.env.NODE_PATH,
      sqliteModuleRoot ? path.dirname(sqliteModuleRoot) : '',
      path.join(paths.rcRoot, 'node_modules'),
    ].filter(Boolean).join(path.delimiter),
    HOME: scratch.home,
    USERPROFILE: scratch.home,
    TMPDIR: scratch.tmp,
    TMP: scratch.tmp,
    TEMP: scratch.tmp,
    ...extra,
  };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Do not inherit Vitest's test-state override. The explicit
  // OPENCLAW_STATE_DIR set inside the worker must remain authoritative.
  for (const key of ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID']) delete env[key];
  return env;
}

function uninstallCronSignalHandlers() {
  if (activeCronWorkers.size > 0) return;
  for (const [signal, handler] of cronSignalHandlers) process.removeListener(signal, handler);
  cronSignalHandlers.clear();
}

function cleanupCronWorker(record, { signal = false } = {}) {
  if (record.cleaned) return;
  record.cleaned = true;
  activeCronWorkers.delete(record);
  try {
    cleanupCronWorkerScratch(record.scratch);
    if (!signal && record.lifecycleAuthority) {
      clearCronWorkerLifecycleAuthority(
        record.paths, record.txId, record.epoch, record.lifecycleAuthority,
      );
    }
    if (signal && record.signalCleanupIdentity) {
      removePrivateDirectoryIdentity(
        record.paths, record.signalCleanupIdentity, 'CRON_WORKER_LIFECYCLE_INVALID',
        {
          nestedIdentities: record.signalCleanupNestedIdentities,
          expectedSourceParentIdentity: record.signalCleanupParentIdentity,
        },
      );
    }
  } finally {
    uninstallCronSignalHandlers();
  }
}

function installCronSignalHandlers() {
  if (cronSignalHandlers.size > 0) return;
  const exitCodes = { SIGINT: 130, SIGTERM: 143 };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      for (const record of [...activeCronWorkers]) {
        record.child.kill('SIGKILL');
        try { cleanupCronWorker(record, { signal: true }); } catch {}
      }
      process.exit(exitCodes[signal]);
    };
    cronSignalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function runCronWorker(paths, action, stateDir, payload, target, controls = {}) {
  return new Promise((resolve, reject) => {
    const worker = controls.workerFile
      ?? path.join(paths.rcRoot, 'scripts/bootstrap-profile/cron-worker.mjs');
    const timeoutMs = controls.timeoutMs ?? CRON_WORKER_TIMEOUT_MS;
    // The SQLite clone has a different database root, but its copied rows keep
    // the canonical live store_key. Always query by that live key.
    const storePath = path.join(paths.stateDir, 'cron/jobs.json');
    const txId = controls.txId ?? null;
    const live = target === 'live';
    if (typeof worker !== 'string' || worker.includes('\0') || !path.isAbsolute(worker)
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
        || typeof txId !== 'string' || !/^tx-[0-9a-f-]{36}$/.test(txId)) {
      reject(new BootstrapProfileTransactionError('CRON_WORKER_LIFECYCLE_INVALID'));
      return;
    }
    const epoch = crypto.randomUUID();
    let encoded;
    try {
      encoded = Buffer.from(JSON.stringify(payload ?? {}));
    } catch {
      reject(new BootstrapProfileTransactionError('CRON_WORKER_FAILED'));
      return;
    }
    if (encoded.length > CRON_WORKER_LIMIT) {
      reject(new BootstrapProfileTransactionError('CRON_WORKER_INPUT_TOO_LARGE'));
      return;
    }
    const inheritedFaults = ['test', 'bootstrap-worker-test'].includes(process.env.NODE_ENV)
      && process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS === '1' ? {
        NODE_ENV: process.env.NODE_ENV,
        RC_BOOTSTRAP_ENABLE_TEST_FAULTS: '1',
        ...(process.env.RC_BOOTSTRAP_WORKER_PAUSE_AT
          ? { RC_BOOTSTRAP_WORKER_PAUSE_AT: process.env.RC_BOOTSTRAP_WORKER_PAUSE_AT } : {}),
        ...(process.env.RC_BOOTSTRAP_WORKER_READY
          ? { RC_BOOTSTRAP_WORKER_READY: process.env.RC_BOOTSTRAP_WORKER_READY } : {}),
      } : {};
    let scratch;
    let signalCleanupIdentity;
    let signalCleanupParentIdentity;
    let signalCleanupNestedIdentities = [];
    let workerEnv;
    const discardScratch = () => {
      if (!scratch) return false;
      try {
        cleanupCronWorkerScratch(scratch);
        scratch = null;
        return false;
      } catch {
        return true;
      }
    };
    try {
      scratch = createCronWorkerScratch(paths, txId, epoch);
      workerEnv = minimalWorkerEnv(paths, scratch, inheritedFaults);
      if (controls.signalCleanupRoot !== undefined && controls.signalCleanupRoot !== null) {
        if (typeof controls.signalCleanupRoot !== 'string'
            || !path.isAbsolute(controls.signalCleanupRoot)
            || controls.signalCleanupRoot.includes('\0')) fail('CRON_WORKER_FAILED');
        if (controls.signalCleanupIdentity !== undefined) {
          if (!isObject(controls.signalCleanupIdentity)
              || controls.signalCleanupIdentity.path !== controls.signalCleanupRoot
              || !samePrivateDirectoryIdentity(
                controls.signalCleanupRoot, controls.signalCleanupIdentity,
              )) fail('CRON_WORKER_LIFECYCLE_INVALID');
          signalCleanupIdentity = clone(controls.signalCleanupIdentity);
        } else {
          signalCleanupIdentity = privateDirectoryIdentity(controls.signalCleanupRoot);
        }
        const signalParent = path.dirname(controls.signalCleanupRoot);
        if (controls.signalCleanupParentIdentity !== undefined) {
          if (!isObject(controls.signalCleanupParentIdentity)
              || controls.signalCleanupParentIdentity.path !== signalParent
              || !samePrivateDirectoryIdentity(
                signalParent, controls.signalCleanupParentIdentity,
              )) fail('CRON_WORKER_LIFECYCLE_INVALID');
          signalCleanupParentIdentity = clone(controls.signalCleanupParentIdentity);
        } else {
          signalCleanupParentIdentity = privateDirectoryIdentity(signalParent);
        }
        const requestedNested = controls.signalCleanupNestedIdentities ?? [];
        if (!Array.isArray(requestedNested)
            || requestedNested.length > CRON_CLEANUP_TREE_MAX_ENTRIES) {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        signalCleanupNestedIdentities = requestedNested.map((item) => {
          if (!isObject(item) || typeof item.relative !== 'string'
              || item.relative.length === 0 || item.relative.includes('\0')
              || path.isAbsolute(item.relative) || path.normalize(item.relative) !== item.relative
              || item.relative === '..' || item.relative.startsWith(`..${path.sep}`)
              || !isObject(item.identity)) fail('CRON_WORKER_LIFECYCLE_INVALID');
          const target = path.join(controls.signalCleanupRoot, item.relative);
          if (!isInside(controls.signalCleanupRoot, target)
              || item.identity.path !== target
              || !samePrivateDirectoryIdentity(target, item.identity)) {
            fail('CRON_WORKER_LIFECYCLE_INVALID');
          }
          return { relative: item.relative, identity: clone(item.identity) };
        });
      }
    } catch (error) {
      const cleanupFailed = discardScratch();
      reject(new BootstrapProfileTransactionError(cleanupFailed
        ? 'CRON_WORKER_LIFECYCLE_INVALID'
        : (error instanceof BootstrapProfileTransactionError ? error.code : 'CRON_WORKER_FAILED')));
      return;
    }
    let lifecycle;
    let lifecycleAuthority = null;
    try {
      lifecycle = live ? openCronWorkerLifecycle(paths, txId) : null;
      lifecycleAuthority = live
        ? JSON.stringify(stableValue(cronWorkerLifecycleAuthorityValue(
          scratch, txId, epoch, lifecycle.identity,
        )))
        : null;
    } catch (error) {
      const cleanupFailed = discardScratch();
      reject(new BootstrapProfileTransactionError(cleanupFailed
        ? 'CRON_WORKER_LIFECYCLE_INVALID'
        : (error instanceof BootstrapProfileTransactionError
          ? error.code : 'CRON_WORKER_LIFECYCLE_INVALID')));
      return;
    }
    let lifecycleClosed = false;
    const releaseLifecycle = () => {
      if (!lifecycle || lifecycleClosed) return;
      lifecycleClosed = true;
      try {
        if (!samePrivateDirectoryIdentity(
          path.dirname(lifecycle.file), lifecycle.rootIdentity,
        ) || !sameCronWorkerLifecycleFileIdentity(lifecycle.file, lifecycle.identity)) {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        const row = lifecycle.database.prepare(
          'SELECT epoch, state, authority FROM rc_cron_worker_epoch WHERE singleton = 1',
        ).get();
        if (!row || row.epoch !== epoch || row.state !== 'active'
            || row.authority !== lifecycleAuthority) {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        const changed = lifecycle.database.prepare(
          "UPDATE rc_cron_worker_epoch SET state = 'idle' WHERE singleton = 1 AND epoch = ? AND state = 'active'",
        ).run(epoch);
        if (changed.changes !== 1) fail('CRON_WORKER_LIFECYCLE_INVALID');
      } finally {
        lifecycle.database.close();
      }
    };
    if (lifecycle) {
      try {
        lifecycle.database.exec('BEGIN IMMEDIATE');
        const row = lifecycle.database.prepare(
          'SELECT tx_id AS txId, state, epoch, authority FROM rc_cron_worker_epoch WHERE singleton = 1',
        ).get();
        if (!row || row.txId !== txId || row.state !== 'idle'
            || row.epoch !== '' || row.authority !== '') {
          fail('CRON_WORKER_LIFECYCLE_INVALID');
        }
        lifecycle.database.prepare(
          "UPDATE rc_cron_worker_epoch SET epoch = ?, state = 'active', authority = ? WHERE singleton = 1",
        ).run(epoch, lifecycleAuthority);
        lifecycle.database.exec('COMMIT');
      } catch (error) {
        try { lifecycle.database.exec('ROLLBACK'); } catch {}
        lifecycle.database.close();
        lifecycleClosed = true;
        const cleanupFailed = discardScratch();
        reject(new BootstrapProfileTransactionError(cleanupFailed
          ? 'CRON_WORKER_LIFECYCLE_INVALID'
          : (error instanceof BootstrapProfileTransactionError
            ? error.code : 'CRON_WORKER_LIFECYCLE_INVALID')));
        return;
      }
    }
    const workerArgs = [
      worker, action, '--state-dir', stateDir, '--store-path', storePath,
      ...(live ? [
        '--lifecycle', lifecycle.file,
        '--tx-id', txId,
        '--epoch', epoch,
        '--lifecycle-dev', lifecycle.identity.dev,
        '--lifecycle-ino', lifecycle.identity.ino,
      ] : []),
    ];
    let child;
    try {
      child = spawn(process.execPath, workerArgs, {
        cwd: paths.rcRoot,
        env: workerEnv,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
    } catch {
      let lifecycleFailure = false;
      try {
        releaseLifecycle();
      } catch { lifecycleFailure = true; }
      if (discardScratch()) lifecycleFailure = true;
      if (!lifecycleFailure && lifecycleAuthority) {
        try {
          clearCronWorkerLifecycleAuthority(paths, txId, epoch, lifecycleAuthority);
        } catch { lifecycleFailure = true; }
      }
      reject(new BootstrapProfileTransactionError(
        lifecycleFailure ? 'CRON_WORKER_LIFECYCLE_INVALID' : 'CRON_WORKER_FAILED',
      ));
      return;
    }
    const record = {
      child,
      paths,
      scratch,
      signalCleanupIdentity: signalCleanupIdentity ?? null,
      signalCleanupParentIdentity: signalCleanupParentIdentity ?? null,
      signalCleanupNestedIdentities,
      txId,
      epoch,
      lifecycleAuthority,
      cleaned: false,
    };
    activeCronWorkers.add(record);
    installCronSignalHandlers();
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failed = false;
    let timedOut = false;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      let cleanupFailure = false;
      try { releaseLifecycle(); } catch { cleanupFailure = true; }
      try { cleanupCronWorker(record); } catch { cleanupFailure = true; }
      if (cleanupFailure) {
        reject(new BootstrapProfileTransactionError('CRON_WORKER_LIFECYCLE_INVALID'));
      } else callback();
    };
    const deadline = setTimeout(() => {
      failed = true;
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    deadline.unref();
    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      if (stdoutBytes + bytes.length > CRON_WORKER_LIMIT) {
        failed = true;
        child.kill('SIGKILL');
      } else {
        stdoutBytes += bytes.length;
        stdoutChunks.push(bytes);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > CRON_WORKER_LIMIT) {
        failed = true;
        child.kill('SIGKILL');
      }
    });
    child.stdin.on('error', () => {
      failed = true;
      child.kill('SIGKILL');
    });
    // Node emits `close` after `error`; keep the exact epoch active until all
    // child stdio descriptors have closed and the process can no longer write.
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code) => {
      finish(() => {
        if (failed || code !== 0 || stderrBytes > CRON_WORKER_LIMIT) {
          reject(new BootstrapProfileTransactionError(
            timedOut ? 'CRON_WORKER_TIMEOUT' : 'CRON_WORKER_FAILED',
          ));
          return;
        }
        try {
          resolve({
            output: JSON.parse(Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8')),
            record: { action, target, exited: true, pid: child.pid, ...(epoch ? { epoch } : {}) },
          });
        } catch {
          reject(new BootstrapProfileTransactionError('CRON_WORKER_FAILED'));
        }
      });
    });
    try {
      child.stdin.end(encoded);
    } catch {
      failed = true;
      child.kill('SIGKILL');
    }
  });
}

async function inspectCronState(paths, txId, controls = {}) {
  const cloneState = await cloneCronState(paths, txId);
  try {
    return await runCronWorker(paths, 'inspect', cloneState.path, {}, 'clone', {
      ...controls,
      txId,
      signalCleanupRoot: cloneState.path,
      signalCleanupIdentity: cloneState.identity,
      signalCleanupParentIdentity: cloneState.parentIdentity,
      signalCleanupNestedIdentities: [{
        relative: 'state', identity: cloneState.stateIdentity,
      }],
    });
  } finally {
    removePrivateDirectoryIdentity(
      paths, cloneState.identity, 'CRON_WORKER_LIFECYCLE_INVALID',
      {
        nestedIdentities: [{ relative: 'state', identity: cloneState.stateIdentity }],
        expectedSourceParentIdentity: cloneState.parentIdentity,
      },
    );
  }
}

function skillPlan(paths, capsule, receipt) {
  const oldDirectories = ownedSkillDirectories(receipt);
  const skills = capsule.skills.items.map((item) => ({
    slug: item.slug,
    directory: `rc-profile--${capsule.profile.id}--${item.slug}`,
    files: item.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  }));
  return { oldDirectories, skills };
}

function skillsConverged(paths, capsule, plan) {
  const desired = new Set(plan.skills.map((item) => item.directory));
  if (plan.oldDirectories.some((directory) => !desired.has(directory)
      && lstatIfPresent(path.join(paths.workspace, 'skills', directory)))) return false;
  for (const skill of capsule.skills.items) {
    const directory = path.join(paths.workspace, 'skills', `rc-profile--${capsule.profile.id}--${skill.slug}`);
    const metadata = lstatIfPresent(directory);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
    const expected = new Map(skill.files.map((file) => [file.path, file]));
    const found = [];
    const visit = (root, relative = '') => {
      for (const name of fs.readdirSync(root).sort()) {
        const absolute = path.join(root, name);
        const rel = relative ? `${relative}/${name}` : name;
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) return false;
        if (stat.isDirectory()) {
          if (visit(absolute, rel) === false) return false;
        } else if (stat.isFile()) found.push(rel);
        else return false;
      }
      return true;
    };
    if (visit(directory) === false || found.length !== expected.size) return false;
    for (const relative of found) {
      const file = expected.get(relative);
      if (!file || sha256(fs.readFileSync(path.join(directory, ...relative.split('/')))) !== file.sha256) return false;
    }
  }
  return true;
}

function writeSkills(paths, capsule, plan, txId) {
  const skillsRoot = path.join(paths.workspace, 'skills');
  const skillsRootMetadata = lstatIfPresent(skillsRoot);
  if (!skillsRootMetadata) ensureDirectory(skillsRoot, 0o700);
  else if (skillsRootMetadata.isSymbolicLink() || !skillsRootMetadata.isDirectory()) fail('UNSAFE_PATH');
  const stagingRoot = path.join(markerRoots(paths, txId).workspace, 'staging');
  ensureDirectory(stagingRoot, 0o700);
  for (const item of capsule.skills.items) {
    const directory = `rc-profile--${capsule.profile.id}--${item.slug}`;
    const staged = path.join(stagingRoot, directory);
    ensureDirectory(staged, 0o700);
    for (const file of item.files) {
      const target = path.join(staged, ...file.path.split('/'));
      if (!isInside(staged, target)) fail('PATH_ESCAPE');
      writeBytesAtomic(target, Buffer.from(file.content, 'utf8'), 0o600);
    }
  }
  const desired = new Set(plan.skills.map((item) => item.directory));
  for (const directory of [...new Set([...plan.oldDirectories, ...desired])].sort()) {
    const target = path.join(skillsRoot, directory);
    removePath(target);
    if (desired.has(directory)) {
      fs.renameSync(path.join(stagingRoot, directory), target);
      fsyncDirectory(skillsRoot);
    }
  }
  removePath(stagingRoot);
  fsyncDirectory(skillsRoot);
}

async function writeAuthStore(paths, txId, value) {
  const file = authStorePath(paths);
  ensureDirectory(path.dirname(file), 0o700);
  const { withFileLock } = await import('openclaw/plugin-sdk/file-lock');
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (content.length > AUTH_STORE_MAX_BYTES) fail('INVALID_AUTH_STORE');
  await withFileLock(file, AUTH_LOCK_OPTIONS, async () => {
    reconcileAuthAtomicWrite(paths, txId);
    const tempPrefix = authAtomicTempPrefix(txId);
    const tempName = `${tempPrefix}.${crypto.randomUUID()}.tmp`;
    writeJsonStagedNoReplace(
      authAtomicIntentPath(paths, txId), authAtomicIntentStagingPath(paths, txId),
      authAtomicIntent(paths, txId, content, tempName), 0o600,
    );
    try {
      writeBytesAtomic(file, content, 0o600, {
        ensureParent: false,
        temporaryPrefix: tempPrefix,
        temporaryName: tempName,
        beforeRename: () => {
          const faultsEnabled = process.env.NODE_ENV === 'test'
            && process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS === '1';
          if (faultsEnabled && process.env.RC_BOOTSTRAP_FAULT_PAUSE_AFTER === 'auth-temp') {
            const ready = process.env.RC_BOOTSTRAP_FAULT_READY;
            if (ready && path.isAbsolute(ready) && !ready.includes('\0')) {
              writeBytesAtomic(ready, Buffer.from('ready\n'), 0o600);
            }
            const signal = new Int32Array(new SharedArrayBuffer(4));
            for (;;) Atomics.wait(signal, 0, 0, 1_000);
          }
        },
      });
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    } finally {
      reconcileAuthAtomicWrite(paths, txId);
    }
  });
}

function writeMonitorRows(paths, beforeRows, afterRows) {
  if (equal(beforeRows, afterRows)) return;
  if (!lstatIfPresent(paths.dbPath)) fail('MONITOR_STORE_INVALID');
  const Database = resolveDatabase(paths);
  const database = new Database(paths.dbPath);
  try {
    const transaction = database.transaction(() => {
      const beforeMap = new Map(beforeRows.map((row) => [row.id, row]));
      for (const next of afterRows) {
        const before = beforeMap.get(next.id);
        if (!before || equal(before, next)) continue;
        database.prepare('UPDATE rc_monitors SET enabled=?, gateway_job_id=? WHERE id=?')
          .run(next.enabled, next.gateway_job_id, next.id);
      }
    });
    transaction();
    const result = database.pragma('quick_check');
    if (result?.[0]?.quick_check !== 'ok') fail('MONITOR_STORE_INVALID');
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
}

function buildReceipt(capsule, validated, skillState, managedDeny, ledger) {
  return {
    version: 1,
    profile: {
      id: capsule.profile.id,
      revision: capsule.profile.revision,
      digest: validated.digest,
    },
    provider: {
      id: capsule.model.providerId,
      authProfileId: validated.authProfileId,
    },
    skills: clone(skillState.skills),
    managedDeny: [...managedDeny].sort(),
    peripheralSuspensions: {
      monitors: Object.keys(ledger.entries).sort(),
      mcp: Object.keys(ledger.mcp).sort(),
    },
  };
}

function receiptEffectValue(receipt) {
  if (!receipt) return null;
  const value = clone(receipt);
  // A raw Capsule digest authenticates the transaction bytes, but array order
  // does not change the installed Skill tree.  Normalize only the receipt's
  // unordered Skill/file sets when comparing an already-installed revision.
  value.profile.digest = '<raw-capsule-digest>';
  value.skills = value.skills.map((skill) => ({
    ...skill,
    files: [...skill.files].sort((left, right) => left.path.localeCompare(right.path)),
  })).sort((left, right) => left.slug.localeCompare(right.slug));
  return value;
}

function afterStep(paths, txId, step, fault) {
  updateManifest(paths, txId, { state: 'applying', lastCompletedStep: step });
  updateMarkerStates(paths, txId, 'applying');
  const faultsEnabled = process.env.NODE_ENV === 'test'
    && process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS === '1';
  const pause = faultsEnabled ? process.env.RC_BOOTSTRAP_FAULT_PAUSE_AFTER : undefined;
  if (pause === step) {
    const ready = process.env.RC_BOOTSTRAP_FAULT_READY;
    if (ready && path.isAbsolute(ready) && !ready.includes('\0')) writeBytesAtomic(ready, Buffer.from('ready\n'), 0o600);
    const signal = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(signal, 0, 0, 1_000);
  }
  if (faultsEnabled && fault === step) fail('INJECTED_FAULT');
}

async function buildApplyPlan(paths, txId, validated, receipt) {
  const capsule = validated.capsule;
  const currentConfig = readJsonObject(paths.configPath, null, 'INVALID_CONFIG');
  const currentAuth = readPrivateJsonObject(
    path.join(paths.stateDir, 'agents/main/agent/auth-profiles.json'),
    { version: 1, profiles: {} },
    'INVALID_AUTH_STORE',
  );
  const currentGlobal = readJsonObject(paths.globalConfigPath, {});
  const initialLedger = readLedger(paths);
  const configPlan = buildConfigPlan(currentConfig, capsule, validated.authProfileId, receipt, initialLedger);
  const inspected = await inspectCronState(paths, txId);
  const rows = await inspectMonitorRows(paths, txId);
  const peripheralPlan = buildPeripheralPlan(
    rows,
    inspected.output.jobs,
    capsule.policy.capabilities.peripherals,
    capsule.profile.id,
    configPlan.ledger,
  );
  const auth = buildAuthPlan(currentAuth, capsule, validated.authProfileId, receipt);
  const globalConfig = buildGlobalConfigPlan(currentGlobal, capsule, validated.authProfileId, receipt);
  const skills = skillPlan(paths, capsule, receipt);
  const nextReceipt = buildReceipt(
    capsule, validated, skills, configPlan.managedDeny, peripheralPlan.ledger,
  );
  const managedStateConverged = equal(currentConfig, configPlan.config)
    && equal(currentAuth, auth)
    && equal(currentGlobal, globalConfig)
    && equal(initialLedger, peripheralPlan.ledger)
    && equal(rows, peripheralPlan.rows)
    && equal(inspected.output.jobs, peripheralPlan.jobs)
    && skillsConverged(paths, capsule, skills);
  const sameRevisionDifferentDigest = receipt?.profile?.id === capsule.profile.id
    && receipt?.profile?.revision === capsule.profile.revision
    && receipt?.profile?.digest !== validated.digest;
  if (sameRevisionDifferentDigest && (!managedStateConverged
      || !equal(receiptEffectValue(receipt), receiptEffectValue(nextReceipt)))) {
    fail('REVISION_DIGEST_CONFLICT');
  }
  const converged = receipt?.profile?.id === capsule.profile.id
    && receipt?.profile?.revision === capsule.profile.revision
    && receipt?.profile?.digest === validated.digest
    && managedStateConverged
    && equal(receipt, nextReceipt);
  return {
    currentConfig,
    currentAuth,
    currentGlobal,
    initialLedger,
    config: configPlan.config,
    auth,
    globalConfig,
    rows,
    jobs: inspected.output.jobs,
    nextRows: peripheralPlan.rows,
    nextJobs: peripheralPlan.jobs,
    ledger: peripheralPlan.ledger,
    receipt: nextReceipt,
    skills,
    converged,
    cronWorkers: [inspected.record],
  };
}

async function applyProfile(options) {
  const paths = normalizePaths(options, { stagedPrecondition: true });
  reconcileCronCleanupQuarantineAtEntry(paths);
  const manifest = readManifest(paths, options.txId);
  if (manifest.state !== 'staged') fail('INVALID_TRANSACTION_STATE');
  const capsuleBytes = readTransactionCapsule(paths, options.txId);
  const validated = validateCapsuleBytes(capsuleBytes, { rcVersion: '0.8.3' });
  if (validated.digest !== manifest.digest) fail('TRANSACTION_DIGEST_MISMATCH');
  // Reject a legacy or externally weakened credential store before the
  // preparing intent and any satellite transaction material is published.
  assertSmallPrivateJson(
    path.join(paths.stateDir, 'agents/main/agent/auth-profiles.json'), 'INVALID_AUTH_STORE',
  );
  const receipt = assertStagedPrecondition(paths, validated.capsule, manifest);
  // Once this intent is durable, recovery knows satellite marker creation may
  // be partial. No live asset is allowed to mutate while state is preparing.
  updateManifest(paths, options.txId, { state: 'preparing', volumeMarkers: null });
  const markers = createVolumeMarkers(
    paths, options.txId, receipt, validated.capsule, manifest, options.fault,
  );
  updateManifest(paths, options.txId, {
    volumeMarkers: Object.fromEntries(VOLUMES.map((volume) => [volume, markers[volume].preimageDigest])),
  });
  const plan = await buildApplyPlan(paths, options.txId, validated, receipt);

  if (plan.converged) {
    updateManifest(paths, options.txId, { state: 'applied', lastCompletedStep: 'noop' });
    updateMarkerStates(paths, options.txId, 'applied');
    return {
      ...publicTransaction(readManifest(paths, options.txId)),
      noop: true,
      cronWorkers: plan.cronWorkers,
      volumeMarkers: publicMarkers(paths, options.txId),
    };
  }

  // The complete four-volume preimage is durable before this transition. A
  // crash from this point onward must perform strict rollback, never cleanup.
  updateManifest(paths, options.txId, { state: 'applying', lastCompletedStep: null });
  updateMarkerStates(paths, options.txId, 'applying');

  writeSkills(paths, validated.capsule, plan.skills, options.txId);
  afterStep(paths, options.txId, 'skills', options.fault);

  await writeAuthStore(paths, options.txId, plan.auth);
  afterStep(paths, options.txId, 'auth', options.fault);

  writeLiveConfigAtomic(paths, options.txId, 'project', plan.config);
  writeLiveConfigAtomic(paths, options.txId, 'global', plan.globalConfig);
  afterStep(paths, options.txId, 'config', options.fault);

  writeMonitorRows(paths, plan.rows, plan.nextRows);
  afterStep(paths, options.txId, 'monitor', options.fault);

  if (!equal(plan.jobs, plan.nextJobs)) {
    const replaced = await runCronWorker(paths, 'compare-and-replace', paths.stateDir, {
      expectedDigest: jobsDigest(plan.jobs), jobs: plan.nextJobs,
    }, 'live', { txId: options.txId });
    plan.cronWorkers.push(replaced.record);
    verifyAndCheckpointCronStore(paths);
  }
  afterStep(paths, options.txId, 'cron', options.fault);

  writeJsonAtomic(suspensionsPath(paths), plan.ledger, 0o600);
  afterStep(paths, options.txId, 'suspensions', options.fault);

  writeJsonAtomic(receiptPath(paths), plan.receipt, 0o600);
  afterStep(paths, options.txId, 'receipt', options.fault);

  updateManifest(paths, options.txId, { state: 'applied', lastCompletedStep: 'receipt' });
  updateMarkerStates(paths, options.txId, 'applied');
  return {
    ...publicTransaction(readManifest(paths, options.txId)),
    noop: false,
    cronWorkers: plan.cronWorkers,
    volumeMarkers: publicMarkers(paths, options.txId),
  };
}

async function verifyProfile(options) {
  const paths = normalizePaths(options);
  reconcileCronCleanupQuarantineAtEntry(paths);
  const manifest = readManifest(paths, options.txId);
  if (manifest.state !== 'applied') fail('INVALID_TRANSACTION_STATE');
  const capsuleBytes = readTransactionCapsule(paths, options.txId);
  const validated = validateCapsuleBytes(capsuleBytes, { rcVersion: '0.8.3' });
  const receipt = readReceipt(paths);
  if (!receipt || receipt.profile.id !== validated.capsule.profile.id
      || receipt.profile.revision !== validated.capsule.profile.revision
      || receipt.profile.digest !== validated.digest) fail('VERIFY_FAILED');
  const preimageAuth = readAuthVerificationPreimage(paths, options.txId, manifest);
  const plan = await buildApplyPlan(paths, options.txId, validated, receipt);
  const key = validated.capsule.secrets.modelApiKey;
  const countStructuredValue = (value) => {
    if (typeof value === 'string') return value === key ? 1 : 0;
    if (Array.isArray(value)) return value.reduce((count, item) => count + countStructuredValue(item), 0);
    if (isObject(value)) {
      return Object.values(value).reduce((count, item) => count + countStructuredValue(item), 0);
    }
    return 0;
  };
  const forbiddenJson = [
    plan.currentConfig,
    plan.currentGlobal,
    plan.initialLedger,
    plan.config,
    plan.globalConfig,
    receipt,
    plan.ledger,
  ];
  if (forbiddenJson.some((value) => countStructuredValue(value) > 0)) fail('SECRET_COPY_DETECTED');
  try {
    for (const skill of receipt.skills) {
      assertNoUnexpectedStateSecretCopies({
        stateDir: path.join(paths.workspace, 'skills', skill.directory),
        secret: key,
      });
    }
    assertCanonicalAuthSecretPlacement({
      authStore: plan.currentAuth,
      preimageAuthStore: preimageAuth.authStore,
      retiredAuthProfileId: preimageAuth.retiredAuthProfileId,
      authProfileId: validated.authProfileId,
      providerId: validated.capsule.model.providerId,
      secret: key,
    });
    assertNoUnexpectedStateSecretCopies({
      stateDir: paths.stateDir,
      secret: key,
      allowedFiles: [path.join(paths.stateDir, 'agents/main/agent/auth-profiles.json')],
      // Transaction preimages and staged Capsules are an explicit, private,
      // short-lived recovery allowlist until commit/rollback removes them.
      allowedDirectories: [path.join(paths.stateDir, '.rc-bootstrap-transactions')],
    });
  } catch (error) {
    if (error?.code === 'SECRET_COPY_DETECTED') fail('SECRET_COPY_DETECTED');
    fail('SECRET_SCAN_FAILED');
  }
  if (!plan.converged) fail('VERIFY_FAILED');
  updateManifest(paths, options.txId, { state: 'verified' });
  updateMarkerStates(paths, options.txId, 'verified');
  return publicTransaction(readManifest(paths, options.txId));
}

function certificateFor(paths, txId, manifest) {
  const roots = markerRoots(paths, txId);
  const markerDigests = {};
  for (const volume of VOLUMES) {
    const marker = readJsonObject(path.join(roots[volume], 'volume-marker.json'), null, 'INVALID_VOLUME_MARKER');
    if (marker.txId !== txId || marker.state !== 'verified'
        || marker.capsuleDigest !== manifest.digest) fail('INVALID_VOLUME_MARKER');
    markerDigests[volume] = valueHash(marker);
  }
  const body = {
    version: 1,
    txId,
    profileId: manifest.profileId,
    capsuleDigest: manifest.digest,
    volumes: [...VOLUMES],
    markerDigests,
  };
  return { ...body, digest: valueHash(body) };
}

function cleanupIntentFor(paths, manifest) {
  if (manifest.state !== 'committed') fail('INVALID_TRANSACTION_STATE');
  const topology = validateCommittedTransactionTopology(paths, manifest);
  const roots = markerRoots(paths, manifest.txId);
  const cleanupRoots = committedCleanupRoots(paths, manifest.txId);
  const rootIdentities = Object.fromEntries(VOLUMES.map((volume) => {
    const metadata = lstatIfPresent(roots[volume]);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail('INCOMPLETE_TRANSACTION_PREIMAGE');
    }
    return [volume, { dev: String(metadata.dev), ino: String(metadata.ino) }];
  }));
  const rootInventories = Object.fromEntries(VOLUMES.map((volume) => [
    volume,
    transactionTreeInventory(roots[volume], {
      excluded: volume === 'config'
        ? [path.basename(preparedCommittedCleanupIntentPath(paths, manifest.txId))]
        : [],
    }),
  ]));
  // The cleanup authority is prepared while the manifest is still verified,
  // but it authenticates the exact tree that will exist after the one global
  // commit-point rename. Predict those bytes so the authority can be durable
  // before the commit point without weakening later tombstone validation.
  const committedManifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestInventory = rootInventories.config.find(
    (entry) => entry.path === 'manifest.json' && entry.type === 'file',
  );
  if (!manifestInventory) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  manifestInventory.size = committedManifestBytes.length;
  manifestInventory.sha256 = sha256(committedManifestBytes);
  const body = {
    version: 1,
    txId: manifest.txId,
    profileId: manifest.profileId,
    capsuleDigest: manifest.digest,
    manifestIdentity: expectedMarkerIdentity(manifest),
    pathsHash: manifest.pathsHash,
    transactionRoots: roots,
    cleanupRoots,
    rootIdentities,
    rootInventories,
    transactionTopology: topology.markers.config.transactionTopology,
    commitCertificate: manifest.commitCertificate,
  };
  return { ...body, digest: valueHash(body) };
}

function validateCleanupIntent(paths, intent) {
  if (!exactKeys(intent, [
    'version', 'txId', 'profileId', 'capsuleDigest', 'manifestIdentity', 'pathsHash',
    'transactionRoots', 'cleanupRoots', 'rootIdentities', 'transactionTopology',
    'rootInventories', 'commitCertificate', 'digest',
  ]) || intent.version !== 1 || !/^tx-[0-9a-f-]{36}$/.test(intent.txId)
      || !isSlug(intent.profileId) || !/^[0-9a-f]{64}$/.test(intent.capsuleDigest)
      || intent.manifestIdentity !== valueHash({
        txId: intent.txId, profileId: intent.profileId, digest: intent.capsuleDigest,
      })
      || intent.pathsHash !== pathsHash(paths)
      || !equal(intent.transactionRoots, markerRoots(paths, intent.txId))
      || !equal(intent.cleanupRoots, committedCleanupRoots(paths, intent.txId))
      || !exactKeys(intent.rootIdentities, VOLUMES)
      || !exactKeys(intent.rootInventories, VOLUMES)) {
    fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
  validateTransactionTopology(paths, intent.transactionTopology);
  for (const identity of Object.values(intent.rootIdentities)) {
    if (!exactKeys(identity, ['dev', 'ino']) || !/^\d+$/.test(identity.dev)
        || !/^\d+$/.test(identity.ino)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
  for (const inventory of Object.values(intent.rootInventories)) {
    validateTransactionTreeInventory(inventory);
  }
  const body = {
    version: intent.version,
    txId: intent.txId,
    profileId: intent.profileId,
    capsuleDigest: intent.capsuleDigest,
    manifestIdentity: intent.manifestIdentity,
    pathsHash: intent.pathsHash,
    transactionRoots: intent.transactionRoots,
    cleanupRoots: intent.cleanupRoots,
    rootIdentities: intent.rootIdentities,
    rootInventories: intent.rootInventories,
    transactionTopology: intent.transactionTopology,
    commitCertificate: intent.commitCertificate,
  };
  if (!/^[0-9a-f]{64}$/.test(intent.digest) || intent.digest !== valueHash(body)) {
    fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
  validateCertificateValue(
    intent.commitCertificate, intent.txId, intent.profileId, intent.capsuleDigest,
  );
  return intent;
}

function prepareCommittedCleanupIntent(paths, manifest) {
  if (manifest.state !== 'committed') fail('INVALID_TRANSACTION_STATE');
  const intent = cleanupIntentFor(paths, manifest);
  const file = preparedCommittedCleanupIntentPath(paths, manifest.txId);
  if (lstatIfPresent(file)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  writeJsonAtomic(file, intent, 0o600, {
    beforeRename: () => maybePauseForFault('cleanup-intent-prepared-temp'),
  });
  const persisted = readPrivateJsonObject(file, null, 'INVALID_COMMITTED_CLEANUP_INTENT');
  validateCleanupIntent(paths, persisted);
  if (!equal(persisted, intent)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  return intent;
}

function publishCommittedCleanupIntent(paths, intent) {
  validateCleanupIntent(paths, intent);
  const manifest = readManifest(paths, intent.txId);
  if (manifest.state !== 'committed' || !equal(cleanupIntentFor(paths, manifest), intent)) {
    fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
  const prepared = preparedCommittedCleanupIntentPath(paths, intent.txId);
  assertSmallPrivateJson(prepared, 'INVALID_COMMITTED_CLEANUP_INTENT');
  if (!lstatIfPresent(prepared)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  const persisted = readPrivateJsonObject(
    prepared, null, 'INVALID_COMMITTED_CLEANUP_INTENT',
  );
  validateCleanupIntent(paths, persisted);
  if (!equal(persisted, intent)) fail('INVALID_COMMITTED_CLEANUP_INTENT');

  const authorityRoot = committedCleanupRoot(paths);
  const rootMetadata = lstatIfPresent(authorityRoot);
  if (rootMetadata) {
    assertPrivateDirectory(authorityRoot, 'INVALID_COMMITTED_CLEANUP_INTENT');
    if (fs.readdirSync(authorityRoot).length !== 0) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  } else {
    ensureDirectory(authorityRoot, 0o700);
  }
  const final = committedCleanupIntentPath(paths, intent.txId);
  if (lstatIfPresent(final)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  if (fs.statSync(path.dirname(prepared)).dev !== fs.statSync(authorityRoot).dev) {
    fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
  fs.renameSync(prepared, final);
  fsyncDirectory(path.dirname(prepared));
  fsyncDirectory(authorityRoot);
  assertSmallPrivateJson(final, 'INVALID_COMMITTED_CLEANUP_INTENT');
  const published = readPrivateJsonObject(final, null, 'INVALID_COMMITTED_CLEANUP_INTENT');
  validateCleanupIntent(paths, published);
  if (!equal(published, intent)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  return intent;
}

function readCommittedCleanupIntents(paths) {
  const root = committedCleanupRoot(paths);
  const metadata = lstatIfPresent(root);
  if (!metadata) return [];
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
  const intents = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!/^tx-[0-9a-f-]{36}\.json$/.test(name)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
    const file = path.join(root, name);
    assertSmallPrivateJson(file, 'INVALID_COMMITTED_CLEANUP_INTENT');
    const intent = readPrivateJsonObject(file, null, 'INVALID_COMMITTED_CLEANUP_INTENT');
    validateCleanupIntent(paths, intent);
    if (name !== `${intent.txId}.json`) fail('INVALID_COMMITTED_CLEANUP_INTENT');
    // A final authority only exists after an atomic same-filesystem rename.
    // Seeing both names is therefore a collision, never a recoverable stage;
    // reject it before any per-volume cleanup can make monotonic progress.
    if (lstatIfPresent(preparedCommittedCleanupIntentPath(paths, intent.txId))) {
      fail('INVALID_COMMITTED_CLEANUP_INTENT');
    }
    intents.push(intent);
  }
  validateCleanupTombstoneSet(paths, intents);
  return intents;
}

function committedCleanupRoots(paths, txId) {
  return {
    config: path.join(bootstrapRoot(paths), 'committed-cleanup-tombstones', txId),
    workspace: path.join(paths.workspace, '.rc-bootstrap-committed-cleanup', txId),
    state: path.join(paths.stateDir, '.rc-bootstrap-committed-cleanup', txId),
    data: path.join(paths.roots.data, '.rc-bootstrap-committed-cleanup', txId),
  };
}

function cleanupTombstoneParents(paths) {
  return {
    config: path.join(bootstrapRoot(paths), 'committed-cleanup-tombstones'),
    workspace: path.join(paths.workspace, '.rc-bootstrap-committed-cleanup'),
    state: path.join(paths.stateDir, '.rc-bootstrap-committed-cleanup'),
    data: path.join(paths.roots.data, '.rc-bootstrap-committed-cleanup'),
  };
}

function validateCleanupTombstoneSet(paths, intents) {
  const ids = new Set(intents.map((intent) => intent.txId));
  for (const parent of Object.values(cleanupTombstoneParents(paths))) {
    const metadata = lstatIfPresent(parent);
    if (!metadata) continue;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()
        || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) {
      fail('INVALID_COMMITTED_CLEANUP_INTENT');
    }
    for (const name of fs.readdirSync(parent)) {
      if (!/^tx-[0-9a-f-]{36}$/.test(name) || !ids.has(name)) {
        fail('INVALID_COMMITTED_CLEANUP_INTENT');
      }
    }
  }
}

function transactionTreeInventory(root, { excluded = [] } = {}) {
  const excludedPaths = new Set(excluded);
  if ([...excludedPaths].some((relative) => !safeCleanupRelative(relative))) {
    fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
  const entries = [];
  let totalBytes = 0;
  const visit = (target, relative) => {
    if (excludedPaths.has(relative)) return;
    const metadata = lstatIfPresent(target);
    if (!metadata || metadata.isSymbolicLink()) fail('INVALID_COMMITTED_CLEANUP_INTENT');
    if (relative !== '') {
      if (entries.length >= 20_000) fail('INVALID_COMMITTED_CLEANUP_INTENT');
      if (metadata.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
      } else if (metadata.isFile() && metadata.nlink === 1) {
        totalBytes += metadata.size;
        if (totalBytes > 64 * 1024 * 1024) fail('INVALID_COMMITTED_CLEANUP_INTENT');
        entries.push({
          path: relative,
          type: 'file',
          size: metadata.size,
          sha256: sha256(fs.readFileSync(target)),
        });
        return;
      } else {
        fail('INVALID_COMMITTED_CLEANUP_INTENT');
      }
    } else if (!metadata.isDirectory()) {
      fail('INVALID_COMMITTED_CLEANUP_INTENT');
    }
    for (const name of fs.readdirSync(target).sort()) {
      visit(path.join(target, name), relative ? path.join(relative, name) : name);
    }
  };
  visit(root, '');
  return entries;
}

function safeCleanupRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
    && !path.isAbsolute(value) && path.normalize(value) === value
    && value !== '..' && !value.startsWith(`..${path.sep}`);
}

function validateTransactionTreeInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.length < 1 || inventory.length > 20_000) {
    fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
  let previous = null;
  const seen = new Set();
  for (const entry of inventory) {
    if (!isObject(entry) || !safeCleanupRelative(entry.path) || seen.has(entry.path)
        || (previous !== null && previous > entry.path)
        || !['directory', 'file'].includes(entry.type)) {
      fail('INVALID_COMMITTED_CLEANUP_INTENT');
    }
    if (entry.type === 'directory') {
      if (!exactKeys(entry, ['path', 'type'])) fail('INVALID_COMMITTED_CLEANUP_INTENT');
    } else if (!exactKeys(entry, ['path', 'type', 'size', 'sha256'])
        || !Number.isSafeInteger(entry.size) || entry.size < 0
        || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail('INVALID_COMMITTED_CLEANUP_INTENT');
    }
    seen.add(entry.path);
    previous = entry.path;
  }
}

function validateRemainingCleanupTree(root, inventory, { complete }) {
  const expected = new Map(inventory.map((entry) => [entry.path, entry]));
  const actual = transactionTreeInventory(root);
  if (complete && !equal(actual, inventory)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  for (const entry of actual) {
    const known = expected.get(entry.path);
    if (!known || !equal(entry, known)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
}

function validateCleanupRootIdentity(target, identity) {
  const metadata = lstatIfPresent(target);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()
      || String(metadata.dev) !== identity.dev || String(metadata.ino) !== identity.ino) {
    fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
}

function validateCommittedSourceRoot(paths, intent, volume) {
  const root = intent.transactionRoots[volume];
  validateCleanupRootIdentity(root, intent.rootIdentities[volume]);
  const markerFile = path.join(root, 'volume-marker.json');
  const certificateFile = path.join(root, 'commit-certificate.json');
  if (!lstatIfPresent(markerFile) || !lstatIfPresent(certificateFile)) {
    fail('INCOMPLETE_TRANSACTION_PREIMAGE');
  }
  const marker = readJsonObject(markerFile, null, 'INVALID_VOLUME_MARKER');
  validateMarkerForRestore(paths, intent.txId, volume, marker);
  if (marker.state !== 'verified' || marker.profileId !== intent.profileId
      || marker.capsuleDigest !== intent.capsuleDigest
      || marker.manifestIdentity !== intent.manifestIdentity
      || !equal(marker.transactionTopology, intent.transactionTopology)
      || valueHash(marker) !== intent.commitCertificate.markerDigests[volume]) {
    fail('INVALID_VOLUME_MARKER');
  }
  assertSmallPrivateJson(certificateFile, 'INVALID_COMMIT_CERTIFICATE');
  if (!equal(
    readJsonObject(certificateFile, null, 'INVALID_COMMIT_CERTIFICATE'),
    intent.commitCertificate,
  )) fail('INVALID_COMMIT_CERTIFICATE');
  validateRemainingCleanupTree(root, intent.rootInventories[volume], { complete: true });
}

function removeCleanupTreeIncremental(target, volume, rootPath, inventoryMap, root = true) {
  const metadata = lstatIfPresent(target);
  if (!metadata) return;
  if (metadata.isSymbolicLink()) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  const relative = root ? '' : path.relative(rootPath, target);
  const expected = root ? null : inventoryMap.get(relative);
  if (!root && (!expected || (metadata.isDirectory() ? expected.type !== 'directory'
    : expected.type !== 'file'))) fail('INVALID_COMMITTED_CLEANUP_INTENT');
  if (metadata.isDirectory()) {
    for (const name of fs.readdirSync(target).sort()) {
      removeCleanupTreeIncremental(
        path.join(target, name), volume, rootPath, inventoryMap, false,
      );
    }
    fs.rmdirSync(target);
  } else if (metadata.isFile() && metadata.nlink === 1) {
    if (metadata.size !== expected.size || sha256(fs.readFileSync(target)) !== expected.sha256) {
      fail('INVALID_COMMITTED_CLEANUP_INTENT');
    }
    fs.unlinkSync(target);
  } else {
    fail('INVALID_COMMITTED_CLEANUP_INTENT');
  }
  fsyncDirectory(path.dirname(target));
  if (!root) maybePauseForFault(`cleanup-${volume}-entry`);
}

function finishCommittedCleanup(paths, intent, fault) {
  validateCleanupIntent(paths, intent);
  for (const volume of ['workspace', 'state', 'data', 'config']) {
    const source = intent.transactionRoots[volume];
    const tombstone = intent.cleanupRoots[volume];
    const sourceMetadata = lstatIfPresent(source);
    const tombstoneMetadata = lstatIfPresent(tombstone);
    if (sourceMetadata && tombstoneMetadata) fail('INVALID_COMMITTED_CLEANUP_INTENT');
    if (sourceMetadata) {
      validateCommittedSourceRoot(paths, intent, volume);
      const parent = path.dirname(tombstone);
      const parentMetadata = lstatIfPresent(parent);
      if (parentMetadata && (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory())) {
        fail('INVALID_COMMITTED_CLEANUP_INTENT');
      }
      ensureDirectory(parent, 0o700);
      fs.renameSync(source, tombstone);
      fsyncDirectory(path.dirname(source));
      fsyncDirectory(parent);
      maybeInjectFault(`cleanup-${volume}-renamed`, fault);
    }
    if (lstatIfPresent(tombstone)) {
      validateCleanupRootIdentity(tombstone, intent.rootIdentities[volume]);
      validateRemainingCleanupTree(tombstone, intent.rootInventories[volume], { complete: false });
      removeCleanupTreeIncremental(
        tombstone, volume, tombstone,
        new Map(intent.rootInventories[volume].map((entry) => [entry.path, entry])),
      );
    }
    const parent = path.dirname(tombstone);
    if (lstatIfPresent(parent)?.isDirectory() && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
      fsyncDirectory(path.dirname(parent));
    }
  }
  removePath(committedCleanupIntentPath(paths, intent.txId));
  const root = committedCleanupRoot(paths);
  if (lstatIfPresent(root)?.isDirectory() && fs.readdirSync(root).length === 0) {
    fs.rmdirSync(root);
    fsyncDirectory(path.dirname(root));
  }
}

async function commitProfile(options) {
  const paths = normalizePaths(options);
  reconcileCronCleanupQuarantineAtEntry(paths);
  const manifest = readManifest(paths, options.txId);
  if (manifest.state !== 'verified') fail('INVALID_TRANSACTION_STATE');
  const certificate = certificateFor(paths, options.txId, manifest);
  const roots = markerRoots(paths, options.txId);
  for (const volume of VOLUMES) {
    writeJsonAtomic(path.join(roots[volume], 'commit-certificate.json'), certificate, 0o600);
    maybeInjectFault(`certificate-${volume}`, options.fault);
  }
  for (const volume of VOLUMES) {
    const candidate = readJsonObject(
      path.join(roots[volume], 'commit-certificate.json'), null, 'INVALID_COMMIT_CERTIFICATE',
    );
    if (!equal(candidate, certificate)) fail('INVALID_COMMIT_CERTIFICATE');
    const marker = readJsonObject(
      path.join(roots[volume], 'volume-marker.json'), null, 'INVALID_VOLUME_MARKER',
    );
    if (valueHash(marker) !== certificate.markerDigests[volume]) fail('INVALID_COMMIT_CERTIFICATE');
  }
  maybeInjectFault('certificates-written', options.fault);
  const committedManifest = {
    ...manifest,
    state: 'committed',
    commitCertificate: certificate,
  };
  const cleanupIntent = prepareCommittedCleanupIntent(paths, committedManifest);
  // This manifest transition is the commit point. Recovery after it is only
  // allowed to finish deleting transaction material; it must never restore an
  // already committed subset of volumes.
  updateManifest(paths, options.txId, { state: 'committed', commitCertificate: certificate });
  maybePauseForFault('cleanup-intent-committed');
  maybeInjectFault('commit-intent', options.fault);
  publishCommittedCleanupIntent(paths, cleanupIntent);
  maybePauseForFault('cleanup-intent-published');
  maybeInjectFault('cleanup-intent', options.fault);
  finishCommittedCleanup(paths, cleanupIntent, options.fault);
  return { state: 'committed', profileId: manifest.profileId, commitCertificate: certificate };
}

function validateMarkerForRestore(paths, txId, volume, marker) {
  const definitions = {
    config: paths.roots.config,
    workspace: paths.workspace,
    state: paths.stateDir,
    data: paths.roots.data,
  };
  const root = definitions[volume];
  const markerKeys = new Set([
    'version', 'txId', 'volume', 'state', 'profileId', 'capsuleDigest', 'manifestIdentity',
    'volumeRoot', 'transactionTopology', 'assets', 'directories', 'preimageDigest',
  ]);
  if (!isObject(marker) || Object.keys(marker).some((key) => !markerKeys.has(key))
      || !['prepared', 'applying', 'applied', 'verified'].includes(marker.state)) {
    fail('INVALID_VOLUME_MARKER');
  }
  if (marker.txId !== txId || marker.volume !== volume || marker.volumeRoot !== root
      || marker.version !== 1 || !Array.isArray(marker.assets) || !Array.isArray(marker.directories)
      || !isSlug(marker.profileId) || !/^[0-9a-f]{64}$/.test(marker.capsuleDigest)
      || marker.manifestIdentity !== valueHash({
        txId, profileId: marker.profileId, digest: marker.capsuleDigest,
      })
      || marker.preimageDigest !== valueHash({
        transactionTopology: marker.transactionTopology,
        assets: marker.assets.map(({ id, target, digest }) => ({ id, target, digest })),
        directories: marker.directories,
      })) fail('INVALID_VOLUME_MARKER');
  validateTransactionTopology(paths, marker.transactionTopology);
  const volumeTopology = marker.transactionTopology[volume];
  if (!equal(marker.assets.map(({ id, target }) => ({ id, target })), volumeTopology.assets)
      || !equal(marker.directories.map(({ target }) => target), volumeTopology.directories)) {
    fail('INVALID_VOLUME_MARKER');
  }
  for (const directory of marker.directories) {
    if (!isObject(directory) || typeof directory.target !== 'string'
        || typeof directory.existed !== 'boolean'
        || (directory.mode !== null && !Number.isSafeInteger(directory.mode))) fail('INVALID_VOLUME_MARKER');
    const target = path.join(root, directory.target);
    if (!isInside(root, target)) fail('INVALID_VOLUME_MARKER');
  }
  for (const asset of marker.assets) {
    if (!isObject(asset) || Object.keys(asset).sort().join(',') !== 'digest,id,snapshot,target'
        || typeof asset.id !== 'string' || typeof asset.target !== 'string'
        || typeof asset.snapshot !== 'string' || !/^[0-9a-f]{64}$/.test(asset.digest)) {
      fail('INVALID_VOLUME_MARKER');
    }
    const target = path.join(root, asset.target);
    if (!isInside(root, target)) fail('INVALID_VOLUME_MARKER');
    const snapshot = path.join(markerRoots(paths, txId)[volume], asset.snapshot);
    if (!isInside(markerRoots(paths, txId)[volume], snapshot)) fail('INVALID_VOLUME_MARKER');
    try { verifySnapshot(snapshot, asset.digest); } catch { fail('INVALID_TRANSACTION_PREIMAGE'); }
  }
}

function validateTransactionTopology(paths, topology) {
  if (!exactKeys(topology, VOLUMES)) fail('INVALID_VOLUME_MARKER');
  const expected = {
    config: {
      volumeRoot: paths.roots.config,
      directories: [],
      assets: [
        { id: 'config', target: path.relative(paths.roots.config, paths.configPath) },
        { id: 'receipt', target: path.relative(paths.roots.config, receiptPath(paths)) },
        { id: 'suspensions', target: path.relative(paths.roots.config, suspensionsPath(paths)) },
      ],
    },
    state: {
      volumeRoot: paths.stateDir,
      directories: [
        path.relative(paths.stateDir, path.join(paths.stateDir, 'agents')),
        path.relative(paths.stateDir, path.join(paths.stateDir, 'agents/main')),
        path.relative(paths.stateDir, path.join(paths.stateDir, 'agents/main/agent')),
        path.relative(paths.stateDir, path.join(paths.stateDir, 'state')),
      ],
      assets: [
        { id: 'auth', target: path.relative(paths.stateDir, authStorePath(paths)) },
        { id: 'global-config', target: path.relative(paths.stateDir, paths.globalConfigPath) },
        { id: 'cron-db', target: path.relative(paths.stateDir, path.join(paths.stateDir, 'state/openclaw.sqlite')) },
        { id: 'cron-wal', target: path.relative(paths.stateDir, path.join(paths.stateDir, 'state/openclaw.sqlite-wal')) },
        { id: 'cron-shm', target: path.relative(paths.stateDir, path.join(paths.stateDir, 'state/openclaw.sqlite-shm')) },
      ],
    },
    data: {
      volumeRoot: paths.roots.data,
      directories: [],
      assets: [
        { id: 'rc-db', target: path.relative(paths.roots.data, paths.dbPath) },
        { id: 'rc-wal', target: path.relative(paths.roots.data, `${paths.dbPath}-wal`) },
        { id: 'rc-shm', target: path.relative(paths.roots.data, `${paths.dbPath}-shm`) },
      ],
    },
  };
  for (const volume of ['config', 'state', 'data']) {
    if (!exactKeys(topology[volume], ['volumeRoot', 'directories', 'assets'])
        || !equal(topology[volume], expected[volume])) fail('INVALID_VOLUME_MARKER');
  }
  const workspace = topology.workspace;
  if (!exactKeys(workspace, ['volumeRoot', 'directories', 'assets'])
      || workspace.volumeRoot !== paths.workspace
      || !equal(workspace.directories, [path.relative(paths.workspace, path.join(paths.workspace, 'skills'))])
      || !Array.isArray(workspace.assets) || workspace.assets.length < 1) {
    fail('INVALID_VOLUME_MARKER');
  }
  const targets = new Set();
  let previous = null;
  for (const asset of workspace.assets) {
    if (!exactKeys(asset, ['id', 'target']) || typeof asset.target !== 'string'
        || path.normalize(asset.target) !== asset.target || path.isAbsolute(asset.target)) {
      fail('INVALID_VOLUME_MARKER');
    }
    const absolute = path.join(paths.workspace, asset.target);
    const directory = path.basename(asset.target);
    const parts = directory.match(
      /^rc-profile--([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)$/,
    );
    if (!isInside(paths.workspace, absolute)
        || path.dirname(asset.target) !== path.relative(paths.workspace, path.join(paths.workspace, 'skills'))
        || !parts || asset.id !== `skill-${sha256(Buffer.from(directory)).slice(0, 16)}`
        || targets.has(asset.target) || (previous !== null && previous > asset.target)) {
      fail('INVALID_VOLUME_MARKER');
    }
    targets.add(asset.target);
    previous = asset.target;
  }
}

function expectedMarkerIdentity(manifest) {
  return valueHash({
    txId: manifest.txId,
    profileId: manifest.profileId,
    digest: manifest.digest,
  });
}

function validateMarkerAgainstManifest(manifest, marker, volume) {
  const volumeMarkers = manifest.volumeMarkers;
  if (marker.volume !== volume
      || marker.profileId !== manifest.profileId
      || marker.capsuleDigest !== manifest.digest
      || marker.manifestIdentity !== expectedMarkerIdentity(manifest)
      || (volumeMarkers !== null && (!isObject(volumeMarkers)
        || Object.keys(volumeMarkers).sort().join(',') !== [...VOLUMES].sort().join(',')
        || volumeMarkers[volume] !== marker.preimageDigest))) {
    fail('INVALID_VOLUME_MARKER');
  }
}

function validateCertificateValue(certificate, txId, profileId, capsuleDigest, markers = {}) {
  const body = certificate && {
    version: certificate.version,
    txId: certificate.txId,
    profileId: certificate.profileId,
    capsuleDigest: certificate.capsuleDigest,
    volumes: certificate.volumes,
    markerDigests: certificate.markerDigests,
  };
  if (!exactKeys(certificate, [
    'version', 'txId', 'profileId', 'capsuleDigest', 'volumes', 'markerDigests', 'digest',
  ]) || certificate.version !== 1 || certificate.txId !== txId
      || certificate.profileId !== profileId || certificate.capsuleDigest !== capsuleDigest
      || !equal(certificate.volumes, VOLUMES)
      || !exactKeys(certificate.markerDigests, VOLUMES)
      || !VOLUMES.every((volume) => /^[0-9a-f]{64}$/.test(certificate.markerDigests[volume]))
      || !/^[0-9a-f]{64}$/.test(certificate.digest)
      || certificate.digest !== valueHash(body)
      || Object.entries(markers).some(
        ([volume, marker]) => certificate.markerDigests[volume] !== valueHash(marker),
      )) fail('INVALID_COMMIT_CERTIFICATE');
  return certificate;
}

function readAndValidateCertificate(paths, txId, manifest, markers, { required = false } = {}) {
  const roots = markerRoots(paths, txId);
  const certificates = {};
  for (const volume of VOLUMES) {
    const file = path.join(roots[volume], 'commit-certificate.json');
    if (!lstatIfPresent(file)) continue;
    assertSmallPrivateJson(file, 'INVALID_COMMIT_CERTIFICATE');
    certificates[volume] = readJsonObject(file, null, 'INVALID_COMMIT_CERTIFICATE');
  }
  if (!required && Object.keys(certificates).length === 0) return null;
  if (required && Object.keys(certificates).length !== VOLUMES.length) fail('INVALID_COMMIT_CERTIFICATE');
  const expected = certificates[Object.keys(certificates)[0]];
  validateCertificateValue(expected, txId, manifest.profileId, manifest.digest, markers);
  if (!Object.values(certificates).every((candidate) => equal(candidate, expected))) {
    fail('INVALID_COMMIT_CERTIFICATE');
  }
  if (manifest.state === 'committed') {
    if (!equal(manifest.commitCertificate, expected)) fail('INVALID_COMMIT_CERTIFICATE');
  } else if (manifest.commitCertificate !== null) {
    fail('INVALID_COMMIT_CERTIFICATE');
  }
  return expected;
}

function validateCommittedTransactionTopology(paths, manifest) {
  const committedCertificate = validateCertificateValue(
    manifest.commitCertificate, manifest.txId, manifest.profileId, manifest.digest,
  );
  const roots = markerRoots(paths, manifest.txId);
  const cleanupOrder = ['workspace', 'state', 'data'];
  let foundRemaining = false;
  for (const volume of cleanupOrder) {
    const present = Boolean(lstatIfPresent(roots[volume]));
    if (present) foundRemaining = true;
    else if (foundRemaining) fail('INVALID_TRANSACTION_STATE');
  }
  const markers = {};
  for (const volume of VOLUMES) {
    const root = roots[volume];
    if (!lstatIfPresent(root)) {
      if (volume === 'config') fail('INCOMPLETE_TRANSACTION_PREIMAGE');
      continue;
    }
    assertPrivateDirectory(root);
    const markerFile = path.join(root, 'volume-marker.json');
    const certificateFile = path.join(root, 'commit-certificate.json');
    if (!lstatIfPresent(markerFile) || !lstatIfPresent(certificateFile)) {
      fail('INCOMPLETE_TRANSACTION_PREIMAGE');
    }
    const marker = readJsonObject(markerFile, null, 'INVALID_VOLUME_MARKER');
    validateMarkerForRestore(paths, manifest.txId, volume, marker);
    validateMarkerAgainstManifest(manifest, marker, volume);
    if (marker.state !== 'verified') fail('INVALID_TRANSACTION_STATE');
    assertSmallPrivateJson(certificateFile, 'INVALID_COMMIT_CERTIFICATE');
    const certificate = readJsonObject(certificateFile, null, 'INVALID_COMMIT_CERTIFICATE');
    if (!equal(certificate, committedCertificate)) fail('INVALID_COMMIT_CERTIFICATE');
    markers[volume] = marker;
  }
  validateCertificateValue(
    committedCertificate, manifest.txId, manifest.profileId, manifest.digest, markers,
  );
  return { markers, certificate: committedCertificate };
}

function readBoundMarkers(paths, txId, manifest, { allowPartial = false } = {}) {
  const roots = markerRoots(paths, txId);
  const markers = {};
  for (const volume of VOLUMES) {
    const file = path.join(roots[volume], 'volume-marker.json');
    if (!lstatIfPresent(file)) {
      if (allowPartial) continue;
      fail('INCOMPLETE_TRANSACTION_PREIMAGE');
    }
    const marker = readJsonObject(file, null, 'INVALID_VOLUME_MARKER');
    validateMarkerForRestore(paths, txId, volume, marker);
    validateMarkerAgainstManifest(manifest, marker, volume);
    markers[volume] = marker;
  }
  return markers;
}

function preflightDirectoryRestores(markers) {
  for (const marker of Object.values(markers)) {
    const assetTargets = new Set(marker.assets.map(
      (asset) => path.join(marker.volumeRoot, asset.target),
    ));
    const newDirectoryTargets = new Set(marker.directories
      .filter((directory) => !directory.existed)
      .map((directory) => path.join(marker.volumeRoot, directory.target)));
    const verifyOnlyManagedContents = (target, root = false) => {
      if (assetTargets.has(target)) return;
      const metadata = lstatIfPresent(target);
      if (!metadata) return;
      if (metadata.isSymbolicLink() || !metadata.isDirectory()
          || (!root && !newDirectoryTargets.has(target))) fail('ROLLBACK_DIRECTORY_CONFLICT');
      for (const name of fs.readdirSync(target)) {
        verifyOnlyManagedContents(path.join(target, name));
      }
    };
    for (const directory of marker.directories) {
      if (directory.existed) continue;
      const target = path.join(marker.volumeRoot, directory.target);
      const metadata = lstatIfPresent(target);
      if (metadata) verifyOnlyManagedContents(target, true);
    }
  }
}

function validateTransactionStateTopology(paths, manifest) {
  const roots = markerRoots(paths, manifest.txId);
  if (manifest.state === 'staged') {
    for (const volume of ['workspace', 'state', 'data']) {
      if (lstatIfPresent(roots[volume])) fail('INVALID_TRANSACTION_STATE');
    }
    return { markers: {}, certificate: null };
  }
  if (manifest.state === 'committed') return validateCommittedTransactionTopology(paths, manifest);
  const allowPartial = manifest.state === 'preparing';
  const markers = readBoundMarkers(paths, manifest.txId, manifest, { allowPartial });
  if (manifest.state === 'preparing') {
    if (Object.values(markers).some((marker) => marker.state !== 'prepared')) {
      fail('INVALID_TRANSACTION_STATE');
    }
    return { markers, certificate: null };
  }
  const expectedMarkerState = manifest.state;
  if (Object.values(markers).some((marker) => marker.state !== expectedMarkerState)) {
    fail('INVALID_TRANSACTION_STATE');
  }
  const certificate = readAndValidateCertificate(
    paths, manifest.txId, manifest, markers,
  );
  return { markers, certificate };
}

function cleanupTransaction(paths, txId) {
  assertNoUnboundCronCleanupSources(paths);
  reconcileTransactionAtomicWrites(paths, txId);
  // Q cleanup must have removed every authenticated transient before a broad
  // transaction-root teardown. Any direct clone/scratch name left here is
  // unbound evidence and makes rollback/recovery read-only and fail closed.
  assertNoUnboundCronCleanupSources(paths);
  const roots = markerRoots(paths, txId);
  for (const volume of ['workspace', 'state', 'data']) removePath(roots[volume]);
  removePath(roots.config);
}

function satelliteTransactionIds(paths) {
  const roots = [
    path.join(paths.workspace, '.rc-bootstrap-transactions'),
    path.join(paths.stateDir, '.rc-bootstrap-transactions'),
    path.join(paths.roots.data, '.rc-bootstrap-transactions'),
  ];
  const ids = new Set();
  for (const root of roots) {
    const metadata = lstatIfPresent(root);
    if (!metadata) continue;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('UNSAFE_TRANSACTION_ROOT');
    for (const name of fs.readdirSync(root)) {
      if (/^tx-[0-9a-f-]{36}$/.test(name)) ids.add(name);
      else fail('UNKNOWN_TRANSACTION_STATE');
    }
  }
  return [...ids].sort();
}

function primaryTransactionIds(paths) {
  const root = transactionsRoot(paths);
  const metadata = lstatIfPresent(root);
  if (!metadata) return [];
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('UNSAFE_TRANSACTION_ROOT');
  const ids = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!/^tx-[0-9a-f-]{36}$/.test(name)) fail('UNKNOWN_TRANSACTION_STATE');
    const transaction = path.join(root, name);
    const entry = lstatIfPresent(transaction);
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) fail('UNSAFE_TRANSACTION_ROOT');
    ids.push(name);
  }
  return ids;
}

function restoreOrphanSatellites(paths, txId, beforeCleanup) {
  const roots = markerRoots(paths, txId);
  const volumeRoots = { workspace: paths.workspace, state: paths.stateDir, data: paths.roots.data };
  const markers = {};
  for (const volume of ['workspace', 'state', 'data']) {
    const file = path.join(roots[volume], 'volume-marker.json');
    if (!lstatIfPresent(file)) continue;
    const marker = readJsonObject(file, null, 'INVALID_VOLUME_MARKER');
    validateMarkerForRestore(paths, txId, volume, marker);
    markers[volume] = marker;
  }
  const markerList = Object.values(markers);
  const states = new Set(markerList.map((marker) => marker.state));
  if (states.size !== 1) fail('INVALID_VOLUME_MARKER');
  const state = [...states][0];
  const binding = markerList.length === 0 ? null : {
    profileId: markerList[0].profileId,
    capsuleDigest: markerList[0].capsuleDigest,
    manifestIdentity: markerList[0].manifestIdentity,
    state: markerList[0].state,
    transactionTopology: markerList[0].transactionTopology,
  };
  if (binding && !markerList.every((marker) => equal({
    profileId: marker.profileId,
    capsuleDigest: marker.capsuleDigest,
    manifestIdentity: marker.manifestIdentity,
    state: marker.state,
    transactionTopology: marker.transactionTopology,
  }, binding))) fail('INVALID_VOLUME_MARKER');
  if (state === 'prepared') {
    if (Object.keys(markers).length === 0) fail('INCOMPLETE_TRANSACTION_PREIMAGE');
    beforeCleanup({ state: 'preparing', restoredVolumes: [] });
    for (const volume of ['workspace', 'state', 'data']) removePath(roots[volume]);
    return { state: 'preparing', restoredVolumes: [] };
  }
  if (Object.keys(markers).length !== 3) fail('INCOMPLETE_TRANSACTION_PREIMAGE');
  const certificates = {};
  for (const volume of ['workspace', 'state', 'data']) {
    const file = path.join(roots[volume], 'commit-certificate.json');
    if (!lstatIfPresent(file)) continue;
    assertSmallPrivateJson(file, 'INVALID_COMMIT_CERTIFICATE');
    certificates[volume] = readJsonObject(file, null, 'INVALID_COMMIT_CERTIFICATE');
  }
  if (Object.keys(certificates).length > 0) {
    const expected = certificates[Object.keys(certificates)[0]];
    validateCertificateValue(
      expected, txId, binding.profileId, binding.capsuleDigest, markers,
    );
    if (!Object.values(certificates).every((candidate) => equal(candidate, expected))) {
      fail('INVALID_COMMIT_CERTIFICATE');
    }
  }
  if (!['applying', 'applied', 'verified'].includes(state)) fail('CONFIG_VOLUME_LOST');
  waitForCronWorkerEpochExit(paths, txId);
  const planned = { state, restoredVolumes: ['data', 'state', 'workspace'] };
  beforeCleanup(planned);
  preflightDirectoryRestores(markers);
  for (const volume of ['data', 'state', 'workspace']) {
    const marker = markers[volume];
    for (const asset of [...marker.assets].reverse()) {
      restorePath(
        path.join(volumeRoots[volume], asset.target),
        path.join(roots[volume], asset.snapshot),
        asset.digest,
      );
    }
    for (const directory of [...marker.directories].reverse()) {
      const target = path.join(volumeRoots[volume], directory.target);
      if (!directory.existed && lstatIfPresent(target)?.isDirectory()
          && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    }
  }
  for (const volume of ['workspace', 'state', 'data']) removePath(roots[volume]);
  return planned;
}

async function rollbackProfile(options) {
  const paths = normalizePaths(options);
  recoverCronWorkerLifecycleAuthority(paths, options.txId);
  reconcileCronCleanupQuarantineAtEntry(paths);
  const manifest = readManifest(paths, options.txId);
  reconcileTransactionAtomicWrites(paths, options.txId);
  if (manifest.state === 'committed') {
    const authorities = readCommittedCleanupIntents(paths);
    if (authorities.length > 1
        || (authorities.length === 1 && authorities[0].txId !== options.txId)) {
      fail('MULTIPLE_PENDING_TRANSACTIONS');
    }
    let intent = authorities[0];
    if (!intent) {
      // No transaction material may be deleted until the committed manifest
      // and every root have authenticated the tx-local prepared authority.
      validateTransactionStateTopology(paths, manifest);
      const prepared = preparedCommittedCleanupIntentPath(paths, options.txId);
      if (!lstatIfPresent(prepared)) fail('INVALID_COMMITTED_CLEANUP_INTENT');
      assertSmallPrivateJson(prepared, 'INVALID_COMMITTED_CLEANUP_INTENT');
      intent = readPrivateJsonObject(prepared, null, 'INVALID_COMMITTED_CLEANUP_INTENT');
      validateCleanupIntent(paths, intent);
      publishCommittedCleanupIntent(paths, intent);
    }
    finishCommittedCleanup(paths, intent, options.fault);
    return { txId: options.txId, state: 'committed' };
  }
  const topology = validateTransactionStateTopology(paths, manifest);
  if (manifest.state === 'staged') {
    cleanupTransaction(paths, options.txId);
    return { txId: options.txId, state: 'rolled-back' };
  }
  if (manifest.state === 'preparing') {
    // The state contract forbids live mutation until all preimages exist and
    // manifest state advances to applying, so partial marker trees are debris.
    cleanupTransaction(paths, options.txId);
    return { txId: options.txId, state: 'rolled-back' };
  }
  if (!['applying', 'applied', 'verified'].includes(manifest.state)) {
    fail('UNKNOWN_TRANSACTION_STATE');
  }
  // This EXCLUSIVE epoch lease is the durable proof that the exact worker for
  // this transaction has released its live CAS. It never signals a bare PID.
  waitForCronWorkerEpochExit(paths, options.txId);
  const roots = markerRoots(paths, options.txId);
  const markers = topology.markers;
  preflightDirectoryRestores(markers);
  for (const volume of ['data', 'state', 'workspace', 'config']) {
    const marker = markers[volume];
    const volumeRoot = marker.volumeRoot;
    for (const asset of [...marker.assets].reverse()) {
      restorePath(
        path.join(volumeRoot, asset.target),
        path.join(roots[volume], asset.snapshot),
        asset.digest,
      );
    }
    for (const directory of [...marker.directories].reverse()) {
      const target = path.join(volumeRoot, directory.target);
      if (!directory.existed) {
        const metadata = lstatIfPresent(target);
        if (metadata) {
          if (metadata.isSymbolicLink() || !metadata.isDirectory() || fs.readdirSync(target).length > 0) {
            fail('ROLLBACK_DIRECTORY_CONFLICT');
          }
          fs.rmdirSync(target);
          fsyncDirectory(path.dirname(target));
        }
      } else if (directory.mode !== null && process.platform !== 'win32') {
        fs.chmodSync(target, directory.mode);
      }
    }
  }
  cleanupTransaction(paths, options.txId);
  return { txId: options.txId, state: 'rolled-back' };
}

async function recoverProfiles(options) {
  const paths = normalizePaths(options, { recovery: true });
  // Unpublished stage directories are intentionally not transaction roots and
  // cannot carry cron lifecycle or Q authority. Authenticate the full parent
  // namespace first, then remove only the validated unpublished set before
  // enumerating published tx-* roots.
  reconcileUnpublishedStages(paths);
  for (const txId of [...new Set([
    ...primaryTransactionIds(paths), ...satelliteTransactionIds(paths),
  ])].sort()) {
    recoverCronWorkerLifecycleAuthority(paths, txId);
  }
  reconcileCronCleanupQuarantineAtEntry(paths);
  const recovered = [];
  const incidents = [];
  const cleanupIntents = readCommittedCleanupIntents(paths);
  const cleanupIds = new Set(cleanupIntents.map((intent) => intent.txId));
  const primary = new Set(primaryTransactionIds(paths));
  for (const txId of primary) {
    if (cleanupIds.has(txId)) continue;
    const manifest = readManifest(paths, txId);
    if (!['staged', 'preparing', 'applying', 'applied', 'verified', 'committed'].includes(manifest.state)) {
      fail('UNKNOWN_TRANSACTION_STATE');
    }
    await rollbackProfile({ ...paths, ...options, txId });
    recovered.push(txId);
  }
  for (const intent of cleanupIntents) {
    finishCommittedCleanup(paths, intent, options.fault);
    recovered.push(intent.txId);
  }
  for (const txId of satelliteTransactionIds(paths)) {
    if (primary.has(txId) || cleanupIds.has(txId)) continue;
    reconcileTransactionAtomicWrites(paths, txId);
    let incident;
    const result = restoreOrphanSatellites(paths, txId, (planned) => {
      incident = recoveryIncident(paths, txId, planned.state, planned.restoredVolumes);
      writeRecoveryIncident(paths, incident);
    });
    incident ??= recoveryIncident(paths, txId, result.state, result.restoredVolumes);
    incidents.push(incident);
  }
  if (incidents.length > 0) fail('CONFIG_VOLUME_LOST');
  return { recovered: [...new Set(recovered)].sort() };
}

async function profileStatus(options) {
  const paths = normalizePaths(options);
  assertCronCleanupQuarantinePreflight(paths);
  assertNoUnboundCronCleanupSources(paths);
  const receipt = readReceipt(paths);
  const root = transactionsRoot(paths);
  let pendingTransaction = null;
  let commitCertificate = null;
  const cleanupIntents = readCommittedCleanupIntents(paths);
  if (cleanupIntents.length > 1) fail('MULTIPLE_PENDING_TRANSACTIONS');
  if (lstatIfPresent(root)) {
    const transactions = fs.readdirSync(root).sort();
    if (transactions.length > 1) fail('MULTIPLE_PENDING_TRANSACTIONS');
    if (transactions.length === 1) {
      const manifest = readManifest(paths, transactions[0]);
      pendingTransaction = publicTransaction(manifest);
      commitCertificate = manifest.commitCertificate ?? null;
    }
  }
  if (cleanupIntents.length === 1) {
    if (pendingTransaction && pendingTransaction.txId !== cleanupIntents[0].txId) {
      fail('MULTIPLE_PENDING_TRANSACTIONS');
    }
    pendingTransaction = {
      txId: cleanupIntents[0].txId,
      state: 'committed',
      profileId: cleanupIntents[0].profileId,
      revision: pendingTransaction?.revision ?? null,
      digest: cleanupIntents[0].capsuleDigest,
    };
    commitCertificate = cleanupIntents[0].commitCertificate;
  }
  return {
    profile: receipt?.profile ? clone(receipt.profile) : null,
    peripheralOverride: receipt?.peripheralOverride ? clone(receipt.peripheralOverride) : null,
    pendingTransaction,
    commitCertificate,
  };
}

function createRestoreTransaction(paths, receipt) {
  assertNoRecoveryIncidents(paths);
  assertNoPendingTransactions(paths);
  ensureDirectory(bootstrapRoot(paths), 0o700);
  ensureDirectory(transactionsRoot(paths), 0o700);
  const txId = `tx-${crypto.randomUUID()}`;
  const root = txRoot(paths, txId);
  fs.mkdirSync(root, { mode: 0o700 });
  fsyncDirectory(transactionsRoot(paths));
  const intent = {
    operation: 'peripheral-restore',
    profileId: receipt?.profile?.id ?? 'operator',
    profileDigest: receipt?.profile?.digest ?? null,
    value: 'enabled',
  };
  const manifest = {
    version: 1,
    txId,
    state: 'staged',
    operation: 'peripheral-restore',
    profileId: intent.profileId,
    revision: receipt?.profile?.revision ?? 0,
    digest: valueHash(intent),
    pathsHash: pathsHash(paths),
    lastCompletedStep: null,
    volumeMarkers: null,
    commitCertificate: null,
  };
  writeJsonAtomic(manifestPath(paths, txId), manifest, 0o600);
  return manifest;
}

async function restorePeripherals(options) {
  const paths = normalizePaths(options);
  reconcileCronCleanupQuarantineAtEntry(paths);
  const ledger = readLedger(paths);
  if (Object.keys(ledger.entries).length === 0 && Object.keys(ledger.mcp).length === 0) {
    return { restored: false };
  }
  const config = readJsonObject(paths.configPath, null, 'INVALID_CONFIG');
  const nextConfig = clone(config);
  if (ledger.mcp.plaud) {
    const plaud = nextConfig.mcp?.servers?.plaud;
    if (!isObject(plaud) || plaud.enabled !== false) fail('SUSPENSION_CONFLICT');
    if (ledger.mcp.plaud.baseline.enabledPresent) {
      plaud.enabled = ledger.mcp.plaud.baseline.enabledValue;
    } else delete plaud.enabled;
  }
  const receipt = readReceipt(paths);
  if (!receipt || !isObject(receipt.profile)) fail('INVALID_RECEIPT');
  const managed = new Set(Array.isArray(receipt?.managedDeny) ? receipt.managedDeny : []);
  if (Array.isArray(nextConfig.tools?.deny)) {
    nextConfig.tools.deny = nextConfig.tools.deny.filter((item) => !managed.has(item));
  }
  const plugins = ensureObjectAt(nextConfig, 'plugins');
  const entries = ensureObjectAt(plugins, 'entries');
  const core = ensureObjectAt(entries, 'research-claw-core');
  const coreConfig = ensureObjectAt(core, 'config');
  const productPolicy = ensureObjectAt(coreConfig, 'productPolicy');
  const capabilities = ensureObjectAt(productPolicy, 'capabilities');
  capabilities.peripherals = 'enabled';

  const nextReceipt = clone(receipt);
  nextReceipt.managedDeny = [];
  nextReceipt.peripheralSuspensions = { monitors: [], mcp: [] };
  nextReceipt.peripheralOverride = { source: 'explicit-restore', value: 'enabled' };

  const manifest = createRestoreTransaction(paths, receipt);
  const syntheticCapsule = {
    profile: { id: manifest.profileId },
    skills: { items: [] },
  };
  try {
    updateManifest(paths, manifest.txId, { state: 'preparing', volumeMarkers: null });
    const markers = createVolumeMarkers(
      paths, manifest.txId, receipt, syntheticCapsule, manifest, options.fault,
    );
    updateManifest(paths, manifest.txId, {
      volumeMarkers: Object.fromEntries(VOLUMES.map(
        (volume) => [volume, markers[volume].preimageDigest],
      )),
    });
    const inspected = await inspectCronState(paths, manifest.txId);
    const rows = await inspectMonitorRows(paths, manifest.txId);
    const peripheral = buildPeripheralPlan(rows, inspected.output.jobs, 'enabled', '', ledger);
    if (peripheral.ledger.mcp.plaud) delete peripheral.ledger.mcp.plaud;

    updateManifest(paths, manifest.txId, { state: 'applying', lastCompletedStep: null });
    updateMarkerStates(paths, manifest.txId, 'applying');
    writeLiveConfigAtomic(paths, manifest.txId, 'project', nextConfig);
    afterStep(paths, manifest.txId, 'config', options.fault);
    writeMonitorRows(paths, rows, peripheral.rows);
    afterStep(paths, manifest.txId, 'monitor', options.fault);
    if (!equal(inspected.output.jobs, peripheral.jobs)) {
      await runCronWorker(paths, 'compare-and-replace', paths.stateDir, {
        expectedDigest: jobsDigest(inspected.output.jobs), jobs: peripheral.jobs,
      }, 'live', { txId: manifest.txId });
    }
    afterStep(paths, manifest.txId, 'cron', options.fault);
    writeJsonAtomic(suspensionsPath(paths), peripheral.ledger, 0o600);
    afterStep(paths, manifest.txId, 'suspensions', options.fault);
    writeJsonAtomic(receiptPath(paths), nextReceipt, 0o600);
    afterStep(paths, manifest.txId, 'receipt', options.fault);
    updateManifest(paths, manifest.txId, { state: 'applied', lastCompletedStep: 'receipt' });
    updateMarkerStates(paths, manifest.txId, 'applied');

    if (!equal(readJsonObject(paths.configPath, null, 'INVALID_CONFIG'), nextConfig)
        || !equal(readMonitorRows(paths), peripheral.rows)
        || !equal(readLedger(paths), peripheral.ledger)
        || !equal(readReceipt(paths), nextReceipt)) fail('VERIFY_FAILED');
    const live = await inspectCronState(paths, manifest.txId);
    if (!equal(live.output.jobs, peripheral.jobs)) fail('VERIFY_FAILED');
    updateManifest(paths, manifest.txId, { state: 'verified' });
    updateMarkerStates(paths, manifest.txId, 'verified');
    const committed = await commitProfile({ ...paths, txId: manifest.txId, fault: options.fault });
    return { restored: true, state: committed.state, peripheralOverride: nextReceipt.peripheralOverride };
  } catch (error) {
    try {
      const pending = lstatIfPresent(txRoot(paths, manifest.txId));
      if (pending) await rollbackProfile({ ...paths, ...options, txId: manifest.txId });
    } catch {
      fail('ROLLBACK_FAILED');
    }
    throw error;
  }
}

function withApplierLocks(options, operation, runtime, callback, lockOptions = {}) {
  return withBootstrapLocks({
    rcRoot: options.rcRoot,
    configPath: options.configPath,
    operation,
    runtime,
    initialize: false,
    allowConfigAbsent: lockOptions.allowConfigAbsent ?? false,
  }, (locks) => {
    locks.assertHeld();
    return callback(locks);
  });
}

const publicApi = {
  stageProfile: (options) => withApplierLocks(
    options, 'exclusive', null, () => stageProfile(options),
  ),
  applyProfile: (options) => withApplierLocks(
    options, 'exclusive', 'exclusive', () => applyProfile(options),
  ),
  verifyProfile: (options) => withApplierLocks(
    options, 'exclusive', 'shared', () => verifyProfile(options),
  ),
  commitProfile: (options) => withApplierLocks(
    options, 'exclusive', 'shared', () => commitProfile(options),
  ),
  rollbackProfile: (options) => withApplierLocks(
    options, 'exclusive', 'exclusive', () => rollbackProfile(options),
    { allowConfigAbsent: true },
  ),
  recoverProfiles: (options) => withApplierLocks(
    options, 'exclusive', 'exclusive', () => recoverProfiles(options),
    { allowConfigAbsent: true },
  ),
  profileStatus: (options) => withApplierLocks(
    options, 'shared', null, () => profileStatus(options),
  ),
  restorePeripherals: (options) => withApplierLocks(
    options, 'exclusive', 'exclusive', () => restorePeripherals(options),
  ),
};

module.exports = {
  BootstrapProfileTransactionError,
  ...publicApi,
  __testing: process.env.NODE_ENV === 'test' ? {
    inspectCronState: (options, txId, controls) => inspectCronState(
      normalizePaths(options), txId, controls,
    ),
    runCronScratchProbe: (options, txId, controls) => {
      const paths = normalizePaths(options);
      return runCronWorker(paths, 'inspect', paths.stateDir, {}, 'clone', {
        ...controls,
        txId,
      });
    },
    cronWorkerScratchCandidate: (options, txId, epoch) => cronWorkerScratchPath(
      normalizePaths(options), txId, epoch,
    ),
    createCronWorkerScratchProbe: (options, txId, epoch) => {
      const scratch = createCronWorkerScratch(normalizePaths(options), txId, epoch);
      cleanupCronWorkerScratch(scratch);
      return { home: scratch.home, tmp: scratch.tmp };
    },
    openCronWorkerLifecycleProbe: (options, txId) => {
      const lifecycle = openCronWorkerLifecycle(normalizePaths(options), txId);
      lifecycle.database.close();
      return lifecycle.file;
    },
    runCronScratchCleanupProbe: (options, txId, epoch, onPhase) => {
      if (typeof onPhase !== 'function') fail('CRON_WORKER_FAILED');
      const scratch = createCronWorkerScratch(normalizePaths(options), txId, epoch);
      onPhase('created', {
        home: scratch.home,
        tmp: scratch.tmp,
        homeIdentity: clone(scratch.homeIdentity),
        tmpIdentity: clone(scratch.tmpIdentity),
      });
      cleanupCronWorkerScratch(scratch, { onPhase });
      return { home: scratch.home, tmp: scratch.tmp };
    },
    activeCronWorkerPids: () => [...activeCronWorkers].map((record) => record.child.pid),
    cronWorkerTimeoutMs,
  } : undefined,
};
