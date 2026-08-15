'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureDirectory(directory, mode = 0o700) {
  const missing = [];
  let current = path.resolve(directory);
  while (!lstatIfPresent(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fs.mkdirSync(directory, { recursive: true, mode });
  for (const created of missing.reverse()) {
    if (process.platform !== 'win32') fs.chmodSync(created, mode);
    fsyncDirectory(created);
    const parent = path.dirname(created);
    if (parent !== created && lstatIfPresent(parent)?.isDirectory()) fsyncDirectory(parent);
  }
  if (process.platform !== 'win32') fs.chmodSync(directory, mode);
}

function writeBytesAtomic(file, bytes, mode = 0o600, options = {}) {
  const parent = path.dirname(file);
  if (options.ensureParent === false) {
    const parentMetadata = lstatIfPresent(parent);
    if (!parentMetadata || parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
      throw new Error('unsafe atomic-write parent');
    }
  } else {
    ensureDirectory(parent);
  }
  const prefix = options.temporaryPrefix ?? `.${path.basename(file)}`;
  if (typeof prefix !== 'string' || prefix.length === 0 || path.basename(prefix) !== prefix
      || prefix.includes('\0')) throw new Error('unsafe atomic-write prefix');
  const temporaryName = options.temporaryName ?? `${prefix}.${crypto.randomUUID()}.tmp`;
  if (typeof temporaryName !== 'string' || path.basename(temporaryName) !== temporaryName
      || !temporaryName.startsWith(`${prefix}.`)
      || !/^[^\0/]+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u
        .test(temporaryName)) throw new Error('unsafe atomic-write temporary name');
  const temporary = path.join(parent, temporaryName);
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let fd;
  let opened;
  const cleanupTemporary = () => {
    const candidate = lstatIfPresent(temporary);
    if (candidate && opened && !candidate.isSymbolicLink() && candidate.isFile()
        && candidate.nlink === 1 && candidate.dev === opened.dev && candidate.ino === opened.ino) {
      fs.unlinkSync(temporary);
      try { fsyncDirectory(parent); } catch {}
    }
  };
  try {
    try {
      fd = fs.openSync(temporary, flags, mode);
      if (process.platform !== 'win32') fs.fchmodSync(fd, mode);
      opened = fs.fstatSync(fd);
      assertPrivateRegularMetadata(opened, { maxBytes: bytes.length, exactMode: mode });
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      const persisted = Buffer.alloc(bytes.length);
      let offset = 0;
      while (offset < persisted.length) {
        const count = fs.readSync(fd, persisted, offset, persisted.length - offset, offset);
        if (count <= 0) throw new Error('short atomic-write readback');
        offset += count;
      }
      const afterWrite = fs.fstatSync(fd);
      assertPrivateRegularMetadata(afterWrite, { maxBytes: bytes.length, exactMode: mode });
      if (afterWrite.dev !== opened.dev || afterWrite.ino !== opened.ino
          || afterWrite.size !== bytes.length || !persisted.equals(bytes)) {
        throw new Error('atomic-write readback mismatch');
      }
      opened = afterWrite;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    options.beforeRename?.(temporary);
    const candidate = readPrivateFileRecord(
      temporary, { maxBytes: bytes.length, exactMode: mode },
    );
    if (!opened || !sameFileIdentity(candidate.identity, opened)
        || !candidate.bytes.equals(bytes)) throw new Error('atomic-write readback mismatch');
    fs.renameSync(temporary, file);
    fsyncDirectory(parent);
  } catch (error) {
    cleanupTemporary();
    throw error;
  }
}

function writeBytesExclusiveDurable(file, bytes, mode = 0o600, options = {}) {
  const parent = path.dirname(file);
  if (options.ensureParent === false) {
    const parentMetadata = lstatIfPresent(parent);
    if (!parentMetadata || parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
      throw new Error('unsafe exclusive-write parent');
    }
  } else {
    ensureDirectory(parent);
  }
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  let opened;
  try {
    descriptor = fs.openSync(file, flags, mode);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, mode);
    opened = fs.fstatSync(descriptor);
    assertPrivateRegularMetadata(opened, { maxBytes: bytes.length, exactMode: mode });
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const persisted = Buffer.alloc(bytes.length);
    let offset = 0;
    while (offset < persisted.length) {
      const count = fs.readSync(descriptor, persisted, offset, persisted.length - offset, offset);
      if (count <= 0) throw new Error('short exclusive-write readback');
      offset += count;
    }
    const afterWrite = fs.fstatSync(descriptor);
    assertPrivateRegularMetadata(afterWrite, { maxBytes: bytes.length, exactMode: mode });
    if (afterWrite.dev !== opened.dev || afterWrite.ino !== opened.ino
        || afterWrite.size !== bytes.length || !persisted.equals(bytes)) {
      throw new Error('exclusive-write readback mismatch');
    }
    opened = afterWrite;
    fs.closeSync(descriptor);
    descriptor = undefined;
    const candidate = lstatIfPresent(file);
    assertPrivateRegularMetadata(candidate, { maxBytes: bytes.length, exactMode: mode });
    if (!sameFileIdentity(candidate, opened)) throw new Error('exclusive-write identity changed');
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
      descriptor = undefined;
    }
    const candidate = lstatIfPresent(file);
    if (candidate && opened && !candidate.isSymbolicLink() && candidate.isFile()
        && candidate.nlink === 1 && candidate.dev === opened.dev && candidate.ino === opened.ino) {
      fs.unlinkSync(file);
      try { fsyncDirectory(parent); } catch {}
    }
    throw error;
  }
}

