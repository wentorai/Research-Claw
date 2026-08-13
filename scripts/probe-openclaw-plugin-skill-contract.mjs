#!/usr/bin/env node

/**
 * OpenClaw 2026.6.1 contract probe for two Bootstrap Capsule assumptions:
 *
 * 1. contracts.tools is an allowlist, not a synthetic runtime inventory. A
 *    manifest-declared tool deliberately omitted by register() must not reach
 *    the model prompt and must not make plugin loading unhealthy.
 * 2. a Profile Skill placed directly under <workspace>/skills wins a same-name
 *    collision with managed/extra sources and is present in the real run's
 *    systemPromptReport. Grouped discovery is observed but never relied upon.
 *
 * Every persistent path and network listener lives below mkdtemp/ephemeral
 * loopback ports. No user OpenClaw state or external model is read.
 */

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openClawPackage = path.join(projectRoot, 'node_modules', 'openclaw', 'package.json');
const openClawEntry = path.join(projectRoot, 'node_modules', 'openclaw', 'dist', 'entry.js');
const requiredOpenClawVersion = '2026.6.1';
const gatewayToken = 't01-isolated-gateway-token';
const sessionKey = 'agent:main:main';
const profileSkill = 'rc-profile-contract-probe';
const groupedSkill = 'rc-grouped-contract-probe';
const registeredTool = 'rc_contract_registered';
const omittedTool = 'rc_contract_omitted';
const registeredRpc = 'rc.contract.registered';
const omittedRpc = 'rc.contract.omitted';
const CLI_TIMEOUT_MS = 30_000;

