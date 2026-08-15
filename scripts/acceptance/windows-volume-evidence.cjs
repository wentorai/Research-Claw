'use strict';

// Read-only evidence helper for the Windows Docker Desktop T10 gate. It emits
// hashes and metadata only: file contents (including API keys) never leave the
// helper process. Keep these paths in lockstep with install-docker.ps1 and the
// Bootstrap Profile CLI ABI.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOTS = Object.freeze({
  config: '/app/config',
  data: '/app/.research-claw',
  workspace: '/app/workspace',
  state: '/root/.openclaw',
});
const USER_MARKERS = Object.freeze(Object.fromEntries(
  Object.entries(ROOTS).map(([name, root]) => [name, path.join(root, '.rc-t10-user-owned-marker.json')]),
));
const CRITICAL_RUNTIME_PATHS = Object.freeze([
  '/entrypoint.sh',
  '/app/scripts/docker-entrypoint.sh',
  '/app/scripts/apply-bootstrap-profile.cjs',
  '/app/scripts/sync-global-config.cjs',
  '/app/scripts/version-info.cjs',
  '/app/scripts/bootstrap-profile/applier.cjs',
  '/app/scripts/bootstrap-profile/cli.cjs',
  '/app/scripts/bootstrap-profile/cron-digest.cjs',
  '/app/scripts/bootstrap-profile/cron-worker.mjs',
  '/app/scripts/bootstrap-profile/entrypoint-admission.cjs',
  '/app/scripts/bootstrap-profile/maintenance-lease.cjs',
  '/app/scripts/bootstrap-profile/model-probe.cjs',
  '/app/scripts/bootstrap-profile/schema.cjs',
  '/app/scripts/bootstrap-profile/secret-copy-scan.cjs',
  '/app/scripts/bootstrap-profile/storage.cjs',
  '/app/scripts/bootstrap-profile/unicode-15.0-assigned-ranges.json',
  '/app/package.json',
  '/app/pnpm-lock.yaml',
]);
const MAX_ENTRIES = 100_000;
const MAX_HASHED_BYTES = 16 * 1024 * 1024 * 1024;
let entryCount = 0;
let hashedBytes = 0;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function lstat(target) {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('EVIDENCE_LSTAT_FAILED');
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.nlink === right.nlink;
}

function fileSha256(target, initial) {
  if (typeof fs.constants.O_NOFOLLOW !== 'number') fail('EVIDENCE_NOFOLLOW_UNAVAILABLE');
  if (initial.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('EVIDENCE_FILE_TOO_LARGE');
  hashedBytes += Number(initial.size);
  if (hashedBytes > MAX_HASHED_BYTES) fail('EVIDENCE_BYTE_BUDGET_EXCEEDED');
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(initial, opened)) fail('EVIDENCE_FILE_RACE');
    let read;
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after)) fail('EVIDENCE_FILE_RACE');
  } finally {
    fs.closeSync(descriptor);
  }
  const pathAfter = lstat(target);
  if (!pathAfter || !sameFileIdentity(initial, pathAfter)) fail('EVIDENCE_FILE_RACE');
  return hash.digest('hex');
}

