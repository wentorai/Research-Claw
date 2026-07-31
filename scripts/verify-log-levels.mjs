#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-log-levels-'));
const levels = ['debug', 'info', 'warn', 'error'];
const productLogging = JSON.parse(
  readFileSync(path.join(root, 'config', 'openclaw.example.json'), 'utf8'),
).logging;
const secretSentinels = [
  ['api-key', 'RC_FAKE_API_KEY_4d238'],
  ['cookie', 'RC_FAKE_COOKIE_63f02'],
  ['webhook', 'RC_FAKE_WEBHOOK_f88b1'],
  ['proxy-userinfo', 'RC_FAKE_PROXY_PASSWORD_07ac3'],
  ['pem', 'RC_FAKE_PEM_BODY_9bb1e'],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function childSource(includeSecrets = false) {
  const secretLines = includeSecrets
    ? `
logger.trace("apiKey=RC_FAKE_API_KEY_4d238");
logger.debug("Cookie: session=RC_FAKE_COOKIE_63f02");
logger.info("https://hooks.example.invalid/RC_FAKE_WEBHOOK_f88b1");
logger.warn("https://user:RC_FAKE_PROXY_PASSWORD_07ac3@proxy.invalid:8443");
logger.error("-----BEGIN PRIVATE KEY----- RC_FAKE_PEM_BODY_9bb1e -----END PRIVATE KEY-----"); // pragma: allowlist secret
`
    : '';
  return `
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
const logger = createSubsystemLogger("rc-level-probe");
logger.debug("RC_PROBE_DEBUG");
logger.info("RC_PROBE_INFO");
logger.warn("RC_PROBE_WARN");
logger.error("RC_PROBE_ERROR");
${secretLines}
await new Promise(resolve => setTimeout(resolve, 150));
`;
}

function runProbe({
  name,
  consoleLevel,
  fileLevel = 'trace',
  envLevel,
  includeSecrets = false,
}) {
  const probeRoot = path.join(tempRoot, name);
  const configPath = path.join(probeRoot, 'openclaw.json');
  const logPath = path.join(probeRoot, 'gateway.log');
  mkdirSync(path.join(probeRoot, 'home'), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    logging: {
      ...productLogging,
      level: fileLevel,
      consoleLevel,
      file: logPath,
      style: 'json',
    },
  }));
  const env = {
    ...process.env,
    HOME: path.join(probeRoot, 'home'),
    OPENCLAW_CONFIG_PATH: configPath,
  };
  if (envLevel) env.OPENCLAW_LOG_LEVEL = envLevel;
  else delete env.OPENCLAW_LOG_LEVEL;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', childSource(includeSecrets)],
    { cwd: root, encoding: 'utf8', env },
  );
  assert(child.status === 0, `probe ${name} exited ${child.status}: ${child.stderr}`);
  const terminal = `${child.stdout}${child.stderr}`;
  const file = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  return {
    terminal,
    file,
    terminalLevels: levels.filter(level =>
      terminal.includes(`RC_PROBE_${level.toUpperCase()}`)),
    fileLevels: levels.filter(level =>
      file.includes(`RC_PROBE_${level.toUpperCase()}`)),
  };
}

try {
  const expectedConsole = {
    debug: ['debug', 'info', 'warn', 'error'],
    info: ['info', 'warn', 'error'],
    warn: ['warn', 'error'],
    error: ['error'],
  };
  const matrix = [];
  for (const consoleLevel of levels) {
    const probe = runProbe({ name: consoleLevel, consoleLevel });
    assert(
      JSON.stringify(probe.terminalLevels)
        === JSON.stringify(expectedConsole[consoleLevel]),
      `${consoleLevel} console filter mismatch: ${probe.terminalLevels}`,
    );
    assert(
      JSON.stringify(probe.fileLevels) === JSON.stringify(levels),
      `${consoleLevel} unexpectedly changed trace file logging`,
    );
    matrix.push({
      consoleLevel,
      terminal: probe.terminalLevels,
      file: probe.fileLevels,
    });
  }

  const overridden = runProbe({
    name: 'env-error',
    consoleLevel: 'debug',
    envLevel: 'error',
  });
  assert(
    JSON.stringify(overridden.terminalLevels) === JSON.stringify(['error'])
      && JSON.stringify(overridden.fileLevels) === JSON.stringify(['error']),
    'OPENCLAW_LOG_LEVEL did not override both console and file',
  );

  const secrets = runProbe({
    name: 'trace-secrets',
    consoleLevel: 'trace',
    fileLevel: 'trace',
    includeSecrets: true,
  });
  const secretLeak = secretSentinels
    .filter(([, secret]) =>
      secrets.terminal.includes(secret) || secrets.file.includes(secret))
    .map(([kind]) => kind);
  assert(
    secretLeak.length === 0,
    `debug/trace logger leaked sentinel classes: ${secretLeak.join(', ')}`,
  );

  console.log(JSON.stringify({
    ok: true,
    runtime: JSON.parse(
      readFileSync(path.join(root, 'node_modules/openclaw/package.json'), 'utf8'),
    ).version,
    matrix,
    envOverride: {
      terminal: overridden.terminalLevels,
      file: overridden.fileLevels,
    },
    secretSentinelsLeaked: secretLeak.length,
  }, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
