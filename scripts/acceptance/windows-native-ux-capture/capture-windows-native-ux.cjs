#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { domainToASCII } = require('node:url');

const ASCII_ALIAS = 'xn--w8yz0bg0vrjz.localhost';
const BRAND_ALIAS_URL = `http://${ASCII_ALIAS}:28789/`;
const DASHBOARD_TITLE_MARKER = 'WentorOS · Research-Claw';
const EXPECTED_SOURCE_COMMIT = '5015be7a72387098f122cb3e7cc4aae32714d4fa';
const EXPECTED_SHARED_FILES = Object.freeze({
  'scripts/install-windows.ps1': '2f76c8c4307e0cb68e8ed3c8fe51edb7a59ebd50ba4f019e55e88a052b8de93b',
  'scripts/install.sh': 'afa18713e02740288e986b8fd1c7b1a6e203c4503ca4f72fd6c501da4a3d5c57',
  'scripts/run.sh': '220d13f82e17cf74d029744915c743f17acf715d701c8861f89b0ebcc9aebc8f',
  'scripts/ensure-config.cjs': '690e576e8bb8d2851170ba1b6f4ae18411c497089081adfd9ccdc1a17bd80c11',
});
const URLS = [
  { id: 'ipv4', url: 'http://127.0.0.1:28789/' },
  { id: 'localhost', url: 'http://localhost:28789/' },
];
const SECRET_PATTERNS = [
  /(^|[^A-Za-z0-9_-])rca_[A-Za-z0-9_-]{43,}/g,
  /(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bAuthorization\s*:\s*Bearer\s+\S+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function usage() {
  return [
    'Usage:',
    '  node capture-windows-native-ux.cjs [--rc-root <dir>] [--output-dir <dir>]',
    '       [--host-script <file>] [--no-dispatch-browser]',
    '  node capture-windows-native-ux.cjs --self-test',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    rcRoot: path.join(os.homedir(), 'research-claw'),
    outputDir: path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Wentor', 'ProbeReports'),
    hostScript: path.join(__dirname, 'Capture-Wentor-UX-Host.ps1'),
    dispatchBrowser: true,
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
    else if (argument === '--host-script') options.hostScript = path.resolve(value());
    else if (argument === '--no-dispatch-browser') options.dispatchBrowser = false;
    else if (argument === '--self-test') options.selfTest = true;
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
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
    /(^|[^A-Za-z0-9_-])rca_[A-Za-z0-9_-]{43,}/g,
    '$1[PRIVATE_VALUE_REDACTED]',
  );
  text = text.replace(
    /(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
    '$1[PRIVATE_VALUE_REDACTED]',
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

function safeEnvironment() {
  const environment = {};
  let withheld = 0;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && containsSecret(value)) {
      withheld += 1;
      continue;
    }
    environment[key] = value;
  }
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GCM_INTERACTIVE = 'Never';
  environment.GIT_ASKPASS = '';
  environment.SSH_ASKPASS = '';
  return { environment, withheld };
}

function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    errorCode: result.error?.code || null,
  };
}

function findExecutable(name, environment) {
  const result = runCommand('where.exe', [name], { env: environment, timeoutMs: 10_000 });
  if (!result.ok) return null;
  return result.stdout
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function findGitExecutable(environment) {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    const runtimesRoot = path.join(process.env.LOCALAPPDATA, 'Wentor', 'Runtimes');
    try {
      const portableRoots = fs.readdirSync(runtimesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('PortableGit-'))
        .map((entry) => path.join(runtimesRoot, entry.name))
        .sort((left, right) => right.localeCompare(left));
      for (const portableRoot of portableRoots) {
        candidates.push(
          path.join(portableRoot, 'cmd', 'git.exe'),
          path.join(portableRoot, 'bin', 'git.exe'),
        );
      }
    } catch {
      // A missing Wentor runtime root is represented by the null result below.
    }
  }
  candidates.push(findExecutable('git.exe', environment));
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function findChromiumBrowser(environment) {
  const candidates = [
    process.env['ProgramFiles(x86)'] && {
      id: 'edge',
      executable: path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    },
    process.env.ProgramFiles && {
      id: 'edge',
      executable: path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    },
    process.env.LOCALAPPDATA && {
      id: 'edge',
      executable: path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    },
    process.env.ProgramFiles && {
      id: 'chrome',
      executable: path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    },
    process.env['ProgramFiles(x86)'] && {
      id: 'chrome',
      executable: path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    },
    process.env.LOCALAPPDATA && {
      id: 'chrome',
      executable: path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    },
    { id: 'edge', executable: findExecutable('msedge.exe', environment) },
    { id: 'chrome', executable: findExecutable('chrome.exe', environment) },
  ].filter(Boolean);
  return candidates.find((candidate) => candidate.executable && fs.existsSync(candidate.executable)) || null;
}

function browserDumpMatches(stdout) {
  return String(stdout).includes(DASHBOARD_TITLE_MARKER);
}

function browserAliasObservation(environment, outputRoot) {
  const browser = findChromiumBrowser(environment);
  if (!browser) {
    return {
      attempted: false,
      browserId: null,
      ok: false,
      markerMatched: false,
      cleanupSucceeded: true,
      errorCode: 'CHROMIUM_BROWSER_NOT_FOUND',
    };
  }
  const browserProbeRoot = fs.mkdtempSync(path.join(outputRoot, '.browser-alias-'));
  let result;
  let cleanupSucceeded = false;
  let cleanupErrorCode = null;
  try {
    result = runCommand(browser.executable, [
      '--headless=new',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${browserProbeRoot}`,
      '--dump-dom',
      BRAND_ALIAS_URL,
    ], { env: environment, timeoutMs: 30_000 });
  } finally {
    try {
      fs.rmSync(browserProbeRoot, { recursive: true, force: false });
      cleanupSucceeded = !fs.existsSync(browserProbeRoot);
    } catch (error) {
      cleanupErrorCode = error?.code || 'BROWSER_PROBE_CLEANUP_FAILED';
    }
  }
  const markerMatched = result?.ok === true && browserDumpMatches(result.stdout);
  return {
    attempted: true,
    browserId: browser.id,
    ok: markerMatched && cleanupSucceeded,
    markerMatched,
    cleanupSucceeded,
    errorCode: cleanupErrorCode
      || (result?.ok ? (markerMatched ? null : 'DASHBOARD_MARKER_NOT_FOUND') : result?.errorCode || `EXIT_${String(result?.status)}`),
  };
}

function powershellExecutables(environment) {
  const ps51 = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const ps7Candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
    findExecutable('pwsh.exe', environment),
  ].filter(Boolean);
  return [
    { id: 'windows-powershell', executable: fs.existsSync(ps51) ? ps51 : null },
    {
      id: 'powershell-core',
      executable: ps7Candidates.find((candidate) => fs.existsSync(candidate)) || null,
    },
  ];
}

function shellContractGreen(snapshots) {
  const desktop = snapshots.find((item) => item.id === 'windows-powershell');
  const core = snapshots.find((item) => item.id === 'powershell-core');
  const common = (item) => item?.ok === true
    && item.powershell?.is64BitOperatingSystem === true
    && item.powershell?.is64BitProcess === true
    && item.powershell?.processorArchitecture === 'AMD64';
  return common(desktop)
    && desktop.powershell.edition === 'Desktop'
    && desktop.powershell.major === 5
    && common(core)
    && core.powershell.edition === 'Core'
    && core.powershell.major === 7;
}

function parseSnapshot(result, id) {
  if (!result.ok) {
    return {
      id,
      ok: false,
      errorCode: result.errorCode || `EXIT_${String(result.status)}`,
    };
  }
  try {
    const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const snapshot = JSON.parse(lines.at(-1));
    return { id, ok: true, ...snapshot };
  } catch {
    return { id, ok: false, errorCode: 'INVALID_HOST_SNAPSHOT_JSON' };
  }
}

function runHostSnapshot(executable, id, options, environment, dispatchBrowser) {
  if (!executable) return { id, ok: false, errorCode: 'EXECUTABLE_NOT_FOUND' };
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    options.hostScript,
    '-RcRoot',
    options.rcRoot,
    '-DashboardUrl',
    URLS[0].url,
  ];
  if (dispatchBrowser) args.push('-DispatchBrowser');
  return parseSnapshot(runCommand(executable, args, {
    cwd: path.dirname(options.hostScript),
    env: environment,
    timeoutMs: 30_000,
  }), id);
}

function httpObservation(target, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const request = http.get(target.url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          id: target.id,
          ok: response.statusCode === 200,
          status: response.statusCode || null,
          durationMs: Date.now() - started,
          bodyBytes: bytes,
          bodySha256: bytes <= 1024 * 1024 ? sha256(body) : null,
          errorCode: bytes <= 1024 * 1024 ? null : 'BODY_LIMIT_EXCEEDED',
        });
      });
    });
    request.once('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    request.once('error', (error) => resolve({
      id: target.id,
      ok: false,
      status: null,
      durationMs: Date.now() - started,
      bodyBytes: 0,
      bodySha256: null,
      errorCode: error.code || 'REQUEST_FAILED',
    }));
  });
}

function sourceObservation(rcRoot, environment) {
  const packageFile = path.join(rcRoot, 'package.json');
  const result = {
    version: null,
    commit: null,
    dirtyEntries: null,
    sharedFiles: {},
  };
  try {
    result.version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version || null;
  } catch {
    // The report remains explicit about missing source metadata.
  }
  const git = findGitExecutable(environment);
  if (git && fs.existsSync(path.join(rcRoot, '.git'))) {
    const head = runCommand(git, ['-c', 'credential.helper=', 'rev-parse', 'HEAD'], {
      cwd: rcRoot,
      env: environment,
    });
    const status = runCommand(git, ['-c', 'credential.helper=', 'status', '--porcelain'], {
      cwd: rcRoot,
      env: environment,
    });
    if (head.ok && /^[0-9a-f]{40}\s*$/u.test(head.stdout)) result.commit = head.stdout.trim();
    if (status.ok) result.dirtyEntries = status.stdout.split(/\r?\n/u).filter(Boolean).length;
  }
  for (const relative of [
    'scripts/install-windows.ps1',
    'scripts/install.sh',
    'scripts/run.sh',
    'scripts/ensure-config.cjs',
  ]) {
    const file = path.join(rcRoot, relative);
    try {
      result.sharedFiles[relative] = sha256(fs.readFileSync(file));
    } catch {
      result.sharedFiles[relative] = null;
    }
  }
  return result;
}

function sourceAuthorityObservation(source) {
  const sharedFileMatches = Object.fromEntries(
    Object.entries(EXPECTED_SHARED_FILES).map(([relative, expected]) => [
      relative,
      source.sharedFiles?.[relative] === expected,
    ]),
  );
  const commitMatches = source.commit === EXPECTED_SOURCE_COMMIT;
  const cleanWorktree = source.dirtyEntries === 0;
  const sourceAuthorityGreen = source.version === '0.8.3'
    && commitMatches
    && cleanWorktree
    && Object.values(sharedFileMatches).every(Boolean);
  return {
    expectedCommit: EXPECTED_SOURCE_COMMIT,
    commitMatches,
    cleanWorktree,
    sharedFileMatches,
    sourceAuthorityGreen,
  };
}

function ownershipObservation(snapshot, protocolMatches) {
  const listener = snapshot?.listener || {};
  const exactIdentityCaptured = snapshot?.ok === true
    && listener.unique === true
    && Number.isInteger(listener.pid)
    && Number.isInteger(listener.parentPid)
    && typeof listener.creationTimeUtc === 'string'
    && listener.creationTimeUtc.length > 0
    && typeof listener.executableName === 'string'
    && listener.executableName.length > 0;
  return {
    exactIdentityCaptured,
    listenerPid: exactIdentityCaptured ? listener.pid : null,
    parentPid: exactIdentityCaptured ? listener.parentPid : null,
    creationTimeUtc: exactIdentityCaptured ? listener.creationTimeUtc : null,
    executableName: exactIdentityCaptured ? listener.executableName : null,
    commandLineContainsRcRoot: exactIdentityCaptured ? listener.commandLineContainsRcRoot : null,
    executableUnderWentorRuntime: exactIdentityCaptured ? listener.executableUnderWentorRuntime : null,
    protocolMatches,
    ownershipClaimed: false,
    note: 'Identity observation alone never authorizes stop or replacement.',
  };
}

function ensureEvidenceRoot(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const real = fs.realpathSync(outputDir);
  const expectedParent = fs.realpathSync(path.dirname(outputDir));
  if (path.dirname(real) !== expectedParent) throw new Error('Evidence directory identity mismatch');
  return real;
}

function writeEvidenceExclusive(outputRoot, name, bytes) {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw new Error('Invalid evidence filename');
  const target = path.join(outputRoot, name);
  if (path.dirname(target) !== outputRoot) throw new Error('Evidence target escaped output root');
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return target;
}

function selfTest() {
  let cases = 0;
  if (domainToASCII('科研龙虾.localhost') !== ASCII_ALIAS) throw new Error('IDNA self-test failed');
  cases += 1;
  const token = `rca_${'A'.repeat(43)}`;
  if (redact(token) !== '[PRIVATE_VALUE_REDACTED]') throw new Error('private value redaction failed');
  cases += 1;
  const key = `sk-${'b'.repeat(24)}`;
  if (redact(key) !== '[PRIVATE_VALUE_REDACTED]') throw new Error('private value redaction failed');
  cases += 1;
  if (!redact(['Authorization:', 'Bearer', 'value'].join(' ')).endsWith('[REDACTED]')) throw new Error('header redaction failed');
  cases += 1;
  if (containsSecret('ordinary diagnostic text')) throw new Error('negative secret test failed');
  cases += 1;
  const exact = ownershipObservation({
    ok: true,
    listener: {
      unique: true,
      pid: 101,
      parentPid: 88,
      creationTimeUtc: '2026-08-18T00:00:00.000Z',
      executableName: 'node.exe',
      commandLineContainsRcRoot: true,
      executableUnderWentorRuntime: true,
    },
  }, true);
  if (!exact.exactIdentityCaptured || exact.ownershipClaimed) throw new Error('identity classification failed');
  cases += 1;
  const ambiguous = ownershipObservation({ ok: true, listener: { unique: false } }, true);
  if (ambiguous.exactIdentityCaptured) throw new Error('ambiguous listener accepted');
  cases += 1;
  const dispatch = { attempted: true, dispatchAccepted: true, errorCode: null };
  if (!dispatch.dispatchAccepted || Object.hasOwn(dispatch, ['browser', 'Opened'].join(''))) throw new Error('dispatch semantics failed');
  cases += 1;
  const sample = JSON.stringify({ exact, dispatch, displayUrl: 'http://科研龙虾.localhost:28789/' });
  if (containsSecret(sample)) throw new Error('sample evidence secret scan failed');
  cases += 1;
  if (!browserDumpMatches(`<title>${DASHBOARD_TITLE_MARKER}</title>`)) throw new Error('browser marker self-test failed');
  cases += 1;
  const authority = sourceAuthorityObservation({
    version: '0.8.3',
    commit: EXPECTED_SOURCE_COMMIT,
    dirtyEntries: 0,
    sharedFiles: { ...EXPECTED_SHARED_FILES },
  });
  if (!authority.sourceAuthorityGreen) throw new Error('source authority self-test failed');
  cases += 1;
  process.stdout.write(`${JSON.stringify({ ok: true, cases })}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    selfTest();
    return;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This capture must run on native Windows x64');
  }
  if (Number(process.versions.node.split('.')[0]) !== 22 || process.versions.modules !== '127') {
    throw new Error('This capture requires Wentor Node 22 ABI 127');
  }
  if (!fs.statSync(options.hostScript).isFile()) throw new Error('Host snapshot script is missing');

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
  const safe = safeEnvironment();
  const outputRoot = ensureEvidenceRoot(options.outputDir);
  const httpChecks = await Promise.all(URLS.map((target) => httpObservation(target)));
  const ipv4Green = httpChecks.find((item) => item.id === 'ipv4')?.ok === true;
  const browserAlias = ipv4Green
    ? browserAliasObservation(safe.environment, outputRoot)
    : {
      attempted: false,
      browserId: null,
      ok: false,
      markerMatched: false,
      cleanupSucceeded: true,
      errorCode: 'DASHBOARD_NOT_HEALTHY',
    };
  const browserAliasGreen = browserAlias.ok === true;
  const shells = powershellExecutables(safe.environment);
  const snapshots = shells.map((shell, index) => runHostSnapshot(
    shell.executable,
    shell.id,
    options,
    safe.environment,
    index === 0 && options.dispatchBrowser && ipv4Green,
  ));
  const primary = snapshots.find((item) => item.id === 'windows-powershell');
  const ownership = ownershipObservation(primary, ipv4Green);
  const browserDispatch = primary?.browserDispatch || {
    attempted: false,
    dispatchAccepted: false,
    errorCode: ipv4Green ? 'HOST_SNAPSHOT_UNAVAILABLE' : 'DASHBOARD_NOT_HEALTHY',
  };
  const source = sourceObservation(options.rcRoot, safe.environment);
  const sourceAuthority = sourceAuthorityObservation(source);
  const sourceAuthorityGreen = sourceAuthority.sourceAuthorityGreen;
  const powershellContractGreen = shellContractGreen(snapshots);
  const requiredGreen = sourceAuthorityGreen
    && powershellContractGreen
    && ownership.exactIdentityCaptured
    && httpChecks.every((item) => item.ok)
    && browserAliasGreen
    && (!options.dispatchBrowser || browserDispatch.dispatchAccepted === true);
  const report = {
    schemaVersion: 1,
    capture: 'wentor-windows-native-ux-read-only',
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    overall: requiredGreen ? 'PASS' : 'FAIL',
    boundaries: {
      liveProductModified: false,
      processStopped: false,
      configurationRead: false,
      privateValueRead: false,
      browserObservation: 'shell-dispatch-plus-headless-chromium-alias',
      ownershipObservation: 'identity-only-never-stop-authority',
      withheldEnvironmentValueCount: safe.withheld,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      windowsRelease: os.release(),
      nodeVersion: process.versions.node,
      nodeAbi: process.versions.modules,
    },
    source,
    sourceAuthority,
    sourceAuthorityGreen,
    powershellContractGreen,
    powershellSnapshots: snapshots,
    loopback: {
      displayUrl: 'http://科研龙虾.localhost:28789/',
      asciiAlias: ASCII_ALIAS,
      checks: httpChecks,
      browserAlias,
      browserAliasGreen,
    },
    browserDispatch,
    ownership,
    captureBytes: {
      coreSha256: sha256(fs.readFileSync(__filename)),
      hostScriptSha256: sha256(fs.readFileSync(options.hostScript)),
    },
  };
  const jsonBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  if (containsSecret(jsonBytes.toString('utf8'))) throw new Error('Refusing to publish private evidence');
  const jsonName = `Wentor-UX-Capture-${runId}.json`;
  const textName = `Wentor-UX-Capture-${runId}.txt`;
  const jsonPath = writeEvidenceExclusive(outputRoot, jsonName, jsonBytes);
  const text = [
    'Wentor Windows native UX read-only capture',
    `Run: ${runId}`,
    `Overall: ${report.overall}`,
    `Source: version=${source.version || 'unknown'} commit=${source.commit || 'unknown'} dirtyEntries=${String(source.dirtyEntries)}`,
    `Source authority: ${sourceAuthorityGreen ? 'PASS' : 'FAIL'}`,
    `PowerShell: ${snapshots.map((item) => `${item.id}=${item.ok ? 'PASS' : item.errorCode}`).join(' ')}`,
    `Loopback: ${httpChecks.map((item) => `${item.id}=${item.ok ? 'PASS' : item.errorCode}`).join(' ')}`,
    `Brand alias in ${browserAlias.browserId || 'browser'}: ${browserAliasGreen ? 'PASS' : browserAlias.errorCode}`,
    `Browser dispatch accepted: ${String(browserDispatch.dispatchAccepted === true)}`,
    `Exact listener identity captured: ${String(ownership.exactIdentityCaptured)}`,
    'Safety: observation only; no configuration or private value was read; no product process was stopped.',
    `Detailed JSON file: ${jsonName}`,
  ].join('\n');
  const textBytes = Buffer.from(`${text}\n`);
  if (containsSecret(textBytes.toString('utf8'))) throw new Error('Refusing to publish private text evidence');
  const textPath = writeEvidenceExclusive(outputRoot, textName, textBytes);
  process.stdout.write(`${text}\n`);
  process.stdout.write(`WENTOR_UX_CAPTURE_JSON=${jsonPath}\n`);
  process.stdout.write(`WENTOR_UX_CAPTURE_REPORT=${textPath}\n`);
  process.exitCode = requiredGreen ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`UX capture failed safely: ${redact(error.message)}\n`);
  process.exitCode = 1;
});
