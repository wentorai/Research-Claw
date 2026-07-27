#!/usr/bin/env node
/**
 * Research-Claw gateway startup / plugin smoke test.
 *
 * Why this exists:
 * - The historical script used an obsolete JSON-RPC shape and pre-v3 method names.
 * - Current OpenClaw gateway uses a connect.challenge/connect handshake and newer
 *   rc.* method names, so the old script produced false negatives.
 *
 * This replacement focuses on the startup chain that actually breaks RC in practice:
 *   1. gateway HTTP health
 *   2. dashboard root availability
 *   3. the running gateway reports the RC plugins as loaded
 *   4. a Research-Claw RPC responds through that gateway
 *   5. config contains the expected plugin entries / load paths
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *   2 — runner/setup failure
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const PORT = Number(getFlag('--port', '28789'));
const TIMEOUT = Number(getFlag('--timeout', '10000'));
const VERBOSE = args.includes('--verbose');

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'openclaw.json');
const ENTRY_JS = path.join(PROJECT_ROOT, 'node_modules', 'openclaw', 'dist', 'entry.js');
const BASE = `http://127.0.0.1:${PORT}`;

const stats = { total: 0, passed: 0, failed: 0, skipped: 0 };
const failures = [];

function readProjectConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function getFlag(name, defaultValue) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue;
}

function log(msg) {
  console.log(`  ${msg}`);
}

function verbose(msg) {
  if (VERBOSE) console.log(`    [verbose] ${msg}`);
}

function pass(name, detail = '') {
  stats.total++;
  stats.passed++;
  log(`\x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, reason) {
  stats.total++;
  stats.failed++;
  log(`\x1b[31m✗\x1b[0m ${name}: ${reason}`);
  failures.push({ name, reason });
}

function runNodeCli(subcommand, extraEnv = {}) {
  return execFileSync(
    process.execPath,
    [ENTRY_JS, ...subcommand],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: CONFIG_PATH,
        ...extraEnv,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function gatewayCall(method) {
  const cfg = readProjectConfig();
  const token = getFlag('--token', cfg?.gateway?.auth?.token ?? '');
  if (!token) throw new Error('gateway auth token is unavailable');
  const raw = runNodeCli([
    'gateway',
    'call',
    method,
    '--url',
    `ws://127.0.0.1:${PORT}`,
    '--token',
    token,
    '--json',
  ]);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error(`${method} returned no JSON object`);
  return JSON.parse(raw.slice(start, end + 1));
}

async function testHealthz() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const res = await fetch(`${BASE}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    pass('HTTP healthz', text || 'ok');
  } catch (err) {
    fail('HTTP healthz', err instanceof Error ? err.message : String(err));
  }
}

async function testDashboardRoot() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const res = await fetch(`${BASE}/`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pass('Dashboard UI', 'gateway serves control UI');
  } catch (err) {
    fail('Dashboard UI', err instanceof Error ? err.message : String(err));
  }
}

function testProjectConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail('Project config', `missing ${CONFIG_PATH}`);
    return;
  }
  pass('Project config', CONFIG_PATH);
}

function testRuntimePlugins() {
  try {
    const health = gatewayCall('health');
    const loaded = health?.plugins?.loaded;
    if (!Array.isArray(loaded)) {
      throw new Error('health.plugins.loaded is unavailable');
    }
    const required = [
      'research-claw-core',
      'dual-model-supervisor',
      'research-superpower',
      'research-plugins',
    ];
    const missing = required.filter((id) => !loaded.includes(id));
    if (missing.length > 0) throw new Error(`missing runtime plugins: ${missing.join(', ')}`);
    pass('Runtime plugins', required.join(', '));
  } catch (err) {
    fail('Runtime plugins', err instanceof Error ? err.message : String(err));
  }
}

function testConfigPluginsSection() {
  try {
    const raw = runNodeCli(['config', 'get', 'plugins']);
    verbose(raw);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      throw new Error('plugins JSON not found in CLI output');
    }
    const plugins = JSON.parse(raw.slice(start, end + 1));
    const paths = plugins.load?.paths ?? [];
    const coreEntry = plugins.entries?.['research-claw-core'];
    if (!Array.isArray(paths) || !paths.some((p) => String(p).includes('extensions/research-claw-core'))) {
      throw new Error('plugins.load.paths is missing research-claw-core');
    }
    if (!coreEntry?.enabled) {
      throw new Error('plugins.entries.research-claw-core.enabled is not true');
    }
    pass('Plugins config', 'research-claw-core present in entries + load.paths');
  } catch (err) {
    fail('Plugins config', err instanceof Error ? err.message : String(err));
  }
}

function testProjectRpc() {
  try {
    const result = gatewayCall('rc.onboarding.status');
    if (!result || typeof result !== 'object') {
      throw new Error('rc.onboarding.status returned no object');
    }
    pass('Project RPC', 'rc.onboarding.status responds through the running gateway');
  } catch (err) {
    fail('Project RPC', err instanceof Error ? err.message : String(err));
  }
}

function testDashboardBuild() {
  const distIndex = path.join(PROJECT_ROOT, 'dashboard', 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    pass('Dashboard build', distIndex);
  } else {
    fail('Dashboard build', `missing ${distIndex} — run pnpm build:dashboard`);
  }
}

function testCorePluginBuild() {
  const distIndex = path.join(PROJECT_ROOT, 'extensions', 'research-claw-core', 'dist', 'index.js');
  if (fs.existsSync(distIndex)) {
    pass('Core plugin build', distIndex);
  } else {
    fail('Core plugin build', `missing ${distIndex} — run pnpm build:extensions`);
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Research-Claw Startup Smoke Test                      ║');
  console.log(`║  Gateway: ${`${BASE}`.padEnd(45)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (!fs.existsSync(ENTRY_JS)) {
    console.error(`\nMissing OpenClaw entry: ${ENTRY_JS}`);
    process.exit(2);
  }

  testProjectConfigFile();
  testDashboardBuild();
  testCorePluginBuild();
  await testHealthz();
  await testDashboardRoot();
  testRuntimePlugins();
  testConfigPluginsSection();
  testProjectRpc();

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Results                                                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Total:   ${stats.total}`);
  console.log(`  Passed:  \x1b[32m${stats.passed}\x1b[0m`);
  console.log(`  Failed:  \x1b[${stats.failed > 0 ? '31' : '32'}m${stats.failed}\x1b[0m`);
  console.log(`  Skipped: \x1b[33m${stats.skipped}\x1b[0m`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const item of failures) {
      console.log(`  \x1b[31m✗\x1b[0m ${item.name}: ${item.reason}`);
    }
  }

  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nUnhandled error:', err);
  process.exit(2);
});
