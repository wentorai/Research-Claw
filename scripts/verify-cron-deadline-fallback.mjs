#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const entryPath = path.join(projectRoot, 'node_modules', 'openclaw', 'dist', 'entry.js');
const gatewayPort = Number(process.env.RC_TEST_GATEWAY_PORT ?? 28799);
const providerPort = Number(process.env.RC_TEST_PROVIDER_PORT ?? 28801);
const gatewayToken = 'rc-cron-fallback-test';
// The cron job carries this in its own payload; it is what makes the deadline
// fire and the fallback engage.
const timeoutSeconds = 2;
/**
 * Deliberately far above the cron budget. This script's second half asserts that
 * a *user* abort does not trigger the fallback, which requires the interactive
 * run to still be alive when the abort lands. Sharing the cron's 2s deadline
 * made that a race against the deadline abort: on a loaded machine the run was
 * already gone, and the script reported a broken abort path that was really just
 * its own configuration killing the subject under test.
 */
const agentDefaultTimeoutSeconds = 300;

let tempRoot;
let gateway;
let provider;
let jobId;
let primaryRequests = 0;
let fallbackRequests = 0;

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

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
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

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendFallbackCompletion(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-fallback',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fallback',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'fallback completed' }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-fallback',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fallback',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function startProvider() {
  provider = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: [
          { id: 'primary', object: 'model', owned_by: 'test' },
          { id: 'fallback', object: 'model', owned_by: 'test' },
        ],
      });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      sendJson(response, 404, { error: { message: 'not found' } });
      return;
    }
    const body = await readRequestJson(request);
    if (body.model === 'primary') {
      primaryRequests += 1;
      // Deliberately outlive the cron wall-clock timeout. The client abort closes
      // this response; the fallback model must then receive a fresh attempt.
      request.once('close', () => response.destroy());
      return;
    }
    if (body.model === 'fallback') {
      fallbackRequests += 1;
      sendFallbackCompletion(response);
      return;
    }
    sendJson(response, 400, { error: { message: `unexpected model ${body.model}` } });
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(providerPort, '127.0.0.1', resolve);
  });
}

/**
 * Every call pays a full OpenClaw CLI cold start, which is the dominant and most
 * variable cost here — a busy CI runner can spend most of a 10s budget just
 * booting. The polling loops below bound total wall-clock, so this per-call
 * budget only needs to be generous enough that a slow boot is not mistaken for a
 * broken gateway.
 *
 * Every poll deadline in this file is derived from it rather than written as a
 * literal, because the two numbers only mean anything relative to each other: a
 * deadline at or below one call's budget cannot survive a single slow call, so
 * the retry it appears to implement never actually happens.
 */
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
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
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
  await Promise.all([
    mkdir(path.join(tempRoot, 'home'), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(path.join(tempRoot, 'logs'), { recursive: true }),
  ]);
  const model = id => ({
    id,
    name: `Cron fallback test ${id}`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 128,
  });
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
          model: { primary: 'test/primary', fallbacks: ['test/fallback'] },
          timeoutSeconds: agentDefaultTimeoutSeconds,
        },
      },
      models: {
        mode: 'merge',
        providers: {
          test: {
            baseUrl: `http://127.0.0.1:${providerPort}/v1`,
            apiKey: 'isolated-test-only',
            api: 'openai-completions',
            timeoutSeconds: 30,
            models: [model('primary'), model('fallback')],
          },
        },
      },
      logging: { file: path.join(tempRoot, 'logs', 'openclaw.log') },
      plugins: { allow: [] },
    }, null, 2),
  );
}

async function startGateway() {
  const output = createWriteStream(path.join(tempRoot, 'logs', 'gateway-console.log'), { flags: 'a' });
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

async function waitForCronResult() {
  // Tolerate a transient call failure the way waitForHealth does. A single slow
  // CLI boot used to abort the whole verification, so the script reported a
  // fallback regression that had not happened — the exact false signal this
  // acceptance lane exists to catch. Only the deadline may fail the run.
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const runs = await gatewayCall('cron.runs', { id: jobId, limit: 5 });
      const entries = runs.entries ?? runs.runs ?? [];
      if (entries.length > 0 && entries[0].status !== 'running') return entries[0];
    } catch (error) {
      lastError = error;
      if (gateway?.exitCode !== null) {
        throw new Error(`gateway exited while polling cron runs with code ${gateway.exitCode}`);
      }
    }
    await sleep(200);
  }
  throw new Error(
    `cron result polling timed out${lastError ? `; last error: ${lastError.message}` : ''}`,
  );
}

async function waitForPrimaryRequest(expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (primaryRequests >= expected) return;
    await sleep(50);
  }
  throw new Error(
    `primary model was not called ${expected} times (observed ${primaryRequests})`,
  );
}

