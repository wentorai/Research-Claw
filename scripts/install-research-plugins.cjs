#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RESEARCH_PLUGINS_PACKAGE,
  inspectResearchPluginsInstall,
  isManagedResearchPluginsPath,
  writeResearchPluginsIntegrityRecord,
} = require('./research-plugins-install-utils.cjs');

const DEFAULT_TIMEOUT_MS = 120_000;
const INSTALL_LOCK_HEARTBEAT_MS = 400;
const INSTALL_LOCK_PROBE_MS = 1_100;

function usage() {
  return [
    'Usage:',
    '  node scripts/install-research-plugins.cjs [--package <spec>] [--target <dir>]',
    '  node scripts/install-research-plugins.cjs --source-dir <dir> [--target <dir>]',
    '  node scripts/install-research-plugins.cjs --check [--target <dir>]',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    packageSpec: RESEARCH_PLUGINS_PACKAGE,
    sourceDir: null,
    target: path.join(
      os.homedir(),
      '.openclaw',
      'extensions',
      'research-plugins',
    ),
    registry: process.env.NPM_REGISTRY || null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    check: false,
    quiet: false,
  };
  let packageWasExplicit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length || argv[index].length === 0) {
        throw new Error(`Missing value for ${argument}`);
      }
      return argv[index];
    };
    if (argument === '--package') {
      options.packageSpec = value();
      packageWasExplicit = true;
    } else if (argument === '--source-dir') {
      options.sourceDir = value();
    } else if (argument === '--target') {
      options.target = value();
    } else if (argument === '--registry') {
      options.registry = value();
    } else if (argument === '--timeout-ms') {
      options.timeoutMs = Number(value());
    } else if (argument === '--check') {
      options.check = true;
    } else if (argument === '--quiet') {
      options.quiet = true;
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.sourceDir && packageWasExplicit) {
    throw new Error('--package and --source-dir are mutually exclusive');
  }
  if (
    !Number.isFinite(options.timeoutMs)
    || options.timeoutMs < 1_000
    || options.timeoutMs > 600_000
  ) {
    throw new Error('--timeout-ms must be between 1000 and 600000');
  }
  options.target = path.resolve(options.target);
  const canonicalTarget = path.resolve(
    os.homedir(),
    '.openclaw',
    'extensions',
    'research-plugins',
  );
  if (
    !isManagedResearchPluginsPath(options.target)
    || options.target !== canonicalTarget
  ) {
    throw new Error(
      '--target must be the current user canonical .openclaw/extensions/research-plugins directory',
    );
  }
  if (options.sourceDir) {
    options.sourceDir = path.resolve(options.sourceDir);
  }
  return options;
}

function redact(message) {
  return String(message)
    .replace(
      /\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi,
      '$1[credentials]@',
    )
    .trim();
}

function run(executable, args, options) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    const detail = redact(result.stderr || result.stdout || '');
    throw new Error(
      `${options.label} failed (exit ${String(result.status)})${
        detail ? `: ${detail.split('\n').slice(-6).join('\n')}` : ''
      }`,
    );
  }
  return result;
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function tarExecutable() {
  return process.platform === 'win32' ? 'tar.exe' : 'tar';
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processStartIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd > -1) {
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTime = fields[19];
      if (startTime) return `proc:${startTime}`;
    }
  } catch {
    // Non-Linux platforms use ps below.
  }
  try {
    const result = spawnSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf8',
        timeout: 2_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    );
    const value = result.status === 0 ? result.stdout.trim() : '';
    return value ? `ps:${value}` : null;
  } catch {
    return null;
  }
}

function bootIdentity() {
  try {
    return fs
      .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
      .trim() || null;
  } catch {
    return null;
  }
}

