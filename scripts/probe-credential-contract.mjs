#!/usr/bin/env node
/**
 * OpenClaw 2026.6.1 credential contract probe.
 *
 * The probe is deliberately offline and hermetic: it creates a temporary HOME,
 * state directory, config and auth store, then points the real OpenClaw CLI and
 * embedded agent runner at a deterministic loopback OpenAI-compatible server.
 * No caller config or credentials are read.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const ENTRY = path.join(ROOT, 'node_modules', 'openclaw', 'dist', 'entry.js');
const OPENCLAW_PACKAGE = path.join(ROOT, 'node_modules', 'openclaw', 'package.json');
const EXPECTED_OPENCLAW_VERSION = '2026.6.1';
const PROVIDER = 'custom-rc-profile-probe';
const MODEL = 'deterministic';
const PROFILE_ID = `${PROVIDER}:managed`;
const CONFIG_KEY = 'rc-fixture-config-key';
const PROFILE_KEY = 'rc-fixture-profile-key';
const REPLY = 'RC_CREDENTIAL_PROBE_OK';
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

class ProbeInterruptedError extends Error {
  constructor(signal) {
    super(`credential contract probe interrupted by ${signal}`);
    this.name = 'ProbeInterruptedError';
    this.signal = signal;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertOpenClawVersion() {
  const manifest = JSON.parse(await readFile(OPENCLAW_PACKAGE, 'utf8'));
  const actual = typeof manifest.version === 'string' ? manifest.version : '<missing>';
  assert(
    actual === EXPECTED_OPENCLAW_VERSION,
    `OpenClaw version mismatch: expected ${EXPECTED_OPENCLAW_VERSION}, found ${actual}`,
  );
  return actual;
}

async function authStorePermissionEvidence(authPath) {
  if (process.platform === 'win32') {
    return {
      model: 'windows-acl',
      verified: false,
      reason: 'This offline probe does not claim POSIX 0600 semantics on Windows.',
    };
  }
  const mode = (await stat(authPath)).mode & 0o777;
  assert(mode === 0o600, `auth-profiles.json mode was ${mode.toString(8)}, expected 600`);
  return { model: 'posix-mode', verified: true, mode: '0600' };
}

function createSignalBridge() {
  const controller = new AbortController();
  let receivedSignal;
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (receivedSignal) return;
      receivedSignal = signal;
      controller.abort();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    signal: controller.signal,
    get receivedSignal() { return receivedSignal; },
    throwIfInterrupted() {
      if (receivedSignal) throw new ProbeInterruptedError(receivedSignal);
    },
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
    },
  };
}

function resolveCliTimeoutMs() {
  const raw = process.env.RC_CREDENTIAL_PROBE_CLI_TIMEOUT_MS;
  if (raw === undefined) return 15_000;
  const parsed = Number(raw);
  assert(Number.isInteger(parsed) && parsed >= 100 && parsed <= 60_000,
    'RC_CREDENTIAL_PROBE_CLI_TIMEOUT_MS must be an integer from 100 to 60000');
  return parsed;
}

function runCli(args, env, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let killTimer;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => terminate();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) terminate();
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
    };
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve({
        code: timedOut ? 124 : code ?? (signal ? 1 : 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function providerConfig(baseUrl, apiKey) {
  return {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    api: 'openai-completions',
    models: [{
      id: MODEL,
      name: 'RC credential contract fixture',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64_000,
      maxTokens: 64,
    }],
  };
}

function configFor({ workspace, baseUrl, apiKey, withProfile }) {
  return {
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: `${PROVIDER}/${MODEL}` },
      },
    },
    models: {
      mode: 'merge',
      providers: { [PROVIDER]: providerConfig(baseUrl, apiKey) },
    },
    ...(withProfile ? {
      auth: {
        profiles: { [PROFILE_ID]: { provider: PROVIDER, mode: 'api_key' } },
        order: { [PROVIDER]: [PROFILE_ID] },
      },
    } : {}),
    skills: { allowBundled: ['fixture-no-bundled-skills'] },
  };
}

function sendCompletion(response) {
  const common = {
    id: 'chatcmpl-rc-credential-probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
  };
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  response.write(`data: ${JSON.stringify({
    ...common,
    choices: [{ index: 0, delta: { role: 'assistant', content: REPLY }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    ...common,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function main() {
  const signalBridge = createSignalBridge();
  const cliTimeoutMs = resolveCliTimeoutMs();
  let tempRoot;
  let server;
  let failProvider = false;
  const requests = [];
  try {
    const openclawVersion = await assertOpenClawVersion();
    signalBridge.throwIfInterrupted();
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-credential-contract-'));
    if (process.env.NODE_ENV === 'test' &&
        process.env.RC_CREDENTIAL_PROBE_FAULT === 'after-temp-root') {
      throw new Error('injected failure after temporary root creation');
    }
    const home = path.join(tempRoot, 'home');
    const state = path.join(tempRoot, 'state');
    const workspace = path.join(tempRoot, 'workspace');
    const configPath = path.join(state, 'openclaw.json');
    const agentDir = path.join(state, 'agents', 'main', 'agent');
    const authPath = path.join(agentDir, 'auth-profiles.json');
    // Create the shared state parent before its recursive child. Running both
    // mkdir calls concurrently lets the child win the race and makes the plain
    // parent mkdir fail with EEXIST on otherwise healthy hosts.
    await Promise.all([mkdir(home), mkdir(state), mkdir(workspace)]);
    await mkdir(agentDir, { recursive: true });
    signalBridge.throwIfInterrupted();

    server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push({
          authorization: request.headers.authorization ?? null,
          retryCount: /^[0-9]+$/.test(String(request.headers['x-stainless-retry-count'] ?? ''))
            ? Number(request.headers['x-stainless-retry-count']) : null,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        if (failProvider) {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'injected credential probe outage' } }));
          return;
        }
        sendCompletion(response);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    signalBridge.throwIfInterrupted();
    const address = server.address();
    assert(address && typeof address === 'object', 'fixture provider did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_AGENT_DIR: agentDir,
      OPENCLAW_AUTH_STORE_READONLY: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    };

    const scenarios = [
      { name: 'config-only', apiKey: CONFIG_KEY, withProfile: false, profile: false, expected: CONFIG_KEY },
      { name: 'profile-only', apiKey: undefined, withProfile: true, profile: true, expected: PROFILE_KEY },
      { name: 'conflict', apiKey: CONFIG_KEY, withProfile: true, profile: true, expected: PROFILE_KEY },
    ];
    const results = [];
    for (const scenario of scenarios) {
      requests.length = 0;
      await writeFile(configPath, `${JSON.stringify(configFor({
        workspace,
        baseUrl,
        apiKey: scenario.apiKey,
        withProfile: scenario.withProfile,
      }), null, 2)}\n`, { mode: 0o600 });
      await writeFile(authPath, `${JSON.stringify({
        version: 1,
        profiles: scenario.profile ? {
          [PROFILE_ID]: { type: 'api_key', provider: PROVIDER, key: PROFILE_KEY },
        } : {},
      }, null, 2)}\n`, { mode: 0o600 });

      const status = await runCli([
        'models', 'status', '--json', '--probe', '--probe-provider', PROVIDER,
        '--probe-timeout', '5000', '--probe-max-tokens', '4',
      ], env, { signal: signalBridge.signal, timeoutMs: cliTimeoutMs });
      signalBridge.throwIfInterrupted();
      assert(status.code === 0, `${scenario.name}: models status --probe failed: ${status.stderr}`);
      const parsedStatus = JSON.parse(status.stdout);
      const statusProbe = parsedStatus.auth?.probes?.results?.[0];
      assert(statusProbe?.status === 'ok', `${scenario.name}: models status probe was not ok`);
      assert(requests.length > 0, `${scenario.name}: models status probe made no provider request`);
      const statusAuthorization = requests.at(-1)?.authorization;
      assert(statusAuthorization === `Bearer ${scenario.expected}`,
        `${scenario.name}: status used unexpected credential source`);

      results.push({
        scenario: scenario.name,
        status: statusProbe.status,
        statusSource: statusProbe.source,
        statusProfileId: statusProbe.profileId ?? null,
        statusCredential: statusAuthorization === `Bearer ${PROFILE_KEY}` ? 'auth-profile' : 'provider-config',
      });
    }

    // One real embedded agent turn proves the agent execution path uses the
    // same winning profile observed in the conflict status probe. Repeating a
    // cold OpenClaw agent process for all three precedence rows only adds
    // latency; credential resolution itself is fully covered above.
    requests.length = 0;
    const agent = await runCli([
      'agent', '--local', '--json', '--session-id', 'credential-conflict-agent',
      '--message', 'Return the deterministic fixture response.', '--timeout', '5',
    ], env, { signal: signalBridge.signal, timeoutMs: cliTimeoutMs });
    signalBridge.throwIfInterrupted();
    assert(agent.code === 0, `conflict: agent request failed: ${agent.stderr || agent.stdout}`);
    assert(requests.length > 0, 'conflict: agent made no provider request');
    const agentAuthorization = requests.at(-1)?.authorization;
    assert(agentAuthorization === `Bearer ${PROFILE_KEY}`, 'conflict: agent did not use auth profile');
    assert(agent.stdout.includes(REPLY), 'conflict: agent response did not contain fixture reply');
    results.find(result => result.scenario === 'conflict').agentCredential = 'auth-profile';

    // Run the outage probe last because it intentionally marks the provider
    // unavailable for later agent turns in the isolated state root. OpenClaw's
    // current provider client performs the initial request plus two bounded
    // retries; all three must retain the same locked credential.
    requests.length = 0;
    await writeFile(configPath, `${JSON.stringify(configFor({
      workspace,
      baseUrl,
      apiKey: PROFILE_ID,
      withProfile: true,
    }), null, 2)}\n`, { mode: 0o600 });
    failProvider = true;
    const failureStatus = await runCli([
      'models', 'status', '--json', '--probe', '--probe-provider', PROVIDER,
      '--probe-profile', PROFILE_ID,
      '--probe-timeout', '5000', '--probe-max-tokens', '4',
    ], env, { signal: signalBridge.signal, timeoutMs: cliTimeoutMs });
    failProvider = false;
    signalBridge.throwIfInterrupted();
    assert(failureStatus.code === 0, `failure-path: models status failed: ${failureStatus.stderr}`);
    const parsedFailureStatus = JSON.parse(failureStatus.stdout);
    const failureProbe = parsedFailureStatus.auth?.probes?.results?.[0];
    assert(failureProbe?.status && failureProbe.status !== 'ok', 'failure-path: provider outage unexpectedly passed');
    const failureCredentialLabels = requests.map((request) =>
      request.authorization === `Bearer ${PROFILE_KEY}` ? 'auth-profile'
        : request.authorization === `Bearer ${CONFIG_KEY}` ? 'provider-config' : 'other');
    const failureRetryCounts = requests.map(request => request.retryCount);
    assert(requests.length === 3 && JSON.stringify(failureRetryCounts) === '[0,1,2]',
      `failure-path: expected retry sequence 0,1,2, observed ${JSON.stringify(failureRetryCounts)} (${failureCredentialLabels.join(',')})`);
    assert(requests.every(request => request.authorization === `Bearer ${PROFILE_KEY}`),
      'failure-path: a provider retry did not retain the resolved auth-profile credential');
    const failureResult = {
      status: failureProbe.status,
      requestCount: requests.length,
      retryCounts: failureRetryCounts,
      credential: 'auth-profile',
    };

    const permissions = await authStorePermissionEvidence(authPath);
    process.stdout.write(`${JSON.stringify({
      schema: 'research-claw.credential-contract-probe.v1',
      openclawVersion,
      isolatedRoot: '<mktemp>',
      providerRequests: results.length + requests.length,
      authStore: {
        relativePath: 'agents/main/agent/auth-profiles.json',
        permissions,
        schema: { version: 1, credentialType: 'api_key', keyField: 'key' },
      },
      precedence: 'eligible auth profile before literal provider config apiKey',
      failureProbe: failureResult,
      results,
    }, null, 2)}\n`);
  } finally {
    if (server) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    const receivedSignal = signalBridge.receivedSignal;
    signalBridge.dispose();
    if (receivedSignal) throw new ProbeInterruptedError(receivedSignal);
  }
}

main().catch(error => {
  if (error instanceof ProbeInterruptedError) {
    process.stderr.write(`${error.message}; temporary state cleaned\n`);
    process.exitCode = SIGNAL_EXIT_CODES[error.signal] ?? 1;
    return;
  }
  process.stderr.write(`credential contract probe failed: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
