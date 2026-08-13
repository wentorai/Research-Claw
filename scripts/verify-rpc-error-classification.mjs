#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createWriteStream, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runReadiness } from './runtime-readiness.mjs';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const entryPath = path.join(projectRoot, 'node_modules', 'openclaw', 'dist', 'entry.js');
const requireFromOpenClaw = createRequire(realpathSync(entryPath));
const WebSocket = requireFromOpenClaw('ws');
const corePath = path.join(projectRoot, 'extensions', 'research-claw-core');
const gatewayPort = Number(process.env.RC_TEST_GATEWAY_PORT ?? 28799);
const gatewayToken = 'rc-rpc-error-test';
const secret = 'rc-runtime-fixture-DEADBEEF-do-not-leak';

let tempRoot;
let gateway;
let rpcSocket;
let requestSequence = 0;
const queuedFrames = [];
const frameWaiters = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`refusing to use occupied port ${port}`));
    });
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

async function assertCoreBuildFresh() {
  const sourcePath = path.join(corePath, 'src', 'rpc-error.ts');
  const artifactPath = path.join(corePath, 'dist', 'src', 'rpc-error.js');
  let sourceStat;
  let artifactStat;
  try {
    [sourceStat, artifactStat] = await Promise.all([stat(sourcePath), stat(artifactPath)]);
  } catch {
    throw new Error(
      'core build missing; run `pnpm --dir extensions/research-claw-core build` before verification',
    );
  }
  if (artifactStat.mtimeMs < sourceStat.mtimeMs) {
    throw new Error(
      'core build is stale; run `pnpm --dir extensions/research-claw-core build` before verification',
    );
  }
}

function isolatedEnv() {
  return {
    ...process.env,
    HOME: path.join(tempRoot, 'home'),
    OPENCLAW_STATE_DIR: path.join(tempRoot, 'state'),
    OPENCLAW_CONFIG_PATH: path.join(tempRoot, 'state', 'openclaw.json'),
  };
}

async function writeConfig() {
  const stateDir = path.join(tempRoot, 'state');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const databasePath = path.join(tempRoot, 'data', 'library.db');
  await Promise.all([
    mkdir(path.join(tempRoot, 'home'), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(path.join(tempRoot, 'data'), { recursive: true }),
    mkdir(path.join(tempRoot, 'logs'), { recursive: true }),
  ]);
  await writeFile(
    path.join(stateDir, 'openclaw.json'),
    JSON.stringify({
      gateway: {
        mode: 'local',
        auth: { mode: 'token', token: gatewayToken },
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
          allowedOrigins: ['http://127.0.0.1:5175'],
        },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          skipBootstrap: true,
        },
      },
      logging: {
        level: 'debug',
        file: path.join(tempRoot, 'logs', 'openclaw.log'),
      },
      plugins: {
        enabled: true,
        allow: ['research-claw-core'],
        load: { paths: [corePath] },
        entries: {
          'research-claw-core': {
            enabled: true,
            hooks: { allowConversationAccess: true },
            config: {
              dbPath: databasePath,
              autoTrackGit: false,
              pptRoot: path.join(tempRoot, 'ppt'),
            },
          },
        },
      },
    }, null, 2),
  );
}

async function waitForHealth() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
      if (response.ok) return;
    } catch {
      // Gateway is still starting.
    }
    if (gateway?.exitCode !== null) {
      throw new Error(`gateway exited during startup with code ${gateway.exitCode}`);
    }
    await sleep(100);
  }
  throw new Error('gateway health check timed out');
}

async function startGateway() {
  const output = createWriteStream(path.join(tempRoot, 'logs', 'gateway-console.log'), {
    flags: 'a',
  });
  gateway = spawn(
    process.execPath,
    [
      entryPath,
      'gateway',
      '--port',
      String(gatewayPort),
      '--bind',
      'loopback',
      '--token',
      gatewayToken,
      'run',
    ],
    {
      cwd: projectRoot,
      env: isolatedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  gateway.stdout.pipe(output);
  gateway.stderr.pipe(output);
  await waitForHealth();
}

function dispatchFrame(frame) {
  const index = frameWaiters.findIndex(waiter => waiter.predicate(frame));
  if (index >= 0) {
    const [waiter] = frameWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  } else {
    queuedFrames.push(frame);
  }
}

function waitForFrame(predicate, timeoutMs = 10_000) {
  const queuedIndex = queuedFrames.findIndex(predicate);
  if (queuedIndex >= 0) {
    return Promise.resolve(queuedFrames.splice(queuedIndex, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = frameWaiters.indexOf(waiter);
        if (index >= 0) frameWaiters.splice(index, 1);
        reject(new Error('gateway response timed out'));
      }, timeoutMs),
    };
    frameWaiters.push(waiter);
  });
}

