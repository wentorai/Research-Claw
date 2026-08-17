#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';
const DEFAULT_PACKAGE = '@wentorai/research-plugins';
const MAX_OUTPUT = 32 * 1024 * 1024;
const SECRET_PATTERNS = [
  /(^|[^A-Za-z0-9_-])rca_[A-Za-z0-9_-]{43,}/g,
  /(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bAuthorization\s*:\s*Bearer\s+\S+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function usage() {
  return [
    'Usage:',
    '  node probe-windows-native.cjs [--rc-root <dir>] [--output-dir <dir>]',
    '       [--registry <url>] [--package <npm-spec>]',
    '  node probe-windows-native.cjs --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    rcRoot: path.join(os.homedir(), 'research-claw'),
    outputDir: path.join(
      process.env.LOCALAPPDATA || os.tmpdir(),
      'Wentor',
      'ProbeReports',
    ),
    registry: DEFAULT_REGISTRY,
    packageSpec: DEFAULT_PACKAGE,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length || argv[index].length === 0) {
        throw new Error(`Missing value for ${argument}`);
      }
      return argv[index];
    };
    if (argument === '--rc-root') options.rcRoot = path.resolve(value());
    else if (argument === '--output-dir') options.outputDir = path.resolve(value());
    else if (argument === '--registry') options.registry = value();
    else if (argument === '--package') options.packageSpec = value();
    else if (argument === '--self-test') options.selfTest = true;
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!/^https:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$/u.test(options.registry)) {
    throw new Error('--registry must be an HTTPS URL');
  }
  if (!/^[A-Za-z0-9@/._+-]+$/u.test(options.packageSpec)) {
    throw new Error('--package contains unsupported characters');
  }
  return options;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
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
  text = text.replace(
    /\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi,
    '$1[credentials]@',
  );
  text = text.replace(
    /(^|[^A-Za-z0-9_-])rca_[A-Za-z0-9_-]{43,}/g,
    '$1[SETUP_TOKEN_REDACTED]',
  );
  text = text.replace(
    /(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
    '$1[MODEL_KEY_REDACTED]',
  );
  text = text.replace(
    /\bAuthorization\s*:\s*Bearer\s+\S+/gi,
    ['Authorization:', 'Bearer', '[REDACTED]'].join(' '),
  );
  text = text.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    '[PRIVATE_KEY_REDACTED]',
  );
  return text;
}

function lastLines(value, count = 8) {
  return redact(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}

function diagnosticExcerpt(value, count = 80) {
  return redact(value)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}

function relativeTarPath(fromDirectory, target) {
  const relative = path.relative(fromDirectory, target)
    .split(path.sep)
    .join('/');
  if (!relative || /^[A-Za-z]:/u.test(relative) || path.isAbsolute(relative)) {
    throw new Error('unable to form a drive-safe relative tar path');
  }
  return relative;
}

function safeEnvironment(overrides = {}) {
  const safe = {};
  let removed = 0;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && containsSecret(value)) {
      removed += 1;
      continue;
    }
    safe[key] = value;
  }
  Object.assign(safe, overrides);
  safe.GIT_TERMINAL_PROMPT = '0';
  safe.GCM_INTERACTIVE = 'Never';
  safe.GIT_ASKPASS = '';
  safe.SSH_ASKPASS = '';
  safe.NPM_CONFIG_AUDIT = 'false';
  safe.NPM_CONFIG_FUND = 'false';
  return { env: safe, removed };
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
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    errorCode: result.error?.code ?? null,
    errorMessage: result.error ? redact(result.error.message) : null,
    ok: result.status === 0 && !result.error,
  };
}

function resolveFromWhere(name) {
  const result = runCommand('where.exe', [name], {
    env: safeEnvironment().env,
    timeoutMs: 10_000,
  });
  if (!result.ok) return null;
  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry && fs.existsSync(entry)) || null;
}

function firstFile(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue to the next fixed candidate.
    }
  }
  return null;
}

function portableGitRoot() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const runtimes = path.join(local, 'Wentor', 'Runtimes');
  try {
    return fs.readdirSync(runtimes)
      .filter((name) => name.startsWith('PortableGit-'))
      .sort()
      .reverse()
      .map((name) => path.join(runtimes, name))
      .find((root) => fs.existsSync(path.join(root, 'cmd', 'git.exe'))) || null;
  } catch {
    return null;
  }
}

function makeExecutables() {
  const portable = portableGitRoot();
  const git = firstFile([
    portable && path.join(portable, 'cmd', 'git.exe'),
    resolveFromWhere('git.exe'),
  ]);
  let gitRoot = portable;
  if (!gitRoot && git && path.basename(path.dirname(git)).toLowerCase() === 'cmd') {
    gitRoot = path.dirname(path.dirname(git));
  }
  return {
    git,
    bash: firstFile([
      gitRoot && path.join(gitRoot, 'bin', 'bash.exe'),
      resolveFromWhere('bash.exe'),
    ]),
    tar: firstFile([
      gitRoot && path.join(gitRoot, 'usr', 'bin', 'tar.exe'),
      resolveFromWhere('tar.exe'),
    ]),
    powershell: firstFile([
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      resolveFromWhere('powershell.exe'),
    ]),
  };
}

