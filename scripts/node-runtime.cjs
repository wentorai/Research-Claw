#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateRuntime } = require('./runtime-contract.cjs');

function inspectNode(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return null;
  try {
    const raw = execFileSync(candidate, [
      '-p',
      'JSON.stringify({version:process.versions.node,modules:process.versions.modules})',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(raw);
    const contract = evaluateRuntime({ node: parsed.version, modules: parsed.modules });
    return {
      path: fs.realpathSync(candidate),
      version: String(parsed.version),
      modules: String(parsed.modules),
      compatible: contract.compatible,
    };
  } catch {
    return null;
  }
}

function condaCandidate() {
  try {
    const raw = execFileSync('conda', ['env', 'list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^openclaw\s+(?:\*\s+)?(.+)$/);
      if (match) return path.join(match[1].trim(), 'bin', 'node');
    }
  } catch {}
  return null;
}

function fnmCandidates(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v?22(?:\.|$)/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    .map((entry) => path.join(root, entry.name, 'installation', 'bin', 'node'));
}

function nvmCandidates(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v22(?:\.|$)/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    .map((entry) => path.join(root, entry.name, 'bin', 'node'));
}

function resolveRuntime() {
  const home = os.homedir();
  const candidates = [
    process.env.RC_NODE_PATH,
    condaCandidate(),
    process.execPath,
    ...fnmCandidates(path.join(home, '.local', 'share', 'fnm', 'node-versions')),
    ...nvmCandidates(path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node')),
    '/opt/homebrew/opt/node@22/bin/node',
    '/usr/local/opt/node@22/bin/node',
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const inspected = inspectNode(candidate);
    if (inspected?.compatible) return inspected;
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function shellPath(value) {
  if (process.platform !== 'win32') return value;
  const normalized = String(value).replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (drive) return `/${drive[1].toLowerCase()}/${drive[2]}`;
  return normalized;
}

function failNoRuntime() {
  process.stderr.write(
    '[runtime] Research-Claw requires Node 22.16+ within the Node 22 line (ABI 127).\n'
    + '[runtime] Install it with: fnm install 22 && fnm use 22 && fnm default 22\n',
  );
  process.exit(78);
}

const [command = 'resolve', ...args] = process.argv.slice(2);
const runtime = resolveRuntime();
if (!runtime) failNoRuntime();

if (command === 'resolve') {
  if (args.includes('--shell')) {
    process.stdout.write([
      `RC_NODE_PATH=${shellQuote(shellPath(runtime.path))}`,
      `RC_NODE_DIR=${shellQuote(shellPath(path.dirname(runtime.path)))}`,
      `RC_NODE_VERSION=${shellQuote(runtime.version)}`,
      `RC_NODE_ABI=${shellQuote(runtime.modules)}`,
    ].join('\n') + '\n');
  } else {
    process.stdout.write(`${JSON.stringify(runtime)}\n`);
  }
} else if (command === 'exec') {
  const separator = args[0] === '--' ? 1 : 0;
  const executable = args[separator];
  const childArgs = args.slice(separator + 1);
  if (!executable) {
    process.stderr.write('Usage: node-runtime.cjs exec -- <command> [args...]\n');
    process.exit(64);
  }
  const env = {
    ...process.env,
    RC_NODE_PATH: runtime.path,
    PATH: `${path.dirname(runtime.path)}${path.delimiter}${process.env.PATH || ''}`,
  };
  const useWindowsPnpmRunner = process.platform === 'win32' && executable === 'pnpm';
  const childExecutable = useWindowsPnpmRunner ? process.execPath : executable;
  const finalArgs = useWindowsPnpmRunner
    ? [path.join(__dirname, 'run-pnpm.cjs'), ...childArgs]
    : childArgs;
  const result = spawnSync(childExecutable, finalArgs, { env, stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`[runtime] Could not execute ${executable}: ${result.error.message}\n`);
    process.exit(127);
  }
  process.exit(result.status ?? 1);
} else {
  process.stderr.write(`Unknown node-runtime command: ${command}\n`);
  process.exit(64);
}