function writeJsonExclusiveDurable(file, value, mode = 0o600, options = {}) {
  writeBytesExclusiveDurable(
    file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), mode, options,
  );
}

function writeJsonStagedNoReplace(finalFile, stagingFile, value, mode = 0o600) {
  if (path.dirname(finalFile) !== path.dirname(stagingFile) || finalFile === stagingFile) {
    throw new Error('unsafe staged authority paths');
  }
  if (lstatIfPresent(finalFile) || lstatIfPresent(stagingFile)) {
    throw new Error('staged authority already exists');
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeBytesExclusiveDurable(stagingFile, bytes, mode, { ensureParent: false });
  fs.linkSync(stagingFile, finalFile);
  fsyncDirectory(path.dirname(finalFile));
  const staging = lstatIfPresent(stagingFile);
  const published = lstatIfPresent(finalFile);
  if (!staging || !published || staging.isSymbolicLink() || published.isSymbolicLink()
      || !staging.isFile() || !published.isFile() || staging.nlink !== 2 || published.nlink !== 2
      || staging.dev !== published.dev || staging.ino !== published.ino
      || staging.size !== bytes.length || published.size !== bytes.length) {
    throw new Error('staged authority identity changed');
  }
  unlinkPrivateFileRecord(stagingFile, {
    dev: staging.dev,
    ino: staging.ino,
    nlink: staging.nlink,
    size: staging.size,
    mode: staging.mode,
    uid: staging.uid,
  }, { expectedNlink: 2 });
  const record = readPrivateFileRecord(finalFile, { maxBytes: bytes.length, exactMode: mode });
  if (!record.bytes.equals(bytes)) throw new Error('staged authority readback mismatch');
  return record;
}

function reconcileStagedJsonAuthority(finalFile, stagingFile, options = {}) {
  const maxBytes = options.maxBytes ?? 4096;
  const mode = options.mode ?? 0o600;
  const finalMetadata = lstatIfPresent(finalFile);
  const stagingMetadata = lstatIfPresent(stagingFile);
  if (!finalMetadata && !stagingMetadata) return null;
  if (!finalMetadata) {
    let staging;
    try {
      staging = readPrivateFileRecord(stagingFile, { maxBytes, exactMode: mode });
      unlinkPrivateFileRecord(stagingFile, staging.identity);
    } catch {
      throw new Error('invalid staged authority residue');
    }
    return null;
  }
  if (stagingMetadata) {
    const privatePair = !finalMetadata.isSymbolicLink() && !stagingMetadata.isSymbolicLink()
      && finalMetadata.isFile() && stagingMetadata.isFile()
      && finalMetadata.nlink === 2 && stagingMetadata.nlink === 2
      && finalMetadata.dev === stagingMetadata.dev && finalMetadata.ino === stagingMetadata.ino
      && finalMetadata.size === stagingMetadata.size && finalMetadata.size <= maxBytes
      && (process.platform === 'win32'
        || ((finalMetadata.mode & 0o7777) === mode && (stagingMetadata.mode & 0o7777) === mode
          && (typeof process.getuid !== 'function'
            || (finalMetadata.uid === process.getuid() && stagingMetadata.uid === process.getuid()))));
    if (!privatePair) throw new Error('invalid staged authority pair');
    unlinkPrivateFileRecord(stagingFile, {
      dev: stagingMetadata.dev,
      ino: stagingMetadata.ino,
      nlink: stagingMetadata.nlink,
      size: stagingMetadata.size,
      mode: stagingMetadata.mode,
      uid: stagingMetadata.uid,
    }, { expectedNlink: 2 });
  }
  return readPrivateFileRecord(finalFile, { maxBytes, exactMode: mode });
}

function writeJsonAtomic(file, value, mode = 0o600, options = {}) {
  writeBytesAtomic(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), mode, options);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertPrivateRegularMetadata(
  metadata,
  { maxBytes = 2 * 1024 * 1024, exactMode = null } = {},
) {
  if (!metadata) throw new Error('unsafe private file');
  if (!metadata.isFile() || metadata.nlink !== 1
      || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes) {
    throw new Error('unsafe private file');
  }
  if (process.platform !== 'win32') {
    const actualMode = metadata.mode & 0o7777;
    if ((actualMode & 0o7000) !== 0
        || (exactMode === null ? (actualMode & 0o077) !== 0 : actualMode !== exactMode)) {
      throw new Error('unsafe private file permissions');
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error('unsafe private file owner');
    }
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.nlink === right.nlink && left.size === right.size
    && left.mode === right.mode && left.uid === right.uid;
}

function assertNoSpecialModeBits(metadata) {
  if (process.platform !== 'win32' && (metadata.mode & 0o7000) !== 0) {
    throw new Error('unsafe POSIX special mode bits');
  }
}

/**
 * Read a private regular file through one verified descriptor. O_NONBLOCK is
 * intentional so an unexpected special-file transition fails without hanging
 * the maintenance transaction.
 */
function readPrivateFileRecord(
  file,
  { maxBytes = 2 * 1024 * 1024, allowAbsent = false, exactMode = null } = {},
) {
  const before = lstatIfPresent(file);
  if (!before) {
    if (allowAbsent) return null;
    throw new Error('private file missing');
  }
  if (before.isSymbolicLink()) throw new Error('unsafe private file');
  assertPrivateRegularMetadata(before, { maxBytes, exactMode });
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, flags);
    const opened = fs.fstatSync(descriptor);
    assertPrivateRegularMetadata(opened, { maxBytes, exactMode });
    if (!sameFileIdentity(opened, before)) {
      throw new Error('private file identity changed');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('short private file read');
      offset += count;
    }
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = lstatIfPresent(file);
    assertPrivateRegularMetadata(afterDescriptor, { maxBytes, exactMode });
    if (!afterPath || afterPath.isSymbolicLink()) throw new Error('private file identity changed');
    assertPrivateRegularMetadata(afterPath, { maxBytes, exactMode });
    if (!sameFileIdentity(afterDescriptor, opened) || !sameFileIdentity(afterPath, opened)) {
      throw new Error('private file identity changed');
    }
    return {
      bytes,
      identity: {
        dev: afterDescriptor.dev,
        ino: afterDescriptor.ino,
        nlink: afterDescriptor.nlink,
        size: afterDescriptor.size,
        mode: afterDescriptor.mode,
        uid: afterDescriptor.uid,
      },
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readPrivateFile(file, options = {}) {
  const record = readPrivateFileRecord(file, options);
  return record === null ? null : record.bytes;
}

function unlinkPrivateFileRecord(file, identity, options = {}) {
  const expectedNlink = options.expectedNlink ?? 1;
  const candidate = lstatIfPresent(file);
  if (!candidate || candidate.isSymbolicLink() || !candidate.isFile()
      || candidate.nlink !== expectedNlink || identity.nlink !== expectedNlink
      || candidate.dev !== identity.dev || candidate.ino !== identity.ino
      || candidate.nlink !== identity.nlink || candidate.size !== identity.size
      || candidate.mode !== identity.mode || candidate.uid !== identity.uid) {
    throw new Error('private file identity changed');
  }
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function readPrivateJson(file, fallback, options = {}) {
  const bytes = readPrivateFile(file, { ...options, allowAbsent: fallback !== undefined });
  if (bytes === null) return fallback;
  return JSON.parse(bytes.toString('utf8'));
}

function removePath(target) {
  const metadata = lstatIfPresent(target);
  if (!metadata) return;
  const parent = path.dirname(target);
  fs.rmSync(target, { recursive: true, force: true });
  if (lstatIfPresent(parent)?.isDirectory()) fsyncDirectory(parent);
}

function writeAllSync(descriptor, bytes, offset, length, position) {
  let written = 0;
  while (written < length) {
    const count = fs.writeSync(
      descriptor, bytes, offset + written, length - written, position + written,
    );
    if (count <= 0) throw new Error('short durable file write');
    written += count;
  }
}

function hashDescriptor(descriptor, size) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    const count = fs.readSync(descriptor, buffer, 0, length, offset);
    if (count <= 0) throw new Error('short durable file read');
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest('hex');
}

function assertStablePathDescriptor(file, before, descriptor, options = {}) {
  const afterDescriptor = fs.fstatSync(descriptor);
  const afterPath = lstatIfPresent(file);
  if (!afterPath || afterPath.isSymbolicLink() || !afterPath.isFile()
      || !sameFileIdentity(before, afterDescriptor)
      || !sameFileIdentity(before, afterPath)) {
    throw new Error('durable file identity changed');
  }
  assertNoSpecialModeBits(afterDescriptor);
  if (options.privateMode !== undefined) {
    assertPrivateRegularMetadata(afterDescriptor, {
      maxBytes: options.maxBytes ?? afterDescriptor.size,
      exactMode: options.privateMode,
    });
    assertPrivateRegularMetadata(afterPath, {
      maxBytes: options.maxBytes ?? afterPath.size,
      exactMode: options.privateMode,
    });
  }
  return afterDescriptor;
}

function serializedContentIdentity(metadata) {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    nlink: metadata.nlink,
    size: metadata.size,
    mode: process.platform === 'win32' ? null : metadata.mode & 0o7777,
  };
}

function copySnapshotFile(source, destination) {
  const before = lstatIfPresent(source);
  if (!before || before.isSymbolicLink() || !before.isFile()
      || !Number.isSafeInteger(before.size) || before.size < 0 || before.nlink < 1) {
    throw new Error('unsupported transaction preimage entry');
  }
  assertNoSpecialModeBits(before);
  const sourceFlags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  const destinationFlags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let sourceDescriptor;
  let destinationDescriptor;
  let destinationOpened;
  try {
    sourceDescriptor = fs.openSync(source, sourceFlags);
    const opened = fs.fstatSync(sourceDescriptor);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error('transaction preimage identity changed');
    }
    assertNoSpecialModeBits(opened);

    destinationDescriptor = fs.openSync(destination, destinationFlags, 0o600);
    if (process.platform !== 'win32') fs.fchmodSync(destinationDescriptor, 0o600);
    destinationOpened = fs.fstatSync(destinationDescriptor);
    assertPrivateRegularMetadata(destinationOpened, { maxBytes: before.size, exactMode: 0o600 });

    const sourceHash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(buffer.length, opened.size - offset);
      const count = fs.readSync(sourceDescriptor, buffer, 0, length, offset);
      if (count <= 0) throw new Error('short transaction preimage read');
      sourceHash.update(buffer.subarray(0, count));
      writeAllSync(destinationDescriptor, buffer, 0, count, offset);
      offset += count;
    }
    fs.fsyncSync(destinationDescriptor);

    assertStablePathDescriptor(source, opened, sourceDescriptor);
    const saved = fs.fstatSync(destinationDescriptor);
    const savedPath = lstatIfPresent(destination);
    assertPrivateRegularMetadata(saved, { maxBytes: opened.size, exactMode: 0o600 });
    assertPrivateRegularMetadata(savedPath, { maxBytes: opened.size, exactMode: 0o600 });
    if (!destinationOpened || saved.dev !== destinationOpened.dev
        || saved.ino !== destinationOpened.ino || saved.nlink !== destinationOpened.nlink
        || saved.size !== opened.size || !sameFileIdentity(saved, savedPath)) {
      throw new Error('transaction preimage copy identity changed');
    }
    const digest = sourceHash.digest('hex');
    if (hashDescriptor(destinationDescriptor, saved.size) !== digest) {
      throw new Error('transaction preimage copy mismatch');
    }
    assertStablePathDescriptor(
      destination, saved, destinationDescriptor, { privateMode: 0o600, maxBytes: saved.size },
    );
    return { sha256: digest, contentIdentity: serializedContentIdentity(saved) };
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
    if (destinationOpened) fsyncDirectory(path.dirname(destination));
  }
}

