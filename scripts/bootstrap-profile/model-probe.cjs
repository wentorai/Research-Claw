#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,127}:managed$/;

class ModelProbeError extends Error {
  constructor(code) {
    super('Bootstrap Profile isolated model probe failed');
    this.name = 'ModelProbeError';
    this.code = code;
  }
}

function fail(code) {
  throw new ModelProbeError(code);
}

function parseArgs(argv) {
  const allowed = new Set([
    '--root', '--config', '--state', '--provider', '--profile', '--scratch-root', '--timeout-ms',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== 'string' || value.length === 0) fail('INVALID_ARGUMENTS');
    values[key.slice(2)] = value;
  }
  for (const required of ['root', 'config', 'state', 'provider', 'profile']) {
    if (!values[required]) fail('INVALID_ARGUMENTS');
  }
  return values;
}

function assertAbsoluteDirectory(directory, code) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(code);
  let metadata;
  try { metadata = fs.lstatSync(directory); } catch { fail(code); }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(code);
  return directory;
}

function readVerifiedFile(file, code) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail(code);
  let before;
  try { before = fs.lstatSync(file); } catch { fail(code); }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
      || before.size < 1 || before.size > MAX_FILE_BYTES
      || (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)) fail(code);
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1
        || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail(code);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail(code);
      offset += count;
    }
    const after = fs.lstatSync(file);
    if (after.isSymbolicLink() || !after.isFile()
        || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) fail(code);
    return bytes;
  } catch (error) {
    if (error instanceof ModelProbeError) throw error;
    fail(code);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { fail(code); }
    }
  }
}

function writePrivateFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, flags, 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } catch {
    fail('SCRATCH_WRITE_FAILED');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { fail('SCRATCH_WRITE_FAILED'); }
    }
  }
}

function parseJsonBytes(bytes, code) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(code); }
}

function parseJsonOutput(stdout) {
  const source = stdout.trim();
  for (let index = source.indexOf('{'); index >= 0; index = source.indexOf('{', index + 1)) {
    try { return JSON.parse(source.slice(index)); } catch { /* launcher notice */ }
  }
  fail('INVALID_PROBE_OUTPUT');
}

function loadSqliteRuntime(candidateRoot) {
  let runtime;
  try {
    runtime = createRequire(path.join(candidateRoot, 'package.json'))(
      'openclaw/plugin-sdk/sqlite-runtime',
    );
  } catch {
    fail('INVALID_OPENCLAW_ENTRY');
  }
  if (typeof runtime?.openNodeSqliteDatabase !== 'function'
      || typeof runtime?.ensureOpenClawAgentDatabaseSchema !== 'function') {
    fail('INVALID_OPENCLAW_ENTRY');
  }
  return runtime;
}

// OC 2026.9.2 stores agent credentials in the canonical
// `<agentDir>/openclaw-agent.sqlite` `auth_profile_store` row and ignores a
// retired `auth-profiles.json` that sits beside a populated store. Read the
// live credential from the legacy file first (2026.6.x and the Bootstrap
// Profile applier still own it), then from the canonical store the 9.2 runtime
// reads.
function readLiveCredential({ liveAgentDir, profileId, sqliteRuntime }) {
  const legacyPath = path.join(liveAgentDir, 'auth-profiles.json');
  if (fs.existsSync(legacyPath)) {
    const auth = parseJsonBytes(readVerifiedFile(legacyPath, 'INVALID_AUTH_STORE'), 'INVALID_AUTH_STORE');
    const credential = auth?.version === 1 ? auth?.profiles?.[profileId] : null;
    if (credential !== undefined && credential !== null) return credential;
  }
  const databasePath = path.join(liveAgentDir, 'openclaw-agent.sqlite');
  let metadata;
  try { metadata = fs.lstatSync(databasePath); } catch { return null; }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail('INVALID_AUTH_STORE');
  let database;
  try {
    database = sqliteRuntime.openNodeSqliteDatabase(databasePath);
    const row = database
      .prepare('SELECT store_json FROM auth_profile_store WHERE store_key = ?')
      .get('primary');
    const store = row && typeof row.store_json === 'string'
      ? JSON.parse(row.store_json)
      : null;
    return store?.version === 1 ? store?.profiles?.[profileId] : null;
  } catch (error) {
    if (error instanceof ModelProbeError) throw error;
    fail('INVALID_AUTH_STORE');
  } finally {
    if (database !== undefined) {
      try { database.close(); } catch { /* probe read only */ }
    }
  }
}

