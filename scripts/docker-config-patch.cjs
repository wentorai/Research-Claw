#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const DOCKER_LOG_FILE = '/app/.research-claw/logs/openclaw.log';
const DOCKER_DB_PATH = '/app/.research-claw/library.db';
const DOCKER_SUPERVISOR_DB_PATH = '/app/.research-claw/supervisor.db';
const LEVELS_QUIETER_THAN_INFO = new Set(['silent', 'fatal', 'error', 'warn']);

function ensureObject(parent, key) {
  const current = parent[key];
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    parent[key] = {};
    return true;
  }
  return false;
}

/**
 * Apply Docker-only settings in place.
 *
 * File logs are raised to info only when missing or quieter than info.
 * Explicit debug/trace settings are preserved so operators can opt into more
 * detail. consoleLevel remains info because stdout is Docker's primary
 * diagnostic channel.
 */
function patchDockerConfig(config, env = process.env) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Docker config root must be an object');
  }
  let changed = false;

  if (ensureObject(config, 'logging')) changed = true;
  const consoleLevel = config.logging.consoleLevel;
  if (!['info', 'debug', 'trace'].includes(consoleLevel)) {
    config.logging.consoleLevel = 'info';
    changed = true;
  }
  const level = config.logging.level;
  if (
    typeof level !== 'string' ||
    level.length === 0 ||
    LEVELS_QUIETER_THAN_INFO.has(level)
  ) {
    if (level !== 'info') {
      config.logging.level = 'info';
      changed = true;
    }
  }
  if (config.logging.file !== DOCKER_LOG_FILE) {
    config.logging.file = DOCKER_LOG_FILE;
    changed = true;
  }

  if (ensureObject(config, 'gateway')) changed = true;
  if (config.gateway.bind !== 'lan') {
    config.gateway.bind = 'lan';
    changed = true;
  }
  if (ensureObject(config.gateway, 'controlUi')) changed = true;
  if (!config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback) {
    config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
    changed = true;
  }
  if (!config.gateway.controlUi.dangerouslyDisableDeviceAuth) {
    config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
    changed = true;
  }

  if (ensureObject(config.gateway, 'auth')) changed = true;
  if (!config.gateway.auth.token) {
    config.gateway.auth.token = env.OPENCLAW_GATEWAY_TOKEN || 'research-claw';
    changed = true;
  }
  if (config.gateway.auth.mode && config.gateway.auth.mode !== 'token') {
    config.gateway.auth.mode = 'token';
    changed = true;
  }

  const rcEntry = config.plugins?.entries?.['research-claw-core'];
  if (rcEntry) {
    if (ensureObject(rcEntry, 'config')) changed = true;
    if (rcEntry.config.dbPath !== DOCKER_DB_PATH) {
      rcEntry.config.dbPath = DOCKER_DB_PATH;
      changed = true;
    }
  }
  const supervisorEntry = config.plugins?.entries?.['dual-model-supervisor'];
  if (supervisorEntry) {
    if (ensureObject(supervisorEntry, 'config')) changed = true;
    if (supervisorEntry.config.dbPath !== DOCKER_SUPERVISOR_DB_PATH) {
      supervisorEntry.config.dbPath = DOCKER_SUPERVISOR_DB_PATH;
      changed = true;
    }
  }

  return changed;
}

function patchDockerConfigFile(filePath, env = process.env) {
  const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const changed = patchDockerConfig(config, env);
  if (changed) {
    const output = `${JSON.stringify(config, null, 2)}\n`;
    const temporaryPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(temporaryPath, output);
    fs.renameSync(temporaryPath, filePath);
  }
  return changed;
}

module.exports = {
  DOCKER_DB_PATH,
  DOCKER_LOG_FILE,
  DOCKER_SUPERVISOR_DB_PATH,
  patchDockerConfig,
  patchDockerConfigFile,
};

if (require.main === module) {
  const [configPath] = process.argv.slice(2);
  if (!configPath) {
    console.error('Usage: node scripts/docker-config-patch.cjs <config-path>');
    process.exit(2);
  }
  try {
    patchDockerConfigFile(configPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