function copyVerifiedDescriptorDurable(record, destination, mode) {
  const sourceBefore = fs.fstatSync(record.descriptor);
  if (!sameFileIdentity(sourceBefore, record.identity)) {
    throw new Error('transaction preimage descriptor changed');
  }
  assertPrivateRegularMetadata(sourceBefore, { maxBytes: record.identity.size, exactMode: 0o600 });
  const destinationFlags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let destinationDescriptor;
  let destinationOpened;
  try {
    destinationDescriptor = fs.openSync(destination, destinationFlags, 0o600);
    if (process.platform !== 'win32') fs.fchmodSync(destinationDescriptor, 0o600);
    destinationOpened = fs.fstatSync(destinationDescriptor);
    assertPrivateRegularMetadata(
      destinationOpened, { maxBytes: record.identity.size, exactMode: 0o600 },
    );
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < record.identity.size) {
      const length = Math.min(buffer.length, record.identity.size - offset);
      const count = fs.readSync(record.descriptor, buffer, 0, length, offset);
      if (count <= 0) throw new Error('short transaction restore read');
      hash.update(buffer.subarray(0, count));
      writeAllSync(destinationDescriptor, buffer, 0, count, offset);
      offset += count;
    }
    if (hash.digest('hex') !== record.sha256) {
      throw new Error('transaction preimage descriptor digest changed');
    }
    if (!sameFileIdentity(fs.fstatSync(record.descriptor), record.identity)) {
      throw new Error('transaction preimage descriptor changed');
    }
    fs.fsyncSync(destinationDescriptor);
    const copied = fs.fstatSync(destinationDescriptor);
    if (copied.dev !== destinationOpened.dev || copied.ino !== destinationOpened.ino
        || copied.nlink !== 1 || copied.size !== record.identity.size
        || hashDescriptor(destinationDescriptor, copied.size) !== record.sha256) {
      throw new Error('transaction restore copy mismatch');
    }
    if (mode !== null && mode !== undefined && process.platform !== 'win32') {
      if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777 || (mode & 0o7000) !== 0) {
        throw new Error('invalid transaction restore mode');
      }
      fs.fchmodSync(destinationDescriptor, mode);
      fs.fsyncSync(destinationDescriptor);
    }
    const finalMetadata = fs.fstatSync(destinationDescriptor);
    const finalPath = lstatIfPresent(destination);
    if (!finalPath || finalPath.isSymbolicLink() || !finalPath.isFile()
        || finalMetadata.dev !== destinationOpened.dev || finalMetadata.ino !== destinationOpened.ino
        || finalMetadata.nlink !== 1 || finalMetadata.size !== record.identity.size
        || !sameFileIdentity(finalMetadata, finalPath)
        || (process.platform !== 'win32' && (finalMetadata.mode & 0o7777) !== mode)) {
      throw new Error('transaction restore identity changed');
    }
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    if (destinationOpened) fsyncDirectory(path.dirname(destination));
  }
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function portableMode(metadata) {
  return process.platform === 'win32' ? null : metadata.mode & 0o777;
}

