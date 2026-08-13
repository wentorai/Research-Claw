#!/usr/bin/env node
/**
 * Optional real-provider smoke for OpenClaw 2026.6.1.
 *
 * This is intentionally NOT part of the default test suite. It reads one
 * explicitly supplied RC config and auth store, selects only the credential
 * for the current primary model, and copies it into a disposable 0700 root /
 * 0600 auth store. Secrets never enter argv, env, Git, or emitted output.
 *
 * Usage:
 *   node scripts/probe-real-provider-smoke.mjs \
 *     --source-config /path/to/config/openclaw.json \
 *     --source-auth-store /path/to/auth-profiles.json
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const ENTRY = path.join(ROOT, 'node_modules', 'openclaw', 'dist', 'entry.js');
const OPENCLAW_PACKAGE = path.join(ROOT, 'node_modules', 'openclaw', 'package.json');
const EXPECTED_OPENCLAW_VERSION = '2026.6.1';
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

class ProbeInterruptedError extends Error {
  constructor(signal) {
    super(`real provider smoke interrupted by ${signal}`);
    this.name = 'ProbeInterruptedError';
    this.signal = signal;
  }
}

function fail(message) {
  throw new Error(message);
}

async function assertOpenClawVersion() {
  const manifest = JSON.parse(await readFile(OPENCLAW_PACKAGE, 'utf8'));
  const actual = typeof manifest.version === 'string' ? manifest.version : '<missing>';
  if (actual !== EXPECTED_OPENCLAW_VERSION) {
    fail(`OpenClaw version mismatch: expected ${EXPECTED_OPENCLAW_VERSION}, found ${actual}`);
  }
  return actual;
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

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== '--source-config' && name !== '--source-auth-store') {
      fail(`Unknown argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${name} requires a path`);
    values[name.slice(2)] = path.resolve(value);
    index += 1;
  }
  if (!values['source-config'] || !values['source-auth-store']) {
    fail('--source-config and --source-auth-store are required');
  }
  return values;
}

function primaryRef(config) {
  const raw = config?.agents?.defaults?.model;
  const ref = typeof raw === 'string' ? raw : raw?.primary;
  if (typeof ref !== 'string' || !ref.includes('/')) fail('Source config has no provider/model primary');
  const [provider, ...modelParts] = ref.split('/');
  const model = modelParts.join('/');
  if (!provider || !model) fail('Source primary model is malformed');
  return { provider, model, ref };
}

function secretValues(credential) {
  const values = [];
  const visit = (value, key = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value)) {
      if (typeof child === 'string' && child.length >= 8 &&
          /(?:key|token|access|refresh|secret|credential|idtoken)/i.test(childKey)) {
        values.push(child);
      } else if (child && typeof child === 'object') {
        visit(child, childKey);
      }
    }
  };
  visit(credential);
  return [...new Set(values)];
}

function usableCredential(credential) {
  if (!credential || typeof credential !== 'object') return false;
  if (credential.type === 'api_key') return typeof credential.key === 'string' && credential.key.length > 0;
  if (credential.type === 'token') return typeof credential.token === 'string' && credential.token.length > 0;
  if (credential.type === 'oauth') return typeof credential.access === 'string' && credential.access.length > 0;
  return false;
}

function selectCredential(config, store, provider) {
  const profiles = store?.profiles ?? {};
  const candidates = Object.entries(profiles)
    .filter(([, credential]) => credential?.provider === provider && usableCredential(credential));
  if (candidates.length === 0) fail('No usable auth profile for the primary provider');

  const orderedIds = [
    ...(Array.isArray(config?.auth?.order?.[provider]) ? config.auth.order[provider] : []),
    ...(Array.isArray(store?.order?.[provider]) ? store.order[provider] : []),
    ...(typeof store?.lastGood?.[provider] === 'string' ? [store.lastGood[provider]] : []),
  ];
  for (const id of orderedIds) {
    const credential = profiles[id];
    if (credential?.provider === provider && usableCredential(credential)) return [id, credential];
  }
  if (candidates.length !== 1) fail('Primary provider has multiple profiles but no unambiguous order');
  return candidates[0];
}

function profileMode(credential) {
  if (credential.type === 'api_key') return 'api_key';
  if (credential.type === 'token') return 'token';
  if (credential.type === 'oauth') return 'oauth';
  fail('Unsupported credential type');
}

function isolatedProvider(sourceProvider, selectedModel, profileId) {
  if (!sourceProvider || typeof sourceProvider !== 'object') fail('Primary provider is absent from models.providers');
  const models = Array.isArray(sourceProvider.models)
    ? sourceProvider.models.filter(model => model?.id === selectedModel)
    : [];
  if (models.length !== 1) fail('Primary model card is absent or ambiguous');
  const {
    apiKey: _apiKey,
    headers: _headers,
    models: _models,
    ...safeProvider
  } = sourceProvider;
  // OC 2026.6.1's models.json planner resolves a missing provider apiKey from
  // auth-profiles and persists the plaintext into models.json or a generated
  // plugin catalog. Binding the provider entry to the profile id keeps those
  // derived catalogs secret-free while runtime auth resolves the actual key.
  return { ...safeProvider, apiKey: profileId, models };
}

function runCli(args, env, timeoutMs, signal) {
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
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function containsAnySecret(buffer, secrets) {
  return secrets.some(secret => buffer.includes(Buffer.from(secret, 'utf8')));
}

function extractVisibleAssistantText(result) {
  if (!Array.isArray(result?.payloads)) return '';
  return result.payloads
    .filter(payload => payload?.isReasoning !== true && typeof payload?.text === 'string')
    .map(payload => payload.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isExplicitCompletion(text) {
  return /^(?:OK|Okay|Done|Completed(?: successfully)?)\.?$/i.test(text.trim());
}

async function listFiles(root) {
  const files = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  await walk(root);
  return files;
}

async function assertNoSecretLeak({ tempRoot, authPath, secrets, outputs }) {
  for (const output of outputs) {
    if (containsAnySecret(output, secrets)) fail('Secret appeared in captured process output');
  }
  for (const file of await listFiles(tempRoot)) {
    if (file === authPath) continue;
    const content = await readFile(file);
    if (containsAnySecret(content, secrets)) {
      fail(`Secret appeared outside the credential-store allowlist: ${path.relative(tempRoot, file)}`);
    }
  }
}

async function pauseBeforeProviderCallsForSignalTest(tempRoot, signal) {
  if (process.env.NODE_ENV !== 'test' ||
      process.env.RC_REAL_PROVIDER_SMOKE_PAUSE_AFTER_AUTH_WRITE !== '1') return;
  let resolveAbort;
  const aborted = new Promise(resolve => {
    resolveAbort = resolve;
    signal.addEventListener('abort', resolve, { once: true });
  });
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await writeFile(path.join(tempRoot, '.signal-test-ready'), 'ready\n', { mode: 0o600 });
    if (!signal.aborted) await aborted;
  } finally {
    clearInterval(keepAlive);
    signal.removeEventListener('abort', resolveAbort);
  }
}

async function main() {
  const signalBridge = createSignalBridge();
  let tempRoot;
  let selected;
  let modelsStatus = 'failed';
  let agentStatus = 'failed';
  let scanStatus = 'not-run';
  let cleaned = false;

  try {
    await assertOpenClawVersion();
    signalBridge.throwIfInterrupted();
    // This optional smoke handles a real credential. Until a Windows ACL probe
    // is implemented and verified, fail before reading either supplied file.
    if (process.platform === 'win32') {
      fail('Real provider smoke is POSIX-only; Windows ACL isolation is not implemented');
    }
    const args = parseArgs(process.argv.slice(2));
    await stat(args['source-config']);
    const sourceAuthMode = (await stat(args['source-auth-store'])).mode & 0o777;
    if (sourceAuthMode & 0o077) fail('Source auth store must not be group/world accessible');

    // Parse directly into memory. Neither raw source file is copied wholesale.
    const sourceConfig = JSON.parse(await readFile(args['source-config'], 'utf8'));
    const sourceStore = JSON.parse(await readFile(args['source-auth-store'], 'utf8'));
    signalBridge.throwIfInterrupted();
    selected = primaryRef(sourceConfig);
    const [profileId, credential] = selectCredential(sourceConfig, sourceStore, selected.provider);
    const secrets = secretValues(credential);
    if (secrets.length === 0) fail('Selected credential has no scannable secret material');
    const provider = isolatedProvider(
      sourceConfig.models?.providers?.[selected.provider],
      selected.model,
      profileId,
    );

    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-real-provider-smoke-'));
    await chmod(tempRoot, 0o700);
    const stateDir = path.join(tempRoot, 'state');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const agentDir = path.join(stateDir, 'agents', 'main', 'agent');
    const configPath = path.join(stateDir, 'openclaw.json');
    const authPath = path.join(agentDir, 'auth-profiles.json');
    const outputs = [];
    await Promise.all([
      mkdir(stateDir, { recursive: true, mode: 0o700 }),
      mkdir(workspaceDir, { recursive: true, mode: 0o700 }),
      mkdir(agentDir, { recursive: true, mode: 0o700 }),
    ]);
    const isolatedConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          skipBootstrap: true,
          model: { primary: selected.ref },
          timeoutSeconds: 45,
        },
      },
      models: { mode: 'merge', providers: { [selected.provider]: provider } },
      auth: {
        profiles: { [profileId]: { provider: selected.provider, mode: profileMode(credential) } },
        order: { [selected.provider]: [profileId] },
      },
      skills: { allowBundled: ['fixture-no-bundled-skills'] },
    };
    await writeFile(configPath, `${JSON.stringify(isolatedConfig, null, 2)}\n`, { mode: 0o600 });
    await writeFile(authPath, `${JSON.stringify({
      version: 1,
      profiles: { [profileId]: credential },
    }, null, 2)}\n`, { mode: 0o600 });
    await Promise.all([chmod(configPath, 0o600), chmod(authPath, 0o600)]);
    const [rootMode, authMode] = await Promise.all([
      stat(tempRoot).then(info => info.mode & 0o777),
      stat(authPath).then(info => info.mode & 0o777),
    ]);
    if (rootMode !== 0o700) fail('Temporary root permissions are not 0700');
    if (authMode !== 0o600) fail('Temporary auth store permissions are not 0600');
    await pauseBeforeProviderCallsForSignalTest(tempRoot, signalBridge.signal);
    signalBridge.throwIfInterrupted();

    const env = {
      PATH: process.env.PATH ?? '',
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_AGENT_DIR: agentDir,
      OPENCLAW_AUTH_STORE_READONLY: '1',
    };
    const status = await runCli([
      'models', 'status', '--json', '--probe', '--probe-provider', selected.provider,
      '--probe-profile', profileId, '--probe-timeout', '30000', '--probe-max-tokens', '4',
    ], env, 45_000, signalBridge.signal);
    signalBridge.throwIfInterrupted();
    outputs.push(status.stdout, status.stderr);
    if (status.code === 0) {
      const parsed = JSON.parse(status.stdout.toString('utf8'));
      const probe = parsed.auth?.probes?.results?.find(result => result.profileId === profileId);
      if (probe?.status === 'ok') modelsStatus = 'ok';
    }
    if (modelsStatus !== 'ok') fail('Real models status probe failed');

    const agent = await runCli([
      'agent', '--local', '--json', '--session-id', `real-smoke-${randomUUID()}`,
      '--message', 'Reply with exactly OK.', '--thinking', 'off', '--timeout', '45',
    ], env, 60_000, signalBridge.signal);
    signalBridge.throwIfInterrupted();
    outputs.push(agent.stdout, agent.stderr);
    if (agent.code === 0) {
      const parsed = JSON.parse(agent.stdout.toString('utf8'));
      const assistantText = extractVisibleAssistantText(parsed);
      if (isExplicitCompletion(assistantText)) agentStatus = 'ok';
    }
    if (agentStatus !== 'ok') fail('Real embedded agent smoke did not return an explicit completion');

    await assertNoSecretLeak({ tempRoot, authPath, secrets, outputs });
    scanStatus = 'clean';
  } finally {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      try {
        await lstat(tempRoot);
      } catch (error) {
        if (error?.code === 'ENOENT') cleaned = true;
        else throw error;
      }
    }
    const receivedSignal = signalBridge.receivedSignal;
    signalBridge.dispose();
    if (receivedSignal) throw new ProbeInterruptedError(receivedSignal);
  }

  // Only non-secret, explicitly allowed fields are emitted.
  process.stdout.write(`${JSON.stringify({
    provider: selected.provider,
    model: selected.model,
    status: {
      models: modelsStatus,
      agent: agentStatus,
      secretScan: scanStatus,
      secretCopies: scanStatus === 'clean' ? 1 : 'unknown',
      cleanup: cleaned ? 'clean' : 'failed',
    },
  })}\n`);
}

main().catch(error => {
  if (error instanceof ProbeInterruptedError) {
    process.stderr.write(`${error.message}; temporary state cleaned\n`);
    process.exitCode = SIGNAL_EXIT_CODES[error.signal] ?? 1;
    return;
  }
  // Never append captured child output, config, credential, or response bodies.
  process.stderr.write(`real provider smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
