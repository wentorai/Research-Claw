#!/usr/bin/env node

/**
 * Real OpenClaw 2026.6.1 cold-start probe for peripherals product policy.
 *
 * Each policy state runs in a fresh child process with isolated HOME/state,
 * SQLite, workspace, Gateway, and loopback-only deterministic provider. The
 * parent executes enabled → disabled → enabled-hidden to prove restart-only
 * removal and restoration without reading user state or a paid API.
 */

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openClawEntry = path.join(projectRoot, 'node_modules', 'openclaw', 'dist', 'entry.js');
const requiredOpenClawVersion = '2026.6.1';
const inventoryPath = path.join(projectRoot, 'test', 'fixtures', 'peripherals-policy-enabled-inventory-0.8.2.json');
const corePluginPath = path.join(projectRoot, 'extensions', 'research-claw-core');
const fakePlaudMcpPath = path.join(projectRoot, 'test', 'fixtures', 'fake-plaud-inventory-mcp-server.cjs');
const workerState = process.argv[2] === '--worker' ? process.argv[3] : null;
const gatewayToken = 't07-isolated-gateway-token';
const fixtureProfileId = 'fixture:managed';
const fixtureSecret = 't07-explicit-fake-secret';
const sessionKey = 'agent:main:main';
const CLI_TIMEOUT_MS = 30_000;
const WORKER_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.RC_T07_PROBE_WORKER_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 90_000;
})();
const HOST_CREDENTIAL_OR_PROXY_ENV_RE = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|BEARER|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)(?:$|_)/i;
const WORKER_ENV_ALLOWLIST = new Set([
  'PATH', 'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot',
  'WINDIR', 'HOME', 'USERPROFILE',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH',
  'NO_PROXY', 'no_proxy',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI',
  // macOS inserts this CoreFoundation locale marker even when execFile receives
  // an explicit env object; it carries no credential, endpoint, or user path.
  '__CF_USER_TEXT_ENCODING',
  'NODE_ENV', 'RC_T07_PROBE_FAULT', 'RC_T07_PROBE_PAUSE_AFTER_AUTH_WRITE',
  'RC_T07_PROBE_INCLUDE_PLAUD_MCP',
]);