function snapshotPath(source, destination) {
  removePath(destination);
  ensureDirectory(destination);
  const metadataPath = path.join(destination, 'snapshot.json');
  const contentRoot = path.join(destination, 'content');
  const entries = [];

  const capture = (absolute, relative) => {
    const metadata = lstatIfPresent(absolute);
    if (!metadata) {
      entries.push({ path: relative, type: 'absent', mode: null });
      return;
    }
    assertNoSpecialModeBits(metadata);
    const mode = portableMode(metadata);
    if (metadata.isSymbolicLink()) {
      entries.push({ path: relative, type: 'symlink', mode, target: fs.readlinkSync(absolute) });
      return;
    }
    if (metadata.isDirectory()) {
      entries.push({ path: relative, type: 'directory', mode });
      for (const name of fs.readdirSync(absolute).sort()) {
        capture(path.join(absolute, name), relative ? path.join(relative, name) : name);
      }
      const after = lstatIfPresent(absolute);
      if (!after || after.isSymbolicLink() || !after.isDirectory()
          || !sameFileIdentity(metadata, after)) {
        throw new Error('transaction preimage directory identity changed');
      }
      return;
    }
    if (metadata.isFile()) {
      const relativeContent = relative || '__root_file__';
      const saved = path.join(contentRoot, relativeContent);
      ensureDirectory(path.dirname(saved));
      // Transaction content is always private even when the original live file
      // was historically group/world readable. The original mode remains only
      // in snapshot metadata so rollback can reproduce it exactly.
      const copied = copySnapshotFile(absolute, saved);
      entries.push({
        path: relative,
        type: 'file',
        mode,
        sha256: copied.sha256,
        content: relativeContent,
        contentIdentity: copied.contentIdentity,
      });
      return;
    }
    throw new Error('unsupported transaction preimage entry');
  };

  capture(source, '');
  writeJsonAtomic(metadataPath, { version: 1, entries });
  fsyncDirectory(destination);
  return sha256(Buffer.from(JSON.stringify(entries)));
}