let tempRoot;
let provider;
let gateway;
let gatewaySpawnError;
let cleanupPromise;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(stdout) {
  const source = stdout.trim();
  for (let index = source.indexOf('{'); index >= 0; index = source.indexOf('{', index + 1)) {
    try {
      return JSON.parse(source.slice(index));
    } catch {
      // OpenClaw may print a launcher banner before --json output.
    }
  }
  throw new Error(`OpenClaw output did not contain JSON: ${source.slice(0, 500)}`);
}

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  invariant(address && typeof address === 'object', 'failed to reserve an ephemeral port');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function isolatedEnv() {
  // Do not forward arbitrary host credentials or OPENCLAW_* switches into the
  // probe. Only process-launch essentials survive; all state and auth inputs
  // below are explicit fake fixture values.
  const inherited = {};
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot',
    'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI',
  ]) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  const env = {
    ...inherited,
    HOME: path.join(tempRoot, 'home'),
    USERPROFILE: path.join(tempRoot, 'home'),
    XDG_CACHE_HOME: path.join(tempRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(tempRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(tempRoot, 'xdg-data'),
    XDG_STATE_HOME: path.join(tempRoot, 'xdg-state'),
    OPENCLAW_STATE_DIR: path.join(tempRoot, 'state'),
    OPENCLAW_CONFIG_PATH: path.join(tempRoot, 'state', 'openclaw.json'),
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
  // A probe launched by Vitest must still exercise the production OC runtime;
  // VITEST makes OC select test-only capability shims and may suppress CLI IO.
  for (const key of Object.keys(env)) {
    if (key === 'VITEST' || key.startsWith('VITEST_')) delete env[key];
  }
  return env;
}

async function writeSkill(root, name, description, body) {
  const skillDir = path.join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
  );
  return skillDir;
}

async function writeFixture({ gatewayPort, providerPort }) {
  const homeDir = path.join(tempRoot, 'home');
  const stateDir = path.join(tempRoot, 'state');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const extraSkillsDir = path.join(tempRoot, 'extra-skills');
  const managedSkillsDir = path.join(stateDir, 'skills');
  const pluginDir = path.join(tempRoot, 'conditional-plugin');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(extraSkillsDir, { recursive: true }),
    mkdir(managedSkillsDir, { recursive: true }),
    mkdir(pluginDir, { recursive: true }),
  ]);

  await Promise.all([
    writeSkill(
      extraSkillsDir,
      profileSkill,
      'EXTRA collision sentinel that must lose to workspace.',
      'EXTRA_COLLISION_SENTINEL',
    ),
    writeSkill(
      managedSkillsDir,
      profileSkill,
      'MANAGED collision sentinel that must lose to workspace.',
      'MANAGED_COLLISION_SENTINEL',
    ),
    writeSkill(
      path.join(homeDir, '.agents', 'skills'),
      profileSkill,
      'PERSONAL AGENTS collision sentinel that must lose to workspace.',
      'PERSONAL_AGENTS_COLLISION_SENTINEL',
    ),
    writeSkill(
      path.join(workspaceDir, '.agents', 'skills'),
      profileSkill,
      'PROJECT AGENTS collision sentinel that must lose to workspace.',
      'PROJECT_AGENTS_COLLISION_SENTINEL',
    ),
    writeSkill(
      path.join(workspaceDir, 'skills'),
      profileSkill,
      'WORKSPACE highest-precedence Profile Skill sentinel.',
      'WORKSPACE_PROFILE_SENTINEL',
    ),
    // OC 2026.6.1 currently scans grouped directories recursively. This is an
    // observation only: Capsule Skills themselves remain exactly one level deep.
    writeSkill(
      path.join(workspaceDir, 'skills', 'group'),
      groupedSkill,
      'Grouped recursive discovery observation sentinel.',
      'GROUPED_DISCOVERY_SENTINEL',
    ),
  ]);

  await writeFile(
    path.join(pluginDir, 'package.json'),
    `${JSON.stringify({
      name: 'openclaw-plugin-rc-t01-contract-probe',
      version: '0.0.0-probe',
      type: 'module',
      private: true,
      openclaw: { extensions: ['./index.js'] },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(pluginDir, 'openclaw.plugin.json'),
    `${JSON.stringify({
      id: 'rc-t01-contract-probe',
      name: 'RC T01 conditional contract probe',
      version: '0.0.0-probe',
      description: 'Isolated conditional registration probe',
      main: 'index.js',
      activation: { onStartup: true },
      contracts: { tools: [registeredTool, omittedTool] },
      configSchema: { type: 'object', properties: {}, additionalProperties: false },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(pluginDir, 'index.js'),
    `export default {
  id: 'rc-t01-contract-probe',
  name: 'RC T01 conditional contract probe',
  contracts: { tools: ['${registeredTool}', '${omittedTool}'] },
  register(api) {
    api.registerTool({
      name: '${registeredTool}',
      description: 'Actually registered T01 sentinel tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ ok: true }),
    });
    // ${omittedTool} is deliberately not registered: this models disabled
    // peripherals while preserving the unconditional contracts.tools allowlist.
    api.registerGatewayMethod('${registeredRpc}', (opts) => opts.respond(true, { ok: true }));
    // ${omittedRpc} is deliberately not registered either.
  },
};
`,
  );

  await writeFile(
    path.join(stateDir, 'openclaw.json'),
    `${JSON.stringify({
      gateway: {
        mode: 'local',
        bind: 'loopback',
        auth: { mode: 'token', token: gatewayToken },
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
            apiKey: 't01-explicit-fake-secret',
            api: 'openai-completions',
            models: [{
              id: 'healthy',
              name: 'T01 deterministic local fixture',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 128,
            }],
          },
        },
      },
      skills: {
        allowBundled: ['rc-t01-no-bundled-skills'],
        load: { extraDirs: [extraSkillsDir] },
        limits: { maxSkillsInPrompt: 100, maxSkillsPromptChars: 30000 },
      },
      plugins: {
        enabled: true,
        allow: ['rc-t01-contract-probe'],
        load: { paths: [pluginDir] },
        entries: { 'rc-t01-contract-probe': { enabled: true } },
      },
      logging: {
        level: 'debug',
        file: path.join(tempRoot, 'openclaw.log'),
      },
    }, null, 2)}\n`,
  );

  return { workspaceDir, pluginDir };
}

async function runCli(args, timeoutMs = CLI_TIMEOUT_MS) {
  const { stdout } = await execFileAsync(process.execPath, [openClawEntry, ...args], {
    cwd: projectRoot,
    env: isolatedEnv(),
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
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
      for await (const _chunk of request) {
        // Drain the local request.
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-t01',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'healthy',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'T01 complete' }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-t01',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'healthy',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  invariant(address && typeof address === 'object', 'local provider did not bind a port');
  return address.port;
}

async function waitForGateway(port) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    if (gatewaySpawnError) throw gatewaySpawnError;
    if (gateway && childExited(gateway)) {
      throw new Error(`gateway exited with ${gateway.exitCode ?? gateway.signalCode}`);
    }
    await sleep(100);
  }
  throw new Error('gateway health timeout');
}

async function startGateway() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const port = await reservePort();
    gatewaySpawnError = undefined;
    gateway = spawn(
      process.execPath,
      [openClawEntry, 'gateway', '--port', String(port), '--bind', 'loopback', '--token', gatewayToken, 'run'],
      { cwd: projectRoot, env: isolatedEnv(), stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    gateway.once('error', (error) => { gatewaySpawnError = error; });
    gateway.stderr.setEncoding('utf8');
    gateway.stderr.on('data', (chunk) => {
      if (stderr.length < 100_000) stderr += chunk;
    });
    try {
      await waitForGateway(port);
      return port;
    } catch (error) {
      const detail = `${error instanceof Error ? error.message : String(error)}\n${stderr.slice(-5000)}`;
      await stopGateway();
      if (attempt < 5 && /EADDRINUSE|address already in use|port .* occupied/iu.test(detail)) continue;
      throw new Error(detail);
    }
  }
  throw new Error('failed to bind isolated Gateway after five attempts');
}

async function stopGateway() {
  if (!gateway) return;
  const child = gateway;
  if (childExited(child)) {
    gateway = undefined;
    return;
  }
  const waitForExit = (timeoutMs) => Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeoutMs).then(() => false),
  ]);
  child.kill('SIGTERM');
  await waitForExit(3000);
  if (!childExited(child)) {
    child.kill('SIGKILL');
    await waitForExit(3000);
  }
  invariant(childExited(child), 'isolated Gateway did not terminate during cleanup');
  gateway = undefined;
}