let tempRoot;
let provider;
let gateway;
let gatewaySpawnEnv;
let providerBodies = [];
let providerAuthorizations = [];
let gatewayStderr = '';
let cleanupPromise;
const activeWorkers = new Set();

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function parseJson(stdout) {
  const source = stdout.trim();
  for (let index = source.indexOf('{'); index >= 0; index = source.indexOf('{', index + 1)) {
    try { return JSON.parse(source.slice(index)); } catch { /* launcher banner */ }
  }
  throw new Error(`OpenClaw output did not contain JSON: ${source.slice(0, 500)}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  invariant(address && typeof address === 'object', 'failed to reserve an ephemeral port');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function isolatedEnv() {
  const inherited = {};
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot',
    'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI',
  ]) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  return {
    ...inherited,
    HOME: path.join(tempRoot, 'home'),
    USERPROFILE: path.join(tempRoot, 'home'),
    XDG_CACHE_HOME: path.join(tempRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(tempRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(tempRoot, 'xdg-data'),
    XDG_STATE_HOME: path.join(tempRoot, 'xdg-state'),
    TMPDIR: path.join(tempRoot, 'tmp'),
    TMP: path.join(tempRoot, 'tmp'),
    TEMP: path.join(tempRoot, 'tmp'),
    OPENCLAW_STATE_DIR: path.join(tempRoot, 'state'),
    OPENCLAW_CONFIG_PATH: path.join(tempRoot, 'state', 'openclaw.json'),
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
}

async function runCli(args, timeoutMs = CLI_TIMEOUT_MS) {
  const { stdout } = await execFileAsync(process.execPath, [openClawEntry, ...args], {
    cwd: projectRoot,
    env: isolatedEnv(),
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function startProvider() {
  provider = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'healthy', owned_by: 'fixture' }] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      providerBodies.push(body);
      providerAuthorizations.push(request.headers.authorization ?? null);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-t07',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'healthy',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'T07 complete' }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-t07',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'healthy',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  invariant(address && typeof address === 'object', 'provider did not bind');
  return address.port;
}

async function writeFixture(state, providerPort) {
  const home = path.join(tempRoot, 'home');
  const stateDir = path.join(tempRoot, 'state');
  const workspace = path.join(tempRoot, 'workspace');
  const rcDir = path.join(workspace, '.ResearchClaw');
  const agentDir = path.join(stateDir, 'agents', 'main', 'agent');
  const authPath = path.join(agentDir, 'auth-profiles.json');
  const probePluginDir = path.join(tempRoot, 'core-source-plugin');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(rcDir, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(path.join(tempRoot, 'tmp'), { recursive: true }),
    mkdir(probePluginDir, { recursive: true }),
  ]);
  const sourceManifest = JSON.parse(await readFile(path.join(corePluginPath, 'openclaw.plugin.json'), 'utf8'));
  await writeFile(path.join(probePluginDir, 'package.json'), `${JSON.stringify({
    name: '@research-claw/t07-source-probe',
    version: '0.0.0-probe',
    private: true,
    type: 'module',
    main: 'index.ts',
    openclaw: { extensions: ['./index.ts'] },
  }, null, 2)}\n`);
  await writeFile(path.join(probePluginDir, 'openclaw.plugin.json'), `${JSON.stringify({
    ...sourceManifest,
    main: 'index.ts',
  }, null, 2)}\n`);
  await writeFile(
    path.join(probePluginDir, 'index.ts'),
    `export { default } from ${JSON.stringify(pathToFileURL(path.join(corePluginPath, 'index.ts')).href)};\n`,
  );
  await writeFile(path.join(rcDir, 'AGENTS.md'), [
    '# T07 bootstrap contract',
    '## §10 Preserved Before',
    'T07_KEEP_BEFORE',
    '## §11 Peripherals',
    'T07_PERIPHERAL_SENTINEL periph_list source_type=device',
    '## §12 Preserved After',
    'T07_KEEP_AFTER',
    '',
  ].join('\n'));
  const coreConfig = {
    dbPath: path.join(tempRoot, 'library.db'),
    workspace: { root: workspace },
    ...(state === 'enabled' ? {} : {
      productPolicy: {
        capabilities: {
          settings: 'enabled-hidden',
          extensions: 'enabled-hidden',
          supervisor: 'enabled-hidden',
          peripherals: state,
        },
      },
    }),
  };
  const includePlaudMcp = process.env.RC_T07_PROBE_INCLUDE_PLAUD_MCP === '1';
  await writeFile(path.join(stateDir, 'openclaw.json'), `${JSON.stringify({
    gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token: gatewayToken } },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: 'fixture/healthy' },
        timeoutSeconds: 15,
      },
    },
    models: {
      mode: 'merge',
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          // A profile ID here prevents OC from materializing the resolved key
          // into generated provider catalogs. The plaintext exists only in the
          // 0600 auth store below.
          apiKey: fixtureProfileId,
          api: 'openai-completions',
          models: [{
            id: 'healthy', name: 'T07 deterministic fixture', reasoning: false,
            input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000, maxTokens: 128,
          }],
        },
      },
    },
    auth: {
      profiles: { [fixtureProfileId]: { provider: 'fixture', mode: 'api_key' } },
      order: { fixture: [fixtureProfileId] },
    },
    ...(includePlaudMcp ? {
      mcp: {
        servers: {
          plaud: { command: process.execPath, args: [fakePlaudMcpPath] },
        },
      },
    } : {}),
    skills: { allowBundled: ['rc-t07-no-bundled-skills'] },
    plugins: {
      enabled: true,
      allow: ['research-claw-core'],
      // Force both startup/discovery and agent-runtime passes through current
      // TypeScript source. A stale ignored dist/ artifact must not influence a
      // clean-checkout contract test.
      load: { paths: [probePluginDir] },
      entries: {
        'research-claw-core': {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: coreConfig,
        },
      },
    },
    logging: { level: 'debug', file: path.join(tempRoot, 'openclaw.log') },
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(authPath, `${JSON.stringify({
    version: 1,
    profiles: { [fixtureProfileId]: { type: 'api_key', provider: 'fixture', key: fixtureSecret } },
  }, null, 2)}\n`, { mode: 0o600 });
  await Promise.all([
    chmod(path.join(stateDir, 'openclaw.json'), 0o600),
    chmod(authPath, 0o600),
  ]);
  if (
    process.env.NODE_ENV === 'test'
    && process.env.RC_T07_PROBE_FAULT === 'after-auth-write'
  ) {
    throw new Error('injected failure after auth store write');
  }
  return { workspace, authPath };
}