function safeSnapshotRelative(value) {
  return typeof value === 'string'
    && !value.includes('\0')
    && !path.isAbsolute(value)
    && (value === '' || path.normalize(value) === value)
    && value !== '..'
    && !value.startsWith(`..${path.sep}`);
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === [...keys].sort()[index]);
}

function validSnapshotMode(mode, type) {
  if (type === 'absent' || process.platform === 'win32') return mode === null;
  return Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o777;
}

function validContentIdentity(identity) {
  return hasExactKeys(identity, ['dev', 'ino', 'mode', 'nlink', 'size'])
    && typeof identity.dev === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(identity.dev)
    && typeof identity.ino === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(identity.ino)
    && identity.nlink === 1
    && Number.isSafeInteger(identity.size) && identity.size >= 0
    && (process.platform === 'win32' ? identity.mode === null : identity.mode === 0o600);
}

function matchesContentIdentity(metadata, identity) {
  return String(metadata.dev) === identity.dev && String(metadata.ino) === identity.ino
    && metadata.nlink === identity.nlink && metadata.size === identity.size
    && (process.platform === 'win32' || (metadata.mode & 0o7777) === identity.mode);
}

function openVerifiedSnapshotContent(file, entry) {
  const before = lstatIfPresent(file);
  assertPrivateRegularMetadata(
    before, { maxBytes: entry.contentIdentity.size, exactMode: 0o600 },
  );
  if (!matchesContentIdentity(before, entry.contentIdentity)) {
    throw new Error('invalid transaction snapshot');
  }
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, flags);
    const opened = fs.fstatSync(descriptor);
    assertPrivateRegularMetadata(
      opened, { maxBytes: entry.contentIdentity.size, exactMode: 0o600 },
    );
    if (!sameFileIdentity(before, opened)
        || !matchesContentIdentity(opened, entry.contentIdentity)
        || hashDescriptor(descriptor, opened.size) !== entry.sha256) {
      throw new Error('invalid transaction snapshot');
    }
    const verified = assertStablePathDescriptor(
      file, opened, descriptor, { privateMode: 0o600, maxBytes: opened.size },
    );
    return { descriptor, identity: verified, sha256: entry.sha256 };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

