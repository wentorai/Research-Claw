#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const entryPath = path.join(projectRoot, 'node_modules', 'openclaw', 'dist', 'entry.js');
const corePath = path.join(projectRoot, 'extensions', 'research-claw-core');
const gatewayPort = Number(process.env.RC_TEST_GATEWAY_PORT ?? 28799);
const providerPort = Number(process.env.RC_TEST_PROVIDER_PORT ?? 28801);
const gatewayToken = 'rc-runtime-self-check';
const sessionKey = 'agent:main:main';

let tempRoot;
let gateway;
let provider;
let providerRequests = 0;

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
  const sources = [
    path.join(corePath, 'index.ts'),
    path.join(corePath, 'src', 'self-check', 'activation-probe.ts'),
    path.join(corePath, 'src', 'self-check', 'runtime-probe.ts'),
  ];
  const artifact = path.join(corePath, 'dist', 'index.js');
  let artifactStat;
  try {
    artifactStat = await stat(artifact);
  } catch {
    throw new Error(
      'core build missing; run `pnpm --dir extensions/research-claw-core build` before verification',
    );
  }
  for (const source of sources) {
    if ((await stat(source)).mtimeMs > artifactStat.mtimeMs) {
      throw new Error(
        'core build is stale; run `pnpm --dir extensions/research-claw-core build` before verification',
      );
    }
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

async function writeSkill(name) {
  const skillDir = path.join(tempRoot, 'workspace', 'skills', name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Runtime budget fixture ${name}\n---\n\n# ${name}\n\nUse this fixture for runtime reconciliation.\n`,
  );
}

async function writeNativeResearchPluginsFixture() {
  const pluginDir = path.join(tempRoot, 'state', 'extensions', 'research-plugins');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, 'openclaw.plugin.json'),
    JSON.stringify({
      id: 'research-plugins',
      name: 'Research Plugins acceptance fixture',
      version: '1.4.7-fixture',
      main: 'index.js',
      contracts: {
        tools: ['rp_missing_tool_alpha', 'rp_missing_tool_beta'],
      },
      configSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    }, null, 2),
  );
  await writeFile(
    path.join(pluginDir, 'index.js'),
    `export default {
  id: 'research-plugins',
  name: 'Research Plugins acceptance fixture',
  contracts: { tools: ['rp_missing_tool_alpha', 'rp_missing_tool_beta'] },
  register(api) {
    api.registerTool({ name: 'fixture_should_not_activate', description: 'not expected', execute: async () => ({ ok: true }) });
  },
};\n`,
  );
}

async function writeHealthyNativeResearchPluginsFixture() {
  const pluginDir = path.join(tempRoot, 'state', 'extensions', 'research-plugins');
  await writeFile(
    path.join(pluginDir, 'openclaw.plugin.json'),
    JSON.stringify({
      id: 'research-plugins',
      name: 'Research Plugins healthy acceptance fixture',
      version: '1.4.8-fixture',
      main: 'index.js',
      activation: { onStartup: true },
      contracts: { tools: [] },
      configSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    }, null, 2),
  );
  await writeFile(
    path.join(pluginDir, 'index.js'),
    `export default {
  id: 'research-plugins',
  name: 'Research Plugins healthy acceptance fixture',
  contracts: { tools: [] },
  register() {},
};\n`,
  );
}

