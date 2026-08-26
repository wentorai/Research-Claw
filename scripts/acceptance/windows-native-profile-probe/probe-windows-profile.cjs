#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_OUTPUT = 4 * 1024 * 1024;
const CANDIDATE_MAINTENANCE_SHA256 = '0f3c4f21d9a99f09025a65b3d2d4d052ed7dd3817ca995667a33b8c7345380ca';
const CANDIDATE_STORAGE_SHA256 = '4a7d5b7bd201547564c74c20721594a40634403d4cad4f838224d70a9b0e25bb';
const LIVE_OPERATIONS = new Set(['status']);
const ISOLATED_OPERATIONS = new Set([
  'initialize-locks', 'recover', 'stage', 'apply', 'verify', 'rollback',
]);
const SECRET_PATTERNS = [
  /(^|[^A-Za-z0-9_-])rca_[A-Za-z0-9_-]{43,}/g,
  /(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bAuthorization\s*:\s*Bearer\s+\S+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function usage() {
  return [
    'Usage:',
    '  node probe-windows-profile.cjs [--rc-root <dir>] [--output-dir <dir>] [--candidate-root <dir>]',
    '  node probe-windows-profile.cjs --worker <payload.json>',
    '  node probe-windows-profile.cjs --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    rcRoot: path.join(os.homedir(), 'research-claw'),
    outputDir: path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Wentor', 'ProbeReports'),
    candidateRoot: path.join(__dirname, 'candidate'),
    worker: null,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length || !argv[index]) throw new Error(`Missing value for ${argument}`);
      return argv[index];
    };
    if (argument === '--rc-root') options.rcRoot = path.resolve(value());
    else if (argument === '--output-dir') options.outputDir = path.resolve(value());
    else if (argument === '--candidate-root') options.candidateRoot = path.resolve(value());
    else if (argument === '--worker') options.worker = path.resolve(value());
    else if (argument === '--self-test') options.selfTest = true;
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function containsSecret(value) {
  const text = String(value);
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function redact(value) {
  let text = String(value ?? '');
  text = text.replace(/\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[credentials]@');
  text = text.replace(/(^|[^A-Za-z0-9_-])rca_[A-Za-z0-9_-]{43,}/g, '$1[SETUP_TOKEN_REDACTED]');
  text = text.replace(/(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '$1[MODEL_KEY_REDACTED]');
  text = text.replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: [REDACTED]');
  text = text.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    '[PRIVATE_KEY_REDACTED]',
  );
  return text;
}

function safeEnvironment(overrides = {}) {
  const result = {};
  let removed = 0;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && containsSecret(value)) {
      removed += 1;
      continue;
    }
    result[key] = value;
  }
  Object.assign(result, overrides);
  result.GIT_TERMINAL_PROMPT = '0';
  result.GCM_INTERACTIVE = 'Never';
  result.GIT_ASKPASS = '';
  result.SSH_ASKPASS = '';
  return { env: result, removed };
}

function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: MAX_OUTPUT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0 && !result.error,
    status: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    errorCode: result.error?.code ?? null,
  };
}

function lstatValue(target) {
  try {
    const metadata = fs.lstatSync(target);
    return {
      exists: true,
      type: metadata.isSymbolicLink() ? 'symlink'
        : metadata.isDirectory() ? 'directory'
          : metadata.isFile() ? 'file' : 'other',
      size: metadata.size,
      mtimeMs: Math.trunc(metadata.mtimeMs),
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      nlink: metadata.nlink,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    return { exists: null, errorCode: safeCode(error?.code, 'LSTAT_FAILED') };
  }
}

function safeCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z0-9_]+$/u.test(value) ? value : fallback;
}

function classifyErrorPath(value, paths) {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const absolute = path.resolve(value);
  const candidates = [
    ['project-config', paths.configPath],
    ['global-config', paths.globalConfigPath],
    ['workspace', paths.workspace],
    ['state', paths.stateDir],
    ['database', paths.dbPath],
    ['capsule', paths.capsuleFile],
    ['rc-root', paths.rcRoot],
  ];
  for (const [label, candidate] of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (absolute === resolved || absolute.startsWith(`${resolved}${path.sep}`)) return label;
  }
  return 'outside-declared-roots';
}