async function pauseAfterAuthWriteForSignalTest() {
  if (
    process.env.NODE_ENV !== 'test'
    || process.env.RC_T07_PROBE_PAUSE_AFTER_AUTH_WRITE !== '1'
  ) return;
  const markerPath = path.join(tempRoot, '.signal-test-ready');
  const markerTempPath = `${markerPath}.${process.pid}.tmp`;
  await writeFile(
    markerTempPath,
    `${JSON.stringify({ pid: process.pid })}\n`,
    { mode: 0o600 },
  );
  // The parent may signal the instant the marker appears. Publish it by atomic
  // same-directory rename so the reader never observes a zero/partial JSON file.
  await rename(markerTempPath, markerPath);
  await new Promise(() => {});
}

async function waitForGateway(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch { /* starting */ }
    if (gateway && childExited(gateway)) throw new Error(`gateway exited: ${gatewayStderr.slice(-4000)}`);
    await sleep(100);
  }
  throw new Error(`gateway health timeout: ${gatewayStderr.slice(-4000)}`);
}

async function startGateway() {
  const port = await reservePort();
  gatewaySpawnEnv = isolatedEnv();
  gateway = spawn(
    process.execPath,
    [openClawEntry, 'gateway', '--port', String(port), '--bind', 'loopback', '--token', gatewayToken, 'run'],
    { cwd: projectRoot, env: gatewaySpawnEnv, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  gateway.stderr.setEncoding('utf8');
  gateway.stderr.on('data', (chunk) => {
    if (gatewayStderr.length < 200_000) gatewayStderr += chunk;
  });
  await waitForGateway(port);
  return port;
}

async function stopGateway() {
  if (!gateway) return;
  const child = gateway;
  if (!childExited(child)) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5_000)]);
    if (!childExited(child)) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  gateway = undefined;
  gatewaySpawnEnv = undefined;
}

async function gatewayRequest(port, method, params = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  return await new Promise((resolve, reject) => {
    let connected = false;
    let requestId = '';
    const timer = setTimeout(() => reject(new Error(`gateway ${method} timeout`)), 15_000);
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        requestId = randomUUID();
        socket.send(JSON.stringify({
          type: 'req', id: requestId, method: 'connect',
          params: {
            minProtocol: 4, maxProtocol: 4,
            // OC 2026.6.1 explicitly permits a shared-secret loopback backend
            // client to self-pair with the requested operator scopes. This is
            // the production gateway-client identity, not a whitelist bypass.
            client: { id: 'gateway-client', version: requiredOpenClawVersion, platform: process.platform, mode: 'backend' },
            role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'],
            auth: { token: gatewayToken },
          },
        }));
      } else if (frame.type === 'res' && frame.id === requestId) {
        if (!frame.ok) {
          clearTimeout(timer);
          socket.close();
          reject(Object.assign(new Error(frame.error?.message ?? JSON.stringify(frame.error)), { gatewayError: frame.error }));
          return;
        }
        if (!connected) {
          connected = true;
          if (method === 'connect') {
            clearTimeout(timer);
            socket.close();
            resolve(frame.payload);
            return;
          }
          requestId = randomUUID();
          socket.send(JSON.stringify({ type: 'req', id: requestId, method, params }));
          return;
        }
        clearTimeout(timer);
        socket.close();
        resolve(frame.payload);
      }
    });
    socket.addEventListener('error', () => reject(new Error('gateway websocket failed')));
  });
}

async function gatewayCall(port, method, params, allowFailure = false) {
  try {
    return { ok: true, payload: await gatewayRequest(port, method, params) };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      ok: false,
      error: error?.gatewayError ?? { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function waitForPromptReport() {
  const sessionsPath = path.join(tempRoot, 'state', 'agents', 'main', 'sessions', 'sessions.json');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const store = JSON.parse(await readFile(sessionsPath, 'utf8'));
      if (store[sessionKey]?.systemPromptReport?.source === 'run') return store[sessionKey].systemPromptReport;
    } catch { /* run not persisted */ }
    await sleep(100);
  }
  throw new Error('systemPromptReport was not persisted');
}

async function waitForRuntimeReconciliation() {
  const logPath = path.join(tempRoot, 'openclaw.log');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const content = await readFile(logPath, 'utf8').catch(() => '');
    if (content.includes('[self-check] runtime reconciliation passed')) return content;
    await sleep(100);
  }
  return await readFile(logPath, 'utf8').catch(() => '');
}