/**
 * Reaching the provider means the run exists, but the gateway registers it as
 * abortable a moment later. Retrying the precondition keeps the real assertion —
 * that a user abort must not trigger the fallback model — from being reported as
 * a fallback regression when it is only a registration race.
 *
 * A thrown call is retried rather than fatal, for the same reason the other polls
 * here tolerate one: a slow CLI cold start is not a broken abort path. The caller
 * owns the assertion, so the last failure rides back on the result instead of
 * being raised here — that keeps the send/abort context in one message.
 */
async function abortWithRetry(sessionKey, runId) {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await gatewayCall('chat.abort', {
        sessionKey,
        ...(runId ? { runId } : {}),
      });
      if (last.aborted === true) return last;
    } catch (error) {
      lastError = error;
      if (gateway?.exitCode !== null) {
        throw new Error(`gateway exited while aborting with code ${gateway.exitCode}`);
      }
    }
    await sleep(200);
  }
  return {
    ...(last ?? { aborted: false }),
    ...(lastError ? { lastError: lastError.message } : {}),
  };
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
  if (jobId && gateway?.exitCode === null) {
    await gatewayCall('cron.remove', { id: jobId }).catch(() => {});
  }
  await stopChild(gateway);
  if (provider) await new Promise(resolve => provider.close(resolve));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

async function main() {
  await Promise.all([assertPortFree(gatewayPort), assertPortFree(providerPort)]);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-cron-fallback-'));
  await writeConfig();
  await startProvider();
  await startGateway();

  const added = await gatewayCall('cron.add', {
    name: 'cron deadline fallback acceptance',
    schedule: { kind: 'cron', expr: '0 0 1 1 *' },
    sessionTarget: 'isolated',
    sessionKey: 'cron:rc-test:deadline-fallback',
    payload: {
      kind: 'agentTurn',
      message: 'Reply with a short success message.',
      timeoutSeconds,
    },
    delivery: { mode: 'none' },
  });
  jobId = added.id ?? added.job?.id;
  if (!jobId) throw new Error(`cron.add returned no id: ${JSON.stringify(added)}`);
  await gatewayCall('cron.run', { id: jobId, mode: 'force' });
  const result = await waitForCronResult();

  if (result.status !== 'ok') {
    const log = await readFile(path.join(tempRoot, 'logs', 'openclaw.log'), 'utf8').catch(() => '');
    const consoleLog = await readFile(path.join(tempRoot, 'logs', 'gateway-console.log'), 'utf8').catch(() => '');
    throw new Error(
      `expected cron status ok (primary=${primaryRequests} fallback=${fallbackRequests}), `
      + `got ${JSON.stringify(result)}\n${consoleLog.slice(-4_000)}\n${log.slice(-8_000)}`,
    );
  }
  if (primaryRequests < 1 || fallbackRequests < 1) {
    throw new Error(`expected both models to run, primary=${primaryRequests} fallback=${fallbackRequests}`);
  }
  if (result.provider !== 'test' || result.model !== 'fallback') {
    throw new Error(`expected test/fallback telemetry, got ${result.provider}/${result.model}`);
  }
  const fallbackCountAfterCron = fallbackRequests;
  const primaryCountAfterCron = primaryRequests;
  const userSessionKey = `rc-test-user-abort-${Date.now()}`;
  const chatSendResult = await gatewayCall('chat.send', {
    message: 'This request will be cancelled by the user.',
    sessionKey: userSessionKey,
    idempotencyKey: randomUUID(),
  });
  // Relative, not absolute: the cron phase already drove primaryRequests past
  // any fixed threshold, so waiting for an absolute count returned immediately
  // and we aborted a run the gateway had not registered yet. Waiting for THIS
  // run to reach the stub provider is what makes it abortable.
  await waitForPrimaryRequest(primaryCountAfterCron + 1);
  const chatAbortResult = await abortWithRetry(userSessionKey, chatSendResult.runId);
  if (chatAbortResult.aborted !== true) {
    throw new Error(
      `chat.abort did not reach the active run: send=${JSON.stringify(chatSendResult)} `
      + `abort=${JSON.stringify(chatAbortResult)}`,
    );
  }
  await sleep(1_000);
  if (fallbackRequests !== fallbackCountAfterCron) {
    const log = await readFile(path.join(tempRoot, 'logs', 'openclaw.log'), 'utf8').catch(() => '');
    throw new Error(
      `user-initiated chat.abort incorrectly triggered the fallback model\n${log.slice(-8_000)}`,
    );
  }
  console.log(JSON.stringify({
    status: result.status,
    provider: result.provider,
    model: result.model,
    primaryRequests,
    fallbackRequests,
    userAbortFallbackRequests: fallbackRequests - fallbackCountAfterCron,
    durationMs: result.durationMs,
  }, null, 2));
}

try {
  await main();
} finally {
  await cleanup();
}