function safeErrorDetails(error, payload) {
  const sourceFrames = [];
  for (const line of String(error?.stack ?? '').split(/\r?\n/u)) {
    const match = line.match(/[\\/](applier|maintenance-lease)\.cjs:(\d+):(\d+)\)?$/u);
    if (!match) continue;
    sourceFrames.push({ module: match[1], line: Number(match[2]) });
    if (sourceFrames.length === 3) break;
  }
  return {
    code: safeCode(error?.code, 'UNCLASSIFIED_ERROR'),
    errno: Number.isInteger(error?.errno) ? error.errno : null,
    syscall: typeof error?.syscall === 'string' && /^[A-Za-z0-9_-]+$/u.test(error.syscall)
      ? error.syscall : null,
    pathClass: classifyErrorPath(error?.path, payload.paths),
    destClass: classifyErrorPath(error?.dest, payload.paths),
    constructor: typeof error?.constructor?.name === 'string'
      && /^[A-Za-z0-9_]+$/u.test(error.constructor.name)
      ? error.constructor.name : 'Error',
    sourceFrames,
  };
}

function validateWorkerPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid worker payload');
  }
  const allowed = payload.scope === 'live' ? LIVE_OPERATIONS : ISOLATED_OPERATIONS;
  if (!allowed.has(payload.operation)) throw new Error('worker operation is not allowed for its scope');
  if (typeof payload.candidateRoot !== 'string' || !path.isAbsolute(payload.candidateRoot)) {
    throw new Error('invalid candidate root');
  }
  const required = ['rcRoot', 'configPath', 'workspace', 'stateDir', 'dbPath', 'globalConfigPath'];
  for (const key of required) {
    if (typeof payload.paths?.[key] !== 'string' || !path.isAbsolute(payload.paths[key])) {
      throw new Error(`invalid worker path: ${key}`);
    }
  }
  if (payload.operation === 'stage'
      && (typeof payload.paths.capsuleFile !== 'string' || !path.isAbsolute(payload.paths.capsuleFile))) {
    throw new Error('invalid capsule path');
  }
  if (['apply', 'verify', 'rollback'].includes(payload.operation)
      && (typeof payload.txId !== 'string' || !/^tx-[0-9a-f-]{36}$/u.test(payload.txId))) {
    throw new Error('invalid transaction id');
  }
}

function loadCandidateMaintenance(payload) {
  const candidateMaintenance = path.join(payload.candidateRoot, 'maintenance-lease.cjs');
  const candidateStorage = path.join(payload.candidateRoot, 'storage.cjs');
  if (sha256(fs.readFileSync(candidateMaintenance)) !== CANDIDATE_MAINTENANCE_SHA256
      || sha256(fs.readFileSync(candidateStorage)) !== CANDIDATE_STORAGE_SHA256) {
    const error = new Error('candidate source hash mismatch');
    error.code = 'CANDIDATE_SOURCE_MISMATCH';
    throw error;
  }
  const installedMaintenance = path.join(
    payload.paths.rcRoot,
    'scripts',
    'bootstrap-profile',
    'maintenance-lease.cjs',
  );
  const candidateModuleId = require.resolve(candidateMaintenance);
  delete require.cache[candidateModuleId];
  const lease = require(candidateModuleId);
  const candidateModule = require.cache[candidateModuleId];
  require.cache[installedMaintenance] = {
    ...candidateModule,
    id: installedMaintenance,
    filename: installedMaintenance,
    exports: lease,
  };
  return lease;
}

