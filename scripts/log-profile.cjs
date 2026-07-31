#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VALID_PROFILES = new Set(['user', 'developer', 'support']);
const MARKER_SCHEMA_VERSION = 1;
// Do not place this inside the legacy project-local `.research-claw/` data
// directory. migrate-rc-data-dir.cjs moves that directory to the user's HOME
// during install, which would erase the install identity before first launch.
const DEFAULT_MARKER_RELATIVE_PATH = '.research-claw-install.json';
const USER_LOGGING = Object.freeze({
  level: 'info',
  consoleLevel: 'error',
  file: '~/.research-claw/logs/openclaw.log',
});
const LEGACY_LOGGING = Object.freeze({
  ...USER_LOGGING,
  consoleLevel: 'warn',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function markerPathFor(root, markerPath) {
  return path.resolve(
    markerPath || path.join(root, DEFAULT_MARKER_RELATIVE_PATH),
  );
}

function readMarker(markerPath) {
  if (!fs.existsSync(markerPath)) {
    return { status: 'missing', marker: null };
  }
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (
      !isRecord(marker)
      || marker.schemaVersion !== MARKER_SCHEMA_VERSION
      || marker.installation !== 'managed-native'
      || !isRecord(marker.logging)
      || typeof marker.logging.managed !== 'boolean'
    ) {
      return { status: 'corrupt', marker: null };
    }
    return { status: 'valid', marker };
  } catch {
    return { status: 'corrupt', marker: null };
  }
}

function matchesLogging(logging, expected) {
  if (!isRecord(logging) || !isRecord(expected)) return false;
  return Object.entries(expected).every(([key, value]) => logging[key] === value);
}

function resolveLogProfile({
  root,
  env = process.env,
  markerPath,
}) {
  const resolvedRoot = path.resolve(root);
  const resolvedMarkerPath = markerPathFor(resolvedRoot, markerPath);
  const markerResult = readMarker(resolvedMarkerPath);
  const explicit = String(env.RC_LOG_PROFILE || '').trim();
  if (explicit && !VALID_PROFILES.has(explicit)) {
    throw new Error(
      `Invalid RC_LOG_PROFILE=${explicit}. Expected user, developer, or support.`,
    );
  }

  let profile;
  let source;
  if (explicit) {
    profile = explicit;
    source = 'explicit-environment';
  } else if (markerResult.status === 'valid') {
    profile = 'user';
    source = 'managed-native-marker';
  } else if (markerResult.status === 'corrupt') {
    // A damaged install marker is evidence of an installed copy. Fail quiet:
    // debug is never enabled merely because the metadata cannot be parsed.
    profile = 'user';
    source = 'corrupt-managed-marker';
  } else {
    profile = 'developer';
    source = 'source-checkout';
  }

  let launcherVerbose = profile !== 'user';
  let gatewayLogLevel = profile === 'user' ? null : 'debug';
  if (env.RC_VERBOSE) {
    launcherVerbose = true;
    if (profile === 'user' && !env.OPENCLAW_LOG_LEVEL) {
      gatewayLogLevel = 'info';
    }
  }
  if (env.OPENCLAW_LOG_LEVEL) {
    // OpenClaw owns validation of its supported levels. The resolver must not
    // replace an expert's one-shot override (especially debug or trace).
    gatewayLogLevel = null;
  }

  return {
    profile,
    source,
    launcherVerbose,
    gatewayLogLevel,
    markerStatus: markerResult.status,
  };
}

function atomicJsonWrite(target, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, target);
}

function markManagedNativeInstall({
  root,
  configPath,
  fresh,
  markerPath,
}) {
  const resolvedRoot = path.resolve(root);
  const resolvedConfigPath = path.resolve(configPath);
  const resolvedMarkerPath = markerPathFor(resolvedRoot, markerPath);
  const config = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
  if (!isRecord(config)) {
    throw new Error(`Config is not a JSON object: ${resolvedConfigPath}`);
  }

  const markerResult = readMarker(resolvedMarkerPath);
  const currentLogging = config.logging;
  let managed = false;

  if (fresh) {
    managed = true;
  } else if (markerResult.status === 'valid') {
    const previous = markerResult.marker;
    managed = previous.logging.managed === true
      && (
        matchesLogging(currentLogging, previous.logging.lastApplied)
        || matchesLogging(currentLogging, LEGACY_LOGGING)
      );
  } else if (markerResult.status === 'missing') {
    // Pre-marker RC releases injected this exact tuple. It is the only legacy
    // state safe enough to adopt; every other existing value is user-owned.
    managed = (
      !isRecord(currentLogging)
      || matchesLogging(currentLogging, LEGACY_LOGGING)
      || matchesLogging(currentLogging, USER_LOGGING)
    );
  } else {
    // A corrupt marker cannot prove ownership. Preserve the config.
    managed = false;
  }

  if (managed) {
    config.logging = {
      ...(isRecord(currentLogging) ? currentLogging : {}),
      ...USER_LOGGING,
    };
    atomicJsonWrite(resolvedConfigPath, config);
  }

  const marker = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    installation: 'managed-native',
    logging: {
      managed,
      lastApplied: managed ? { ...USER_LOGGING } : null,
    },
  };
  atomicJsonWrite(resolvedMarkerPath, marker);
  return marker;
}

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (index + 1 >= args.length) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}

function shellQuoteFixed(value) {
  if (!/^[a-z0-9-]*$/.test(value)) {
    throw new Error(`Unsafe internal shell value: ${value}`);
  }
  return `'${value}'`;
}

function main(argv) {
  const [command, ...args] = argv;
  const root = path.resolve(readOption(args, '--root', process.cwd()));
  const markerPath = readOption(
    args,
    '--marker',
    process.env.RC_LOG_MARKER_PATH || undefined,
  );

  if (command === 'resolve') {
    const resolution = resolveLogProfile({ root, markerPath });
    if (args.includes('--shell')) {
      const gatewayLevel = resolution.gatewayLogLevel || '';
      process.stdout.write(
        `RC_RESOLVED_LOG_PROFILE=${shellQuoteFixed(resolution.profile)}\n`
        + `RC_PROFILE_SOURCE=${shellQuoteFixed(resolution.source)}\n`
        + `RC_LAUNCHER_VERBOSE=${resolution.launcherVerbose ? "'1'" : "''"}\n`
        + `RC_PROFILE_GATEWAY_LOG_LEVEL=${shellQuoteFixed(gatewayLevel)}\n`
        + `RC_PROFILE_MARKER_STATUS=${shellQuoteFixed(resolution.markerStatus)}\n`,
      );
    } else {
      process.stdout.write(`${JSON.stringify(resolution)}\n`);
    }
    return;
  }

  if (command === 'mark-native') {
    const configPath = readOption(args, '--config');
    if (!configPath) throw new Error('mark-native requires --config <path>');
    const fresh = readOption(args, '--fresh', '0') === '1';
    const marker = markManagedNativeInstall({
      root,
      configPath,
      markerPath,
      fresh,
    });
    process.stdout.write(`${JSON.stringify(marker)}\n`);
    return;
  }

  throw new Error(
    'Usage: log-profile.cjs resolve [--root PATH] [--marker PATH] [--shell]\n'
    + '       log-profile.cjs mark-native --config PATH [--fresh 0|1]',
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[log-profile] ERROR: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  LEGACY_LOGGING,
  USER_LOGGING,
  markManagedNativeInstall,
  readMarker,
  resolveLogProfile,
};