function withRuntimePaths(environment, executables) {
  const updated = { ...environment };
  const pathKey = Object.keys(updated)
    .find((key) => key.toLowerCase() === 'path') || 'Path';
  const fixed = [
    path.dirname(process.execPath),
    executables.git && path.dirname(executables.git),
    executables.bash && path.dirname(executables.bash),
    executables.tar && path.dirname(executables.tar),
  ].filter(Boolean);
  updated[pathKey] = [...new Set(fixed), updated[pathKey] || '']
    .filter(Boolean)
    .join(path.delimiter);
  return updated;
}

async function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      resolve({ available: false, code: error.code || 'UNKNOWN' });
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve({ available: true, code: null }));
    });
  });
}

function selfTest() {
  const samples = [
    ['ordinary', 'ordinary text', 'ordinary text'],
    [
      'token',
      `prefix rca_${'A'.repeat(43)} suffix`,
      'prefix [SETUP_TOKEN_REDACTED] suffix',
    ],
    [
      'key',
      `prefix sk-${'b'.repeat(24)} suffix`,
      'prefix [MODEL_KEY_REDACTED] suffix',
    ],
    [
      'bearer',
      ['Authorization:', 'Bearer', 'private-value'].join(' '),
      ['Authorization:', 'Bearer', '[REDACTED]'].join(' '),
    ],
  ];
  for (const [name, input, expected] of samples) {
    const actual = redact(input);
    if (actual !== expected) throw new Error(`redaction self-test failed: ${name}`);
  }
  const safe = redact(`rca_${'C'.repeat(12)} sk-short task-sk-not-a-key`);
  if (containsSecret(safe)) throw new Error('negative secret self-test failed');
  process.stdout.write(`${JSON.stringify({ ok: true, cases: samples.length + 1 })}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    selfTest();
    return;
  }
  if (process.platform !== 'win32') {
    throw new Error('This probe must run on native Windows');
  }

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[-:.TZ]/g, '')}-${crypto
    .randomBytes(4).toString('hex')}`;
  const localBase = process.env.LOCALAPPDATA || os.tmpdir();
  const taskRoot = path.join(localBase, 'Wentor', 'NativeProbe', runId);
  const logsRoot = path.join(taskRoot, 'logs');
  const sandbox = path.join(taskRoot, 'sandbox');
  fs.mkdirSync(logsRoot, { recursive: true });
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(options.outputDir, { recursive: true });

  const checks = [];
  const rawLogPaths = [];
  const executables = makeExecutables();
  const safeBase = safeEnvironment();
  const baseEnv = withRuntimePaths(safeBase.env, executables);
  const removedEnvironmentSecrets = safeBase.removed;
  const rcRoot = options.rcRoot;

  const add = (id, title, status, summary, details = {}) => {
    const item = {
      id,
      title,
      status,
      summary: redact(summary),
      details: JSON.parse(redact(JSON.stringify(details))),
    };
    checks.push(item);
    const marker = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : status;
    process.stdout.write(`[${marker}] ${title}: ${item.summary}\n`);
    return item;
  };

  const saveLog = (id, result, extra = '') => {
    const file = path.join(logsRoot, `${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.log`);
    const text = redact([
      `status=${String(result.status)}`,
      `signal=${String(result.signal)}`,
      `errorCode=${String(result.errorCode)}`,
      extra,
      '--- stdout ---',
      result.stdout,
      '--- stderr ---',
      result.stderr,
    ].join('\n'));
    fs.writeFileSync(file, `${text}\n`, 'utf8');
    rawLogPaths.push(file);
    return { path: file, sha256: sha256(fs.readFileSync(file)) };
  };

  const commandCheck = (id, title, executable, args, settings = {}) => {
    if (!executable) {
      return add(id, title, settings.missingStatus || 'FAIL', 'required executable not found');
    }
    process.stdout.write(`[..] ${title}\n`);
    const result = runCommand(executable, args, {
      cwd: settings.cwd,
      env: settings.env || baseEnv,
      timeoutMs: settings.timeoutMs,
    });
    const log = saveLog(id, result);
    const status = result.ok ? 'PASS' : (settings.failureStatus || 'FAIL');
    const summary = result.ok
      ? (settings.successSummary?.(result) || lastLines(result.stdout, 2) || 'exit 0')
      : (result.errorMessage || lastLines(result.stderr || result.stdout, 8) || `exit ${String(result.status)}`);
    return add(id, title, status, summary, {
      exitCode: result.status,
      errorCode: result.errorCode,
      logSha256: log.sha256,
    });
  };

  process.stdout.write('\nWentor Windows Native full-chain probe\n');
  process.stdout.write('This probe does not read a setup token or model API key.\n\n');

  add(
    'host.platform',
    'Native Windows x64 host',
    process.arch === 'x64' ? 'PASS' : 'FAIL',
    `${process.platform}/${process.arch}; Windows ${os.release()}`,
    { node: process.version, abi: process.versions.modules },
  );
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeContractOk = nodeMajor === 22
    && process.versions.modules === '127'
    && process.arch === 'x64';
  add(
    'host.node-contract',
    'Wentor Node 22 runtime contract',
    nodeContractOk ? 'PASS' : 'FAIL',
    `node=${process.versions.node} abi=${process.versions.modules} arch=${process.arch}`,
  );
  add(
    'host.environment-secret-boundary',
    'Child environment secret boundary',
    'PASS',
    `${removedEnvironmentSecrets} secret-shaped environment value(s) withheld from probe children`,
  );
  try {
    const capacity = fs.statfsSync(taskRoot);
    const availableBytes = Number(capacity.bavail) * Number(capacity.bsize);
    const availableGiB = availableBytes / (1024 ** 3);
    add(
      'host.disk-capacity',
      'Probe/install disk capacity',
      availableGiB >= 5 ? 'PASS' : 'FAIL',
      `${availableGiB.toFixed(1)} GiB available on the task volume`,
    );
  } catch (error) {
    add('host.disk-capacity', 'Probe/install disk capacity', 'WARN', `${error.code || 'ERROR'}: ${error.message}`);
  }

  const requiredFiles = [
    'package.json',
    'scripts/install-research-plugins.cjs',
    'scripts/bootstrap-profile/storage.cjs',
    'scripts/bootstrap-profile/applier.cjs',
    'scripts/run-pnpm.cjs',
    'profiles/fixtures/thermoelectric-user-a/capsule.json',
  ];
  const missingFiles = requiredFiles.filter((relative) =>
    !fs.existsSync(path.join(rcRoot, relative)));
  add(
    'source.required-files',
    'Research-Claw diagnostic source surface',
    missingFiles.length === 0 ? 'PASS' : 'FAIL',
    missingFiles.length === 0
      ? `${requiredFiles.length}/${requiredFiles.length} required files present`
      : `${missingFiles.length} required file(s) missing`,
    { missing: missingFiles },
  );

  let packageJson = null;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(rcRoot, 'package.json'), 'utf8'));
    add(
      'source.package',
      'Research-Claw package metadata',
      packageJson.version === '0.8.3' ? 'PASS' : 'FAIL',
      `version=${String(packageJson.version)} packageManager=${String(packageJson.packageManager)}`,
    );
  } catch (error) {
    add('source.package', 'Research-Claw package metadata', 'FAIL', error.message);
  }

  const npmCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  commandCheck(
    'runtime.node',
    'Pinned Node runtime',
    process.execPath,
    ['-p', "JSON.stringify({version:process.versions.node,abi:process.versions.modules,arch:process.arch})"],
  );
  commandCheck(
    'runtime.npm',
    'Sibling npm JavaScript CLI',
    fs.existsSync(npmCli) ? process.execPath : null,
    [npmCli, '--version'],
  );

  let pnpmCli = null;
  const manager = String(packageJson?.packageManager || '');
  if (/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/u.test(manager)) {
    pnpmCli = path.join(
      rcRoot,
      '.tools',
      'pnpm',
      'node_modules',
      'pnpm',
      'bin',
      'pnpm.cjs',
    );
  }
  commandCheck(
    'runtime.pnpm',
    'Project-pinned pnpm runtime',
    pnpmCli && fs.existsSync(pnpmCli) ? process.execPath : null,
    [pnpmCli || '', '--version'],
  );
  commandCheck('runtime.git', 'Git for Windows', executables.git, ['--version']);
  commandCheck('runtime.bash', 'Git Bash', executables.bash, ['--version']);
  commandCheck('runtime.tar', 'Git for Windows tar', executables.tar, ['--version']);
  commandCheck(
    'runtime.ffmpeg',
    'Optional ffmpeg runtime',
    resolveFromWhere('ffmpeg.exe'),
    ['-version'],
    { missingStatus: 'WARN', failureStatus: 'WARN' },
  );
  commandCheck(
    'runtime.winget',
    'Optional WinGet availability',
    resolveFromWhere('winget.exe'),
    ['--version'],
    { missingStatus: 'WARN', failureStatus: 'WARN' },
  );
  commandCheck(
    'host.task-root-acl',
    'Probe task-root ACL readability',
    resolveFromWhere('icacls.exe'),
    [taskRoot],
    {
      missingStatus: 'WARN',
      failureStatus: 'WARN',
      successSummary: () => 'icacls completed successfully',
    },
  );

  if (executables.git) {
    const installedHead = runCommand(executables.git, ['rev-parse', 'HEAD'], {
      cwd: rcRoot,
      env: baseEnv,
      timeoutMs: 15_000,
    });
    const installedStatus = runCommand(executables.git, ['status', '--porcelain'], {
      cwd: rcRoot,
      env: baseEnv,
      timeoutMs: 15_000,
    });
    const head = installedHead.ok ? installedHead.stdout.trim() : null;
    const dirtyEntries = installedStatus.ok
      ? installedStatus.stdout.split(/\r?\n/u).filter(Boolean).length
      : null;
    add(
      'source.git-state',
      'Installed Research-Claw Git state',
      installedHead.ok && installedStatus.ok ? 'PASS' : 'FAIL',
      head ? `HEAD=${head.slice(0, 12)} dirtyEntries=${String(dirtyEntries)}` : 'unable to read Git state',
      { head, dirtyEntries },
    );

    const remoteHeads = {};
    for (const [name, url] of [
      ['github', 'https://github.com/wentorai/Research-Claw.git'],
      ['gitee', 'https://gitee.com/wentor/Research-Claw.git'],
    ]) {
      const result = runCommand(
        executables.git,
        [
          '-c',
          'credential.helper=',
          '-c',
          'core.askPass=',
          'ls-remote',
          url,
          'refs/heads/main',
        ],
        { cwd: sandbox, env: baseEnv, timeoutMs: 45_000 },
      );
      saveLog(`network-${name}`, result);
      const match = result.ok ? /^([0-9a-f]{40})\s/u.exec(result.stdout.trim()) : null;
      remoteHeads[name] = match?.[1] || null;
      add(
        `network.${name}`,
        `${name} Research-Claw main reachability`,
        match ? 'PASS' : (name === 'gitee' ? 'WARN' : 'FAIL'),
        match ? `main=${match[1].slice(0, 12)}` : (lastLines(result.stderr, 5) || 'unreachable'),
      );
    }
    const parityStatus = remoteHeads.github && remoteHeads.gitee
      ? (remoteHeads.github === remoteHeads.gitee ? 'PASS' : 'FAIL')
      : (remoteHeads.github ? 'WARN' : 'FAIL');
    add(
      'network.remote-parity',
      'GitHub/Gitee main parity',
      parityStatus,
      remoteHeads.github && remoteHeads.gitee
        ? `${remoteHeads.github.slice(0, 12)} vs ${remoteHeads.gitee.slice(0, 12)}`
        : (remoteHeads.github
          ? 'primary GitHub is reachable; optional Gitee mirror is unavailable'
          : 'both release remotes are unavailable'),
      remoteHeads,
    );
  }

  if (fs.existsSync(npmCli)) {
    commandCheck(
      'network.npm-registry',
      'Research-plugins registry metadata',
      process.execPath,
      [npmCli, 'view', options.packageSpec, 'version', '--registry', options.registry],
      { cwd: sandbox, timeoutMs: 90_000 },
    );
  } else {
    add('network.npm-registry', 'Research-plugins registry metadata', 'SKIP', 'npm CLI unavailable');
  }

  const fsRoot = path.join(sandbox, 'Windows path - 空格 - 路径', 'fs');
  fs.mkdirSync(fsRoot, { recursive: true });
  try {
    const file = path.join(fsRoot, 'durable.bin');
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, Buffer.from('durable-probe'));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    if (fs.readFileSync(file, 'utf8') !== 'durable-probe') throw new Error('readback mismatch');
    add('filesystem.file-fsync', 'File create/fsync/readback', 'PASS', 'exact byte readback succeeded');
  } catch (error) {
    add('filesystem.file-fsync', 'File create/fsync/readback', 'FAIL', `${error.code || 'ERROR'}: ${error.message}`);
  }

  try {
    const source = path.join(fsRoot, 'rename-source');
    const target = path.join(fsRoot, 'rename-target');
    fs.writeFileSync(source, 'new');
    fs.writeFileSync(target, 'old');
    fs.renameSync(source, target);
    if (fs.readFileSync(target, 'utf8') !== 'new') throw new Error('replace readback mismatch');
    add('filesystem.rename-replace', 'Atomic file replacement', 'PASS', 'rename over existing file succeeded');
  } catch (error) {
    add('filesystem.rename-replace', 'Atomic file replacement', 'FAIL', `${error.code || 'ERROR'}: ${error.message}`);
  }

  try {
    const source = path.join(fsRoot, 'hardlink-source');
    const target = path.join(fsRoot, 'hardlink-target');
    fs.writeFileSync(source, 'hardlink-probe');
    fs.linkSync(source, target);
    const left = fs.statSync(source);
    const right = fs.statSync(target);
    if (left.ino !== right.ino || left.dev !== right.dev || left.nlink < 2) {
      throw new Error('hardlink identity mismatch');
    }
    fs.unlinkSync(target);
    add('filesystem.hardlink', 'Hardlink publication primitive', 'PASS', 'identity and link count matched');
  } catch (error) {
    add('filesystem.hardlink', 'Hardlink publication primitive', 'FAIL', `${error.code || 'ERROR'}: ${error.message}`);
  }

  if (missingFiles.length === 0) {
    try {
      const storage = require(path.join(rcRoot, 'scripts', 'bootstrap-profile', 'storage.cjs'));
      const storageRoot = path.join(fsRoot, 'product-storage');
      storage.ensureDirectory(storageRoot);
      const atomic = path.join(storageRoot, 'atomic.json');
      storage.writeBytesAtomic(atomic, Buffer.from('{"revision":1}\n'));
      storage.writeBytesAtomic(atomic, Buffer.from('{"revision":2}\n'));
      if (fs.readFileSync(atomic, 'utf8') !== '{"revision":2}\n') {
        throw new Error('product atomic-write readback mismatch');
      }
      const staged = path.join(storageRoot, '.authority.stage.json');
      const published = path.join(storageRoot, 'authority.json');
      storage.writeJsonStagedNoReplace(published, staged, { ok: true });
      if (storage.readPrivateJson(published, { maxBytes: 1024 }).ok !== true) {
        throw new Error('staged authority readback mismatch');
      }
      add(
        'profile.storage-primitives',
        'Production Profile storage primitives',
        'PASS',
        'directory, repeated atomic replace, hardlink publication and readback passed',
      );
    } catch (error) {
      add(
        'profile.storage-primitives',
        'Production Profile storage primitives',
        'FAIL',
        `${error.code || 'ERROR'}: ${error.message}`,
      );
    }
  } else {
    add('profile.storage-primitives', 'Production Profile storage primitives', 'SKIP', 'required source files missing');
  }

  if (executables.tar) {
    const tarRoot = path.join(sandbox, 'tar-drive-probe');
    const payloadRoot = path.join(tarRoot, 'payload', 'package');
    const packRoot = path.join(tarRoot, 'pack');
    fs.mkdirSync(payloadRoot, { recursive: true });
    fs.mkdirSync(packRoot, { recursive: true });
    fs.writeFileSync(path.join(payloadRoot, 'probe.txt'), 'tar-drive-probe\n');
    const fixtureArchive = path.join(packRoot, 'fixture.tgz');
    const create = runCommand(
      executables.tar,
      ['-czf', path.join('pack', 'fixture.tgz'), '-C', 'payload', 'package'],
      { cwd: tarRoot, env: baseEnv, timeoutMs: 30_000 },
    );
    saveLog('tar-create', create);
    if (!create.ok) {
      add('archive.fixture', 'Tar fixture creation', 'FAIL', lastLines(create.stderr, 6) || 'tar creation failed');
    } else {
      add('archive.fixture', 'Tar fixture creation', 'PASS', 'local fixture archive created');
      const absoluteStage = path.join(tarRoot, 'absolute-stage');
      fs.mkdirSync(absoluteStage);
      const absolute = runCommand(
        executables.tar,
        ['-xzf', fixtureArchive, '--strip-components=1', '-C', absoluteStage],
        { cwd: tarRoot, env: baseEnv, timeoutMs: 30_000 },
      );
      saveLog('tar-absolute-drive', absolute);
      add(
        'archive.production-absolute-drive',
        'Current production absolute-drive tar invocation',
        absolute.ok ? 'PASS' : 'FAIL',
        absolute.ok
          ? 'absolute Windows archive path extracted successfully'
          : (lastLines(absolute.stderr, 6) || 'absolute archive path rejected'),
        { exitCode: absolute.status },
      );

      const relativeStage = path.join(tarRoot, 'relative-stage');
      fs.mkdirSync(relativeStage);
      const relative = runCommand(
        executables.tar,
        [
          '-xzf',
          relativeTarPath(relativeStage, fixtureArchive),
          '--strip-components=1',
        ],
        { cwd: relativeStage, env: baseEnv, timeoutMs: 30_000 },
      );
      saveLog('tar-relative-drive', relative);
      const relativePayload = path.join(relativeStage, 'probe.txt');
      const relativeOk = relative.ok
        && fs.existsSync(relativePayload)
        && fs.readFileSync(relativePayload, 'utf8') === 'tar-drive-probe\n';
      add(
        'archive.relative-safe',
        'Drive-safe relative tar invocation',
        relativeOk ? 'PASS' : 'FAIL',
        relativeOk ? 'relative archive extraction and byte readback passed' : (lastLines(relative.stderr, 6) || 'relative extraction failed'),
      );
    }
  } else {
    add('archive.fixture', 'Tar fixture creation', 'SKIP', 'tar executable unavailable');
    add('archive.production-absolute-drive', 'Current production absolute-drive tar invocation', 'SKIP', 'tar executable unavailable');
    add('archive.relative-safe', 'Drive-safe relative tar invocation', 'SKIP', 'tar executable unavailable');
  }

  const pluginRoot = path.join(
    sandbox,
    'Windows path - 空格 - 路径',
    'real-plugin-pipeline',
  );
  const packDir = path.join(pluginRoot, 'pack');
  const extractDir = path.join(pluginRoot, 'extracted');
  const isolatedHome = path.join(pluginRoot, 'isolated-home');
  const pluginTarget = path.join(
    isolatedHome,
    '.openclaw',
    'extensions',
    'research-plugins',
  );
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(isolatedHome, { recursive: true });
  const homedirHook = path.join(pluginRoot, 'probe-homedir.cjs');
  fs.writeFileSync(
    homedirHook,
    `require('node:os').homedir = () => ${JSON.stringify(isolatedHome)};\n`,
    { mode: 0o600 },
  );
  const pluginEnv = withRuntimePaths(safeEnvironment({
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
    NPM_CONFIG_CACHE: path.join(pluginRoot, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: path.join(pluginRoot, 'npmrc'),
    OPENCLAW_CONFIG_PATH: path.join(pluginRoot, 'openclaw.json'),
    NODE_OPTIONS: `--require="${homedirHook.replaceAll('\\', '/')}"`,
  }).env, executables);
  let packedArchive = null;
  if (fs.existsSync(npmCli)) {
    process.stdout.write('[..] Real research-plugins npm pack (may take several minutes)\n');
    const packed = runCommand(
      process.execPath,
      [
        npmCli,
        'pack',
        options.packageSpec,
        '--pack-destination',
        packDir,
        '--json',
        '--registry',
        options.registry,
      ],
      { cwd: pluginRoot, env: pluginEnv, timeoutMs: 300_000 },
    );
    const packLog = saveLog('plugins-real-pack', packed);
    if (packed.ok) {
      try {
        const parsed = JSON.parse(packed.stdout);
        const filename = Array.isArray(parsed) ? parsed[0]?.filename : null;
        if (typeof filename === 'string') packedArchive = path.join(packDir, filename);
      } catch {
        packedArchive = null;
      }
      if (!packedArchive || !fs.existsSync(packedArchive)) {
        packedArchive = fs.readdirSync(packDir)
          .filter((name) => name.endsWith('.tgz'))
          .map((name) => path.join(packDir, name))[0] || null;
      }
    }
    add(
      'plugins.real-pack',
      'Real research-plugins package download',
      packed.ok && packedArchive ? 'PASS' : 'FAIL',
      packed.ok && packedArchive
        ? `archiveBytes=${fs.statSync(packedArchive).size}`
        : (lastLines(packed.stderr || packed.stdout, 8) || 'npm pack failed'),
      { logSha256: packLog.sha256 },
    );
  } else {
    add('plugins.real-pack', 'Real research-plugins package download', 'SKIP', 'npm CLI unavailable');
  }

  let safeRealExtract = false;
  if (packedArchive && executables.tar) {
    fs.mkdirSync(extractDir, { recursive: true });
    const extracted = runCommand(
      executables.tar,
      [
        '-xzf',
        relativeTarPath(extractDir, packedArchive),
        '--strip-components=1',
      ],
      { cwd: extractDir, env: pluginEnv, timeoutMs: 180_000 },
    );
    const extractLog = saveLog('plugins-real-relative-extract', extracted);
    safeRealExtract = extracted.ok && fs.existsSync(path.join(extractDir, 'package.json'));
    add(
      'plugins.real-relative-extract',
      'Real package drive-safe extraction',
      safeRealExtract ? 'PASS' : 'FAIL',
      safeRealExtract ? 'package.json present after relative extraction' : (lastLines(extracted.stderr, 8) || 'real package extraction failed'),
      { logSha256: extractLog.sha256 },
    );
  } else {
    add('plugins.real-relative-extract', 'Real package drive-safe extraction', 'SKIP', 'package archive or tar unavailable');
  }

  let productionDependenciesReady = false;
  if (safeRealExtract) {
    const installed = runCommand(
      process.execPath,
      [
        npmCli,
        'install',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        options.registry,
      ],
      { cwd: extractDir, env: pluginEnv, timeoutMs: 600_000 },
    );
    const installLog = saveLog('plugins-production-dependencies', installed);
    productionDependenciesReady = installed.ok;
    add(
      'plugins.production-dependencies',
      'Real plugin production dependency install',
      installed.ok ? 'PASS' : 'FAIL',
      installed.ok ? 'npm install --omit=dev completed' : (lastLines(installed.stderr || installed.stdout, 8) || 'dependency install failed'),
      { logSha256: installLog.sha256 },
    );
  } else {
    add('plugins.production-dependencies', 'Real plugin production dependency install', 'SKIP', 'safe extraction did not complete');
  }

  if (productionDependenciesReady && missingFiles.length === 0) {
    const installer = path.join(rcRoot, 'scripts', 'install-research-plugins.cjs');
    const swapped = runCommand(
      process.execPath,
      [
        installer,
        '--source-dir',
        extractDir,
        '--target',
        pluginTarget,
        '--registry',
        options.registry,
        '--timeout-ms',
        '300000',
        '--quiet',
      ],
      { cwd: rcRoot, env: pluginEnv, timeoutMs: 600_000 },
    );
    const swapLog = saveLog('plugins-isolated-swap', swapped);
    const checked = swapped.ok
      ? runCommand(
        process.execPath,
        [installer, '--check', '--target', pluginTarget, '--quiet'],
        { cwd: rcRoot, env: pluginEnv, timeoutMs: 60_000 },
      )
      : null;
    const pipelineOk = swapped.ok && checked?.ok;
    add(
      'plugins.isolated-swap',
      'Real plugin isolated validation and atomic swap',
      pipelineOk ? 'PASS' : 'FAIL',
      pipelineOk
        ? 'package validated, installed into isolated home, and passed integrity check'
        : (lastLines(swapped.stderr || swapped.stdout, 8) || 'isolated plugin swap/check failed'),
      { logSha256: swapLog.sha256, checkExitCode: checked?.status ?? null },
    );
  } else {
    add('plugins.isolated-swap', 'Real plugin isolated validation and atomic swap', 'SKIP', 'plugin dependencies or source unavailable');
  }

  if (missingFiles.length === 0) {
    commandCheck(
      'runtime.preflight',
      'Built Research-Claw runtime preflight',
      process.execPath,
      [path.join(rcRoot, 'scripts', 'runtime-preflight.cjs'), '--require-build'],
      { cwd: rcRoot, timeoutMs: 120_000 },
    );
  } else {
    add('runtime.preflight', 'Built Research-Claw runtime preflight', 'SKIP', 'required source files missing');
  }

  const profileTests = [
    'test/research-plugins-installer.test.ts',
    'test/bootstrap-profile-lifecycle.test.ts',
    'test/bootstrap-profile-stage-publication.test.ts',
    'test/bootstrap-profile-secure-io-hardening.test.ts',
    'test/bootstrap-profile-maintenance-lease.test.ts',
    'test/bootstrap-profile-storage-identity-hardening.test.ts',
  ];
  const missingTests = profileTests.filter((relative) => !fs.existsSync(path.join(rcRoot, relative)));
  if (pnpmCli && fs.existsSync(pnpmCli) && missingTests.length === 0) {
    const testTemp = path.join(sandbox, 'isolated-test-runtime');
    const testHome = path.join(testTemp, 'home');
    fs.mkdirSync(testHome, { recursive: true });
    const testEnv = withRuntimePaths(safeEnvironment({
      HOME: testHome,
      USERPROFILE: testHome,
      APPDATA: path.join(testHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(testHome, 'AppData', 'Local'),
      TEMP: path.join(testTemp, 'temp'),
      TMP: path.join(testTemp, 'temp'),
      NPM_CONFIG_CACHE: path.join(testTemp, 'npm-cache'),
      OPENCLAW_CONFIG_PATH: path.join(testTemp, 'openclaw.json'),
    }).env, executables);
    fs.mkdirSync(testEnv.TEMP, { recursive: true });
    process.stdout.write('[..] Isolated Windows product tests (may take 10-20 minutes)\n');
    const tests = runCommand(
      process.execPath,
      [
        pnpmCli,
        'exec',
        'vitest',
        'run',
        ...profileTests,
        '--pool=forks',
        '--maxWorkers=1',
        '--minWorkers=1',
        '--no-file-parallelism',
        '--maxConcurrency=1',
      ],
      { cwd: rcRoot, env: testEnv, timeoutMs: 1_200_000 },
    );
    const testLog = saveLog('profile-isolated-tests', tests);
    const summary = lastLines(`${tests.stdout}\n${tests.stderr}`, 12);
    add(
      'profile.isolated-tests',
      'Isolated plugin and Profile transaction suites',
      tests.ok ? 'PASS' : 'FAIL',
      summary || `exit ${String(tests.status)}`,
      {
        files: profileTests.length,
        logSha256: testLog.sha256,
        failureExcerpt: tests.ok
          ? null
          : diagnosticExcerpt(`${tests.stdout}\n${tests.stderr}`),
      },
    );
  } else {
    add(
      'profile.isolated-tests',
      'Isolated plugin and Profile transaction suites',
      'SKIP',
      pnpmCli && fs.existsSync(pnpmCli)
        ? `${missingTests.length} test file(s) missing`
        : 'project pnpm unavailable',
      { missingTests },
    );
  }

  const port = await probePort(28789);
  add(
    'runtime.port-28789',
    'Gateway port 28789 observation',
    'PASS',
    port.available ? 'port is currently available' : `port is occupied (${port.code}); informational only`,
    { available: port.available, code: port.code },
  );

  if (executables.powershell) {
    const processScanScript = [
      '$ErrorActionPreference="Stop"',
      '$patterns=@("rca_[A-Za-z0-9_-]{43,}","(^|[^A-Za-z0-9_-])sk-(proj-)?[A-Za-z0-9_-]{16,}","Authorization\\s*:\\s*Bearer\\s+\\S+")',
      '$hits=0',
      'Get-CimInstance Win32_Process | ForEach-Object {',
      '  $line=[string]$_.CommandLine',
      '  foreach($pattern in $patterns){if($line -match $pattern){$hits++;break}}',
      '}',
      'Write-Output $hits',
    ].join(';');
    const scan = runCommand(
      executables.powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', processScanScript],
      { cwd: sandbox, env: baseEnv, timeoutMs: 30_000 },
    );
    const hits = scan.ok && /^\d+$/u.test(scan.stdout.trim())
      ? Number(scan.stdout.trim())
      : null;
    add(
      'runtime.process-secret-shapes',
      'Host process command-line secret-shape scan',
      scan.ok && hits === 0 ? 'PASS' : (scan.ok ? 'WARN' : 'FAIL'),
      scan.ok ? `${hits} process command line(s) matched; values were never collected` : (lastLines(scan.stderr, 5) || 'process scan unavailable'),
      { hitCount: hits },
    );
  } else {
    add('runtime.process-secret-shapes', 'Host process command-line secret-shape scan', 'SKIP', 'Windows PowerShell unavailable');
  }

  let evidenceSecretHits = 0;
  for (const file of rawLogPaths) {
    if (containsSecret(fs.readFileSync(file, 'utf8'))) evidenceSecretHits += 1;
  }
  add(
    'evidence.secret-scan',
    'Sanitized evidence secret scan',
    evidenceSecretHits === 0 ? 'PASS' : 'FAIL',
    `${evidenceSecretHits} evidence file(s) contain a high-confidence secret shape`,
  );

  const counts = checks.reduce((accumulator, item) => {
    accumulator[item.status] = (accumulator[item.status] || 0) + 1;
    return accumulator;
  }, {});
  const overall = (counts.FAIL || 0) > 0 ? 'BLOCKED' : 'READY_FOR_INSTALLER_FIX';
  const report = {
    schemaVersion: 1,
    probe: 'wentor-windows-native-full-chain',
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    overall,
    counts,
    boundaries: {
      setupTokenRead: false,
      modelKeyRead: false,
      liveProfileModified: false,
      liveResearchPluginsModified: false,
      packagePipelineTarget: 'isolated probe home',
      profilePipelineTarget: 'isolated Vitest temporary roots',
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      windowsRelease: os.release(),
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
    },
    rcRoot,
    taskRoot,
    checks,
  };

  const jsonBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  if (containsSecret(jsonBytes.toString('utf8'))) {
    throw new Error('Refusing to publish a report containing a secret shape');
  }
  const reportJson = path.join(options.outputDir, `Wentor-Windows-Probe-${runId}.json`);
  const reportText = path.join(options.outputDir, `Wentor-Windows-Probe-${runId}.txt`);
  fs.writeFileSync(reportJson, jsonBytes);
  const textLines = [
    'Wentor Windows Native full-chain probe',
    `Run: ${runId}`,
    `Overall: ${overall}`,
    `Counts: PASS=${counts.PASS || 0} WARN=${counts.WARN || 0} FAIL=${counts.FAIL || 0} SKIP=${counts.SKIP || 0}`,
    '',
    ...checks.map((item) => `[${item.status}] ${item.id} - ${item.summary.replace(/\n/g, ' | ')}`),
    '',
    'Safety: no setup token or model API key was read; live Profile and plugins were not modified.',
    `Detailed JSON: ${reportJson}`,
  ];
  const textBytes = Buffer.from(`${textLines.join('\n')}\n`);
  if (containsSecret(textBytes.toString('utf8'))) {
    throw new Error('Refusing to publish a text report containing a secret shape');
  }
  fs.writeFileSync(reportText, textBytes);
  process.stdout.write(`\nProbe complete: ${overall}\n`);
  process.stdout.write(`WENTOR_PROBE_REPORT=${reportText}\n`);
  process.stdout.write(`WENTOR_PROBE_JSON=${reportJson}\n`);
  process.stdout.write('Please send both report files to Wentor. They contain no setup token or model API key.\n');
}

main().catch((error) => {
  process.stderr.write(`Probe failed safely: ${redact(error.message)}\n`);
  process.exitCode = 1;
});