async function workerMain(payloadFile) {
  const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
  validateWorkerPayload(payload);
  try {
    const lease = loadCandidateMaintenance(payload);
    const applier = require(path.join(
      payload.paths.rcRoot,
      'scripts',
      'bootstrap-profile',
      'applier.cjs',
    ));
    const storage = require(path.join(
      payload.paths.rcRoot,
      'scripts',
      'bootstrap-profile',
      'storage.cjs',
    ));
    const options = {
      rcRoot: payload.paths.rcRoot,
      configPath: payload.paths.configPath,
      workspace: payload.paths.workspace,
      stateDir: payload.paths.stateDir,
      dbPath: payload.paths.dbPath,
      globalConfigPath: payload.paths.globalConfigPath,
    };
    let result;
    if (payload.operation === 'initialize-locks') {
      const value = lease.ensureInitialized({
        rcRoot: options.rcRoot,
        configPath: options.configPath,
        externalStopVerified: true,
      });
      result = { created: value.created === true };
    } else if (payload.operation === 'recover') {
      const value = await applier.recoverProfiles(options);
      result = { recoveredCount: Array.isArray(value?.recovered) ? value.recovered.length : null };
    } else if (payload.operation === 'stage') {
      const bytes = storage.readPrivateFile(payload.paths.capsuleFile, {
        maxBytes: 2 * 1024 * 1024,
        exactMode: 0o600,
      });
      const value = await applier.stageProfile({ ...options, capsuleBytes: bytes, rcVersion: '0.8.3' });
      result = { txId: value.txId, state: value.state ?? 'staged' };
    } else if (payload.operation === 'apply') {
      const value = await applier.applyProfile({ ...options, txId: payload.txId });
      result = { state: value?.state ?? 'applied', noop: value?.noop === true };
    } else if (payload.operation === 'verify') {
      await applier.verifyProfile({ ...options, txId: payload.txId });
      result = { verified: true };
    } else if (payload.operation === 'rollback') {
      const value = await applier.rollbackProfile({ ...options, txId: payload.txId });
      result = { state: value?.state ?? 'rolled-back' };
    } else if (payload.operation === 'status') {
      const value = await applier.profileStatus(options);
      result = {
        profilePresent: Boolean(value?.profile),
        pendingPresent: Boolean(value?.pendingTransaction),
        pendingState: typeof value?.pendingTransaction?.state === 'string'
          ? value.pendingTransaction.state : null,
        commitCertificatePresent: Boolean(value?.commitCertificate),
      };
    }
    process.stdout.write(`${JSON.stringify({ ok: true, phase: payload.operation, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      phase: payload.operation,
      error: safeErrorDetails(error, payload),
    })}\n`);
    process.exitCode = 1;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function recursiveDigest(root, excludedRelativeRoots = []) {
  const hash = crypto.createHash('sha256');
  const excluded = new Set(excludedRelativeRoots);
  let entries = 0;
  let bytes = 0;
  const visit = (target, relative = '') => {
    if (relative && excluded.has(relative)) return;
    const metadata = fs.lstatSync(target);
    if (metadata.isSymbolicLink()) throw new Error('isolated tree contains a symlink');
    if (relative) {
      hash.update(`${relative}\0${metadata.isDirectory() ? 'd' : metadata.isFile() ? 'f' : 'o'}\0`);
      entries += 1;
    }
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) {
        visit(path.join(target, name), relative ? `${relative}/${name}` : name);
      }
    } else if (metadata.isFile()) {
      const content = fs.readFileSync(target);
      bytes += content.length;
      hash.update(content);
    } else throw new Error('isolated tree contains a non-file entry');
  };
  try {
    visit(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    hash.update('absent\0');
    return { sha256: hash.digest('hex'), entries: 0, bytes: 0, absent: true };
  }
  return { sha256: hash.digest('hex'), entries, bytes, absent: false };
}

function transactionSurfaceDigest(paths) {
  const surfaces = [
    ['project-config', paths.configPath, []],
    ['profile-receipt', path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'receipt.json'), []],
    [
      'peripheral-suspensions',
      path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'peripheral-suspensions.json'),
      [],
    ],
    ['workspace', paths.workspace, ['.rc-bootstrap-transactions']],
    ['state', paths.stateDir, ['.rc-bootstrap-transactions']],
    ['data', path.dirname(paths.dbPath), ['.rc-bootstrap-transactions']],
    ['capsule-fixture', paths.capsuleFile, []],
  ];
  const hash = crypto.createHash('sha256');
  let entries = 0;
  let bytes = 0;
  for (const [label, target, excluded] of surfaces) {
    const digest = recursiveDigest(target, excluded);
    hash.update(`${label}\0${digest.sha256}\0${digest.entries}\0${digest.bytes}\0`);
    entries += digest.entries;
    bytes += digest.bytes;
  }
  return {
    sha256: hash.digest('hex'),
    entries,
    bytes,
    surfaces: surfaces.map(([label]) => label),
    excludedControlRoots: ['workspace', 'state', 'data'].map(
      (label) => `${label}/.rc-bootstrap-transactions`,
    ),
  };
}