function openVerifiedSnapshot(snapshotRoot, expectedDigest) {
  const rootMetadata = lstatIfPresent(snapshotRoot);
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('invalid transaction snapshot');
  }
  assertNoSpecialModeBits(rootMetadata);
  const metadataPath = path.join(snapshotRoot, 'snapshot.json');
  let snapshot;
  try {
    const metadata = readPrivateFile(
      metadataPath, { maxBytes: 2 * 1024 * 1024, exactMode: 0o600 },
    );
    snapshot = JSON.parse(metadata.toString('utf8'));
  } catch {
    throw new Error('invalid transaction snapshot');
  }
  if (!hasExactKeys(snapshot, ['entries', 'version'])
      || snapshot.version !== 1 || !Array.isArray(snapshot.entries)
      || snapshot.entries.length === 0 || snapshot.entries.length > 10_000) {
    throw new Error('invalid transaction snapshot');
  }
  if (sha256(Buffer.from(JSON.stringify(snapshot.entries))) !== expectedDigest) {
    throw new Error('invalid transaction snapshot');
  }
  const seen = new Set();
  const seenContent = new Set();
  const contentRecords = new Map();
  let rootCount = 0;
  try {
    for (const entry of snapshot.entries) {
      if (!entry || typeof entry !== 'object' || !safeSnapshotRelative(entry.path)
          || seen.has(entry.path) || !['absent', 'directory', 'file', 'symlink'].includes(entry.type)
          || !validSnapshotMode(entry.mode, entry.type)) {
        throw new Error('invalid transaction snapshot');
      }
      seen.add(entry.path);
      if (entry.path === '') rootCount += 1;
      if (entry.type === 'file') {
        if (!hasExactKeys(
          entry, ['content', 'contentIdentity', 'mode', 'path', 'sha256', 'type'],
        ) || !/^[0-9a-f]{64}$/u.test(entry.sha256)
          || !safeSnapshotRelative(entry.content) || seenContent.has(entry.content)
          || !validContentIdentity(entry.contentIdentity)) {
          throw new Error('invalid transaction snapshot');
        }
        seenContent.add(entry.content);
        const contentRoot = path.join(snapshotRoot, 'content');
        const content = path.join(contentRoot, entry.content);
        if (!content.startsWith(`${contentRoot}${path.sep}`)) {
          throw new Error('invalid transaction snapshot');
        }
        contentRecords.set(entry.content, openVerifiedSnapshotContent(content, entry));
      } else if (entry.type === 'symlink') {
        if (!hasExactKeys(entry, ['mode', 'path', 'target', 'type'])
            || typeof entry.target !== 'string' || entry.target.includes('\0')) {
          throw new Error('invalid transaction snapshot');
        }
      } else if (!hasExactKeys(entry, ['mode', 'path', 'type'])) {
        throw new Error('invalid transaction snapshot');
      }
    }
    if (rootCount !== 1) throw new Error('invalid transaction snapshot');
    const afterRoot = lstatIfPresent(snapshotRoot);
    if (!afterRoot || afterRoot.isSymbolicLink() || !afterRoot.isDirectory()
        || !sameFileIdentity(rootMetadata, afterRoot)) {
      throw new Error('invalid transaction snapshot');
    }
    return { snapshot, contentRecords };
  } catch (error) {
    for (const record of contentRecords.values()) {
      try { fs.closeSync(record.descriptor); } catch {}
    }
    throw error;
  }
}

