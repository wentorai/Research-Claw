'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_INPUT_BYTES = 262144;
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SECRET_LIKE = /rca_[A-Za-z0-9_-]{43,}/;
const CRITICAL_RUNTIME_SOURCES = Object.freeze([
  ['/entrypoint.sh', 'scripts/docker-entrypoint.sh', 0o755],
  ['/app/scripts/docker-entrypoint.sh', 'scripts/docker-entrypoint.sh', 0o644],
  ['/app/scripts/apply-bootstrap-profile.cjs', 'scripts/apply-bootstrap-profile.cjs', 0o644],
  ['/app/scripts/sync-global-config.cjs', 'scripts/sync-global-config.cjs', 0o644],
  ['/app/scripts/version-info.cjs', 'scripts/version-info.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/applier.cjs', 'scripts/bootstrap-profile/applier.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/cli.cjs', 'scripts/bootstrap-profile/cli.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/cron-digest.cjs', 'scripts/bootstrap-profile/cron-digest.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/cron-worker.mjs', 'scripts/bootstrap-profile/cron-worker.mjs', 0o644],
  ['/app/scripts/bootstrap-profile/entrypoint-admission.cjs', 'scripts/bootstrap-profile/entrypoint-admission.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/maintenance-lease.cjs', 'scripts/bootstrap-profile/maintenance-lease.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/model-probe.cjs', 'scripts/bootstrap-profile/model-probe.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/schema.cjs', 'scripts/bootstrap-profile/schema.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/secret-copy-scan.cjs', 'scripts/bootstrap-profile/secret-copy-scan.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/storage.cjs', 'scripts/bootstrap-profile/storage.cjs', 0o644],
  ['/app/scripts/bootstrap-profile/unicode-15.0-assigned-ranges.json', 'scripts/bootstrap-profile/unicode-15.0-assigned-ranges.json', 0o644],
  ['/app/package.json', 'package.json', 0o644],
  ['/app/pnpm-lock.yaml', 'pnpm-lock.yaml', 0o644],
]);

function fail(code) {
  const error = new Error(code);
  error.finalizerCode = code;
  throw error;
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink;
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readFileSnapshot(file, missingCode, unsafeCode, maxBytes = MAX_INPUT_BYTES) {
  let initial;
  try {
    initial = fs.lstatSync(file, { bigint: true });
  } catch {
    fail(missingCode);
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 1n ||
      initial.size > BigInt(maxBytes) || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(unsafeCode);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  let bytes;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFile(initial, opened)) fail(unsafeCode);
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail(unsafeCode);
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFile(opened, after)) fail(unsafeCode);
  } catch {
    fail(unsafeCode);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let pathAfter;
  try {
    pathAfter = fs.lstatSync(file, { bigint: true });
  } catch {
    fail(unsafeCode);
  }
  if (!sameFile(initial, pathAfter)) fail(unsafeCode);
  return bytes;
}

function readStrictJson(file) {
  const bytes = readFileSnapshot(
    file,
    'INVALID_MANIFEST_DRAFT',
    'INVALID_MANIFEST_DRAFT',
  );
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('INVALID_MANIFEST_DRAFT');
  }
  try {
    return JSON.parse(text);
  } catch {
    fail('INVALID_MANIFEST_DRAFT');
  }
}

