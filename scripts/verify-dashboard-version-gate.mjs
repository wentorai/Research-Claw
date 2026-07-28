#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const expectedVersion = String(packageJson.version);
const entryPath = path.join(projectRoot, 'node_modules', 'openclaw', 'dist', 'entry.js');
const requireFromOpenClaw = createRequire(realpathSync(entryPath));
const WebSocket = requireFromOpenClaw('ws');
const gatewayPort = Number(process.env.RC_TEST_GATEWAY_PORT ?? 28807);
const gatewayToken = 'rc-dashboard-version-gate';
const origin = 'http://127.0.0.1:5175';

let tempRoot;
let gateway;

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

async function prepareConfig() {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-dashboard-version-'));
  const homeDir = path.join(tempRoot, 'home');
  const stateDir = path.join(tempRoot, 'state');
  const workspaceDir = path.join(tempRoot, 'workspace');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(
    path.join(stateDir, 'openclaw.json'),
    `${JSON.stringify({
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
        },
      },
      plugins: { enabled: false },
    }, null, 2)}\n`,
  );
}

function gatewayEnv() {
  return {
    ...process.env,
    HOME: path.join(tempRoot, 'home'),
    OPENCLAW_STATE_DIR: path.join(tempRoot, 'state'),
    OPENCLAW_CONFIG_PATH: path.join(tempRoot, 'state', 'openclaw.json'),
    RESEARCH_CLAW_UI_VERSION: expectedVersion,
  };
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
      env: gatewayEnv(),
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  await waitForHealth();
}

async function connectControlUi(version) {
  const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}`, {
    headers: { Origin: origin },
  });
  const frames = [];
  const waiters = [];
  socket.on('message', data => {
    let frame;
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    const index = waiters.findIndex(waiter => waiter.predicate(frame));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      frames.push(frame);
    }
  });

  function waitForFrame(predicate, timeoutMs = 10_000) {
    const queuedIndex = frames.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(frames.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('gateway response timed out'));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  }

  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await waitForFrame(frame =>
      frame.type === 'event' && frame.event === 'connect.challenge');
    const id = `connect-${version}`;
    socket.send(JSON.stringify({
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: 'openclaw-control-ui',
          version,
          platform: 'node',
          mode: 'webchat',
          displayName: 'Research-Claw Dashboard version verifier',
        },
        caps: [],
        role: 'operator',
        scopes: ['operator.admin'],
        auth: { token: gatewayToken },
      },
    }));
    return await waitForFrame(frame => frame.type === 'res' && frame.id === id);
  } finally {
    socket.close();
  }
}

async function stopGateway() {
  if (!gateway || gateway.exitCode !== null) return;
  gateway.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => gateway.once('exit', resolve)),
    sleep(3_000),
  ]);
  if (gateway.exitCode === null) gateway.kill('SIGKILL');
}

async function main() {
  await assertPortFree(gatewayPort);
  await prepareConfig();
  await startGateway();

  const stale = await connectControlUi(`${expectedVersion}-stale`);
  if (stale.ok !== false) {
    throw new Error(`stale Dashboard unexpectedly connected: ${JSON.stringify(stale)}`);
  }
  if (
    stale.error?.code !== 'FORBIDDEN'
    || stale.error?.details?.code !== 'RESEARCH_CLAW_UI_VERSION_MISMATCH'
    || !String(stale.error?.message ?? '').includes('Refresh this page')
  ) {
    throw new Error(`stale Dashboard received the wrong error: ${JSON.stringify(stale.error)}`);
  }

  const current = await connectControlUi(expectedVersion);
  if (current.ok !== true) {
    throw new Error(`current Dashboard could not connect: ${JSON.stringify(current.error)}`);
  }

  process.stdout.write(
    `dashboard version gate verified: stale ${expectedVersion}-stale rejected; ${expectedVersion} connected\n`,
  );
}

try {
  await main();
} finally {
  await stopGateway();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