function writeCanonicalAuthStore({ sqliteRuntime, agentDir, agentId, profileId, credential, env }) {
  const databasePath = path.join(agentDir, 'openclaw-agent.sqlite');
  let database;
  try {
    database = sqliteRuntime.openNodeSqliteDatabase(databasePath);
    sqliteRuntime.ensureOpenClawAgentDatabaseSchema(database, {
      path: databasePath,
      agentId,
      env,
    });
    database.prepare(
      `INSERT INTO auth_profile_store (store_key, store_json, updated_at)
       VALUES ('primary', ?, ?)
       ON CONFLICT(store_key) DO UPDATE SET
         store_json = excluded.store_json,
         updated_at = excluded.updated_at`,
    ).run(JSON.stringify({ version: 1, profiles: { [profileId]: credential } }), Date.now());
  } catch (error) {
    if (error instanceof ModelProbeError) throw error;
    fail('SCRATCH_WRITE_FAILED');
  } finally {
    if (database !== undefined) {
      try { database.close(); } catch { fail('SCRATCH_WRITE_FAILED'); }
    }
  }
  if (process.platform !== 'win32') {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(`${databasePath}${suffix}`, 0o600); } catch { /* sidecar absent */ }
    }
  }
}

function isolatedEnv({ home, stateDir, agentDir, configPath }) {
  const env = {};
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot', 'WINDIR',
    'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
    XDG_DATA_HOME: path.join(home, 'xdg-data'),
    XDG_STATE_HOME: path.join(home, 'xdg-state'),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_AGENT_DIR: agentDir,
    OPENCLAW_AUTH_STORE_READONLY: '1',
    OPENCLAW_NO_RESPAWN: '1',
    NODE_DISABLE_COMPILE_CACHE: '1',
  };
}

function runChild(entry, args, env, timeoutMs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;
    const chunks = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0 };
    const collect = (field, chunk) => {
      const bytesKey = `${field}Bytes`;
      chunks[bytesKey] += chunk.length;
      if (chunks[bytesKey] > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        reject(new ModelProbeError('PROBE_OUTPUT_LIMIT'));
        return;
      }
      chunks[field].push(chunk);
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.once('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ModelProbeError('PROBE_TIMEOUT'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      activeChild = undefined;
      resolve({
        code,
        signal,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      });
    });
  });
}

let scratch;
let activeChild;
let cleanupStarted = false;