function startInstallLockHeartbeat(lockPath, ownerToken) {
  const heartbeat = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs');
const [lockPath,ownerToken,parentPid]=process.argv.slice(1);
const alive=()=>{try{process.kill(Number(parentPid),0);return true}catch{return false}};
const beat=()=>{try{
  if(!alive())process.exit(0);
  const record=JSON.parse(fs.readFileSync(lockPath,'utf8'));
  if(record.ownerToken!==ownerToken)process.exit(0);
  const now=new Date();
  fs.utimesSync(lockPath,now,now);
}catch{process.exit(0)}};
beat();
setInterval(beat,${INSTALL_LOCK_HEARTBEAT_MS});`,
      lockPath,
      ownerToken,
      String(process.pid),
    ],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  heartbeat.on('error', () => {});
  heartbeat.unref();
  return heartbeat;
}

function lockHasLiveHeartbeat(lockPath) {
  let before;
  try {
    before = fs.statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    INSTALL_LOCK_PROBE_MS,
  );
  try {
    return fs.statSync(lockPath).mtimeMs > before;
  } catch {
    return false;
  }
}

function acquireInstallLock(parent) {
  const lockPath = path.join(parent, '.research-plugins.install.lock');
  const create = () => {
    const ownerToken = crypto.randomBytes(16).toString('hex');
    const descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(
      descriptor,
      JSON.stringify({
        ownerToken,
        pid: process.pid,
        hostname: os.hostname(),
        bootId: bootIdentity(),
        processStart: processStartIdentity(process.pid),
        createdAt: Date.now(),
      }),
    );
    return {
      descriptor,
      lockPath,
      ownerToken,
      heartbeat: startInstallLockHeartbeat(lockPath, ownerToken),
    };
  };
  try {
    return create();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let stale = true;
    try {
      const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const currentBoot = bootIdentity();
      const pid = Number(record.pid);
      const age = Date.now() - Number(record.createdAt);
      const sameHost =
        typeof record.hostname === 'string'
        && record.hostname === os.hostname();
      if (
        !Number.isInteger(pid)
        || pid < 1
        || !Number.isFinite(age)
        || age < 0
        || typeof record.hostname !== 'string'
      ) {
        stale = true;
      } else if (!sameHost) {
        // A different container may share this volume but not its PID
        // namespace. A live owner advances mtime from a child heartbeat even
        // while npm is blocked; a crashed container leaves it unchanged.
        stale = !lockHasLiveHeartbeat(lockPath);
      } else {
        const currentStart = processStartIdentity(pid);
        const alive = processIsAlive(pid);
        const bootMismatch =
          typeof record.bootId === 'string'
          && currentBoot !== null
          && record.bootId !== currentBoot;
        const startMismatch =
          typeof record.processStart === 'string'
          && currentStart !== null
          && record.processStart !== currentStart;
        const strongLiveIdentity =
          alive
          && !bootMismatch
          && typeof record.processStart === 'string'
          && currentStart === record.processStart;
        stale =
          bootMismatch
          || !alive
          || startMismatch
          || (!strongLiveIdentity && !lockHasLiveHeartbeat(lockPath));
      }
    } catch {
      stale = true;
    }
    if (!stale) {
      throw new Error('another research-plugins installation is active');
    }
    fs.rmSync(lockPath, { force: true });
    return create();
  }
}

function releaseInstallLock(lock) {
  if (!lock) return;
  try {
    lock.heartbeat?.kill();
  } catch {
    // Ownership verification below still prevents deleting another lock.
  }
  try {
    fs.closeSync(lock.descriptor);
  } catch {
    // The lock path remains the authoritative cleanup target.
  }
  try {
    const record = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    if (record.ownerToken === lock.ownerToken) {
      fs.rmSync(lock.lockPath, { force: true });
    }
  } catch {
    // Never delete a lock whose ownership can no longer be proven.
  }
}

function recoverInterruptedSwap(parent, target, nonce) {
  for (const name of fs.readdirSync(parent)) {
    if (name.startsWith('.research-plugins.install-')) {
      fs.rmSync(path.join(parent, name), {
        recursive: true,
        force: true,
      });
    }
  }
  const backups = fs.readdirSync(parent)
    .filter((name) => name.startsWith('.research-plugins.backup-'))
    .map((name) => path.join(parent, name))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) =>
      fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  if (backups.length === 0) return false;

  const targetState = inspectResearchPluginsInstall(target);
  if (targetState.usable) {
    for (const backup of backups) {
      fs.rmSync(backup, { recursive: true, force: true });
    }
    return false;
  }

  const usableBackup = backups.find(
    (backup) => inspectResearchPluginsInstall(backup).usable,
  );
  if (!usableBackup) return false;

  const displaced = path.join(
    parent,
    `.research-plugins.invalid-${nonce}`,
  );
  const hadTarget = fs.existsSync(target);
  if (hadTarget) fs.renameSync(target, displaced);
  try {
    fs.renameSync(usableBackup, target);
  } catch (error) {
    if (hadTarget && fs.existsSync(displaced) && !fs.existsSync(target)) {
      fs.renameSync(displaced, target);
    }
    throw error;
  }
  if (fs.existsSync(displaced)) {
    fs.rmSync(displaced, { recursive: true, force: true });
  }
  for (const backup of backups) {
    if (fs.existsSync(backup)) {
      fs.rmSync(backup, { recursive: true, force: true });
    }
  }
  return true;
}

function installFromPackage(options, workDir, stageDir) {
  const packDir = path.join(workDir, 'pack');
  fs.mkdirSync(packDir);
  const packArgs = [
    'pack',
    options.packageSpec,
    '--pack-destination',
    packDir,
    '--json',
  ];
  if (options.registry) packArgs.push('--registry', options.registry);
  const packed = run(npmExecutable(), packArgs, {
    cwd: workDir,
    timeoutMs: options.timeoutMs,
    label: 'npm pack',
  });

  let archive = null;
  try {
    const report = JSON.parse(packed.stdout);
    const filename = Array.isArray(report) ? report[0]?.filename : null;
    if (typeof filename === 'string' && filename.length > 0) {
      archive = path.join(packDir, filename);
    }
  } catch {
    archive = null;
  }
  if (!archive || !fs.existsSync(archive)) {
    archive = fs.readdirSync(packDir)
      .filter((name) => name.endsWith('.tgz'))
      .map((name) => path.join(packDir, name))[0] || null;
  }
  if (!archive || !fs.statSync(archive).isFile()) {
    throw new Error('npm pack did not produce a tarball');
  }

  fs.mkdirSync(stageDir);
  run(
    tarExecutable(),
    ['-xzf', archive, '--strip-components=1', '-C', stageDir],
    {
      cwd: workDir,
      timeoutMs: options.timeoutMs,
      label: 'package extraction',
    },
  );

  const installArgs = [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ];
  if (options.registry) installArgs.push('--registry', options.registry);
  run(npmExecutable(), installArgs, {
    cwd: stageDir,
    timeoutMs: options.timeoutMs,
    label: 'production dependency install',
  });
}

function installFromDirectory(options, stageDir) {
  if (
    !fs.existsSync(options.sourceDir)
    || !fs.statSync(options.sourceDir).isDirectory()
  ) {
    throw new Error('--source-dir is not a directory');
  }
  fs.cpSync(options.sourceDir, stageDir, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
  });
}

function replaceAtomically(stageDir, target, backupPath) {
  const hadTarget = fs.existsSync(target);
  if (hadTarget) fs.renameSync(target, backupPath);
  try {
    fs.renameSync(stageDir, target);
  } catch (error) {
    if (hadTarget && fs.existsSync(backupPath) && !fs.existsSync(target)) {
      fs.renameSync(backupPath, target);
    }
    throw error;
  }
  return hadTarget;
}

function restoreAfterFailedSwap(target, backupPath, hadTarget) {
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (hadTarget && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, target);
    }
    return true;
  } catch {
    return false;
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${redact(error.message)}\n${usage()}\n`);
    return 2;
  }

  const initial = inspectResearchPluginsInstall(options.target);
  if (options.check) {
    if (!options.quiet) {
      process.stdout.write(`${JSON.stringify(initial)}\n`);
    }
    return initial.usable ? 0 : 1;
  }

  const parent = path.dirname(options.target);
  fs.mkdirSync(parent, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const workDir = path.join(
    parent,
    `.research-plugins.install-${nonce}`,
  );
  const stageDir = path.join(workDir, 'stage');
  const backupPath = path.join(
    parent,
    `.research-plugins.backup-${nonce}`,
  );
  let installLock = null;
  let swapCompleted = false;
  let hadTarget = false;

  try {
    installLock = acquireInstallLock(parent);
    if (recoverInterruptedSwap(parent, options.target, nonce) && !options.quiet) {
      process.stdout.write(
        'Recovered the previous research plugins after an interrupted update.\n',
      );
    }
    if (options.sourceDir) {
      const sourceState = inspectResearchPluginsInstall(
        options.sourceDir,
        { requireIntegrity: false },
      );
      const targetState = inspectResearchPluginsInstall(options.target);
      if (
        sourceState.usable
        && targetState.usable
        && sourceState.version !== null
        && sourceState.version === targetState.version
        && sourceState.integrityDigest === targetState.integrityDigest
      ) {
        if (targetState.integrityStatus === 'legacy') {
          writeResearchPluginsIntegrityRecord(options.target);
          const adopted = inspectResearchPluginsInstall(
            options.target,
            { requireIntegrity: true },
          );
          if (!adopted.usable) {
            throw new Error(
              `legacy integrity adoption failed (${adopted.reason})`,
            );
          }
        }
        if (!options.quiet) {
          process.stdout.write(
            `Research plugins already ready (v${sourceState.version}).\n`,
          );
        }
        return 0;
      }
    }
    fs.mkdirSync(workDir);
    if (options.sourceDir) {
      installFromDirectory(options, stageDir);
    } else {
      installFromPackage(options, workDir, stageDir);
    }
    const stagedSource = inspectResearchPluginsInstall(
      stageDir,
      { requireIntegrity: false },
    );
    if (!stagedSource.usable) {
      throw new Error(
        `staged package is incomplete (${stagedSource.reason})`,
      );
    }
    writeResearchPluginsIntegrityRecord(stageDir);
    const staged = inspectResearchPluginsInstall(
      stageDir,
      { requireIntegrity: true },
    );
    if (!staged.usable) {
      throw new Error(
        `staged package is incomplete (${staged.reason})`,
      );
    }
    hadTarget = replaceAtomically(stageDir, options.target, backupPath);
    swapCompleted = true;
    const installed = inspectResearchPluginsInstall(
      options.target,
      { requireIntegrity: true },
    );
    if (!installed.usable) {
      throw new Error(
        `installed package failed post-swap validation (${installed.reason})`,
      );
    }
    if (hadTarget && fs.existsSync(backupPath)) {
      fs.rmSync(backupPath, { recursive: true, force: true });
    }
    if (!options.quiet) {
      process.stdout.write(
        `Research plugins ready${
          installed.version ? ` (v${installed.version})` : ''
        }.\n`,
      );
    }
    return 0;
  } catch (error) {
    if (!fs.existsSync(options.target) && fs.existsSync(backupPath)) {
      try {
        fs.renameSync(backupPath, options.target);
      } catch {
        process.stderr.write(
          `Research plugins restore failed; preserved backup: ${backupPath}\n`,
        );
        return 3;
      }
    }
    if (
      swapCompleted
      && !restoreAfterFailedSwap(
        options.target,
        backupPath,
        hadTarget,
      )
    ) {
      process.stderr.write(
        `Research plugins restore failed; preserved backup: ${backupPath}\n`,
      );
      return 3;
    }
    process.stderr.write(
      `Research plugins were not changed: ${redact(error.message)}\n`,
    );
    return 1;
  } finally {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    releaseInstallLock(installLock);
  }
}

process.exitCode = main();
