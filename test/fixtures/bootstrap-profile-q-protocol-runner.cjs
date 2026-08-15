'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const [applierFile, pathsBase64, txId, epochValue, planBase64, readyFile] = process.argv.slice(2);
const paths = JSON.parse(Buffer.from(pathsBase64, 'base64url').toString('utf8'));
const plan = JSON.parse(Buffer.from(planBase64, 'base64url').toString('utf8'));
const epoch = epochValue === '-' ? null : epochValue;

if (!path.isAbsolute(applierFile) || !path.isAbsolute(readyFile) || !plan || !plan.action) {
  process.exit(2);
}

process.env.NODE_ENV = 'test';
process.env.RC_BOOTSTRAP_ENABLE_TEST_FAULTS = '1';

const original = Object.fromEntries([
  'accessSync', 'chmodSync', 'closeSync', 'copyFileSync', 'existsSync', 'fstatSync', 'fsyncSync',
  'linkSync', 'lstatSync', 'mkdirSync', 'openSync', 'opendirSync', 'readFileSync', 'readdirSync',
  'readlinkSync', 'readSync', 'realpathSync', 'renameSync', 'rmdirSync', 'statSync', 'unlinkSync',
  'writeFileSync', 'writeSync',
].map((name) => [name, fs[name].bind(fs)]));
const originalRealpathNative = typeof fs.realpathSync.native === 'function'
  ? fs.realpathSync.native.bind(fs.realpathSync) : null;
const originalSpawn = childProcess.spawn.bind(childProcess);

const bootstrapRoot = path.join(path.dirname(paths.configPath), '.rc-bootstrap');
const transactionsRoot = path.join(bootstrapRoot, 'transactions');
const transactionRoot = path.join(transactionsRoot, txId);
const quarantineRoot = path.join(bootstrapRoot, 'cron-worker-cleanup-quarantine');
const source = epoch === null
  ? path.join(transactionRoot, 'cron-clone')
  : path.join(transactionRoot, `.rc-bootstrap-worker-${txId}-${epoch}`);
const suffix = epoch === null ? 'clone' : `scratch-${epoch}`;
const layerFiles = Object.fromEntries([
  'reservation', 'authority', 'delete-authority', 'done',
].map((layer) => [layer, {
  final: path.join(transactionRoot, `cron-worker-cleanup-${layer}-${suffix}.json`),
  staging: path.join(transactionRoot, `cron-worker-cleanup-${layer}-${suffix}.staging`),
}]));
Object.defineProperty(layerFiles, 'inventory', {
  enumerable: true,
  get: () => discoverInventoryFiles(),
});

let readyWritten = false;
let internalIo = false;
let scanGeneration = 0;
let renameArmed = false;
let stagingFsyncPending = null;
let linkFsyncPending = null;
let unlinkFsyncPending = null;
let teardownFsyncPending = null;
let partialRepairObserved = false;
let attacked = false;
let attackSnapshot = null;
let authorityReadOpens = 0;
let populatedFiles = 0;
let populatedBytes = 0;
let capturedReparent = null;
let cleanupNamesEnumerated = 0;
let transactionReaddirCleanupNames = 0;
let batchTopLevelNamesEnumerated = 0;
let batchReaddirNamesEnumerated = 0;
let sourceNamesEnumerated = 0;
let sourceReaddirNamesEnumerated = 0;
let heldFile = null;
let attackDetails = null;
let cloneFaultWritten = 0;
let cloneSourceOpenCount = 0;
let cloneReplacementPending = null;
let cloneHierarchyRebindPending = null;
const fdPaths = new Map();
const cloneSourceDescriptors = new Map();
const namespaceEvents = [];
const renameEvents = [];
const recoveryDurabilityEvents = [];
const scanCloseEvents = [];
const cloneNamespaceEvents = [];
const lastControlOpenMutationCount = new Map();
const watched = {
  accessSync: 0,
  existsSync: 0,
  lstatSync: 0,
  openSync: 0,
  opendirSync: 0,
  readFileSync: 0,
  readdirSync: 0,
  readlinkSync: 0,
  readSync: 0,
  realpathSync: 0,
  statSync: 0,
};

function withInternalIo(callback) {
  const previousInternalIo = internalIo;
  internalIo = true;
  try {
    return callback();
  } finally {
    internalIo = previousInternalIo;
  }
}

function normalized(target) {
  if (typeof target !== 'string' && !Buffer.isBuffer(target)) return null;
  const resolved = path.resolve(String(target));
  let parent = path.dirname(resolved);
  const suffixes = [path.basename(resolved)];
  for (;;) {
    try {
      const canonicalParent = withInternalIo(() => (originalRealpathNative
        ? originalRealpathNative(parent) : original.realpathSync(parent)));
      return path.join(canonicalParent, ...suffixes);
    } catch (error) {
      if (!error || !['ENOENT', 'ENOTDIR'].includes(error.code)) return resolved;
      const next = path.dirname(parent);
      if (next === parent) return resolved;
      suffixes.unshift(path.basename(parent));
      parent = next;
    }
  }
}

function samePath(left, right) {
  if (!right) return false;
  const resolved = normalized(left);
  return resolved !== null && resolved === normalized(right);
}

