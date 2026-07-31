#!/usr/bin/env node

/**
 * Real OpenClaw presentation-hook contract probe.
 *
 * This starts an isolated OpenClaw 2026.6.1 gateway with the real RC, RP,
 * research-superpower and configured Wentor MCP plugins. A deterministic local
 * OpenAI-compatible provider requests one real tool call per run. A temporary
 * capture plugin records the public hook payloads without changing them.
 *
 * The script never writes fixtures into the repository. Set
 * RC_KEEP_TEST_ARTIFACTS=1 to retain the temporary capture for review; checked-in
 * fixtures must still be added deliberately after redaction.
 */

import { execFile, spawn } from 'node:child_process';
import { createWriteStream, realpathSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPath = path.join(projectRoot, 'node_modules', 'openclaw', 'dist', 'entry.js');
const requireFromOpenClaw = createRequire(realpathSync(entryPath));
const WebSocket = requireFromOpenClaw('ws');
const corePath = path.join(projectRoot, 'extensions', 'research-claw-core');
const superpowerPath = path.join(projectRoot, 'extensions', 'research-superpower');
const rpPath = path.resolve(projectRoot, '..', '..', 'research-plugins');
const globalConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const gatewayPort = Number(process.env.RC_PRESENTATION_GATEWAY_PORT ?? 28831);
const providerPort = Number(process.env.RC_PRESENTATION_PROVIDER_PORT ?? 28832);
const gatewayToken = 'rc-presentation-contract-probe';
const origin = 'http://127.0.0.1:5175';
const captureTools = [
  'workspace_save',
  'workspace_append',
  'workspace_export',
  'workspace_download',
  'get_arxiv_paper',
  'search_openalex',
  'search_crossref',
  'search_arxiv',
  'search_dblp',
  'rp_search',
  'wentor-network__search_papers',
  'presentation_event_probe',
];

let tempRoot;
let gateway;
let provider;
let capturePath;
let pythonUserSite;
let requestSequence = 0;
let rpcSocket;
const frames = [];
const frameWaiters = [];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  const artifact = path.join(corePath, 'dist', 'index.js');
  const artifactStat = await stat(artifact);
  for (const source of [
    path.join(corePath, 'index.ts'),
    path.join(corePath, 'src', 'workspace', 'tools.ts'),
  ]) {
    if ((await stat(source)).mtimeMs > artifactStat.mtimeMs) {
      throw new Error('core build is stale; run `pnpm --filter @research-claw/core build`');
    }
  }
}

function gatewayEnv() {
  return {
    ...process.env,
    HOME: path.join(tempRoot, 'home'),
    OPENCLAW_STATE_DIR: path.join(tempRoot, 'state'),
    OPENCLAW_CONFIG_PATH: path.join(tempRoot, 'state', 'openclaw.json'),
    RC_PRESENTATION_CAPTURE_PATH: capturePath,
    ...(pythonUserSite ? { PYTHONPATH: pythonUserSite } : {}),
  };
}

async function writeCapturePlugin() {
  const pluginPath = path.join(tempRoot, 'capture-plugin');
  await mkdir(pluginPath, { recursive: true });
  await writeFile(path.join(pluginPath, 'openclaw.plugin.json'), JSON.stringify({
    id: 'presentation-capture',
    name: 'Presentation contract capture',
    version: '1.0.0',
    main: 'index.js',
    activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }, null, 2));
  await writeFile(path.join(pluginPath, 'index.js'), `
import fs from 'node:fs';

const target = process.env.RC_PRESENTATION_CAPTURE_PATH;
function record(kind, event, context) {
  if (!target) return;
  fs.appendFileSync(target, JSON.stringify({ kind, event, context, capturedAt: Date.now() }) + '\\n');
}

export default {
  id: 'presentation-capture',
  name: 'Presentation contract capture',
  register(api) {
    api.on('before_prompt_build', (event, context) => record('before_prompt_build', event, context));
    api.on('before_agent_start', (event, context) => record('before_agent_start', event, context));
    api.on('before_tool_call', (event, context) => record('before_tool_call', event, context));
    api.on('after_tool_call', (event, context) => record('after_tool_call', event, context));
    api.on('tool_result_persist', (event, context) => record('tool_result_persist', event, context));
    api.on('agent_end', (event, context) => record('agent_end', event, context));
  },
};
`);
  return pluginPath;
}