function sha256File(file) {
  const bytes = readFileSnapshot(
    file,
    'LOCAL_SOURCE_MISSING',
    'LOCAL_SOURCE_NOT_REGULAR',
    Number.MAX_SAFE_INTEGER,
  );
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function requireString(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
}

function setLocalSha(slot, sha) {
  if (typeof slot.sha256 !== 'string' ||
      (slot.sha256 !== 'REPLACE_WITH_64_LOWERCASE_HEX' && slot.sha256 !== sha)) {
    fail('LOCAL_SOURCE_SHA_MISMATCH');
  }
  slot.sha256 = sha;
}

function hasUnresolvedPlaceholder(value) {
  if (typeof value === 'string') {
    return value.includes('REPLACE_') || value.includes('replace-with') ||
      value.includes('.invalid') || value === '2099-01-01T00:00:00Z';
  }
  if (Array.isArray(value)) return value.some(hasUnresolvedPlaceholder);
  if (value && typeof value === 'object') {
    return Object.values(value).some(hasUnresolvedPlaceholder);
  }
  return false;
}

function hasSecretLikeValue(value) {
  if (typeof value === 'string') return SECRET_LIKE.test(value);
  if (Array.isArray(value)) return value.some(hasSecretLikeValue);
  if (value && typeof value === 'object') return Object.values(value).some(hasSecretLikeValue);
  return false;
}

function criticalRuntimeSha256(root) {
  const evidence = CRITICAL_RUNTIME_SOURCES.map(([runtimePath, sourcePath, mode]) => {
    const bytes = readFileSnapshot(
      path.join(root, sourcePath),
      'LOCAL_SOURCE_MISSING',
      'LOCAL_SOURCE_NOT_REGULAR',
      Number.MAX_SAFE_INTEGER,
    );
    return {
      mode,
      path: runtimePath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: String(bytes.length),
    };
  });
  return crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function writeExclusiveUtf8(target, text) {
  const requested = path.resolve(target);
  let parent;
  try {
    parent = fs.realpathSync.native(path.dirname(requested));
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('INVALID_OUTPUT_PARENT');
  } catch {
    fail('INVALID_OUTPUT_PARENT');
  }
  const resolved = path.join(parent, path.basename(requested));
  if (fs.existsSync(resolved)) fail('OUTPUT_ALREADY_EXISTS');
  const temporary = path.join(
    parent,
    `.${path.basename(resolved)}.tmp.${process.pid}.${crypto.randomBytes(12).toString('hex')}`,
  );
  let descriptor;
  let temporaryOwnership = null;
  let temporaryIdentity = null;
  let ownedResolvedIdentity = null;
  let validated = false;
  let failureCode = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    temporaryOwnership = fs.fstatSync(descriptor, { bigint: true });
    if (!temporaryOwnership.isFile() || temporaryOwnership.isSymbolicLink()) {
      throw new Error('temporary output identity invalid');
    }
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    }
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor, { bigint: true });
    if (!written.isFile() || !sameIdentity(temporaryOwnership, written) ||
        written.size !== BigInt(bytes.length)) {
      throw new Error('short write');
    }
    temporaryIdentity = written;
    fs.closeSync(descriptor);
    descriptor = undefined;
    const temporaryPathIdentity = fs.lstatSync(temporary, { bigint: true });
    if (!temporaryPathIdentity.isFile() || temporaryPathIdentity.isSymbolicLink() ||
        !sameNode(temporaryIdentity, temporaryPathIdentity)) {
      throw new Error('temporary output identity invalid');
    }
    const readback = readFileSnapshot(
      temporary,
      'OUTPUT_WRITE_FAILED',
      'OUTPUT_WRITE_FAILED',
      MAX_INPUT_BYTES,
    );
    if (!readback.equals(bytes)) throw new Error('readback mismatch');
    // The fully validated temporary inode is now the source of a single
    // hard-link commit. No fallible validation follows successful publication.
    fs.linkSync(temporary, resolved);
    ownedResolvedIdentity = temporaryIdentity;
    validated = true;
  } catch (error) {
    failureCode = error && error.code === 'EEXIST'
      ? 'OUTPUT_ALREADY_EXISTS'
      : 'OUTPUT_WRITE_FAILED';
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (!validated && ownedResolvedIdentity) {
      try {
        const current = fs.lstatSync(resolved, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() &&
            sameNode(current, ownedResolvedIdentity)) {
          fs.unlinkSync(resolved);
        }
      } catch {}
    }
    if (temporaryIdentity) {
      try {
        const currentTemporary = fs.lstatSync(temporary, { bigint: true });
        if (currentTemporary.isFile() && !currentTemporary.isSymbolicLink() &&
            sameNode(currentTemporary, temporaryIdentity)) {
          fs.unlinkSync(temporary);
        }
      } catch {}
    }
  }
  if (failureCode) fail(failureCode);
}