async function readHelloMethods(gatewayPort) {
  const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}`);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, methods) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(methods);
    };
    const timer = setTimeout(() => finish(new Error('gateway hello timeout')), 15_000);
    socket.addEventListener('error', () => finish(new Error('gateway websocket failed')));
    socket.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          socket.send(JSON.stringify({
            type: 'req',
            id: randomUUID(),
            method: 'connect',
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              client: { id: 'cli', version: '2026.6.1', platform: process.platform, mode: 'cli' },
              role: 'operator',
              scopes: ['operator.admin', 'operator.read', 'operator.write'],
              auth: { token: gatewayToken },
            },
          }));
          return;
        }
        if (frame.type === 'res') {
          if (!frame.ok) finish(new Error(`gateway connect rejected: ${JSON.stringify(frame.error)}`));
          else finish(null, frame.payload?.features?.methods ?? []);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function gatewayCall(gatewayPort, method, params) {
  return parseJson(await runCli([
    'gateway', 'call', method,
    '--url', `ws://127.0.0.1:${gatewayPort}`,
    '--token', gatewayToken,
    '--params', JSON.stringify(params),
    '--timeout', String(CLI_TIMEOUT_MS),
    '--json',
  ], CLI_TIMEOUT_MS + 5000));
}

async function waitForPromptReport() {
  const filePath = path.join(tempRoot, 'state', 'agents', 'main', 'sessions', 'sessions.json');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const store = JSON.parse(await readFile(filePath, 'utf8'));
      const report = store[sessionKey]?.systemPromptReport;
      if (report?.source === 'run') return report;
    } catch {
      // Run has not persisted its report yet.
    }
    await sleep(100);
  }
  throw new Error('real run did not persist systemPromptReport');
}

function selectPluginInspection(raw) {
  const record = raw?.plugin ?? raw;
  return {
    id: record?.id,
    status: record?.status,
    toolNames: record?.toolNames ?? record?.tools ?? [],
    diagnostics: raw?.diagnostics ?? record?.diagnostics ?? [],
  };
}