async function connectRpcSocket() {
  rpcSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}`, {
    headers: { Origin: 'http://127.0.0.1:5175' },
  });
  rpcSocket.on('message', data => {
    try {
      dispatchFrame(JSON.parse(data.toString('utf8')));
    } catch {
      // Ignore non-JSON gateway frames.
    }
  });
  await new Promise((resolve, reject) => {
    rpcSocket.once('open', resolve);
    rpcSocket.once('error', reject);
  });
  await waitForFrame(frame =>
    frame.type === 'event' && frame.event === 'connect.challenge');

  const id = `connect-${++requestSequence}`;
  rpcSocket.send(JSON.stringify({
    type: 'req',
    id,
    method: 'connect',
    params: {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: 'openclaw-control-ui',
        version: 'rpc-error-verifier',
        platform: 'node',
        mode: 'webchat',
        displayName: 'RPC error verifier',
      },
      caps: [],
      role: 'operator',
      scopes: ['operator.admin'],
      auth: { token: gatewayToken },
    },
  }));
  const response = await waitForFrame(frame => frame.type === 'res' && frame.id === id);
  if (!response.ok) {
    throw new Error(`gateway connect failed: ${JSON.stringify(response.error)}`);
  }
}

async function gatewayRequest(method, params) {
  const id = `request-${++requestSequence}`;
  rpcSocket.send(JSON.stringify({ type: 'req', id, method, params }));
  return waitForFrame(frame => frame.type === 'res' && frame.id === id);
}

async function gatewayCallExpectError(method, params) {
  const response = await gatewayRequest(method, params);
  if (response.ok) throw new Error(`${method} unexpectedly succeeded`);
  return response;
}

function readMessage(record) {
  for (const key of ['msg', 'message', '1']) {
    if (typeof record?.[key] === 'string') return record[key];
  }
  return JSON.stringify(record);
}

async function waitForLog(fragment) {
  const logPath = path.join(tempRoot, 'logs', 'openclaw.log');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (readMessage(record).includes(fragment)) return record;
        } catch {
          if (line.includes(fragment)) return { level: null, message: line };
        }
      }
    } catch {
      // Log file has not been created yet.
    }
    await sleep(100);
  }
  throw new Error(`log entry not found: ${fragment}`);
}

function assertLogLevel(record, expected) {
  const actual =
    record.level ??
    record.levelName ??
    record.severity ??
    record._meta?.logLevelName ??
    record._meta?.logLevelId;
  const accepted = expected === 'debug'
    ? [2, 20, 'debug', 'DEBUG']
    : expected === 'warn'
      ? [4, 40, 'warn', 'WARN', 'WARNING']
      : [5, 50, 'error', 'ERROR'];
  if (!accepted.includes(actual)) {
    throw new Error(`expected ${expected} log level, got ${JSON.stringify(actual)}`);
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(3_000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function cleanup() {
  if (rpcSocket) {
    rpcSocket.close(1000, 'verification complete');
    rpcSocket = undefined;
  }
  await stopChild(gateway);
  if (tempRoot && process.env.RC_KEEP_TEST_ARTIFACTS !== '1') {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  await assertCoreBuildFresh();
  await assertPortFree(gatewayPort);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-rpc-error-'));
  await writeConfig();
  await startGateway();
  const readiness = await runReadiness({
    root: projectRoot,
    configPath: path.join(tempRoot, 'state', 'openclaw.json'),
    port: gatewayPort,
    token: gatewayToken,
    timeout: 5_000,
  });
  if (!readiness.ok) {
    throw new Error(`Core capability readiness failed: ${JSON.stringify(readiness)}`);
  }
  await connectRpcSocket();

  const domainResponse = await gatewayCallExpectError('rc.lit.get', {
    id: 'missing-paper-runtime-fixture',
  });
  if (String(domainResponse.error?.code) !== '-32001') {
    throw new Error(`numeric domain code was not transmitted: ${JSON.stringify(domainResponse)}`);
  }
  const domainLog = await waitForLog('RPC rc.lit.get failed [-32001]');
  assertLogLevel(domainLog, 'warn');

  const secretResponse = await gatewayCallExpectError('rc.ws.read', {
    path: `fixtures/apiKey=${secret}.txt`,
  });
  if (String(secretResponse.error?.code) !== '-32002') {
    throw new Error(`coded WorkspaceError was not transmitted: ${JSON.stringify(secretResponse)}`);
  }
  const secretLog = await waitForLog('RPC rc.ws.read deferred [-32002]');
  assertLogLevel(secretLog, 'debug');

  const unexpectedResponse = await gatewayCallExpectError('rc.session.autoName', {});
  if (unexpectedResponse.error?.code !== 'PLUGIN_ERROR') {
    throw new Error(`unexpected error was not classified as PLUGIN_ERROR: ${JSON.stringify(unexpectedResponse)}`);
  }
  const unexpectedLog = await waitForLog('RPC rc.session.autoName failed [PLUGIN_ERROR]');
  assertLogLevel(unexpectedLog, 'error');
  const unexpectedText = readMessage(unexpectedLog);
  if (!unexpectedText.includes('\n') || !/session-naming\/rpc\.(?:ts|js)/.test(unexpectedText)) {
    throw new Error('unexpected error log did not preserve its runtime stack');
  }

  const allLogs = await readFile(path.join(tempRoot, 'logs', 'openclaw.log'), 'utf8');
  if (JSON.stringify(secretResponse).includes(secret) || allLogs.includes(secret)) {
    throw new Error('secret leaked through RPC response or gateway log');
  }

  console.log(JSON.stringify({
    readiness: {
      core: readiness.core,
      probes: readiness.probes.map(({ method, ok }) => ({ method, ok })),
    },
    domain: { code: '-32001', level: 'warn' },
    codedError: { code: '-32002', level: 'debug', secretLeaked: false },
    unexpected: { code: 'PLUGIN_ERROR', level: 'error', stack: true },
    gatewayPort,
  }, null, 2));
}

process.once('SIGINT', () => {
  void cleanup().finally(() => process.exit(130));
});
process.once('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143));
});

try {
  await main();
} catch (error) {
  for (const name of ['gateway-console.log', 'openclaw.log']) {
    try {
      const content = await readFile(path.join(tempRoot, 'logs', name), 'utf8');
      const relevant = content
        .split('\n')
        .filter(line => line.includes('research-claw-core') || line.includes('RPC rc.'))
        .join('\n');
      if (relevant) console.error(`[${name}]\n${relevant}`);
    } catch {
      // Best-effort diagnostics only.
    }
  }
  throw error;
} finally {
  await cleanup();
}