function main() {
if (process.argv.length !== 5 || process.argv[3] !== '--output') {
  fail('USAGE: finalize-windows-bootstrap-manifest.cjs DRAFT_JSON --output OUTPUT_JSON');
}

const draft = readStrictJson(path.resolve(process.argv[2]));
const outputPath = path.resolve(process.argv[4]);
if (outputPath === path.resolve(process.argv[2])) fail('INPUT_OUTPUT_PATH_ALIAS');
exactObject(draft, [
  'schemaVersion', 'gateId', 'redeemEndpoint', 'fixtureAuthority',
  'acceptanceHarness', 'installer', 'evidenceHelper', 'images',
  'expectedProfiles', 'expectedFailures',
], 'INVALID_MANIFEST_DRAFT');
exactObject(draft.fixtureAuthority, [
  'id', 'expiresAtUtc', 'notForProduction', 'cases',
], 'INVALID_FIXTURE_AUTHORITY');
exactObject(draft.fixtureAuthority.cases, [
  'network', 'unknown', 'revoked', 'badCapsule', 'valid', 'rotate', 'healthFail',
], 'INVALID_FIXTURE_AUTHORITY');
exactObject(draft.acceptanceHarness, ['sha256'], 'INVALID_LOCAL_SOURCE_MANIFEST');
exactObject(draft.installer, ['sha256'], 'INVALID_LOCAL_SOURCE_MANIFEST');
exactObject(draft.evidenceHelper, ['sha256'], 'INVALID_LOCAL_SOURCE_MANIFEST');
exactObject(draft.images, ['candidate', 'healthFail'], 'INVALID_IMAGE_MANIFEST');
exactObject(draft.images.candidate, [
  'repository', 'tag', 'registryDigest', 'criticalRuntimeSha256', 'labels',
], 'INVALID_IMAGE_MANIFEST');
exactObject(draft.images.healthFail, [
  'repository', 'tag', 'registryDigest', 'failureEntrypoint',
  'failureEntrypointSha256', 'labels',
], 'INVALID_IMAGE_MANIFEST');
exactObject(draft.images.candidate.labels, [
  'org.opencontainers.image.version', 'org.opencontainers.image.revision',
], 'INVALID_IMAGE_LABEL_MANIFEST');
exactObject(draft.images.healthFail.labels, [
  'org.opencontainers.image.version', 'org.opencontainers.image.revision',
  'ai.wentor.acceptance.failure-mode',
], 'INVALID_IMAGE_LABEL_MANIFEST');
exactObject(draft.expectedProfiles, ['valid', 'rotate', 'healthFail'], 'INVALID_PROFILE_EXPECTATIONS');
for (const name of ['valid', 'rotate', 'healthFail']) {
  exactObject(draft.expectedProfiles[name], ['id', 'revision', 'digest'], 'INVALID_PROFILE_EXPECTATION');
}
exactObject(draft.expectedFailures, ['badCapsule'], 'INVALID_FAILURE_EXPECTATIONS');
exactObject(draft.expectedFailures.badCapsule, ['capsuleDigest'], 'INVALID_FAILURE_EXPECTATIONS');

const root = path.resolve(__dirname, '../..');
setLocalSha(draft.acceptanceHarness, sha256File(path.join(__dirname, 'windows-bootstrap-docker.ps1')));
setLocalSha(draft.installer, sha256File(path.join(root, 'scripts/install-docker.ps1')));
setLocalSha(draft.evidenceHelper, sha256File(path.join(__dirname, 'windows-volume-evidence.cjs')));
const entrypointSha = sha256File(path.join(__dirname, 'entrypoint-health-fail.sh'));
if (typeof draft.images.healthFail.failureEntrypointSha256 !== 'string' ||
    (draft.images.healthFail.failureEntrypointSha256 !== 'REPLACE_WITH_64_LOWERCASE_HEX' &&
      draft.images.healthFail.failureEntrypointSha256 !== entrypointSha)) {
  fail('LOCAL_SOURCE_SHA_MISMATCH');
}
draft.images.healthFail.failureEntrypointSha256 = entrypointSha;
const localCriticalRuntimeSha256 = criticalRuntimeSha256(root);
if (typeof draft.images.candidate.criticalRuntimeSha256 !== 'string' ||
    (draft.images.candidate.criticalRuntimeSha256 !== 'REPLACE_WITH_64_LOWERCASE_HEX' &&
      draft.images.candidate.criticalRuntimeSha256 !== localCriticalRuntimeSha256)) {
  fail('LOCAL_SOURCE_RUNTIME_MISMATCH');
}
draft.images.candidate.criticalRuntimeSha256 = localCriticalRuntimeSha256;
if (hasUnresolvedPlaceholder(draft)) fail('UNRESOLVED_MANIFEST_PLACEHOLDER');
if (hasSecretLikeValue(draft)) fail('SECRET_LIKE_MANIFEST_VALUE');

if (draft.schemaVersion !== 1 || !ID.test(draft.gateId) ||
    draft.redeemEndpoint !== 'https://wentor.ai/api/v1/rc/bootstrap/redeem') {
  fail('INVALID_MANIFEST_DRAFT');
}
if (!ID.test(draft.fixtureAuthority.id) ||
    typeof draft.fixtureAuthority.expiresAtUtc !== 'string' ||
    !ISO_UTC.test(draft.fixtureAuthority.expiresAtUtc) ||
    !Number.isFinite(Date.parse(draft.fixtureAuthority.expiresAtUtc)) ||
    Date.parse(draft.fixtureAuthority.expiresAtUtc) <= Date.now() ||
    draft.fixtureAuthority.notForProduction !== true ||
    Object.values(draft.fixtureAuthority.cases).some((value) => value !== true)) {
  fail('INVALID_FIXTURE_AUTHORITY');
}

for (const image of [draft.images.candidate, draft.images.healthFail]) {
  requireString(image.repository, REPOSITORY, 'INVALID_IMAGE_MANIFEST');
  if (image.tag !== 'latest') fail('INVALID_IMAGE_MANIFEST');
  requireString(image.registryDigest, SHA256, 'INVALID_IMAGE_MANIFEST');
  if (image.labels['org.opencontainers.image.version'] !== '0.8.3') {
    fail('INVALID_IMAGE_LABEL_MANIFEST');
  }
  requireString(
    image.labels['org.opencontainers.image.revision'],
    HEX_40,
    'INVALID_IMAGE_LABEL_MANIFEST',
  );
}
if (draft.images.candidate.repository === draft.images.healthFail.repository ||
    draft.images.candidate.registryDigest === draft.images.healthFail.registryDigest) {
  fail('HEALTH_FAIL_IMAGE_MUST_BE_DISTINCT');
}
requireString(
  draft.images.candidate.criticalRuntimeSha256,
  HEX_64,
  'INVALID_CRITICAL_RUNTIME_MANIFEST',
);
if (draft.images.healthFail.failureEntrypoint !== '/entrypoint-health-fail.sh' ||
    draft.images.healthFail.labels['ai.wentor.acceptance.failure-mode'] !== 'health-fail' ||
    draft.images.candidate.labels['org.opencontainers.image.revision'] !==
      draft.images.healthFail.labels['org.opencontainers.image.revision']) {
  fail('INVALID_HEALTH_FAIL_IMAGE_MANIFEST');
}

const profiles = ['valid', 'rotate', 'healthFail'].map((name) => draft.expectedProfiles[name]);
for (const profile of profiles) {
  requireString(profile.id, ID, 'INVALID_PROFILE_EXPECTATION');
  if (!Number.isSafeInteger(profile.revision) || profile.revision < 1 ||
      profile.revision > 2_147_483_647) {
    fail('INVALID_PROFILE_EXPECTATION');
  }
  requireString(profile.digest, HEX_64, 'INVALID_PROFILE_EXPECTATION');
}
if (new Set(profiles.map((profile) => profile.id)).size !== 1 ||
    !(profiles[0].revision < profiles[1].revision && profiles[1].revision < profiles[2].revision) ||
    new Set(profiles.map((profile) => profile.digest)).size !== profiles.length) {
  fail('PROFILE_ROTATION_EXPECTATIONS_INVALID');
}
requireString(
  draft.expectedFailures.badCapsule.capsuleDigest,
  HEX_64,
  'INVALID_FAILURE_EXPECTATIONS',
);
if (profiles.some((profile) => profile.digest === draft.expectedFailures.badCapsule.capsuleDigest)) {
  fail('INVALID_FAILURE_EXPECTATIONS');
}

writeExclusiveUtf8(outputPath, `${JSON.stringify(draft, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  const code = error && typeof error.finalizerCode === 'string'
    ? error.finalizerCode
    : 'MANIFEST_FINALIZATION_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
