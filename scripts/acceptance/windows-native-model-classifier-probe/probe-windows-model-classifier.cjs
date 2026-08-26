#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER_SHA256 = 'f359f2c5e7443d60653541c252f091c03b1f93a6c1897e51017e024a1f67c7c7';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SAFE_CODES = new Set([
  'MODEL_PROBE_AUTH',
  'MODEL_PROBE_BILLING',
  'MODEL_PROBE_RATE_LIMIT',
  'MODEL_PROBE_TIMEOUT',
  'MODEL_PROBE_FORMAT',
  'MODEL_PROBE_NO_MODEL',
  'MODEL_PROBE_UNKNOWN',
  'MODEL_PROBE_REJECTED',
  'MODEL_PROBE_FAILED',
  'PROBE_TIMEOUT',
]);
const SECRET_PATTERNS = [
  /(^|[^A-Za-z0-9_-])rca_[A-Za-z0-9_-]{43,}/u,
  /(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/u,
  /Authorization\s*:\s*Bearer\s+\S+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const result = { rcRoot: null, outputDir: null, helper: null, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--self-test') result.selfTest = true;
    else if (['--rc-root', '--output-dir', '--helper'].includes(key)) {
      const value = argv[index += 1];
      if (!value) throw new Error('INVALID_ARGUMENTS');
      result[key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = path.resolve(value);
    } else throw new Error('INVALID_ARGUMENTS');
  }
  if (!result.selfTest && (!result.rcRoot || !result.outputDir || !result.helper)) {
    throw new Error('INVALID_ARGUMENTS');
  }
  return result;
}

function containsSecret(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(String(value)));
}

function classify(stderr, result) {
  const match = String(stderr).match(/\((MODEL_PROBE_[A-Z_]+|PROBE_TIMEOUT)\)/u);
  if (match && SAFE_CODES.has(match[1])) return match[1];
  if (result?.error?.code === 'ETIMEDOUT') return 'CLASSIFIER_WRAPPER_TIMEOUT';
  return 'MODEL_PROBE_UNCLASSIFIED';
}

function assertFile(target, expectedSha, code) {
  const metadata = fs.lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isFile() || sha256(fs.readFileSync(target)) !== expectedSha) {
    throw new Error(code);
  }
}

function writeExclusive(file, value) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, value, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function selfTest() {
  const matrix = [
    ['MODEL_PROBE_AUTH', 'MODEL_PROBE_AUTH'],
    ['MODEL_PROBE_TIMEOUT', 'MODEL_PROBE_TIMEOUT'],
    ['MODEL_PROBE_FAILED', 'MODEL_PROBE_FAILED'],
  ];
  for (const [input, expected] of matrix) {
    if (classify(`Bootstrap Profile isolated model probe failed (${input})`, {}) !== expected) {
      throw new Error('SELF_TEST_CLASSIFICATION');
    }
  }
  if (!containsSecret(`rca_${'A'.repeat(43)}`)) {
    throw new Error('SELF_TEST_SECRET_SCAN');
  }
  process.stdout.write('{"ok":true}\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  if (process.platform !== 'win32' || process.arch !== 'x64'
      || process.versions.node.split('.')[0] !== '22' || process.versions.modules !== '127') {
    throw new Error('HOST_CONTRACT');
  }
  assertFile(options.helper, HELPER_SHA256, 'HELPER_SHA_MISMATCH');
  const configPath = path.join(options.rcRoot, 'config', 'openclaw.json');
  const stateDir = path.join(os.homedir(), '.openclaw');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const primary = typeof config?.agents?.defaults?.model === 'string'
    ? config.agents.defaults.model : config?.agents?.defaults?.model?.primary;
  const provider = typeof primary === 'string' ? primary.split('/')[0] : '';
  const profile = config?.auth?.order?.[provider]?.[0];
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(provider)
      || profile !== `${provider}:managed`) throw new Error('MODEL_IDENTITY');

  fs.mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });
  const scratchParent = path.join(process.env.LOCALAPPDATA, 'Wentor', 'ProbeTemp');
  fs.mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'model-classifier-'));
  const started = Date.now();
  let result;
  let cleanupComplete = false;
  try {
    result = spawnSync(process.execPath, [
      options.helper,
      '--root', options.rcRoot,
      '--config', configPath,
      '--state', stateDir,
      '--provider', provider,
      '--profile', profile,
      '--scratch-root', scratch,
      '--timeout-ms', '120000',
    ], {
      cwd: options.rcRoot,
      env: { ...process.env, RC_MODEL_PROBE_DEBUG: '0' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 130_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    cleanupComplete = !fs.existsSync(scratch);
  }
  const combined = `${result?.stdout ?? ''}${result?.stderr ?? ''}`;
  if (containsSecret(combined)) throw new Error('SECRET_OUTPUT_REJECTED');
  const elapsedMs = Date.now() - started;
  const productPassed = result?.status === 0 && !result.error;
  const code = productPassed ? 'MODEL_PROBE_OK' : classify(result?.stderr, result);
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/gu, '').slice(0, 17);
  const id = crypto.randomBytes(4).toString('hex');
  const base = `Wentor-Model-Classifier-${stamp}-${id}`;
  const report = {
    schemaVersion: 1,
    capturedAt: now.toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      abi: process.versions.modules,
      release: os.release(),
    },
    probe: {
      productPassed,
      code,
      elapsedMs,
      childExitCode: Number.isInteger(result?.status) ? result.status : null,
      childSignal: typeof result?.signal === 'string' ? result.signal : null,
      cleanupComplete,
    },
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const text = [
    'Wentor v20 model classifier probe',
    `productPassed=${productPassed}`,
    `code=${code}`,
    `elapsedMs=${elapsedMs}`,
    `cleanupComplete=${cleanupComplete}`,
    '',
  ].join('\n');
  if (containsSecret(json) || containsSecret(text)) throw new Error('REPORT_SECRET_REJECTED');
  const jsonPath = path.join(options.outputDir, `${base}.json`);
  const textPath = path.join(options.outputDir, `${base}.txt`);
  writeExclusive(jsonPath, json);
  writeExclusive(textPath, text);
  process.stdout.write(`WENTOR_MODEL_CLASSIFIER_TXT=${textPath}\n`);
  process.stdout.write(`WENTOR_MODEL_CLASSIFIER_JSON=${jsonPath}\n`);
}

try {
  main();
} catch (error) {
  const code = /^[A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'PROBE_FAILED';
  process.stderr.write(`Model classifier probe failed (${code})\n`);
  process.exitCode = 1;
}