async function writeEventProbePlugin() {
  const pluginPath = path.join(tempRoot, 'event-probe-plugin');
  await mkdir(pluginPath, { recursive: true });
  await writeFile(path.join(pluginPath, 'openclaw.plugin.json'), JSON.stringify({
    id: 'research-claw-core',
    name: 'Research-Claw event transport probe',
    version: '1.0.0',
    main: 'index.js',
    activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }, null, 2));
  await writeFile(path.join(pluginPath, 'index.js'), `
import fs from 'node:fs';

const target = process.env.RC_PRESENTATION_CAPTURE_PATH;
export default {
  id: 'research-claw-core',
  name: 'Research-Claw event transport probe',
  register(api) {
    api.registerTool({
      name: 'presentation_event_probe',
      description: 'Contract-only custom event transport probe.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: [{ type: 'text', text: 'event probe tool completed' }], details: { ok: true } };
      },
    });
    api.on('after_tool_call', (event, context) => {
      if (event?.toolName !== 'presentation_event_probe') return;
      const runId = event?.runId ?? context?.runId;
      const sessionKey = context?.sessionKey;
      const emitted = api.emitAgentEvent({
        runId,
        sessionKey,
        stream: 'research-claw-core.presentation_changed',
        data: { schemaVersion: 1, runId, sessionKey, recordsRevision: 1 },
      });
      if (target) fs.appendFileSync(target, JSON.stringify({
        kind: 'presentation_event_emitted', event: { runId, sessionKey, emitted }, capturedAt: Date.now(),
      }) + '\\n');
    });
  },
};
`);
  return pluginPath;
}

async function readConfiguredMcp() {
  try {
    const config = JSON.parse(await readFile(globalConfigPath, 'utf8'));
    const wentor = config.mcp?.servers?.['wentor-network'];
    return wentor ? { servers: { 'wentor-network': wentor } } : undefined;
  } catch {
    return undefined;
  }
}

async function writeConfig() {
  const stateDir = path.join(tempRoot, 'state');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const dataDir = path.join(tempRoot, 'data');
  const logsDir = path.join(tempRoot, 'logs');
  await Promise.all([
    mkdir(path.join(tempRoot, 'home'), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
  ]);
  const capturePluginPath = await writeCapturePlugin();
  const eventProbePath = process.env.RC_CONTRACT_MODE === 'event'
    ? await writeEventProbePlugin()
    : undefined;
  const mcp = await readConfiguredMcp();
  const pluginPaths = eventProbePath
    ? [eventProbePath, capturePluginPath]
    : [corePath, rpPath, superpowerPath, capturePluginPath];
  const pluginAllow = eventProbePath
    ? ['research-claw-core', 'presentation-capture']
    : ['research-claw-core', 'research-plugins', 'research-superpower', 'presentation-capture'];
  const pluginEntries = eventProbePath
    ? {
        'research-claw-core': { enabled: true, hooks: { allowConversationAccess: true } },
        'presentation-capture': { enabled: true, hooks: { allowConversationAccess: true } },
      }
    : {
        'research-claw-core': {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: {
            dbPath: path.join(dataDir, 'library.db'),
            autoTrackGit: false,
            pptRoot: path.join(tempRoot, 'ppt'),
          },
        },
        'research-plugins': { enabled: true },
        'research-superpower': { enabled: true },
        'presentation-capture': {
          enabled: true,
          hooks: { allowConversationAccess: true },
        },
      };
  await writeFile(path.join(stateDir, 'openclaw.json'), JSON.stringify({
    gateway: {
      mode: 'local',
      auth: { mode: 'token', token: gatewayToken },
      controlUi: {
        dangerouslyDisableDeviceAuth: true,
        allowedOrigins: [origin],
      },
    },
    agents: {
      defaults: {
        workspace: workspaceDir,
        skipBootstrap: true,
        model: { primary: 'fixture/tool-driver' },
        timeoutSeconds: process.env.RC_CONTRACT_MODE === 'lifecycle' ? 2 : 90,
      },
    },
    models: {
      mode: 'merge',
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: 'isolated-tool-driver',
          api: 'openai-completions',
          models: [{
            id: 'tool-driver',
            name: 'Presentation tool driver',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 512,
          }],
        },
      },
    },
    ...(mcp && !eventProbePath ? { mcp } : {}),
    skills: { allowBundled: ['fixture-no-bundled-skills'] },
    logging: { level: 'debug', file: path.join(logsDir, 'openclaw.log') },
    plugins: {
      enabled: true,
      allow: pluginAllow,
      load: { paths: pluginPaths },
      entries: pluginEntries,
    },
  }, null, 2));
}

