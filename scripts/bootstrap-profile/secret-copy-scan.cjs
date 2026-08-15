'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const JSON_STRUCTURED_LIMIT = 2 * 1024 * 1024;
const MIN_SECRET_BYTES = 16;
const MAX_SECRET_BYTES = 16 * 1024;

class SecretCopyScanError extends Error {
  constructor(code) {
    super('Bootstrap Profile secret-copy scan failed');
    this.name = 'SecretCopyScanError';
    this.code = code;
  }
}

function fail(code) {
  throw new SecretCopyScanError(code);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('SECRET_SCAN_FAILED');
  }
}

function structuredValueCount(value, secret) {
  if (typeof value === 'string') return value === secret ? 1 : 0;
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + structuredValueCount(item, secret), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value)
      .reduce((count, item) => count + structuredValueCount(item, secret), 0);
  }
  return 0;
}

function validatedSecretBytes(secret) {
  if (typeof secret !== 'string') fail('SECRET_SCAN_FAILED');
  const bytes = Buffer.from(secret, 'utf8');
  if (bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES) {
    fail('SECRET_SCAN_FAILED');
  }
  return bytes;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

/**
 * The credential file is excluded from the raw tree scan because it is the one
 * allowed long-lived plaintext location. Compensate with a typed assertion:
 * the secret must occur exactly once in the whole store and that occurrence
 * must be the exact OpenClaw API-key profile owned by this transaction.
 */
function assertCanonicalAuthSecret({ authStore, authProfileId, providerId, secret }) {
  validatedSecretBytes(secret);
  if (typeof authProfileId !== 'string' || authProfileId.length === 0
      || typeof providerId !== 'string' || providerId.length === 0
      || authProfileId !== `${providerId}:managed`
      || !authStore || typeof authStore !== 'object' || Array.isArray(authStore)
      || authStore.version !== 1 || !Object.hasOwn(authStore, 'profiles')
      || !authStore.profiles || typeof authStore.profiles !== 'object'
      || Array.isArray(authStore.profiles)) fail('SECRET_SCAN_FAILED');
  const profile = Object.hasOwn(authStore.profiles, authProfileId)
    ? authStore.profiles[authProfileId] : null;
  const canonical = exactKeys(profile, ['type', 'provider', 'key'])
    && profile.type === 'api_key'
    && profile.provider === providerId
    && profile.key === secret;
  const occurrences = structuredValueCount(authStore, secret);
  if (!canonical || occurrences !== 1) fail('SECRET_COPY_DETECTED');
  return { occurrences };
}

function streamContains(file, secret, secretBytes, expected, budget) {
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== expected.dev
        || opened.ino !== expected.ino || opened.size !== expected.size) fail('SECRET_SCAN_FAILED');
    budget.bytes += opened.size;
    if (budget.bytes > MAX_TOTAL_BYTES) fail('SECRET_SCAN_LIMIT_EXCEEDED');
    const scratch = Buffer.alloc(CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let offset = 0;
    let structured = Buffer.alloc(0);
    while (offset < opened.size) {
      const count = fs.readSync(
        descriptor, scratch, 0, Math.min(scratch.length, opened.size - offset), offset,
      );
      if (count <= 0) fail('SECRET_SCAN_FAILED');
      const chunk = scratch.subarray(0, count);
      const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      if (combined.includes(secretBytes)) return true;
      if (opened.size <= JSON_STRUCTURED_LIMIT) structured = Buffer.concat([structured, chunk]);
      const overlap = Math.max(0, secretBytes.length - 1);
      carry = overlap === 0 ? Buffer.alloc(0) : combined.subarray(Math.max(0, combined.length - overlap));
      offset += count;
    }
    if (structured.length > 0) {
      try {
        const parsed = JSON.parse(structured.toString('utf8'));
        if (structuredValueCount(parsed, secret) > 0) return true;
      } catch {
        // Non-JSON files are still scanned byte-for-byte for realistic keys.
      }
    }
    const afterFd = fs.fstatSync(descriptor);
    const afterPath = lstatIfPresent(file);
    if (!afterPath || afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.nlink !== 1
        || afterFd.dev !== opened.dev || afterFd.ino !== opened.ino || afterFd.size !== opened.size
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
        || afterPath.size !== opened.size) fail('SECRET_SCAN_FAILED');
    return false;
  } catch (error) {
    if (error instanceof SecretCopyScanError) throw error;
    fail('SECRET_SCAN_FAILED');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { fail('SECRET_SCAN_FAILED'); }
    }
  }
}

/**
 * Scan live OpenClaw state for an exact managed API key outside explicit
 * credential/transaction allowlists. The key itself never appears in errors.
 */
function assertNoUnexpectedStateSecretCopies({ stateDir, secret, allowedFiles = [], allowedDirectories = [] }) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)
      || typeof secret !== 'string') fail('SECRET_SCAN_FAILED');
  const root = path.resolve(stateDir);
  const rootMetadata = lstatIfPresent(root);
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail('SECRET_SCAN_FAILED');
  }
  const fileAllowlist = new Set(allowedFiles.map((target) => path.resolve(target)));
  const directoryAllowlist = allowedDirectories.map((target) => path.resolve(target));
  for (const target of [...fileAllowlist, ...directoryAllowlist]) {
    if (!isInside(root, target)) fail('SECRET_SCAN_FAILED');
  }
  const budget = { files: 0, bytes: 0 };
  const secretBytes = validatedSecretBytes(secret);
  const generatedPluginSkillsRoot = path.join(root, 'plugin-skills');
  const inspectGeneratedPluginSkillLink = (target, metadata) => {
    // OpenClaw 2026.6.1 intentionally publishes one generated symlink per
    // plugin Skill directly under $OPENCLAW_STATE_DIR/plugin-skills. These are
    // directory references, not copies of their target bytes. Never follow
    // them during a secret-copy scan, but keep every other symlink fail-closed.
    if (path.dirname(target) !== generatedPluginSkillsRoot) return false;
    let linkTarget;
    try {
      linkTarget = fs.readlinkSync(target);
    } catch {
      fail('SECRET_SCAN_FAILED');
    }
    const linkBytes = Buffer.from(linkTarget, 'utf8');
    budget.bytes += linkBytes.length;
    if (budget.bytes > MAX_TOTAL_BYTES) fail('SECRET_SCAN_LIMIT_EXCEEDED');
    if (linkBytes.includes(secretBytes)) fail('SECRET_COPY_DETECTED');
    const after = lstatIfPresent(target);
    if (!after || !after.isSymbolicLink()
        || after.dev !== metadata.dev || after.ino !== metadata.ino
        || after.size !== metadata.size) fail('SECRET_SCAN_FAILED');
    return true;
  };
  const visit = (target) => {
    if (fileAllowlist.has(target)
        || directoryAllowlist.some((directory) => isInside(directory, target))) return;
    const metadata = lstatIfPresent(target);
    if (!metadata) return;
    if (metadata.isSymbolicLink()) {
      if (inspectGeneratedPluginSkillLink(target, metadata)) return;
      fail('SECRET_SCAN_FAILED');
    }
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) fail('SECRET_SCAN_FAILED');
    budget.files += 1;
    if (budget.files > MAX_FILES) fail('SECRET_SCAN_LIMIT_EXCEEDED');
    if (streamContains(target, secret, secretBytes, metadata, budget)) fail('SECRET_COPY_DETECTED');
  };
  visit(root);
  return { filesScanned: budget.files, bytesScanned: budget.bytes };
}

module.exports = {
  SecretCopyScanError,
  assertCanonicalAuthSecret,
  assertNoUnexpectedStateSecretCopies,
};