function metadata(stat) {
  return {
    mode: Number(stat.mode & 0o7777n),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function treeEntries(target) {
  const entries = [];
  function visit(current, relative) {
    entryCount += 1;
    if (entryCount > MAX_ENTRIES) fail('EVIDENCE_ENTRY_BUDGET_EXCEEDED');
    const stat = lstat(current);
    if (!stat) {
      entries.push({ relative, type: 'absent' });
      return;
    }
    const common = { relative, ...metadata(stat) };
    if (stat.isFile()) {
      entries.push({
        ...common,
        type: 'file',
        size: stat.size.toString(),
        sha256: fileSha256(current, stat),
      });
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push({ ...common, type: 'symlink', targetSha256: sha256(fs.readlinkSync(current)) });
      return;
    }
    if (!stat.isDirectory()) fail('EVIDENCE_UNSUPPORTED_FILE_TYPE');
    entries.push({ ...common, type: 'directory' });
    const names = fs.readdirSync(current).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const name of names) {
      visit(path.join(current, name), relative === '.' ? name : `${relative}/${name}`);
    }
  }
  visit(target, '.');
  return entries;
}

function contentProjection(entries) {
  return entries.map((entry) => {
    const projected = { ...entry };
    delete projected.mtimeNs;
    return projected;
  });
}

function pathEvidence(target) {
  const entries = treeEntries(target);
  return {
    contentSha256: sha256(stableJson(contentProjection(entries))),
    observationSha256: sha256(stableJson(entries)),
    entries,
  };
}

function readReceipt() {
  const target = path.join(ROOTS.config, '.rc-bootstrap', 'receipt.json');
  const initial = lstat(target);
  if (!initial) return { profile: null, skillDirectories: [] };
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > 1024n * 1024n) {
    fail('EVIDENCE_INVALID_RECEIPT');
  }
  if (typeof fs.constants.O_NOFOLLOW !== 'number') fail('EVIDENCE_NOFOLLOW_UNAVAILABLE');
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const bytes = Buffer.alloc(Number(initial.size));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(initial, opened)) fail('EVIDENCE_RECEIPT_RACE');
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail('EVIDENCE_RECEIPT_RACE');
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after)) fail('EVIDENCE_RECEIPT_RACE');
  } finally {
    fs.closeSync(descriptor);
  }
  const pathAfter = lstat(target);
  if (!pathAfter || !sameFileIdentity(initial, pathAfter)) fail('EVIDENCE_RECEIPT_RACE');
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('EVIDENCE_INVALID_RECEIPT');
  }
  const profile = receipt?.profile;
  if (!profile || typeof profile.id !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id)
      || !Number.isSafeInteger(profile.revision) || profile.revision < 1
      || typeof profile.digest !== 'string' || !/^[0-9a-f]{64}$/.test(profile.digest)
      || !Array.isArray(receipt.skills)) fail('EVIDENCE_INVALID_RECEIPT');
  const directories = receipt.skills.map((skill) => skill?.directory);
  if (directories.some((directory) => typeof directory !== 'string'
      || directory !== `rc-profile--${profile.id}--${directory.split('--').at(-1)}`
      || !/^rc-profile--[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*$/.test(directory))
      || new Set(directories).size !== directories.length) fail('EVIDENCE_INVALID_RECEIPT');
  return {
    profile: { id: profile.id, revision: profile.revision, digest: profile.digest },
    skillDirectories: directories.sort(),
  };
}

function immediateNamespace(target) {
  const stat = lstat(target);
  if (!stat) return { state: 'absent', entries: [] };
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('EVIDENCE_INVALID_MARKER_NAMESPACE');
  const entries = fs.readdirSync(target)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    .map((name) => {
      const child = lstat(path.join(target, name));
      if (!child) fail('EVIDENCE_MARKER_RACE');
      return {
        name,
        type: child.isDirectory() ? 'directory'
          : child.isFile() ? 'file'
            : child.isSymbolicLink() ? 'symlink' : 'other',
        mode: Number(child.mode & 0o7777n),
      };
    });
  return { state: 'present', entries };
}