async function writeConfig() {
  const stateDir = path.join(tempRoot, 'state');
  const workspaceDir = path.join(tempRoot, 'workspace');
  await Promise.all([
    mkdir(path.join(tempRoot, 'home'), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(path.join(tempRoot, 'data'), { recursive: true }),
    mkdir(path.join(tempRoot, 'logs'), { recursive: true }),
    mkdir(path.join(stateDir, 'logs', 'stability'), { recursive: true }),
  ]);
  await Promise.all([
    writeSkill('alpha'),
    writeSkill('bravo'),
    writeSkill('charlie'),
    writeNativeResearchPluginsFixture(),
  ]);
  await writeFile(
    path.join(stateDir, 'logs', 'stability', 'gateway-startup_failed-fixture.json'),
    JSON.stringify({ fixture: true }),
  );
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
          model: { primary: 'fixture/healthy' },
          timeoutSeconds: 15,
        },
      },
      models: {
        mode: 'merge',
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${providerPort}/v1`,
            apiKey: 'isolated-fixture-only',
            api: 'openai-completions',
            models: [{
              id: 'healthy',
              name: 'Runtime self-check fixture',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 128,
            }],
          },
        },
      },
      skills: {
        allowBundled: ['fixture-no-bundled-skills'],
        limits: {
          maxSkillsInPrompt: 1,
          maxSkillsPromptChars: 30_000,
        },
      },
      logging: {
        level: 'debug',
        file: path.join(tempRoot, 'logs', 'openclaw.log'),
      },
      plugins: {
        enabled: true,
        allow: ['research-claw-core', 'research-plugins'],
        load: { paths: [corePath] },
        entries: {
          'research-claw-core': {
            enabled: true,
            hooks: { allowConversationAccess: true },
            config: {
              dbPath: path.join(tempRoot, 'data', 'library.db'),
              autoTrackGit: false,
              pptRoot: path.join(tempRoot, 'ppt'),
            },
          },
          'research-plugins': { enabled: true },
        },
      },
    }, null, 2),
  );
}

function sendCompletion(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-runtime-self-check',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'healthy',
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: 'runtime self-check complete' },
      finish_reason: null,
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-runtime-self-check',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'healthy',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function startProvider() {
  provider = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'healthy', object: 'model', owned_by: 'fixture' }],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      providerRequests += 1;
      for await (const _chunk of request) {
        // Drain request body before responding.
      }
      sendCompletion(response);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(providerPort, '127.0.0.1', resolve);
  });
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

async function stopGateway() {
  if (!gateway || gateway.exitCode !== null) return;
  const child = gateway;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(3_000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  gateway = undefined;
}

// Each call cold-starts the OpenClaw CLI, the dominant and most variable cost.
// The deadline of every poll that wraps a call is derived from this rather than
// written as a literal: a deadline at or below one call's budget cannot outlive a
// single slow call, so its retry loop would never run a second attempt.
const GATEWAY_CALL_TIMEOUT_MS = 30_000;
/** Room for a hung call plus real retries after it. */
const POLL_DEADLINE_MS = GATEWAY_CALL_TIMEOUT_MS * 3;

async function gatewayCall(method, params, timeoutMs = GATEWAY_CALL_TIMEOUT_MS) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      entryPath,
      'gateway',
      'call',
      method,
      '--url',
      `ws://127.0.0.1:${gatewayPort}`,
      '--token',
      gatewayToken,
      '--params',
      JSON.stringify(params),
      '--timeout',
      String(timeoutMs),
      '--json',
    ],
    {
      cwd: projectRoot,
      env: isolatedEnv(),
      timeout: timeoutMs + 5_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

async function waitForNotifications(predicate, description) {
  // A transient call failure must not fail the run: each call pays a full CLI
  // cold start, so a busy machine can exceed the per-call budget without the
  // gateway being unhealthy. Only the deadline is allowed to fail this.
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const pending = await gatewayCall('rc.notifications.pending', {});
      if (predicate(pending.custom ?? [])) return pending.custom;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `notification polling timed out: ${description}${lastError ? `; last error: ${lastError.message}` : ''}`,
  );
}

function parseLogRecords(rawLogs) {
  return rawLogs
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        const record = JSON.parse(line);
        return {
          level: record._meta?.logLevelName ?? record.levelName ?? record.level,
          message: record.message ?? record['1'] ?? record.msg ?? line,
        };
      } catch {
        return { level: undefined, message: line };
      }
    });
}

async function waitForLogFragment(fragment, afterByte = 0) {
  const logPath = path.join(tempRoot, 'logs', 'openclaw.log');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(logPath);
      const records = parseLogRecords(raw.subarray(afterByte).toString('utf8'));
      if (records.some(record => record.message.includes(fragment))) return records;
    } catch {
      // Log has not been written yet.
    }
    await sleep(100);
  }
  throw new Error(`gateway log omitted: ${fragment}`);
}

