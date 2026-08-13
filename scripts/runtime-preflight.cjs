#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandHome(value) {
  if (typeof value !== 'string') return '';
  return value === '~' ? os.homedir() : value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value;
}

function fail(code, message, detail = '') {
  process.stderr.write(`[preflight] ${code}: ${message}\n`);
  if (detail) process.stderr.write(`[preflight] ${detail}\n`);
  process.exit(78);
}

function parseArgs(argv) {
  const result = { root: path.resolve(__dirname, '..'), config: '', requireBuild: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) result.root = path.resolve(argv[++i]);
    else if (argv[i] === '--config' && argv[i + 1]) result.config = path.resolve(argv[++i]);
    else if (argv[i] === '--require-build') result.requireBuild = true;
    else if (argv[i] === '--json') result.json = true;
  }
  if (!result.config) result.config = path.join(result.root, 'config', 'openclaw.json');
  return result;
}

const options = parseArgs(process.argv.slice(2));
const coreRoot = path.join(options.root, 'extensions', 'research-claw-core');
const sourceEntry = path.join(coreRoot, 'index.ts');
const buildEntry = path.join(coreRoot, 'dist', 'index.js');

if (!fs.existsSync(sourceEntry)) {
  fail('CORE_SOURCE_MISSING', `missing ${sourceEntry}`);
}
if (options.requireBuild && !fs.existsSync(buildEntry)) {
  fail('CORE_BUILD_MISSING', `missing ${buildEntry}`, 'Run: pnpm build:extensions');
}

let config;
try {
  config = JSON.parse(fs.readFileSync(options.config, 'utf8'));
} catch (error) {
  fail('CONFIG_UNREADABLE', `cannot read ${options.config}`, error instanceof Error ? error.message : String(error));
}

let sqliteModule;
try {
  const openClawReal = fs.realpathSync(path.join(options.root, 'node_modules', 'openclaw'));
  sqliteModule = require.resolve('better-sqlite3', { paths: [path.join(openClawReal, '..')] });
} catch (error) {
  fail('SQLITE_MODULE_MISSING', 'better-sqlite3 is not resolvable from the OpenClaw runtime', 'Run: pnpm install');
}

let Database;
try {
  Database = require(sqliteModule);
  const smoke = new Database(':memory:');
  smoke.prepare('SELECT 1 AS ok').get();
  smoke.close();
} catch (error) {
  fail(
    'NATIVE_ABI_MISMATCH',
    `better-sqlite3 cannot load under Node ${process.version} (ABI ${process.versions.modules})`,
    `${error instanceof Error ? error.message : String(error)}\n[preflight] Fix: fnm use 22 && pnpm rebuild better-sqlite3`,
  );
}

const configuredDb = config?.plugins?.entries?.['research-claw-core']?.config?.dbPath;
const dbPath = path.resolve(options.root, expandHome(configuredDb || '~/.research-claw/library.db'));
let database = { path: dbPath, exists: fs.existsSync(dbPath), quickCheck: 'new' };
if (database.exists) {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.pragma('quick_check');
    db.close();
    database.quickCheck = rows?.[0]?.quick_check || 'unknown';
    if (database.quickCheck !== 'ok') {
      fail('DATABASE_INTEGRITY', `SQLite quick_check returned ${database.quickCheck}`);
    }
  } catch (error) {
    fail('DATABASE_UNREADABLE', `cannot open ${dbPath} read-only`, error instanceof Error ? error.message : String(error));
  }
}

const result = {
  ok: true,
  node: process.version,
  abi: process.versions.modules,
  sqliteModule,
  coreBuild: options.requireBuild ? buildEntry : sourceEntry,
  database,
};
if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
else process.stdout.write(`[preflight] Core runtime ready · Node ${result.node} ABI ${result.abi} · DB ${database.quickCheck}\n`);
