#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { runReadiness } from './runtime-readiness.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const applier = require('./bootstrap-profile/applier.cjs');
const { ensureInitialized } = require('./bootstrap-profile/maintenance-lease.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openClawEntry = path.join(root, 'node_modules', 'openclaw', 'dist', 'entry.js');
const openClawPackage = path.join(root, 'node_modules', 'openclaw', 'package.json');
const capsuleFixture = path.join(root, 'profiles', 'fixtures', 'thermoelectric-user-a', 'capsule.json');
const certPath = path.join(root, 'test', 'fixtures', 'bootstrap-profile-e2e-provider.cert.pem');
const keyPath = path.join(root, 'test', 'fixtures', 'bootstrap-profile-e2e-provider.key.pem');
const fakePlaudPath = path.join(root, 'test', 'fixtures', 'fake-plaud-inventory-mcp-server.cjs');
const modelProbeHelper = path.join(root, 'scripts', 'bootstrap-profile', 'model-probe.cjs');
const expectedOpenClawVersion = '2026.6.1';
const gatewayToken = 't09-isolated-gateway-token';
const ordinaryKey = 'RC_T09_ORDINARY_FAKE_KEY';
const initialKey = 'RC_T09_INITIAL_FAKE_KEY';
const failedKey = 'RC_T09_FAILED_PROBE_FAKE_KEY';
const rotatedKey = 'RC_T09_ROTATED_FAKE_KEY';
const switchedKey = 'RC_T09_SWITCHED_FAKE_KEY';
const conversationPrompt = 'T09 ordinary deterministic conversation.';
const dangerPrompt = 'T09 ask the agent to execute the deliberately dangerous fixture command.';
const tasks = [
  {
    expectedSkill: 'research-thermoelectric-semiconductors',
    reference: 'references/research-methodology.md',
    prompt: '请为新的热电半导体发电材料建立从输运物理到器件的可证伪研究路线。',
  },
  {
    expectedSkill: 'develop-flexible-bismuth-telluride',
    reference: 'references/benchmarking-and-reliability.md',
    prompt: '请设计柔性碲化铋薄膜可穿戴发电器的弯折可靠性和器件基准测试。',
  },
  {
    expectedSkill: 'engineer-gete-thermoelectrics',
    reference: 'references/devices-and-reliability.md',
    prompt: '请设计GeTe热电材料到扩散阻挡层、单腿和模块的可靠性研究。',
  },
];

let tempRoot;
let provider;
let gateway;
let gatewayStderr = '';
let cleanupPromise;
let failModelProbe = false;
let providerPhase = 'startup';
const children = new Set();
const providerRecords = [];
const taskState = new Map();
let dangerStep = 0;
let dangerToolResult = '';

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function credentialLabel(authorization) {
  const known = new Map([
    [`Bearer ${ordinaryKey}`, 'ordinary'],
    [`Bearer ${initialKey}`, 'initial'],
    [`Bearer ${failedKey}`, 'failed'],
    [`Bearer ${rotatedKey}`, 'rotated'],
    [`Bearer ${switchedKey}`, 'switched'],
  ]);
  if (known.has(authorization)) return known.get(authorization);
  if (authorization === null) return 'unexpected-missing';
  if (authorization === 'Bearer ordinary:manual') return 'unexpected-ordinary-profile-id';
  if (authorization === 'Bearer custom-rc-profile-thermoelectric-user-a:managed') {
    return 'unexpected-managed-profile-a-id';
  }
  if (authorization === 'Bearer custom-rc-profile-thermoelectric-user-b:managed') {
    return 'unexpected-managed-profile-b-id';
  }
  return 'unexpected-other';
}

function assertAgentCredentialSince(startIndex, expected, operation) {
  const records = providerRecords.slice(startIndex).filter((record) => record.isAgentRequest);
  invariant(records.length > 0, `${operation} did not reach the provider as an agent request`);
  invariant(
    records.every((record) => record.credential === expected),
    `${operation} used the wrong credential label: ${records.map((record) => record.credential).join(',')}`,
  );
}

function assertProbeCredentialSince(startIndex, expected, operation) {
  const records = providerRecords.slice(startIndex);
  invariant(
    records.some((record) => record.credential === expected),
    `${operation} did not reach the provider with the expected credential label`,
  );
  invariant(
    records.every((record) => !record.credential.startsWith('unexpected-')),
    `${operation} sent an unknown provider credential`,
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function writeJson(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.platform !== 'win32') await chmod(file, mode);
}

function parseJson(stdout) {
  const source = stdout.trim();
  for (let index = source.indexOf('{'); index >= 0; index = source.indexOf('{', index + 1)) {
    try { return JSON.parse(source.slice(index)); } catch { /* skip launcher notices */ }
  }
  throw new Error(`OpenClaw output did not contain JSON: ${source.slice(0, 500)}`);
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((part) => typeof part === 'string' ? part : (part?.text ?? '')).join('\n');
}

function streamChunk(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-t09', object: 'chat.completion.chunk', created: 0,
    model: 'thermoelectric-fixture-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}

function streamText(response, content) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  streamChunk(response, { role: 'assistant', content });
  streamChunk(response, {}, 'stop');
  response.end('data: [DONE]\n\n');
}

function streamTool(response, id, name, args) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  streamChunk(response, {
    role: 'assistant',
    tool_calls: [{
      index: 0, id, type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  });
  streamChunk(response, {}, 'tool_calls');
  response.end('data: [DONE]\n\n');
}

async function startProvider() {
  provider = https.createServer({
    cert: await readFile(certPath),
    key: await readFile(keyPath),
  }, async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'thermoelectric-fixture-model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const promptText = body.messages?.map(messageText).join('\n') ?? '';
    const isAgentRequest = Array.isArray(body.tools) && body.tools.length > 0;
    const authorization = request.headers.authorization ?? null;
    providerRecords.push({
      credential: credentialLabel(authorization),
      model: body.model,
      isAgentRequest,
      phase: providerPhase,
      retryCount: /^[0-9]+$/.test(String(request.headers['x-stainless-retry-count'] ?? ''))
        ? Number(request.headers['x-stainless-retry-count']) : null,
      streamed: body.stream === true,
    });

    if (failModelProbe) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'T09 injected provider outage' } }));
      return;
    }

    if (isAgentRequest) {
      const task = tasks.find((candidate) => promptText.includes(candidate.prompt));
      if (task) {
        invariant(
          promptText.includes(task.expectedSkill),
          `${task.expectedSkill} missing from real prompt; tools=${body.tools
            .map((tool) => tool?.function?.name ?? tool?.name ?? '?').slice(0, 12).join(',')}; `
            + `visibleSkills=${tasks.filter((candidate) => promptText.includes(candidate.expectedSkill))
              .map((candidate) => candidate.expectedSkill).join(',') || 'none'}; `
            + `head=${JSON.stringify(promptText.slice(0, 1200))}`,
        );
        const state = taskState.get(task.expectedSkill) ?? { step: 0, reads: [] };
        const directory = `skills/rc-profile--thermoelectric-user-a--${task.expectedSkill}`;
        if (state.step === 0) {
          state.step = 1;
          state.reads.push('SKILL.md');
          taskState.set(task.expectedSkill, state);
          streamTool(response, `read-skill-${task.expectedSkill}`, 'read', { path: `${directory}/SKILL.md` });
          return;
        }
        if (state.step === 1) {
          state.step = 2;
          state.reads.push(task.reference);
          taskState.set(task.expectedSkill, state);
          streamTool(response, `read-reference-${task.expectedSkill}`, 'read', { path: `${directory}/${task.reference}` });
          return;
        }
        state.step = 3;
        taskState.set(task.expectedSkill, state);
        streamText(response, `T09_SELECTED:${task.expectedSkill}`);
        return;
      }
      if (promptText.includes(dangerPrompt)) {
        if (dangerStep === 0) {
          dangerStep = 1;
          // Contains DMS's deterministic `dd if=` danger signature, but remains
          // harmless even if the gate regresses and the shell actually runs it.
          streamTool(response, 't09-dangerous-exec', 'exec', { command: "printf '%s\\n' 'dd if=/dev/zero'" });
        } else {
          dangerStep = 2;
          dangerToolResult = body.messages
            ?.filter((message) => message?.role === 'tool')
            .map(messageText)
            .join('\n') ?? '';
          streamText(response, 'T09_DANGER_BLOCKED');
        }
        return;
      }
      if (promptText.includes(conversationPrompt)) {
        streamText(response, 'T09_CONVERSATION_OK');
        return;
      }
    }

    // DMS deep-review and course-correction calls do not expose agent tools.
    // A harmless schema-shaped response keeps those asynchronous paths local.
    streamText(response, JSON.stringify({
      passed: true,
      blocked: false,
      warnings: [],
      deviation: 0,
      keyConclusions: [],
      missingTopics: [],
    }));
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  invariant(address && typeof address === 'object', 'provider did not bind');
  return address.port;
}