function closeVerifiedSnapshot(verified) {
  let firstError;
  for (const record of verified.contentRecords.values()) {
    try { fs.closeSync(record.descriptor); } catch (error) { firstError ??= error; }
  }
  if (firstError) throw firstError;
}

function verifySnapshot(snapshotRoot, expectedDigest) {
  const verified = openVerifiedSnapshot(snapshotRoot, expectedDigest);
  try {
    return verified.snapshot;
  } finally {
    closeVerifiedSnapshot(verified);
  }
}

function restorePath(destination, snapshotRoot, expectedDigest) {
  const verified = openVerifiedSnapshot(snapshotRoot, expectedDigest);
  try {
    const { snapshot, contentRecords } = verified;
    removePath(destination);
    const root = snapshot.entries.find((entry) => entry.path === '');
    if (!root || root.type === 'absent') return;
    const resolve = (relative) => relative ? path.join(destination, relative) : destination;
    const directories = snapshot.entries
      .filter((entry) => entry.type === 'directory')
      .sort((a, b) => a.path.split(path.sep).length - b.path.split(path.sep).length);
    for (const entry of directories) ensureDirectory(resolve(entry.path));
    for (const entry of snapshot.entries) {
      if (entry.type === 'file') {
        const target = resolve(entry.path);
        ensureDirectory(path.dirname(target));
        const record = contentRecords.get(entry.content);
        if (!record) throw new Error('invalid transaction snapshot');
        copyVerifiedDescriptorDurable(record, target, entry.mode);
      } else if (entry.type === 'symlink') {
        const target = resolve(entry.path);
        ensureDirectory(path.dirname(target));
        fs.symlinkSync(entry.target, target);
      }
    }
    for (const entry of directories.reverse()) {
      if (entry.mode !== null) fs.chmodSync(resolve(entry.path), entry.mode);
      fsyncDirectory(resolve(entry.path));
    }
    fsyncDirectory(path.dirname(destination));
  } finally {
    closeVerifiedSnapshot(verified);
  }
}