function transactionControlState(paths) {
  const configRoot = path.dirname(paths.configPath);
  const roots = [
    ['config-transactions', path.join(configRoot, '.rc-bootstrap', 'transactions')],
    [
      'config-cron-cleanup-quarantine',
      path.join(configRoot, '.rc-bootstrap', 'cron-worker-cleanup-quarantine'),
    ],
    ['workspace-transactions', path.join(paths.workspace, '.rc-bootstrap-transactions')],
    ['state-transactions', path.join(paths.stateDir, '.rc-bootstrap-transactions')],
    ['data-transactions', path.join(path.dirname(paths.dbPath), '.rc-bootstrap-transactions')],
  ];
  const states = roots.map(([label, target]) => {
    let metadata;
    try {
      metadata = fs.lstatSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return { label, state: 'absent', entries: 0 };
      return { label, state: 'unreadable', entries: null };
    }
    if (metadata.isSymbolicLink()) return { label, state: 'symlink', entries: null };
    if (!metadata.isDirectory()) return { label, state: 'not-directory', entries: null };
    try {
      const entries = fs.readdirSync(target).length;
      return { label, state: entries === 0 ? 'empty-directory' : 'nonempty-directory', entries };
    } catch {
      return { label, state: 'unreadable', entries: null };
    }
  });
  return {
    clean: states.every(({ state }) => state === 'absent' || state === 'empty-directory'),
    roots: states,
  };
}

function liveMetadata(paths) {
  const transactionRoot = path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'transactions');
  let transactionCount = null;
  try {
    transactionCount = fs.existsSync(transactionRoot) ? fs.readdirSync(transactionRoot).length : 0;
  } catch {
    transactionCount = null;
  }
  return {
    projectConfig: lstatValue(paths.configPath),
    globalConfig: lstatValue(paths.globalConfigPath),
    workspace: lstatValue(paths.workspace),
    state: lstatValue(paths.stateDir),
    database: lstatValue(paths.dbPath),
    bootstrapRoot: lstatValue(path.join(path.dirname(paths.configPath), '.rc-bootstrap')),
    rootAuthorityRoot: lstatValue(path.join(
      path.dirname(paths.configPath),
      '.rc-bootstrap-lock-authority',
    )),
    rootAuthority: lstatValue(path.join(
      path.dirname(paths.configPath),
      '.rc-bootstrap-lock-authority',
      'authority.json',
    )),
    locksRoot: lstatValue(path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'locks')),
    operationDb: lstatValue(path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'locks', 'operation.sqlite')),
    runtimeDb: lstatValue(path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'locks', 'runtime.sqlite')),
    receipt: lstatValue(path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'receipt.json')),
    transactionCount,
  };
}

