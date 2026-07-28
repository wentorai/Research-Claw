#!/usr/bin/env node

import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = process.env.RC_TEST_DOCKER_IMAGE
  ?? 'ghcr.io/wentorai/research-claw:0.8.0';
const hostPort = Number(process.env.RC_TEST_GATEWAY_PORT ?? 28799);
const gatewayToken = 'rc-docker-config-fixture';
const containerPrefix = `rc-observability-docker-${process.pid}`;
const keepArtifacts = process.env.RC_KEEP_TEST_ARTIFACTS === '1';

let tempRoot;
const containers = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function docker(args, options = {}) {
  return execFileAsync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

async function containerExists(name) {
  try {
    await docker(['inspect', name]);
    return true;
  } catch {
    return false;
  }
}

async function removeContainer(name) {
  if (await containerExists(name)) {
    await docker(['rm', '-f', name]).catch(() => {});
  }
  containers.delete(name);
}

function volumeMount(source, target, readOnly = false) {
  return `type=bind,src=${source},dst=${target}${readOnly ? ',readonly' : ''}`;
}

function dockerRunArgs(name) {
  const args = [
    'run',
    '-d',
    '--name',
    name,
    '--entrypoint',
    '/bin/sh',
    '-p',
    `127.0.0.1:${hostPort}:28789`,
    '-e',
    `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
    '--mount',
    volumeMount(path.join(tempRoot, 'config'), '/app/config'),
    '--mount',
    volumeMount(path.join(tempRoot, 'data'), '/app/.research-claw'),
    '--mount',
    volumeMount(path.join(tempRoot, 'workspace'), '/app/workspace'),
    '--mount',
    volumeMount(path.join(tempRoot, 'state'), '/root/.openclaw'),
    '--mount',
    volumeMount(
      path.join(projectRoot, 'scripts', 'docker-entrypoint.sh'),
      '/entrypoint.sh',
      true,
    ),
    '--mount',
    volumeMount(
      path.join(projectRoot, 'scripts', 'docker-config-patch.cjs'),
      '/app/scripts/docker-config-patch.cjs',
      true,
    ),
    image,
    '/entrypoint.sh',
  ];
  return args;
}

async function startContainer(name) {
  await docker(dockerRunArgs(name));
  containers.add(name);
}

async function stopContainer(name) {
  if (!(await containerExists(name))) return;
  await docker(['stop', '-t', '10', name]).catch(() => {});
  await removeContainer(name);
}

async function containerLogs(name) {
  try {
    const result = await docker(['logs', name]);
    return result.stdout + result.stderr;
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

async function waitForHealth(name, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/healthz`);
      if (response.ok) return await response.text();
      lastError = new Error(`healthz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `container ${name} did not become healthy: ${lastError?.message ?? 'timeout'}\n`
      + await containerLogs(name),
  );
}

async function waitForLog(name, pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let logs = '';
  while (Date.now() < deadline) {
    logs = await containerLogs(name);
    if (pattern.test(logs)) return logs;
    await sleep(500);
  }
  throw new Error(`container ${name} never logged ${pattern}\n${logs}`);
}

async function seedDebugConfig() {
  const template = JSON.parse(
    await readFile(path.join(projectRoot, 'config', 'openclaw.example.json'), 'utf8'),
  );
  template.logging = {
    ...template.logging,
    level: 'debug',
    consoleLevel: 'error',
    file: '/user/custom/openclaw.log',
  };
  template.channels = {};
  template.gateway.auth = { mode: 'token', token: gatewayToken };
  template.gateway.controlUi.allowedOrigins = [
    `http://127.0.0.1:${hostPort}`,
    `http://localhost:${hostPort}`,
  ];
  await writeFile(
    path.join(tempRoot, 'config', 'openclaw.json'),
    `${JSON.stringify(template, null, 2)}\n`,
  );
}

async function assertHealthyContainer(name) {
  const health = await waitForHealth(name);
  const config = JSON.parse(
    await readFile(path.join(tempRoot, 'config', 'openclaw.json'), 'utf8'),
  );
  assert(config.logging.level === 'debug', 'Docker overwrote explicit debug file logging');
  assert(config.logging.consoleLevel === 'info', 'Docker console logging is not info');
  assert(
    config.logging.file === '/app/.research-claw/logs/openclaw.log',
    'Docker file log is not on the persistent data volume',
  );
  assert(
    config.plugins.entries['research-claw-core'].config.dbPath
      === '/app/.research-claw/library.db',
    'research-claw-core dbPath is not on the data volume',
  );
  assert(
    config.plugins.entries['dual-model-supervisor'].config.dbPath
      === '/app/.research-claw/supervisor.db',
    'dual-model-supervisor dbPath is not on the data volume',
  );

  const [configFiles, dataFiles, workspaceFiles, stateFiles] = await Promise.all([
    readdir(path.join(tempRoot, 'config')),
    readdir(path.join(tempRoot, 'data')),
    readdir(path.join(tempRoot, 'workspace')),
    readdir(path.join(tempRoot, 'state')),
  ]);
  assert(configFiles.includes('.config-version'), 'config volume was not initialized');
  assert(dataFiles.includes('library.db'), 'data volume did not receive library.db');
  assert(workspaceFiles.includes('.ResearchClaw'), 'workspace volume was not initialized');
  assert(stateFiles.includes('extensions'), 'state volume did not receive plugins');

  const logs = await containerLogs(name);
  const firstGatewayLine = logs
    .split(/\r?\n/)
    .findIndex(line => /^\d{4}-\d{2}-\d{2}T/.test(line));
  const entrypointLines = logs
    .split(/\r?\n/)
    .slice(0, firstGatewayLine === -1 ? undefined : firstGatewayLine)
    .filter(line => line.trim().length > 0);
  assert(
    entrypointLines.length <= 15,
    `entrypoint emitted ${entrypointLines.length} regular lines before gateway output`,
  );
  assert(!logs.includes(`Gateway token: ${gatewayToken}`), 'verbose token line leaked by default');

  return {
    health: health.trim(),
    entrypointLines: entrypointLines.length,
    volumeFiles: {
      config: configFiles.length,
      data: dataFiles.length,
      workspace: workspaceFiles.length,
      state: stateFiles.length,
    },
  };
}

async function assertBadConfigVisible(name) {
  await writeFile(path.join(tempRoot, 'config', 'openclaw.json'), '{ broken-json\n');
  await startContainer(name);
  const logs = await waitForLog(
    name,
    /Config patch failed[\s\S]*(?:Invalid config|Unexpected|JSON|parse)/i,
  );
  const inspect = JSON.parse((await docker(['inspect', name])).stdout)[0];
  assert(inspect.State.Running, 'entrypoint stopped supervising after a bad config');
  assert(
    logs.includes('Config patch failed'),
    'bad config did not produce an entrypoint-visible failure',
  );
  return logs
    .split(/\r?\n/)
    .filter(line => /config|json|restart/i.test(line))
    .slice(-8);
}

async function main() {
  await assertPortFree(hostPort);
  await docker(['image', 'inspect', image]);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-docker-config-'));
  await Promise.all(
    ['config', 'data', 'workspace', 'state'].map(name =>
      mkdir(path.join(tempRoot, name), { recursive: true })),
  );
  await seedDebugConfig();

  const healthyName = `${containerPrefix}-healthy`;
  const badName = `${containerPrefix}-bad`;
  try {
    await startContainer(healthyName);
    const healthy = await assertHealthyContainer(healthyName);
    await stopContainer(healthyName);
    await assertPortFree(hostPort);

    const badConfigEvidence = await assertBadConfigVisible(badName);
    await stopContainer(badName);
    await assertPortFree(hostPort);

    console.log(JSON.stringify({
      ok: true,
      image,
      hostPort,
      healthy,
      badConfigEvidence,
    }, null, 2));
  } finally {
    for (const name of [...containers]) await removeContainer(name);
    if (keepArtifacts) {
      console.error(`[verify-docker-config] kept fixtures at ${tempRoot}`);
    } else if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch(async error => {
  console.error(error instanceof Error ? error.stack : String(error));
  for (const name of [...containers]) await removeContainer(name);
  if (tempRoot && !keepArtifacts) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
  process.exitCode = 1;
});