function copyTree(source, destination) {
  removePath(destination);
  if (!lstatIfPresent(source)) return;
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

function directoryDigest(root, options = {}) {
  const ignored = new Set(options.ignore ?? []);
  const hash = crypto.createHash('sha256');
  const visit = (absolute, relative) => {
    const metadata = lstatIfPresent(absolute);
    if (!metadata) {
      hash.update(`${relative}:absent;`);
      return;
    }
    if (metadata.isDirectory()) {
      hash.update(`${relative}:directory:${portableMode(metadata)};`);
      for (const name of fs.readdirSync(absolute).sort()) {
        if (ignored.has(name)) continue;
        visit(path.join(absolute, name), relative ? path.join(relative, name) : name);
      }
    } else if (metadata.isFile()) {
      hash.update(`${relative}:file:${portableMode(metadata)}:`);
      hash.update(fs.readFileSync(absolute));
      hash.update(';');
    } else if (metadata.isSymbolicLink()) {
      hash.update(`${relative}:symlink:${fs.readlinkSync(absolute)};`);
    }
  };
  visit(root, '');
  return hash.digest('hex');
}

module.exports = {
  copyTree,
  directoryDigest,
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
  writeJsonExclusiveDurable,
  writeJsonStagedNoReplace,
  unlinkPrivateFileRecord,
};