async function cleanup() {
  await stopActiveWorkers();
  await stopGateway();
  if (provider) {
    provider.closeAllConnections?.();
    await new Promise((resolve) => provider.close(resolve));
    provider = undefined;
  }
  if (tempRoot && process.env.RC_KEEP_TEST_ARTIFACTS !== '1') {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function stopActiveWorkers() {
  for (const child of [...activeWorkers]) {
    if (childExited(child)) continue;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(5_000),
    ]);
    if (!childExited(child)) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
}

function cleanupOnce() {
  cleanupPromise ??= cleanup();
  return cleanupPromise;
}

async function listRegularFiles(root) {
  const output = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) output.push(target);
    }
  };
  await walk(root);
  return output;
}

async function assertCredentialSingleCopy(authPath) {
  if (process.platform !== 'win32') {
    const authMode = (await stat(authPath)).mode & 0o777;
    invariant(authMode === 0o600, `auth store mode was ${authMode.toString(8)}, expected 600`);
  }
  let copies = 0;
  for (const file of await listRegularFiles(tempRoot)) {
    const content = await readFile(file);
    if (content.includes(Buffer.from(fixtureSecret))) {
      invariant(file === authPath, `fixture secret leaked outside auth store: ${path.relative(tempRoot, file)}`);
      copies += 1;
    }
  }
  invariant(copies === 1, `expected exactly one fixture secret copy, found ${copies}`);
}

