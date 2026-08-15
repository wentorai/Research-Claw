'use strict';

const path = require('node:path');
const applier = require('./applier.cjs');
const { ensureInitialized } = require('./maintenance-lease.cjs');
const { MAX_CAPSULE_BYTES } = require('./schema.cjs');
const { readPrivateFile } = require('./storage.cjs');

const PATH_FLAGS = {
  '--rc-root': 'rcRoot',
  '--config': 'configPath',
  '--workspace': 'workspace',
  '--state-dir': 'stateDir',
  '--db': 'dbPath',
  '--global-config': 'globalConfigPath',
};
const COMMANDS = new Set([
  'initialize-locks', 'stage', 'apply', 'verify', 'commit', 'rollback', 'recover', 'status',
  'restore-peripherals',
]);

function fail(code = 'INVALID_ARGUMENTS') {
  const error = new Error('Bootstrap Profile CLI failed');
  error.code = code;
  throw error;
}

function parseArguments(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) fail();
  const options = {};
  let capsuleFile;
  let txId;
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.includes('\0')) fail();
    if (PATH_FLAGS[flag]) {
      if (!path.isAbsolute(value) || options[PATH_FLAGS[flag]] !== undefined) fail();
      options[PATH_FLAGS[flag]] = value;
    } else if (flag === '--tx-id') {
      if (txId !== undefined) fail();
      txId = value;
    } else if (flag === '--capsule-file') {
      if (capsuleFile !== undefined || !path.isAbsolute(value)) fail();
      capsuleFile = value;
    } else fail();
  }
  for (const key of Object.values(PATH_FLAGS)) {
    if (options[key] === undefined) fail();
  }
  if (['apply', 'verify', 'commit', 'rollback'].includes(command) && !txId) fail();
  if (command === 'stage' && txId) fail();
  if (command !== 'stage' && capsuleFile) fail();
  return { command, options, txId, capsuleFile };
}

async function readStdinBounded() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_CAPSULE_BYTES) fail('CAPSULE_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function readFileBounded(file) {
  try {
    return readPrivateFile(file, { maxBytes: MAX_CAPSULE_BYTES, exactMode: 0o600 });
  } catch {
    fail('INVALID_CAPSULE_FILE');
  }
}

async function main(argv) {
  const parsed = parseArguments(argv);
  let result;
  if (parsed.command === 'initialize-locks') {
    const initialized = ensureInitialized({
      rcRoot: parsed.options.rcRoot,
      configPath: parsed.options.configPath,
      // This command is an ABI primitive for T06. The installer may invoke it
      // only after its legacy/native/container stop proof has succeeded.
      externalStopVerified: true,
    });
    result = { state: 'initialized', created: initialized.created };
  } else if (parsed.command === 'stage') {
    const capsuleBytes = parsed.capsuleFile
      ? readFileBounded(parsed.capsuleFile)
      : await readStdinBounded();
    result = await applier.stageProfile({
      ...parsed.options, capsuleBytes, rcVersion: '0.8.3',
    });
  } else if (parsed.command === 'apply') {
    result = await applier.applyProfile({ ...parsed.options, txId: parsed.txId });
  } else if (parsed.command === 'verify') {
    result = await applier.verifyProfile({ ...parsed.options, txId: parsed.txId });
  } else if (parsed.command === 'commit') {
    result = await applier.commitProfile({ ...parsed.options, txId: parsed.txId });
  } else if (parsed.command === 'rollback') {
    result = await applier.rollbackProfile({ ...parsed.options, txId: parsed.txId });
  } else if (parsed.command === 'recover') {
    result = await applier.recoverProfiles(parsed.options);
  } else if (parsed.command === 'status') {
    result = await applier.profileStatus(parsed.options);
  } else if (parsed.command === 'restore-peripherals') {
    result = await applier.restorePeripherals(parsed.options);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

module.exports = { main };
