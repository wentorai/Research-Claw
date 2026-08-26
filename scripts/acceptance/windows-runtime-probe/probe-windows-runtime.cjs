#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const CONFIG_GET_TIMEOUT_MS = 35_000;
const RPC_TIMEOUT_MS = 12_000;
const STABILITY_WINDOW_MS = 75_000;
const HTTP_TIMEOUT_MS = 5_000;
const PORT = 28789;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const clientId = 'openclaw-control-ui';

const SECRET_PATTERNS = [
  /(^|[^A-Za-z0-9_-])rca_[A-Za-z0-9_-]{43,}/g,
  /(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bAuthorization\s*:\s*Bearer\s+\S+/gi,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
];

function parseArgs(argv) {
  const options = {
    rcRoot: path.join(os.homedir(), 'research-claw'),
    outputDir: path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Wentor', 'ProbeReports'),
    consoleInputMode: 'unavailable',
    quickEditEnabled: null,
    expectedHead: null,
    processHelper: null,
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
    else if (argument === '--console-input-mode') options.consoleInputMode = value();
    else if (argument === '--quick-edit') {
      const raw = value();
      options.quickEditEnabled = raw === 'true' ? true : raw === 'false' ? false : null;
    } else if (argument === '--expected-head') options.expectedHead = value().toLowerCase();
    else if (argument === '--process-helper') options.processHelper = path.resolve(value());
    else if (argument === '--self-test') options.selfTest = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function secretShape(value) {
  const text = String(value ?? '');
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function redact(value, home = os.homedir()) {
  let text = String(value ?? '');
  text = text.replace(/\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[credentials]@');
  text = text.replace(/(^|[^A-Za-z0-9_-])rca_[A-Za-z0-9_-]{43,}/g, '$1[SETUP_TOKEN_REDACTED]');
  text = text.replace(/(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '$1[MODEL_KEY_REDACTED]');
  text = text.replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: [REDACTED]');
  text = text.replace(
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
    '[PRIVATE_KEY_REDACTED]',
  );
  text = text.replace(
    /\b((?:api[_-]?key|access[_-]?token|authorization|credential|password|passphrase|secret|token)\s*[:=]\s*)[^\s,;}"']+/gi,
    '$1[REDACTED]',
  );
  if (home) text = text.split(home).join('%USERPROFILE%');
  return text;
}

function safeCode(value, fallback = 'UNCLASSIFIED') {
  return typeof value === 'string' && /^[A-Z0-9_.-]{1,80}$/u.test(value)
    ? value : fallback;
}

function safeError(error, home) {
  return {
    code: safeCode(error?.code, 'PROBE_ERROR'),
    message: redact(error?.message || String(error), home).slice(0, 500),
  };
}

function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 15_000,
    windowsHide: true,
    maxBuffer: MAX_OUTPUT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0 && !result.error,
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    errorCode: result.error?.code || null,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readGitHead(root) {
  try {
    const git = path.join(root, '.git');
    const gitMetadata = fs.lstatSync(git);
    let gitDir = git;
    if (gitMetadata.isFile()) {
      const marker = fs.readFileSync(git, 'utf8').trim();
      if (!marker.startsWith('gitdir: ')) return null;
      gitDir = path.resolve(root, marker.slice('gitdir: '.length));
    } else if (!gitMetadata.isDirectory()) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/u.test(head)) return head;
    const match = head.match(/^ref: (.+)$/u);
    if (!match) return null;
    const loose = path.join(gitDir, ...match[1].split('/'));
    if (fs.existsSync(loose)) {
      const value = fs.readFileSync(loose, 'utf8').trim();
      return /^[0-9a-f]{40}$/u.test(value) ? value : null;
    }
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split(/\r?\n/u).find((entry) => entry.endsWith(` ${match[1]}`));
    return line && /^[0-9a-f]{40} /u.test(line) ? line.slice(0, 40) : null;
  } catch {
    return null;
  }
}

function fileMetadata(target) {
  try {
    const stat = fs.lstatSync(target);
    return {
      present: true,
      type: stat.isSymbolicLink() ? 'symlink'
        : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      sha256: stat.isFile() && stat.size <= 32 * 1024 * 1024
        ? sha256(fs.readFileSync(target)) : null,
    };
  } catch (error) {
    return { present: false, errorCode: error?.code === 'ENOENT' ? null : safeCode(error?.code) };
  }
}

function sanitizeLogTail(target, home) {
  const metadata = fileMetadata(target);
  if (!metadata.present || metadata.type !== 'file') return { pathClass: path.basename(target), ...metadata };
  try {
    const descriptor = fs.openSync(target, 'r');
    const stat = fs.fstatSync(descriptor);
    const length = Math.min(stat.size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
    fs.closeSync(descriptor);
    const raw = buffer.toString('utf8');
    const tail = redact(raw, home).split(/\r?\n/u).slice(-120).join('\n');
    if (secretShape(tail)) throw new Error('SECRET_SHAPE_REMAINED');
    return {
      pathClass: path.basename(target),
      ...metadata,
      sanitizedTail: tail,
    };
  } catch (error) {
    return {
      pathClass: path.basename(target),
      ...metadata,
      sanitizedTail: null,
      errorCode: safeCode(error?.code, 'LOG_SANITIZE_FAILED'),
    };
  }
}

function newestInstallerLog() {
  const parent = path.join(process.env.LOCALAPPDATA || '', 'Wentor', 'InstallerTemp');
  let best = null;
  const visit = (target, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) visit(child, depth + 1);
      else if (entry.isFile() && /^rc-install-\d{8}-\d{6}\.log$/u.test(entry.name)) {
        const stat = fs.statSync(child);
        if (!best || stat.mtimeMs > best.mtimeMs) best = { path: child, mtimeMs: stat.mtimeMs };
      }
    }
  };
  if (parent) visit(parent, 0);
  return best?.path || null;
}

function extractInstallerTimeline(sanitizedTail) {
  if (typeof sanitizedTail !== 'string') return [];
  const allowed = /step 8\/8|research.plugins|profile|model.probe|configuration|gateway|ready|starting/i;
  return sanitizedTail.split(/\r?\n/u)
    .filter((line) => allowed.test(line))
    .slice(-40)
    .map((line) => line.slice(0, 500));
}

function findListenerPid(port) {
  const result = runCommand('netstat.exe', ['-ano', '-p', 'tcp']);
  if (!result.ok) return { pid: null, errorCode: 'NETSTAT_FAILED' };
  const expression = new RegExp(`^\\s*TCP\\s+(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]):${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i');
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.match(expression);
    if (match) return { pid: Number(match[1]), errorCode: null };
  }
  return { pid: null, errorCode: null };
}

function processSample(pid, helper) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (typeof helper !== 'string' || !fs.existsSync(helper)) {
    return { rootPid: pid, errorCode: 'PROCESS_HELPER_MISSING' };
  }
  const result = runCommand('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helper, '-RootPid', String(pid),
  ]);
  if (!result.ok) return { rootPid: pid, errorCode: 'PROCESS_SAMPLE_FAILED' };
  try { return JSON.parse(result.stdout); } catch {
    return { rootPid: pid, errorCode: 'PROCESS_SAMPLE_INVALID' };
  }
}

async function httpHealth(port) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    const body = await response.text();
    return {
      ok: response.status === 200,
      status: response.status,
      durationMs: Date.now() - started,
      bodySha256: sha256(Buffer.from(body)),
      bodyBytes: Buffer.byteLength(body),
    };
  } catch (error) {
    return { ok: false, status: null, durationMs: Date.now() - started, error: safeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function loadRuntimeInputs(root) {
  const packagePath = path.join(root, 'package.json');
  const configPath = path.join(root, 'config', 'openclaw.json');
  const entryPath = path.join(root, 'node_modules', 'openclaw', 'dist', 'entry.js');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const token = typeof config?.gateway?.auth?.token === 'string'
    ? config.gateway.auth.token : 'research-claw';
  return {
    packagePath,
    configPath,
    entryPath,
    uiVersion: String(packageJson.version),
    token,
  };
}

async function openDashboardSession({ root, port, token, uiVersion, listenerPid, processHelper }) {
  const entryPath = path.join(root, 'node_modules', 'openclaw', 'dist', 'entry.js');
  const requireFromOpenClaw = createRequire(fs.realpathSync(entryPath));
  const WebSocket = requireFromOpenClaw('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  const pending = new Map();
  const eventTimeline = [];
  const openedAt = Date.now();
  let challengeResolve;
  let challengeReject;
  const challenge = new Promise((resolve, reject) => {
    challengeResolve = resolve;
    challengeReject = reject;
  });
  let closed = null;

  const rejectPending = (code, message) => {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error(message), { code }));
      pending.delete(id);
    }
  };
  socket.on('message', (bytes) => {
    let frame;
    try { frame = JSON.parse(bytes.toString('utf8')); } catch { return; }
    if (frame?.type === 'event') {
      const name = typeof frame.event === 'string' ? frame.event : 'unknown';
      eventTimeline.push({ event: name, atMs: Date.now() - openedAt });
      if (name === 'connect.challenge') challengeResolve();
      if (frame.event === 'tick') {
        // The event name and time are sufficient; its payload is never retained.
      }
      return;
    }
    if (frame?.type === 'res' && typeof frame.id === 'string' && pending.has(frame.id)) {
      const waiter = pending.get(frame.id);
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      waiter.resolve({
        ok: frame.ok === true,
        errorCode: safeCode(frame?.error?.code, frame.ok === true ? 'NONE' : 'RPC_REJECTED'),
        errorMessage: frame.ok === true ? null : redact(frame?.error?.message || 'RPC rejected', os.homedir()),
      });
    }
  });
  socket.on('close', (code, reason) => {
    closed = { code, reason: redact(reason.toString('utf8'), os.homedir()).slice(0, 200) };
    challengeReject(Object.assign(new Error('WebSocket closed before challenge'), { code: 'WS_CLOSED' }));
    rejectPending('WS_CLOSED', 'WebSocket closed before the RPC response');
  });
  socket.on('error', (error) => {
    challengeReject(error);
    rejectPending('WS_ERROR', error.message);
  });

  const opened = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('WebSocket open timed out'), { code: 'WS_OPEN_TIMEOUT' })), RPC_TIMEOUT_MS);
    socket.once('open', () => { clearTimeout(timer); resolve(true); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  if (!opened) throw new Error('WebSocket did not open');
  await Promise.race([
    challenge,
    delay(RPC_TIMEOUT_MS).then(() => { throw Object.assign(new Error('Challenge timed out'), { code: 'CHALLENGE_TIMEOUT' }); }),
  ]);

  let sequence = 0;
  const request = (method, params, timeoutMs) => {
    const id = `wentor-runtime-probe-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out`), { code: 'RPC_TIMEOUT' }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  };

  const timedRequest = async (method, params, timeoutMs) => {
    const started = Date.now();
    try {
      const result = await request(method, params, timeoutMs);
      return { method, ok: result.ok, durationMs: Date.now() - started, ...result };
    } catch (error) {
      return { method, ok: false, durationMs: Date.now() - started, error: safeError(error) };
    }
  };

  const connect = await timedRequest('connect', {
    minProtocol: 4,
    maxProtocol: 4,
    client: {
      id: clientId,
      version: uiVersion,
      platform: 'node',
      mode: 'webchat',
      displayName: 'Wentor post-install runtime probe',
    },
    caps: [],
    role: 'operator',
    scopes: ['operator.admin'],
    auth: token ? { token } : {},
  }, RPC_TIMEOUT_MS);

  let configGet = { method: 'config.get', ok: false, durationMs: 0, error: { code: 'NOT_RUN', message: 'connect failed' } };
  const healthRpcs = [];
  const processSamples = [];
  const httpSamples = [];
  if (connect.ok) {
    configGet = await timedRequest('config.get', {}, CONFIG_GET_TIMEOUT_MS);
    const stabilityStarted = Date.now();
    while (Date.now() - stabilityStarted < STABILITY_WINDOW_MS) {
      healthRpcs.push(await timedRequest('health', {}, RPC_TIMEOUT_MS));
      httpSamples.push(await httpHealth(port));
      processSamples.push(processSample(listenerPid, processHelper));
      const remaining = STABILITY_WINDOW_MS - (Date.now() - stabilityStarted);
      if (remaining > 0) await delay(Math.min(15_000, remaining));
    }
  }
  const tickEvents = eventTimeline.filter((frame) => frame.event === 'tick');
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'runtime probe complete');
  await delay(250);
  return {
    connect,
    configGet,
    healthRpcs,
    httpSamples,
    processSamples,
    eventTimeline,
    tickCount: tickEvents.length,
    lastTickAtMs: tickEvents.length ? tickEvents[tickEvents.length - 1].atMs : null,
    closed,
  };
}

function readProfileReceipt(root) {
  const target = path.join(root, 'config', '.rc-bootstrap', 'receipt.json');
  try {
    const receipt = JSON.parse(fs.readFileSync(target, 'utf8'));
    const profile = receipt?.profile;
    return {
      present: true,
      id: typeof profile?.id === 'string' ? profile.id : null,
      revision: Number.isSafeInteger(profile?.revision) ? profile.revision : null,
      digest: typeof profile?.digest === 'string' && /^[0-9a-f]{64}$/u.test(profile.digest)
        ? profile.digest : null,
    };
  } catch (error) {
    return { present: false, errorCode: safeCode(error?.code, 'RECEIPT_INVALID') };
  }
}

function pluginSummary() {
  const root = path.join(os.homedir(), '.openclaw', 'extensions', 'research-plugins');
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    let skills = 0;
    const walk = (target) => {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const child = path.join(target, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile() && entry.name === 'SKILL.md') skills += 1;
      }
    };
    walk(path.join(root, 'skills'));
    return { present: true, version: String(packageJson.version), skills };
  } catch (error) {
    return { present: false, errorCode: safeCode(error?.code, 'PLUGIN_INSPECT_FAILED') };
  }
}

function buildText(report) {
  const lines = [
    'Wentor Windows post-install runtime probe',
    'This diagnostic reads no Setup Token or model API key.',
    'Returned gateway config bytes are discarded and never written.',
    'No child process can wait for keyboard input.',
    '',
  ];
  const add = (state, name, detail = '') => lines.push(`[${state}] ${name}${detail ? `: ${detail}` : ''}`);
  add(report.host.ok ? 'PASS' : 'FAIL', 'host.contract', report.host.summary);
  add(report.source.ok ? 'PASS' : 'FAIL', 'candidate.source', report.source.summary);
  add(report.installTransactionGreen ? 'PASS' : 'FAIL', 'install.transaction', report.install.summary);
  add('INFO', 'console.input-mode', `mode=${report.consoleInputMode}; quickEdit=${String(report.quickEditEnabled)}`);
  add(report.listener.pid ? 'PASS' : 'FAIL', 'gateway.listener', report.listener.pid ? `pid=${report.listener.pid}` : 'not found');
  add(report.initialProcess?.console?.attached && report.initialProcess?.console?.quickEditEnabled === false ? 'PASS' : 'FAIL',
    'gateway.console-mode',
    `mode=${report.initialProcess?.console?.inputMode ?? 'unavailable'}; quickEdit=${String(report.initialProcess?.console?.quickEditEnabled)}`);
  add(report.initialProcess?.gitDescendantCount === 0 ? 'PASS' : 'FAIL',
    'gateway.git-descendants', `count=${report.initialProcess?.gitDescendantCount ?? 'unknown'}`);
  add(report.initialHttp.ok ? 'PASS' : 'FAIL', 'gateway.http-health', `${String(report.initialHttp.status)} in ${report.initialHttp.durationMs}ms`);
  add(report.session?.connect?.ok ? 'PASS' : 'FAIL', 'gateway.websocket-auth', `${report.session?.connect?.durationMs ?? 0}ms`);
  add(report.session?.configGet?.ok ? 'PASS' : 'FAIL', 'gateway.config.get', `${report.session?.configGet?.durationMs ?? 0}ms`);
  add(report.session?.tickCount > 0 ? 'PASS' : 'FAIL', 'gateway.tick', `count=${report.session?.tickCount ?? 0}`);
  add(report.dashboardRuntimeGreen ? 'PASS' : 'FAIL', 'dashboard.runtime', report.verdict);
  lines.push('', `WENTOR_RUNTIME_PROBE_REPORT=${report.reportPath}`, `WENTOR_RUNTIME_PROBE_JSON=${report.jsonPath}`);
  lines.push('', report.dashboardRuntimeGreen
    ? 'Runtime probe completed successfully.'
    : 'Runtime probe captured a failure. Send both sanitized report files to Wentor.');
  return `${lines.join('\n')}\n`;
}

function selfTest() {
  const samples = [
    ['setup', `prefix rca_${'a'.repeat(43)} suffix`, '[SETUP_TOKEN_REDACTED]'],
    ['model', `x sk-${'b'.repeat(20)} y`, '[MODEL_KEY_REDACTED]'],
    ['bearer', 'Authorization: Bearer abcdef', '[REDACTED]'],
    ['password', 'password=hunter2', '[REDACTED]'],
  ];
  for (const [, input, marker] of samples) {
    const output = redact(input, '');
    if (!output.includes(marker) || secretShape(output)) throw new Error('redaction self-test failed');
  }
  if (safeCode('not safe!', 'FALLBACK') !== 'FALLBACK') throw new Error('code self-test failed');
  if (extractInstallerTimeline('12:00 step 8/8\n12:01 unrelated\n12:02 model probe').length !== 2) {
    throw new Error('timeline self-test failed');
  }
  if (!sha256(Buffer.from('probe')).match(/^[0-9a-f]{64}$/u)) throw new Error('hash self-test failed');
  if (redact('C:\\Users\\Probe\\x', 'C:\\Users\\Probe') !== '%USERPROFILE%\\x') {
    throw new Error('home redaction self-test failed');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, cases: 8 })}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  if (process.platform !== 'win32' || process.arch !== 'x64'
      || !process.versions.node.startsWith('22.') || process.versions.modules !== '127') {
    throw new Error('This probe requires native Windows x64 Node.js 22 ABI 127');
  }
  if (!options.processHelper || !fs.existsSync(options.processHelper)) {
    throw new Error('The pinned gateway process helper is missing');
  }
  const startedAt = new Date().toISOString();
  const home = os.homedir();
  const required = [
    'package.json',
    'config/openclaw.json',
    'node_modules/openclaw/dist/entry.js',
    'scripts/runtime-readiness.mjs',
    'scripts/run.sh',
  ];
  const requiredFiles = required.map((relative) => ({
    relative,
    ...fileMetadata(path.join(options.rcRoot, ...relative.split('/'))),
  }));
  const head = readGitHead(options.rcRoot);
  const sourceOk = requiredFiles.every((entry) => entry.present && entry.type === 'file')
    && (!options.expectedHead || head === options.expectedHead);
  const profile = readProfileReceipt(options.rcRoot);
  const plugins = pluginSummary();
  const installTransactionGreen = sourceOk && profile.present && profile.id === 'weifang-university-thermoelectrics'
    && profile.revision === 1 && plugins.present && plugins.skills === 473;
  const listener = findListenerPid(PORT);
  const initialHttp = await httpHealth(PORT);
  const initialProcess = processSample(listener.pid, options.processHelper);
  let session = null;
  let runtimeInputError = null;
  try {
    const inputs = loadRuntimeInputs(options.rcRoot);
    session = await openDashboardSession({
      root: options.rcRoot,
      port: PORT,
      token: inputs.token,
      uiVersion: inputs.uiVersion,
      listenerPid: listener.pid,
      processHelper: options.processHelper,
    });
    inputs.token = null;
  } catch (error) {
    runtimeInputError = safeError(error, home);
  }
  const healthRpcGreen = Array.isArray(session?.healthRpcs)
    && session.healthRpcs.length > 0 && session.healthRpcs.every((entry) => entry.ok);
  const repeatedHttpGreen = Array.isArray(session?.httpSamples)
    && session.httpSamples.length > 0 && session.httpSamples.every((entry) => entry.ok);
  const repeatedProcessGreen = Array.isArray(session?.processSamples)
    && session.processSamples.length > 0
    && session.processSamples.every((entry) => entry?.gitDescendantCount === 0
      && entry?.console?.attached === true
      && entry?.console?.quickEditEnabled === false);
  const gatewayConsoleGreen = initialProcess?.gitDescendantCount === 0
    && initialProcess?.console?.attached === true
    && initialProcess?.console?.quickEditEnabled === false;
  const dashboardRuntimeGreen = initialHttp.ok && session?.connect?.ok === true
    && session?.configGet?.ok === true && healthRpcGreen && repeatedHttpGreen
    && repeatedProcessGreen && gatewayConsoleGreen && session?.tickCount > 0;

  const runLog = sanitizeLogTail(path.join(home, '.research-claw', 'logs', 'run-latest.log'), home);
  const gatewayLog = sanitizeLogTail(path.join(home, '.research-claw', 'logs', 'openclaw.log'), home);
  const installerLogPath = newestInstallerLog();
  const installerLog = installerLogPath ? sanitizeLogTail(installerLogPath, home) : { present: false };
  const installerTimeline = extractInstallerTimeline(installerLog.sanitizedTail);
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const nonce = crypto.randomBytes(4).toString('hex');
  const base = `Wentor-Runtime-Probe-${timestamp}-${nonce}`;
  const jsonPath = path.join(options.outputDir, `${base}.json`);
  const reportPath = path.join(options.outputDir, `${base}.txt`);
  fs.mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });

  const report = {
    schemaVersion: 1,
    probe: 'windows-post-install-runtime',
    startedAt,
    finishedAt: new Date().toISOString(),
    host: {
      ok: true,
      summary: `win32/x64 node=${process.versions.node} abi=${process.versions.modules}`,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      abi: process.versions.modules,
      osRelease: os.release(),
    },
    source: {
      ok: sourceOk,
      summary: `${requiredFiles.filter((entry) => entry.present).length}/${requiredFiles.length} files; head=${head ? head.slice(0, 12) : 'unknown'}`,
      head,
      expectedHead: options.expectedHead,
      requiredFiles,
    },
    install: {
      summary: `profile=${profile.id || 'absent'} revision=${String(profile.revision)}; plugins=${plugins.skills || 0}`,
      profile,
      plugins,
    },
    installTransactionGreen,
    dashboardRuntimeGreen,
    verdict: dashboardRuntimeGreen ? 'INSTALL_AND_RUNTIME_GREEN' : 'INSTALL_GREEN_RUNTIME_RED',
    consoleInputMode: options.consoleInputMode,
    quickEditEnabled: options.quickEditEnabled,
    consoleScope: 'gateway-process-console-direct',
    listener,
    initialHttp,
    initialProcess,
    session,
    runtimeInputError,
    installerTimeline,
    logs: { installer: installerLog, launcher: runLog, gateway: gatewayLog },
    reportPath,
    jsonPath,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const text = buildText(report);
  if (secretShape(json) || secretShape(text)) {
    throw new Error('Refusing to publish a report containing a secret shape');
  }
  fs.writeFileSync(jsonPath, json, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(reportPath, text, { flag: 'wx', mode: 0o600 });
  process.stdout.write(text);
}

main().catch((error) => {
  process.stderr.write(`Probe infrastructure failed: ${redact(error?.message || String(error))}\n`);
  process.exitCode = 1;
});