async function runWorker(state) {
  invariant(['enabled', 'enabled-hidden', 'disabled'].includes(state), `invalid state: ${state}`);
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const coreManifest = JSON.parse(await readFile(path.join(corePluginPath, 'openclaw.plugin.json'), 'utf8'));
  const workerCredentialOrProxyEnvNames = Object.keys(process.env)
    .filter((name) => HOST_CREDENTIAL_OR_PROXY_ENV_RE.test(name))
    .sort();
  const workerUnexpectedEnvNames = Object.keys(process.env)
    .filter((name) => !WORKER_ENV_ALLOWLIST.has(name))
    .sort();
  invariant(
    workerCredentialOrProxyEnvNames.length === 0,
    `host credential/proxy env reached probe worker: ${workerCredentialOrProxyEnvNames.join(',')}`,
  );
  invariant(
    workerUnexpectedEnvNames.length === 0,
    `non-allowlisted host env reached probe worker: ${workerUnexpectedEnvNames.join(',')}`,
  );
  tempRoot = await mkdtemp(path.join(os.tmpdir(), `rc-t07-peripherals-${state}-`));
  const providerPort = await startProvider();
  const { workspace, authPath } = await writeFixture(state, providerPort);
  await pauseAfterAuthWriteForSignalTest();
  const port = await startGateway();
  const includePlaudMcp = process.env.RC_T07_PROBE_INCLUDE_PLAUD_MCP === '1';
  invariant(gatewaySpawnEnv, 'Gateway spawn environment was not captured');
  const gatewayEnv = gatewaySpawnEnv;
  const forwardedCredentialOrProxyEnvNames = Object.keys(gatewayEnv)
    .filter((name) => HOST_CREDENTIAL_OR_PROXY_ENV_RE.test(name))
    .sort();
  invariant(
    forwardedCredentialOrProxyEnvNames.length === 0,
    `host credential/proxy env reached Gateway: ${forwardedCredentialOrProxyEnvNames.join(',')}`,
  );
  invariant(
    gatewayEnv.OPENCLAW_STATE_DIR.startsWith(`${tempRoot}${path.sep}`)
      && gatewayEnv.OPENCLAW_CONFIG_PATH.startsWith(`${tempRoot}${path.sep}`)
      && gatewayEnv.HOME.startsWith(`${tempRoot}${path.sep}`)
      && gatewayEnv.TMPDIR.startsWith(`${tempRoot}${path.sep}`),
    'Gateway state/home/tmp escaped the isolated probe root',
  );
  const hello = await gatewayRequest(port, 'connect');
  const methods = hello?.features?.methods ?? [];
  await gatewayCall(port, 'chat.send', {
    message: 'Reply briefly for the T07 isolated policy probe.',
    sessionKey,
    idempotencyKey: randomUUID(),
  });
  const report = await waitForPromptReport();
  const toolNames = report.tools.entries.map((entry) => entry.name).sort();
  const plaudMcpTools = toolNames.filter((name) => name.startsWith('plaud__'));
  const peripheralTools = inventory.agentTools.peripherals;
  const peripheralRpc = inventory.gatewayRpc.peripherals;
  const disabled = state === 'disabled';
  const staleRpc = await gatewayCall(port, peripheralRpc[0], {}, true);
  const monitorList = await gatewayCall(port, 'rc.monitor.list', {});
  const promptBody = providerBodies.join('\n');
  const pluginLog = await waitForRuntimeReconciliation();
  const rtspRoot = path.join(tempRoot, 'tmp', 'rc-rtsp-preview');
  const rtspTempRootExists = await lstat(rtspRoot).then((info) => info.isDirectory()).catch(() => false);
  const hlsResponse = await fetch(
    `http://127.0.0.1:${port}/rc/rtsp-preview/t07-missing/index.m3u8`,
    { headers: { authorization: `Bearer ${gatewayToken}` } },
  );
  const hlsBody = await hlsResponse.text();
  const expectedCoreTools = disabled
    ? inventory.agentTools.coreTotal - inventory.agentTools.peripherals.length
    : inventory.agentTools.coreTotal;
  const expectedCoreRpc = disabled
    ? inventory.gatewayRpc.coreTotal - inventory.gatewayRpc.peripherals.length
    : inventory.gatewayRpc.coreTotal;
  const coreToolNames = toolNames.filter((name) => coreManifest.contracts.tools.includes(name));
  const coreRpcMethods = methods.filter((method) => method.startsWith('rc.'));

  invariant(peripheralTools.every((name) => toolNames.includes(name) === !disabled), 'peripheral tool inventory mismatch');
  invariant(
    peripheralRpc.every((name) => methods.includes(name) === !disabled),
    `peripheral RPC inventory mismatch: ${JSON.stringify(peripheralRpc.filter((name) => methods.includes(name)))}`,
  );
  invariant(promptBody.includes('T07_KEEP_BEFORE') && promptBody.includes('T07_KEEP_AFTER'), 'bootstrap preservation markers missing');
  invariant(promptBody.includes('T07_PERIPHERAL_SENTINEL') === !disabled, 'bootstrap peripheral section policy mismatch');
  invariant(!disabled || !/periph_list|source_type.?device/i.test(promptBody), 'disabled prompt leaked peripheral guidance');
  invariant(!disabled || !staleRpc.ok, 'stale peripheral RPC unexpectedly succeeded');
  invariant(!disabled || /unknown method|INVALID_REQUEST/i.test(JSON.stringify(staleRpc.error)), 'stale RPC did not return feature-unavailable wire semantics');
  invariant(monitorList.ok, 'non-device monitor RPC failed');
  invariant(
    providerAuthorizations.length > 0
      && providerAuthorizations.every((value) => value === `Bearer ${fixtureSecret}`),
    'provider did not resolve the bound auth profile credential',
  );
  invariant(pluginLog.includes('[self-check] plugin activation audit passed'), 'Core activation self-check did not pass');
  invariant(pluginLog.includes('[self-check] runtime reconciliation passed'), 'Core runtime reconciliation did not pass');
  invariant(!pluginLog.includes('plugin activation audit failed'), 'Core entered a global activation failure');
  for (const tool of peripheralTools) {
    invariant(
      pluginLog.includes(`${tool} intentionally not registered`) === disabled,
      `intentional omission audit mismatch for ${tool}`,
    );
  }
  invariant(rtspTempRootExists === !disabled, 'RTSP manager construction side effect mismatch');
  invariant(coreToolNames.length === expectedCoreTools, `Core tool count mismatch: ${coreToolNames.length}`);
  invariant(coreRpcMethods.length === expectedCoreRpc, `Core RPC count mismatch: ${coreRpcMethods.length}`);
  invariant(
    hlsBody.includes('NO_SESSION') === !disabled,
    `HLS route registration mismatch (${hlsResponse.status}): ${hlsBody.slice(0, 200)}`,
  );
  await assertCredentialSingleCopy(authPath);

  return {
    state,
    isolation: 'loopback-only-mkdtemp',
    runtimeBoundary: {
      gateway: 'loopback-websocket',
      provider: 'loopback-http',
      plaudMcp: includePlaudMcp ? 'local-stdio-fixture' : 'absent',
      workerUnexpectedEnvNames,
      workerForwardedCredentialOrProxyEnvNames: workerCredentialOrProxyEnvNames,
      gatewayForwardedCredentialOrProxyEnvNames: forwardedCredentialOrProxyEnvNames,
      homeStateAndTmpUnderMkdtemp: true,
    },
    workspace: workspace.replace(tempRoot, '<mkdtemp>'),
    toolInventory: {
      coreCount: coreToolNames.length,
      peripheralCount: toolNames.filter((name) => peripheralTools.includes(name)).length,
      allExpectedPresent: peripheralTools.every((name) => toolNames.includes(name)),
      plaudMcpTools,
    },
    rpcInventory: {
      coreCount: coreRpcMethods.length,
      peripheralCount: methods.filter((name) => peripheralRpc.includes(name)).length,
      staleRpc: staleRpc.ok ? 'available' : 'feature-unavailable',
    },
    prompt: {
      preservedBefore: promptBody.includes('T07_KEEP_BEFORE'),
      preservedAfter: promptBody.includes('T07_KEEP_AFTER'),
      peripheralSectionPresent: promptBody.includes('T07_PERIPHERAL_SENTINEL'),
    },
    nonDeviceMonitorRpc: monitorList.ok,
    pluginHealthy: !pluginLog.includes('plugin activation audit failed'),
    rtspTempRootObserved: rtspTempRootExists,
    hlsRoute: hlsBody.includes('NO_SESSION') ? 'registered' : 'absent',
    credentialSecretCopies: 1,
    authStoreMode: process.platform === 'win32' ? 'windows-acl-not-asserted' : '0600',
  };
}