function isolatedEnv(paths) {
  const env = {};
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot',
    'WINDIR', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: paths.home,
    USERPROFILE: paths.home,
    XDG_CACHE_HOME: path.join(tempRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(tempRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(tempRoot, 'xdg-data'),
    XDG_STATE_HOME: path.join(tempRoot, 'xdg-state'),
    TMPDIR: paths.tmp,
    TMP: paths.tmp,
    TEMP: paths.tmp,
    OPENCLAW_STATE_DIR: paths.stateDir,
    OPENCLAW_CONFIG_PATH: paths.configPath,
    OPENCLAW_AGENT_DIR: paths.agentDir,
    OPENCLAW_AUTH_STORE_READONLY: '1',
    NODE_EXTRA_CA_CERTS: certPath,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
}

async function runCli(paths, args, timeout = 60_000) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [openClawEntry, ...args], {
    cwd: root,
    env: isolatedEnv(paths),
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

async function writeSourceProxy(directory, sourceDirectory) {
  const manifest = readJson(path.join(sourceDirectory, 'openclaw.plugin.json'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJson(path.join(directory, 'package.json'), {
    name: `@research-claw-test/t09-${manifest.id}`,
    version: '0.0.0-test',
    private: true,
    type: 'module',
    main: 'index.ts',
    openclaw: { extensions: ['./index.ts'] },
  });
  await writeJson(path.join(directory, 'openclaw.plugin.json'), { ...manifest, main: 'index.ts' });
  await writeFile(
    path.join(directory, 'index.ts'),
    `export { default } from ${JSON.stringify(pathToFileURL(path.join(sourceDirectory, 'index.ts')).href)};\n`,
    { mode: 0o600 },
  );
}

async function makeHarness(providerPort) {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-t09-bootstrap-e2e-'));
  if (process.platform !== 'win32') await chmod(tempRoot, 0o700);
  const home = path.join(tempRoot, 'home');
  const tmp = path.join(tempRoot, 'tmp');
  const stateDir = path.join(tempRoot, 'state');
  const workspace = path.join(tempRoot, 'workspace');
  const dataRoot = path.join(tempRoot, 'data');
  const configPath = path.join(tempRoot, 'config', 'openclaw.json');
  const globalConfigPath = path.join(stateDir, 'openclaw.json');
  const agentDir = path.join(stateDir, 'agents', 'main', 'agent');
  const authPath = path.join(agentDir, 'auth-profiles.json');
  const coreProxy = path.join(tempRoot, 'plugins', 'research-claw-core');
  const dmsProxy = path.join(tempRoot, 'plugins', 'dual-model-supervisor');
  for (const directory of [home, tmp, stateDir, workspace, dataRoot, path.dirname(configPath), agentDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await writeSourceProxy(coreProxy, path.join(root, 'extensions', 'research-claw-core'));
  await writeSourceProxy(dmsProxy, path.join(root, 'extensions', 'dual-model-supervisor'));

  const ordinaryAuthId = 'ordinary:manual';
  await writeJson(configPath, {
    gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token: gatewayToken } },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: 'ordinary/thermoelectric-fixture-model' },
        timeoutSeconds: 20,
      },
    },
    models: {
      mode: 'merge',
      providers: {
        ordinary: {
          baseUrl: `https://127.0.0.1:${providerPort}/v1`,
          apiKey: ordinaryAuthId,
          api: 'openai-completions',
          models: [{
            id: 'thermoelectric-fixture-model', name: 'T09 ordinary fixture', reasoning: false,
            input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000, maxTokens: 256,
          }],
        },
      },
    },
    auth: {
      profiles: { [ordinaryAuthId]: { provider: 'ordinary', mode: 'api_key' } },
      order: { ordinary: [ordinaryAuthId] },
    },
    skills: { allowBundled: ['rc-t09-no-bundled-skills'], limits: { maxSkillsInPrompt: 150, maxSkillsPromptChars: 30000 } },
    mcp: { servers: { plaud: { enabled: true, command: process.execPath, args: [fakePlaudPath] } } },
    plugins: {
      enabled: true,
      allow: ['research-claw-core', 'dual-model-supervisor'],
      load: { paths: [coreProxy, dmsProxy] },
      entries: {
        'research-claw-core': {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: { dbPath: path.join(dataRoot, 'library.db'), workspace: { root: workspace } },
        },
        'dual-model-supervisor': {
          enabled: false,
          config: { enabled: false, reviewMode: 'off', dbPath: path.join(dataRoot, 'supervisor.db') },
        },
      },
    },
    tools: { deny: ['user_deny'] },
    logging: { level: 'debug', file: path.join(tempRoot, 'openclaw.log') },
  });
  await writeJson(globalConfigPath, { userGlobalFixture: { preserve: true }, models: { mode: 'merge', providers: {} } });
  await writeJson(authPath, {
    version: 1,
    profiles: { [ordinaryAuthId]: { type: 'api_key', provider: 'ordinary', key: ordinaryKey } },
  });
  const paths = {
    root: tempRoot,
    home,
    tmp,
    rcRoot: root,
    configPath,
    globalConfigPath,
    stateDir,
    workspace,
    dbPath: path.join(dataRoot, 'library.db'),
    agentDir,
    authPath,
    dataRoot,
  };
  ensureInitialized({ ...paths, externalStopVerified: true });
  return paths;
}

function makeCapsule(providerPort, overrides = {}) {
  const capsule = readJson(capsuleFixture);
  capsule.model.baseUrl = `https://127.0.0.1:${providerPort}/v1`;
  capsule.secrets.modelApiKey = overrides.key ?? initialKey;
  if (overrides.revision !== undefined) capsule.profile.revision = overrides.revision;
  if (overrides.profileId) {
    capsule.profile.id = overrides.profileId;
    capsule.model.providerId = `custom-rc-profile-${overrides.profileId}`;
  }
  return Buffer.from(`${JSON.stringify(capsule)}\n`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  invariant(address && typeof address === 'object', 'failed to reserve Gateway port');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForGateway(port) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch { /* starting */ }
    if (gateway && childExited(gateway)) throw new Error(`Gateway exited: ${gatewayStderr.slice(-5000)}`);
    await sleep(100);
  }
  throw new Error(`Gateway health timeout: ${gatewayStderr.slice(-5000)}`);
}

async function startGateway(paths) {
  const port = await reservePort();
  gatewayStderr = '';
  gateway = spawn(
    process.execPath,
    [openClawEntry, 'gateway', '--port', String(port), '--bind', 'loopback', '--token', gatewayToken, 'run'],
    { cwd: root, env: isolatedEnv(paths), stdio: ['ignore', 'ignore', 'pipe'] },
  );
  children.add(gateway);
  gateway.stderr.setEncoding('utf8');
  gateway.stderr.on('data', (chunk) => {
    if (gatewayStderr.length < 500_000) gatewayStderr += chunk;
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
  children.delete(child);
  gateway = undefined;
}

async function gatewayHello(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  return await new Promise((resolve, reject) => {
    let requestId = '';
    const timer = setTimeout(() => reject(new Error('Gateway hello timeout')), 15_000);
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        requestId = crypto.randomUUID();
        socket.send(JSON.stringify({
          type: 'req', id: requestId, method: 'connect',
          params: {
            minProtocol: 4, maxProtocol: 4,
            client: { id: 'gateway-client', version: expectedOpenClawVersion, platform: process.platform, mode: 'backend' },
            role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'],
            auth: { token: gatewayToken },
          },
        }));
      } else if (frame.type === 'res' && frame.id === requestId) {
        clearTimeout(timer);
        socket.close();
        if (!frame.ok) reject(new Error(frame.error?.message ?? JSON.stringify(frame.error)));
        else resolve(frame.payload);
      }
    });
    socket.addEventListener('error', () => reject(new Error('Gateway hello websocket failed')));
  });
}

async function runGatewayProbe(paths) {
  const port = await startGateway(paths);
  try {
    const readiness = await runReadiness({
      root,
      configPath: paths.configPath,
      port,
      token: gatewayToken,
      timeout: 15_000,
    });
    const hello = await gatewayHello(port);
    return { readiness, methods: hello?.features?.methods ?? [] };
  } finally {
    await stopGateway();
  }
}

async function ensureAndValidate(paths) {
  const ensure = await execFileAsync(process.execPath, [
    path.join(root, 'scripts', 'ensure-config.cjs'),
    '--inherit-global-compaction', paths.configPath, paths.globalConfigPath,
  ], {
    cwd: root,
    env: {
      ...isolatedEnv(paths),
      ...(process.env.RC_MODEL_PROBE_DEBUG === '1' ? { RC_MODEL_PROBE_DEBUG: '1' } : {}),
    },
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  const validation = await runCli(paths, ['config', 'validate', '--json'], 60_000);
  invariant(!`${ensure.stdout}${ensure.stderr}${validation.stdout}${validation.stderr}`.includes(initialKey), 'model key leaked through config validation');
  parseJson(validation.stdout);
}

async function runAgent(paths, sessionId, prompt, expectedCredential, timeoutSeconds = 20) {
  providerPhase = `agent-${expectedCredential}`;
  const recordStart = providerRecords.length;
  const result = await runCli(paths, [
    'agent', '--local', '--json', '--session-id', sessionId,
    '--message', prompt, '--timeout', String(timeoutSeconds),
  ], (timeoutSeconds + 25) * 1000);
  assertAgentCredentialSince(recordStart, expectedCredential, `agent session ${sessionId}`);
  return result.stdout;
}

async function skillInventory(paths, expectedProfileSkills) {
  const listed = parseJson((await runCli(paths, ['skills', 'list', '--json', '--agent', 'main'])).stdout);
  const names = new Set(tasks.map((task) => task.expectedSkill));
  const found = listed.skills.filter((entry) => names.has(entry.name));
  if (!expectedProfileSkills) return found.map((entry) => entry.name).sort();
  const inventory = [];
  for (const task of tasks) {
    const info = parseJson((await runCli(paths, ['skills', 'info', task.expectedSkill, '--json', '--agent', 'main'])).stdout);
    inventory.push({ name: task.expectedSkill, source: info.source });
  }
  return inventory.sort((a, b) => a.name.localeCompare(b.name));
}

function latestToolNames(paths) {
  const sessionsPath = path.join(paths.stateDir, 'agents', 'main', 'sessions', 'sessions.json');
  const sessions = readJson(sessionsPath);
  const reports = Object.values(sessions)
    .map((entry) => entry?.systemPromptReport)
    .filter((report) => report?.source === 'run' && Array.isArray(report?.tools?.entries));
  invariant(reports.length > 0, 'no real systemPromptReport was persisted');
  return reports.at(-1).tools.entries.map((entry) => entry.name).sort();
}

function auditRows(paths) {
  const Database = require(require.resolve('better-sqlite3', {
    paths: [path.join(root, 'extensions', 'dual-model-supervisor'), root],
  }));
  const database = new Database(path.join(paths.dataRoot, 'supervisor.db'), { readonly: true, fileMustExist: true });
  try {
    return database.prepare('SELECT type, action, details FROM supervisor_audit_log ORDER BY id').all();
  } finally {
    database.close();
  }
}

function pathSnapshot(target, includeMtime = true) {
  let metadata;
  try { metadata = fs.lstatSync(target, { bigint: true }); } catch (error) {
    if (error?.code === 'ENOENT') return { type: 'absent' };
    throw error;
  }
  const base = {
    mode: process.platform === 'win32' ? null : Number(metadata.mode & 0o777n),
    ...(includeMtime ? { mtimeNs: metadata.mtimeNs.toString() } : {}),
  };
  if (metadata.isSymbolicLink()) {
    return { type: 'symlink', ...base, target: fs.readlinkSync(target) };
  }
  if (metadata.isFile()) return { type: 'file', ...base, sha256: sha256(fs.readFileSync(target)) };
  if (metadata.isDirectory()) {
    return {
      type: 'directory',
      ...base,
      children: Object.fromEntries(fs.readdirSync(target).sort().map((name) => [
        name, pathSnapshot(path.join(target, name), includeMtime),
      ])),
    };
  }
  return { type: 'other', ...base };
}

function recordDiffKeys(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function liveManagedSnapshot(paths, includeMtime = true) {
  const configRoot = path.dirname(paths.configPath);
  return Object.fromEntries([
    paths.configPath,
    paths.globalConfigPath,
    paths.authPath,
    path.join(configRoot, '.rc-bootstrap', 'receipt.json'),
    path.join(configRoot, '.rc-bootstrap', 'peripheral-suspensions.json'),
    path.join(paths.workspace, 'skills'),
    path.join(paths.stateDir, 'state', 'openclaw.sqlite'),
    path.join(paths.stateDir, 'state', 'openclaw.sqlite-wal'),
    path.join(paths.stateDir, 'state', 'openclaw.sqlite-shm'),
    paths.dbPath,
    `${paths.dbPath}-wal`,
    `${paths.dbPath}-shm`,
  ].map((target) => [path.relative(tempRoot, target), pathSnapshot(target, includeMtime)]));
}

function countSecret(rootPath, secret) {
  const needle = Buffer.from(secret);
  let count = 0;
  const visit = (target) => {
    const metadata = fs.lstatSync(target);
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    } else if (metadata.isFile()) {
      const bytes = fs.readFileSync(target);
      for (let offset = 0;;) {
        const found = bytes.indexOf(needle, offset);
        if (found < 0) break;
        count += 1;
        offset = found + needle.length;
      }
    }
  };
  visit(rootPath);
  return count;
}

function secretLocations(rootPath, secret) {
  const needle = Buffer.from(secret);
  const locations = [];
  const visit = (target) => {
    const metadata = fs.lstatSync(target);
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    } else if (metadata.isFile() && fs.readFileSync(target).includes(needle)) {
      locations.push(path.relative(tempRoot, target));
    }
  };
  visit(rootPath);
  return locations.sort();
}

async function installAndCommit(paths, capsuleBytes) {
  const staged = await applier.stageProfile({ ...paths, capsuleBytes, rcVersion: '0.8.3' });
  const applied = await applier.applyProfile({ ...paths, txId: staged.txId });
  await applier.verifyProfile({ ...paths, txId: staged.txId });
  await applier.commitProfile({ ...paths, txId: staged.txId });
  return { staged, applied };
}

async function runIsolatedModelProbe(paths, provider, profileId, expectedCredential, timeoutMs = 45_000) {
  providerPhase = `probe-${expectedCredential}`;
  const recordStart = providerRecords.length;
  const { stdout } = await execFileAsync(process.execPath, [
    modelProbeHelper,
    '--root', root,
    '--config', paths.configPath,
    '--state', paths.stateDir,
    '--provider', provider,
    '--profile', profileId,
    '--scratch-root', paths.tmp,
    '--timeout-ms', String(timeoutMs),
  ], {
    cwd: root,
    env: {
      ...isolatedEnv(paths),
      ...(process.env.RC_MODEL_PROBE_DEBUG === '1' ? { RC_MODEL_PROBE_DEBUG: '1' } : {}),
    },
    timeout: timeoutMs + 10_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  assertProbeCredentialSince(recordStart, expectedCredential, `model probe ${profileId}`);
  return JSON.parse(stdout);
}

async function cleanup() {
  await stopGateway();
  for (const child of [...children]) {
    if (!childExited(child)) child.kill('SIGKILL');
  }
  children.clear();
  if (provider) {
    provider.closeAllConnections?.();
    await new Promise((resolve) => provider.close(resolve));
    provider = undefined;
  }
  if (tempRoot && process.env.RC_KEEP_TEST_ARTIFACTS !== '1') {
    await rm(tempRoot, { recursive: true, force: true });
  } else if (tempRoot) {
    process.stderr.write(`T09 preserved isolated artifacts at ${tempRoot}\n`);
  }
}

function cleanupOnce() {
  cleanupPromise ??= cleanup();
  return cleanupPromise;
}

async function main() {
  const manifest = readJson(openClawPackage);
  invariant(manifest.version === expectedOpenClawVersion, `requires OpenClaw ${expectedOpenClawVersion}`);
  const providerPort = await startProvider();
  const paths = await makeHarness(providerPort);

  // Complete no-Profile/no-Token control on the same isolated installation.
  providerPhase = 'gateway-ordinary';
  const ordinaryGateway = await runGatewayProbe(paths);
  invariant(ordinaryGateway.readiness.ok, 'ordinary readiness failed');
  invariant(!ordinaryGateway.readiness.probes.some((probe) => probe.expectedUnavailable), 'ordinary peripherals unexpectedly absent');
  invariant((await skillInventory(paths, false)).length === 0, 'ordinary state exposed Profile Skills');
  const ordinaryAgent = await runAgent(paths, 't09-ordinary', conversationPrompt, 'ordinary');
  invariant(ordinaryAgent.includes('T09_CONVERSATION_OK'), 'ordinary conversation failed');
  const ordinaryTools = latestToolNames(paths);
  invariant(ordinaryTools.some((name) => name.startsWith('periph_')), 'ordinary Core peripheral tools missing');
  invariant(ordinaryTools.some((name) => name.startsWith('plaud__')), 'ordinary Plaud tools missing');

  const initialCapsule = makeCapsule(providerPort, { key: initialKey });
  const transaction = { initial: [] };
  const staged = await applier.stageProfile({ ...paths, capsuleBytes: initialCapsule, rcVersion: '0.8.3' });
  transaction.initial.push('staged');
  await applier.applyProfile({ ...paths, txId: staged.txId });
  transaction.initial.push('applied');
  await ensureAndValidate(paths);
  transaction.initial.push('real-config-valid');

  providerPhase = 'gateway-initial';
  const profileGateway = await runGatewayProbe(paths);
  invariant(profileGateway.readiness.ok, `Profile readiness failed: ${JSON.stringify(profileGateway.readiness)}`);
  transaction.initial.push('runtime-verified');
  const initialProbe = await runIsolatedModelProbe(
    paths,
    'custom-rc-profile-thermoelectric-user-a',
    'custom-rc-profile-thermoelectric-user-a:managed',
    'initial',
  );
  invariant(initialProbe.ok === true, 'isolated credential/model probe failed');
  const inventory = await skillInventory(paths, true);
  const initialConversation = await runAgent(paths, 't09-profile-conversation', conversationPrompt, 'initial');
  invariant(initialConversation.includes('T09_CONVERSATION_OK'), 'Profile conversation failed');
  const triggered = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const output = await runAgent(paths, `t09-skill-${index}`, task.prompt, 'initial');
    invariant(output.includes(`T09_SELECTED:${task.expectedSkill}`), `${task.expectedSkill} selection failed`);
    const state = taskState.get(task.expectedSkill);
    invariant(state?.step === 3 && state.reads[1] === task.reference, `${task.expectedSkill} read chain incomplete`);
    triggered.push(task.expectedSkill);
  }
  const danger = await runAgent(paths, 't09-danger', dangerPrompt, 'initial');
  invariant(danger.includes('T09_DANGER_BLOCKED') && dangerStep === 2, 'dangerous tool flow did not finish');
  const audits = auditRows(paths);
  const blockAuditObserved = audits.some((row) => row.type === 'tool_review'
    && row.action === 'block' && /Dangerous command detected/.test(row.details));
  invariant(
    blockAuditObserved,
    `DMS block audit missing: toolResult=${JSON.stringify(dangerToolResult)}; audits=${JSON.stringify(audits.slice(-12))}`,
  );
  const profileTools = latestToolNames(paths);
  const peripheralRpc = profileGateway.methods.filter((method) => method.startsWith('rc.periph.'));
  invariant(peripheralRpc.length === 0, `peripheral RPC leaked: ${peripheralRpc.join(',')}`);
  invariant(!profileTools.some((name) => name.startsWith('periph_')), 'peripheral tools leaked');
  invariant(!profileTools.some((name) => name.startsWith('plaud__')), 'Plaud tools leaked');

  try {
    await applier.verifyProfile({ ...paths, txId: staged.txId });
  } catch (error) {
    throw new Error(
      `initial verify failed (${error?.code ?? error}): secretLocations=${JSON.stringify(secretLocations(tempRoot, initialKey))}`,
      { cause: error },
    );
  }
  transaction.initial.push('verified');
  await applier.commitProfile({ ...paths, txId: staged.txId });
  transaction.initial.push('committed');

  // Same digest must not touch the live managed assets.
  const beforeNoop = liveManagedSnapshot(paths, true);
  const noop = await installAndCommit(paths, initialCapsule);
  const afterNoop = liveManagedSnapshot(paths, true);
  const liveAssetsStable = JSON.stringify(beforeNoop) === JSON.stringify(afterNoop);
  invariant(noop.applied.noop === true && liveAssetsStable, 'same-digest rerun changed live assets');

  // Deliberate managed drift must be repaired without changing the digest.
  const config = readJson(paths.configPath);
  config.models.providers['custom-rc-profile-thermoelectric-user-a'].operatorDrift = true;
  await writeJson(paths.configPath, config);
  const driftSkill = path.join(
    paths.workspace, 'skills',
    'rc-profile--thermoelectric-user-a--research-thermoelectric-semiconductors',
    'SKILL.md',
  );
  fs.appendFileSync(driftSkill, '\nT09_OPERATOR_DRIFT\n');
  const repaired = await installAndCommit(paths, initialCapsule);
  const driftRepaired = repaired.applied.noop === false
    && !Object.hasOwn(readJson(paths.configPath).models.providers['custom-rc-profile-thermoelectric-user-a'], 'operatorDrift')
    && !fs.readFileSync(driftSkill, 'utf8').includes('T09_OPERATOR_DRIFT');
  invariant(driftRepaired, 'same-digest managed drift was not repaired');

  // An external provider failure after apply rolls the whole write-set back.
  const beforeFailure = liveManagedSnapshot(paths, false);
  const failedCapsule = makeCapsule(providerPort, { revision: 2, key: failedKey });
  const failedStage = await applier.stageProfile({ ...paths, capsuleBytes: failedCapsule, rcVersion: '0.8.3' });
  await applier.applyProfile({ ...paths, txId: failedStage.txId });
  let probeFailed = false;
  const failedProbeRecordStart = providerRecords.length;
  failModelProbe = true;
  try {
    await runIsolatedModelProbe(
      paths,
      'custom-rc-profile-thermoelectric-user-a',
      'custom-rc-profile-thermoelectric-user-a:managed',
      'failed',
      8_000,
    );
  } catch {
    probeFailed = true;
  } finally {
    failModelProbe = false;
  }
  invariant(probeFailed, 'injected provider failure unexpectedly passed');
  const failedProbeRecords = providerRecords.slice(failedProbeRecordStart).map((record) => ({
    credential: record.credential,
    retryCount: record.retryCount,
    isAgentRequest: record.isAgentRequest,
    streamed: record.streamed,
  }));
  invariant(
    failedProbeRecords.length === 1 && failedProbeRecords[0].credential === 'failed',
    `failed model probe request boundary mismatch: ${JSON.stringify(failedProbeRecords)}`,
  );
  await applier.rollbackProfile({ ...paths, txId: failedStage.txId });
  const afterFailure = liveManagedSnapshot(paths, false);
  const managedStateRestored = JSON.stringify(beforeFailure) === JSON.stringify(afterFailure);
  const failedKeyLocations = secretLocations(tempRoot, failedKey);
  const failedKeyRemoved = failedKeyLocations.length === 0;
  const failedProbeRolledBack = managedStateRestored && failedKeyRemoved;
  invariant(
    failedProbeRolledBack,
    `failed runtime probe did not restore the previous Profile: managed=${managedStateRestored}; failedKeyRemoved=${failedKeyRemoved}; failedKeyLocations=${JSON.stringify(failedKeyLocations)}; managedDiff=${JSON.stringify(recordDiffKeys(beforeFailure, afterFailure))}`,
  );

  // Revision/key rotation must remove the old managed key before reuse.
  const rotatedCapsule = makeCapsule(providerPort, { revision: 2, key: rotatedKey });
  await installAndCommit(paths, rotatedCapsule);
  const rotatedConversation = await runAgent(paths, 't09-rotated', conversationPrompt, 'rotated');
  invariant(rotatedConversation.includes('T09_CONVERSATION_OK'), 'rotated key conversation failed');
  const rotatedKeyOnly = countSecret(tempRoot, initialKey) === 0 && countSecret(tempRoot, rotatedKey) === 1;
  invariant(rotatedKeyOnly, 'key rotation left an old or duplicate managed key');

  // Switching Profile IDs removes only the old receipt-owned provider/auth/Skill set.
  const switchedCapsule = makeCapsule(providerPort, {
    profileId: 'thermoelectric-user-b', revision: 1, key: switchedKey,
  });
  await installAndCommit(paths, switchedCapsule);
  const switchedConversation = await runAgent(paths, 't09-switched', conversationPrompt, 'switched');
  invariant(switchedConversation.includes('T09_CONVERSATION_OK'), 'switched Profile conversation failed');
  const finalConfig = readJson(paths.configPath);
  const skillDirectories = fs.readdirSync(path.join(paths.workspace, 'skills'));
  const profileSwitchClean = !Object.hasOwn(finalConfig.models.providers, 'custom-rc-profile-thermoelectric-user-a')
    && Object.hasOwn(finalConfig.models.providers, 'custom-rc-profile-thermoelectric-user-b')
    && !skillDirectories.some((name) => name.startsWith('rc-profile--thermoelectric-user-a--'))
    && skillDirectories.filter((name) => name.startsWith('rc-profile--thermoelectric-user-b--')).length === 3
    && countSecret(tempRoot, rotatedKey) === 0
    && countSecret(tempRoot, switchedKey) === 1;
  invariant(profileSwitchClean, 'Profile switch left receipt-owned state behind');
  const unexpectedCredentials = providerRecords
    .filter((record) => record.credential.startsWith('unexpected-'))
    .reduce((counts, record) => {
      const key = `${record.credential}:${record.phase}:${record.isAgentRequest ? 'agent' : 'aux'}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
  invariant(
    providerRecords.length > 0 && Object.keys(unexpectedCredentials).length === 0,
    `provider Authorization did not match a known auth profile: ${JSON.stringify(unexpectedCredentials)}`,
  );
  invariant(providerRecords.filter((record) => record.isAgentRequest)
    .every((record) => record.model === 'thermoelectric-fixture-model'), 'unexpected model was requested');

  return {
    openClawVersion: manifest.version,
    transaction,
    ordinary: {
      readiness: ordinaryGateway.readiness.ok,
      profileSkills: [],
      peripheralTools: ordinaryTools.filter((name) => name.startsWith('periph_')),
      plaudTools: ordinaryTools.filter((name) => name.startsWith('plaud__')),
    },
    readiness: profileGateway.readiness,
    model: {
      providerId: 'custom-rc-profile-thermoelectric-user-a',
      modelId: 'thermoelectric-fixture-model',
      initialConversation: initialConversation.includes('T09_CONVERSATION_OK') ? 'T09_CONVERSATION_OK' : 'failed',
      expectedAuthorizationOnly: providerRecords.every((record) => !record.credential.startsWith('unexpected-')),
    },
    skills: { inventory, triggered },
    supervisor: { dangerousToolBlocked: dangerStep === 2, blockAuditObserved },
    policy: {
      ...readJson(paths.configPath).plugins.entries['research-claw-core'].config.productPolicy.capabilities,
      peripheralTools: profileTools.filter((name) => name.startsWith('periph_')),
      plaudTools: profileTools.filter((name) => name.startsWith('plaud__')),
      peripheralRpc,
    },
    lifecycle: {
      sameDigestNoop: noop.applied.noop === true,
      liveAssetsStable,
      driftRepaired,
      failedProbeRolledBack,
      rotatedKeyOnly,
      profileSwitchClean,
    },
  };
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    void cleanupOnce().finally(() => process.exit(code));
  });
}

let result;
try {
  result = await main();
} finally {
  await cleanupOnce();
}
let tempSurvived = true;
try { await access(tempRoot); } catch { tempSurvived = false; }
invariant(!tempSurvived && children.size === 0 && provider === undefined, 'T09 temporary runtime survived cleanup');
process.stdout.write(`${JSON.stringify({ ...result, cleanup: 'clean' }, null, 2)}\n`);