function insideCloneRoot(target) {
  const resolved = normalized(target);
  const root = normalized(source);
  return epoch === null && resolved !== null
    && (resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function recordCloneNamespace(operation, target) {
  if (!insideCloneRoot(target)) return;
  cloneNamespaceEvents.push({ operation, target: normalized(target) });
}

function fileExists(target) {
  if (!target) return false;
  try {
    original.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function discoverInventoryFiles() {
  let names;
  try { names = original.readdirSync(transactionRoot); } catch (error) {
    if (error && error.code === 'ENOENT') return { final: null, staging: null, anchor: null };
    throw error;
  }
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^cron-worker-cleanup-inventory-${escaped}(?:-([0-9a-f]{64}))?\\.(json|staging)$`,
  );
  const matches = names.map((name) => pattern.exec(name)).filter(Boolean);
  if (matches.length === 0) return { final: null, staging: null, anchor: null };
  const anchors = [...new Set(matches.map((match) => match[1] || null))];
  if (anchors.length !== 1) throw new Error('ambiguous test inventory anchor');
  const anchor = anchors[0];
  const stem = path.join(
    transactionRoot,
    `cron-worker-cleanup-inventory-${suffix}${anchor ? `-${anchor}` : ''}`,
  );
  return { final: `${stem}.json`, staging: `${stem}.staging`, anchor };
}

function privateWriteJson(target, value) {
  const temporary = `${target}.tmp-${process.pid}`;
  internalIo = true;
  try {
    original.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    original.renameSync(temporary, target);
  } finally {
    internalIo = false;
  }
}

function writeReady(value) {
  if (readyWritten) return;
  readyWritten = true;
  privateWriteJson(readyFile, {
    version: 1,
    pid: process.pid,
    txId,
    epoch,
    ...value,
  });
}

function pause(value) {
  writeReady(value);
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
}

function publicationLayer(target, extension) {
  const resolved = normalized(target);
  if (!resolved) return null;
  if (path.basename(resolved) === `intent.${extension}`
      && path.basename(path.dirname(resolved)).startsWith('.cleanup-')) return 'intent';
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(
    `^cron-worker-cleanup-inventory-${escaped}(?:-[0-9a-f]{64})?\\.${extension}$`,
  ).test(path.basename(resolved))) return 'inventory';
  const match = new RegExp(
    `^cron-worker-cleanup-(reservation|authority|delete-authority|done)-${escaped}\\.${extension}$`,
  ).exec(path.basename(resolved));
  return match ? match[1] : null;
}

function publicationParent(layer) {
  if (layer !== 'intent') return transactionRoot;
  try {
    const reservation = JSON.parse(original.readFileSync(layerFiles.reservation.final, 'utf8'));
    return path.join(quarantineRoot, reservation.container);
  } catch {
    return null;
  }
}

function recordNamespace(layer, operation, target) {
  const event = {
    layer,
    operation,
    generation: scanGeneration,
    target: normalized(target),
  };
  namespaceEvents.push(event);
  return event;
}

function controlSnapshot() {
  const result = {};
  const candidates = [];
  for (const [layer, files] of Object.entries(layerFiles)) {
    if (files.final) candidates.push([`${layer}.json`, files.final]);
    if (files.staging) candidates.push([`${layer}.staging`, files.staging]);
  }
  if (fileExists(layerFiles.reservation.final)) {
    try {
      const reservation = JSON.parse(original.readFileSync(layerFiles.reservation.final, 'utf8'));
      const container = path.join(quarantineRoot, reservation.container);
      candidates.push(['intent.json', path.join(container, 'intent.json')]);
      candidates.push(['intent.staging', path.join(container, 'intent.staging')]);
    } catch {}
  }
  for (const [name, target] of candidates) {
    if (!fileExists(target)) continue;
    const metadata = original.lstatSync(target);
    result[name] = {
      path: target,
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      nlink: metadata.nlink,
      size: metadata.size,
      bytes: metadata.isFile() ? original.readFileSync(target).toString('base64') : null,
    };
  }
  return result;
}

function directoryIdentity(target) {
  const metadata = original.lstatSync(target);
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

function fileIdentity(target) {
  const metadata = original.lstatSync(target);
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    nlink: metadata.nlink,
    size: metadata.size,
  };
}

function sameLengthDigestTamper(bytes) {
  const changed = Buffer.from(bytes);
  const marker = Buffer.from('"digest": "');
  const markerOffset = changed.indexOf(marker);
  if (markerOffset < 0) throw new Error('test tamper requires a digest field');
  const digitOffset = markerOffset + marker.length;
  if (digitOffset >= changed.length) throw new Error('test tamper digest is truncated');
  changed[digitOffset] = changed[digitOffset] === 0x30 ? 0x31 : 0x30;
  if (changed.length !== bytes.length || changed.equals(bytes)) {
    throw new Error('test tamper must preserve length and alter bytes');
  }
  return changed;
}

function overwriteSameInode(target) {
  return withInternalIo(() => {
    const beforeIdentity = fileIdentity(target);
    const beforeBytes = original.readFileSync(target);
    const afterBytes = sameLengthDigestTamper(beforeBytes);
    const descriptor = original.openSync(target, fs.constants.O_RDWR);
    try {
      let offset = 0;
      while (offset < afterBytes.length) {
        const count = original.writeSync(
          descriptor, afterBytes, offset, afterBytes.length - offset, offset,
        );
        if (count <= 0) throw new Error('test tamper write made no progress');
        offset += count;
      }
      original.fsyncSync(descriptor);
    } finally {
      original.closeSync(descriptor);
    }
    const afterIdentity = fileIdentity(target);
    if (beforeIdentity.dev !== afterIdentity.dev || beforeIdentity.ino !== afterIdentity.ino
        || beforeIdentity.size !== afterIdentity.size) {
      throw new Error('test tamper unexpectedly changed identity or length');
    }
    return {
      target,
      beforeIdentity,
      afterIdentity,
      beforeSha256: crypto.createHash('sha256').update(beforeBytes).digest('hex'),
      afterSha256: crypto.createHash('sha256').update(afterBytes).digest('hex'),
      bytes: afterBytes.toString('base64'),
    };
  });
}

function replacementHeldPath(label) {
  return path.join(
    path.dirname(bootstrapRoot),
    `held-${label}-${txId}-${suffix}-${process.pid}`,
  );
}

function rebindCloneRootAfterStateMkdir() {
  const stateRoot = path.join(source, 'state');
  const heldRoot = replacementHeldPath('clone-root');
  const sourceBefore = directoryIdentity(source);
  const stateBefore = directoryIdentity(stateRoot);
  original.renameSync(source, heldRoot);
  original.mkdirSync(source, { mode: 0o700 });
  original.mkdirSync(stateRoot, { mode: 0o700 });
  if (process.platform !== 'win32') {
    original.chmodSync(source, 0o700);
    original.chmodSync(stateRoot, 0o700);
  }
  const sentinel = path.join(source, 'openclaw.json');
  original.writeFileSync(sentinel, 'ATTACKER_OPENCLAW_SENTINEL\n', {
    flag: 'wx', mode: 0o600,
  });
  heldFile = heldRoot;
  attackDetails = {
    kind: 'clone-root-rebind',
    heldRoot,
    replacementRoot: source,
    sentinel,
    sourceBefore,
    sourceAfter: directoryIdentity(source),
    stateBefore,
    stateAfter: directoryIdentity(stateRoot),
  };
  attacked = true;
}

function cloneDatabaseDestination(target) {
  return insideCloneRoot(target)
    && /^openclaw\.sqlite(?:-wal|-shm)?$/.test(path.basename(normalized(target)));
}

function cloneDatabaseSource(target) {
  const resolved = normalized(target);
  const database = normalized(path.join(paths.stateDir, 'state/openclaw.sqlite'));
  return resolved !== null && (resolved === database
    || resolved === `${database}-wal` || resolved === `${database}-shm`);
}

function overwriteCloneSourceSameInode(target, phase) {
  const beforeIdentity = fileIdentity(target);
  const beforeBytes = original.readFileSync(target);
  if (beforeBytes.length === 0) throw new Error('clone source tamper requires nonempty bytes');
  const afterBytes = Buffer.from(beforeBytes);
  const offset = Math.max(0, afterBytes.length - 17);
  afterBytes[offset] ^= 0x01;
  const descriptor = original.openSync(target, fs.constants.O_RDWR);
  try {
    let written = 0;
    while (written < afterBytes.length) {
      const count = original.writeSync(
        descriptor, afterBytes, written, afterBytes.length - written, written,
      );
      if (count <= 0) throw new Error('clone source tamper write made no progress');
      written += count;
    }
    original.fsyncSync(descriptor);
  } finally {
    original.closeSync(descriptor);
  }
  const afterIdentity = fileIdentity(target);
  if (beforeIdentity.dev !== afterIdentity.dev || beforeIdentity.ino !== afterIdentity.ino
      || beforeIdentity.size !== afterIdentity.size) {
    throw new Error('clone source tamper unexpectedly changed identity or length');
  }
  attacked = true;
  attackDetails = {
    kind: 'same-inode-clone-source-tamper',
    phase,
    target,
    beforeIdentity,
    afterIdentity,
    beforeSha256: crypto.createHash('sha256').update(beforeBytes).digest('hex'),
    afterSha256: crypto.createHash('sha256').update(afterBytes).digest('hex'),
    bytes: afterBytes.toString('base64'),
  };
}

function throwCloneWriteFault(target, descriptor) {
  const partialIdentity = fileIdentity(target);
  attackDetails = {
    kind: plan.replaceClonePartialOnFault
      ? 'clone-mid-write-replacement' : 'clone-mid-write-enospc',
    partialTarget: normalized(target),
    partialIdentity,
    partialBytes: cloneFaultWritten,
  };
  if (plan.replaceClonePartialOnFault) {
    cloneReplacementPending = { descriptor, target: normalized(target), partialIdentity };
  } else if (['root', 'state'].includes(plan.rebindCloneHierarchyOnFault)) {
    cloneHierarchyRebindPending = { descriptor, target: normalized(target), partialIdentity };
  }
  attacked = true;
  const error = new Error('injected clone destination ENOSPC');
  error.code = 'ENOSPC';
  throw error;
}

function finalizeCloneHierarchyRebind(pending) {
  return withInternalIo(() => {
  const scope = plan.rebindCloneHierarchyOnFault;
  const cloneRoot = source;
  const stateRoot = path.join(cloneRoot, 'state');
  const originalRootIdentity = directoryIdentity(cloneRoot);
  const originalStateIdentity = directoryIdentity(stateRoot);
  const held = replacementHeldPath(`clone-${scope}-rebind`);
  if (scope === 'root') {
    original.renameSync(cloneRoot, held);
    original.mkdirSync(cloneRoot, { mode: 0o700 });
    original.mkdirSync(stateRoot, { mode: 0o700 });
  } else {
    original.renameSync(stateRoot, held);
    original.mkdirSync(stateRoot, { mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    original.chmodSync(cloneRoot, 0o700);
    original.chmodSync(stateRoot, 0o700);
  }
  const replacementTarget = path.join(stateRoot, path.basename(pending.target));
  original.writeFileSync(replacementTarget, 'ATTACKER_CLONE_HIERARCHY_REPLACEMENT\n', {
    flag: 'wx', mode: 0o600,
  });
  if (process.platform !== 'win32') original.chmodSync(replacementTarget, 0o600);
  const heldPartial = scope === 'root'
    ? path.join(held, path.relative(cloneRoot, pending.target))
    : path.join(held, path.relative(stateRoot, pending.target));
  heldFile = held;
  attackDetails = {
    ...attackDetails,
    kind: `clone-${scope}-rebind-after-copy-fault`,
    scope,
    held,
    heldPartial,
    cloneRoot,
    stateRoot,
    replacementTarget,
    originalRootIdentity,
    originalStateIdentity,
    replacementRootIdentity: directoryIdentity(cloneRoot),
    replacementStateIdentity: directoryIdentity(stateRoot),
    replacementTargetIdentity: fileIdentity(replacementTarget),
    replacementBytes: original.readFileSync(replacementTarget).toString('base64'),
  };
  });
}

function finalizeCloneReplacement(pending) {
  return withInternalIo(() => {
  const held = replacementHeldPath('clone-partial');
  original.renameSync(pending.target, held);
  original.writeFileSync(pending.target, 'ATTACKER_CLONE_REPLACEMENT\n', {
    flag: 'wx', mode: 0o600,
  });
  if (process.platform !== 'win32') original.chmodSync(pending.target, 0o600);
  heldFile = held;
  attackDetails = {
    ...attackDetails,
    heldPartial: held,
    replacement: pending.target,
    replacementIdentity: fileIdentity(pending.target),
    replacementBytes: original.readFileSync(pending.target).toString('base64'),
  };
  });
}

function reparentCapturedSource() {
  const heldSource = replacementHeldPath('captured-source');
  const heldParent = replacementHeldPath('captured-parent');
  const sourceBefore = directoryIdentity(source);
  const parentBefore = directoryIdentity(transactionRoot);
  original.renameSync(source, heldSource);
  original.renameSync(transactionRoot, heldParent);
  original.mkdirSync(transactionRoot, { mode: 0o700 });
  if (process.platform !== 'win32') original.chmodSync(transactionRoot, 0o700);
  original.renameSync(heldSource, source);
  original.writeFileSync(path.join(transactionRoot, 'attacker-parent-sentinel'),
    'CAPTURED_PARENT_REBOUND\n', { flag: 'wx', mode: 0o600 });
  capturedReparent = {
    source,
    heldParent,
    sourceBefore,
    sourceAfter: directoryIdentity(source),
    parentBefore,
    parentAfter: directoryIdentity(transactionRoot),
  };
  heldFile = heldParent;
  attackDetails = { kind: 'source-parent-rebind', ...capturedReparent };
  attacked = true;
}

function maybeCountWatch(name, target) {
  if (!plan.watchPath || internalIo) return;
  const resolved = normalized(target);
  const watchedRoot = normalized(plan.watchPath);
  if (!resolved || (resolved !== watchedRoot && !resolved.startsWith(`${watchedRoot}${path.sep}`))) {
    return;
  }
  watched[name] += 1;
}

fs.existsSync = function patchedExistsSync(target) {
  maybeCountWatch('existsSync', target);
  return original.existsSync(target);
};

fs.accessSync = function patchedAccessSync(target, ...args) {
  maybeCountWatch('accessSync', target);
  return original.accessSync(target, ...args);
};

fs.lstatSync = function patchedLstatSync(target, ...args) {
  maybeCountWatch('lstatSync', target);
  return original.lstatSync(target, ...args);
};

fs.statSync = function patchedStatSync(target, ...args) {
  maybeCountWatch('statSync', target);
  return original.statSync(target, ...args);
};

fs.realpathSync = function patchedRealpathSync(target, ...args) {
  maybeCountWatch('realpathSync', target);
  return original.realpathSync(target, ...args);
};
if (originalRealpathNative) {
  fs.realpathSync.native = function patchedRealpathNative(target, ...args) {
    maybeCountWatch('realpathSync', target);
    return originalRealpathNative(target, ...args);
  };
}

fs.readFileSync = function patchedReadFileSync(target, ...args) {
  maybeCountWatch('readFileSync', target);
  return original.readFileSync(target, ...args);
};

fs.readlinkSync = function patchedReadlinkSync(target, ...args) {
  maybeCountWatch('readlinkSync', target);
  return original.readlinkSync(target, ...args);
};

fs.readSync = function patchedReadSync(descriptor, ...args) {
  maybeCountWatch('readSync', fdPaths.get(descriptor));
  return original.readSync(descriptor, ...args);
};

fs.writeSync = function patchedWriteSync(descriptor, buffer, offset, length, position) {
  const target = fdPaths.get(descriptor);
  if (!internalIo && plan.cloneWriteFaultAfterBytes && target
      && cloneDatabaseDestination(target) && Buffer.isBuffer(buffer)) {
    const remaining = plan.cloneWriteFaultAfterBytes - cloneFaultWritten;
    if (remaining <= 0) throwCloneWriteFault(target, descriptor);
    const requested = Number.isInteger(length) ? length : buffer.length - (offset || 0);
    const count = original.writeSync(
      descriptor,
      buffer,
      offset || 0,
      Math.min(requested, remaining),
      position,
    );
    cloneFaultWritten += count;
    return count;
  }
  return original.writeSync(descriptor, buffer, offset, length, position);
};

fs.openSync = function patchedOpenSync(target, flags, ...args) {
  if (internalIo) return original.openSync(target, flags, ...args);
  maybeCountWatch('openSync', target);
  const resolved = normalized(target);
  const creating = typeof flags === 'number' && (flags & fs.constants.O_CREAT) !== 0;
  const stagingLayer = creating ? publicationLayer(target, 'staging') : null;
  const finalLayer = !creating ? publicationLayer(target, 'json') : null;

  if (!internalIo && plan.pauseBeforeDeleteStaging && creating
      && samePath(target, layerFiles['delete-authority'].staging)) {
    pause({
      event: 'before-delete-staging-create',
      target: normalized(target),
      recoveryDurabilityEvents,
    });
  }

  if (!internalIo && !creating && finalLayer) {
    const pairKey = `pair:${finalLayer}`;
    const pairPrevious = lastControlOpenMutationCount.get(pairKey);
    if (!attacked && plan.attack === 'tamper-pair-before-normalize-read'
        && plan.tamperPairLayer === finalLayer
        && pairPrevious === namespaceEvents.length) {
      const files = finalLayer === 'inventory' ? layerFiles.inventory : layerFiles[finalLayer];
      if (!files?.staging || !fileExists(files.staging)) {
        throw new Error('pair tamper did not observe the staging hardlink');
      }
      attackDetails = {
        kind: 'same-inode-pair-tamper',
        layer: finalLayer,
        ...overwriteSameInode(files.final),
      };
      attacked = true;
      attackSnapshot = controlSnapshot();
    }
    lastControlOpenMutationCount.set(pairKey, namespaceEvents.length);
  }

  if (!internalIo && !creating && finalLayer === 'authority'
      && ['replace-authority-before-teardown-read',
        'tamper-authority-before-teardown-read'].includes(plan.attack)) {
    authorityReadOpens += 1;
    const teardownKey = 'teardown:authority';
    const previous = lastControlOpenMutationCount.get(teardownKey);
    if (!attacked && previous === namespaceEvents.length) {
      withInternalIo(() => {
        if (plan.attack === 'replace-authority-before-teardown-read') {
          const bytes = original.readFileSync(layerFiles.authority.final);
          const beforeIdentity = fileIdentity(layerFiles.authority.final);
          const held = replacementHeldPath('frozen-authority');
          original.renameSync(layerFiles.authority.final, held);
          original.writeFileSync(layerFiles.authority.final, bytes, { flag: 'wx', mode: 0o600 });
          if (process.platform !== 'win32') original.chmodSync(layerFiles.authority.final, 0o600);
          heldFile = held;
          attackDetails = {
            kind: 'same-bytes-identity-replacement',
            target: layerFiles.authority.final,
            held,
            beforeIdentity,
            afterIdentity: fileIdentity(layerFiles.authority.final),
            bytes: bytes.toString('base64'),
          };
        } else {
          attackDetails = {
            kind: 'same-inode-teardown-tamper',
            ...overwriteSameInode(layerFiles.authority.final),
          };
        }
      });
      attacked = true;
      attackSnapshot = controlSnapshot();
    }
    lastControlOpenMutationCount.set(teardownKey, namespaceEvents.length);
  }

  const descriptor = original.openSync(target, flags, ...args);
  if (resolved) fdPaths.set(descriptor, resolved);
  if (!internalIo && resolved && cloneDatabaseSource(resolved) && !creating) {
    cloneSourceOpenCount += 1;
    cloneSourceDescriptors.set(descriptor, cloneSourceOpenCount);
  }
  if (!internalIo && stagingLayer) {
    recordNamespace(stagingLayer, 'create-staging', target);
  }
  if (!internalIo && creating) recordCloneNamespace('open-create', target);
  return descriptor;
};

fs.closeSync = function patchedCloseSync(descriptor) {
  if (internalIo) return original.closeSync(descriptor);
  const descriptorPath = fdPaths.get(descriptor);
  const cloneSourceSequence = cloneSourceDescriptors.get(descriptor);
  try {
    return original.closeSync(descriptor);
  } finally {
    if (!attacked && plan.tamperCloneSourceOnCloseNumber
        && cloneSourceSequence === plan.tamperCloneSourceOnCloseNumber
        && descriptorPath && cloneDatabaseSource(descriptorPath)) {
      overwriteCloneSourceSameInode(
        descriptorPath, `source-close-${cloneSourceSequence}`,
      );
    }
    if (cloneHierarchyRebindPending?.descriptor === descriptor
        && descriptorPath === cloneHierarchyRebindPending.target) {
      const pending = cloneHierarchyRebindPending;
      cloneHierarchyRebindPending = null;
      finalizeCloneHierarchyRebind(pending);
    } else if (cloneReplacementPending?.descriptor === descriptor
        && descriptorPath === cloneReplacementPending.target) {
      const pending = cloneReplacementPending;
      cloneReplacementPending = null;
      finalizeCloneReplacement(pending);
    }
    fdPaths.delete(descriptor);
    cloneSourceDescriptors.delete(descriptor);
  }
};

fs.writeFileSync = function patchedWriteFileSync(target, data, ...args) {
  const descriptorPath = typeof target === 'number' ? fdPaths.get(target) : normalized(target);
  const requestedPartial = plan.partialPublication
    ?? (plan.partialInventoryBytes
      ? { layer: 'inventory', bytes: plan.partialInventoryBytes } : null);
  const partialLayer = descriptorPath ? publicationLayer(descriptorPath, 'staging') : null;
  if (!internalIo && requestedPartial && partialLayer === requestedPartial.layer) {
    const bytes = Buffer.from(data);
    const count = Math.min(requestedPartial.bytes, bytes.length - 1);
    original.writeFileSync(target, bytes.subarray(0, count), ...args);
    original.fsyncSync(target);
    const directoryDescriptor = original.openSync(path.dirname(descriptorPath), 'r');
    try { original.fsyncSync(directoryDescriptor); } finally { original.closeSync(directoryDescriptor); }
    pause({
      event: 'partial-publication-durable',
      layer: partialLayer,
      bytes: count,
      stagingPath: descriptorPath,
      filenameAnchor: discoverInventoryFiles().anchor,
      fullCanonicalSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      namespaceEvents,
    });
  }
  return original.writeFileSync(target, data, ...args);
};

fs.readdirSync = function patchedReaddirSync(target, ...args) {
  maybeCountWatch('readdirSync', target);
  const result = original.readdirSync(target, ...args);
  const resolved = normalized(target);
  if (!internalIo && resolved) {
    const names = Array.isArray(result) ? result.map((entry) => (
      typeof entry === 'string' || Buffer.isBuffer(entry) ? String(entry) : entry.name
    )) : [];
    if (samePath(resolved, transactionsRoot)
        || path.dirname(resolved) === normalized(transactionsRoot)) {
      batchReaddirNamesEnumerated += names.length;
    }
    if (plan.auditArtifactEnumeration
        && path.dirname(resolved) === normalized(transactionsRoot)) {
      const count = names.filter((name) => name.startsWith('cron-worker-cleanup-')).length;
      cleanupNamesEnumerated += count;
      transactionReaddirCleanupNames += count;
    }
    if (resolved === normalized(source)
        || resolved.startsWith(`${normalized(source)}${path.sep}`)) {
      sourceReaddirNamesEnumerated += names.length;
    }
  }
  return result;
};

fs.opendirSync = function patchedOpendirSync(target, ...args) {
  maybeCountWatch('opendirSync', target);
  const result = original.opendirSync(target, ...args);
  const resolved = normalized(target);
  if (internalIo || !resolved) return result;
  const isBatchRoot = samePath(resolved, transactionsRoot);
  const isTransactionChild = path.dirname(resolved) === normalized(transactionsRoot);
  const isSourceDirectory = resolved === normalized(source)
    || resolved.startsWith(`${normalized(source)}${path.sep}`);
  let fullyRead = false;
  let closed = false;
  return {
    readSync() {
      const entry = result.readSync();
      if (entry === null) {
        fullyRead = true;
        return null;
      }
      if (isBatchRoot || isTransactionChild) batchTopLevelNamesEnumerated += 1;
      if (isTransactionChild && plan.auditArtifactEnumeration
          && entry.name.startsWith('cron-worker-cleanup-')) {
        cleanupNamesEnumerated += 1;
      }
      if (isSourceDirectory) sourceNamesEnumerated += 1;
      return entry;
    },
    closeSync() {
      if (closed) return undefined;
      const closeResult = result.closeSync();
      closed = true;
      if (isBatchRoot) {
        if (fullyRead) scanGeneration += 1;
        scanCloseEvents.push({
          generation: scanGeneration,
          fullyRead,
          incremented: fullyRead,
        });
      }
      return closeResult;
    },
  };
};

fs.linkSync = function patchedLinkSync(existing, target) {
  const result = original.linkSync(existing, target);
  if (!internalIo) {
    const layer = publicationLayer(existing, 'staging');
    if (layer && publicationLayer(target, 'json') === layer) {
      recordNamespace(layer, 'link-final', target);
      linkFsyncPending = { layer, parent: path.dirname(target) };
    }
  }
  return result;
};

fs.unlinkSync = function patchedUnlinkSync(target) {
  const stagingLayer = publicationLayer(target, 'staging');
  const finalLayer = publicationLayer(target, 'json');
  const beforeBytes = finalLayer && fileExists(target) ? original.readFileSync(target) : null;
  const beforeTeardown = finalLayer && plan.pauseTeardownAfter === finalLayer
    ? controlSnapshot() : null;
  const result = original.unlinkSync(target);
  if (internalIo) return result;

  if (stagingLayer) {
    recordNamespace(stagingLayer, 'unlink-staging', target);
    unlinkFsyncPending = { layer: stagingLayer, parent: path.dirname(target) };
    if (plan.observePartialRepair && stagingLayer === 'inventory') {
      partialRepairObserved = true;
      const staging = normalized(target);
      const final = staging ? staging.replace(/\.staging$/, '.json') : null;
      pause({
        event: 'partial-inventory-old-anchor-unlinked',
        anchors: {
          final: fileExists(final),
          staging: fileExists(staging),
        },
        namespaceEvents,
      });
    }
  }
  if (finalLayer === 'intent') {
    recordNamespace('intent', 'unlink-final', target);
  } else if (finalLayer) {
    recordNamespace(finalLayer, 'unlink-final', target);
  } else {
    const resolved = normalized(target);
    if (resolved && resolved.includes(`${path.sep}payload${path.sep}`)) {
      recordNamespace('payload', 'unlink-entry', target);
    }
  }

  if (finalLayer && plan.attack === 'recreate-authority-after-unlink'
      && finalLayer === 'authority' && !attacked) {
    original.writeFileSync(target, beforeBytes, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') original.chmodSync(target, 0o600);
    attacked = true;
    attackSnapshot = controlSnapshot();
  }
  if (finalLayer && plan.pauseTeardownAfter === finalLayer) {
    teardownFsyncPending = {
      layer: finalLayer,
      parent: path.dirname(target),
      before: beforeTeardown,
      frozen: controlSnapshot(),
    };
  }
  const resolvedTarget = normalized(target);
  if (plan.pauseAfterEntryDeleteBeforeFsync && resolvedTarget
      && resolvedTarget.includes(`${path.sep}payload${path.sep}`)) {
    pause({
      event: 'after-entry-delete-before-fsync',
      target: resolvedTarget,
      parent: path.dirname(resolvedTarget),
      targetPresent: fileExists(resolvedTarget),
    });
  }
  return result;
};

fs.renameSync = function patchedRenameSync(from, to) {
  const result = original.renameSync(from, to);
  if (!internalIo) recordCloneNamespace('rename-destination', to);
  if (!internalIo && samePath(from, source)
      && path.basename(String(to)) === 'payload'
      && path.dirname(normalized(to)).startsWith(normalized(quarantineRoot))) {
    recordNamespace('payload', 'rename-source-to-payload', to);
    renameArmed = true;
    renameEvents.push('rename');
    if (plan.renameCut === 1) {
      pause({ event: 'rename-cut-1', eventPrefix: [...renameEvents] });
    }
  }
  return result;
};

fs.fsyncSync = function patchedFsyncSync(descriptor) {
  const result = original.fsyncSync(descriptor);
  if (internalIo) return result;
  const descriptorPath = fdPaths.get(descriptor);
  if (!descriptorPath) return result;

  const stagingLayer = publicationLayer(descriptorPath, 'staging');
  if (stagingLayer) stagingFsyncPending = { layer: stagingLayer, parent: path.dirname(descriptorPath) };

  if (renameArmed && samePath(descriptorPath, path.dirname(source))) {
    renameEvents.push('source-parent-fsync');
    if (plan.renameCut === 3) {
      pause({ event: 'rename-cut-3', eventPrefix: [...renameEvents] });
    }
  }
  if (renameArmed && descriptorPath.startsWith(normalized(quarantineRoot))
      && path.basename(descriptorPath).startsWith('.cleanup-')) {
    renameEvents.push('destination-container-fsync');
    if (plan.renameCut === 2) {
      pause({ event: 'rename-cut-2', eventPrefix: [...renameEvents] });
    }
  }

  if (plan.auditRecoveryBeforeDelete) {
    let container = null;
    try {
      const reservation = JSON.parse(original.readFileSync(layerFiles.reservation.final, 'utf8'));
      container = path.join(quarantineRoot, reservation.container);
    } catch {}
    if (container && samePath(descriptorPath, container)) {
      recoveryDurabilityEvents.push('destination-container-fsync');
    } else if (samePath(descriptorPath, transactionRoot)) {
      recoveryDurabilityEvents.push('source-parent-fsync');
    }
  }

  if (stagingFsyncPending && samePath(descriptorPath, stagingFsyncPending.parent)) {
    const pending = stagingFsyncPending;
    stagingFsyncPending = null;
    if (plan.pausePublication?.stage === 'created-durable'
        && plan.pausePublication.layer === pending.layer) {
      pause({
        event: 'publication-created-durable', layer: pending.layer, namespaceEvents,
      });
    }
  }
  if (linkFsyncPending && samePath(descriptorPath, linkFsyncPending.parent)) {
    const pending = linkFsyncPending;
    linkFsyncPending = null;
    if (plan.pausePublication?.stage === 'linked-durable'
        && plan.pausePublication.layer === pending.layer) {
      pause({
        event: 'publication-linked-durable', layer: pending.layer, namespaceEvents,
      });
    }
  }
  if (unlinkFsyncPending && samePath(descriptorPath, unlinkFsyncPending.parent)) {
    const pending = unlinkFsyncPending;
    unlinkFsyncPending = null;
    if (plan.pausePublication?.stage === 'normalized-durable'
        && plan.pausePublication.layer === pending.layer) {
      pause({
        event: 'publication-normalized-durable', layer: pending.layer, namespaceEvents,
      });
    }
  }
  if (teardownFsyncPending && samePath(descriptorPath, teardownFsyncPending.parent)) {
    const pending = teardownFsyncPending;
    teardownFsyncPending = null;
    pause({
      event: 'teardown-unlink-durable',
      layer: pending.layer,
      before: pending.before,
      frozen: pending.frozen,
    });
  }
  return result;
};

fs.mkdirSync = function patchedMkdirSync(target, options) {
  const result = original.mkdirSync(target, options);
  if (!internalIo) recordCloneNamespace('mkdir', target);
  if (!internalIo && samePath(target, quarantineRoot)) {
    recordNamespace('quarantine-root', 'mkdir-quarantine-root', target);
  } else if (!internalIo && normalized(target)
      && path.dirname(normalized(target)) === normalized(quarantineRoot)
      && path.basename(normalized(target)).startsWith('.cleanup-')) {
    recordNamespace('container', 'mkdir-container', target);
  }
  if (!internalIo && plan.attack === 'rebind-clone-root-after-state-mkdir'
      && epoch === null && !attacked && samePath(target, path.join(source, 'state'))) {
    rebindCloneRootAfterStateMkdir();
  }
  if (!internalIo && plan.attack === 'tamper-clone-source-after-plan'
      && epoch === null && !attacked && samePath(target, source)) {
    overwriteCloneSourceSameInode(
      path.join(paths.stateDir, 'state/openclaw.sqlite'), 'after-plan-before-copy',
    );
  }
  return result;
};

fs.rmdirSync = function patchedRmdirSync(target, ...args) {
  const result = original.rmdirSync(target, ...args);
  if (!internalIo) {
    const resolved = normalized(target);
    if (resolved && path.dirname(resolved) === normalized(quarantineRoot)
        && path.basename(resolved).startsWith('.cleanup-')) {
      recordNamespace('container', 'rmdir-container', target);
    } else if (resolved && (path.basename(resolved) === 'payload'
        || resolved.includes(`${path.sep}payload${path.sep}`))) {
      recordNamespace('payload', 'rmdir-entry', target);
    }
  }
  return result;
};

fs.copyFileSync = function patchedCopyFileSync(from, to, mode) {
  if (!internalIo && plan.cloneWriteFaultAfterBytes && cloneDatabaseDestination(to)) {
    const sourceDescriptor = original.openSync(from, fs.constants.O_RDONLY);
    const destinationDescriptor = original.openSync(
      to,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fdPaths.set(destinationDescriptor, normalized(to));
    recordCloneNamespace('copy-create', to);
    const buffer = Buffer.alloc(64 * 1024);
    try {
      let position = 0;
      for (;;) {
        const count = original.readSync(sourceDescriptor, buffer, 0, buffer.length, position);
        if (count === 0) break;
        let offset = 0;
        while (offset < count) {
          const written = fs.writeSync(
            destinationDescriptor, buffer, offset, count - offset, position + offset,
          );
          if (written <= 0) throw new Error('test clone copy made no progress');
          offset += written;
        }
        position += count;
      }
    } finally {
      original.closeSync(sourceDescriptor);
      fs.closeSync(destinationDescriptor);
    }
    return;
  }
  const result = original.copyFileSync(from, to, mode);
  if (!internalIo) recordCloneNamespace('copy-create', to);
  return result;
};

childProcess.spawn = function patchedSpawn(...args) {
  if (plan.attack === 'reparent-clone-after-capture' && !attacked) {
    reparentCapturedSource();
  }
  return originalSpawn(...args);
};

function populateScratch(context) {
  const writeMember = (directory, name, bytes = plan.populateBytes || 0) => {
    original.writeFileSync(
      path.join(directory, name),
      bytes ? Buffer.alloc(bytes, 0x61) : Buffer.alloc(0),
      { flag: 'wx', mode: 0o600 },
    );
    populatedFiles += 1;
    populatedBytes += bytes;
  };
  if (plan.reviewerCounterexample701) {
    for (let index = 0; index < 350; index += 1) {
      writeMember(context.home, `review-root-${String(index).padStart(3, '0')}.bin`, 0);
    }
    for (let index = 0; index < 349; index += 1) {
      writeMember(context.tmp, `review-child-${String(index).padStart(3, '0')}.bin`, 0);
    }
  }
  for (let index = 0; index < (plan.populateSourceNames || 0); index += 1) {
    writeMember(context.home, `stream-${String(index).padStart(5, '0')}.bin`, 0);
  }
  for (let index = 0; index < (plan.populateFiles || 0); index += 1) {
    writeMember(
      context.home,
      `projected-${String(index).padStart(4, '0')}.bin`,
      plan.populateBytes || 0,
    );
  }
}

function onCleanupPhase(phase, context) {
  if (phase === 'created') populateScratch(context);
  if (!attacked && plan.injectUnknownAtPhase === phase) {
    const unknown = path.join(
      transactionRoot,
      `cron-worker-cleanup-unknown-${crypto.randomUUID()}.json`,
    );
    original.writeFileSync(unknown, '{}\n', { flag: 'wx', mode: 0o600 });
    attacked = true;
    attackDetails = { kind: 'unknown-q-artifact', phase, unknown };
    attackSnapshot = controlSnapshot();
  }
  if (!attacked && plan.attack === 'inject-unknown-sibling-before-entry-delete'
      && phase === 'before-entry-delete' && context.relative !== '') {
    const unknown = path.join(context.parent, 'attacker-unknown-sibling');
    original.writeFileSync(unknown, 'ATTACKER_UNKNOWN_SIBLING\n', {
      flag: 'wx', mode: 0o600,
    });
    attacked = true;
    attackDetails = {
      kind: 'unknown-payload-sibling',
      unknown,
      target: context.target,
      parent: context.parent,
      relative: context.relative,
      targetIdentity: fileIdentity(context.target),
    };
  }
}

async function run() {
  const applier = require(applierFile);
  try {
    if (!applier.__testing) throw new Error('missing test API');
    if (plan.action === 'cleanup' || plan.action === 'audit-cleanup') {
      applier.__testing.runCronScratchCleanupProbe(paths, txId, epoch, onCleanupPhase);
    } else if (plan.action === 'recover') {
      await applier.recoverProfiles(paths);
    } else if (plan.action === 'status') {
      await applier.profileStatus(paths);
    } else if (plan.action === 'create') {
      applier.__testing.createCronWorkerScratchProbe(paths, txId, epoch);
    } else if (plan.action === 'clone') {
      await applier.__testing.inspectCronState(paths, txId);
    } else if (plan.action === 'apply') {
      await applier.applyProfile({ ...paths, txId });
    } else if (plan.action === 'rollback') {
      await applier.rollbackProfile({ ...paths, txId });
    } else {
      throw new Error(`unsupported action: ${plan.action}`);
    }
    writeReady({
      event: 'completed',
      result: { ok: true },
      attacked,
      attackSnapshot,
      attackDetails,
      heldFile,
      partialRepairObserved,
      namespaceEvents,
      cloneNamespaceEvents,
      cloneSourceOpenCount,
      scanCloseEvents,
      scanGeneration,
      renameEvents,
      recoveryDurabilityEvents,
      populatedFiles,
      populatedBytes,
      capturedReparent,
      cleanupNamesEnumerated,
      transactionReaddirCleanupNames,
      batchTopLevelNamesEnumerated,
      batchReaddirNamesEnumerated,
      sourceNamesEnumerated,
      sourceReaddirNamesEnumerated,
      watchCounts: watched,
    });
  } catch (error) {
    writeReady({
      event: 'completed',
      result: { ok: false, code: error && error.code, name: error && error.name },
      attacked,
      attackSnapshot,
      attackDetails,
      heldFile,
      partialRepairObserved,
      namespaceEvents,
      cloneNamespaceEvents,
      cloneSourceOpenCount,
      scanCloseEvents,
      scanGeneration,
      renameEvents,
      recoveryDurabilityEvents,
      populatedFiles,
      populatedBytes,
      capturedReparent,
      cleanupNamesEnumerated,
      transactionReaddirCleanupNames,
      batchTopLevelNamesEnumerated,
      batchReaddirNamesEnumerated,
      sourceNamesEnumerated,
      sourceReaddirNamesEnumerated,
      watchCounts: watched,
    });
  }
}

run().catch((error) => {
  writeReady({
    event: 'runner-failed',
    result: { ok: false, code: error && error.code, name: error && error.name },
    attacked,
    attackSnapshot,
    attackDetails,
    heldFile,
    namespaceEvents,
    cloneNamespaceEvents,
    cloneSourceOpenCount,
    scanCloseEvents,
    scanGeneration,
    renameEvents,
    recoveryDurabilityEvents,
    populatedFiles,
    populatedBytes,
    capturedReparent,
    cleanupNamesEnumerated,
    transactionReaddirCleanupNames,
    batchTopLevelNamesEnumerated,
    batchReaddirNamesEnumerated,
    sourceNamesEnumerated,
    sourceReaddirNamesEnumerated,
    watchCounts: watched,
  });
  process.exitCode = 1;
});