function sendSse(response, chunks) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function completionChunk(delta, finishReason = null) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'tool-driver',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter(item => item?.type === 'text').map(item => item.text ?? '').join('');
}

function parseToolInstruction(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUserIndex = messages.findLastIndex(message => message?.role === 'user');
  if (lastUserIndex < 0) return null;
  const match = messageText(messages[lastUserIndex]).match(/RC_CONTRACT_TOOL_CALL\s+(\{[\s\S]*\})/);
  if (!match) return null;
  const instruction = JSON.parse(match[1]);
  return messages.slice(lastUserIndex + 1).some(message => message?.role === 'tool')
    ? { ...instruction, final: true }
    : instruction;
}

async function startProvider() {
  provider = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'tool-driver', object: 'model', owned_by: 'fixture' }],
      }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const instruction = parseToolInstruction(body);
    if (instruction?.final) {
      if (Number.isFinite(instruction.finalDelayMs) && instruction.finalDelayMs > 0) {
        await sleep(Math.min(instruction.finalDelayMs, 15_000));
        if (response.destroyed) return;
      }
      sendSse(response, [
        completionChunk({
          role: 'assistant',
          content: instruction.finalText ?? 'Contract run complete. No card fence emitted.',
        }),
        completionChunk({}, 'stop'),
      ]);
      return;
    }
    if (!instruction || !captureTools.includes(instruction.name)) {
      sendSse(response, [
        completionChunk({ role: 'assistant', content: 'No contract tool instruction.' }),
        completionChunk({}, 'stop'),
      ]);
      return;
    }
    const toolCallId = instruction.toolCallId ?? `contract-${instruction.name}-${Date.now()}`;
    sendSse(response, [
      completionChunk({
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: toolCallId,
          type: 'function',
          function: {
            name: instruction.name,
            arguments: JSON.stringify(instruction.arguments ?? {}),
          },
        }],
      }),
      completionChunk({}, 'tool_calls'),
    ]);
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(providerPort, '127.0.0.1', resolve);
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
      if (response.ok) return;
    } catch {
      // Gateway is still starting.
    }
    if (gateway?.exitCode !== null) throw new Error(`gateway exited with ${gateway.exitCode}`);
    await sleep(100);
  }
  throw new Error('gateway health check timed out');
}

async function startGateway() {
  const output = createWriteStream(path.join(tempRoot, 'logs', 'gateway-console.log'), { flags: 'a' });
  gateway = spawn(process.execPath, [
    entryPath,
    'gateway',
    '--port', String(gatewayPort),
    '--bind', 'loopback',
    '--token', gatewayToken,
    'run',
  ], {
    cwd: projectRoot,
    env: gatewayEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    frames.push(frame);
  }
}

function waitForFrame(predicate, timeoutMs = 20_000) {
  const queuedIndex = frames.findIndex(predicate);
  if (queuedIndex >= 0) return Promise.resolve(frames.splice(queuedIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        const index = frameWaiters.indexOf(waiter);
        if (index >= 0) frameWaiters.splice(index, 1);
        reject(new Error('gateway frame timed out'));
      }, timeoutMs),
    };
    frameWaiters.push(waiter);
  });
}