function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
    activeChild.kill('SIGKILL');
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const candidateRoot = assertAbsoluteDirectory(path.resolve(values.root), 'INVALID_ROOT');
  const liveState = assertAbsoluteDirectory(path.resolve(values.state), 'INVALID_STATE');
  const configSource = path.resolve(values.config);
  const provider = values.provider;
  const profileId = values.profile;
  if (!PROVIDER_RE.test(provider) || !PROFILE_RE.test(profileId)
      || profileId !== `${provider}:managed`) fail('INVALID_MODEL_IDENTITY');
  const timeoutMs = values['timeout-ms'] === undefined
    ? DEFAULT_TIMEOUT_MS : Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    fail('INVALID_TIMEOUT');
  }
  const entry = path.join(candidateRoot, 'node_modules', 'openclaw', 'dist', 'entry.js');
  const entryMetadata = fs.lstatSync(entry);
  if (entryMetadata.isSymbolicLink() || !entryMetadata.isFile()) fail('INVALID_OPENCLAW_ENTRY');

  const configBytes = readVerifiedFile(configSource, 'INVALID_CONFIG');
  const config = parseJsonBytes(configBytes, 'INVALID_CONFIG');
  const primary = typeof config?.agents?.defaults?.model === 'string'
    ? config.agents.defaults.model : config?.agents?.defaults?.model?.primary;
  if (typeof primary !== 'string' || primary.split('/')[0] !== provider
      || config?.auth?.order?.[provider]?.[0] !== profileId
      || config?.models?.providers?.[provider]?.apiKey !== profileId) fail('MODEL_IDENTITY_MISMATCH');

  const liveAuthPath = path.join(liveState, 'agents', 'main', 'agent', 'auth-profiles.json');
  const sqliteRuntime = loadSqliteRuntime(candidateRoot);
  const credential = readLiveCredential({
    liveAgentDir: path.dirname(liveAuthPath),
    profileId,
    sqliteRuntime,
  });
  if (!credential || credential.type !== 'api_key' || credential.provider !== provider
      || typeof credential.key !== 'string' || credential.key.length < 16) fail('INVALID_AUTH_STORE');
  if (configBytes.includes(Buffer.from(credential.key, 'utf8'))) fail('SECRET_COPY_DETECTED');

  // This subprocess proves only the selected credential/model path. Loading
  // the caller's plugins or MCP servers would expand that boundary and can
  // mutate model/auth selection through runtime hooks. Keep the ordinary
  // config fields intact while removing both executable extension surfaces.
  config.plugins = { enabled: false };
  delete config.mcp;
  const probeConfigBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
  if (probeConfigBytes.includes(Buffer.from(credential.key, 'utf8'))) fail('SECRET_COPY_DETECTED');

  const scratchParent = values['scratch-root']
    ? assertAbsoluteDirectory(path.resolve(values['scratch-root']), 'INVALID_SCRATCH_ROOT')
    : assertAbsoluteDirectory(os.tmpdir(), 'INVALID_SCRATCH_ROOT');
  scratch = fs.mkdtempSync(path.join(scratchParent, 'rc-profile-model-probe-'));
  if (process.platform !== 'win32') fs.chmodSync(scratch, 0o700);
  const home = path.join(scratch, 'home');
  const stateDir = path.join(scratch, 'state');
  const agentDir = path.join(stateDir, 'agents', 'main', 'agent');
  const configPath = path.join(scratch, 'config', 'openclaw.json');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writePrivateFile(configPath, probeConfigBytes);
  writeCanonicalAuthStore({
    sqliteRuntime,
    agentDir,
    agentId: 'main',
    profileId,
    credential,
    env: isolatedEnv({ home, stateDir, agentDir, configPath }),
  });

  const result = await runChild(entry, [
    'models', 'status', '--json', '--probe',
    '--probe-provider', provider,
    '--probe-profile', profileId,
    '--probe-timeout', String(Math.min(timeoutMs, 30_000)),
    '--probe-max-tokens', '4',
  ], isolatedEnv({ home, stateDir, agentDir, configPath }), timeoutMs, candidateRoot);
  if (`${result.stdout}${result.stderr}`.includes(credential.key)) fail('PROBE_SECRET_LEAK');
  if (result.code !== 0) {
    if (process.env.RC_MODEL_PROBE_DEBUG === '1') {
      process.stderr.write(`isolated OpenClaw probe child failed: ${result.stderr.slice(-4000)}\n`);
    }
    fail('MODEL_PROBE_FAILED');
  }
  const output = parseJsonOutput(result.stdout);
  const probes = output?.auth?.probes?.results;
  const accepted = Array.isArray(probes)
    && probes.some((probe) => probe?.status === 'ok'
      && (probe.provider === undefined || probe.provider === provider)
      && (probe.profileId === undefined || probe.profileId === profileId));
  if (!accepted) fail('MODEL_PROBE_REJECTED');
  return { ok: true, provider, profileId, status: 'ok' };
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    cleanup();
    process.exit(code);
  });
}

(async () => {
  try {
    const result = await main();
    cleanup();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    cleanup();
    const code = error instanceof ModelProbeError ? error.code : 'MODEL_PROBE_FAILED';
    process.stderr.write(`Bootstrap Profile isolated model probe failed (${code})\n`);
    process.exitCode = 1;
  }
})();