function parseWorkerOutput(run) {
  const lines = String(run.stdout).trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0]);
    if (!value || typeof value.ok !== 'boolean' || typeof value.phase !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

function selfTest() {
  const samples = [
    `rca_${'A'.repeat(43)}`,
    `sk-${'b'.repeat(24)}`,
    ['Authorization:', 'Bearer', 'private'].join(' '),
    'ordinary text',
  ];
  if (!containsSecret(samples[0]) || !containsSecret(samples[1]) || !containsSecret(samples[2])) {
    throw new Error('positive secret self-test failed');
  }
  if (containsSecret(samples[3])) throw new Error('negative secret self-test failed');
  const payload = {
    paths: {
      rcRoot: path.resolve('/fixture/rc'),
      configPath: path.resolve('/fixture/config/openclaw.json'),
      globalConfigPath: path.resolve('/fixture/state/openclaw.json'),
      workspace: path.resolve('/fixture/workspace'),
      stateDir: path.resolve('/fixture/state'),
      dbPath: path.resolve('/fixture/data/library.db'),
      capsuleFile: path.resolve('/fixture/capsule.json'),
    },
  };
  const safe = safeErrorDetails(
    Object.assign(new Error('must not be emitted'), {
      code: 'EPERM', errno: -4048, syscall: 'rename', path: payload.paths.workspace,
    }),
    payload,
  );
  if (safe.code !== 'EPERM' || safe.syscall !== 'rename' || safe.pathClass !== 'workspace') {
    throw new Error('error classification self-test failed');
  }
  if (JSON.stringify(safe).includes('must not be emitted')) throw new Error('error message leaked');
  const cleaned = redact(`${samples[0]} ${samples[1]} ${samples[2]}`);
  if (containsSecret(cleaned)) throw new Error('redaction self-test failed');
  process.stdout.write(`${JSON.stringify({ ok: true, cases: 7 })}\n`);
}

async function main(options) {
  if (process.platform !== 'win32' || process.arch !== 'x64'
      || Number(process.versions.node.split('.')[0]) !== 22
      || process.versions.modules !== '127') {
    throw new Error('This probe requires native Windows x64 Node 22 ABI 127');
  }
  const required = [
    'scripts/apply-bootstrap-profile.cjs',
    'scripts/bootstrap-profile/applier.cjs',
    'scripts/bootstrap-profile/cli.cjs',
    'scripts/bootstrap-profile/maintenance-lease.cjs',
    'scripts/bootstrap-profile/storage.cjs',
    'profiles/fixtures/thermoelectric-user-a/capsule.json',
    'package.json',
  ];
  const missing = required.filter((relative) => !fs.existsSync(path.join(options.rcRoot, relative)));
  if (missing.length > 0) throw new Error('Installed Research-Claw is missing required probe files');
  const candidateMaintenance = path.join(options.candidateRoot, 'maintenance-lease.cjs');
  const candidateStorage = path.join(options.candidateRoot, 'storage.cjs');
  if (!fs.existsSync(candidateMaintenance) || !fs.existsSync(candidateStorage)
      || sha256(fs.readFileSync(candidateMaintenance)) !== CANDIDATE_MAINTENANCE_SHA256
      || sha256(fs.readFileSync(candidateStorage)) !== CANDIDATE_STORAGE_SHA256) {
    throw new Error('The packaged Windows durability candidate failed its SHA256 check');
  }

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
  const localBase = process.env.LOCALAPPDATA || os.tmpdir();
  const taskRoot = path.join(localBase, 'Wentor', 'ProfileProbe', runId);
  const isolatedRoot = path.join(taskRoot, 'Windows path - \u7a7a\u683c - Profile probe');
  const logsRoot = path.join(taskRoot, 'logs');
  fs.mkdirSync(logsRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.outputDir, { recursive: true });

  const safeBase = safeEnvironment();
  const whoami = runCommand('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    env: safeBase.env,
    timeoutMs: 30_000,
  });
  const currentSid = whoami.ok ? whoami.stdout.match(/S-1-[0-9-]+/u)?.[0] : null;
  if (!currentSid) throw new Error('Unable to determine the current Windows user SID');
  const icacls = runCommand('icacls.exe', [
    taskRoot,
    '/inheritance:r',
    '/grant:r', `*${currentSid}:(OI)(CI)F`,
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
    '/grant:r', '*S-1-5-32-544:(OI)(CI)F',
    '/t', '/c', '/q',
  ], { env: safeBase.env, timeoutMs: 30_000 });
  if (!icacls.ok) throw new Error('Unable to protect the probe task root');

  const checks = [];
  const logs = [];
  const add = (id, status, summary, details = {}) => {
    const item = { id, status, summary: redact(summary), details };
    checks.push(item);
    process.stdout.write(`[${status}] ${id}: ${item.summary}\n`);
    return item;
  };
  const runWorker = (scope, operation, paths, txId = null) => {
    process.stdout.write(`[RUN] ${scope}.${operation}\n`);
    const payload = { scope, operation, paths, txId, candidateRoot: options.candidateRoot };
    const payloadFile = path.join(taskRoot, `payload-${scope}-${operation}.json`);
    writeJson(payloadFile, payload);
    const run = runCommand(process.execPath, [__filename, '--worker', payloadFile], {
      cwd: options.rcRoot,
      env: safeBase.env,
      timeoutMs: 180_000,
    });
    const parsed = parseWorkerOutput(run);
    const logFile = path.join(logsRoot, `${scope}-${operation}.log`);
    const logBytes = Buffer.from(`${JSON.stringify({
      exitCode: run.status,
      signal: run.signal,
      errorCode: run.errorCode,
      output: parsed,
      parseable: Boolean(parsed),
    }, null, 2)}\n`);
    if (containsSecret(logBytes.toString('utf8'))) throw new Error('Refusing to retain a secret-shaped worker log');
    fs.writeFileSync(logFile, logBytes, { mode: 0o600 });
    logs.push({ scope, operation, sha256: sha256(logBytes) });
    return parsed || {
      ok: false,
      phase: operation,
      error: {
        code: safeCode(run.errorCode, 'UNPARSEABLE_WORKER_RESULT'),
        errno: null,
        syscall: null,
        pathClass: null,
        destClass: null,
        constructor: 'Error',
      },
    };
  };

  add('host.contract', 'PASS', `win32/x64 node=${process.versions.node} abi=${process.versions.modules}`);
  add('environment.secret-boundary', 'PASS', `${safeBase.removed} secret-shaped environment value(s) withheld`);
  const sourceHashes = Object.fromEntries(required.map((relative) => [
    relative,
    sha256(fs.readFileSync(path.join(options.rcRoot, relative))),
  ]));
  add('source.required-files', 'PASS', `${required.length}/${required.length} required files`, { sourceHashes });
  add('candidate.source', 'PASS', '2/2 candidate durability files matched', {
    maintenanceLeaseSha256: CANDIDATE_MAINTENANCE_SHA256,
    storageSha256: CANDIDATE_STORAGE_SHA256,
  });

  const livePaths = {
    rcRoot: options.rcRoot,
    configPath: path.join(options.rcRoot, 'config', 'openclaw.json'),
    workspace: path.join(options.rcRoot, 'workspace'),
    stateDir: path.join(os.homedir(), '.openclaw'),
    dbPath: path.join(os.homedir(), '.research-claw', 'library.db'),
    globalConfigPath: path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    capsuleFile: null,
  };
  const liveBefore = liveMetadata(livePaths);
  const liveStatus = runWorker('live', 'status', livePaths);
  const liveAfter = liveMetadata(livePaths);
  const liveUnchanged = JSON.stringify(liveBefore) === JSON.stringify(liveAfter);
  const expectedUninitializedResidue = liveBefore.bootstrapRoot.exists === true
    && liveBefore.rootAuthorityRoot.exists === false
    && liveBefore.locksRoot.exists === false
    && liveBefore.receipt.exists === false
    && liveBefore.transactionCount === 0;
  const expectedLiveFailure = !liveStatus.ok
    && liveStatus.error.code === 'LOCK_AUTHORITY_LOST'
    && expectedUninitializedResidue;
  add(
    'live.status',
    liveUnchanged && (liveStatus.ok || expectedLiveFailure)
      ? expectedLiveFailure ? 'EXPECTED' : 'PASS'
      : 'FAIL',
    liveStatus.ok
      ? `read-only status completed; pending=${String(liveStatus.result.pendingPresent)} state=${String(liveStatus.result.pendingState)}`
      : expectedLiveFailure
        ? 'known pre-fix initialization residue; no authority was published'
        : `status failed: ${liveStatus.error.code}; syscall=${String(liveStatus.error.syscall)}; pathClass=${String(liveStatus.error.pathClass)}`,
    {
      output: liveStatus,
      metadataUnchanged: liveUnchanged,
      expectedUninitializedResidue,
      before: liveBefore,
      after: liveAfter,
    },
  );

  const paths = {
    rcRoot: options.rcRoot,
    configPath: path.join(isolatedRoot, 'config', 'openclaw.json'),
    workspace: path.join(isolatedRoot, 'workspace'),
    stateDir: path.join(isolatedRoot, 'state'),
    dbPath: path.join(isolatedRoot, 'data', 'library.db'),
    globalConfigPath: path.join(isolatedRoot, 'state', 'openclaw.json'),
    capsuleFile: path.join(isolatedRoot, 'capsule', 'capsule.json'),
  };
  for (const directory of [
    path.dirname(paths.configPath), paths.workspace, paths.stateDir, path.dirname(paths.dbPath),
    path.dirname(paths.capsuleFile),
  ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJson(paths.configPath, {
    agents: { defaults: { model: { primary: 'user-provider/user-model' } } },
    models: {
      mode: 'merge',
      providers: {
        'user-provider': {
          baseUrl: 'https://user.invalid/v1', api: 'openai-completions',
          models: [{ id: 'user-model', name: 'User model', input: ['text'], contextWindow: 1, maxTokens: 1 }],
          userOwned: true,
        },
      },
    },
    plugins: {
      entries: {
        'research-claw-core': { enabled: true, config: { userField: 'preserve' } },
        'dual-model-supervisor': { enabled: false, config: { enabled: false, reviewMode: 'off' } },
      },
    },
    tools: { deny: ['user_deny'] },
  });
  writeJson(path.join(paths.stateDir, 'agents', 'main', 'agent', 'auth-profiles.json'), {
    version: 1,
    profiles: {
      'user-provider:manual': {
        type: 'api_key', provider: 'user-provider', key: 'RC_TEST_ONLY_USER_OWNED_FAKE_KEY',
      },
    },
  });
  writeJson(paths.globalConfigPath, { userGlobal: { preserve: true } });
  const userSkill = path.join(paths.workspace, 'skills', 'user-skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(userSkill), { recursive: true, mode: 0o700 });
  fs.writeFileSync(userSkill, '---\nname: user-skill\ndescription: probe fixture\n---\n\nPRESERVE\n', { mode: 0o600 });

  const fixture = JSON.parse(fs.readFileSync(
    path.join(options.rcRoot, 'profiles', 'fixtures', 'thermoelectric-user-a', 'capsule.json'),
    'utf8',
  ));
  const key = fixture?.secrets?.modelApiKey;
  if (typeof key !== 'string' || !key.startsWith('RC_TEST_ONLY_') || containsSecret(key)) {
    throw new Error('The repository Profile fixture is not approved for isolated diagnostics');
  }
  writeJson(paths.capsuleFile, fixture);

  const phases = [];
  let firstFailedPhase = null;
  let txId = null;
  for (const operation of ['initialize-locks', 'recover']) {
    const output = runWorker('isolated', operation, paths);
    phases.push(output);
    add(
      `isolated.${operation}`,
      output.ok ? 'PASS' : 'FAIL',
      output.ok ? 'completed' : `${output.error.code}; syscall=${String(output.error.syscall)}; pathClass=${String(output.error.pathClass)}`,
      { output },
    );
    if (!output.ok) {
      firstFailedPhase ??= operation;
      break;
    }
  }

  let baseline = null;
  if (!firstFailedPhase) baseline = transactionSurfaceDigest(paths);
  if (!firstFailedPhase) {
    const staged = runWorker('isolated', 'stage', paths);
    phases.push(staged);
    add(
      'isolated.stage',
      staged.ok ? 'PASS' : 'FAIL',
      staged.ok ? 'completed' : `${staged.error.code}; syscall=${String(staged.error.syscall)}; pathClass=${String(staged.error.pathClass)}`,
      { output: staged },
    );
    if (staged.ok && /^tx-[0-9a-f-]{36}$/u.test(staged.result?.txId || '')) txId = staged.result.txId;
    else firstFailedPhase ??= 'stage';
  }
  for (const operation of ['apply', 'verify']) {
    if (firstFailedPhase || !txId) break;
    const output = runWorker('isolated', operation, paths, txId);
    phases.push(output);
    add(
      `isolated.${operation}`,
      output.ok ? 'PASS' : 'FAIL',
      output.ok ? 'completed' : `${output.error.code}; syscall=${String(output.error.syscall)}; pathClass=${String(output.error.pathClass)}`,
      { output },
    );
    if (!output.ok) firstFailedPhase ??= operation;
  }

  let rollback = null;
  if (txId) {
    rollback = runWorker('isolated', 'rollback', paths, txId);
    phases.push(rollback);
    add(
      'isolated.rollback',
      rollback.ok ? 'PASS' : 'FAIL',
      rollback.ok ? 'completed' : `${rollback.error.code}; syscall=${String(rollback.error.syscall)}; pathClass=${String(rollback.error.pathClass)}`,
      { output: rollback },
    );
    if (!rollback.ok) firstFailedPhase ??= 'rollback';
  } else {
    add('isolated.rollback', 'SKIP', 'no transaction was published');
  }
  let afterRollback = null;
  let rollbackRestored = null;
  if (baseline && rollback?.ok) {
    afterRollback = transactionSurfaceDigest(paths);
    const controlAfterRollback = transactionControlState(paths);
    rollbackRestored = JSON.stringify(baseline) === JSON.stringify(afterRollback)
      && controlAfterRollback.clean;
    add(
      'isolated.rollback-byte-preservation',
      rollbackRestored ? 'PASS' : 'FAIL',
      rollbackRestored
        ? 'isolated user preimage restored byte-for-byte; transaction control roots are absent or empty'
        : 'isolated user preimage drifted or transaction control residue remained after rollback',
      { baseline, afterRollback, controlAfterRollback },
    );
    if (!rollbackRestored) firstFailedPhase ??= 'rollback-byte-preservation';
  } else {
    add('isolated.rollback-byte-preservation', 'SKIP', 'rollback comparison unavailable');
  }

  const report = {
    schemaVersion: 1,
    probe: 'wentor-windows-native-profile-phase',
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    outcome: 'DIAGNOSTIC_CAPTURED',
    firstFailedPhase,
    boundaries: {
      setupTokenRead: false,
      modelKeyRead: false,
      liveProfileMutationAttempted: false,
      installedProductSourceModified: false,
      candidateMaintenanceOverlay: true,
      liveAllowedOperations: [...LIVE_OPERATIONS],
      isolatedOperations: [...ISOLATED_OPERATIONS],
      childStdin: 'closed',
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      nodeVersion: process.versions.node,
      nodeAbi: process.versions.modules,
    },
    source: { rcRoot: options.rcRoot, hashes: sourceHashes },
    checks,
    logs,
    phaseSummary: phases,
    rollbackRestored,
  };
  const jsonBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  if (containsSecret(jsonBytes.toString('utf8'))) {
    throw new Error('Refusing to publish a report containing a secret shape');
  }
  const jsonFile = path.join(options.outputDir, `Wentor-Profile-Probe-${runId}.json`);
  const textFile = path.join(options.outputDir, `Wentor-Profile-Probe-${runId}.txt`);
  fs.writeFileSync(jsonFile, jsonBytes);
  const text = [
    'Wentor Windows Profile phase probe',
    `Run: ${runId}`,
    'Outcome: DIAGNOSTIC_CAPTURED',
    `First failed isolated phase: ${String(firstFailedPhase)}`,
    '',
    ...checks.map((item) => `[${item.status}] ${item.id} - ${item.summary}`),
    '',
    'Safety: live access was status-only; no setup token or model API key was read.',
    `Detailed JSON: ${jsonFile}`,
  ].join('\n');
  const textBytes = Buffer.from(`${text}\n`);
  if (containsSecret(textBytes.toString('utf8'))) {
    throw new Error('Refusing to publish a report containing a secret shape');
  }
  fs.writeFileSync(textFile, textBytes);
  process.stdout.write(`\nDiagnostic capture complete.\nWENTOR_PROFILE_PROBE_REPORT=${textFile}\n`);
  process.stdout.write(`WENTOR_PROFILE_PROBE_JSON=${jsonFile}\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options.selfTest) {
  selfTest();
} else if (options.worker) {
  workerMain(options.worker).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: safeCode(error?.code, 'WORKER_FAILED') })}\n`);
    process.exitCode = 1;
  });
} else {
  main(options).catch((error) => {
    process.stderr.write(`Probe failed safely: ${redact(error.message)}\n`);
    process.exitCode = 1;
  });
}
