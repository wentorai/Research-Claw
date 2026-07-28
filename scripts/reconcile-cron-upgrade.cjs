#!/usr/bin/env node
'use strict';

/**
 * Repair Research-Claw preset jobs before OpenClaw opens its cron store.
 *
 * The dashboard owns rc_cron_state, while OpenClaw persists runnable jobs in a
 * separate JSON store. Older releases could leave a disabled preset (notably
 * Weekly Report) active in OpenClaw with delivery.mode=announce. Startup is the
 * only race-free point shared by native, WSL/Linux/macOS and Docker installs.
 *
 * This script touches only jobs that are unambiguously RC presets:
 *   sessionKey "cron:rc-preset:<id>", or an id stored in rc_cron_state.
 * Operator-created cron jobs are never rewritten.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : '';
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveDbPath(args) {
  const explicit = option(args, '--db');
  if (explicit) return path.resolve(expandHome(explicit));

  const configPath = option(args, '--config');
  if (configPath && fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const configured = config.plugins?.entries?.['research-claw-core']?.config?.dbPath;
      if (typeof configured === 'string' && configured.trim()) {
        const expanded = expandHome(configured.trim());
        return path.isAbsolute(expanded)
          ? expanded
          : path.resolve(path.dirname(configPath), '..', expanded);
      }
    } catch {
      // ensure-config / gateway will report malformed project config separately.
    }
  }
  return path.join(os.homedir(), '.research-claw', 'library.db');
}

function resolveJobsPath(args) {
  const explicit = option(args, '--jobs');
  if (explicit) return path.resolve(expandHome(explicit));
  const state = option(args, '--state') || process.env.OPENCLAW_STATE_DIR
    || path.join(os.homedir(), '.openclaw');
  return path.join(path.resolve(expandHome(state)), 'cron', 'jobs.json');
}

function loadDatabaseConstructor() {
  const resolved = require.resolve('better-sqlite3', {
    paths: [
      path.join(projectRoot, 'extensions', 'research-claw-core'),
      projectRoot,
    ],
  });
  return require(resolved);
}

function presetIdFromJob(job, byGatewayId) {
  if (typeof job?.sessionKey === 'string' && job.sessionKey.startsWith('cron:rc-preset:')) {
    const id = job.sessionKey.slice('cron:rc-preset:'.length);
    if (id) return id;
  }
  return typeof job?.id === 'string' ? byGatewayId.get(job.id) : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const dbPath = resolveDbPath(args);
  const jobsPath = resolveJobsPath(args);

  // Absence is a normal first-install state. Never create an empty SQLite file
  // merely by running a migration probe.
  if (!fs.existsSync(dbPath) || !fs.existsSync(jobsPath)) return;

  let store;
  try {
    store = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read cron store ${jobsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!store || !Array.isArray(store.jobs)) return;

  const Database = loadDatabaseConstructor();
  const db = new Database(dbPath);
  let removed = 0;
  let normalized = 0;
  try {
    const table = db.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'rc_cron_state'",
    ).get();
    if (!table) return;

    const rows = db.prepare(
      'SELECT preset_id, enabled, gateway_job_id FROM rc_cron_state',
    ).all();
    const byPreset = new Map(rows.map((row) => [String(row.preset_id), row]));
    const byGatewayId = new Map(
      rows
        .filter((row) => typeof row.gateway_job_id === 'string' && row.gateway_job_id)
        .map((row) => [String(row.gateway_job_id), String(row.preset_id)]),
    );
    const bindingsToClear = new Set();

    const nextJobs = [];
    for (const job of store.jobs) {
      const presetId = presetIdFromJob(job, byGatewayId);
      if (!presetId) {
        nextJobs.push(job);
        continue;
      }

      const row = byPreset.get(presetId);
      // No DB row means the preset was explicitly deleted.
      if (!row || Number(row.enabled) !== 1) {
        removed += 1;
        if (row) bindingsToClear.add(presetId);
        continue;
      }

      if (
        !job.delivery
        || job.delivery.mode !== 'none'
        || Object.keys(job.delivery).length !== 1
      ) {
        job.delivery = { mode: 'none' };
        normalized += 1;
      }
      nextJobs.push(job);
    }

    if (removed > 0 || normalized > 0) {
      store.jobs = nextJobs;
      const output = `${JSON.stringify(store, null, 2)}\n`;
      const temp = `${jobsPath}.tmp.${process.pid}`;
      const mode = fs.statSync(jobsPath).mode & 0o777;
      fs.writeFileSync(temp, output, { mode });
      fs.renameSync(temp, jobsPath);
    }

    if (bindingsToClear.size > 0) {
      const clear = db.prepare(
        'UPDATE rc_cron_state SET gateway_job_id = NULL WHERE preset_id = ?',
      );
      const transaction = db.transaction((ids) => {
        for (const id of ids) clear.run(id);
      });
      transaction([...bindingsToClear]);
    }
  } finally {
    db.close();
  }

  const parts = [];
  if (removed > 0) parts.push(`removed ${removed} disabled preset job(s)`);
  if (normalized > 0) parts.push(`normalized ${normalized} enabled preset job(s)`);
  if (parts.length > 0) {
    process.stdout.write(`[cron-upgrade] ${parts.join('; ')}\n`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[cron-upgrade] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