async function connectControlUi() {
  rpcSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}`, { headers: { Origin: origin } });
  rpcSocket.on('message', data => {
    try {
      dispatchFrame(JSON.parse(data.toString('utf8')));
    } catch {
      // Ignore non-JSON frames.
    }
  });
  await new Promise((resolve, reject) => {
    rpcSocket.once('open', resolve);
    rpcSocket.once('error', reject);
  });
  await waitForFrame(frame => frame.type === 'event' && frame.event === 'connect.challenge');
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
        version: 'presentation-contract-probe',
        platform: 'node',
        mode: 'webchat',
        displayName: 'Presentation contract probe',
      },
      caps: [],
      role: 'operator',
      scopes: ['operator.admin'],
      auth: { token: gatewayToken },
    },
  }));
  const response = await waitForFrame(frame => frame.type === 'res' && frame.id === id);
  if (!response.ok) throw new Error(`gateway connect failed: ${JSON.stringify(response.error)}`);
}

async function gatewayCall(method, params, timeoutMs = 120_000) {
  const { stdout } = await execFileAsync(process.execPath, [
    entryPath,
    'gateway', 'call', method,
    '--url', `ws://127.0.0.1:${gatewayPort}`,
    '--token', gatewayToken,
    '--params', JSON.stringify(params),
    '--timeout', String(timeoutMs),
    '--json',
  ], {
    cwd: projectRoot,
    env: gatewayEnv(),
    timeout: timeoutMs + 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function controlUiCall(method, params, timeoutMs = 20_000) {
  const id = `rpc-${++requestSequence}`;
  rpcSocket.send(JSON.stringify({ type: 'req', id, method, params }));
  const response = await waitForFrame(
    frame => frame.type === 'res' && frame.id === id,
    timeoutMs,
  );
  if (!response.ok) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
  return response.payload;
}

async function readCaptures() {
  try {
    return (await readFile(capturePath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

async function waitForCapture(runId, kind, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captures = await readCaptures();
    const found = captures.find(item =>
      item.kind === kind && (item.event?.runId === runId || item.context?.runId === runId));
    if (found) return found;
    if (gateway?.exitCode !== null) throw new Error(`gateway exited with ${gateway.exitCode}`);
    await sleep(100);
  }
  throw new Error(`capture timed out: ${kind} ${runId}`);
}

async function waitForToolCapture(toolCallId, kind, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captures = await readCaptures();
    const found = captures.find(item =>
      item.kind === kind &&
      (item.event?.toolCallId === toolCallId || item.context?.toolCallId === toolCallId));
    if (found) return found;
    if (gateway?.exitCode !== null) throw new Error(`gateway exited with ${gateway.exitCode}`);
    await sleep(100);
  }
  throw new Error(`capture timed out: ${kind} ${toolCallId}`);
}

async function runToolCase(toolName, args, index) {
  const sessionKey = `agent:main:presentation-contract-${index}`;
  const runId = `presentation-contract-run-${index}`;
  const result = await gatewayCall('chat.send', {
    sessionKey,
    idempotencyKey: runId,
    deliver: false,
    message: `RC_CONTRACT_TOOL_CALL ${JSON.stringify({ name: toolName, arguments: args })}`,
  });
  const after = await waitForCapture(runId, 'after_tool_call');
  const toolCallId = after.event?.toolCallId ?? after.context?.toolCallId;
  if (!toolCallId) throw new Error(`after_tool_call omitted toolCallId for ${toolName}`);
  // tool_result_persist intentionally has no runId. Correlating it by runId would
  // make the probe assert a contract that OpenClaw does not provide.
  const persisted = await waitForToolCapture(toolCallId, 'tool_result_persist');
  const end = await waitForCapture(runId, 'agent_end');
  return {
    toolName,
    sessionKey,
    requestedRunId: runId,
    acknowledgedRunId: result.runId,
    after,
    persisted,
    agentEndRunId: end.event?.runId ?? end.context?.runId,
  };
}

function hashReplyText(textValue) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < textValue.length; index += 1) {
    hash ^= textValue.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function startLifecycleRun({ sessionKey, runId, pathName, finalText, finalDelayMs, timeoutMs, toolCallId }) {
  const result = await gatewayCall('chat.send', {
    sessionKey,
    idempotencyKey: runId,
    deliver: false,
    ...(timeoutMs ? { timeoutMs } : {}),
    message: `RC_CONTRACT_TOOL_CALL ${JSON.stringify({
      name: 'workspace_save',
      arguments: { path: `outputs/contracts/${pathName}.md`, content: `# ${pathName}\n` },
      finalText,
      finalDelayMs,
      toolCallId,
    })}`,
  });
  return { sessionKey, runId, acknowledgedRunId: result.runId, finalText };
}

async function collectLifecycleRun(started) {
  const after = await waitForCapture(started.runId, 'after_tool_call');
  const toolCallId = after.event?.toolCallId ?? after.context?.toolCallId;
  const persisted = await waitForToolCapture(toolCallId, 'tool_result_persist');
  const end = await waitForCapture(started.runId, 'agent_end');
  return { ...started, after, persisted, end };
}

async function resolveLifecycleReplies(sessionKey, candidates) {
  return controlUiCall('rc.execution.resolve', {
    sessionKey,
    candidates: candidates.map((candidate, index) => ({
      index,
      timestamp: Date.now() + index,
      textHashes: [hashReplyText(candidate.finalText)],
    })),
  });
}

async function runLifecycleProbe() {
  const normal = await startLifecycleRun({
    sessionKey: 'agent:main:presentation-lifecycle-normal',
    runId: 'presentation-lifecycle-run-normal',
    pathName: 'normal',
    finalText: 'Lifecycle normal final.',
    finalDelayMs: 0,
    toolCallId: 'contract-reused-tool-call',
  });
  const normalCaptured = await collectLifecycleRun(normal);

  const queuedSessionKey = 'agent:main:presentation-lifecycle-queued';
  const queuedA = await startLifecycleRun({
    sessionKey: queuedSessionKey,
    runId: 'presentation-lifecycle-run-queued-a',
    pathName: 'queued-a',
    finalText: 'Lifecycle queued A final.',
    finalDelayMs: 1_200,
    toolCallId: 'contract-queued-a',
  });
  const queuedB = await startLifecycleRun({
    sessionKey: queuedSessionKey,
    runId: 'presentation-lifecycle-run-queued-b',
    pathName: 'queued-b',
    finalText: 'Lifecycle queued B final.',
    finalDelayMs: 0,
    toolCallId: 'contract-queued-b',
  });
  const [queuedACaptured, queuedBCaptured] = await Promise.all([
    collectLifecycleRun(queuedA),
    collectLifecycleRun(queuedB),
  ]);

  const timeout = await startLifecycleRun({
    sessionKey: 'agent:main:presentation-lifecycle-timeout',
    runId: 'presentation-lifecycle-run-timeout',
    pathName: 'timeout',
    finalText: 'Lifecycle timeout final must not be delivered.',
    finalDelayMs: 5_000,
    timeoutMs: 1_000,
    toolCallId: 'contract-reused-tool-call',
  });
  const timeoutCaptured = await collectLifecycleRun(timeout);

  const cancelled = await startLifecycleRun({
    sessionKey: 'agent:main:presentation-lifecycle-cancelled',
    runId: 'presentation-lifecycle-run-cancelled',
    pathName: 'cancelled',
    finalText: 'Lifecycle cancelled final must not be delivered.',
    finalDelayMs: 5_000,
    toolCallId: 'contract-reused-tool-call',
  });
  await waitForCapture(cancelled.runId, 'after_tool_call');
  const abortResponse = await controlUiCall('chat.abort', {
    sessionKey: cancelled.sessionKey,
    runId: cancelled.runId,
  });
  const cancelledCaptured = await collectLifecycleRun(cancelled);

  const completed = [normalCaptured, queuedACaptured, queuedBCaptured];
  const incomplete = [timeoutCaptured, cancelledCaptured];
  const normalResolution = await resolveLifecycleReplies(normal.sessionKey, [normal]);
  const queuedResolution = await resolveLifecycleReplies(queuedSessionKey, [queuedA, queuedB]);
  const incompleteResolutions = await Promise.all(incomplete.map(item =>
    resolveLifecycleReplies(item.sessionKey, [item])));
  const historySessionKeys = Array.from(new Set(
    [...completed, ...incomplete].map(item => item.sessionKey),
  ));
  const histories = Object.fromEntries(await Promise.all(historySessionKeys.map(async sessionKey => [
    sessionKey,
    await controlUiCall('chat.history', { sessionKey, limit: 100 }),
  ])));
  const runIds = new Set([...completed, ...incomplete].map(item => item.runId));
  const relevantFrames = frames.filter(frame => {
    if (frame.type !== 'event' || !['agent', 'chat'].includes(frame.event)) return false;
    const runId = frame.payload?.runId ?? frame.payload?.data?.runId;
    return typeof runId === 'string' && runIds.has(runId);
  });

  return {
    cases: Object.fromEntries([...completed, ...incomplete].map(item => [item.runId, item])),
    chatAndAgentFrames: relevantFrames,
    resolver: { normal: normalResolution, queued: queuedResolution, incomplete: incompleteResolutions },
    histories,
    abortResponse,
  };
}

function summarizeCase(item) {
  const afterResult = item.after.event?.result;
  const persistedDetails = item.persisted.event?.message?.details;
  const afterText = afterResult?.content?.find?.(part => part?.type === 'text')?.text;
  const persistedText = item.persisted.event?.message?.content?.find?.(part => part?.type === 'text')?.text;
  return {
    toolName: item.toolName,
    sessionKey: item.sessionKey,
    requestedRunId: item.requestedRunId,
    acknowledgedRunId: item.acknowledgedRunId,
    hookRunId: item.after.event?.runId,
    hookContextRunId: item.after.context?.runId,
    agentEndRunId: item.agentEndRunId,
    toolCallId: item.after.event?.toolCallId,
    afterError: item.after.event?.error,
    afterTextChars: typeof afterText === 'string' ? afterText.length : 0,
    afterDetailsType: Array.isArray(afterResult?.details) ? 'array' : typeof afterResult?.details,
    afterDetailsKeys: afterResult?.details && typeof afterResult.details === 'object' && !Array.isArray(afterResult.details)
      ? Object.keys(afterResult.details)
      : [],
    afterDetailsLength: Array.isArray(afterResult?.details) ? afterResult.details.length : undefined,
    persistedTextChars: typeof persistedText === 'string' ? persistedText.length : 0,
    persistedDetailsTruncated: Boolean(persistedDetails?.persistedDetailsTruncated),
    persistedDetailsType: Array.isArray(persistedDetails) ? 'array' : typeof persistedDetails,
    persistedDetailsKeys: persistedDetails && typeof persistedDetails === 'object' && !Array.isArray(persistedDetails)
      ? Object.keys(persistedDetails)
      : [],
  };
}

async function stopGateway() {
  rpcSocket?.close();
  if (!gateway || gateway.exitCode !== null) return;
  const child = gateway;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  gateway = undefined;
}

async function cleanup() {
  await stopGateway();
  if (provider) await new Promise(resolve => provider.close(resolve));
  if (tempRoot && process.env.RC_KEEP_TEST_ARTIFACTS !== '1') {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  await assertCoreBuildFresh();
  pythonUserSite = (await execFileAsync('python3', ['-m', 'site', '--user-site'])).stdout.trim();
  await Promise.all([assertPortFree(gatewayPort), assertPortFree(providerPort)]);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-presentation-contract-'));
  capturePath = path.join(tempRoot, 'presentation-hooks.jsonl');
  await writeConfig();
  await startProvider();
  await startGateway();
  await connectControlUi();

  if (process.env.RC_CONTRACT_MODE === 'event') {
    const captured = await runToolCase('presentation_event_probe', {}, 1);
    const emittedCapture = await waitForCapture(captured.requestedRunId, 'presentation_event_emitted');
    const deliveredFrame = await waitForFrame(frame =>
      frame.type === 'event'
      && frame.event === 'agent'
      && frame.payload?.runId === captured.requestedRunId
      && frame.payload?.stream === 'research-claw-core.presentation_changed');
    const report = {
      gatewayPort,
      node: process.version,
      openClaw: '2026.6.1',
      tempRoot: process.env.RC_KEEP_TEST_ARTIFACTS === '1' ? tempRoot : undefined,
      event: { captured, emittedCapture, deliveredFrame },
    };
    await writeFile(path.join(tempRoot, 'contract-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ...report,
      event: {
        emitted: emittedCapture.event?.emitted,
        deliveredStream: deliveredFrame.payload?.stream,
        deliveredRunId: deliveredFrame.payload?.runId,
      },
    }, null, 2));
    return;
  }

  if (process.env.RC_CONTRACT_MODE === 'lifecycle') {
    const lifecycle = await runLifecycleProbe();
    const report = {
      gatewayPort,
      node: process.version,
      openClaw: '2026.6.1',
      tempRoot: process.env.RC_KEEP_TEST_ARTIFACTS === '1' ? tempRoot : undefined,
      lifecycle,
    };
    await writeFile(path.join(tempRoot, 'contract-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ...report,
      lifecycle: {
        cases: Object.fromEntries(Object.entries(lifecycle.cases).map(([runId, item]) => [runId, {
          acknowledgedRunId: item.acknowledgedRunId,
          hookRunId: item.after.event?.runId,
          toolCallId: item.after.event?.toolCallId,
          agentEndSuccess: item.end.event?.success,
          agentEndDurationMs: item.end.event?.durationMs,
        }])),
        resolver: lifecycle.resolver,
        abortResponse: lifecycle.abortResponse,
        frameCount: lifecycle.chatAndAgentFrames.length,
      },
    }, null, 2));
    return;
  }

  const allCases = [
    ['workspace_save', { path: 'outputs/contracts/base.csv', content: 'title,year\nFixture,2026\n' }],
    ['workspace_append', { path: 'outputs/contracts/base.csv', content: 'Second,2025\n' }],
    ['workspace_export', { source: 'outputs/contracts/base.csv', format: 'xlsx', output: 'outputs/contracts/base.xlsx' }],
    ['workspace_download', { url: 'https://example.com/', path: 'outputs/contracts/example.html' }],
    ['get_arxiv_paper', { arxiv_id: '1706.03762' }],
    ['search_openalex', { query: 'attention is all you need', limit: 1 }],
    ['search_crossref', { query: 'attention is all you need', limit: 1 }],
    ['search_arxiv', { query: 'all:"attention is all you need"', max_results: 1 }],
    ['search_dblp', { query: 'attention is all you need', max_results: 1 }],
    ['rp_search', { query: 'scientific knowledge graph', limit: 1 }],
    ['wentor-network__search_papers', { query: 'scientific knowledge graph', top_k: 1 }],
  ];
  const selectedNames = new Set(
    String(process.env.RC_CONTRACT_CASES ?? '').split(',').map(item => item.trim()).filter(Boolean),
  );
  const cases = selectedNames.size > 0
    ? allCases.filter(([toolName]) => selectedNames.has(toolName))
    : allCases;
  const captured = [];
  for (let index = 0; index < cases.length; index += 1) {
    const [toolName, args] = cases[index];
    captured.push(await runToolCase(toolName, args, index + 1));
  }

  const summaries = captured.map(summarizeCase);
  const missing = summaries.filter(item =>
    !item.hookRunId || !item.toolCallId || item.requestedRunId !== item.hookRunId);
  if (missing.length > 0) {
    throw new Error(`run/tool identity mismatch: ${JSON.stringify(missing, null, 2)}`);
  }
  const report = {
    gatewayPort,
    node: process.version,
    openClaw: '2026.6.1',
    tempRoot: process.env.RC_KEEP_TEST_ARTIFACTS === '1' ? tempRoot : undefined,
    cases: summaries,
    customFramesObserved: frames.filter(frame =>
      frame.type === 'event' && frame.event === 'agent' && String(frame.payload?.stream ?? '').includes('.')).length,
  };
  await writeFile(path.join(tempRoot, 'contract-report.json'), JSON.stringify({ ...report, captured }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

try {
  await main();
} catch (error) {
  if (tempRoot) {
    await appendFile(path.join(tempRoot, 'failure.txt'), `${error?.stack ?? error}\n`).catch(() => {});
    console.error(`presentation hook probe artifacts: ${tempRoot}`);
  }
  throw error;
} finally {
  await cleanup();
}