function managedSkillDirectories(receiptDirectories) {
  const skillsRoot = path.join(ROOTS.workspace, 'skills');
  const stat = lstat(skillsRoot);
  if (!stat) return [...receiptDirectories];
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('EVIDENCE_INVALID_SKILLS_ROOT');
  const reserved = fs.readdirSync(skillsRoot)
    .filter((name) => name.startsWith('rc-profile--'));
  return [...new Set([...receiptDirectories, ...reserved])]
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function criticalRuntimeEvidence(extraPath) {
  const paths = extraPath ? [...CRITICAL_RUNTIME_PATHS, extraPath] : [...CRITICAL_RUNTIME_PATHS];
  return paths.map((target) => {
    entryCount += 1;
    if (entryCount > MAX_ENTRIES) fail('EVIDENCE_ENTRY_BUDGET_EXCEEDED');
    const stat = lstat(target);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail('EVIDENCE_RUNTIME_NOT_REGULAR');
    return {
      path: target,
      size: stat.size.toString(),
      mode: Number(stat.mode & 0o7777n),
      sha256: fileSha256(target, stat),
    };
  });
}

function seedUserMarkers(runId) {
  const seeded = [];
  for (const [volume, target] of Object.entries(USER_MARKERS)) {
    const root = ROOTS[volume];
    const rootStat = lstat(root);
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      fail('EVIDENCE_INVALID_VOLUME_ROOT');
    }
    const bytes = Buffer.from(`${stableJson({
      schemaVersion: 1,
      owner: 'windows-bootstrap-docker',
      runId,
      volume,
    })}\n`, 'utf8');
    const descriptor = fs.openSync(target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset,
        bytes.length - offset, offset);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
      bytes.fill(0);
    }
    fs.chmodSync(target, 0o600);
    const rootDescriptor = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(rootDescriptor); } finally { fs.closeSync(rootDescriptor); }
    const stat = lstat(target);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()
        || Number(stat.mode & 0o7777n) !== 0o600) fail('EVIDENCE_USER_MARKER_SEED_FAILED');
    seeded.push({ volume, pathSha256: sha256(`${volume}\0.rc-t10-user-owned-marker.json`) });
  }
  process.stdout.write(`${stableJson({ schemaVersion: 1, seeded })}\n`);
}

