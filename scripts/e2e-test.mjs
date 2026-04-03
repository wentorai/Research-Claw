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
 *   3. running listener uses the project config file
 *   4. project config can load research-claw-core successfully
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

function skip(name, reason) {
  stats.total++;
  stats.skipped++;
  log(`\x1b[33m○\x1b[0m ${name}: ${reason}`);
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

function runCommand(command, argv) {
  return execFileSync(command, argv, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

function testListenerConfigPath() {
  try {
    const pidsRaw = runCommand('lsof', ['-tiTCP:28789', '-sTCP:LISTEN']).trim();
    if (!pidsRaw) {
      fail('Listener PID', `no process is listening on ${PORT}`);
      return;
    }
    const pid = pidsRaw.split('\n')[0].trim();
    const files = runCommand('lsof', ['-p', pid]);
    if (files.includes(CONFIG_PATH)) {
      pass('Listener config path', `pid ${pid} is using project openclaw.json`);
      return;
    }
    fail('Listener config path', `pid ${pid} is not holding ${CONFIG_PATH}`);
  } catch (err) {
    skip('Listener config path', err instanceof Error ? err.message : String(err));
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

function testPluginLoader() {
  try {
    const out = runNodeCli(['plugins', 'list']);
    verbose(out);
    const normalized = out.replace(/\s+/g, ' ');
    if (!normalized.includes('research -claw- core │ loaded') &&
        !normalized.includes('research-claw-core') &&
        !out.includes('Research-Claw Core registered')) {
      throw new Error('research-claw-core did not appear as loaded');
    }
    if (!out.includes('Research-Claw Core registered')) {
      throw new Error('research-claw-core loader output did not register gateway methods');
    }
    pass('Plugin loader', 'research-claw-core loads and registers in project config');
  } catch (err) {
    fail('Plugin loader', err instanceof Error ? err.message : String(err));
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
  testListenerConfigPath();
  testConfigPluginsSection();
  testPluginLoader();

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