async function runParent() {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'node_modules', 'openclaw', 'package.json'), 'utf8'));
  invariant(manifest.version === requiredOpenClawVersion, `requires OpenClaw ${requiredOpenClawVersion}`);
  const states = ['enabled', 'disabled', 'enabled-hidden'];
  const results = [];
  for (const state of states) {
    const rootsBefore = await listProbeRootNames();
    try {
      const { stdout } = await runWorkerChild(state);
      results.push(JSON.parse(stdout));
    } catch (error) {
      // execFile's timeout sends SIGTERM to the worker; wait for its async
      // cleanup handler before surfacing the parent failure. This also covers a
      // worker's ordinary non-zero exit, whose own catch/finally removes state.
      await waitForProbeRootsToDisappear(rootsBefore);
      throw error;
    }
  }
  process.stdout.write(`${JSON.stringify({
    openClawVersion: requiredOpenClawVersion,
    coldRestartSequence: states,
    results,
  }, null, 2)}\n`);
}

function runWorkerChild(state) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [fileURLToPath(import.meta.url), '--worker', state],
      {
        cwd: projectRoot,
        timeout: WORKER_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: isolatedParentEnv(),
      },
      (error, stdout, stderr) => {
        activeWorkers.delete(child);
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    activeWorkers.add(child);
  });
}

async function listProbeRootNames() {
  const tempParent = process.env.TMPDIR || process.env.TMP || process.env.TEMP || os.tmpdir();
  try {
    return new Set((await readdir(tempParent)).filter((name) => name.startsWith('rc-t07-peripherals-')));
  } catch {
    return new Set();
  }
}

async function waitForProbeRootsToDisappear(preexisting) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await listProbeRootNames();
    if (![...current].some((name) => !preexisting.has(name))) return;
    await sleep(20);
  }
  throw new Error('peripherals policy worker state survived parent failure boundary');
}

function isolatedParentEnv() {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.env.NODE_ENV === 'test') {
    env.NODE_ENV = 'test';
    for (const key of ['RC_T07_PROBE_FAULT', 'RC_T07_PROBE_PAUSE_AFTER_AUTH_WRITE']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  // This is a non-faulting, default-off diagnostic switch used to document
  // the T04 boundary in either worker or full cold-restart mode.
  if (process.env.RC_T07_PROBE_INCLUDE_PLAUD_MCP !== undefined) {
    env.RC_T07_PROBE_INCLUDE_PLAUD_MCP = process.env.RC_T07_PROBE_INCLUDE_PLAUD_MCP;
  }
  return env;
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    void cleanupOnce().finally(() => {
      process.stderr.write(`peripherals policy probe interrupted by ${signal}; temporary state cleaned\n`);
      process.exit(code);
    });
  });
}

try {
  if (workerState) {
    const result = await runWorker(workerState);
    await cleanupOnce();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    await runParent();
  }
} catch (error) {
  await cleanupOnce();
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