function volumeEvidence() {
  for (const root of Object.values(ROOTS)) {
    const stat = lstat(root);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail('EVIDENCE_INVALID_VOLUME_ROOT');
  }
  const receipt = readReceipt();
  const skillDirectories = managedSkillDirectories(receipt.skillDirectories);
  const assets = {
    config: {
      projectConfig: pathEvidence(path.join(ROOTS.config, 'openclaw.json')),
      receipt: pathEvidence(path.join(ROOTS.config, '.rc-bootstrap', 'receipt.json')),
      suspensions: pathEvidence(path.join(ROOTS.config, '.rc-bootstrap', 'peripheral-suspensions.json')),
    },
    workspace: Object.fromEntries(skillDirectories.map((directory) => [
      directory,
      pathEvidence(path.join(ROOTS.workspace, 'skills', directory)),
    ])),
    state: {
      auth: pathEvidence(path.join(ROOTS.state, 'agents', 'main', 'agent', 'auth-profiles.json')),
      globalConfig: pathEvidence(path.join(ROOTS.state, 'openclaw.json')),
      cronDb: pathEvidence(path.join(ROOTS.state, 'state', 'openclaw.sqlite')),
      cronWal: pathEvidence(path.join(ROOTS.state, 'state', 'openclaw.sqlite-wal')),
      cronShm: pathEvidence(path.join(ROOTS.state, 'state', 'openclaw.sqlite-shm')),
    },
    data: {
      rcDb: pathEvidence(path.join(ROOTS.data, 'library.db')),
      rcWal: pathEvidence(path.join(ROOTS.data, 'library.db-wal')),
      rcShm: pathEvidence(path.join(ROOTS.data, 'library.db-shm')),
    },
  };
  const markers = {
    configTransactions: immediateNamespace(path.join(ROOTS.config, '.rc-bootstrap', 'transactions')),
    configCommittedCleanup: immediateNamespace(path.join(ROOTS.config, '.rc-bootstrap', 'committed-cleanup')),
    configCommittedCleanupTombstones: immediateNamespace(path.join(ROOTS.config, '.rc-bootstrap', 'committed-cleanup-tombstones')),
    configRecoveryIncidents: immediateNamespace(path.join(ROOTS.config, '.rc-bootstrap', 'recovery-incidents')),
    workspaceTransactions: immediateNamespace(path.join(ROOTS.workspace, '.rc-bootstrap-transactions')),
    workspaceCommittedCleanup: immediateNamespace(path.join(ROOTS.workspace, '.rc-bootstrap-committed-cleanup')),
    workspaceRecoveryIncidents: immediateNamespace(path.join(ROOTS.workspace, '.rc-bootstrap-recovery-incidents')),
    stateTransactions: immediateNamespace(path.join(ROOTS.state, '.rc-bootstrap-transactions')),
    stateCommittedCleanup: immediateNamespace(path.join(ROOTS.state, '.rc-bootstrap-committed-cleanup')),
    stateRecoveryIncidents: immediateNamespace(path.join(ROOTS.state, '.rc-bootstrap-recovery-incidents')),
    dataTransactions: immediateNamespace(path.join(ROOTS.data, '.rc-bootstrap-transactions')),
    dataCommittedCleanup: immediateNamespace(path.join(ROOTS.data, '.rc-bootstrap-committed-cleanup')),
    dataRecoveryIncidents: immediateNamespace(path.join(ROOTS.data, '.rc-bootstrap-recovery-incidents')),
  };
  const userOwnedMarkers = Object.fromEntries(Object.entries(USER_MARKERS).map(([name, target]) => [
    name,
    pathEvidence(target),
  ]));
  const userMarkerContent = structuredClone(userOwnedMarkers);
  const userMarkerObservation = structuredClone(userOwnedMarkers);
  for (const evidence of Object.values(userMarkerContent)) {
    delete evidence.entries;
    delete evidence.observationSha256;
  }
  for (const evidence of Object.values(userMarkerObservation)) {
    delete evidence.entries;
    delete evidence.contentSha256;
  }
  const userOwnedMarkerCount = Object.values(userOwnedMarkers)
    .filter((evidence) => evidence.entries.length === 1 && evidence.entries[0].type === 'file').length;
  const contentAssets = structuredClone(assets);
  const observationAssets = structuredClone(assets);
  for (const group of Object.values(contentAssets)) {
    for (const evidence of Object.values(group)) {
      delete evidence.entries;
      delete evidence.observationSha256;
    }
  }
  for (const group of Object.values(observationAssets)) {
    for (const evidence of Object.values(group)) {
      delete evidence.entries;
      delete evidence.contentSha256;
    }
  }
  const markerEntries = Object.values(markers).flatMap((namespace) => namespace.entries);
  const result = {
    schemaVersion: 1,
    profile: receipt.profile,
    declaredWriteSet: assets,
    declaredWriteSetSha256: sha256(stableJson(contentAssets)),
    declaredWriteSetObservationSha256: sha256(stableJson(observationAssets)),
    transactionMarkers: markers,
    transactionMarkersSha256: sha256(stableJson(markers)),
    activeTransactionMarkerCount: markerEntries.length,
    userOwnedMarkers,
    userOwnedMarkersSha256: sha256(stableJson(userMarkerContent)),
    userOwnedMarkersObservationSha256: sha256(stableJson(userMarkerObservation)),
    userOwnedMarkerCount,
    budgets: { entryCount, hashedBytes },
  };
  process.stdout.write(`${stableJson(result)}\n`);
}

function main() {
  if (process.argv.length === 2) {
    volumeEvidence();
    return;
  }
  if (process.argv.length === 4 && process.argv[2] === 'seed-user-markers'
      && process.argv[3].match(/^[0-9a-f]{32}$/)) {
    seedUserMarkers(process.argv[3]);
    return;
  }
  if (process.argv[2] === 'image-runtime'
      && (process.argv.length === 3 || (process.argv.length === 5
        && process.argv[3] === '--extra-path'
        && /^\/[A-Za-z0-9._/-]+$/.test(process.argv[4])
        && !process.argv[4].split('/').includes('..')))) {
    const extraPath = process.argv.length === 5 ? process.argv[4] : null;
    process.stdout.write(`${stableJson(criticalRuntimeEvidence(extraPath))}\n`);
    return;
  }
  fail('EVIDENCE_INVALID_ARGUMENTS');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.code ?? 'EVIDENCE_FAILED'}\n`);
  process.exitCode = 1;
}