async function setResearchPluginsConfigured(enabled) {
  const configPath = path.join(tempRoot, 'state', 'openclaw.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const allow = config.plugins.allow.filter(pluginId => pluginId !== 'research-plugins');
  if (enabled) allow.push('research-plugins');
  config.plugins.allow = allow;
  if (enabled) {
    config.plugins.entries['research-plugins'] = { enabled: true };
  } else {
    delete config.plugins.entries['research-plugins'];
  }
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

async function proveProbeFailureIsNonFatal() {
  const extensionsPath = path.join(tempRoot, 'state', 'extensions');
  const savedExtensionsPath = path.join(tempRoot, 'state', 'extensions.saved');
  await setResearchPluginsConfigured(false);
  await rename(extensionsPath, savedExtensionsPath);
  await writeFile(extensionsPath, 'intentionally not a directory');
  const logOffset = (await stat(path.join(tempRoot, 'logs', 'openclaw.log'))).size;
  try {
    await startGateway();
    await waitForLogFragment('probe error (non-fatal)', logOffset);
  } finally {
    await stopGateway();
    await rm(extensionsPath, { force: true });
    await rename(savedExtensionsPath, extensionsPath);
    await setResearchPluginsConfigured(true);
  }
}

async function proveThreeHealthyColdStartsHaveNoSelfCheckWarnings() {
  await writeHealthyNativeResearchPluginsFixture();
  const stabilityDir = path.join(tempRoot, 'state', 'logs', 'stability');
  for (const name of await readdir(stabilityDir)) {
    if (name.includes('startup_failed') && name.endsWith('.json')) {
      await rm(path.join(stabilityDir, name), { force: true });
    }
  }
  const logPath = path.join(tempRoot, 'logs', 'openclaw.log');
  const logOffset = (await stat(logPath)).size;
  for (let index = 0; index < 3; index += 1) {
    const coldStartOffset = (await stat(logPath)).size;
    await startGateway();
    await waitForLogFragment('plugin activation audit passed', coldStartOffset);
    await stopGateway();
  }
  const raw = await readFile(logPath);
  const warningRecords = parseLogRecords(raw.subarray(logOffset).toString('utf8')).filter(
    record =>
      record.message.includes('[self-check]') &&
      ['WARN', 'warn', 4, 40].includes(record.level),
  );
  if (warningRecords.length > 0) {
    throw new Error(
      `healthy cold starts emitted self-check warnings: ${warningRecords.map(item => item.message).join(' | ')}`,
    );
  }
}

async function waitForSystemPromptReport() {
  const storePath = path.join(
    tempRoot,
    'state',
    'agents',
    'main',
    'sessions',
    'sessions.json',
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const store = JSON.parse(await readFile(storePath, 'utf8'));
      const report = store[sessionKey]?.systemPromptReport;
      if (report?.source === 'run') return report;
    } catch {
      // Agent run has not persisted its report yet.
    }
    await sleep(100);
  }
  throw new Error('systemPromptReport was not persisted');
}

function requireSingleNotification(notifications, title) {
  const matching = notifications.filter(item => item.title === title);
  if (matching.length !== 1) {
    throw new Error(`expected one "${title}" notification, got ${matching.length}`);
  }
  return matching[0];
}

async function cleanup() {
  await stopGateway();
  if (provider) {
    await new Promise(resolve => provider.close(resolve));
    provider = undefined;
  }
  if (tempRoot && process.env.RC_KEEP_TEST_ARTIFACTS !== '1') {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  await assertCoreBuildFresh();
  await Promise.all([assertPortFree(gatewayPort), assertPortFree(providerPort)]);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-runtime-self-check-'));
  await writeConfig();
  await startProvider();

  // Two cold starts against the same DB prove unread notification dedupe.
  await startGateway();
  await waitForNotifications(
    notifications =>
      notifications.some(item => item.title === '插件未正确加载:research-plugins') &&
      notifications.some(item => item.title === '网关近期启动失败'),
    'native plugin and state-dir stability findings',
  );
  await stopGateway();
  await startGateway();
  const startupNotifications = await waitForNotifications(
    notifications =>
      notifications.some(item => item.title === '插件未正确加载:research-plugins') &&
      notifications.some(item => item.title === '网关近期启动失败'),
    'deduplicated startup findings after restart',
  );
  const activationNotice = requireSingleNotification(
    startupNotifications,
    '插件未正确加载:research-plugins',
  );
  requireSingleNotification(startupNotifications, '网关近期启动失败');
  if (!activationNotice.body?.includes('activation.onStartup:true')) {
    throw new Error(`native plugin finding lacks activation evidence: ${activationNotice.body}`);
  }

  await gatewayCall('chat.send', {
    message: 'Reply briefly for a runtime self-check.',
    sessionKey,
    idempotencyKey: randomUUID(),
  });
  const report = await waitForSystemPromptReport();
  const runtimeNotifications = await waitForNotifications(
    notifications =>
      notifications.some(item => item.title === '插件工具未实际挂载') &&
      notifications.some(item => item.title === '技能预算发生截断'),
    'actual tools and skills reconciliation',
  );
  const toolsNotice = requireSingleNotification(runtimeNotifications, '插件工具未实际挂载');
  const skillsNotice = requireSingleNotification(runtimeNotifications, '技能预算发生截断');
  for (const expected of ['rp_missing_tool_alpha', 'rp_missing_tool_beta']) {
    if (!toolsNotice.body?.includes(expected)) {
      throw new Error(`mounted-tool finding omitted ${expected}: ${toolsNotice.body}`);
    }
  }
  for (const expected of ['bravo', 'charlie']) {
    if (!skillsNotice.body?.includes(expected)) {
      throw new Error(`skills truncation finding omitted ${expected}: ${skillsNotice.body}`);
    }
  }
  if (report.skills.entries.length !== 1) {
    throw new Error(`expected exactly one injected skill, got ${report.skills.entries.length}`);
  }
  if (providerRequests < 1) throw new Error('mock provider was never called');

  const rawLogs = await readFile(path.join(tempRoot, 'logs', 'openclaw.log'), 'utf8');
  const logs = parseLogRecords(rawLogs).map(record => record.message).join('\n');
  for (const expected of [
    'Plugin "research-plugins" advertises 2 tool(s)',
    'rp_missing_tool_alpha',
    '被截断 2 个：bravo, charlie',
  ]) {
    if (!logs.includes(expected)) throw new Error(`gateway log omitted: ${expected}`);
  }

  await stopGateway();
  await proveProbeFailureIsNonFatal();
  await proveThreeHealthyColdStartsHaveNoSelfCheckWarnings();

  console.log(JSON.stringify({
    gatewayPort,
    nativePluginPath: path.join(tempRoot, 'state', 'extensions', 'research-plugins'),
    startupNotificationCounts: {
      activation: startupNotifications.filter(
        item => item.title === '插件未正确加载:research-plugins',
      ).length,
      stability: startupNotifications.filter(item => item.title === '网关近期启动失败').length,
    },
    runtime: {
      mountedTools: report.tools.entries.length,
      injectedSkills: report.skills.entries.map(entry => entry.name),
      missingTools: ['rp_missing_tool_alpha', 'rp_missing_tool_beta'],
      truncatedSkills: ['bravo', 'charlie'],
    },
    probeFailureNonFatal: true,
    healthyColdStartsWithoutSelfCheckWarnings: 3,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  if (tempRoot) {
    for (const name of ['gateway-console.log', 'openclaw.log']) {
      try {
        const content = await readFile(path.join(tempRoot, 'logs', name), 'utf8');
        console.error(`[${name}]\n${content.slice(-12_000)}`);
      } catch {
        // Best-effort diagnostics.
      }
    }
  }
  throw error;
} finally {
  await cleanup();
}