async function cleanup() {
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

function cleanupOnce() {
  cleanupPromise ??= cleanup();
  return cleanupPromise;
}

async function main() {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-t01-plugin-skill-'));
  let openClawManifest;
  try {
    openClawManifest = JSON.parse(await readFile(openClawPackage, 'utf8'));
  } catch (error) {
    throw new Error(
      `cannot verify installed OpenClaw contract version at ${openClawPackage}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const openClawVersion = typeof openClawManifest?.version === 'string'
    ? openClawManifest.version
    : '';
  invariant(
    openClawVersion === requiredOpenClawVersion,
    `refusing to probe OpenClaw ${openClawVersion || '<missing version>'}; `
      + `T01 contract is locked to ${requiredOpenClawVersion}`,
  );
  // Keep the provider bound while selecting the Gateway port, eliminating both
  // same-port selection and the provider's bind-after-reservation race.
  const providerPort = await startProvider();
  const { workspaceDir } = await writeFixture({ providerPort });

  const skillList = parseJson(await runCli(['skills', 'list', '--json', '--agent', 'main']));
  const profileInfo = parseJson(await runCli(['skills', 'info', profileSkill, '--json', '--agent', 'main']));
  const groupedInfo = parseJson(await runCli(['skills', 'info', groupedSkill, '--json', '--agent', 'main']));
  const pluginInspection = selectPluginInspection(parseJson(await runCli([
    'plugins', 'inspect', 'rc-t01-contract-probe', '--runtime', '--json',
  ])));

  const gatewayPort = await startGateway();
  const helloMethods = await readHelloMethods(gatewayPort);
  await gatewayCall(gatewayPort, 'chat.send', {
    message: 'Reply briefly for the isolated T01 contract probe.',
    sessionKey,
    idempotencyKey: randomUUID(),
  });
  const report = await waitForPromptReport();

  const inventory = report.tools.entries.map((entry) => entry.name).sort();
  const promptSkills = report.skills.entries.map((entry) => entry.name).sort();
  const profileEntry = skillList.skills.find((entry) => entry.name === profileSkill);

  invariant(profileEntry, 'one-level Profile Skill was not discovered');
  invariant(profileInfo.source === 'openclaw-workspace', `workspace did not win collision: ${profileInfo.source}`);
  invariant(
    profileInfo.filePath === path.join(workspaceDir, 'skills', profileSkill, 'SKILL.md'),
    `Profile Skill resolved to the wrong path: ${profileInfo.filePath}`,
  );
  invariant(groupedInfo.source === 'openclaw-workspace', 'grouped recursive observation was not discovered');
  invariant(inventory.includes(registeredTool), 'registered tool missing from real model inventory');
  invariant(!inventory.includes(omittedTool), 'manifest-only omitted tool leaked into real model inventory');
  invariant(helloMethods.includes(registeredRpc), 'registered RPC missing from hello method inventory');
  invariant(!helloMethods.includes(omittedRpc), 'omitted RPC leaked into hello method inventory');
  invariant(promptSkills.includes(profileSkill), 'Profile Skill missing from real prompt snapshot');
  invariant(
    !pluginInspection.diagnostics.some((entry) => entry?.level === 'error'),
    `conditional omission made plugin unhealthy: ${JSON.stringify(pluginInspection.diagnostics)}`,
  );

  const output = {
    openClawVersion,
    isolation: {
      tempRoot: '<mkdtemp>',
      home: '<mkdtemp>/home',
      state: '<mkdtemp>/state',
      workspace: '<mkdtemp>/workspace',
      gatewayPort: '<ephemeral>',
      providerPort: '<ephemeral>',
      configuredNetworkEndpoints: 'loopback-only',
    },
    conditionalPlugin: {
      manifestDeclaredTools: [registeredTool, omittedTool],
      runtimeModelInventory: inventory.filter((name) => name.startsWith('rc_contract_')),
      registeredToolPresent: inventory.includes(registeredTool),
      omittedToolAbsent: !inventory.includes(omittedTool),
      registeredRpcPresent: helloMethods.includes(registeredRpc),
      omittedRpcAbsent: !helloMethods.includes(omittedRpc),
      pluginInspection,
      conclusion: 'contracts.tools is an allowlist; deliberate omission does not synthesize a runtime tool',
    },
    skillDiscovery: {
      oneLevelProfile: {
        name: profileSkill,
        source: profileInfo.source,
        path: `<workspace>/skills/${profileSkill}/SKILL.md`,
        modelVisible: profileEntry.modelVisible,
      },
      collisionWinner: 'openclaw-workspace',
      observedGroupedRecursiveSkill: {
        name: groupedSkill,
        source: groupedInfo.source,
        path: `<workspace>/skills/group/${groupedSkill}/SKILL.md`,
      },
      promptSnapshot: {
        source: report.source,
        profileSkillPresent: promptSkills.includes(profileSkill),
        skillNames: promptSkills.filter((name) => name.startsWith('rc-')),
      },
      stableCapsuleContract: '<workspace>/skills/<one-level-managed-dir>/SKILL.md',
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    void cleanupOnce().finally(() => process.exit(exitCode));
  });
}

try {
  await main();
} finally {
  await cleanupOnce();
}
